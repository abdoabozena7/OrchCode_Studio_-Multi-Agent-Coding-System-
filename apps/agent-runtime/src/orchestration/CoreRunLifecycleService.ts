import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { IntentLedgerService } from "./IntentLedgerService.js";
import { computeRunMetrics } from "./Metrics.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type FinalRunReport,
  type OrchestratorEvent,
  type Run,
  type RunCheckpoint,
  type RunMetrics,
  type RunStatus,
  type Task
} from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import {
  isResumeSafeRunStatus,
  normalizeRunStatus,
  transitionRun as createRunTransition,
  type RunTransitionTrigger
} from "./RunStateMachine.js";
import { assertValid, validateRun } from "./Validation.js";

export type CoreRunTransitionOptions = {
  trigger?: RunTransitionTrigger;
  taskId?: string;
  artifactRefs?: string[];
  mode?: "normal" | "plan_only";
  validationStatus?: "passed" | "failed" | "blocked" | "skipped" | "partial" | "not_required" | "not_run";
};

export type CoreRunCreationOptions = {
  userRequest: string;
  workspacePath: string;
  memoryDir: string;
  config: OrchestrationSafetyConfig;
  maxContextFiles: number;
  maxContextChars: number;
  maxTaskAttempts: number;
};

export type CoreRunResumeReconciliation = {
  ok: boolean;
  reason: string;
  severity?: "blocked" | "failed";
};

export type CoreRunResumeReconciliationOptions = {
  run: Run;
  workspacePath: string;
  memoryDir: string;
};

export class CoreRunLifecycleService {
  constructor(
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly traceWriter: FactoryTraceWriter,
    private readonly sourceComponent = "CoreOrchestrator"
  ) {}

