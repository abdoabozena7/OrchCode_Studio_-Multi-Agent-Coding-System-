import { createHash, randomUUID } from "node:crypto";

export const CANONICAL_RUN_STATUSES = [
  "created",
  "intake",
  "prompt_rewrite",
  "clarification_check",
  "repo_mapping",
  "complexity_estimation",
  "staffing_plan",
  "planning",
  "task_graph_ready",
  "executing",
  "reviewing",
  "validating",
  "integrating",
  "memory_update",
  "reporting",
  "succeeded",
  "failed",
  "blocked",
  "cancelled"
] as const;

export type CanonicalRunStatus = typeof CANONICAL_RUN_STATUSES[number];

export type LegacyRunStatus =
  | "indexing"
  | "verifying"
  | "analyzing"
  | "staffing"
  | "scheduling";

export type RunStatusLike = CanonicalRunStatus | LegacyRunStatus | string;
export type RunTransitionTrigger = "automatic" | "user" | "retry" | "resume" | "failure_handling";

export type RunTransitionMetadata = {
  currentStatus?: RunStatusLike;
  reason: string;
  sourceComponent: string;
  taskId?: string;
  artifactRefs?: string[];
  trigger?: RunTransitionTrigger;
  timestamp?: string;
  mode?: "normal" | "plan_only";
  validationStatus?: "passed" | "failed" | "blocked" | "skipped" | "partial" | "not_required" | "not_run";
};

export type RunTransitionRecord = {
  id: string;
  run_id: string;
  previous_status?: string;
  next_status: string;
  canonical_previous_status?: CanonicalRunStatus;
  canonical_next_status: CanonicalRunStatus;
  created_at: string;
  reason: string;
  source_component: string;
  task_id?: string;
  artifact_refs: string[];
  trigger: RunTransitionTrigger;
  metadata: Record<string, unknown>;
};

const CANONICAL_STATUS_SET = new Set<string>(CANONICAL_RUN_STATUSES);

const LEGACY_STATUS_ALIASES: Record<LegacyRunStatus, CanonicalRunStatus> = {
  indexing: "repo_mapping",
  verifying: "validating",
  analyzing: "complexity_estimation",
  staffing: "staffing_plan",
  scheduling: "executing"
};

const TERMINAL_STATUSES = new Set<CanonicalRunStatus>(["succeeded", "failed", "cancelled"]);
const BLOCKED_STATUSES = new Set<CanonicalRunStatus>(["blocked"]);
const FAILED_STATUSES = new Set<CanonicalRunStatus>(["failed"]);
const RESUME_SAFE_STATUSES = new Set<CanonicalRunStatus>([
  "intake",
  "clarification_check",
  "repo_mapping",
  "complexity_estimation",
  "staffing_plan",
  "planning",
  "task_graph_ready",
  "executing",
  "reviewing",
  "validating",
  "integrating",
  "memory_update",
  "reporting",
  "blocked",
  "failed"
]);

const ALLOWED_TRANSITIONS: Record<CanonicalRunStatus, CanonicalRunStatus[]> = {
  created: ["intake", "repo_mapping", "complexity_estimation", "failed", "blocked", "cancelled"],
  intake: ["prompt_rewrite", "clarification_check", "repo_mapping", "planning", "failed", "blocked", "cancelled"],
  prompt_rewrite: ["clarification_check", "failed", "blocked", "cancelled"],
  clarification_check: ["repo_mapping", "failed", "blocked", "cancelled"],
  repo_mapping: ["complexity_estimation", "planning", "failed", "blocked", "cancelled"],
  complexity_estimation: ["staffing_plan", "planning", "failed", "blocked", "cancelled"],
  staffing_plan: ["planning", "failed", "blocked", "cancelled"],
  planning: ["task_graph_ready", "failed", "blocked", "cancelled"],
  task_graph_ready: ["executing", "reporting", "failed", "blocked", "cancelled"],
  executing: ["reviewing", "failed", "blocked", "cancelled"],
  reviewing: ["validating", "integrating", "failed", "blocked", "cancelled"],
  validating: ["integrating", "failed", "blocked", "cancelled"],
  integrating: ["memory_update", "failed", "blocked", "cancelled"],
  memory_update: ["reporting", "failed", "blocked", "cancelled"],
  reporting: ["succeeded", "failed", "blocked", "cancelled"],
  succeeded: [],
  failed: ["executing", "planning", "task_graph_ready", "blocked", "cancelled"],
  blocked: ["clarification_check", "repo_mapping", "planning", "task_graph_ready", "executing", "validating", "failed", "cancelled"],
  cancelled: []
};

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly from: RunStatusLike | undefined,
    readonly to: RunStatusLike,
    readonly reason: string
  ) {
    super(`Invalid run transition ${from ?? "<none>"} -> ${to}: ${reason}`);
    this.name = "InvalidRunTransitionError";
  }
}

