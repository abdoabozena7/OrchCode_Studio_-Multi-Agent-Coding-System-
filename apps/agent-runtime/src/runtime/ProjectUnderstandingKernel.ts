import type {
  ClaimLedger,
  InvestigationAction,
  ProjectClaim,
  ProjectUnderstandingAnswer,
  ProjectUnderstandingKernelMode,
  QuestionDecomposition
} from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { semanticNodeEmbeddingText } from "../memory/SemanticProjectModel.js";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import type { SemanticEmbeddingRecord, SemanticProjectNode, SemanticProjectRelationship } from "../memory/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { blockingUserClarifications, classifyClarifications } from "./ClarificationPolicy.js";
import { invokeReasoningProviderEmbedding, invokeReasoningProviderStructured, invokeReasoningProviderText } from "./ReasoningKernel.js";

const MAX_ELAPSED_MS = 90_000;
const MAX_PROVIDER_CALLS = 12;
const MAX_REPAIR_ITERATIONS = 3;
const MAX_EMBEDDING_NODES = 320;
const EMBEDDING_BATCH_SIZE = 64;

export function projectUnderstandingKernelMode(): ProjectUnderstandingKernelMode {
  const value = process.env.HIVO_PROJECT_UNDERSTANDING_KERNEL_MODE?.toLowerCase();
  return value === "off" || value === "on" || value === "shadow" ? value : "off";
}