  async createRun(options: CoreRunCreationOptions): Promise<Run> {
    const runId = `run_${randomUUID()}`;
    const paths = await this.artifactStore.ensureRunLayout(runId);
    const now = new Date().toISOString();
    const run: Run = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: runId,
      user_request: options.userRequest,
      status: "created",
      created_at: now,
      updated_at: now,
      root_task_ids: [],
      memory_snapshot_ref: "pending",
      config: {
        workspace_path: options.workspacePath,
        memory_dir: options.memoryDir,
        enable_internal_swarm_autopilot: options.config.enable_internal_swarm_autopilot,
        max_supported_logical_agents: options.config.max_supported_logical_agents,
        max_swarm_parallel_agents: options.config.max_swarm_parallel_agents,
        max_swarm_executors: options.config.max_swarm_executors,
        max_context_files: options.maxContextFiles,
        max_context_chars: options.maxContextChars,
        max_task_attempts: options.maxTaskAttempts,
        provider_mode: "real_provider",
        execution_mode: options.config.execution_mode,
        max_tasks_per_run: options.config.max_tasks_per_run,
        max_parallel_tasks: options.config.max_parallel_tasks,
        max_repair_rounds: options.config.max_repair_rounds,
        max_files_per_task: options.config.max_files_per_task,
        max_validation_log_size: options.config.max_validation_log_size,
        max_patch_bytes: options.config.max_patch_bytes,
        lock_ttl_ms: options.config.lock_ttl_ms,
        enable_multi_perspective_review: options.config.enable_multi_perspective_review,
        enable_multi_plan_factory: options.config.enable_multi_plan_factory,
        enable_parallel_execution: options.config.enable_parallel_execution,
        validation_level: options.config.validation_level,
        require_human_approval_for_risky_files: options.config.require_human_approval_for_risky_files,
        validation_timeout: options.config.validation_timeout,
        safe_commands_allowlist: options.config.safe_commands_allowlist,
        swarm_worker_mode: options.config.swarm_worker_mode,
        use_planning_evidence: options.config.use_planning_evidence,
        planning_evidence_mode: options.config.planning_evidence_mode,
        max_evidence_items: options.config.max_evidence_items,
        min_evidence_confidence: options.config.min_evidence_confidence,
        prompt_writer_mode: options.config.prompt_writer_mode,
        prompt_writer_provider_mode: options.config.prompt_writer_provider_mode,
        enable_team_sub_planning: options.config.enable_team_sub_planning,
        team_sub_planning_mode: options.config.team_sub_planning_mode,
        max_team_sub_plans_per_run: options.config.max_team_sub_plans_per_run,
        max_team_sub_plan_tasks: options.config.max_team_sub_plan_tasks,
        max_team_sub_plan_depth: options.config.max_team_sub_plan_depth,
        allow_provider_team_sub_planning: options.config.allow_provider_team_sub_planning,
        enable_team_task_adoption: options.config.enable_team_task_adoption,
        team_task_adoption_mode: options.config.team_task_adoption_mode,
        max_adopted_tasks_per_run: options.config.max_adopted_tasks_per_run,
        max_adopted_tasks_per_team: options.config.max_adopted_tasks_per_team,
        allow_write_task_future_candidates: options.config.allow_write_task_future_candidates,
        allow_executable_adoption: options.config.allow_executable_adoption,
        enable_proposed_task_graph: options.config.enable_proposed_task_graph,
        proposed_task_graph_mode: options.config.proposed_task_graph_mode,
        max_proposed_nodes_per_run: options.config.max_proposed_nodes_per_run,
        max_proposed_edges_per_run: options.config.max_proposed_edges_per_run,
        block_cycles: options.config.block_cycles,
        dedupe_proposed_nodes: options.config.dedupe_proposed_nodes,
        execution_readiness_gate_enabled: options.config.execution_readiness_gate_enabled,
        execution_readiness_mode: options.config.execution_readiness_mode,
        allow_read_only_promotion_candidates: options.config.allow_read_only_promotion_candidates,
        allow_write_future_candidates: options.config.allow_write_future_candidates,
        require_human_approval_for_write: options.config.require_human_approval_for_write,
        allow_auto_approval_for_low_risk_read_only: options.config.allow_auto_approval_for_low_risk_read_only,
        max_nodes_evaluated_per_run: options.config.max_nodes_evaluated_per_run,
        enable_execution_promotion_queue: options.config.enable_execution_promotion_queue,
        promotion_queue_mode: options.config.promotion_queue_mode,
        allow_read_only_queue_without_human_approval: options.config.allow_read_only_queue_without_human_approval,
        approval_default_ttl_hours: options.config.approval_default_ttl_hours,
        allow_test_fixture_approvals: options.config.allow_test_fixture_approvals,
        track_blocked_promotion_requests: options.config.track_blocked_promotion_requests,
        enable_execution_preparation: options.config.enable_execution_preparation,
        execution_preparation_mode: options.config.execution_preparation_mode,
        max_preparation_plans_per_run: options.config.max_preparation_plans_per_run,
        require_human_approval_for_write_preparation: options.config.require_human_approval_for_write_preparation,
        allow_read_only_preparation_without_human_approval: options.config.allow_read_only_preparation_without_human_approval,
        block_on_stale_context: options.config.block_on_stale_context,
        block_on_prompt_quality_warning_for_write: options.config.block_on_prompt_quality_warning_for_write,
        enable_one_writer_dry_run: options.config.enable_one_writer_dry_run,
        one_writer_dry_run_mode: options.config.one_writer_dry_run_mode,
        enable_patch_proposal_review_gate: options.config.enable_patch_proposal_review_gate,
        patch_proposal_review_mode: options.config.patch_proposal_review_mode,
        enable_validation_candidate_gate: options.config.enable_validation_candidate_gate,
        validation_candidate_mode: options.config.validation_candidate_mode,
        enable_patch_apply_sandbox: options.config.enable_patch_apply_sandbox,
        patch_apply_sandbox_mode: options.config.patch_apply_sandbox_mode,
        enable_sandbox_validation: options.config.enable_sandbox_validation,
        sandbox_validation_mode: options.config.sandbox_validation_mode,
        enable_sandbox_integration_candidates: options.config.enable_sandbox_integration_candidates,
        sandbox_integration_candidate_mode: options.config.sandbox_integration_candidate_mode,
        enable_integration_apply_approval_gate: options.config.enable_integration_apply_approval_gate,
        integration_apply_approval_mode: options.config.integration_apply_approval_mode,
        enable_controlled_integration_apply: options.config.enable_controlled_integration_apply,
        controlled_apply_mode: options.config.controlled_apply_mode,
        enable_integration_finalization: options.config.enable_integration_finalization,
        integration_finalization_mode: options.config.integration_finalization_mode
      },
      artifacts_path: paths.runDir
    };
    const intent = await new IntentLedgerService({
      workspacePath: options.workspacePath,
      memoryDir: options.memoryDir,
      sourceComponent: this.sourceComponent
    }).saveOriginalRequest({
      runId,
      runKind: "core",
      artifactsPath: paths.runDir,
      originalRequest: options.userRequest,
      metadata: { source_component: this.sourceComponent }
    });
    run.original_request_ref = intent.artifact_ref;
    run.intent_ledger_ref = path.join(paths.runDir, "intent", "intent_ledger.json");
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.recordRunTransition(run.id, undefined, "created", "Run created.", this.sourceComponent);
    await this.artifactStore.appendEvent(this.event(run.id, "run.created", `Run created for request: ${options.userRequest}`));
    return run;
  }

  async reconcileRunForResume(options: CoreRunResumeReconciliationOptions): Promise<CoreRunResumeReconciliation> {
    const { run, workspacePath, memoryDir } = options;
    const paths = await this.artifactStore.pathsForRun(run.id);
    const metadataPath = await resolveFactoryMetadataDatabasePath(workspacePath, memoryDir);
    if (!existsSync(metadataPath)) {
      return { ok: false, reason: `Factory metadata database is missing: ${metadataPath}`, severity: "blocked" };
    }
    const metadata = await FactoryMetadataStore.open({ workspacePath, memoryDir, readOnly: true });
    try {
      const row = metadata.get<{ status: string; run_artifact_ref: string }>(
        "SELECT status, run_artifact_ref FROM factory_runs WHERE id = ?",
        run.id
      );
      if (!row) {
        return { ok: false, reason: `Factory metadata has no run row for ${run.id}.`, severity: "blocked" };
      }
      if (normalizeRunStatus(row.status) !== normalizeRunStatus(run.status)) {
        return {
          ok: false,
          reason: `Run status mismatch: artifact=${run.status}, metadata=${row.status}.`,
          severity: "blocked"
        };
      }
      if (path.resolve(row.run_artifact_ref) !== path.resolve(paths.run)) {
        return {
          ok: false,
          reason: `Run artifact ref mismatch: artifact=${paths.run}, metadata=${row.run_artifact_ref}.`,
          severity: "blocked"
        };
      }
      if (!isResumeSafeRunStatus(run.status) && !["succeeded", "cancelled"].includes(normalizeRunStatus(run.status))) {
        return {
          ok: false,
          reason: `Run status ${run.status} is not resume-safe.`,
          severity: "blocked"
        };
      }
      return { ok: true, reason: "SQLite run state and factory metadata agree." };
    } finally {
      metadata.close();
    }
  }

  async transitionRun(
    run: Run,
    status: RunStatus,
    message: string,
    options: CoreRunTransitionOptions = {}
  ) {
    const previous = run.status;
    const requested = await this.traceWriter.recordRunTransitionRequested({
      runId: run.id,
      previousStatus: previous,
      nextStatus: status,
      reason: message,
      sourceComponent: this.sourceComponent,
      taskId: options.taskId,
      artifactRefs: options.artifactRefs,
      trigger: options.trigger,
      mode: options.mode
    });

    let record: ReturnType<typeof createRunTransition>;
    try {
      record = createRunTransition(run.id, status, {
        currentStatus: previous,
        reason: message,
        sourceComponent: this.sourceComponent,
        taskId: options.taskId,
        artifactRefs: options.artifactRefs,
        trigger: options.trigger,
        mode: options.mode,
        validationStatus: options.validationStatus
      });
    } catch (error) {
      await this.traceWriter.recordRunTransitionRejected({
        runId: run.id,
        previousStatus: previous,
        nextStatus: status,
        reason: error instanceof Error ? error.message : String(error),
        sourceComponent: this.sourceComponent,
        causalParentEventId: requested.trace_event_id,
        taskId: options.taskId,
        artifactRefs: options.artifactRefs,
        trigger: options.trigger
      });
      throw error;
    }

    run.status = status;
    run.updated_at = new Date().toISOString();
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.artifactStore.recordRunTransition(record);
    await this.traceWriter.recordRunTransitionAccepted(record, {
      causalParentEventId: requested.trace_event_id
    });
    if (status === "blocked" || status === "failed") {
      await this.traceWriter.write({
        run_id: run.id,
        task_id: options.taskId,
        event_type: status === "blocked" ? "run_blocked" : "run_failed",
        lifecycle_stage: status,
        previous_status: previous,
        next_status: status,
        source_component: this.sourceComponent,
        severity: status === "blocked" ? "warning" : "error",
        reason: message,
        summary: message,
        artifact_refs: options.artifactRefs ?? [],
        metadata_json: {
          transition_record_id: record.id,
          trigger: record.trigger
        }
      });
    }
    await this.artifactStore.appendEvent(this.event(run.id, "run.status_changed", message, {
      previous_status: previous,
      next_status: status,
      canonical_previous_status: record.canonical_previous_status,
      canonical_next_status: record.canonical_next_status,
      transition_trigger: record.trigger,
      transition_id: record.id
    }, options.taskId));
  }

  async recordRunTransition(
    runId: string,
    previous: RunStatus | undefined,
    status: RunStatus,
    message: string,
    sourceComponent = this.sourceComponent
  ) {
    const requested = await this.traceWriter.recordRunTransitionRequested({
      runId,
      previousStatus: previous,
      nextStatus: status,
      reason: message,
      sourceComponent
    });
    const record = createRunTransition(runId, status, {
      currentStatus: previous,
      reason: message,
      sourceComponent
    });
    await this.artifactStore.recordRunTransition(record);
    await this.traceWriter.recordRunTransitionAccepted(record, {
      causalParentEventId: requested.trace_event_id
    });
  }

  async writeCheckpoint(run: Run, tasks: Task[], label: string, notes: string[], indexFreshness?: unknown) {
    const checkpoint: RunCheckpoint = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `checkpoint_${randomUUID()}`,
      run_id: run.id,
      label,
      created_at: new Date().toISOString(),
      run_status: run.status,
      task_graph_state: tasks,
      memory_snapshot_ref: run.memory_snapshot_ref,
      config: run.config,
      index_freshness: indexFreshness,
      notes
    };
    const ref = await this.artifactStore.saveCheckpoint(checkpoint);
    await this.artifactStore.appendEvent(this.event(run.id, "run.checkpoint_written", `Checkpoint written: ${label}.`, {
      checkpoint_ref: ref,
      task_count: tasks.length
    }));
    return ref;
  }

  async writeRunMetrics(run: Run, tasks: Task[], report: FinalRunReport): Promise<RunMetrics> {
    const events = await this.artifactStore.listRunEvents(run.id) as OrchestratorEvent[];
    const metrics = computeRunMetrics({ run, tasks, events, report });
    const ref = await this.artifactStore.saveRunMetrics(metrics);
    await this.artifactStore.appendEvent(this.event(run.id, "metrics.written", `Run metrics written: ${ref}`, {
      metrics_ref: ref,
      metrics
    }));
    return metrics;
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
    return {
      id: `event_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    };
  }
}