export function normalizeRunStatus(status: RunStatusLike): CanonicalRunStatus {
  if (CANONICAL_STATUS_SET.has(status)) return status as CanonicalRunStatus;
  if (status in LEGACY_STATUS_ALIASES) return LEGACY_STATUS_ALIASES[status as LegacyRunStatus];
  throw new InvalidRunTransitionError(undefined, status, `Unknown run status "${status}".`);
}

export function canTransitionRun(from: RunStatusLike | undefined, to: RunStatusLike, metadata: Partial<RunTransitionMetadata> = {}) {
  try {
    assertRunTransition(from, to, metadata);
    return true;
  } catch {
    return false;
  }
}

export function assertRunTransition(from: RunStatusLike | undefined, to: RunStatusLike, metadata: Partial<RunTransitionMetadata> = {}) {
  const next = normalizeRunStatus(to);
  const previous = from === undefined ? undefined : normalizeRunStatus(from);
  if (previous === undefined) {
    if (next !== "created") {
      throw new InvalidRunTransitionError(from, to, "Initial transition must create the run.");
    }
    return;
  }
  if (previous === next) return;
  if (previous === "cancelled") {
    throw new InvalidRunTransitionError(from, to, "Cancelled runs are terminal.");
  }
  if (previous === "succeeded") {
    throw new InvalidRunTransitionError(from, to, "Succeeded runs are terminal.");
  }
  if (previous === "failed" && !isResumeOrRetry(metadata.trigger)) {
    const allowedFailureHandling = next === "blocked" || next === "cancelled";
    if (!allowedFailureHandling) {
      throw new InvalidRunTransitionError(from, to, "Failed runs require an explicit resume or retry transition before continuing.");
    }
  }
  if (previous === "validating" && next === "succeeded") {
    throw new InvalidRunTransitionError(from, to, "Validation must integrate, update memory, and report before success.");
  }
  if (previous === "validating" && metadata.validationStatus && metadata.validationStatus !== "passed" && metadata.validationStatus !== "not_required") {
    if (next !== "failed" && next !== "blocked" && next !== "cancelled") {
      throw new InvalidRunTransitionError(from, to, `Validation status ${metadata.validationStatus} cannot continue to ${next}.`);
    }
  }
  const allowed = ALLOWED_TRANSITIONS[previous];
  if (!allowed.includes(next)) {
    throw new InvalidRunTransitionError(from, to, `${previous} may transition only to: ${allowed.join(", ") || "no states"}.`);
  }
}

export function transitionRun(runId: string, nextStatus: RunStatusLike, metadata: RunTransitionMetadata): RunTransitionRecord {
  assertRunTransition(metadata.currentStatus, nextStatus, metadata);
  const timestamp = metadata.timestamp ?? new Date().toISOString();
  const canonicalNext = normalizeRunStatus(nextStatus);
  const canonicalPrevious = metadata.currentStatus === undefined ? undefined : normalizeRunStatus(metadata.currentStatus);
  const artifactRefs = metadata.artifactRefs ?? [];
  return {
    id: `run_transition_${transitionHash(runId, timestamp, metadata.currentStatus, nextStatus, metadata.reason)}_${randomUUID().slice(0, 8)}`,
    run_id: runId,
    previous_status: metadata.currentStatus,
    next_status: nextStatus,
    canonical_previous_status: canonicalPrevious,
    canonical_next_status: canonicalNext,
    created_at: timestamp,
    reason: metadata.reason,
    source_component: metadata.sourceComponent,
    task_id: metadata.taskId,
    artifact_refs: artifactRefs,
    trigger: metadata.trigger ?? "automatic",
    metadata: {
      mode: metadata.mode,
      validation_status: metadata.validationStatus,
      artifact_ref_count: artifactRefs.length
    }
  };
}

export function isTerminalRunStatus(status: RunStatusLike) {
  return TERMINAL_STATUSES.has(normalizeRunStatus(status));
}

export function isBlockedRunStatus(status: RunStatusLike) {
  return BLOCKED_STATUSES.has(normalizeRunStatus(status));
}

export function isFailedRunStatus(status: RunStatusLike) {
  return FAILED_STATUSES.has(normalizeRunStatus(status));
}

export function isResumeSafeRunStatus(status: RunStatusLike) {
  return RESUME_SAFE_STATUSES.has(normalizeRunStatus(status));
}

export function canonicalRunStatusValues() {
  return [...CANONICAL_RUN_STATUSES];
}

export function legacyRunStatusAliases() {
  return { ...LEGACY_STATUS_ALIASES };
}

function isResumeOrRetry(trigger?: RunTransitionTrigger) {
  return trigger === "resume" || trigger === "retry";
}

function transitionHash(runId: string, timestamp: string, from: RunStatusLike | undefined, to: RunStatusLike, reason: string) {
  return createHash("sha256").update([runId, timestamp, from ?? "", to, reason].join("\0")).digest("hex").slice(0, 16);
}