export async function runProjectUnderstandingKernel(input: {
  question: string;
  provider: LlmProvider;
  tools: ToolRegistry;
  embeddingModel?: string;
  mode?: ProjectUnderstandingKernelMode;
  escalate?: (
    question: string,
    missingFacts: string[],
    budget: { remainingProviderCalls: number; remainingMs: number }
  ) => Promise<{ reviews: string[]; providerCalls: number }>;
}): Promise<ProjectUnderstandingAnswer> {
  const startedAt = Date.now();
  const mode = input.mode ?? projectUnderstandingKernelMode();
  const state = { providerCalls: 0, repairIterations: 0, escalationUsed: false };
  if (mode === "off") throw new Error("project_understanding.disabled");
  if (!input.embeddingModel || !input.provider.embed) {
    throw new Error("project_understanding.embedding_provider_required");
  }

  const freshness = await assessIndexFreshness(input.tools.getWorkspacePath());
  if (freshness.status !== "fresh") {
    throw new Error(`project_understanding.stale_repository_index:${freshness.status}`);
  }
  const decomposition = await decomposeQuestion(input.question, input.provider, state);

  const store = await SqliteMemoryStore.open({ workspacePath: input.tools.getWorkspacePath() });
  try {
    const model = store.semanticProjectModel();
    if (!model?.nodes.length) throw new Error("project_understanding.semantic_model_unavailable");
    await ensureEmbeddings(store, input.provider, input.embeddingModel, model.nodes, state, startedAt);
    const searchText = decompositionSearchText(decomposition);
    const queryVector = await embedOne(input.provider, input.embeddingModel, searchText, state, startedAt);
    const semanticMatches = store.semanticSearch(queryVector, input.embeddingModel, 18);
    const ftsNodes = store.semanticNodes(store.search(searchText, { kinds: ["semantic_node"], limit: 18 }).map((entry) => entry.id));
    const seedNodes = uniqueNodes([...semanticMatches.map((entry) => entry.node), ...ftsNodes]);
    const expansion = expandGraph(store, seedNodes, 2);
    let allNodes = uniqueNodes([...seedNodes, ...expansion.nodes]);
    let allRelationships = expansion.relationships;
    let filesRead = readEvidenceFiles(input.tools, allNodes);
    let evidenceRefs = unique([
      ...allNodes.flatMap((node) => node.evidenceRefs),
      ...expansion.relationships.flatMap((relationship) => relationship.evidenceRefs)
    ]);
    let draft = await composeAnswer(input, decomposition, seedNodes, expansion.relationships, filesRead, evidenceRefs, state, startedAt);
    let ledger = buildClaimLedger(draft, evidenceRefs, allNodes, allRelationships);

    while (!ledger.allMaterialClaimsSupported && state.repairIterations < MAX_REPAIR_ITERATIONS && withinBudget(state, startedAt)) {
      state.repairIterations += 1;
      const missing = ledger.claims.filter((claim) => claim.material && claim.status !== "supported").map((claim) => claim.text);
      const extraNodes = expandGraph(store, allNodes, Math.min(3, state.repairIterations + 1));
      const extraFiles = readEvidenceFiles(input.tools, extraNodes.nodes);
      allNodes = uniqueNodes([...allNodes, ...extraNodes.nodes]);
      allRelationships = uniqueRelationships([...allRelationships, ...extraNodes.relationships]);
      filesRead = uniqueFiles([...filesRead, ...extraFiles]);
      evidenceRefs = unique([
        ...evidenceRefs,
        ...extraNodes.nodes.flatMap((node) => node.evidenceRefs),
        ...extraNodes.relationships.flatMap((relationship) => relationship.evidenceRefs)
      ]);
      draft = await repairAnswer(input, decomposition, draft, missing, allRelationships, filesRead, evidenceRefs, state, startedAt);
      ledger = buildClaimLedger(draft, evidenceRefs, allNodes, allRelationships);
    }

    let missingFacts = ledger.claims.filter((claim) => claim.material && claim.status !== "supported").map((claim) => claim.text);
    let clarification = classifyClarifications({ decomposition, missingFacts });
    const escalationProviderBudget = Math.max(0, MAX_PROVIDER_CALLS - state.providerCalls - 1);
    if (missingFacts.length && !blockingUserClarifications(clarification).length && input.escalate && escalationProviderBudget > 0 && withinBudget(state, startedAt)) {
      state.escalationUsed = true;
      try {
        const escalation = await input.escalate(input.question, missingFacts, {
          remainingProviderCalls: escalationProviderBudget,
          remainingMs: Math.max(0, MAX_ELAPSED_MS - (Date.now() - startedAt))
        });
        state.providerCalls += escalation.providerCalls;
        if (escalation.reviews.length && withinBudget(state, startedAt)) {
          draft = await repairAnswer(input, decomposition, draft, missingFacts, allRelationships, filesRead, evidenceRefs, state, startedAt, escalation.reviews);
          ledger = buildClaimLedger(draft, evidenceRefs, allNodes, allRelationships);
          missingFacts = ledger.claims.filter((claim) => claim.material && claim.status !== "supported").map((claim) => claim.text);
          clarification = classifyClarifications({ decomposition, missingFacts });
        }
      } catch {
        // Escalation is advisory; a failed or exhausted read-only swarm leads to a verified refusal.
      }
    }

    const decision = decide(ledger, clarification, state.escalationUsed);
    const actions = investigationActions(decomposition, allNodes, allRelationships, filesRead);
    return {
      mode,
      status: mode === "shadow" ? "shadow_complete" : statusForDecision(decision.action),
      decomposition,
      investigationActions: actions,
      claimLedger: ledger,
      clarification,
      filesRead: filesRead.map((file) => file.path),
      graphExpansionTrace: allRelationships.map((relationship) => `${relationship.fromNodeId} -[${relationship.kind}]-> ${relationship.toNodeId}`),
      repairIterations: state.repairIterations,
      providerCalls: state.providerCalls,
      elapsedMs: Date.now() - startedAt,
      evidenceRefs,
      unknowns: missingFacts,
      finalAnswerMarkdown: draft,
      decision: decision.action,
      decisionReason: decision.reason,
      escalationUsed: state.escalationUsed
    };
  } finally {
    store.close();
  }
}

