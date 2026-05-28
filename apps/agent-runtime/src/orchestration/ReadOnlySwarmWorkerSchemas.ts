export type ReadOnlySwarmWorkerOutputKind =
  | "swarm_scout_output"
  | "swarm_planner_output"
  | "swarm_risk_analyst_output"
  | "swarm_reviewer_output"
  | "swarm_specialist_output"
  | "swarm_tester_planner_output"
  | "swarm_reporter_output";

export const swarmScoutOutputSchema = { name: "swarm_scout_output" } as const;
export const swarmPlannerOutputSchema = { name: "swarm_planner_output" } as const;
export const swarmRiskAnalystOutputSchema = { name: "swarm_risk_analyst_output" } as const;
export const swarmReviewerOutputSchema = { name: "swarm_reviewer_output" } as const;
export const swarmSpecialistOutputSchema = { name: "swarm_specialist_output" } as const;
export const swarmTesterPlannerOutputSchema = { name: "swarm_tester_planner_output" } as const;
export const swarmReporterOutputSchema = { name: "swarm_reporter_output" } as const;

export type ReadOnlySwarmWorkerSchemaValidation = {
  valid: boolean;
  errors: string[];
  schema_name: ReadOnlySwarmWorkerOutputKind;
};

export function schemaForReadOnlySwarmRole(role: string, workItemType: string) {
  if (workItemType === "scout" || role === "ScoutAgent") return swarmScoutOutputSchema;
  if (workItemType === "plan" || role === "PlannerAgent" || role === "ArchitectAgent") return swarmPlannerOutputSchema;
  if (workItemType === "risk_analysis" || role === "RiskAnalyzerAgent") return swarmRiskAnalystOutputSchema;
  if (workItemType === "test" || role === "TesterAgent") return swarmTesterPlannerOutputSchema;
  if (workItemType === "summarize" || role === "ReporterAgent") return swarmReporterOutputSchema;
  if (role === "ReviewerAgent" || workItemType === "review") return swarmReviewerOutputSchema;
  return swarmSpecialistOutputSchema;
}

export function validateReadOnlySwarmOutput(value: unknown, schema: { name: string }): ReadOnlySwarmWorkerSchemaValidation {
  const schemaName = schema.name as ReadOnlySwarmWorkerOutputKind;
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: [`${schema.name} must be an object`], schema_name: schemaName };
  }
  switch (schema.name) {
    case "swarm_scout_output":
      errors.push(...requiredArrays(value, ["findings", "relevant_files", "risks", "unknowns", "suggested_next_steps"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_planner_output":
      errors.push(...requiredStrings(value, ["plan_summary"]));
      errors.push(...requiredArrays(value, ["task_drafts", "dependencies", "risks", "validation_strategy", "assumptions"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_risk_analyst_output":
      errors.push(...requiredArrays(value, ["risks", "impacted_files_or_modules", "mitigation", "blockers"]));
      errors.push(...requiredStrings(value, ["severity"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_reviewer_output":
      errors.push(...requiredStrings(value, ["decision", "severity"]));
      errors.push(...requiredArrays(value, ["findings", "required_changes", "validation_recommendations"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_specialist_output":
      errors.push(...requiredStrings(value, ["specialty"]));
      errors.push(...requiredArrays(value, ["findings", "recommendations", "risks"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_tester_planner_output":
      errors.push(...requiredArrays(value, ["recommended_validation", "required_commands", "optional_commands", "smoke_checks", "blocked_or_missing_validation"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    case "swarm_reporter_output":
      errors.push(...requiredStrings(value, ["summary"]));
      errors.push(...requiredArrays(value, ["evidence_refs", "unresolved_risks", "next_steps"]));
      errors.push(...requiredNumber(value, ["confidence"]));
      break;
    default:
      errors.push(`Unknown read-only swarm schema: ${schema.name}`);
  }
  if (typeof value.confidence === "number" && (value.confidence < 0 || value.confidence > 1)) {
    errors.push("confidence must be between 0 and 1");
  }
  return { valid: errors.length === 0, errors, schema_name: schemaName };
}

export function summarizeReadOnlySwarmOutput(value: unknown): {
  summary: string;
  findings: string[];
  relevant_files: string[];
  risks: string[];
  unknowns: string[];
  confidence: number;
} {
  const record = isRecord(value) ? value : {};
  return {
    summary: stringField(record, "summary")
      ?? stringField(record, "plan_summary")
      ?? arrayField(record, "findings")[0]
      ?? "Provider-backed read-only worker returned structured output.",
    findings: uniqueStrings([
      ...arrayField(record, "findings"),
      ...arrayField(record, "recommendations"),
      ...arrayField(record, "recommended_validation"),
      ...arrayField(record, "validation_recommendations")
    ]),
    relevant_files: uniqueStrings([
      ...arrayField(record, "relevant_files"),
      ...arrayField(record, "impacted_files_or_modules")
    ]),
    risks: uniqueStrings([
      ...arrayField(record, "risks"),
      ...arrayField(record, "blockers"),
      ...arrayField(record, "unresolved_risks")
    ]),
    unknowns: uniqueStrings([
      ...arrayField(record, "unknowns"),
      ...arrayField(record, "blocked_or_missing_validation")
    ]),
    confidence: typeof record.confidence === "number" ? record.confidence : 0.45
  };
}

function requiredStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (typeof value[key] === "string" && String(value[key]).trim() ? [] : [`${key} is required`]));
}

function requiredArrays(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (Array.isArray(value[key]) ? [] : [`${key} must be an array`]));
}

function requiredNumber(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (typeof value[key] === "number" && Number.isFinite(value[key]) ? [] : [`${key} must be a finite number`]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
