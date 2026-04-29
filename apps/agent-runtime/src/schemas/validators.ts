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

function requiredStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (typeof value[key] === "string" && value[key] ? [] : [`${key} is required`]));
}

function requiredArrays(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (Array.isArray(value[key]) ? [] : [`${key} must be an array`]));
}
