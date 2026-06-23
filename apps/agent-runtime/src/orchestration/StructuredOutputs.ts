import type { AgentRoleName, ParsedAgentOutput, RunStatus, ValidationResultRecord } from "./OrchestrationModels.js";
import type { ValidationResult } from "./Validation.js";

export type TaskDecompositionResult = {
  tasks: Array<{
    id: string;
    title: string;
    objective: string;
    role_required: AgentRoleName;
    allowed_files_to_edit: string[];
    forbidden_files: string[];
    validation_commands: string[];
  }>;
  dependencies: Array<{ task_id: string; depends_on: string[] }>;
  assumptions: string[];
  risks: string[];
  requires_human_approval: boolean;
};

export type ScoutResult = {
  relevant_files: string[];
  relevant_symbols: string[];
  discovered_commands: string[];
  project_patterns: string[];
  confidence: number;
  notes: string[];
};

export type CodePatchProposal = {
  task_id: string;
  summary: string;
  files_to_modify: string[];
  patch_or_diff: string;
  risks: string[];
  validation_suggestions: string[];
  requires_followup: boolean;
};

export type ReviewDecision = "accept" | "request_changes" | "reject" | "split_task";
export type ReviewSeverity = "low" | "medium" | "high" | "critical";

export type ReviewResult = {
  decision: ReviewDecision;
  severity: ReviewSeverity;
  findings: string[];
  required_changes: string[];
  scope_violations: string[];
  confidence: number;
};

export type VerificationResult = {
  commands_run: Array<{
    command: string;
    cwd: string;
    status: "passed" | "failed" | "blocked" | "skipped" | "timed_out" | "not_run";
    exit_code?: number | null;
    required?: boolean;
    summary?: string;
    log_ref?: string;
  }>;
  passed: boolean;
  validation_status?: "passed" | "failed" | "skipped" | "blocked" | "partial" | "not_required" | "not_run";
  aggregate?: {
    status: "passed" | "failed" | "skipped" | "blocked" | "partial" | "not_required" | "not_run";
    required_command_count: number;
    optional_command_count: number;
    passed_count: number;
    failed_count: number;
    blocked_count: number;
    skipped_count: number;
    timed_out_count: number;
    not_run_count: number;
    reason: string;
  };
  failed_commands: string[];
  logs_refs: string[];
  summary: string;
  next_action: "accept" | "repair" | "manual_review" | "no_validation_available";
};

export type IntegrationResult = {
  accepted_tasks: string[];
  rejected_tasks: string[];
  conflicts: string[];
  files_changed: string[];
  final_status: "succeeded" | "failed" | "partial" | "requires_human_approval";
  notes: string[];
};

export type Phase3FinalRunReport = {
  run_id: string;
  user_request: string;
  status: RunStatus;
  completed_tasks: string[];
  failed_tasks: string[];
  changed_files: string[];
  validation_results: ValidationResultRecord[];
  unresolved_risks: string[];
  next_steps: string[];
};

export type MachineOutputSchemaName =
  | "TaskDecompositionResult"
  | "ScoutResult"
  | "CodePatchProposal"
  | "ReviewResult"
  | "VerificationResult"
  | "IntegrationResult"
  | "FinalRunReport"
  | "ParsedAgentOutput";

export type StructuredRepairResult<T> = {
  repaired: T | undefined;
  repair_prompt: string;
  validation: ValidationResult;
};

export function validateStructuredOutput(schema: MachineOutputSchemaName, value: unknown): ValidationResult {
  switch (schema) {
    case "TaskDecompositionResult":
      return validateTaskDecompositionResult(value);
    case "ScoutResult":
      return validateScoutResult(value);
    case "CodePatchProposal":
      return validateCodePatchProposal(value);
    case "ReviewResult":
      return validateReviewResult(value);
    case "VerificationResult":
      return validateVerificationResult(value);
    case "IntegrationResult":
      return validateIntegrationResult(value);
    case "FinalRunReport":
      return validatePhase3FinalRunReport(value);
    case "ParsedAgentOutput":
      return validateParsedAgentOutput(value);
  }
}

export function parseAndValidateStructuredOutput<T>(schema: MachineOutputSchemaName, raw: string | unknown): {
  value?: T;
  validation: ValidationResult;
  parsed_raw: unknown;
} {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  if (parsed instanceof Error) {
    return { validation: { valid: false, errors: [`Invalid JSON: ${parsed.message}`] }, parsed_raw: raw };
  }
  const validation = validateStructuredOutput(schema, parsed);
  return { value: validation.valid ? parsed as T : undefined, validation, parsed_raw: parsed };
}

