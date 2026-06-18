import type { BusinessBrief, ProductBrief, TechnicalPlan, TaskGraph, WorkerOutput, ReviewResult } from "@hivo/protocol";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export function validateProductBrief(value: ProductBrief): ValidationResult {
  const errors = requiredStrings(value, ["goal", "userIntent"]);
  errors.push(...requiredArrays(value, ["scope", "constraints", "successCriteria", "clarifyingQuestions", "assumptions"]));
  return { valid: errors.length === 0, errors };
}

export function validateBusinessBrief(value: BusinessBrief): ValidationResult {
  const errors = requiredStrings(value, ["userValue", "priority", "releaseNotesDraft"]);
  errors.push(...requiredArrays(value, ["mvpScope", "outOfScope", "businessRisks", "acceptanceCriteria"]));
  return { valid: errors.length === 0, errors };
}

export function validateTechnicalPlan(value: TechnicalPlan): ValidationResult {
  const errors = requiredStrings(value, ["summary", "architectureImpact", "riskLevel"]);
  errors.push(...requiredArrays(value, ["affectedAreas", "testStrategy"]));
  if (!value.taskGraph?.nodes?.length) errors.push("taskGraph.nodes must not be empty");
  return { valid: errors.length === 0, errors };
}

export function validateTaskGraph(graph: TaskGraph): ValidationResult {
  const errors: string[] = [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) errors.push(`${node.id} depends on missing node ${dependency}`);
    }
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push(`Invalid edge ${edge.from}->${edge.to}`);
  }
  return { valid: errors.length === 0, errors };
}

export const workerOutputSchema = { name: "worker-output" } as const;
export const reviewSchema = { name: "review" } as const;

export function validateWorkerOutput(value: WorkerOutput): ValidationResult {
  const errors = requiredStrings(value, ["id", "sessionId", "taskId", "agentName", "summary", "status"]);
  errors.push(...requiredArrays(value, ["details", "patchProposalIds", "commandRequestIds", "risks"]));
  return { valid: errors.length === 0, errors };
}

export function validateReview(value: ReviewResult): ValidationResult {
  const errors = requiredStrings(value, ["id", "sessionId", "reviewer", "status", "summary"]);
  errors.push(...requiredArrays(value, ["targetIds", "findings"]));
  return { valid: errors.length === 0, errors };
}

export function validateStructuredOutput(value: unknown, schema: unknown): ValidationResult {
  const schemaName = getSchemaName(schema);
  switch (schemaName) {
    case "agent-plan":
      return validateAgentPlanShape(value);
    case "patch-proposal":
      return validatePatchProposalShape(value);
    case "run-plan":
      return validateRunPlanShape(value);
    case "run-patch":
      return validateRunPatchShape(value);
    case "run-patch-intent":
      return validateRunPatchIntentShape(value);
    case "run-verification":
      return validateRunVerificationShape(value);
    case "project-explain":
      return validateProjectExplainShape(value);
    case "conversation-intent-decision":
      return validateConversationIntentDecisionShape(value);
    case "turn-understanding":
      return validateTurnUnderstandingShape(value);
    case "reasoning-step":
      return validateReasoningStepShape(value);
    case "initial-reasoning-decision":
      return validateInitialReasoningDecisionShape(value);
    case "provider-authored-result":
      return validateProviderAuthoredResultShape(value);
    case "answer-verification":
      return validateAnswerVerificationShape(value);
    case "evidence-curation":
      return validateEvidenceCurationShape(value);
    case "adaptive-reasoning-judge":
      return validateAdaptiveReasoningJudgeShape(value);
    case "worker-output":
      return validateWorkerOutput(value as WorkerOutput);
    case "review":
      return validateReview(value as ReviewResult);
    default:
      return { valid: true, errors: [] };
  }
}

function validateTurnUnderstandingShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["turn-understanding must be an object"] };
  const errors = requiredStrings(value, [
    "originalRequest",
    "cleanedRequest",
    "language",
    "intentKind",
    "route",
    "goal",
    "risk",
    "confidence",
    "rationale"
  ]);
  errors.push(...requiredArrays(value, ["ambiguities", "requiredEvidence"]));
  if (typeof value.needsWorkspace !== "boolean") errors.push("needsWorkspace must be boolean");
  if (typeof value.intentKind === "string" && !["direct_conversation", "workspace_question", "workspace_action", "run_request"].includes(value.intentKind)) {
    errors.push("intentKind is invalid");
  }
  if (typeof value.route === "string" && !["chat", "inspect_explain", "simple_run", "orchestrated_run", "recursive_factory", "swarm_readonly"].includes(value.route)) {
    errors.push("route is invalid");
  }
  if (value.intentKind === "direct_conversation" && value.needsWorkspace !== false) {
    errors.push("direct_conversation must not require workspace access");
  }
  if (value.intentKind !== "direct_conversation" && value.needsWorkspace !== true) {
    errors.push("workspace turns must require workspace access");
  }
  return { valid: errors.length === 0, errors };
}

function validateReasoningStepShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["reasoning-step must be an object"] };
  const errors = requiredStrings(value, ["id", "kind", "rationale"]);
  errors.push(...requiredArrays(value, ["toolRequests", "missingFacts", "successCriteria"]));
  if (typeof value.kind === "string" && !["tool_batch", "final", "ask_user", "refuse", "escalate"].includes(value.kind)) {
    errors.push("kind is invalid");
  }
  if (value.kind === "tool_batch" && Array.isArray(value.toolRequests) && value.toolRequests.length === 0) {
    errors.push("tool_batch must include at least one tool request");
  }
  if (value.kind === "final" && isRecord(value.result)) {
    errors.push(...validateProviderAuthoredResultShape(value.result).errors.map((error) => `result.${error}`));
  }
  if (Array.isArray(value.toolRequests)) {
    value.toolRequests.forEach((request, index) => {
      if (!isRecord(request)) {
        errors.push(`toolRequests[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(request, ["id", "kind", "reason"]).map((error) => `toolRequests[${index}].${error}`));
      errors.push(...validateReasoningToolRequestShape(request).map((error) => `toolRequests[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateReasoningToolRequestShape(request: Record<string, unknown>) {
  const errors: string[] = [];
  const kind = request.kind;
  const allowedKinds = [
    "list_files",
    "repository_search",
    "read_file",
    "inspect_manifest",
    "investigate_project",
    "semantic_search",
    "follow_relationships",
    "read_semantic_sources",
    "run_command",
    "propose_patch",
    "analyze_project",
    "delegate_readonly"
  ];
  if (typeof kind !== "string" || !allowedKinds.includes(kind)) return ["kind is invalid"];
  if (["repository_search", "investigate_project", "semantic_search", "delegate_readonly"].includes(kind) && !(typeof request.query === "string" && request.query.trim())) {
    errors.push(`${kind} requires query`);
  }
  if (kind === "read_file") {
    const hasPath = typeof request.path === "string" && request.path.trim();
    const hasPaths = Array.isArray(request.paths) && request.paths.some((entry) => typeof entry === "string" && entry.trim());
    if (!hasPath && !hasPaths) errors.push("read_file requires path or paths");
  }
  if (["follow_relationships", "read_semantic_sources"].includes(kind)
    && !(Array.isArray(request.relatedNodeIds) && request.relatedNodeIds.some((entry) => typeof entry === "string" && entry.trim()))) {
    errors.push(`${kind} requires relatedNodeIds`);
  }
  if (kind === "run_command" && !(typeof request.command === "string" && request.command.trim())) {
    errors.push("run_command requires command");
  }
  if (kind === "propose_patch" && !isRecord(request.patch)) {
    errors.push("propose_patch requires patch");
  }
  return errors;
}

function validateInitialReasoningDecisionShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["initial-reasoning-decision must be an object"] };
  const errors: string[] = [];
  if (!isRecord(value.understanding)) errors.push("understanding must be an object");
  else errors.push(...validateTurnUnderstandingShape(value.understanding).errors.map((error) => `understanding.${error}`));
  if (!isRecord(value.step)) errors.push("step must be an object");
  else errors.push(...validateReasoningStepShape(value.step).errors.map((error) => `step.${error}`));
  return { valid: errors.length === 0, errors };
}

function validateProviderAuthoredResultShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["provider-authored-result must be an object"] };
  const errors = requiredStrings(value, ["decision", "answerMarkdown", "rationale"]);
  errors.push(...requiredArrays(value, ["claims", "evidenceRefs", "unknowns"]));
  if (typeof value.decision === "string" && !["ANSWER", "FOLLOW_UP", "REFUSE", "ESCALATE"].includes(value.decision)) {
    errors.push("decision is invalid");
  }
  if (Array.isArray(value.claims)) {
    value.claims.forEach((claim, index) => {
      if (typeof claim === "string") return;
      if (!isRecord(claim)) {
        errors.push(`claims[${index}] must be a string or object`);
        return;
      }
      errors.push(...requiredStrings(claim, ["id", "text", "confidence"]).map((error) => `claims[${index}].${error}`));
      if (typeof claim.material !== "boolean") errors.push(`claims[${index}].material must be boolean`);
      if (!Array.isArray(claim.evidenceIds)) errors.push(`claims[${index}].evidenceIds must be an array`);
      if (typeof claim.confidence === "string" && !["high", "medium", "low"].includes(claim.confidence)) {
        errors.push(`claims[${index}].confidence is invalid`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateAnswerVerificationShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["answer-verification must be an object"] };
  const errors = requiredStrings(value, ["verdict", "rationale"]);
  errors.push(...requiredArrays(value, ["supportedClaims", "unsupportedClaims", "missingFacts", "evidenceRefs"]));
  if (typeof value.verdict === "string" && !["pass", "fail", "needs_more_evidence"].includes(value.verdict)) {
    errors.push("verdict is invalid");
  }
  if (value.workspaceEvidenceRequired !== undefined && typeof value.workspaceEvidenceRequired !== "boolean") {
    errors.push("workspaceEvidenceRequired must be boolean");
  }
  if (value.recommendedBudgetProfile !== undefined
    && (typeof value.recommendedBudgetProfile !== "string"
      || !["conversation", "project", "deep_project", "action"].includes(value.recommendedBudgetProfile))) {
    errors.push("recommendedBudgetProfile is invalid");
  }
  return { valid: errors.length === 0, errors };
}

function validateEvidenceCurationShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["evidence-curation must be an object"] };
  const errors = requiredStrings(value, ["rationale"]);
  errors.push(...requiredArrays(value, ["selectedEvidenceRefs", "missingFacts"]));
  return { valid: errors.length === 0, errors };
}

function validateAdaptiveReasoningJudgeShape(value: unknown): ValidationResult {
  if (!isRecord(value)) return { valid: false, errors: ["adaptive-reasoning-judge must be an object"] };
  const errors = requiredStrings(value, ["rationale"]);
  errors.push(...requiredArrays(value, ["unsupportedMaterialClaims", "safetyErrors"]));
  for (const key of ["correct", "evidenceSupported", "safe", "correctRefusal"]) {
    if (typeof value[key] !== "boolean") errors.push(`${key} must be boolean`);
  }
  return { valid: errors.length === 0, errors };
}

function requiredStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (typeof value[key] === "string" && value[key] ? [] : [`${key} is required`]));
}

function requiredArrays(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (Array.isArray(value[key]) ? [] : [`${key} must be an array`]));
}

function validateAgentPlanShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["agent-plan must be an object"] };
  errors.push(...requiredStrings(value, ["summary"]));
  errors.push(...requiredArrays(value, ["steps", "acceptanceCriteria", "risks"]));
  if (Array.isArray(value.steps)) {
    value.steps.forEach((step, index) => {
      if (!isRecord(step)) {
        errors.push(`steps[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(step, ["id", "title", "detail", "status"]).map((error) => `steps[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validatePatchProposalShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["patch-proposal must be an object"] };
  errors.push(...requiredStrings(value, ["title", "summary", "riskLevel", "unifiedDiff", "status"]));
  errors.push(...requiredArrays(value, ["filesChanged"]));
  if (Array.isArray(value.filesChanged)) {
    value.filesChanged.forEach((file, index) => {
      if (!isRecord(file)) {
        errors.push(`filesChanged[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(file, ["path", "changeType", "explanation"]).map((error) => `filesChanged[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateRunPlanShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["run-plan must be an object"] };
  errors.push(...requiredStrings(value, ["summary", "reasoningSummary", "mode"]));
  errors.push(...requiredArrays(value, ["tasks", "acceptanceCriteria", "risks"]));
  if (Array.isArray(value.tasks)) {
    value.tasks.forEach((task, index) => {
      if (!isRecord(task)) {
        errors.push(`tasks[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(task, ["title", "objective", "roleTitle"]).map((error) => `tasks[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateRunPatchShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["run-patch must be an object"] };
  errors.push(...requiredStrings(value, ["title", "summary"]));
  errors.push(...requiredArrays(value, ["files"]));
  if (Array.isArray(value.files)) {
    value.files.forEach((file, index) => {
      if (!isRecord(file)) {
        errors.push(`files[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(file, ["path", "changeType", "content", "explanation"]).map((error) => `files[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateRunPatchIntentShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["run-patch-intent must be an object"] };
  errors.push(...requiredStrings(value, ["title", "summary"]));
  errors.push(...requiredArrays(value, ["intents"]));
  if (Array.isArray(value.intents)) {
    value.intents.forEach((intent, index) => {
      if (!isRecord(intent)) {
        errors.push(`intents[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(intent, ["path", "operation", "reason", "risk"]).map((error) => `intents[${index}].${error}`));
      if (intent.operation !== "delete_range" && (typeof intent.replacementText !== "string" || intent.replacementText.length === 0)) {
        errors.push(`intents[${index}].replacementText is required`);
      }
      if (
        typeof intent.operation === "string" &&
        !["create_file", "overwrite_file", "replace_range", "insert_after", "insert_before", "delete_range"].includes(intent.operation)
      ) {
        errors.push(`intents[${index}].operation is invalid`);
      }
      if (typeof intent.risk === "string" && !["low", "medium", "high"].includes(intent.risk)) {
        errors.push(`intents[${index}].risk is invalid`);
      }
      if (intent.operation !== "create_file" && intent.operation !== "overwrite_file") {
        const hasAnchor = typeof intent.anchorText === "string" && intent.anchorText.length > 0;
        const hasPreimage = typeof intent.preimageText === "string" && intent.preimageText.length > 0;
        if (!hasAnchor && !hasPreimage) {
          errors.push(`intents[${index}] requires anchorText or preimageText for existing-file edits`);
        }
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateRunVerificationShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["run-verification must be an object"] };
  errors.push(...requiredStrings(value, ["summary"]));
  errors.push(...requiredArrays(value, ["checks"]));
  if (Array.isArray(value.checks)) {
    value.checks.forEach((check, index) => {
      if (!isRecord(check)) {
        errors.push(`checks[${index}] must be an object`);
        return;
      }
      errors.push(...requiredStrings(check, ["name", "status", "detail"]).map((error) => `checks[${index}].${error}`));
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateProjectExplainShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["project-explain must be an object"] };
  errors.push(...requiredStrings(value, ["answerMarkdown"]));
  errors.push(...requiredArrays(value, ["usedEvidenceRefs", "unsupportedOrUnclearParts"]));
  if (Array.isArray(value.usedEvidenceRefs)) {
    value.usedEvidenceRefs.forEach((ref, index) => {
      if (typeof ref !== "string" || !ref.trim()) {
        errors.push(`usedEvidenceRefs[${index}] must be a non-empty string`);
      }
    });
  }
  if (Array.isArray(value.unsupportedOrUnclearParts)) {
    value.unsupportedOrUnclearParts.forEach((entry, index) => {
      if (typeof entry !== "string") {
        errors.push(`unsupportedOrUnclearParts[${index}] must be a string`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function validateConversationIntentDecisionShape(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["conversation-intent-decision must be an object"] };
  errors.push(...requiredStrings(value, ["kind", "language", "rationale"]));
  if (typeof value.workspaceMessage !== "string") {
    errors.push("workspaceMessage is required");
  }
  if (typeof value.kind === "string" && !["direct_conversation", "workspace_question", "workspace_action", "run_request"].includes(value.kind)) {
    errors.push("kind is invalid");
  }
  if (typeof value.language === "string" && !["arabic", "english"].includes(value.language)) {
    errors.push("language is invalid");
  }
  if (typeof value.needsWorkspace !== "boolean") {
    errors.push("needsWorkspace must be boolean");
  }
  if (typeof value.confidence === "string" && !["high", "medium", "low"].includes(value.confidence)) {
    errors.push("confidence is invalid");
  }
  if (typeof value.confidence !== "string") {
    errors.push("confidence is required");
  }
  if (value.kind === "direct_conversation" && value.needsWorkspace !== false) {
    errors.push("direct_conversation must set needsWorkspace false");
  }
  if (value.kind !== "direct_conversation" && value.needsWorkspace !== true) {
    errors.push("workspace intents must set needsWorkspace true");
  }
  if (value.kind !== "direct_conversation" && typeof value.workspaceMessage === "string" && !value.workspaceMessage.trim()) {
    errors.push("workspaceMessage must not be empty for workspace intents");
  }
  return { valid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}
