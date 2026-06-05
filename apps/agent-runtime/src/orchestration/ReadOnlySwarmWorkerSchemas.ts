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

export type ReadOnlySwarmWorkerOutputNormalization = {
  value: unknown;
  validation: ReadOnlySwarmWorkerSchemaValidation;
  repaired: boolean;
  repair_reasons: string[];
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

export function normalizeReadOnlySwarmOutput(value: unknown, schema: { name: string }): ReadOnlySwarmWorkerOutputNormalization {
  const parsed = parseJsonObjectString(value);
  const original = parsed ?? value;
  const validation = validateReadOnlySwarmOutput(original, schema);
  if (validation.valid) {
    return {
      value: original,
      validation,
      repaired: Boolean(parsed),
      repair_reasons: parsed ? ["Parsed JSON object from string provider output."] : []
    };
  }
  if (!isRecord(original)) {
    return { value: original, validation, repaired: false, repair_reasons: [] };
  }
  if ("confidence" in original && coerceConfidence(original.confidence) === undefined) {
    return { value: original, validation, repaired: false, repair_reasons: [] };
  }

  const repaired = repairReadOnlyRecord(original, schema.name);
  const repairedValidation = validateReadOnlySwarmOutput(repaired, schema);
  if (!repairedValidation.valid) {
    return { value: original, validation, repaired: false, repair_reasons: [] };
  }
  return {
    value: repaired,
    validation: repairedValidation,
    repaired: true,
    repair_reasons: repairReasons(original, repaired, validation)
  };
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

function repairReadOnlyRecord(record: Record<string, unknown>, schemaName: string): Record<string, unknown> {
  const answer = stringField(record, "answer") ?? stringField(record, "summary") ?? stringField(record, "plan_summary");
  const findings = nonEmptyArray(record, "findings")
    || stringArrayFrom(answer)
    || stringArrayFrom(stringField(record, "finding"));
  const relevantFiles = arrayField(record, "relevant_files");
  const risks = arrayField(record, "risks");
  const unknowns = arrayField(record, "unknowns");
  const suggestedNextSteps = firstNonEmptyArray(
    arrayField(record, "suggested_next_steps"),
    arrayField(record, "next_steps"),
    arrayField(record, "recommendations")
  );
  const confidence = normalizeConfidence(record.confidence);

  switch (schemaName) {
    case "swarm_scout_output":
      return {
        ...record,
        findings,
        relevant_files: relevantFiles,
        risks,
        unknowns,
        suggested_next_steps: suggestedNextSteps,
        confidence
      };
    case "swarm_planner_output":
      return {
        ...record,
        plan_summary: stringField(record, "plan_summary") ?? answer ?? "Provider returned an answer-shaped planning summary.",
        task_drafts: nonEmptyArray(record, "task_drafts") || suggestedNextSteps || findings,
        dependencies: arrayField(record, "dependencies"),
        risks,
        validation_strategy: arrayField(record, "validation_strategy"),
        assumptions: arrayField(record, "assumptions"),
        confidence
      };
    case "swarm_risk_analyst_output":
      return {
        ...record,
        risks: risks.length ? risks : findings,
        severity: stringField(record, "severity") ?? "medium",
        impacted_files_or_modules: firstNonEmptyArray(arrayField(record, "impacted_files_or_modules"), relevantFiles),
        mitigation: arrayField(record, "mitigation"),
        blockers: arrayField(record, "blockers"),
        confidence
      };
    case "swarm_reviewer_output":
      return {
        ...record,
        decision: stringField(record, "decision") ?? "needs_review",
        severity: stringField(record, "severity") ?? "medium",
        findings,
        required_changes: arrayField(record, "required_changes"),
        validation_recommendations: arrayField(record, "validation_recommendations"),
        confidence
      };
    case "swarm_specialist_output":
      return {
        ...record,
        specialty: stringField(record, "specialty") ?? "general",
        findings,
        recommendations: firstNonEmptyArray(arrayField(record, "recommendations"), suggestedNextSteps),
        risks,
        confidence
      };
    case "swarm_tester_planner_output":
      return {
        ...record,
        recommended_validation: arrayField(record, "recommended_validation"),
        required_commands: arrayField(record, "required_commands"),
        optional_commands: arrayField(record, "optional_commands"),
        smoke_checks: nonEmptyArray(record, "smoke_checks") || findings,
        blocked_or_missing_validation: arrayField(record, "blocked_or_missing_validation"),
        confidence
      };
    case "swarm_reporter_output":
      return {
        ...record,
        summary: stringField(record, "summary") ?? answer ?? "Provider returned an answer-shaped report.",
        evidence_refs: firstNonEmptyArray(arrayField(record, "evidence_refs"), relevantFiles),
        unresolved_risks: firstNonEmptyArray(arrayField(record, "unresolved_risks"), risks),
        next_steps: firstNonEmptyArray(arrayField(record, "next_steps"), suggestedNextSteps),
        confidence
      };
    default:
      return record;
  }
}

function repairReasons(original: Record<string, unknown>, repaired: Record<string, unknown>, validation: ReadOnlySwarmWorkerSchemaValidation) {
  const reasons = validation.errors.map((error) => `Repaired ${error}.`);
  if (typeof original.answer === "string" && JSON.stringify(repaired).includes(original.answer)) {
    reasons.push("Mapped answer-shaped provider output into the role schema.");
  }
  return reasons.length ? reasons : ["Normalized provider output into the requested read-only role schema."];
}

function parseJsonObjectString(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function nonEmptyArray(record: Record<string, unknown>, key: string) {
  const value = arrayField(record, key);
  return value.length ? value : undefined;
}

function stringArrayFrom(value: string | undefined) {
  return value?.trim() ? [value.trim()] : undefined;
}

function firstNonEmptyArray(...values: string[][]) {
  return values.find((value) => value.length > 0) ?? [];
}

function normalizeConfidence(value: unknown) {
  return coerceConfidence(value) ?? 0.35;
}

function coerceConfidence(value: unknown) {
  if (value === undefined) return 0.35;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (["very high", "high", "strong", "confident"].includes(normalized)) return 0.85;
    if (["medium", "moderate", "normal", "partial"].includes(normalized)) return 0.55;
    if (["low", "weak", "uncertain"].includes(normalized)) return 0.25;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