export function repairStructuredOutput<T>(schema: MachineOutputSchemaName, raw: unknown, errors: string[]): StructuredRepairResult<T> {
  const repairPrompt = [
    `Repair output to match schema ${schema}.`,
    "Return only a JSON object that satisfies the schema.",
    "Validation errors:",
    ...errors.map((error) => `- ${error}`)
  ].join("\n");
  const repaired = repairValue(schema, raw);
  const validation = validateStructuredOutput(schema, repaired);
  return {
    repaired: validation.valid ? repaired as T : undefined,
    repair_prompt: repairPrompt,
    validation
  };
}

export function codePatchProposalFromParsedOutput(taskId: string, output: ParsedAgentOutput): CodePatchProposal {
  return {
    task_id: taskId,
    summary: output.summary,
    files_to_modify: output.files_changed,
    patch_or_diff: "",
    risks: output.limitations,
    validation_suggestions: output.validation_results.map((result) => result.command),
    requires_followup: output.status !== "succeeded" || output.limitations.length > 0
  };
}

export function scoutResultFromParsedOutput(output: ParsedAgentOutput, relevantFiles: string[]): ScoutResult {
  return {
    relevant_files: relevantFiles,
    relevant_symbols: [],
    discovered_commands: output.validation_results.map((result) => result.command),
    project_patterns: [output.summary],
    confidence: 0.7,
    notes: [...output.limitations, ...output.next_recommendations]
  };
}

export function taskDecompositionFromTasks(tasks: Array<{
  id: string;
  title: string;
  objective: string;
  role_required: AgentRoleName;
  dependencies: string[];
  allowed_files_to_edit: string[];
  forbidden_files: string[];
  validation_commands: string[];
}>): TaskDecompositionResult {
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      objective: task.objective,
      role_required: task.role_required,
      allowed_files_to_edit: task.allowed_files_to_edit,
      forbidden_files: task.forbidden_files,
      validation_commands: task.validation_commands
    })),
    dependencies: tasks.map((task) => ({ task_id: task.id, depends_on: task.dependencies })),
    assumptions: ["Task graph was generated by deterministic Phase 4 heuristics."],
    risks: [],
    requires_human_approval: false
  };
}

function validateTaskDecompositionResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredArray(object, "tasks", errors);
  requiredArray(object, "dependencies", errors);
  requiredArray(object, "assumptions", errors);
  requiredArray(object, "risks", errors);
  requiredBoolean(object, "requires_human_approval", errors);
  for (const [index, task] of (object.tasks as unknown[] | undefined ?? []).entries()) {
    const item = asRecord(task, errors, `tasks[${index}]`);
    if (!item) continue;
    requiredString(item, "id", errors, `tasks[${index}]`);
    requiredString(item, "title", errors, `tasks[${index}]`);
    requiredString(item, "objective", errors, `tasks[${index}]`);
    requiredString(item, "role_required", errors, `tasks[${index}]`);
    requiredArray(item, "allowed_files_to_edit", errors, `tasks[${index}]`);
    requiredArray(item, "forbidden_files", errors, `tasks[${index}]`);
    requiredArray(item, "validation_commands", errors, `tasks[${index}]`);
  }
  return result(errors);
}

function validateScoutResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredArray(object, "relevant_files", errors);
  requiredArray(object, "relevant_symbols", errors);
  requiredArray(object, "discovered_commands", errors);
  requiredArray(object, "project_patterns", errors);
  requiredArray(object, "notes", errors);
  requiredNumber(object, "confidence", errors, 0, 1);
  return result(errors);
}

function validateCodePatchProposal(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredString(object, "task_id", errors);
  requiredString(object, "summary", errors);
  requiredArray(object, "files_to_modify", errors);
  requiredStringAllowEmpty(object, "patch_or_diff", errors);
  requiredArray(object, "risks", errors);
  requiredArray(object, "validation_suggestions", errors);
  requiredBoolean(object, "requires_followup", errors);
  return result(errors);
}

function validateReviewResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredEnum(object, "decision", ["accept", "request_changes", "reject", "split_task"], errors);
  requiredEnum(object, "severity", ["low", "medium", "high", "critical"], errors);
  requiredArray(object, "findings", errors);
  requiredArray(object, "required_changes", errors);
  requiredArray(object, "scope_violations", errors);
  requiredNumber(object, "confidence", errors, 0, 1);
  return result(errors);
}

function validateVerificationResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredArray(object, "commands_run", errors);
  requiredBoolean(object, "passed", errors);
  requiredArray(object, "failed_commands", errors);
  requiredArray(object, "logs_refs", errors);
  requiredString(object, "summary", errors);
  requiredEnum(object, "next_action", ["accept", "repair", "manual_review", "no_validation_available"], errors);
  return result(errors);
}

function validateIntegrationResult(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredArray(object, "accepted_tasks", errors);
  requiredArray(object, "rejected_tasks", errors);
  requiredArray(object, "conflicts", errors);
  requiredArray(object, "files_changed", errors);
  requiredEnum(object, "final_status", ["succeeded", "failed", "partial", "requires_human_approval"], errors);
  requiredArray(object, "notes", errors);
  return result(errors);
}

function validatePhase3FinalRunReport(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredString(object, "run_id", errors);
  requiredString(object, "user_request", errors);
  requiredString(object, "status", errors);
  requiredArray(object, "completed_tasks", errors);
  requiredArray(object, "failed_tasks", errors);
  requiredArray(object, "changed_files", errors);
  requiredArray(object, "validation_results", errors);
  requiredArray(object, "unresolved_risks", errors);
  requiredArray(object, "next_steps", errors);
  return result(errors);
}

function validateParsedAgentOutput(value: unknown): ValidationResult {
  const errors: string[] = [];
  const object = asRecord(value, errors);
  if (!object) return result(errors);
  requiredString(object, "summary", errors);
  requiredEnum(object, "status", ["succeeded", "failed", "blocked"], errors);
  requiredArray(object, "files_changed", errors);
  requiredArray(object, "validation_results", errors);
  requiredArray(object, "artifacts", errors);
  requiredArray(object, "limitations", errors);
  requiredArray(object, "next_recommendations", errors);
  validateIntentAlignmentShape(object.intent_alignment, errors, "intent_alignment");
  return result(errors);
}

function validateIntentAlignmentShape(value: unknown, errors: string[], prefix: string) {
  const object = asRecord(value, errors, prefix);
  if (!object) return;
  requiredString(object, "original_request_hash", errors, prefix);
  requiredString(object, "task_understanding", errors, prefix);
  requiredString(object, "original_goal_contribution", errors, prefix);
  requiredArray(object, "possible_intent_conflicts", errors, prefix);
  requiredArray(object, "assumptions_used", errors, prefix);
  requiredArray(object, "evidence_refs", errors, prefix);
  if ("intent_contract_ref" in object && typeof object.intent_contract_ref !== "string") {
    errors.push(`${field(prefix, "intent_contract_ref")} must be a string`);
  }
  if ("intent_contract_revision" in object && typeof object.intent_contract_revision !== "number") {
    errors.push(`${field(prefix, "intent_contract_revision")} must be a number`);
  }
  if ("task_slice_id" in object && typeof object.task_slice_id !== "string") {
    errors.push(`${field(prefix, "task_slice_id")} must be a string`);
  }
}

