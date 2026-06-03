import type { WorkspaceIntentUnderstanding } from "./WorkspaceReasoningPipeline.js";
import { evidencePathDecision } from "./EvidenceHygiene.js";

export type InspectExplainReadLaneName =
  | "frontend"
  | "api"
  | "service"
  | "storage"
  | "tests"
  | "concept_search";

export type InspectExplainProofStatus = "proven" | "partial" | "unproven" | "rejected";

export type InspectExplainReadLaneFindingRole =
  | "ui_state"
  | "ui_event_handler"
  | "api_client_call"
  | "backend_route"
  | "service_logic"
  | "storage_target"
  | "storage_write"
  | "storage_read"
  | "log_append"
  | "training_or_retraining"
  | "job_or_scheduler"
  | "lifecycle_status"
  | "test_endpoint_expectation"
  | "algorithm_implementation"
  | "page_structure"
  | "wrapper_or_context"
  | "general_storage"
  | "documentation_context"
  | "unrelated_name_match";

export type InspectExplainReadLaneFinding = {
  id: string;
  lane: InspectExplainReadLaneName;
  role: InspectExplainReadLaneFindingRole;
  status: InspectExplainProofStatus;
  path: string;
  line: number;
  snippet: string;
  reason: string;
  symbol?: string;
  endpoint?: string;
  storageTarget?: string;
  ownerSymbol?: string;
  from?: string;
  to?: string;
  targetScoped?: boolean;
  confidence: "high" | "medium" | "low";
  relatedNames: string[];
};

export type InspectExplainReadLaneEdge = {
  id: string;
  fromLane: InspectExplainReadLaneName;
  toLane: InspectExplainReadLaneName | "synthesizer";
  relation: string;
  from?: string;
  to?: string;
  status: InspectExplainProofStatus;
  evidenceRefs: string[];
  reason: string;
  confidence: "high" | "medium" | "low";
};

export type InspectExplainReadLaneArtifact = {
  lane: InspectExplainReadLaneName;
  objective: string;
  inspectedFiles: string[];
  findings: InspectExplainReadLaneFinding[];
  edges: InspectExplainReadLaneEdge[];
  confidence: "high" | "medium" | "low";
  missingLinks: string[];
  rejectedEvidence: InspectExplainReadLaneFinding[];
  warnings: string[];
};

export type InspectExplainLaneSynthesizedGraph = {
  targetConcept: string;
  status: "confirmed" | "partial" | "not_found";
  confidence: "high" | "medium" | "low";
  edges: InspectExplainReadLaneEdge[];
  provenLinks: string[];
  partialLinks: string[];
  missingLinks: string[];
  rejectedLinks: string[];
  confirmedFiles: string[];
};

