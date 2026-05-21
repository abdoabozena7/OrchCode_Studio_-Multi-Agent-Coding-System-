export type ExecutionMode = "fast" | "deep" | "exhaustive";
export type ValidationLevel = "basic" | "standard" | "strict";

export type OrchestrationSafetyConfig = {
  execution_mode: ExecutionMode;
  memory_path: string;
  max_tasks_per_run: number;
  max_parallel_tasks: number;
  max_attempts_per_task: number;
  max_repair_rounds: number;
  max_files_per_task: number;
  max_context_size: number;
  max_review_findings: number;
  max_validation_log_size: number;
  max_patch_bytes: number;
  lock_ttl_ms: number;
  enable_multi_perspective_review: boolean;
  enable_parallel_execution: boolean;
  validation_level: ValidationLevel;
  require_human_approval_for_risky_files: boolean;
  validation_timeout: number;
  safe_commands_allowlist: string[];
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationSafetyConfig = {
  execution_mode: "deep",
  memory_path: ".agent_memory",
  max_tasks_per_run: 20,
  max_parallel_tasks: 1,
  max_attempts_per_task: 2,
  max_repair_rounds: 1,
  max_files_per_task: 8,
  max_context_size: 12_000,
  max_review_findings: 20,
  max_validation_log_size: 20_000,
  max_patch_bytes: 120_000,
  lock_ttl_ms: 5 * 60 * 1000,
  enable_multi_perspective_review: false,
  enable_parallel_execution: false,
  validation_level: "standard",
  require_human_approval_for_risky_files: true,
  validation_timeout: 30_000,
  safe_commands_allowlist: ["git diff --check"]
};

export const EXECUTION_MODE_PRESETS: Record<ExecutionMode, Partial<OrchestrationSafetyConfig>> = {
  fast: {
    execution_mode: "fast",
    max_tasks_per_run: 8,
    max_parallel_tasks: 1,
    max_attempts_per_task: 1,
    max_repair_rounds: 0,
    max_context_size: 8_000,
    enable_multi_perspective_review: false,
    validation_level: "basic",
    require_human_approval_for_risky_files: true
  },
  deep: {
    execution_mode: "deep",
    max_tasks_per_run: 20,
    max_parallel_tasks: 1,
    max_attempts_per_task: 2,
    max_repair_rounds: 1,
    max_context_size: 12_000,
    enable_multi_perspective_review: false,
    validation_level: "standard",
    require_human_approval_for_risky_files: true
  },
  exhaustive: {
    execution_mode: "exhaustive",
    max_tasks_per_run: 60,
    max_parallel_tasks: 2,
    max_attempts_per_task: 3,
    max_repair_rounds: 2,
    max_context_size: 24_000,
    enable_multi_perspective_review: true,
    validation_level: "strict",
    require_human_approval_for_risky_files: true
  }
};

export type PartialOrchestrationSafetyConfig = Partial<OrchestrationSafetyConfig>;

export function loadOrchestrationConfig(input: PartialOrchestrationSafetyConfig = {}): OrchestrationSafetyConfig {
  const mode = envMode("ORCHCODE_EXECUTION_MODE", input.execution_mode ?? DEFAULT_ORCHESTRATION_CONFIG.execution_mode);
  const preset = EXECUTION_MODE_PRESETS[mode];
  const config: OrchestrationSafetyConfig = {
    ...DEFAULT_ORCHESTRATION_CONFIG,
    ...preset,
    execution_mode: mode,
    memory_path: process.env.ORCHCODE_MEMORY_DIR ?? input.memory_path ?? DEFAULT_ORCHESTRATION_CONFIG.memory_path,
    max_tasks_per_run: envNumber("ORCHCODE_MAX_TASKS_PER_RUN", input.max_tasks_per_run, preset.max_tasks_per_run ?? DEFAULT_ORCHESTRATION_CONFIG.max_tasks_per_run),
    max_parallel_tasks: envNumber("ORCHCODE_MAX_PARALLEL_TASKS", input.max_parallel_tasks, preset.max_parallel_tasks ?? DEFAULT_ORCHESTRATION_CONFIG.max_parallel_tasks),
    max_attempts_per_task: envNumber("ORCHCODE_MAX_ATTEMPTS_PER_TASK", input.max_attempts_per_task, preset.max_attempts_per_task ?? DEFAULT_ORCHESTRATION_CONFIG.max_attempts_per_task),
    max_repair_rounds: envNumber("ORCHCODE_MAX_REPAIR_ROUNDS", input.max_repair_rounds, preset.max_repair_rounds ?? DEFAULT_ORCHESTRATION_CONFIG.max_repair_rounds),
    max_files_per_task: envNumber("ORCHCODE_MAX_FILES_PER_TASK", input.max_files_per_task, preset.max_files_per_task ?? DEFAULT_ORCHESTRATION_CONFIG.max_files_per_task),
    max_context_size: envNumber("ORCHCODE_MAX_CONTEXT_SIZE", input.max_context_size, preset.max_context_size ?? DEFAULT_ORCHESTRATION_CONFIG.max_context_size),
    max_review_findings: envNumber("ORCHCODE_MAX_REVIEW_FINDINGS", input.max_review_findings, DEFAULT_ORCHESTRATION_CONFIG.max_review_findings),
    max_validation_log_size: envNumber("ORCHCODE_MAX_VALIDATION_LOG_SIZE", input.max_validation_log_size, DEFAULT_ORCHESTRATION_CONFIG.max_validation_log_size),
    max_patch_bytes: envNumber("ORCHCODE_MAX_PATCH_BYTES", input.max_patch_bytes, DEFAULT_ORCHESTRATION_CONFIG.max_patch_bytes),
    lock_ttl_ms: envNumber("ORCHCODE_LOCK_TTL_MS", input.lock_ttl_ms, DEFAULT_ORCHESTRATION_CONFIG.lock_ttl_ms),
    enable_multi_perspective_review: envBool("ORCHCODE_ENABLE_MULTI_PERSPECTIVE_REVIEW", input.enable_multi_perspective_review, preset.enable_multi_perspective_review ?? DEFAULT_ORCHESTRATION_CONFIG.enable_multi_perspective_review),
    enable_parallel_execution: envBool("ORCHCODE_ENABLE_PARALLEL_EXECUTION", input.enable_parallel_execution, DEFAULT_ORCHESTRATION_CONFIG.enable_parallel_execution),
    validation_level: envValidationLevel("ORCHCODE_VALIDATION_LEVEL", input.validation_level ?? preset.validation_level ?? DEFAULT_ORCHESTRATION_CONFIG.validation_level),
    require_human_approval_for_risky_files: envBool("ORCHCODE_REQUIRE_HUMAN_APPROVAL_FOR_RISKY_FILES", input.require_human_approval_for_risky_files, preset.require_human_approval_for_risky_files ?? DEFAULT_ORCHESTRATION_CONFIG.require_human_approval_for_risky_files),
    validation_timeout: envNumber("ORCHCODE_VALIDATION_TIMEOUT", input.validation_timeout, DEFAULT_ORCHESTRATION_CONFIG.validation_timeout),
    safe_commands_allowlist: envList("ORCHCODE_SAFE_COMMANDS_ALLOWLIST", input.safe_commands_allowlist, DEFAULT_ORCHESTRATION_CONFIG.safe_commands_allowlist)
  };
  validateOrchestrationConfig(config);
  return config;
}

export function validateOrchestrationConfig(config: OrchestrationSafetyConfig) {
  const numericKeys: Array<keyof Pick<
    OrchestrationSafetyConfig,
    | "max_tasks_per_run"
    | "max_parallel_tasks"
    | "max_attempts_per_task"
    | "max_repair_rounds"
    | "max_files_per_task"
    | "max_context_size"
    | "max_review_findings"
    | "max_validation_log_size"
    | "max_patch_bytes"
    | "lock_ttl_ms"
    | "validation_timeout"
  >> = [
    "max_tasks_per_run",
    "max_parallel_tasks",
    "max_attempts_per_task",
    "max_repair_rounds",
    "max_files_per_task",
    "max_context_size",
    "max_review_findings",
    "max_validation_log_size",
    "max_patch_bytes",
    "lock_ttl_ms",
    "validation_timeout"
  ];
  for (const key of numericKeys) {
    const minValue = key === "max_repair_rounds" ? 0 : 1;
    if (!Number.isFinite(config[key]) || config[key] < minValue) {
      throw new Error(`Invalid orchestration config ${key}: expected positive number`);
    }
  }
  if (!config.memory_path.trim()) throw new Error("Invalid orchestration config memory_path");
  if (!["fast", "deep", "exhaustive"].includes(config.execution_mode)) throw new Error("Invalid orchestration config execution_mode");
  if (!["basic", "standard", "strict"].includes(config.validation_level)) throw new Error("Invalid orchestration config validation_level");
  if (!Array.isArray(config.safe_commands_allowlist)) throw new Error("Invalid orchestration config safe_commands_allowlist");
  return config;
}

function envNumber(name: string, value: number | undefined, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return value ?? fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, value: boolean | undefined, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return value ?? fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name: string, value: string[] | undefined, fallback: string[]) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return value ?? fallback;
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function envMode(name: string, fallback: ExecutionMode): ExecutionMode {
  const raw = process.env[name];
  if (raw === "fast" || raw === "deep" || raw === "exhaustive") return raw;
  return fallback;
}

function envValidationLevel(name: string, fallback: ValidationLevel): ValidationLevel {
  const raw = process.env[name];
  if (raw === "basic" || raw === "standard" || raw === "strict") return raw;
  return fallback;
}
