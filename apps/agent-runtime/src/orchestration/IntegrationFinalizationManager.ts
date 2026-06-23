import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { ControlledIntegrationApplyResult, RollbackResult } from "./ControlledIntegrationApplyModels.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { IntegrationApplyApproval } from "./IntegrationApplyApprovalModels.js";
import {
  createIntegrationFinalizationBatch,
  createIntegrationFinalizationBlocker,
  createIntegrationFinalizationResult,
  createIntegrationFinalizationSummary,
  createIntegrationFinalizationWarning,
  createTaskStatusUpdateRef,
  type IntegrationFinalizationBatch,
  type IntegrationFinalizationBlocker,
  type IntegrationFinalizationResult,
  type IntegrationFinalizationStatus,
  type IntegrationFinalizationSummary,
  type TaskStatusUpdateRef
} from "./IntegrationFinalizationModels.js";
import { IntegrationMemoryUpdater } from "./IntegrationMemoryUpdater.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { SandboxValidatedIntegrationCandidate } from "./SandboxIntegrationCandidateModels.js";
import type { OverallValidationStatus } from "./ValidationSemantics.js";

export type IntegrationFinalizationManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  memoryUpdater?: IntegrationMemoryUpdater;
};

export type IntegrationFinalizationBatchOptions = {
  controlledApplyIds?: string[];
};

type FinalizationEligibility = {
  eligible: boolean;
  status: IntegrationFinalizationStatus;
  blockers: IntegrationFinalizationBlocker[];
  rollback?: RollbackResult;
  candidate?: SandboxValidatedIntegrationCandidate;
  approval?: IntegrationApplyApproval;
  proposed_node_id?: string;
  task_id?: string;
  team_id?: string;
};