async function decomposeQuestion(question: string, provider: LlmProvider, state: BudgetState): Promise<QuestionDecomposition> {
  let errors: string[] = [];
  let previous: unknown;
  for (let attempt = 0; attempt <= MAX_REPAIR_ITERATIONS; attempt += 1) {
    state.providerCalls += 1;
    const generated = await invokeReasoningProviderStructured<Partial<QuestionDecomposition>>(provider, {
      purpose: attempt === 0 ? "reason" : "repair",
      systemPrompt: attempt === 0
        ? "Decompose a deep project question into concepts and required code relationships. Return strict JSON only."
        : "Repair the malformed question decomposition using the validation errors. Return strict JSON only.",
      userPrompt: `${question}\n\nReturn { question, concepts, requiredRelationships, ambiguities, expectedAnswerShape, language }.`,
      context: attempt === 0 ? undefined : { invalidResult: previous, validationErrors: errors }
    }, { name: "project-understanding-decomposition" });
    previous = generated;
    const normalized = normalizeDecomposition(question, generated);
    if (normalized.valid) return normalized.value;
    errors = normalized.errors;
    if (attempt < MAX_REPAIR_ITERATIONS) state.repairIterations += 1;
  }
  throw new Error(`project_understanding.decomposition_invalid_after_repairs:${errors.join("; ")}`);
}

async function ensureEmbeddings(
  store: SqliteMemoryStore,
  provider: LlmProvider,
  model: string,
  nodes: SemanticProjectNode[],
  state: BudgetState,
  startedAt: number
) {
  const existing = new Map(store.semanticEmbeddings(model).map((record) => [record.nodeId, record]));
  const missing = nodes
    .filter((node) => !existing.has(node.id))
    .sort((left, right) => nodePriority(left) - nodePriority(right) || left.id.localeCompare(right.id))
    .slice(0, MAX_EMBEDDING_NODES);
  for (let index = 0; index < missing.length && withinBudget(state, startedAt); index += EMBEDDING_BATCH_SIZE) {
    const batch = missing.slice(index, index + EMBEDDING_BATCH_SIZE);
    state.providerCalls += 1;
    const response = await invokeReasoningProviderEmbedding(provider, { model, inputs: batch.map(semanticNodeEmbeddingText) });
    const now = new Date().toISOString();
    store.saveSemanticEmbeddings(batch.map((node, vectorIndex): SemanticEmbeddingRecord => ({
      nodeId: node.id,
      model,
      dimensions: response.vectors[vectorIndex]?.length ?? 0,
      vector: response.vectors[vectorIndex] ?? [],
      contentHash: node.contentHash,
      updatedAt: now
    })));
  }
}

async function embedOne(provider: LlmProvider, model: string, text: string, state: BudgetState, startedAt: number) {
  assertBudget(state, startedAt);
  state.providerCalls += 1;
  const response = await invokeReasoningProviderEmbedding(provider, { model, inputs: [text] });
  const vector = response.vectors[0];
  if (!vector?.length) throw new Error("project_understanding.empty_query_embedding");
  return vector;
}

function expandGraph(store: SqliteMemoryStore, seeds: SemanticProjectNode[], maxDepth: number) {
  const nodes = new Map(seeds.map((node) => [node.id, node]));
  const relationships = new Map<string, SemanticProjectRelationship>();
  let frontier = seeds.map((node) => node.id);
  for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
    const edges = store.semanticRelationships(frontier);
    const next = new Set<string>();
    for (const edge of edges) {
      relationships.set(edge.id, edge);
      if (!nodes.has(edge.fromNodeId)) next.add(edge.fromNodeId);
      if (!nodes.has(edge.toNodeId)) next.add(edge.toNodeId);
    }
    const newNodes = store.semanticNodes([...next]);
    for (const node of newNodes) nodes.set(node.id, node);
    frontier = newNodes.map((node) => node.id);
  }
  return { nodes: [...nodes.values()], relationships: [...relationships.values()] };
}

function readEvidenceFiles(tools: ToolRegistry, nodes: SemanticProjectNode[]) {
  return unique(nodes.flatMap((node) => node.path ? [node.path] : [])).slice(0, 24).flatMap((filePath) => {
    try {
      return [{ path: filePath, content: tools.workspace.readWholeFile(filePath).slice(0, 24_000) }];
    } catch {
      return [];
    }
  });
}

