import path from "node:path";
import type { Run, Task } from "./OrchestrationModels.js";
import { FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { isRecord, readOptionalJson } from "./CoreReportArtifactHelpers.js";

export type PromptWriterReportSummary = {
  prompt_writer_runs: number;
  adopted_count: number;
  rejected_count: number;
  shadow_count: number;
  fallback_count: number;
  failed_schema_count: number;
  failed_quality_count: number;
  top_missing_context_warnings: string[];
};

export type LockReportSummary = {
  locks_requested: number;
  locks_acquired: number;
  locks_rejected: number;
  advisory_locks: number;
  semantic_locks: number;
  module_locks: number;
  expired_locks_recovered: number;
  active_locks_at_end: number;
  blocking_conflicts: number;
};

export class CoreFinalReportArtifactSummaryService {
  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {}

  async promptWriterReportSummary(tasks: Task[]): Promise<PromptWriterReportSummary> {
    const artifacts = tasks.flatMap((task) => task.artifacts).filter((artifact) => artifact.includes(`${path.sep}prompt_writers${path.sep}`));
    const decisions = await Promise.all(artifacts
      .filter((artifact) => path.basename(artifact).startsWith("adoption_decision_"))
      .map((artifact) => readOptionalJson<Record<string, unknown>>(artifact)));
    const schemaValidations = await Promise.all(artifacts
      .filter((artifact) => path.basename(artifact).startsWith("schema_validation_"))
      .map((artifact) => readOptionalJson<Record<string, unknown>>(artifact)));
    const parsedOutputs = await Promise.all(artifacts
      .filter((artifact) => path.basename(artifact).startsWith("parsed_output_"))
      .map((artifact) => readOptionalJson<Record<string, unknown>>(artifact)));
    const validDecisions = decisions.filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const validSchemas = schemaValidations.filter((entry): entry is Record<string, unknown> => Boolean(entry));
    const validOutputs = parsedOutputs.filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return {
      prompt_writer_runs: artifacts.filter((artifact) => path.basename(artifact).startsWith("summary_")).length,
      adopted_count: validDecisions.filter((decision) => decision.adopted === true).length,
      rejected_count: validDecisions.filter((decision) => decision.decision === "rejected").length,
      shadow_count: validDecisions.filter((decision) => decision.decision === "shadow_recorded").length,
      fallback_count: artifacts.filter((artifact) => path.basename(artifact).startsWith("raw_output_")).length,
      failed_schema_count: validSchemas.filter((schema) => schema.schema_status === "failed").length,
      failed_quality_count: validDecisions.filter((decision) => decision.quality_status === "failed" || decision.quality_status === "blocked").length,
      top_missing_context_warnings: uniqueStrings(validOutputs.flatMap((output) => Array.isArray(output.missing_context)
        ? output.missing_context.filter((entry): entry is string => typeof entry === "string")
        : [])).slice(0, 5)
    };
  }

  async lockReportSummary(run: Run, tasks: Task[]): Promise<LockReportSummary> {
    const artifacts = tasks.flatMap((task) => task.artifacts).filter((artifact) => artifact.includes(`${path.sep}locks${path.sep}`));
    const lockArtifacts = await Promise.all(artifacts.map((artifact) => readOptionalJson<unknown>(artifact)));
    const locks = lockArtifacts.flatMap((entry) => Array.isArray(entry) ? entry : isRecord(entry) && Array.isArray(entry.locks) ? entry.locks : []);
    const conflicts = lockArtifacts.flatMap((entry) => isRecord(entry) && Array.isArray(entry.conflicts) ? entry.conflicts : []);
    let activeLocksAtEnd = 0;
    try {
      const metadata = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        activeLocksAtEnd = metadata.listActiveDurableLocks().filter((lock) => lock.run_id === run.id).length;
      } finally {
        metadata.close();
      }
    } catch {
      activeLocksAtEnd = 0;
    }
    return {
      locks_requested: artifacts.filter((artifact) => path.basename(artifact).startsWith("lock_request_")).length,
      locks_acquired: locks.filter((lock) => isRecord(lock) && lock.status === "acquired").length,
      locks_rejected: locks.filter((lock) => isRecord(lock) && lock.status === "rejected").length,
      advisory_locks: locks.filter((lock) => isRecord(lock) && (lock.lock_type === "advisory" || lock.lock_mode === "advisory")).length,
      semantic_locks: locks.filter((lock) => isRecord(lock) && lock.lock_type === "semantic").length,
      module_locks: locks.filter((lock) => isRecord(lock) && lock.lock_type === "module").length,
      expired_locks_recovered: locks.filter((lock) => isRecord(lock) && (lock.status === "expired" || lock.status === "stolen_or_recovered")).length,
      active_locks_at_end: activeLocksAtEnd,
      blocking_conflicts: conflicts.filter((conflict) => isRecord(conflict) && conflict.blocking !== false).length
    };
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