export class IntegrationFinalizationManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly memoryUpdater: IntegrationMemoryUpdater;

  constructor(options: IntegrationFinalizationManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "IntegrationFinalizationManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.memoryUpdater = options.memoryUpdater ?? new IntegrationMemoryUpdater({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      createMemoryEntries: this.config.create_integration_memory_entries ?? true,
      createLessons: this.config.create_integration_lessons ?? true
    });
  }

  async finalizeControlledApplyResult(controlledApplyResult: ControlledIntegrationApplyResult): Promise<IntegrationFinalizationResult> {
    const integrationFinalizationId = `integration_finalization_${controlledApplyResult.controlled_apply_id}`;
    await this.traceWriter.write({
      run_id: controlledApplyResult.run_id,
      event_type: "integration_finalization_started",
      lifecycle_stage: "memory_update",
      summary: `Integration finalization started for ${controlledApplyResult.controlled_apply_id}.`,
      artifact_refs: [controlledApplyResult.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_finalization_id: integrationFinalizationId, controlled_apply_id: controlledApplyResult.controlled_apply_id, no_apply: true, no_validation_run: true }
    });

    const eligibility = await this.validateFinalizationEligibility(controlledApplyResult, integrationFinalizationId);
    let result = this.baseResult(controlledApplyResult, integrationFinalizationId, eligibility.status, eligibility);
    if (!eligibility.eligible) {
      await this.traceWriter.write({
        run_id: controlledApplyResult.run_id,
        event_type: "integration_finalization_eligibility_blocked",
        lifecycle_stage: "blocked",
        severity: eligibility.status === "rollback_failed" ? "critical" : "warning",
        summary: `Integration finalization blocked with status ${eligibility.status}.`,
        metadata_json: { integration_finalization_id: integrationFinalizationId, blocker_count: eligibility.blockers.length }
      });
      if (shouldRecordFailureMemory(result.status) && eligibility.candidate && eligibility.approval) {
        await this.assignFinalizationArtifactRefs(result);
        try {
          const memory = await this.updateMemoryAfterIntegration(result, eligibility.candidate, eligibility.approval);
          result.memory_entries_created = memory.memoryEntries;
          result.lessons_created = memory.lessons;
        } catch (error) {
          result.blockers.push(blockerFor(result, "memory_update_failed", error instanceof Error ? error.message : String(error), [], "blocking"));
          await this.traceWriter.write({
            run_id: result.run_id,
            event_type: "integration_finalization_memory_update_failed",
            lifecycle_stage: "blocked",
            severity: "warning",
            summary: "Integration finalization failure memory update failed.",
            metadata_json: { integration_finalization_id: result.integration_finalization_id }
          });
        }
      }
      result.completed_at = new Date().toISOString();
      await this.writeFinalizationArtifacts(result, controlledApplyResult);
      await this.persistFinalizationResult(result);
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "integration_finalization_blocked",
        lifecycle_stage: "blocked",
        severity: result.status === "rollback_failed" ? "critical" : "warning",
        summary: `Integration finalization ended as ${result.status}.`,
        artifact_refs: [result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { integration_finalization_id: result.integration_finalization_id }
      });
      return result;
    }

    await this.traceWriter.write({
      run_id: controlledApplyResult.run_id,
      event_type: "integration_finalization_eligibility_passed",
      lifecycle_stage: "memory_update",
      summary: "Integration finalization eligibility passed.",
      metadata_json: { integration_finalization_id: integrationFinalizationId }
    });

    const semanticBlockers = await this.semanticConflictFinalizationBlockers(controlledApplyResult, integrationFinalizationId, eligibility);
    if (semanticBlockers.length) {
      result.status = "blocked";
      result.blockers.push(...semanticBlockers);
      result.completed_at = new Date().toISOString();
      await this.assignFinalizationArtifactRefs(result);
      await this.writeFinalizationArtifacts(result, controlledApplyResult);
      await this.persistFinalizationResult(result);
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "integration_finalization_semantic_conflict_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Integration finalization blocked by unresolved semantic conflicts.",
        artifact_refs: [result.artifact_ref, result.report_summary_ref, ...semanticBlockers.flatMap((blocker) => blocker.refs)].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { integration_finalization_id: result.integration_finalization_id, blocker_count: semanticBlockers.length }
      });
      return result;
    }

    result.status = "finalized";
    result.finalized_files = controlledApplyResult.applied_files.length ? controlledApplyResult.applied_files : controlledApplyResult.changed_files;
    await this.assignFinalizationArtifactRefs(result);
    result.task_status_updates = await this.updateTaskAndProposalStatus(result);
    await this.updateIntegrationMetadata(result);
    try {
      const memory = await this.updateMemoryAfterIntegration(result, eligibility.candidate, eligibility.approval);
      result.memory_entries_created = memory.memoryEntries;
      result.lessons_created = memory.lessons;
    } catch (error) {
      result.status = "memory_update_failed";
      result.blockers.push(blockerFor(result, "memory_update_failed", error instanceof Error ? error.message : String(error), [], "blocking"));
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "integration_finalization_memory_update_failed",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Integration finalization memory update failed.",
        metadata_json: { integration_finalization_id: result.integration_finalization_id }
      });
    }
    result.completed_at = new Date().toISOString();
    await this.writeFinalizationArtifacts(result, controlledApplyResult);
    await this.persistFinalizationResult(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_completed",
      lifecycle_stage: "memory_update",
      severity: result.status === "finalized" ? "info" : "warning",
      summary: `Integration finalization completed with status ${result.status}.`,
      artifact_refs: [result.artifact_ref, result.report_summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_finalization_id: result.integration_finalization_id, memory_entries: result.memory_entries_created.length, lessons: result.lessons_created.length }
    });
    return result;
  }

  async finalizeControlledApplyBatch(runId: string, options: IntegrationFinalizationBatchOptions = {}): Promise<IntegrationFinalizationBatch> {
    if (!this.config.enable_integration_finalization || this.config.integration_finalization_mode === "off") {
      const summary = this.summarizeFinalizations([], runId);
      const batch = createIntegrationFinalizationBatch({
        run_id: runId,
        controlled_apply_ids: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      await this.writeBatchArtifacts(batch);
      await this.metadata.recordIntegrationFinalizationBatchSaved(batch);
      return batch;
    }
    if (this.config.integration_finalization_mode === "report_only") {
      const summary = this.summarizeFinalizations([], runId);
      const batch = createIntegrationFinalizationBatch({
        run_id: runId,
        controlled_apply_ids: [],
        results: [],
        summary,
        metadata_json: { report_only: true, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      await this.writeBatchArtifacts(batch);
      await this.metadata.recordIntegrationFinalizationBatchSaved(batch);
      return batch;
    }
    const controlledApplyResults = await this.loadControlledApplyResultsForRun(runId, options.controlledApplyIds);
    const limit = this.config.max_finalizations_per_run ?? 4;
    const results: IntegrationFinalizationResult[] = [];
    for (const result of controlledApplyResults.slice(0, limit)) {
      results.push(await this.finalizeControlledApplyResult(result));
    }
    const summary = this.summarizeFinalizations(results, runId);
    const batch = createIntegrationFinalizationBatch({
      run_id: runId,
      controlled_apply_ids: controlledApplyResults.slice(0, limit).map((result) => result.controlled_apply_id),
      results,
      summary,
      metadata_json: {
        integration_finalization_mode: this.config.integration_finalization_mode,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    await this.writeBatchArtifacts(batch);
    await this.metadata.recordIntegrationFinalizationBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "integration_finalization_batch_completed",
      lifecycle_stage: "memory_update",
      summary: `Integration finalization batch completed with ${results.length} result(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: summary
    });
    return batch;
  }

  async validateFinalizationEligibility(result: ControlledIntegrationApplyResult, integrationFinalizationId = `integration_finalization_${result.controlled_apply_id}`): Promise<FinalizationEligibility> {
    const candidate = await this.loadCandidate(result.integration_candidate_id);
    const approval = await this.loadApproval(result.integration_apply_approval_id);
    const rollback = await this.loadRollback(result);
    const proposed = candidate ? await this.loadProposedNode(candidate.proposed_node_id) : undefined;
    const blockers: IntegrationFinalizationBlocker[] = [];
    const add = (type: IntegrationFinalizationBlocker["blocker_type"], reason: string, refs: string[] = [], severity: IntegrationFinalizationBlocker["severity"] = "blocking") => {
      blockers.push(createIntegrationFinalizationBlocker({
        integration_finalization_id: integrationFinalizationId,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        blocker_type: type,
        severity,
        reason,
        refs
      }));
    };

    if (!this.config.enable_integration_finalization || this.config.integration_finalization_mode === "off") add("finalization_disabled", "Integration finalization is disabled.", [], "warning");
    if (!result.artifact_ref || !existsSync(result.artifact_ref)) add("apply_artifact_missing", "Controlled apply artifact is missing.", [result.artifact_ref ?? result.controlled_apply_id]);
    if (!result.post_validation_result_ref || !existsSync(result.post_validation_result_ref)) add("post_validation_ref_missing", "Post-apply validation result ref is missing.", [result.post_validation_result_ref ?? result.controlled_apply_id]);
    if (!result.changed_files.length) add("changed_files_missing", "Controlled apply changed files are unknown.", [result.controlled_apply_id]);
    if (!candidate) add("integration_candidate_missing", "Integration candidate metadata/artifact is missing.", [result.integration_candidate_id]);
    if (!approval) add("apply_approval_missing", "Integration apply approval metadata/artifact is missing.", [result.integration_apply_approval_id]);
    if (!await this.locksReleased(result)) add("locks_not_released", "Controlled apply locks were not proven released.", result.acquired_lock_refs);

    if (result.status === "rollback_failed" || rollback?.status === "rollback_failed") {
      add("rollback_failed", "Controlled apply rollback failed; finalization cannot mark integration complete.", [result.rollback_result_ref ?? result.controlled_apply_id], "critical");
      return { eligible: false, status: "rollback_failed", blockers, rollback, candidate, approval, proposed_node_id: candidate?.proposed_node_id, task_id: proposed?.adopted_task_id, team_id: proposed?.team_id };
    }
    if (rollback?.status === "rolled_back" && result.strict_validation_status !== "passed") {
      return { eligible: false, status: "rollback_completed", blockers, rollback, candidate, approval, proposed_node_id: candidate?.proposed_node_id, task_id: proposed?.adopted_task_id, team_id: proposed?.team_id };
    }
    if (result.strict_validation_status !== "passed") {
      add("strict_validation_not_passed", `Strict post-apply validation status is ${result.strict_validation_status}.`, [result.post_validation_result_ref ?? result.controlled_apply_id]);
      return { eligible: false, status: validationBlockedStatus(result.strict_validation_status), blockers, rollback, candidate, approval, proposed_node_id: candidate?.proposed_node_id, task_id: proposed?.adopted_task_id, team_id: proposed?.team_id };
    }
    if (!["post_validation_passed", "applied"].includes(result.status)) {
      add("controlled_apply_not_successful", `Controlled apply status is ${result.status}.`, [result.controlled_apply_id]);
    }
    if ((this.config.require_passed_post_apply_validation ?? true) && result.status !== "post_validation_passed") {
      add("strict_validation_not_passed", `Controlled apply did not record post_validation_passed status; status is ${result.status}.`, [result.controlled_apply_id]);
    }
    return {
      eligible: blockers.length === 0,
      status: blockers.length ? statusForBlockers(blockers, result) : "pending",
      blockers,
      rollback,
      candidate,
      approval,
      proposed_node_id: candidate?.proposed_node_id,
      task_id: proposed?.adopted_task_id,
      team_id: proposed?.team_id
    };
  }

  buildFinalizationSummary(result: IntegrationFinalizationResult) {
    return [
      `# Integration Finalization ${result.integration_finalization_id}`,
      "",
      `- status: ${result.status}`,
      `- controlled_apply_id: ${result.controlled_apply_id}`,
      `- integration_candidate_id: ${result.integration_candidate_id}`,
      `- proposal_id: ${result.proposal_id}`,
      `- proposed_node_id: ${result.proposed_node_id ?? "n/a"}`,
      `- task_id: ${result.task_id ?? "n/a"}`,
      `- team_id: ${result.team_id ?? "n/a"}`,
      `- controlled_apply_status: ${result.controlled_apply_status}`,
      `- strict_validation_status: ${result.strict_validation_status}`,
      `- rollback_status: ${result.rollback_status ?? "n/a"}`,
      `- finalized_files: ${result.finalized_files.join(", ") || "none"}`,
      `- rejected_files: ${result.rejected_files.join(", ") || "none"}`,
      `- memory_entries_created: ${result.memory_entries_created.length}`,
      `- lessons_created: ${result.lessons_created.length}`,
      `- task_status_updates: ${result.task_status_updates.length}`,
      `- blockers: ${result.blockers.length}`,
      "",
      "This finalization layer records metadata and memory only. It does not apply patches, generate patches, call provider writers, acquire locks, or run validation commands."
    ].join("\n");
  }

  async updateTaskAndProposalStatus(result: IntegrationFinalizationResult): Promise<TaskStatusUpdateRef[]> {
    if (result.status !== "finalized") return [];
    const updates = [
      createTaskStatusUpdateRef({
        integration_finalization_id: result.integration_finalization_id,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        target_type: "integration_candidate",
        target_id: result.integration_candidate_id,
        next_status: "finalized",
        artifact_ref: result.artifact_ref,
        metadata_json: { metadata_only: true, integrated: true }
      }),
      createTaskStatusUpdateRef({
        integration_finalization_id: result.integration_finalization_id,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        target_type: "proposal",
        target_id: result.proposal_id,
        next_status: "integrated",
        artifact_ref: result.artifact_ref,
        metadata_json: { metadata_only: true }
      }),
      createTaskStatusUpdateRef({
        integration_finalization_id: result.integration_finalization_id,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        target_type: "run_report",
        target_id: result.run_id,
        next_status: "integration_finalized",
        artifact_ref: result.report_summary_ref,
        metadata_json: { metadata_only: true }
      })
    ];
    if (result.proposed_node_id) {
      updates.push(createTaskStatusUpdateRef({
        integration_finalization_id: result.integration_finalization_id,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        target_type: "proposed_node",
        target_id: result.proposed_node_id,
        next_status: "integrated",
        artifact_ref: result.artifact_ref,
        metadata_json: { metadata_only: true }
      }));
    }
    if (result.task_id) {
      updates.push(createTaskStatusUpdateRef({
        integration_finalization_id: result.integration_finalization_id,
        run_id: result.run_id,
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        target_type: "adopted_task",
        target_id: result.task_id,
        next_status: "integrated_metadata",
        artifact_ref: result.artifact_ref,
        metadata_json: { metadata_only: true, no_execution_queue_change: true }
      }));
    }
    for (const update of updates) {
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "integration_finalization_task_status_updated",
        lifecycle_stage: "memory_update",
        summary: `Recorded metadata-only ${update.target_type} status update for ${update.target_id}.`,
        metadata_json: { integration_finalization_id: result.integration_finalization_id, target_type: update.target_type, target_id: update.target_id, next_status: update.next_status }
      });
    }
    return updates;
  }

  async semanticConflictFinalizationBlockers(
    controlledApplyResult: ControlledIntegrationApplyResult,
    integrationFinalizationId: string,
    eligibility: FinalizationEligibility
  ): Promise<IntegrationFinalizationBlocker[]> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    let rows: Array<{
      decision_id: string;
      batch_id?: string;
      conflict: string;
      decision: string;
      reason: string;
      severity: string;
      status: string;
      requires_user_approval: number;
      source_refs_json?: string;
      evidence_refs_json?: string;
      artifact_ref?: string;
      summary_ref?: string;
    }> = [];
    try {
      rows = store.all(
        `SELECT decision_id, batch_id, conflict, decision, reason, severity, status, requires_user_approval,
                source_refs_json, evidence_refs_json, artifact_ref, summary_ref
         FROM factory_semantic_conflict_decisions
         WHERE run_id = ?
           AND (
             requires_user_approval != 0
             OR status IN ('requires_user_approval', 'blocked')
             OR (severity = 'blocking' AND status != 'resolved')
           )
         ORDER BY created_at ASC`,
        controlledApplyResult.run_id
      );
    } catch {
      rows = [];
    } finally {
      store.close();
    }
    return rows.map((row) => createIntegrationFinalizationBlocker({
      integration_finalization_id: integrationFinalizationId,
      run_id: controlledApplyResult.run_id,
      controlled_apply_id: controlledApplyResult.controlled_apply_id,
      integration_candidate_id: controlledApplyResult.integration_candidate_id,
      blocker_type: "semantic_conflict_unresolved",
      severity: "blocking",
      reason: `Unresolved semantic conflict ${row.conflict}: ${row.reason}`,
      refs: uniqueFinalizationRefs([
        row.decision_id,
        row.batch_id,
        row.artifact_ref,
        row.summary_ref,
        ...jsonStringArray(row.source_refs_json),
        ...jsonStringArray(row.evidence_refs_json)
      ]),
      metadata_json: {
        semantic_conflict_decision_id: row.decision_id,
        semantic_conflict_batch_id: row.batch_id,
        semantic_conflict: row.conflict,
        semantic_decision: row.decision,
        semantic_status: row.status,
        semantic_severity: row.severity,
        requires_user_approval: Boolean(row.requires_user_approval),
        proposed_node_id: eligibility.proposed_node_id,
        task_id: eligibility.task_id,
        team_id: eligibility.team_id
      }
    }));
  }

  async updateIntegrationMetadata(result: IntegrationFinalizationResult) {
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_status_updated",
      lifecycle_stage: "memory_update",
      summary: "Integration finalization metadata status updates prepared.",
      metadata_json: { integration_finalization_id: result.integration_finalization_id, task_status_updates: result.task_status_updates.length }
    });
  }

  async updateMemoryAfterIntegration(result: IntegrationFinalizationResult, candidate?: SandboxValidatedIntegrationCandidate, approval?: IntegrationApplyApproval) {
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_memory_update_started",
      lifecycle_stage: "memory_update",
      summary: "Integration finalization memory update started.",
      metadata_json: { integration_finalization_id: result.integration_finalization_id }
    });
    const memory = await this.memoryUpdater.updateAfterIntegration({
      integration_finalization_id: result.integration_finalization_id,
      result: controlledResultFromFinalization(result),
      candidate,
      approval,
      task_id: result.task_id,
      team_id: result.team_id,
      report_summary_ref: result.report_summary_ref
    });
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_memory_update_completed",
      lifecycle_stage: "memory_update",
      summary: `Integration memory update created ${memory.memoryEntries.length} memory entry ref(s).`,
      metadata_json: { integration_finalization_id: result.integration_finalization_id, memory_entries: memory.memoryEntries.length }
    });
    for (const lesson of memory.lessons) {
      await this.traceWriter.write({
        run_id: result.run_id,
        event_type: "integration_finalization_lesson_created",
        lifecycle_stage: "memory_update",
        summary: lesson.summary,
        artifact_refs: lesson.evidence_refs,
        metadata_json: { integration_finalization_id: result.integration_finalization_id, lesson_id: lesson.lesson_id, lesson_type: lesson.lesson_type }
      });
    }
    return memory;
  }

  async persistFinalizationResult(result: IntegrationFinalizationResult) {
    await this.metadata.recordIntegrationFinalizationResultSaved(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_completed",
      lifecycle_stage: result.status === "finalized" ? "memory_update" : "blocked",
      severity: result.status === "finalized" ? "info" : "warning",
      summary: `Integration finalization result persisted: ${result.status}.`,
      artifact_refs: [result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_finalization_id: result.integration_finalization_id, status: result.status }
    });
    return result;
  }

  summarizeFinalizations(results: IntegrationFinalizationResult[], runId = results[0]?.run_id ?? ""): IntegrationFinalizationSummary {
    return createIntegrationFinalizationSummary({
      run_id: runId,
      integration_finalization_used: results.length > 0,
      integration_finalization_count: results.length,
      finalized_count: results.filter((result) => result.status === "finalized").length,
      validation_failed_count: results.filter((result) => result.status === "validation_failed").length,
      rollback_completed_count: results.filter((result) => result.status === "rollback_completed").length,
      rollback_failed_count: results.filter((result) => result.status === "rollback_failed").length,
      memory_entries_created_count: results.reduce((sum, result) => sum + result.memory_entries_created.length, 0),
      lessons_created_count: results.reduce((sum, result) => sum + result.lessons_created.length, 0)
    });
  }

  private baseResult(controlled: ControlledIntegrationApplyResult, finalizationId: string, status: IntegrationFinalizationStatus, eligibility: FinalizationEligibility): IntegrationFinalizationResult {
    const rollbackRefs = [controlled.rollback_result_ref].filter((ref): ref is string => Boolean(ref));
    const validationRefs = [controlled.post_validation_result_ref].filter((ref): ref is string => Boolean(ref));
    const applyRefs = [controlled.artifact_ref, controlled.patch_artifact_ref, controlled.pre_apply_snapshot_ref].filter((ref): ref is string => Boolean(ref));
    return createIntegrationFinalizationResult({
      integration_finalization_id: finalizationId,
      run_id: controlled.run_id,
      controlled_apply_id: controlled.controlled_apply_id,
      integration_candidate_id: controlled.integration_candidate_id,
      proposal_id: controlled.proposal_id,
      proposed_node_id: eligibility.proposed_node_id,
      task_id: eligibility.task_id,
      team_id: eligibility.team_id,
      controlled_apply_status: controlled.status,
      strict_validation_status: controlled.strict_validation_status,
      rollback_status: eligibility.rollback?.status ?? rollbackStatusFromControlled(controlled),
      finalized_files: [],
      rejected_files: status === "pending" ? controlled.failed_files : controlled.changed_files,
      validation_refs: validationRefs,
      apply_refs: applyRefs,
      rollback_refs: rollbackRefs,
      report_summary_ref: undefined,
      status,
      blockers: eligibility.blockers,
      warnings: [
        createIntegrationFinalizationWarning({
          integration_finalization_id: finalizationId,
          run_id: controlled.run_id,
          controlled_apply_id: controlled.controlled_apply_id,
          integration_candidate_id: controlled.integration_candidate_id,
          warning_type: "metadata_only_update",
          severity: "info",
          message: "Integration finalization records metadata and memory only.",
          refs: [controlled.artifact_ref].filter((ref): ref is string => Boolean(ref))
        })
      ],
      metadata_json: {
        integration_apply_approval_id: controlled.integration_apply_approval_id,
        no_patch_apply: true,
        no_patch_generation: true,
        no_provider_writer: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
  }

  private async writeFinalizationArtifacts(result: IntegrationFinalizationResult, controlled: ControlledIntegrationApplyResult) {
    const dir = await this.assignFinalizationArtifactRefs(result);
    await writeJson(path.join(dir, "finalization_input.json"), controlled);
    await writeJson(path.join(dir, "memory_updates.json"), result.memory_entries_created);
    await writeJson(path.join(dir, "lessons.json"), result.lessons_created);
    await writeJson(path.join(dir, "task_status_updates.json"), result.task_status_updates);
    await writeJson(result.artifact_ref!, result);
    await writeFile(result.report_summary_ref!, this.buildFinalizationSummary(result), "utf8");
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_finalization_summary_created",
      lifecycle_stage: "memory_update",
      summary: "Integration finalization summary created.",
      artifact_refs: [result.report_summary_ref!],
      metadata_json: { integration_finalization_id: result.integration_finalization_id }
    });
  }

  private async assignFinalizationArtifactRefs(result: IntegrationFinalizationResult) {
    const dir = await this.finalizationDir(result.run_id, result.integration_finalization_id);
    result.report_summary_ref = path.join(dir, "finalization_summary.md");
    result.artifact_ref = path.join(dir, "finalization_result.json");
    return dir;
  }

  private async writeBatchArtifacts(batch: IntegrationFinalizationBatch) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const dir = path.join(memory.runsDir, batch.run_id, "integration_finalization");
    await mkdir(dir, { recursive: true });
    batch.artifact_ref = path.join(dir, `integration_finalization_batch_${batch.batch_id}.json`);
    batch.summary_ref = path.join(dir, `integration_finalization_batch_summary_${batch.batch_id}.md`);
    batch.summary.finalization_summary_ref = batch.summary_ref;
    await writeJson(batch.artifact_ref, batch);
    await writeFile(batch.summary_ref, finalizationBatchSummaryMarkdown(batch.summary), "utf8");
  }

  private async finalizationDir(runId: string, finalizationId: string) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const dir = path.join(memory.runsDir, runId, "integration_finalization", finalizationId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async loadControlledApplyResultsForRun(runId: string, controlledApplyIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return [];
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = controlledApplyIds?.length
        ? store.all<{ artifact_ref?: string }>(
          `SELECT artifact_ref FROM factory_controlled_integration_applies WHERE run_id = ? AND controlled_apply_id IN (${controlledApplyIds.map(() => "?").join(",")}) ORDER BY created_at`,
          runId,
          ...controlledApplyIds
        )
        : store.all<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_controlled_integration_applies WHERE run_id = ? ORDER BY created_at", runId);
      const results: ControlledIntegrationApplyResult[] = [];
      for (const row of rows) {
        if (row.artifact_ref && existsSync(row.artifact_ref)) results.push(await readJson<ControlledIntegrationApplyResult>(row.artifact_ref));
      }
      return results;
    } finally {
      store.close();
    }
  }

  private async loadCandidate(candidateId: string) {
    return this.loadArtifactRow<SandboxValidatedIntegrationCandidate>(
      "SELECT artifact_ref FROM factory_sandbox_integration_candidates WHERE integration_candidate_id = ? ORDER BY created_at DESC LIMIT 1",
      candidateId
    );
  }

  private async loadApproval(approvalId: string) {
    return this.loadArtifactRow<IntegrationApplyApproval>(
      "SELECT artifact_ref FROM factory_integration_apply_approvals WHERE integration_apply_approval_id = ? ORDER BY created_at DESC LIMIT 1",
      approvalId
    );
  }

  private async loadRollback(result: ControlledIntegrationApplyResult) {
    if (result.rollback_result_ref && existsSync(result.rollback_result_ref)) return readJson<RollbackResult>(result.rollback_result_ref);
    return this.loadArtifactRow<RollbackResult>(
      "SELECT artifact_ref FROM factory_controlled_rollback_results WHERE controlled_apply_id = ? ORDER BY created_at DESC LIMIT 1",
      result.controlled_apply_id
    );
  }

  private async loadProposedNode(proposedNodeId: string) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.get<{ team_id?: string; adopted_task_id?: string }>(
        "SELECT team_id, adopted_task_id FROM factory_proposed_task_nodes WHERE proposed_node_id = ? ORDER BY created_at DESC LIMIT 1",
        proposedNodeId
      );
    } finally {
      store.close();
    }
  }

  private async loadArtifactRow<T>(sql: string, ...params: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ artifact_ref?: string }>(sql, ...params);
      return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<T>(row.artifact_ref) : undefined;
    } finally {
      store.close();
    }
  }

  private async locksReleased(result: ControlledIntegrationApplyResult) {
    if (!result.acquired_lock_refs.length) return false;
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return false;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = store.all<{ lock_id: string; status: string }>(
        `SELECT lock_id, status FROM factory_locks WHERE lock_id IN (${result.acquired_lock_refs.map(() => "?").join(",")})`,
        ...result.acquired_lock_refs
      );
      return rows.length === result.acquired_lock_refs.length && rows.every((row) => row.status === "released");
    } finally {
      store.close();
    }
  }
}