export type InspectExplainEvidenceReview = {
  valid: boolean;
  blockingReasons: string[];
  warnings: string[];
  rejectedClaims: Array<{
    rule: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  downgrades: Array<{
    claim: string;
    from: InspectExplainProofStatus;
    to: InspectExplainProofStatus;
    reason: string;
    evidenceRefs: string[];
  }>;
  answerPolicyHints: string[];
};

export type InspectExplainReadLaneRun = {
  id: string;
  targetConcept: string;
  topic: string;
  lanes: InspectExplainReadLaneName[];
  artifacts: InspectExplainReadLaneArtifact[];
  synthesizedGraph: InspectExplainLaneSynthesizedGraph;
  evidenceReview: InspectExplainEvidenceReview;
};

export type InspectExplainReadLaneInput = {
  userPrompt: string;
  targetConcept: string;
  topic: string;
  intent?: WorkspaceIntentUnderstanding;
  filePaths: string[];
  readFile: (relativePath: string) => string;
  maxFilesPerLane?: number;
  maxReadChars?: number;
};

export type ReadLaneAnswerValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

const TEXT_FILE_RE = /\.(c|cc|conf|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i;
const SOURCE_FILE_RE = /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|py|rs|ts|tsx)$/i;
const FRONTEND_FILE_RE = /\.(tsx|jsx|vue|svelte|html|css|scss)$/i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\.[a-z0-9]+$/i;
const DOC_PATH_RE = /\.(md|mdx|rst|txt)$/i;
const API_PATH_RE = /(^|\/)(api|routes?|controllers?|handlers?|server|backend)(\/|$)|routes?\.(ts|tsx|js|jsx|mjs|py|rs|go)$/i;
const LANE_ORDER: InspectExplainReadLaneName[] = ["frontend", "api", "service", "storage", "tests", "concept_search"];

const CONCEPT_ALIASES: Record<string, string[]> = {
  feedback: [
    "feedback",
    "customer feedback",
    "customer_feedback",
    "customer-feedback",
    "submitfeedback",
    "awaiting_feedback",
    "observed_outcome",
    "positive",
    "negative",
    "neutral",
    "outcome"
  ],
  outerloop: [
    "outerloop",
    "outer loop",
    "outer_loop",
    "feedback loop",
    "decision loop",
    "control loop",
    "action executor",
    "actionexecutor",
    "selected_action",
    "selected_action_name",
    "retention offer",
    "human review",
    "retraining"
  ],
  inner_loop: ["inner loop", "inner_loop", "innerloop", "model pipeline", "prediction", "decision", "svm", "dbscan"],
  inner_outer_loop: ["inner loop", "outer loop", "feedback loop", "decision loop", "action executor", "retraining"],
  multi_agent_system: ["multi agent", "multi-agent", "multi agentic", "multi-agentic", "multiagent", "agentic system", "agents", "specialist agents", "build_default_agents", "ReActOrchestrator", "orchestrator", "agent_recommendations", "agent_consensus", "weighted_votes", "choose_route"],
  dbscan: ["dbscan", "density-based", "density based", "fit_dbscan", "fit_predict"],
  fcm: ["fcm", "cmeans", "fuzzy c", "fuzzy c-means", "skfuzzy"],
  svm: ["svm", "svc", "support vector", "linearsvc", "predict_proba"],
  shap: ["shap", "kernelexplainer", "shap_values"],
  sarima: ["sarima", "sarimax", "arima", "forecast"]
};

export function runInspectExplainReadLanes(input: InspectExplainReadLaneInput): InspectExplainReadLaneRun {
  const targetConcept = normalizeConcept(input.targetConcept || input.intent?.topicPhrase || "general");
  const filePaths = uniqueStrings(input.filePaths.map(normalizePath).filter((file) => TEXT_FILE_RE.test(file) && !evidencePathDecision(file, input.userPrompt).excluded));
  const targetTerms = termsForTarget(targetConcept, input.userPrompt);
  const context: LaneContext = {
    ...input,
    targetConcept,
    targetTerms,
    filePaths,
    maxFilesPerLane: input.maxFilesPerLane ?? 220,
    maxReadChars: input.maxReadChars ?? 300_000
  };

  const artifacts = LANE_ORDER.map((lane) => runLane(lane, context));
  const synthesizedGraph = synthesizeLaneGraph(targetConcept, artifacts);
  const evidenceReview = reviewLaneEvidence(targetConcept, artifacts, synthesizedGraph);
  return {
    id: `read_lanes_${stableHash(`${input.userPrompt}\n${targetConcept}\n${filePaths.length}`)}`,
    targetConcept,
    topic: input.topic,
    lanes: LANE_ORDER,
    artifacts,
    synthesizedGraph,
    evidenceReview
  };
}

export function validateAnswerAgainstReadLaneEvidence(input: {
  answerMarkdown: string;
  targetConcept: string;
  readLaneRun: InspectExplainReadLaneRun;
}): ReadLaneAnswerValidation {
  const errors: string[] = [];
  const warnings = [...input.readLaneRun.evidenceReview.warnings];
  const answer = input.answerMarkdown;
  const normalized = normalizeText(answer);
  const target = normalizeConcept(input.targetConcept);
  const graph = input.readLaneRun.synthesizedGraph;
  const findings = allFindings(input.readLaneRun.artifacts);
  const apiClientCalls = findings.filter((item) => item.role === "api_client_call");
  const testEndpointExpectations = findings.filter((item) => item.role === "test_endpoint_expectation");
  const generalStorage = findings.filter((item) => item.role === "general_storage");
  const lifecycleOnly = findings.some((item) => item.role === "lifecycle_status")
    && !findings.some((item) => ["api_client_call", "backend_route", "storage_write", "log_append", "storage_read"].includes(item.role));
  const exposedInternalLabels = /\b(ui_state|ui_event_handler|api_client_call|backend_route|service_logic|storage_target|storage_write|log_append|general_storage|test_endpoint_expectation|mechanismCoverageValidation|directMechanismEvidence)\b/.test(answer);
  if (exposedInternalLabels) {
    errors.push("Answer exposes internal audit labels instead of user-facing evidence language.");
  }

  if (target === "feedback") {
    if (graph.status !== "confirmed" && /\b(end-to-end|complete|fully wired|implemented|persisted|stored|submitted|sent to backend|wired through)\b/i.test(answer)) {
      errors.push("Answer claims feedback is complete or implemented end-to-end even though the read lanes did not confirm the chain.");
    }
    if (testEndpointExpectations.length && !apiClientCalls.length && /\b(frontend|client|ui|browser|fetch|sent|submitted|calls?)\b/i.test(answer)) {
      errors.push("Answer treats test endpoint expectations as production frontend/client flow.");
    }
    if (generalStorage.length && mentionsAny(normalized, generalStorage.map((item) => item.storageTarget ?? "").filter(Boolean)) && /\b(feedback|proof|proves|stored|persisted|log)\b/i.test(answer)) {
      errors.push("Answer uses general storage evidence as proof for target-scoped feedback storage.");
    }
    if (lifecycleOnly && /\b(implemented|wired|stored|submitted|sent|backend)\b/i.test(answer)) {
      errors.push("Answer treats lifecycle/status text as a feedback implementation.");
    }
  }

  const rejectedPageStyle = findings.filter((item) => item.role === "unrelated_name_match" && /css|style|title-only|stylesheet/i.test(item.reason));
  if (rejectedPageStyle.length && /\b(css|style|stylesheet)\b.*\b(page|screen|view)\b/i.test(answer)) {
    errors.push("Answer counts CSS/style/title-only evidence as page structure.");
  }

  const wrapperOnly = findings.some((item) => item.role === "wrapper_or_context")
    && !findings.some((item) => item.role === "algorithm_implementation");
  if (wrapperOnly && /\balgorithms?\b/i.test(answer) && /\b(wrapper|service|manager)\b/i.test(answer) && !/\bnot counted|not enough|not proven\b/i.test(answer)) {
    errors.push("Answer appears to count wrappers or managers as algorithms without direct algorithm evidence.");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function laneScopedFilesForTopic(
  run: InspectExplainReadLaneRun,
  topic: string,
  fallbackFiles: string[]
): string[] {
  const byLane = new Map(run.artifacts.map((artifact) => [artifact.lane, artifact.inspectedFiles]));
  const from = (...lanes: InspectExplainReadLaneName[]) => uniqueStrings(lanes.flatMap((lane) => byLane.get(lane) ?? []));
  const target = run.targetConcept;
  let scoped: string[];
  if (topic === "frontend" || topic === "ui_controls") scoped = from("frontend");
  else if (topic === "algorithms" || ["dbscan", "fcm", "svm", "shap", "sarima"].includes(target)) scoped = from("service", "concept_search", "api");
  else if (topic === "training_inference") scoped = from("service", "api", "storage", "concept_search");
  else if (target === "feedback" || target.includes("loop") || target === "outerloop" || target === "inner_outer_loop") scoped = from("frontend", "api", "service", "storage", "tests", "concept_search");
  else scoped = from("concept_search", "service", "api", "frontend");
  return uniqueStrings(scoped.filter(Boolean)).slice(0, 260).length
    ? uniqueStrings(scoped.filter(Boolean)).slice(0, 260)
    : fallbackFiles;
}

type LaneContext = InspectExplainReadLaneInput & {
  targetConcept: string;
  targetTerms: string[];
  filePaths: string[];
  maxFilesPerLane: number;
  maxReadChars: number;
};

function runLane(lane: InspectExplainReadLaneName, context: LaneContext): InspectExplainReadLaneArtifact {
  const selectedFiles = selectLaneFiles(lane, context)
    .slice(0, context.maxFilesPerLane);
  const findings: InspectExplainReadLaneFinding[] = [];
  const warnings: string[] = [];
  for (const filePath of selectedFiles) {
    let text = "";
    try {
      text = context.readFile(filePath).slice(0, context.maxReadChars);
    } catch {
      warnings.push(`Could not read ${filePath}.`);
      continue;
    }
    if (!text.trim()) continue;
    findings.push(...scanFileForLane(lane, filePath, text, context));
  }
  const dedupedFindings = dedupeFindings(findings).slice(0, 80);
  const edges = dedupeEdges(dedupedFindings.map((finding) => edgeFromFinding(finding)).filter((edge): edge is InspectExplainReadLaneEdge => Boolean(edge)));
  const rejectedEvidence = dedupedFindings.filter((finding) => finding.status === "rejected" || finding.role === "general_storage" || finding.role === "unrelated_name_match");
  const missingLinks = missingLinksForLane(lane, dedupedFindings, context.targetConcept);
  return {
    lane,
    objective: laneObjective(lane, context.targetConcept),
    inspectedFiles: uniqueStrings(selectedFiles),
    findings: dedupedFindings,
    edges,
    confidence: laneConfidence(dedupedFindings, missingLinks),
    missingLinks,
    rejectedEvidence,
    warnings
  };
}

function selectLaneFiles(lane: InspectExplainReadLaneName, context: LaneContext) {
  const terms = context.targetTerms;
  const sorted = [...context.filePaths].sort((left, right) => laneFileScore(lane, right, terms) - laneFileScore(lane, left, terms) || left.localeCompare(right));
  const selected = sorted.filter((file) => laneFileScore(lane, file, terms) > 0);
  if (lane === "concept_search") return selected.length ? selected : sorted.filter((file) => SOURCE_FILE_RE.test(file));
  return selected;
}

function laneFileScore(lane: InspectExplainReadLaneName, filePath: string, terms: string[]) {
  const pathText = normalizeText(filePath);
  if (lane !== "tests" && TEST_PATH_RE.test(filePath)) return 0;
  let score = 0;
  if (lane === "frontend") {
    if (FRONTEND_FILE_RE.test(filePath)) score += 40;
    if (/(^|\/)(frontend|client|web|ui|components|pages|screens|views|app)\//i.test(filePath)) score += 50;
    if (/\.(css|scss)$/i.test(filePath)) score += 8;
  } else if (lane === "api") {
    if (API_PATH_RE.test(filePath)) score += 70;
    if (/@app\.|router\.|fastapi|express|endpoint|route/i.test(pathText)) score += 20;
  } else if (lane === "service") {
    if (SOURCE_FILE_RE.test(filePath)) score += 30;
    if (/(^|\/)(services?|models?|domain|core|lib|runtime|orchestration|agents?|scheduler)\//i.test(filePath)) score += 50;
    if (API_PATH_RE.test(filePath)) score += 10;
  } else if (lane === "storage") {
    if (SOURCE_FILE_RE.test(filePath) || /\.(json|yaml|yml|toml|csv|sql)$/i.test(filePath)) score += 20;
    if (/(storage|repository|repo|database|db|csv|log|memory|state|artifact|persist|retrain|feedback|data)/i.test(pathText)) score += 60;
  } else if (lane === "tests") {
    if (TEST_PATH_RE.test(filePath)) score += 80;
  } else if (lane === "concept_search") {
    if (SOURCE_FILE_RE.test(filePath)) score += 20;
    if (terms.some((term) => pathText.includes(term))) score += 80;
    if (/(readme|docs?|architecture)/i.test(filePath)) score += 8;
  }
  if (terms.some((term) => pathText.includes(term))) score += 30;
  if (DOC_PATH_RE.test(filePath) && lane !== "concept_search") score -= 30;
  return Math.max(0, score);
}

function scanFileForLane(
  lane: InspectExplainReadLaneName,
  filePath: string,
  text: string,
  context: LaneContext
): InspectExplainReadLaneFinding[] {
  const lines = text.split(/\r?\n/);
  const storageNames = collectStorageNames(lines);
  const owners = indexOwnerSymbols(lines);
  const findings: InspectExplainReadLaneFinding[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const snippet = snippetAround(lines, index);
    const role = classifyLaneRole(lane, filePath, line, snippet, context, storageNames);
    if (!role) continue;
    const lineNumber = index + 1;
    const endpoint = endpointForRole(role, line, snippet);
    const storageTarget = storageTargetForRole(role, line, snippet, storageNames);
    const ownerSymbol = ownerSymbolForRole(role, line, snippet, owners[index]);
    const targetScoped = storageTarget ? isTargetScopedStorage(`${line}\n${snippet}\n${ownerSymbol ?? ""}\n${endpoint ?? ""}`, context.targetConcept, context.targetTerms, storageTarget) : undefined;
    const finalRole = role === "storage_target" || role === "storage_write" || role === "storage_read" || role === "log_append"
      ? targetScoped === false ? "general_storage" : role
      : role;
    findings.push({
      id: `${lane}:${filePath}:${lineNumber}:${finalRole}:${endpoint ?? storageTarget ?? ownerSymbol ?? ""}`,
      lane,
      role: finalRole,
      status: statusForRole(finalRole, targetScoped),
      path: filePath,
      line: lineNumber,
      snippet,
      reason: reasonForRole(finalRole, context.targetConcept, targetScoped),
      symbol: extractNearestSymbol(snippet) ?? ownerSymbol,
      endpoint,
      storageTarget,
      ownerSymbol,
      from: inferFrom(finalRole, ownerSymbol, endpoint, storageTarget),
      to: inferTo(finalRole, endpoint, storageTarget),
      targetScoped,
      confidence: confidenceForRole(finalRole, targetScoped),
      relatedNames: relatedNamesForFinding(finalRole, line, snippet, endpoint, storageTarget).slice(0, 12)
    });
  }
  return findings;
}

function classifyLaneRole(
  lane: InspectExplainReadLaneName,
  filePath: string,
  line: string,
  snippet: string,
  context: LaneContext,
  storageNames: string[]
): InspectExplainReadLaneFindingRole | undefined {
  const haystack = `${line}\n${snippet}`;
  const normalized = normalizeText(haystack);
  const targetSeen = context.targetTerms.some((term) => normalized.includes(term));
  if (lane === "tests") {
    if (extractEndpoint(haystack)) return "test_endpoint_expectation";
    if (targetSeen) return "documentation_context";
    return undefined;
  }
  if (lane === "frontend") {
    if (/\.(css|scss)$/i.test(filePath) && /\b(page|screen|view|section|route|tab)\b/i.test(haystack)) return "unrelated_name_match";
    if (isClientSourceFile(filePath) && /\b(fetch|axios|XMLHttpRequest|apiClient|client\.|apiGet|apiPost|request|postJson|getJson)\b/i.test(haystack) && isConcreteEndpoint(extractEndpoint(line) ?? extractEndpoint(snippet))) return "api_client_call";
    if (isClientSourceFile(filePath) && targetSeen && /\b(onSubmit|onClick|onChange|handle[A-Z][A-Za-z0-9_]*|submit[A-Z][A-Za-z0-9_]*|button|form|textarea|input|select)\b/i.test(haystack)) return "ui_event_handler";
    if (isClientSourceFile(filePath) && targetSeen && /\b(useState|state|set[A-Z][A-Za-z0-9_]*|submitting|message|label)\b/i.test(haystack)) return "ui_state";
    if (isClientSourceFile(filePath) && /\b(BrowserRouter|createBrowserRouter|Routes|Route|router|href=|data-view|data-page|CHAPTERS|PAGES|ROUTES|VIEWS|TABS)\b|<\s*(nav|section|aside|main|a|button)\b/i.test(haystack)) return "page_structure";
    return undefined;
  }
  if (lane === "api") {
    if (/@(?:app|router)\.(?:get|post|put|delete|patch)\(["']|(?:app|router)\.(?:get|post|put|delete|patch)\(["']|FastAPI\(|express\(/.test(haystack) && extractEndpoint(haystack)) return "backend_route";
    if (API_PATH_RE.test(filePath) && targetSeen && /\b(def|function|async|handler|controller|route|payload|request|response)\b/i.test(haystack)) return "service_logic";
    return undefined;
  }
  if (lane === "storage") {
    if (storageNames.some((name) => line.includes(name)) && /\b[A-Z0-9_]*(?:LOG|CSV|FILE|PATH)[A-Z0-9_]*\b/.test(line)) return "storage_target";
    if (targetSeen && /(?:^|[^A-Za-z0-9_])_?(?:append|record|write|save|persist|log)_[A-Za-z0-9_]*(?:feedback|outcome|retrain|log)|(?:^|[^A-Za-z0-9_])_?[A-Za-z0-9_]*(?:feedback|outcome|retrain|log)[A-Za-z0-9_]*(?:append|record|write|save|persist|log)\b/i.test(line)) return "log_append";
    if (isStorageWrite(line) && storageNames.some((name) => haystack.includes(name))) return isLogLike(haystack) ? "log_append" : "storage_write";
    if (isStorageRead(line) && storageNames.some((name) => haystack.includes(name))) return "storage_read";
    if (targetSeen && /\b(retrain|retraining|scheduler|job|queue|candidate)\b/i.test(haystack)) return "training_or_retraining";
    return undefined;
  }
  if (lane === "service") {
    if (isAlgorithmImplementation(haystack, context.targetConcept)) return "algorithm_implementation";
    if (/\b(retrain|retraining|train_|fit\(|joblib\.dump|pickle\.dump|scheduler|cron|queue)\b/i.test(haystack)) return "training_or_retraining";
    if (/\b(job|scheduler|cron|interval|queue)\b/i.test(haystack) && targetSeen) return "job_or_scheduler";
    if (targetSeen && /\b(awaiting_feedback|pending_feedback|observed_outcome|status|state|lifecycle)\b/i.test(haystack)) return "lifecycle_status";
    if (targetSeen && /\b(def|function|class|return|if |elif |else|selected_action|decision|execute|recommend|review|offer|pass|fail)\b/i.test(haystack)) return "service_logic";
    if (targetSeen) return "wrapper_or_context";
    return undefined;
  }
  if (lane === "concept_search") {
    if (isAlgorithmImplementation(haystack, context.targetConcept)) return "algorithm_implementation";
    if (targetSeen && TEST_PATH_RE.test(filePath)) return "test_endpoint_expectation";
    if (targetSeen && DOC_PATH_RE.test(filePath)) return "documentation_context";
    if (targetSeen && /\b(fetch|axios|XMLHttpRequest|apiGet|apiPost|apiClient|client\.|request|postJson|getJson)\b/i.test(haystack) && isConcreteEndpoint(extractEndpoint(line) ?? extractEndpoint(snippet))) return "api_client_call";
    if (targetSeen && extractEndpoint(haystack) && API_PATH_RE.test(filePath)) return "backend_route";
    if (targetSeen && /\b(def|function|class|return|execute|selected_action|decision|feedback|outcome|retrain)\b/i.test(haystack)) return "service_logic";
    if (targetSeen) return "wrapper_or_context";
  }
  return undefined;
}

function synthesizeLaneGraph(targetConcept: string, artifacts: InspectExplainReadLaneArtifact[]): InspectExplainLaneSynthesizedGraph {
  const target = normalizeConcept(targetConcept);
  if (target === "feedback") return synthesizeFeedbackGraph(target, artifacts);
  if (target.includes("loop") || target === "outerloop" || target === "inner_outer_loop") return synthesizeLoopGraph(target, artifacts);
  return synthesizeGenericGraph(target, artifacts);
}

function synthesizeFeedbackGraph(targetConcept: string, artifacts: InspectExplainReadLaneArtifact[]): InspectExplainLaneSynthesizedGraph {
  const findings = allFindings(artifacts);
  const edges: InspectExplainReadLaneEdge[] = [];
  const push = (relation: string, status: InspectExplainProofStatus, items: InspectExplainReadLaneFinding[], reason: string, from?: string, to?: string) => {
    if (!items.length) return;
    edges.push(createSyntheticEdge(relation, status, items, reason, from, to));
  };
  const ui = findings.filter((item) => item.role === "ui_event_handler" || item.role === "ui_state");
  const apiCalls = findings.filter((item) => item.role === "api_client_call" && item.endpoint);
  const routes = findings.filter((item) => item.role === "backend_route" && item.endpoint);
  const routeEndpointKeys = new Set(routes.map((item) => endpointMatchKey(item.endpoint)).filter(Boolean));
  const matchedApi = apiCalls.filter((item) => item.endpoint && routeEndpointKeys.has(endpointMatchKey(item.endpoint)));
  const storage = findings
    .filter((item) => (item.role === "storage_write" || item.role === "log_append" || item.role === "storage_read") && item.targetScoped !== false)
    .sort((left, right) => feedbackStorageFindingScore(right) - feedbackStorageFindingScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
  const storageTargets = findings
    .filter((item) => item.role === "storage_target" && item.targetScoped !== false)
    .sort((left, right) => feedbackStorageFindingScore(right) - feedbackStorageFindingScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
  const downstream = findings.filter((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler");
  const tests = findings.filter((item) => item.role === "test_endpoint_expectation");

  push("frontend_surface", ui.some((item) => item.role === "ui_event_handler") ? "proven" : "partial", ui, "Frontend lane found a feedback surface or submit handler.", ui[0]?.ownerSymbol, ui[0]?.endpoint);
  push("frontend_to_api", apiCalls.length ? "proven" : "partial", apiCalls.length ? apiCalls : tests, apiCalls.length ? "Frontend lane found a production client/API call." : "Tests mention an endpoint, but no production client call was found.", apiCalls[0]?.ownerSymbol ?? "client", apiCalls[0]?.endpoint ?? tests[0]?.endpoint);
  push("api_to_backend", matchedApi.length ? "proven" : routes.length && apiCalls.length ? "partial" : routes.length ? "partial" : "unproven", matchedApi.length ? [...matchedApi, ...routes.filter((route) => endpointMatchKey(route.endpoint) === endpointMatchKey(matchedApi[0]?.endpoint))] : routes, matchedApi.length ? "Client endpoint matches a backend route." : "Backend route evidence exists without a matched production client call.", matchedApi[0]?.endpoint ?? routes[0]?.endpoint, routes[0]?.ownerSymbol);
  push("backend_to_storage", storage.length ? "proven" : storageTargets.length ? "partial" : "unproven", storage.length ? storage : storageTargets, storage.length ? "Target-scoped feedback storage/log read or write exists." : "Feedback storage target is declared, but no read/write was proven.", storage[0]?.ownerSymbol, storage[0]?.storageTarget ?? storageTargets[0]?.storageTarget);
  push("downstream_feedback_consumer", downstream.length ? "proven" : "unproven", downstream, "Feedback has a downstream consumer such as retraining or a scheduled job.", downstream[0]?.ownerSymbol, downstream[0]?.storageTarget);

  const proven = edgeRelations(edges, "proven");
  const partial = edgeRelations(edges, "partial");
  const missing = [
    !ui.length ? "frontend_feedback_surface" : "",
    !apiCalls.length ? "frontend_to_backend_request" : "",
    !(matchedApi.length || routes.length) ? "backend_feedback_handler" : "",
    !storage.length ? "feedback_storage_or_log_usage" : "",
    !downstream.length ? "downstream_feedback_consumer" : ""
  ].filter(Boolean);
  const confirmed = proven.includes("frontend_to_api") && proven.includes("api_to_backend") && proven.includes("backend_to_storage");
  return createSynthesizedGraph(targetConcept, edges, confirmed ? "confirmed" : edges.length ? "partial" : "not_found", missing, findings);
}

function synthesizeLoopGraph(targetConcept: string, artifacts: InspectExplainReadLaneArtifact[]): InspectExplainLaneSynthesizedGraph {
  const findings = allFindings(artifacts);
  const target = normalizeConcept(targetConcept);
  const innerOnly = target === "inner_loop";
  const decision = findings.filter((item) => innerOnly
    ? item.role === "service_logic" || item.role === "algorithm_implementation" || item.role === "wrapper_or_context"
    : isOuterLoopDecisionFinding(item));
  const feedback = findings.filter((item) => innerOnly
    ? ["lifecycle_status", "service_logic", "algorithm_implementation"].includes(item.role)
    : isOuterLoopFeedbackFinding(item));
  const updates = findings.filter((item) => innerOnly
    ? item.role === "training_or_retraining" || item.role === "job_or_scheduler"
    : isOuterLoopUpdateFinding(item));
  const edges: InspectExplainReadLaneEdge[] = [];
  if (decision.length) edges.push(createSyntheticEdge("decision_action_stage", decision.some((item) => item.role === "service_logic" || item.role === "algorithm_implementation") ? "proven" : "partial", decision, "Decision/action evidence was found."));
  if (feedback.length) edges.push(createSyntheticEdge("feedback_or_outcome_stage", feedback.some((item) => ["api_client_call", "backend_route", "storage_write", "log_append"].includes(item.role)) ? "proven" : "partial", feedback, "Feedback or outcome evidence was found."));
  if (updates.length) edges.push(createSyntheticEdge("state_log_or_retraining_update", updates.some((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler") ? "proven" : "partial", updates, "State/log/retraining update evidence was found."));
  const proven = edgeRelations(edges, "proven");
  const missing = [
    !decision.length ? "inner_model_or_decision_stage" : "",
    !feedback.length ? "feedback_or_outcome_stage" : "",
    !updates.length ? "state_log_or_retraining_update" : "",
    !updates.some((item) => item.role === "training_or_retraining" || item.role === "job_or_scheduler") ? "next_cycle_effect" : ""
  ].filter(Boolean);
  const confirmed = proven.includes("decision_action_stage") && proven.includes("feedback_or_outcome_stage") && proven.includes("state_log_or_retraining_update");
  return createSynthesizedGraph(targetConcept, edges, confirmed ? "confirmed" : edges.length ? "partial" : "not_found", missing, findings);
}

function isOuterLoopDecisionFinding(finding: InspectExplainReadLaneFinding) {
  if (!["service_logic", "lifecycle_status", "wrapper_or_context"].includes(finding.role)) return false;
  const text = loopEvidenceText(finding);
  return /\b(action|decision|selected_action|selected_action_name|recommend|recommendation|offer|retention|review|human_review|manual_review|probability_gap|low_gap|high_gap|execute|executor)\b/i.test(text);
}

function isOuterLoopFeedbackFinding(finding: InspectExplainReadLaneFinding) {
  const text = loopEvidenceText(finding);
  if (!["api_client_call", "backend_route", "storage_write", "log_append", "storage_read", "storage_target", "lifecycle_status", "ui_event_handler", "ui_state", "service_logic"].includes(finding.role)) return false;
  return /\b(feedback|customer-feedback|customer_feedback|outcome|observed_outcome|awaiting_feedback|pending_feedback|positive|negative|neutral)\b/i.test(text);
}

function isOuterLoopUpdateFinding(finding: InspectExplainReadLaneFinding) {
  const text = loopEvidenceText(finding);
  if (finding.role === "job_or_scheduler") return /\b(feedback|outcome|retrain|retraining|review|queue|candidate)\b/i.test(text);
  if (finding.role === "training_or_retraining") return /\b(retrain|retraining|feedback_label|feedback|outcome|candidate|queued_for_retraining)\b/i.test(text);
  if (["storage_write", "log_append", "storage_read", "storage_target"].includes(finding.role)) {
    return finding.targetScoped !== false && /\b(feedback|customer_feedback|customer-feedback|retrain|retraining|outcome|candidate)\b/i.test(text);
  }
  return false;
}

function loopEvidenceText(finding: InspectExplainReadLaneFinding) {
  return [
    finding.path,
    finding.snippet,
    finding.ownerSymbol,
    finding.endpoint,
    finding.storageTarget,
    ...finding.relatedNames
  ].filter(Boolean).join("\n");
}

function synthesizeGenericGraph(targetConcept: string, artifacts: InspectExplainReadLaneArtifact[]): InspectExplainLaneSynthesizedGraph {
  const findings = allFindings(artifacts);
  const direct = findings.filter((item) => item.role === "algorithm_implementation" || item.role === "service_logic" || item.role === "backend_route" || item.role === "page_structure");
  const edges = direct.length ? [createSyntheticEdge("target_implementation_evidence", direct.some((item) => item.role !== "wrapper_or_context") ? "proven" : "partial", direct, "Target-scoped implementation evidence was found.")] : [];
  const missing = direct.length ? [] : ["target_implementation_evidence"];
  return createSynthesizedGraph(targetConcept, edges, edges.length ? "confirmed" : "not_found", missing, findings);
}

function reviewLaneEvidence(
  targetConcept: string,
  artifacts: InspectExplainReadLaneArtifact[],
  graph: InspectExplainLaneSynthesizedGraph
): InspectExplainEvidenceReview {
  const findings = allFindings(artifacts);
  const warnings: string[] = [];
  const blockingReasons: string[] = [];
  const rejectedClaims: InspectExplainEvidenceReview["rejectedClaims"] = [];
  const downgrades: InspectExplainEvidenceReview["downgrades"] = [];
  const policy = [
    "Use proven links for direct claims.",
    "Label partial chains as partial.",
    "Say not proven for missing links.",
    "Do not expose internal audit role labels."
  ];
  const refs = (items: InspectExplainReadLaneFinding[]) => items.slice(0, 6).map((item) => `${item.path}:${item.line}`);
  const tests = findings.filter((item) => item.role === "test_endpoint_expectation");
  const apiCalls = findings.filter((item) => item.role === "api_client_call");
  const generalStorage = findings.filter((item) => item.role === "general_storage");
  const targetStorageWrites = findings.filter((item) => (item.role === "storage_write" || item.role === "log_append" || item.role === "storage_read") && item.targetScoped !== false);
  const lifecycle = findings.filter((item) => item.role === "lifecycle_status");
  const hardMechanism = findings.filter((item) => ["api_client_call", "backend_route", "storage_write", "log_append", "storage_read"].includes(item.role));
  const wrappers = findings.filter((item) => item.role === "wrapper_or_context");
  const algorithmImplementation = findings.filter((item) => item.role === "algorithm_implementation");

  if (tests.length && !apiCalls.length) {
    warnings.push("Endpoint evidence from tests is expectation-only; it does not prove production frontend/client flow.");
    rejectedClaims.push({ rule: "tests_are_not_frontend_flow", reason: "Test endpoint calls cannot prove production UI/API wiring.", evidenceRefs: refs(tests) });
  }
  if (generalStorage.length && !targetStorageWrites.length) {
    warnings.push("General storage evidence was rejected as target-scoped persistence proof.");
    rejectedClaims.push({ rule: "general_storage_not_target_storage", reason: "Storage/log evidence is not scoped to the requested concept.", evidenceRefs: refs(generalStorage) });
  }
  if (lifecycle.length && !hardMechanism.length) {
    warnings.push("Lifecycle/status evidence was downgraded to partial context.");
    downgrades.push({ claim: "lifecycle/status implementation", from: "proven", to: "partial", reason: "Status text does not prove a submit, route, or persistence path.", evidenceRefs: refs(lifecycle) });
  }
  if (wrappers.length && !algorithmImplementation.length && /\balgorithm|model|dbscan|svm|fcm|shap|sarima\b/i.test(targetConcept)) {
    warnings.push("Wrapper/context evidence was not counted as a concrete algorithm implementation.");
    rejectedClaims.push({ rule: "wrappers_are_not_algorithms", reason: "A wrapper or manager is not an algorithm unless direct model/algorithm calls are present.", evidenceRefs: refs(wrappers) });
  }
  const rejectedPageStyles = findings.filter((item) => item.role === "unrelated_name_match" && /stylesheet|css|style|title-only/i.test(item.reason));
  if (rejectedPageStyles.length) {
    warnings.push("CSS/style/title-only evidence was rejected for page inventory claims.");
    rejectedClaims.push({ rule: "style_is_not_page_structure", reason: "Stylesheets and title-only mentions do not prove rendered pages/screens.", evidenceRefs: refs(rejectedPageStyles) });
  }
  if (graph.status === "not_found" && findings.some((item) => item.role !== "unrelated_name_match" && item.role !== "general_storage")) {
    warnings.push("Related evidence exists, but the synthesizer could not prove the requested mechanism.");
  }
  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
    warnings: uniqueStrings(warnings),
    rejectedClaims,
    downgrades,
    answerPolicyHints: policy
  };
}

function createSynthesizedGraph(
  targetConcept: string,
  edges: InspectExplainReadLaneEdge[],
  status: InspectExplainLaneSynthesizedGraph["status"],
  missingLinks: string[],
  findings: InspectExplainReadLaneFinding[]
): InspectExplainLaneSynthesizedGraph {
  return {
    targetConcept,
    status,
    confidence: status === "confirmed" ? "high" : status === "partial" ? "medium" : "low",
    edges: dedupeEdges(edges),
    provenLinks: edgeRelations(edges, "proven"),
    partialLinks: edgeRelations(edges, "partial"),
    missingLinks: uniqueStrings(missingLinks),
    rejectedLinks: uniqueStrings(findings.filter((item) => item.status === "rejected" || item.role === "general_storage").map((item) => item.role)),
    confirmedFiles: uniqueStrings(edges.flatMap((edge) => edge.evidenceRefs.map((ref) => ref.split(":").slice(0, -1).join(":")))).filter(Boolean)
  };
}

function createSyntheticEdge(
  relation: string,
  status: InspectExplainProofStatus,
  items: InspectExplainReadLaneFinding[],
  reason: string,
  from?: string,
  to?: string
): InspectExplainReadLaneEdge {
  return {
    id: `synth:${relation}:${stableHash(items.map((item) => item.id).join("|"))}`,
    fromLane: items[0]?.lane ?? "concept_search",
    toLane: "synthesizer",
    relation,
    from,
    to,
    status,
    evidenceRefs: uniqueStrings(items.slice(0, 6).map((item) => `${item.path}:${item.line}`)),
    reason,
    confidence: status === "proven" ? "high" : status === "partial" ? "medium" : "low"
  };
}

function edgeFromFinding(finding: InspectExplainReadLaneFinding): InspectExplainReadLaneEdge | undefined {
  const ref = `${finding.path}:${finding.line}`;
  if (finding.role === "api_client_call") return createLaneEdge(finding, "frontend_to_api", finding.ownerSymbol, finding.endpoint, "Client code calls an API endpoint.", [ref]);
  if (finding.role === "backend_route") return createLaneEdge(finding, "api_to_backend", finding.endpoint, finding.ownerSymbol, "Backend route handles an endpoint.", [ref]);
  if (finding.role === "storage_write" || finding.role === "log_append" || finding.role === "storage_read") return createLaneEdge(finding, "backend_to_storage", finding.ownerSymbol, finding.storageTarget, "Code reads or writes target-scoped storage.", [ref]);
  if (finding.role === "training_or_retraining" || finding.role === "job_or_scheduler") return createLaneEdge(finding, "downstream_feedback_consumer", finding.ownerSymbol, finding.storageTarget, "Downstream training/retraining or job evidence.", [ref]);
  if (finding.role === "test_endpoint_expectation") return createLaneEdge(finding, "test_endpoint_expectation", "test", finding.endpoint, "A test expects endpoint behavior.", [ref]);
  if (finding.role === "page_structure") return createLaneEdge(finding, "page_structure", finding.path, finding.symbol, "Frontend structural evidence.", [ref]);
  if (finding.role === "algorithm_implementation") return createLaneEdge(finding, "algorithm_implementation", finding.ownerSymbol, finding.symbol, "Direct algorithm/model implementation evidence.", [ref]);
  return undefined;
}

function createLaneEdge(
  finding: InspectExplainReadLaneFinding,
  relation: string,
  from: string | undefined,
  to: string | undefined,
  reason: string,
  evidenceRefs: string[]
): InspectExplainReadLaneEdge {
  return {
    id: `${finding.lane}:${relation}:${finding.path}:${finding.line}`,
    fromLane: finding.lane,
    toLane: nextLaneForRelation(relation),
    relation,
    from,
    to,
    status: finding.status === "rejected" ? "rejected" : finding.status,
    evidenceRefs,
    reason,
    confidence: finding.confidence
  };
}

function nextLaneForRelation(relation: string): InspectExplainReadLaneEdge["toLane"] {
  if (relation === "frontend_to_api") return "api";
  if (relation === "api_to_backend") return "service";
  if (relation === "backend_to_storage") return "storage";
  if (relation === "test_endpoint_expectation") return "api";
  return "synthesizer";
}

function missingLinksForLane(
  lane: InspectExplainReadLaneName,
  findings: InspectExplainReadLaneFinding[],
  targetConcept: string
) {
  const target = normalizeConcept(targetConcept);
  const missing: string[] = [];
  if (target === "feedback") {
    if (lane === "frontend") {
      if (!findings.some((item) => item.role === "ui_state" || item.role === "ui_event_handler")) missing.push("frontend_feedback_surface");
      if (!findings.some((item) => item.role === "api_client_call")) missing.push("frontend_to_backend_request");
    }
    if (lane === "api" && !findings.some((item) => item.role === "backend_route")) missing.push("backend_feedback_handler");
    if (lane === "storage" && !findings.some((item) => (item.role === "storage_write" || item.role === "log_append" || item.role === "storage_read") && item.targetScoped !== false)) missing.push("feedback_storage_or_log_usage");
  }
  return missing;
}

function laneObjective(lane: InspectExplainReadLaneName, targetConcept: string) {
  if (lane === "frontend") return `Find UI surfaces, controls, state, and client calls related to ${targetConcept}.`;
  if (lane === "api") return `Find routes, endpoints, and request handlers related to ${targetConcept}.`;
  if (lane === "service") return `Find service logic, algorithms, decisions, and lifecycle statuses related to ${targetConcept}.`;
  if (lane === "storage") return `Find storage targets, reads/writes, logs, and downstream consumers related to ${targetConcept}.`;
  if (lane === "tests") return `Find test expectations related to ${targetConcept}, without treating them as production flow.`;
  return `Find literal, alias, and behavioral evidence for ${targetConcept}.`;
}

function laneConfidence(findings: InspectExplainReadLaneFinding[], missingLinks: string[]): "high" | "medium" | "low" {
  if (findings.some((item) => item.status === "proven") && missingLinks.length === 0) return "high";
  if (findings.length) return "medium";
  return "low";
}

function statusForRole(role: InspectExplainReadLaneFindingRole, targetScoped?: boolean): InspectExplainProofStatus {
  if (role === "general_storage" || role === "unrelated_name_match") return "rejected";
  if (targetScoped === false) return "rejected";
  if (["ui_state", "storage_target", "lifecycle_status", "wrapper_or_context", "documentation_context", "test_endpoint_expectation"].includes(role)) return "partial";
  return "proven";
}

function confidenceForRole(role: InspectExplainReadLaneFindingRole, targetScoped?: boolean): "high" | "medium" | "low" {
  if (targetScoped === false || role === "general_storage" || role === "unrelated_name_match") return "low";
  if (["api_client_call", "backend_route", "storage_write", "storage_read", "log_append", "algorithm_implementation"].includes(role)) return "high";
  if (["ui_event_handler", "service_logic", "training_or_retraining", "job_or_scheduler", "page_structure"].includes(role)) return "medium";
  return "low";
}

function reasonForRole(role: InspectExplainReadLaneFindingRole, targetConcept: string, targetScoped?: boolean) {
  if (role === "ui_state") return `UI state mentions ${targetConcept}; this proves surface state only.`;
  if (role === "ui_event_handler") return `UI handler/control mentions ${targetConcept}.`;
  if (role === "api_client_call") return `Production client code calls a target-related endpoint.`;
  if (role === "backend_route") return `Backend route handles a target-related endpoint.`;
  if (role === "storage_target") return `Target-scoped storage/log path is declared.`;
  if (role === "storage_write" || role === "log_append") return targetScoped === false ? "General storage write rejected as target proof." : `Target-scoped storage/log write is present.`;
  if (role === "storage_read") return targetScoped === false ? "General storage read rejected as target proof." : `Target-scoped storage/log read is present.`;
  if (role === "general_storage") return `Storage evidence is not scoped to ${targetConcept}.`;
  if (role === "test_endpoint_expectation") return `A test expects endpoint behavior; this is not production client flow.`;
  if (role === "algorithm_implementation") return `Direct algorithm/model implementation evidence.`;
  if (role === "page_structure") return `Rendered UI structure evidence.`;
  if (role === "unrelated_name_match") return `Stylesheet, title-only, or unrelated name match rejected as implementation evidence.`;
  if (role === "lifecycle_status") return `Lifecycle/status text mentions ${targetConcept}; this is partial context.`;
  return `Evidence is related to ${targetConcept}.`;
}

function isAlgorithmImplementation(text: string, targetConcept: string) {
  const normalized = normalizeText(text);
  const target = normalizeConcept(targetConcept);
  if (target === "dbscan") return /\bDBSCAN\b|\.fit_predict\(|fit_dbscan\b/i.test(text);
  if (target === "fcm") return /\bcmeans\b|skfuzzy|fuzzy c/i.test(text);
  if (target === "svm") return /\bSVC\b|LinearSVC|predict_proba|support vector/i.test(text);
  if (target === "shap") return /\bshap\b|KernelExplainer|shap_values/i.test(text);
  if (target === "sarima") return /\bSARIMAX?\b|\bARIMA\b|forecast/i.test(text);
  return /\b(DBSCAN|SVC|LinearSVC|KernelExplainer|SARIMAX?|ARIMA|cmeans|fit_predict|predict_proba|RandomForest|LogisticRegression|KMeans)\b/i.test(text)
    || (/\b(fit|predict|train)\(/.test(normalized) && /\b(model|classifier|cluster|forecast)\b/.test(normalized));
}

function isClientSourceFile(filePath: string) {
  const normalized = normalizePath(filePath);
  if (TEST_PATH_RE.test(normalized)) return false;
  if (/(^|\/)(backend|server|api|routes?|controllers?)\//i.test(normalized)) return false;
  return FRONTEND_FILE_RE.test(normalized) || /(^|\/)(frontend|client|web|ui|components|hooks|pages|app)\//i.test(normalized);
}

function endpointForRole(role: InspectExplainReadLaneFindingRole, line: string, snippet: string) {
  if (role === "api_client_call" || role === "backend_route" || role === "test_endpoint_expectation") {
    return extractEndpoint(line) ?? extractEndpoint(snippet);
  }
  return undefined;
}

function storageTargetForRole(role: InspectExplainReadLaneFindingRole, line: string, snippet: string, storageNames: string[]) {
  if (!["storage_target", "storage_write", "storage_read", "log_append", "general_storage"].includes(role)) return undefined;
  return extractStorageTarget(line, storageNames) ?? extractStorageTarget(snippet, storageNames);
}

function ownerSymbolForRole(role: InspectExplainReadLaneFindingRole, line: string, snippet: string, currentOwner?: string) {
  if (role === "backend_route") return nextSymbol(snippet) ?? currentOwner;
  return currentOwner ?? extractNearestSymbol(line) ?? extractNearestSymbol(snippet);
}

function relatedNamesForFinding(
  role: InspectExplainReadLaneFindingRole,
  line: string,
  snippet: string,
  endpoint?: string,
  storageTarget?: string
) {
  const names = extractIdentifiers(role === "ui_state" || role === "ui_event_handler" ? snippet : line);
  return uniqueStrings([
    ...names,
    endpoint,
    storageTarget
  ].filter(Boolean) as string[]);
}

function collectStorageNames(lines: string[]) {
  const names: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(/\b([A-Z][A-Z0-9_]*(?:LOG|CSV|FILE|PATH)[A-Z0-9_]*)\b/g)) {
      if (match[1]) names.push(match[1]);
    }
  }
  return uniqueStrings(names);
}

function extractEndpoint(text: string) {
  return text.match(/["'](\/api\/[^"'\s)]+)["']/i)?.[1]
    ?? text.match(/["'](\/[A-Za-z0-9_./:-]+)["']/)?.[1];
}

function endpointMatchKey(endpoint?: string) {
  if (!endpoint) return "";
  return endpoint.replace(/\/+$/g, "").replace(/^\/api(?=\/)/i, "") || "/";
}

function isConcreteEndpoint(endpoint?: string) {
  const key = endpointMatchKey(endpoint);
  return key !== "" && key !== "/" && key.startsWith("/") && !key.includes("${");
}

function feedbackStorageFindingScore(item: InspectExplainReadLaneFinding) {
  const text = `${item.storageTarget ?? ""}\n${item.ownerSymbol ?? ""}\n${item.symbol ?? ""}\n${item.snippet}`;
  let score = item.role === "log_append" || item.role === "storage_write" ? 30 : 0;
  if (/\bcustomer_feedback|customer-feedback|customer feedback|feedback_log|feedback[-_]?log\b/i.test(text)) score += 100;
  else if (/\bfeedback\b/i.test(text)) score += 50;
  if (/\bretrain|retraining\b/i.test(text) && !/\bcustomer_feedback|customer-feedback|feedback_log\b/i.test(text)) score -= 25;
  return score;
}

function extractStorageTarget(text: string, storageNames: string[]) {
  for (const name of storageNames) {
    if (text.includes(name)) return name;
  }
  return text.match(/["']([^"'\r\n]*(?:feedback|outcome|retrain|log|csv|state)[^"'\r\n]*)["']/i)?.[1];
}

function isStorageWrite(line: string) {
  return /\b(open\([^)]*["']a["']|open\([^)]*["']w["']|writerow|writerows|to_csv|dump|write|append|insert|save)\b/i.test(line);
}

function isStorageRead(line: string) {
  return /\b(open\(|read_csv|load|loads|read|select|find)\b/i.test(line) && !isStorageWrite(line);
}

function isLogLike(text: string) {
  return /\b(log|csv|feedback|outcome|retrain)\b/i.test(text);
}

function isTargetScopedStorage(text: string, targetConcept: string, targetTerms: string[], storageTarget?: string) {
  const haystack = normalizeText(`${text}\n${storageTarget ?? ""}`);
  if (targetTerms.some((term) => haystack.includes(term))) return true;
  const target = normalizeConcept(targetConcept);
  if (target === "feedback" && /\b(customer_feedback|feedback[_-]?log|feedback|observed_outcome|rating|label)\b/i.test(haystack)) return true;
  if (target.includes("loop") && /\b(feedback|outcome|retrain|state|decision|action)\b/i.test(haystack)) return true;
  return false;
}

function inferFrom(role: InspectExplainReadLaneFindingRole, ownerSymbol?: string, endpoint?: string, storageTarget?: string) {
  if (role === "api_client_call") return ownerSymbol;
  if (role === "backend_route") return endpoint;
  if (role === "test_endpoint_expectation") return "test";
  if (role === "storage_write" || role === "log_append" || role === "storage_read") return ownerSymbol;
  return ownerSymbol ?? endpoint ?? storageTarget;
}

function inferTo(role: InspectExplainReadLaneFindingRole, endpoint?: string, storageTarget?: string) {
  if (role === "api_client_call" || role === "backend_route" || role === "test_endpoint_expectation") return endpoint;
  if (role === "storage_target" || role === "storage_write" || role === "storage_read" || role === "log_append" || role === "general_storage") return storageTarget;
  return undefined;
}

function indexOwnerSymbols(lines: string[]) {
  const owners: Array<string | undefined> = [];
  let currentClass = "";
  let currentFunction = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const classMatch = line.match(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch?.[1]) currentClass = classMatch[1];
    const functionMatch = line.match(/^\s*(?:async\s+)?(?:function\s+|def\s+)([A-Za-z_][A-Za-z0-9_]*)|^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\(?/);
    if (functionMatch?.[1] || functionMatch?.[2]) currentFunction = functionMatch[1] ?? functionMatch[2] ?? "";
    owners[index] = currentFunction ? (currentClass ? `${currentClass}.${currentFunction}` : currentFunction) : currentClass || undefined;
  }
  return owners;
}

function extractNearestSymbol(text: string) {
  return text.match(/\b(?:def|class|function)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    ?? text.match(/\b(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    ?? text.match(/@(?:app|router)\.(?:get|post|put|delete|patch)\(["']([^"']+)["']/)?.[1];
}

function nextSymbol(snippet: string) {
  return snippet.match(/\n\s*(?:async\s+)?(?:def|function)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    ?? snippet.match(/\n\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
}

function extractIdentifiers(text: string) {
  return uniqueStrings(Array.from(text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g)).map((match) => match[0])).slice(0, 16);
}

function termsForTarget(targetConcept: string, userPrompt: string) {
  const target = normalizeConcept(targetConcept);
  const promptTerms = Array.from(userPrompt.matchAll(/\b[A-Za-z_][A-Za-z0-9_-]{2,}\b/g)).map((match) => normalizeConcept(match[0]));
  return uniqueStrings([
    target,
    target.replace(/\s+/g, "_"),
    target.replace(/\s+/g, "-"),
    target.replace(/\s+/g, ""),
    ...(CONCEPT_ALIASES[target] ?? []),
    ...promptTerms
  ].map(normalizeText).filter((term) => term.length > 1 && !STYLE_TERMS.has(term))).slice(0, 40);
}

const STYLE_TERMS = new Set([
  "how",
  "here",
  "explain",
  "detail",
  "detailed",
  "project",
  "system",
  "code",
  "works",
  "work",
  "applied",
  "apply",
  "implementation"
]);

function allFindings(artifacts: InspectExplainReadLaneArtifact[]) {
  return artifacts.flatMap((artifact) => artifact.findings);
}

function edgeRelations(edges: InspectExplainReadLaneEdge[], status: InspectExplainProofStatus) {
  return uniqueStrings(edges.filter((edge) => edge.status === status).map((edge) => edge.relation));
}

function mentionsAny(text: string, values: string[]) {
  return values.some((value) => value && text.includes(normalizeText(value)));
}

function dedupeFindings(findings: InspectExplainReadLaneFinding[]) {
  const seen = new Set<string>();
  const result: InspectExplainReadLaneFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.lane}:${finding.role}:${finding.path}:${finding.line}:${finding.endpoint ?? finding.storageTarget ?? finding.ownerSymbol ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result.sort((left, right) => findingScore(right) - findingScore(left) || left.path.localeCompare(right.path) || left.line - right.line);
}

function dedupeEdges(edges: InspectExplainReadLaneEdge[]) {
  const seen = new Set<string>();
  const result: InspectExplainReadLaneEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.relation}:${edge.from ?? ""}:${edge.to ?? ""}:${edge.evidenceRefs.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function findingScore(finding: InspectExplainReadLaneFinding) {
  return (finding.status === "proven" ? 100 : finding.status === "partial" ? 50 : finding.status === "unproven" ? 10 : -20)
    + (finding.confidence === "high" ? 30 : finding.confidence === "medium" ? 10 : 0);
}

function snippetAround(lines: string[], index: number) {
  return lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 3)).join("\n").trim().slice(0, 1_200);
}

function normalizeConcept(value: string) {
  return normalizeText(value)
    .replace(/^the\s+/, "")
    .replace(/^al\s+/, "")
    .replace(/[^a-z0-9_\-\s]/g, "")
    .trim();
}

function normalizeText(value: string) {
  return value.replaceAll("\\", "/").toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
