import { randomUUID } from "node:crypto";
import type { ControlledIntegrationApplyStatus } from "./ControlledIntegrationApplyModels.js";
import type { OverallValidationStatus } from "./ValidationSemantics.js";

export type IntegrationFinalizationStatus =
  | "not_required"
  | "pending"
  | "finalized"
  | "blocked"
  | "apply_failed"
  | "validation_failed"
  | "validation_blocked"
  | "rollback_completed"
  | "rollback_failed"
  | "memory_update_failed"
  | "partial"
  | "cancelled";

export type IntegrationFinalizationBlocker = {
  blocker_id: string;
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  blocker_type:
    | "finalization_disabled"
    | "controlled_apply_missing"
    | "controlled_apply_not_successful"
    | "apply_artifact_missing"
    | "post_validation_ref_missing"
    | "strict_validation_not_passed"
    | "changed_files_missing"
    | "locks_not_released"
    | "integration_candidate_missing"
    | "apply_approval_missing"
    | "rollback_failed"
    | "memory_update_failed"
    | "cancelled";
  severity: "warning" | "blocking" | "critical";
  reason: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationFinalizationWarning = {
  warning_id: string;
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  warning_type:
    | "rollback_recorded"
    | "metadata_only_update"
    | "memory_update_skipped"
    | "lesson_creation_skipped"
    | "task_status_update_metadata_only";
  severity: "info" | "warning";
  message: string;
  refs: string[];
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationMemoryEntry = {
  memory_entry_id: string;
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  scope: "run" | "team" | "task" | "global";
  entry_type: "decision" | "lesson" | "validation" | "integration" | "failure" | "risk" | "file_summary";
  summary: string;
  source_refs: string[];
  confidence: number;
  freshness: "fresh" | "stale" | "unknown";
  tags: string[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationLesson = {
  lesson_id: string;
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  lesson_type: "validation" | "scope" | "rollback" | "review" | "integration";
  summary: string;
  evidence_refs: string[];
  tags: string[];
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TaskStatusUpdateRef = {
  task_status_update_id: string;
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  target_type: "integration_candidate" | "proposal" | "proposed_node" | "adopted_task" | "review" | "run_report";
  target_id: string;
  previous_status?: string;
  next_status: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationFinalizationRequest = {
  request_id: string;
  run_id: string;
  controlled_apply_ids: string[];
  requested_by: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationFinalizationResult = {
  integration_finalization_id: string;
  run_id: string;
  controlled_apply_id: string;
  integration_candidate_id: string;
  proposal_id: string;
  proposed_node_id?: string;
  task_id?: string;
  team_id?: string;
  controlled_apply_status: ControlledIntegrationApplyStatus;
  strict_validation_status: OverallValidationStatus;
  rollback_status?: string;
  finalized_files: string[];
  rejected_files: string[];
  validation_refs: string[];
  apply_refs: string[];
  rollback_refs: string[];
  memory_entries_created: IntegrationMemoryEntry[];
  lessons_created: IntegrationLesson[];
  task_status_updates: TaskStatusUpdateRef[];
  report_summary_ref?: string;
  status: IntegrationFinalizationStatus;
  blockers: IntegrationFinalizationBlocker[];
  warnings: IntegrationFinalizationWarning[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  completed_at?: string;
};

export type IntegrationFinalizationSummary = {
  summary_id: string;
  run_id: string;
  integration_finalization_used: boolean;
  integration_finalization_count: number;
  finalized_count: number;
  validation_failed_count: number;
  rollback_completed_count: number;
  rollback_failed_count: number;
  memory_entries_created_count: number;
  lessons_created_count: number;
  finalization_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type IntegrationFinalizationBatch = {
  batch_id: string;
  run_id: string;
  controlled_apply_ids: string[];
  results: IntegrationFinalizationResult[];
  summary: IntegrationFinalizationSummary;
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createIntegrationFinalizationBlocker(input: Omit<IntegrationFinalizationBlocker, "blocker_id" | "created_at" | "metadata_json"> & {
  blocker_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationFinalizationBlocker {
  return {
    ...input,
    blocker_id: input.blocker_id ?? `integration_finalization_blocker_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationFinalizationWarning(input: Omit<IntegrationFinalizationWarning, "warning_id" | "created_at" | "metadata_json"> & {
  warning_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationFinalizationWarning {
  return {
    ...input,
    warning_id: input.warning_id ?? `integration_finalization_warning_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationMemoryEntry(input: Omit<IntegrationMemoryEntry, "memory_entry_id" | "created_at" | "metadata_json"> & {
  memory_entry_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationMemoryEntry {
  return {
    ...input,
    memory_entry_id: input.memory_entry_id ?? `integration_memory_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationLesson(input: Omit<IntegrationLesson, "lesson_id" | "created_at" | "metadata_json"> & {
  lesson_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationLesson {
  return {
    ...input,
    lesson_id: input.lesson_id ?? `integration_lesson_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createTaskStatusUpdateRef(input: Omit<TaskStatusUpdateRef, "task_status_update_id" | "created_at" | "metadata_json"> & {
  task_status_update_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): TaskStatusUpdateRef {
  return {
    ...input,
    task_status_update_id: input.task_status_update_id ?? `integration_task_status_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationFinalizationRequest(input: Omit<IntegrationFinalizationRequest, "request_id" | "created_at" | "metadata_json"> & {
  request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationFinalizationRequest {
  return {
    ...input,
    request_id: input.request_id ?? `integration_finalization_request_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationFinalizationResult(input: Omit<IntegrationFinalizationResult, "integration_finalization_id" | "created_at" | "metadata_json" | "blockers" | "warnings" | "memory_entries_created" | "lessons_created" | "task_status_updates"> & {
  integration_finalization_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  blockers?: IntegrationFinalizationBlocker[];
  warnings?: IntegrationFinalizationWarning[];
  memory_entries_created?: IntegrationMemoryEntry[];
  lessons_created?: IntegrationLesson[];
  task_status_updates?: TaskStatusUpdateRef[];
}): IntegrationFinalizationResult {
  return {
    ...input,
    integration_finalization_id: input.integration_finalization_id ?? `integration_finalization_${randomUUID()}`,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    memory_entries_created: input.memory_entries_created ?? [],
    lessons_created: input.lessons_created ?? [],
    task_status_updates: input.task_status_updates ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationFinalizationSummary(input: Omit<IntegrationFinalizationSummary, "summary_id" | "created_at" | "metadata_json"> & {
  summary_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationFinalizationSummary {
  return {
    ...input,
    summary_id: input.summary_id ?? `integration_finalization_summary_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createIntegrationFinalizationBatch(input: Omit<IntegrationFinalizationBatch, "batch_id" | "created_at" | "metadata_json"> & {
  batch_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): IntegrationFinalizationBatch {
  return {
    ...input,
    batch_id: input.batch_id ?? `integration_finalization_batch_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}