function controlledResultFromFinalization(result: IntegrationFinalizationResult): ControlledIntegrationApplyResult {
  return {
    controlled_apply_id: result.controlled_apply_id,
    run_id: result.run_id,
    integration_candidate_id: result.integration_candidate_id,
    integration_apply_approval_id: result.metadata_json.integration_apply_approval_id as string ?? "unknown",
    proposal_id: result.proposal_id,
    patch_artifact_ref: result.apply_refs.find((ref) => ref.includes("patch")),
    changed_files: [...result.finalized_files, ...result.rejected_files],
    acquired_lock_refs: [],
    apply_adapter: "finalization_replay",
    apply_status: "applied",
    applied_files: result.finalized_files,
    failed_files: result.rejected_files,
    post_validation_result_ref: result.validation_refs[0],
    strict_validation_status: result.strict_validation_status,
    rollback_result_ref: result.rollback_refs[0],
    status: result.controlled_apply_status,
    blockers: [],
    warnings: [],
    artifact_ref: result.apply_refs[0],
    metadata_json: { replayed_for_memory: true, no_apply: true },
    created_at: result.created_at,
    completed_at: result.completed_at
  };
}

function blockerFor(result: IntegrationFinalizationResult, blockerType: IntegrationFinalizationBlocker["blocker_type"], reason: string, refs: string[], severity: IntegrationFinalizationBlocker["severity"]) {
  return createIntegrationFinalizationBlocker({
    integration_finalization_id: result.integration_finalization_id,
    run_id: result.run_id,
    controlled_apply_id: result.controlled_apply_id,
    integration_candidate_id: result.integration_candidate_id,
    blocker_type: blockerType,
    severity,
    reason,
    refs
  });
}

