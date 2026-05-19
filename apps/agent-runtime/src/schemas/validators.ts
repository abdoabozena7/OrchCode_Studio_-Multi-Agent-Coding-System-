import type { BusinessBrief, ProductBrief, TechnicalPlan, TaskGraph, WorkerOutput, ReviewResult } from "@orchcode/protocol";

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
    case "worker-output":
      return validateWorkerOutput(value as WorkerOutput);
    case "review":
      return validateReview(value as ReviewResult);
    default:
      return { valid: true, errors: [] };
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}