async function composeAnswer(
  input: Parameters<typeof runProjectUnderstandingKernel>[0],
  decomposition: QuestionDecomposition,
  nodes: SemanticProjectNode[],
  relationships: SemanticProjectRelationship[],
  files: Array<{ path: string; content: string }>,
  evidenceRefs: string[],
  state: BudgetState,
  startedAt: number
) {
  assertBudget(state, startedAt);
  state.providerCalls += 1;
  return invokeReasoningProviderText(input.provider, {
    purpose: "compose",
    systemPrompt: [
      "Answer the project question from the supplied durable semantic model and source evidence.",
      "Every material claim must include a plain path:line evidence reference from the allow-list.",
      "State unknowns explicitly. Do not invent files, relationships, or behavior."
    ].join("\n"),
    userPrompt: input.question,
    context: {
      decomposition,
      nodes: nodes.slice(0, 30),
      relationships: relationships.slice(0, 60),
      files: files.map((file) => ({ path: file.path, excerpt: file.content.slice(0, 6_000) })),
      allowedEvidenceRefs: evidenceRefs
    }
  });
}

async function repairAnswer(
  input: Parameters<typeof runProjectUnderstandingKernel>[0],
  decomposition: QuestionDecomposition,
  draft: string,
  missingClaims: string[],
  relationships: SemanticProjectRelationship[],
  files: Array<{ path: string; content: string }>,
  evidenceRefs: string[],
  state: BudgetState,
  startedAt: number,
  review: string[] = []
) {
  assertBudget(state, startedAt);
  state.providerCalls += 1;
  return invokeReasoningProviderText(input.provider, {
    purpose: "compose",
    systemPrompt: "Repair the answer. Remove or qualify unsupported claims and cite only allowed path:line refs.",
    userPrompt: input.question,
    context: {
      decomposition,
      previousDraft: draft,
      unsupportedClaims: missingClaims,
      relationships: relationships.slice(0, 80),
      files: files.map((file) => ({ path: file.path, excerpt: file.content.slice(0, 6_000) })),
      allowedEvidenceRefs: evidenceRefs,
      readOnlyReview: review
    }
  });
}