function jsonStringArray(value: string | undefined) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function uniqueFinalizationRefs(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function statusForBlockers(blockers: IntegrationFinalizationBlocker[], result: ControlledIntegrationApplyResult): IntegrationFinalizationStatus {
  if (blockers.some((blocker) => blocker.blocker_type === "rollback_failed")) return "rollback_failed";
  if (result.status === "apply_failed") return "apply_failed";
  if (result.strict_validation_status === "failed") return "validation_failed";
  if (result.strict_validation_status === "partial") return "partial";
  if (["blocked", "skipped", "not_run", "not_required"].includes(result.strict_validation_status)) return "validation_blocked";
  return "blocked";
}

function validationBlockedStatus(status: OverallValidationStatus): IntegrationFinalizationStatus {
  if (status === "failed") return "validation_failed";
  if (status === "partial") return "partial";
  return "validation_blocked";
}

function rollbackStatusFromControlled(result: ControlledIntegrationApplyResult) {
  if (result.status === "rolled_back") return "rolled_back";
  if (result.status === "rollback_failed") return "rollback_failed";
  return result.rollback_result_ref ? "recorded" : undefined;
}

function shouldRecordFailureMemory(status: IntegrationFinalizationStatus) {
  return [
    "apply_failed",
    "validation_failed",
    "validation_blocked",
    "rollback_completed",
    "rollback_failed",
    "partial"
  ].includes(status);
}

function finalizationBatchSummaryMarkdown(summary: IntegrationFinalizationSummary) {
  return [
    `# Integration Finalization Summary ${summary.summary_id}`,
    "",
    `- integration_finalization_used: ${summary.integration_finalization_used}`,
    `- integration_finalization_count: ${summary.integration_finalization_count}`,
    `- finalized_count: ${summary.finalized_count}`,
    `- validation_failed_count: ${summary.validation_failed_count}`,
    `- rollback_completed_count: ${summary.rollback_completed_count}`,
    `- rollback_failed_count: ${summary.rollback_failed_count}`,
    `- memory_entries_created_count: ${summary.memory_entries_created_count}`,
    `- lessons_created_count: ${summary.lessons_created_count}`,
    `- finalization_summary_ref: ${summary.finalization_summary_ref ?? "n/a"}`,
    "",
    "This batch is finalization-only: no patch apply, no provider writer, no lock acquisition, and no validation command execution."
  ].join("\n");
}