function repairValue(schema: MachineOutputSchemaName, raw: unknown): unknown {
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  switch (schema) {
    case "CodePatchProposal":
      return {
        task_id: stringValue(object.task_id, "unknown_task"),
        summary: stringValue(object.summary, "No summary provided."),
        files_to_modify: stringArray(object.files_to_modify),
        patch_or_diff: stringValue(object.patch_or_diff, ""),
        risks: stringArray(object.risks),
        validation_suggestions: stringArray(object.validation_suggestions),
        requires_followup: booleanValue(object.requires_followup, false)
      } satisfies CodePatchProposal;
    case "ReviewResult":
      return {
        decision: enumValue(object.decision, ["accept", "request_changes", "reject", "split_task"], "request_changes"),
        severity: enumValue(object.severity, ["low", "medium", "high", "critical"], "medium"),
        findings: stringArray(object.findings),
        required_changes: stringArray(object.required_changes),
        scope_violations: stringArray(object.scope_violations),
        confidence: numberValue(object.confidence, 0.3, 0, 1)
      } satisfies ReviewResult;
    case "VerificationResult":
      return {
        commands_run: Array.isArray(object.commands_run) ? object.commands_run : [],
        passed: booleanValue(object.passed, false),
        failed_commands: stringArray(object.failed_commands),
        logs_refs: stringArray(object.logs_refs),
        summary: stringValue(object.summary, "Validation output repaired from incomplete agent response."),
        next_action: enumValue(object.next_action, ["accept", "repair", "manual_review", "no_validation_available"], "manual_review")
      } satisfies VerificationResult;
    case "IntegrationResult":
      return {
        accepted_tasks: stringArray(object.accepted_tasks),
        rejected_tasks: stringArray(object.rejected_tasks),
        conflicts: stringArray(object.conflicts),
        files_changed: stringArray(object.files_changed),
        final_status: enumValue(object.final_status, ["succeeded", "failed", "partial", "requires_human_approval"], "requires_human_approval"),
        notes: stringArray(object.notes)
      } satisfies IntegrationResult;
    case "ScoutResult":
      return {
        relevant_files: stringArray(object.relevant_files),
        relevant_symbols: stringArray(object.relevant_symbols),
        discovered_commands: stringArray(object.discovered_commands),
        project_patterns: stringArray(object.project_patterns),
        confidence: numberValue(object.confidence, 0.3, 0, 1),
        notes: stringArray(object.notes)
      } satisfies ScoutResult;
    case "TaskDecompositionResult":
      return {
        tasks: Array.isArray(object.tasks) ? object.tasks : [],
        dependencies: Array.isArray(object.dependencies) ? object.dependencies : [],
        assumptions: stringArray(object.assumptions),
        risks: stringArray(object.risks),
        requires_human_approval: booleanValue(object.requires_human_approval, true)
      } satisfies TaskDecompositionResult;
    case "FinalRunReport":
      return {
        run_id: stringValue(object.run_id, "unknown_run"),
        user_request: stringValue(object.user_request, "Unknown request"),
        status: stringValue(object.status, "failed") as RunStatus,
        completed_tasks: stringArray(object.completed_tasks),
        failed_tasks: stringArray(object.failed_tasks),
        changed_files: stringArray(object.changed_files),
        validation_results: Array.isArray(object.validation_results) ? object.validation_results as ValidationResultRecord[] : [],
        unresolved_risks: stringArray(object.unresolved_risks),
        next_steps: stringArray(object.next_steps)
      } satisfies Phase3FinalRunReport;
    case "ParsedAgentOutput":
      return {
        summary: stringValue(object.summary, "No summary provided."),
        status: enumValue(object.status, ["succeeded", "failed", "blocked"], "failed"),
        files_changed: stringArray(object.files_changed),
        validation_results: Array.isArray(object.validation_results) ? object.validation_results : [],
        artifacts: stringArray(object.artifacts),
        limitations: stringArray(object.limitations),
        next_recommendations: stringArray(object.next_recommendations),
        intent_alignment: object.intent_alignment as ParsedAgentOutput["intent_alignment"]
      } satisfies ParsedAgentOutput;
  }
}

function parseJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function asRecord(value: unknown, errors: string[], label = "value"): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string, errors: string[], prefix = "") {
  if (typeof object[key] !== "string" || !String(object[key]).trim()) errors.push(`${field(prefix, key)} is required`);
}

function requiredStringAllowEmpty(object: Record<string, unknown>, key: string, errors: string[], prefix = "") {
  if (typeof object[key] !== "string") errors.push(`${field(prefix, key)} must be a string`);
}

function requiredArray(object: Record<string, unknown>, key: string, errors: string[], prefix = "") {
  if (!Array.isArray(object[key])) errors.push(`${field(prefix, key)} must be an array`);
}

function requiredBoolean(object: Record<string, unknown>, key: string, errors: string[]) {
  if (typeof object[key] !== "boolean") errors.push(`${key} must be boolean`);
}

function requiredNumber(object: Record<string, unknown>, key: string, errors: string[], min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  if (typeof object[key] !== "number" || !Number.isFinite(object[key]) || object[key] < min || object[key] > max) {
    errors.push(`${key} must be a number between ${min} and ${max}`);
  }
}

function requiredEnum(object: Record<string, unknown>, key: string, values: string[], errors: string[]) {
  if (typeof object[key] !== "string" || !values.includes(String(object[key]))) {
    errors.push(`${key} must be one of ${values.join(", ")}`);
  }
}

function result(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors };
}

function field(prefix: string, key: string) {
  return prefix ? `${prefix}.${key}` : key;
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function stringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : fallback;
}