function buildClaimLedger(
  answer: string,
  evidenceRefs: string[],
  nodes: SemanticProjectNode[],
  relationships: SemanticProjectRelationship[]
): ClaimLedger {
  const allowed = new Set(evidenceRefs.map(normalizeRef));
  const evidenceText = `${nodes.map((node) => `${node.name} ${node.summary}`).join(" ")} ${relationships.map((relationship) => relationship.reason).join(" ")}`;
  const claims = answer
    .split(/(?<=[.!?؟])\s+|\n+/)
    .map((text) => text.replace(/^#+\s*/, "").trim())
    .filter((text) => text.length > 24)
    .slice(0, 40)
    .map((text, index): ProjectClaim => {
      const refs = extractRefs(text).filter((ref) => allowed.has(normalizeRef(ref)));
      const overlap = tokenOverlap(text, evidenceText);
      const material = !/\b(unknown|unclear|cannot confirm|not enough evidence|risk|may|might|could)\b/i.test(text);
      const status = refs.length && overlap >= 1 ? "supported" : refs.length ? "partially_supported" : material ? "unsupported" : "unknown";
      return {
        id: `claim_${index + 1}`,
        text,
        material,
        status,
        evidenceRefs: refs,
        relationshipIds: relationships.filter((relationship) => tokenOverlap(text, relationship.reason) >= 2).slice(0, 6).map((relationship) => relationship.id),
        reason: status === "supported" ? "Claim overlaps semantic evidence and cites an allow-listed ref." : "Claim lacks sufficient allow-listed evidence support."
      };
    });
  const supportedMaterialClaims = claims.filter((claim) => claim.material && claim.status === "supported").length;
  const unsupportedMaterialClaims = claims.filter((claim) => claim.material && claim.status !== "supported").length;
  return { claims, supportedMaterialClaims, unsupportedMaterialClaims, allMaterialClaimsSupported: unsupportedMaterialClaims === 0 && supportedMaterialClaims > 0 };
}

function investigationActions(
  decomposition: QuestionDecomposition,
  nodes: SemanticProjectNode[],
  relationships: SemanticProjectRelationship[],
  files: Array<{ path: string }>
): InvestigationAction[] {
  return [
    ...decomposition.concepts.map((concept, index): InvestigationAction => ({
      id: `semantic_search_${index + 1}`,
      kind: "semantic_search",
      status: nodes.length ? "completed" : "blocked",
      reason: `Retrieve semantic nodes for ${concept}.`,
      query: concept,
      evidenceRefs: nodes.flatMap((node) => node.evidenceRefs).slice(0, 8)
    })),
    ...files.map((file, index): InvestigationAction => ({
      id: `open_file_${index + 1}`,
      kind: "open_file",
      status: "completed",
      reason: "Read source selected by semantic retrieval or graph expansion.",
      path: file.path,
      evidenceRefs: nodes.filter((node) => node.path === file.path).flatMap((node) => node.evidenceRefs)
    })),
    ...relationships.slice(0, 30).map((relationship): InvestigationAction => ({
      id: `follow_${relationship.id}`,
      kind: "follow_relationship",
      status: "completed",
      reason: relationship.reason,
      relationshipId: relationship.id,
      evidenceRefs: relationship.evidenceRefs
    }))
  ];
}

function normalizeDecomposition(question: string, value: Partial<QuestionDecomposition>): {
  valid: boolean;
  errors: string[];
  value: QuestionDecomposition;
} {
  const errors: string[] = [];
  if (!arrayOfStrings(value.concepts).length) errors.push("concepts must contain at least one provider-authored concept");
  if (!Array.isArray(value.requiredRelationships)) errors.push("requiredRelationships must be an array");
  if (!Array.isArray(value.ambiguities)) errors.push("ambiguities must be an array");
  if (!isAnswerShape(value.expectedAnswerShape)) errors.push("expectedAnswerShape is invalid");
  if (value.language !== "arabic" && value.language !== "english") errors.push("language is invalid");
  return {
    valid: errors.length === 0,
    errors,
    value: {
    question,
    concepts: arrayOfStrings(value.concepts),
    requiredRelationships: Array.isArray(value.requiredRelationships) ? value.requiredRelationships.filter(isRelationshipRequirement) : [],
    ambiguities: arrayOfStrings(value.ambiguities),
    expectedAnswerShape: isAnswerShape(value.expectedAnswerShape) ? value.expectedAnswerShape : "summary",
    language: value.language === "arabic" ? "arabic" : "english"
    }
  };
}

function deterministicDecomposition(question: string): QuestionDecomposition {
  const concepts = unique(question.match(/[A-Za-z_][A-Za-z0-9_-]{2,}|[\u0600-\u06ff]{3,}/g) ?? [])
    .filter((term) => !STOP_WORDS.has(term.toLowerCase()))
    .slice(0, 8);
  const shape = /\b(compare|difference|versus|vs)\b/i.test(question) ? "comparison"
    : /\b(when|decide|policy|rule|choose)\b/i.test(question) ? "decision_policy"
      : /\b(exist|whether|is there)\b/i.test(question) ? "existence"
        : /\b(flow|how|trace|from .* to)\b/i.test(question) ? "flow"
          : "summary";
  return {
    question,
    concepts,
    requiredRelationships: concepts.slice(1).map((concept, index) => ({
      fromConcept: concepts[index] ?? concepts[0] ?? "project",
      toConcept: concept,
      required: true,
      rationale: "The question mentions both concepts and requires their project relationship."
    })),
    ambiguities: [],
    expectedAnswerShape: shape,
    language: /[\u0600-\u06ff]/u.test(question) ? "arabic" : "english"
  };
}

function decompositionSearchText(value: QuestionDecomposition) {
  return [value.question, ...value.concepts, ...value.requiredRelationships.map((relationship) => `${relationship.fromConcept} ${relationship.toConcept} ${relationship.kind ?? ""}`)].join("\n");
}

function decide(ledger: ClaimLedger, clarification: ReturnType<typeof classifyClarifications>, escalationUsed: boolean) {
  if (ledger.allMaterialClaimsSupported) return { action: "ANSWER" as const, reason: "All material claims are supported by current repository evidence." };
  if (blockingUserClarifications(clarification).length) return { action: "FOLLOW_UP" as const, reason: "A user-provided fact is required before the question has one correct meaning." };
  if (!escalationUsed && clarification.some((entry) => entry.classification === "discoverable")) return { action: "ESCALATE" as const, reason: "Discoverable evidence gaps remain and read-only escalation has not been used." };
  return { action: "REFUSE" as const, reason: "Material claims remain unsupported after bounded investigation." };
}

function blockedAnswer(mode: ProjectUnderstandingKernelMode, decomposition: QuestionDecomposition, startedAt: number, reason: string): ProjectUnderstandingAnswer {
  return {
    mode,
    status: "blocked",
    decomposition,
    investigationActions: [],
    claimLedger: { claims: [], supportedMaterialClaims: 0, unsupportedMaterialClaims: 0, allMaterialClaimsSupported: false },
    clarification: [],
    filesRead: [],
    graphExpansionTrace: [],
    repairIterations: 0,
    providerCalls: 0,
    elapsedMs: Date.now() - startedAt,
    evidenceRefs: [],
    unknowns: [reason],
    finalAnswerMarkdown: reason,
    decision: "REFUSE",
    decisionReason: reason,
    escalationUsed: false
  };
}

function statusForDecision(action: ProjectUnderstandingAnswer["decision"]): ProjectUnderstandingAnswer["status"] {
  if (action === "ANSWER") return "answered";
  if (action === "FOLLOW_UP") return "follow_up";
  if (action === "ESCALATE") return "escalate";
  return "refused";
}

function extractRefs(text: string) {
  return unique(Array.from(text.matchAll(/\b((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)\b/g)).map((match) => `${match[1]}:${match[2]}`));
}

function tokenOverlap(left: string, right: string) {
  const rightSet = new Set(tokens(right));
  return tokens(left).filter((token) => rightSet.has(token)).length;
}

function tokens(text: string) {
  return unique(text.toLowerCase().match(/[a-z0-9_]{3,}|[\u0600-\u06ff]{3,}/g) ?? []).filter((token) => !STOP_WORDS.has(token));
}

function nodePriority(node: SemanticProjectNode) {
  if (node.kind === "file") return 0;
  if (node.kind === "symbol") return 1;
  return 2;
}

function withinBudget(state: BudgetState, startedAt: number) {
  return state.providerCalls < MAX_PROVIDER_CALLS && Date.now() - startedAt < MAX_ELAPSED_MS;
}

function assertBudget(state: BudgetState, startedAt: number) {
  if (!withinBudget(state, startedAt)) throw new Error("project_understanding.budget_exhausted");
}

function normalizeRef(ref: string) {
  return ref.replaceAll("\\", "/").toLowerCase();
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function uniqueNodes(nodes: SemanticProjectNode[]) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function uniqueRelationships(relationships: SemanticProjectRelationship[]) {
  return [...new Map(relationships.map((relationship) => [relationship.id, relationship])).values()];
}

function uniqueFiles(files: Array<{ path: string; content: string }>) {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

function isRelationshipRequirement(value: unknown): value is QuestionDecomposition["requiredRelationships"][number] {
  return Boolean(value && typeof value === "object" && "fromConcept" in value && "toConcept" in value);
}

function isAnswerShape(value: unknown): value is QuestionDecomposition["expectedAnswerShape"] {
  return ["summary", "flow", "comparison", "decision_policy", "existence", "judgment"].includes(String(value));
}

type BudgetState = { providerCalls: number; repairIterations: number; escalationUsed: boolean };

const STOP_WORDS = new Set(["the", "and", "for", "from", "with", "this", "that", "what", "how", "why", "project", "code", "system"]);
