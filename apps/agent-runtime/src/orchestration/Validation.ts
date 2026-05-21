import type {
  AgentInvocation,
  AgentRole,
  ContextPack,
  FinalRunReport,
  Run,
  RunStatus,
  Task,
  TaskStatus
} from "./OrchestrationModels.js";

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

const RUN_STATUSES: RunStatus[] = [
  "created",
  "indexing",
  "planning",
  "executing",
  "reviewing",
  "verifying",
  "integrating",
  "succeeded",
  "failed",
  "cancelled"
];

const TASK_STATUSES: TaskStatus[] = ["pending", "ready", "running", "blocked", "succeeded", "failed", "skipped"];

export function validateRun(value: Run): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["id", "user_request", "created_at", "updated_at", "memory_snapshot_ref", "artifacts_path"]));
  errors.push(...requiredArrays(value, ["root_task_ids"]));
  if (!RUN_STATUSES.includes(value.status)) errors.push(`status is invalid: ${value.status}`);
  if (!value.config || typeof value.config !== "object") {
    errors.push("config is required");
  } else {
    errors.push(...requiredStrings(value.config, ["workspace_path", "memory_dir"]));
    if (!Number.isFinite(value.config.max_context_files)) errors.push("config.max_context_files is required");
    if (!Number.isFinite(value.config.max_context_chars)) errors.push("config.max_context_chars is required");
    if (!Number.isFinite(value.config.max_task_attempts)) errors.push("config.max_task_attempts is required");
  }
  return result(errors);
}

export function validateTask(value: Task): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["id", "run_id", "title", "objective", "role_required", "expected_output_schema", "created_at", "updated_at"]));
  errors.push(...requiredArrays(value, ["dependencies", "relevant_files", "allowed_files_to_edit", "forbidden_files", "validation_commands", "artifacts"]));
  if (!TASK_STATUSES.includes(value.status)) errors.push(`status is invalid: ${value.status}`);
  if (!Number.isFinite(value.max_attempts) || value.max_attempts < 1) errors.push("max_attempts must be >= 1");
  if (!Number.isFinite(value.attempt_count) || value.attempt_count < 0) errors.push("attempt_count must be >= 0");
  return result(errors);
}

export function validateAgentRole(value: AgentRole): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["name", "purpose", "default_prompt", "expected_output_schema", "required_output_format"]));
  errors.push(...requiredArrays(value, ["allowed_operations", "forbidden_operations", "success_criteria"]));
  if (typeof value.can_edit_files !== "boolean") errors.push("can_edit_files must be boolean");
  if (typeof value.can_run_commands !== "boolean") errors.push("can_run_commands must be boolean");
  if (typeof value.review_required !== "boolean") errors.push("review_required must be boolean");
  return result(errors);
}

export function validateAgentInvocation(value: AgentInvocation): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["id", "run_id", "task_id", "role", "prompt", "context_pack_ref", "started_at", "status"]));
  if (!["created", "running", "succeeded", "failed", "cancelled"].includes(value.status)) errors.push(`status is invalid: ${value.status}`);
  return result(errors);
}

export function validateContextPack(value: ContextPack): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["id", "run_id", "task_id", "objective", "expected_output_schema"]));
  errors.push(...requiredArrays(value, [
    "relevant_files",
    "snippets",
    "repo_index_refs",
    "constraints",
    "allowed_files_to_edit",
    "forbidden_files",
    "previous_decisions",
    "validation_requirements",
    "warnings"
  ]));
  if (!Number.isFinite(value.approximate_size)) errors.push("approximate_size is required");
  return result(errors);
}

export function validateFinalRunReport(value: FinalRunReport): ValidationResult {
  const errors: string[] = [];
  errors.push(...requiredStrings(value, ["run_id", "user_request", "artifacts_path"]));
  errors.push(...requiredArrays(value, ["files_changed", "validation_results", "limitations", "next_recommendations"]));
  if (!RUN_STATUSES.includes(value.status)) errors.push(`status is invalid: ${value.status}`);
  if (!Number.isFinite(value.tasks_created)) errors.push("tasks_created is required");
  if (!Number.isFinite(value.tasks_completed)) errors.push("tasks_completed is required");
  if (!Number.isFinite(value.tasks_failed)) errors.push("tasks_failed is required");
  return result(errors);
}

export function assertValid<T>(label: string, value: T, validator: (value: T) => ValidationResult): T {
  const validation = validator(value);
  if (!validation.valid) {
    throw new Error(`${label} validation failed: ${validation.errors.join("; ")}`);
  }
  return value;
}

function requiredStrings(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (typeof value[key] === "string" && String(value[key]).trim() ? [] : [`${key} is required`]));
}

function requiredArrays(value: Record<string, unknown>, keys: string[]) {
  return keys.flatMap((key) => (Array.isArray(value[key]) ? [] : [`${key} must be an array`]));
}

function result(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors };
}
