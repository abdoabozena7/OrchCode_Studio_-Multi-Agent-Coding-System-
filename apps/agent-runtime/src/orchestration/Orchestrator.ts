import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentRuntimeSession } from "@hivo/protocol";
import { appendDecision, appendFailedAttempt, appendSuccessfulPattern, readJson, resolveMemoryPaths } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { SeniorCodingAgent } from "../agents/SeniorCodingAgent.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { AgentTeamManager } from "./AgentTeamManager.js";
import type { AgentTeamHierarchy } from "./AgentTeamModels.js";
import { TeamSubPlanner } from "./TeamSubPlanner.js";
import { TeamSubPlanAggregator } from "./TeamSubPlanAggregator.js";
import { TeamTaskAdoptionGate } from "./TeamTaskAdoptionGate.js";
import { ProposedTaskGraphManager } from "./ProposedTaskGraphManager.js";
import { ExecutionReadinessGate } from "./ExecutionReadinessGate.js";
import { ExecutionPreparationPlanner } from "./ExecutionPreparationPlanner.js";
import { OneWriterDryRunExecutor } from "./OneWriterDryRunExecutor.js";
import { PatchProposalReviewGate } from "./PatchProposalReviewGate.js";
import { ValidationCandidateGate } from "./ValidationCandidateGate.js";
import { PatchApplySandboxManager } from "./PatchApplySandboxManager.js";
import { SandboxValidationRunner } from "./SandboxValidationRunner.js";
import { SandboxIntegrationCandidateGate } from "./SandboxIntegrationCandidateGate.js";
import { IntegrationApplyApprovalGate } from "./IntegrationApplyApprovalGate.js";
import { ControlledIntegrationApplyManager } from "./ControlledIntegrationApplyManager.js";
import { IntegrationFinalizationManager } from "./IntegrationFinalizationManager.js";
import { assessApprovalGate } from "./ApprovalGates.js";
import { ContextPackBuilder } from "./ContextPackBuilder.js";
import { FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { DurableLockManager } from "./DurableLockManager.js";
import { IntegrationManager } from "./IntegrationManager.js";
import type { IntegrationResult as FactoryIntegrationResult } from "./IntegrationModels.js";
import { MultiPlanFactory } from "./MultiPlanFactory.js";
import type { MergedPlan, MultiPlanFactoryResult, MultiPlanSummary } from "./MultiPlanModels.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentInvocation,
  type AgentRoleName,
  type ContextPack,
  type FinalRunReport,
  type OrchestratorEvent,
  type ParsedAgentOutput,
  type Run,
  type RunCheckpoint,
  type RunMetrics,
  type RunStatus,
  type Task
} from "./OrchestrationModels.js";
import {
  loadOrchestrationConfig,
  type OrchestrationSafetyConfig,
  type PartialOrchestrationSafetyConfig
} from "./OrchestrationConfig.js";
import { validatePatchProposalScope } from "./PatchSafety.js";
import {
  evaluatePromptQuality,
  isPromptQualityBlocking,
  promptQualityStatusToRunImpact,
  summarizePromptQuality
} from "./PromptQualityGate.js";
import { renderRolePrompt, rolePromptInputFromTask } from "./PromptSystem.js";
import { PromptWriterService } from "./PromptWriterService.js";
import { createRepairTask, PatchFingerprintTracker } from "./RepairLoop.js";
import { runReviewLoop } from "./ReviewLoop.js";
import { getAgentRole } from "./RoleRegistry.js";
import {
  codePatchProposalFromParsedOutput,
  repairStructuredOutput,
  scoutResultFromParsedOutput,
  taskDecompositionFromTasks,
  validateStructuredOutput,
  type CodePatchProposal,
  type VerificationResult
} from "./StructuredOutputs.js";
import { TaskGraphManager } from "./TaskGraphManager.js";
import { ValidationRunner } from "./ValidationRunner.js";
import { aggregateValidationStatus, normalizeValidationStatus, type OverallValidationStatus } from "./ValidationSemantics.js";
import { computeRunMetrics } from "./Metrics.js";
import { SwarmStaffingPlanner } from "./SwarmStaffingPlanner.js";
import {
  InvalidRunTransitionError,
  isResumeSafeRunStatus,
  normalizeRunStatus,
  transitionRun as createRunTransition,
  type RunTransitionTrigger
} from "./RunStateMachine.js";
import {
  assertValid,
  validateAgentInvocation,
  validateFinalRunReport,
  validateRun,
  validateTask
} from "./Validation.js";

export type AgenticRunOptions = {
  workspacePath: string;
  memoryDir?: string;
  maxContextFiles?: number;
  maxContextChars?: number;
  maxTaskAttempts?: number;
  config?: PartialOrchestrationSafetyConfig;
  onEvent?: (event: import("./OrchestrationModels.js").OrchestratorEvent) => void;
  providerFactory?: (role: string) => import("../llm/LlmProvider.js").LlmProvider;
};

export type AgenticRunResult = {
  run: Run;
  tasks: Task[];
  report: FinalRunReport;
};

export class CoreOrchestrator {
  private readonly workspacePath: string;
  private readonly memoryDir: string;
  private readonly maxContextFiles: number;
  private readonly maxContextChars: number;
  private readonly maxTaskAttempts: number;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly onEvent?: (event: import("./OrchestrationModels.js").OrchestratorEvent) => void;
  private readonly providerFactory?: (role: string) => import("../llm/LlmProvider.js").LlmProvider;

  constructor(options: AgenticRunOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.config = loadOrchestrationConfig({
      ...options.config,
      memory_path: options.memoryDir ?? options.config?.memory_path
    });
    this.memoryDir = options.memoryDir ?? this.config.memory_path;
    this.maxContextFiles = options.maxContextFiles ?? 6;
    this.maxContextChars = options.maxContextChars ?? this.config.max_context_size;
    this.maxTaskAttempts = options.maxTaskAttempts ?? this.config.max_attempts_per_task;
    this.artifactStore = new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "CoreOrchestrator" });
    this.onEvent = options.onEvent;
    this.providerFactory = options.providerFactory;
  }

  async planOnly(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.createRun(userRequest);
    await this.writeCheckpoint(run, [], "created", ["Plan-only run created."]);
    await this.transitionRun(run, "intake", "Plan-only intake started.", { mode: "plan_only" });
    await this.transitionRun(run, "prompt_rewrite", "Prompt rewrite is not implemented in this step; using the request as provided.", { mode: "plan_only" });
    await this.transitionRun(run, "clarification_check", "No clarification was required for plan-only orchestration.", { mode: "plan_only" });
    await this.transitionRun(run, "repo_mapping", "Loading repository memory for planning.", { mode: "plan_only" });
    const memory = await this.loadOrRebuildIndex(run);
    await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded for plan-only mode."]);
    await this.transitionRun(run, "complexity_estimation", "Estimated complexity from repository memory and command inventory.", { mode: "plan_only" });
    await this.transitionRun(run, "planning", "Creating deterministic task graph.");
    const multiPlan = await this.createMultiPlanIfNeeded(run, memory.repoIndex, memory.commandInventory, true);
    const manager = await this.createTaskGraph(run, memory.repoIndex, memory.commandInventory, multiPlan.merged_plan);
    run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
    run.summary = `Planned ${manager.listTasks().length} task(s) for: ${userRequest}`;
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    const teamHierarchy = await this.createAgentTeamsIfNeeded(run, multiPlan, manager.listTasks(), true);
    await this.transitionRun(run, "task_graph_ready", "Plan-only task graph is ready.", { mode: "plan_only" });
    const integration = await this.integrationManager().integrate({
      run,
      tasks: manager.listTasks(),
      parsedOutputs: [],
      mode: "plan_only",
      commandInventory: memory.commandInventory
    });
    await this.transitionRun(run, "reporting", "Writing plan-only final report.", { mode: "plan_only" });
    await this.transitionRun(run, "succeeded", "Plan-only run completed after task graph creation.", { mode: "plan_only" });
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "report_started",
      lifecycle_stage: "reporting",
      summary: "Plan-only final report creation started.",
      metadata_json: { mode: "plan_only" }
    });
    const report = await this.createFinalReport(run, manager.listTasks(), [], [
      "Plan-only mode did not invoke agents.",
      "Validation commands were selected but not run.",
      ...multiPlanLimitations(multiPlan)
    ], multiPlan.summary, integration, teamHierarchy);
    await this.writeCheckpoint(run, manager.listTasks(), "planned", ["Task graph persisted in plan-only mode."]);
    await this.writeRunMetrics(run, manager.listTasks(), report);
    return { run, tasks: manager.listTasks(), report };
  }

  async runAgenticTask(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.createRun(userRequest);
    let manager: TaskGraphManager | undefined;
    const parsedOutputs: ParsedAgentOutput[] = [];
    const fingerprintTracker = new PatchFingerprintTracker();
    const lockManager = new DurableLockManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      ttlMs: this.config.lock_ttl_ms,
      ownerComponent: "CoreOrchestrator"
    });
    try {
      await this.writeCheckpoint(run, [], "created", ["Run created."]);
      await this.transitionRun(run, "intake", "Run intake started.");
      await this.transitionRun(run, "prompt_rewrite", "Prompt rewrite is not implemented in this step; using the request as provided.");
      await this.transitionRun(run, "clarification_check", "No clarification was required for this orchestration run.");
      await this.transitionRun(run, "repo_mapping", "Loading or rebuilding repository index.");
      const memory = await this.loadOrRebuildIndex(run);
      await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded."]);
      await this.transitionRun(run, "complexity_estimation", "Estimated run complexity from repository memory and command inventory.");
      await this.transitionRun(run, "planning", "Creating orchestration task graph.");
      const multiPlan = await this.createMultiPlanIfNeeded(run, memory.repoIndex, memory.commandInventory, false);
      manager = await this.createTaskGraph(run, memory.repoIndex, memory.commandInventory, multiPlan.merged_plan);
      run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
      const teamHierarchy = await this.createAgentTeamsIfNeeded(run, multiPlan, manager.listTasks(), false);
      await this.transitionRun(run, "task_graph_ready", "Task graph created and persisted.");
      await this.writeCheckpoint(run, manager.listTasks(), "planned", ["Task graph created."]);

      await this.transitionRun(run, "executing", "Executing ready tasks through role invocations.");
      while (manager.listTasks().some((task) => !["succeeded", "failed", "skipped"].includes(task.status))) {
        const ready = manager.getReadyTasks();
        if (!ready.length) {
          for (const task of manager.listTasks().filter((candidate) => candidate.status === "pending")) {
            await manager.markStatus(task.id, "blocked", "No dependency path is available.");
          }
          break;
        }
        for (const task of ready) {
          await manager.markStatus(task.id, "ready", "Task is dependency-ready.");
          const lockScopes = taskEditLockScopes(task);
          const semanticScopes = lockScopes.length
            ? [...lockManager.deriveModuleLocksForTask(task), ...lockManager.deriveSemanticLocksForTask(task)]
            : [];
          const lockResult = lockScopes.length ? await lockManager.acquireLocks({
            request_id: `lock_request_${randomUUID()}`,
            run_id: run.id,
            task_id: task.id,
            owner_component: "CoreOrchestrator",
            scopes: [
              ...lockScopes.map((scope) => lockManager.normalizeLockScope(scope, "write")),
              ...semanticScopes
            ],
            ttl_ms: this.config.lock_ttl_ms,
            reason: `Acquire durable locks before invoking ${task.role_required}.`,
            metadata_json: {
              role_required: task.role_required,
              allowed_files_to_edit: task.allowed_files_to_edit
            }
          }) : undefined;
          if (lockResult && !lockResult.acquired) {
            await this.artifactStore.appendEvent(this.event(run.id, "lock.conflict", `Task ${task.id} is blocked by active file locks.`, {
              requested_paths: lockResult.requested_paths,
              conflicts: lockResult.conflicts
            }, task.id));
            await manager.markStatus(task.id, "blocked", "Task is blocked by active file locks.");
            continue;
          }
          if (lockResult?.locks.length) {
            const lockRef = await this.artifactStore.saveLockSnapshot(run.id, `${task.id}_acquired`, lockResult.locks);
            task.artifacts.push(lockRef);
            task.artifacts.push(...lockResult.artifact_refs);
            await this.artifactStore.appendEvent(this.event(run.id, "lock.acquired", `Acquired ${lockResult.locks.length} file lock(s) for ${task.id}.`, {
              locks: lockResult.locks,
              lock_ref: lockRef
            }, task.id));
          }
          try {
            await manager.markStatus(task.id, "running", `Invoking ${task.role_required}.`);
            const rawOutput = await this.invokeRole(run, task);
            const output = await this.applySafetyAndVerificationGates({
              run,
              task,
              output: rawOutput,
              commandInventory: memory.commandInventory,
              manager,
              fingerprintTracker
            });
            parsedOutputs.push(output);
            task.result_summary = output.summary;
            task.artifacts.push(...output.artifacts);
            if (output.status === "succeeded") {
              await manager.markStatus(task.id, "succeeded", output.summary);
            } else if (output.status === "blocked") {
              await manager.markStatus(task.id, "blocked", output.summary);
            } else {
              await manager.markStatus(task.id, "failed", output.summary);
            }
            await this.writeCheckpoint(run, manager.listTasks(), `task_${task.id}`, [`Task ${task.id} ended with ${output.status}.`]);
          } finally {
            if (lockResult?.locks.length) {
              const released = await lockManager.releaseByTask(task.id);
              const lockRef = await this.artifactStore.saveLockSnapshot(run.id, `${task.id}_released`, released);
              task.artifacts.push(lockRef);
              await this.artifactStore.appendEvent(this.event(run.id, "lock.released", `Released ${released.length} file lock(s) for ${task.id}.`, {
                locks: released,
                lock_ref: lockRef
              }, task.id));
            }
          }
        }
      }

      await this.transitionRun(run, "reviewing", "Review gates completed for executor outputs.");
      const validationStatus = summarizeValidationStatus(parsedOutputs);
      await this.transitionRun(run, "validating", "Validation runner completed safe command execution where available.", { validationStatus });
      await this.transitionRun(run, "integrating", "Integrating completed task artifacts into final report.");
      const integration = await this.integrationManager(lockManager).integrate({
        run,
        tasks: manager.listTasks(),
        parsedOutputs,
        mode: "normal",
        commandInventory: memory.commandInventory
      });
      const failedTasks = manager.listTasks().filter((task) => task.status === "failed" || task.status === "blocked");
      const finalStatus = finalRunStatus(manager.listTasks(), parsedOutputs, integration);
      await this.transitionRun(run, "memory_update", "Recording durable memory handoff for completed run artifacts.");
      await this.transitionRun(run, "reporting", "Writing final run report.");
      await this.transitionRun(run, finalStatus, finalStatus === "failed"
        ? "One or more tasks failed."
        : finalStatus === "blocked"
          ? "One or more required tasks or validations are blocked."
          : "Orchestration run succeeded.");
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "report_started",
        lifecycle_stage: "reporting",
        summary: "Final run report creation started."
      });
      const report = await this.createFinalReport(run, manager.listTasks(), parsedOutputs, [
        ...(failedTasks.length ? ["Some tasks did not complete successfully."] : []),
        ...integrationLimitations(integration),
        ...multiPlanLimitations(multiPlan)
      ], multiPlan.summary, integration, teamHierarchy);
      run.summary = report.next_recommendations[0] ?? "Run completed.";
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
      await this.writeCheckpoint(run, manager.listTasks(), "final", [`Run completed with status ${run.status}.`]);
      const metrics = await this.writeRunMetrics(run, manager.listTasks(), report);
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "memory_append_started",
        lifecycle_stage: "memory_update",
        summary: "Durable memory append started.",
        artifact_refs: [report.artifacts_path],
        metadata_json: { final_status: run.status }
      });
      await appendDecision(this.workspacePath, {
        agent: "CoreOrchestrator",
        summary: `Phase 4 run ${run.id} completed with status ${run.status}.`,
        rationale: report.limitations.join(" ") || "Safety-gated vertical slice completed.",
        relatedFiles: report.files_changed,
        tags: ["phase-4", "orchestration-run", "safety-gates", this.config.execution_mode]
      }, this.memoryDir);
      if (run.status === "succeeded") {
        await appendSuccessfulPattern(this.workspacePath, {
          summary: `Run ${run.id} succeeded in ${this.config.execution_mode} mode.`,
          relatedRunIds: [run.id],
          relatedFiles: report.files_changed,
          tags: ["orchestration-run", this.config.execution_mode]
        }, this.memoryDir);
      } else {
        await appendFailedAttempt(this.workspacePath, {
          summary: `Run ${run.id} finished with status ${run.status}.`,
          relatedRunId: run.id,
          evidence: [report.artifacts_path],
          nextAvoidance: report.next_recommendations[0]
        }, this.memoryDir);
      }
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "memory_append_completed",
        lifecycle_stage: "memory_update",
        summary: "Durable memory append completed.",
        artifact_refs: [report.artifacts_path],
        metadata_json: { final_status: run.status }
      });
      await this.artifactStore.appendEvent(this.event(run.id, "run.completed", `Run completed with integration status ${integration.status}.`, {
        integration,
        metrics
      }));
      return { run, tasks: manager.listTasks(), report };
    } catch (error) {
      run.summary = error instanceof Error ? error.message : String(error);
      await this.transitionRun(run, error instanceof InvalidRunTransitionError ? "blocked" : "failed", run.summary, {
        trigger: "failure_handling"
      });
      await this.artifactStore.appendEvent(this.event(run.id, "run.failed", run.summary));
      const report = await this.createFinalReport(run, manager?.listTasks() ?? [], parsedOutputs, [run.summary]);
      await this.writeCheckpoint(run, manager?.listTasks() ?? [], "failed", [run.summary ?? "Run failed."]);
      await this.writeRunMetrics(run, manager?.listTasks() ?? [], report);
      return { run, tasks: manager?.listTasks() ?? [], report };
    }
  }

  async resumeRun(runId: string): Promise<AgenticRunResult> {
    const run = await this.artifactStore.loadRun(runId);
    const tasks = await this.artifactStore.loadTasks(runId);
    const reconciliation = await this.reconcileRunForResume(run);
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    await this.artifactStore.appendEvent(this.event(run.id, "run.resumed", `Resume requested for run ${run.id}.`, {
      index_freshness: freshness.status,
      reconciliation
    }));
    if (!reconciliation.ok) {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "run_resume_mismatch_detected",
        lifecycle_stage: "blocked",
        source_component: "CoreOrchestrator",
        severity: reconciliation.severity === "failed" ? "error" : "warning",
        reason: reconciliation.reason,
        summary: reconciliation.reason,
        artifact_refs: [run.artifacts_path],
        metadata_json: {
          severity: reconciliation.severity ?? "blocked"
        }
      });
      run.summary = reconciliation.reason;
      await this.transitionRun(run, reconciliation.severity === "failed" ? "failed" : "blocked", reconciliation.reason, {
        trigger: "resume"
      });
    }
    if (freshness.status !== "fresh") {
      await this.artifactStore.appendEvent(this.event(run.id, "index.stale", "Repository changed since the saved run checkpoint.", {
        changed_files: freshness.changedFiles,
        new_files: freshness.newFiles,
        deleted_files: freshness.deletedFiles
      }));
    }
    await this.writeCheckpoint(run, tasks, "resume_requested", [
      reconciliation.ok
        ? "SQLite run state and factory metadata agree for resume inspection."
        : reconciliation.reason,
      ["succeeded", "failed", "cancelled"].includes(run.status)
        ? "Run is terminal; resume is a safe no-op."
        : "Run is non-terminal; Phase 4 requires operator reconciliation before continuing in-flight work."
    ], freshness);
    let report: FinalRunReport;
    try {
      report = await this.artifactStore.loadFinalReport(run.id);
    } catch {
      report = await this.createFinalReport(run, tasks, [], [
        "Resume inspection could not find a prior final report.",
        freshness.status !== "fresh" ? "Repository index is stale relative to saved run state." : ""
      ].filter(Boolean));
    }
    await this.writeRunMetrics(run, tasks, report);
    return { run, tasks, report };
  }

  private async reconcileRunForResume(run: Run): Promise<{ ok: boolean; reason: string; severity?: "blocked" | "failed" }> {
    const paths = await this.artifactStore.pathsForRun(run.id);
    const metadataPath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(metadataPath)) {
      return { ok: false, reason: `Factory metadata database is missing: ${metadataPath}`, severity: "blocked" };
    }
    const metadata = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
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

  private async createRun(userRequest: string): Promise<Run> {
    const runId = `run_${randomUUID()}`;
    const paths = await this.artifactStore.ensureRunLayout(runId);
    const now = new Date().toISOString();
    const run: Run = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: runId,
      user_request: userRequest,
      status: "created",
      created_at: now,
      updated_at: now,
      root_task_ids: [],
      memory_snapshot_ref: "pending",
      config: {
        workspace_path: this.workspacePath,
        memory_dir: this.memoryDir,
        enable_internal_swarm_autopilot: this.config.enable_internal_swarm_autopilot,
        max_supported_logical_agents: this.config.max_supported_logical_agents,
        max_swarm_parallel_agents: this.config.max_swarm_parallel_agents,
        max_swarm_executors: this.config.max_swarm_executors,
        max_context_files: this.maxContextFiles,
        max_context_chars: this.maxContextChars,
        max_task_attempts: this.maxTaskAttempts,
        provider_mode: "real_provider",
        execution_mode: this.config.execution_mode,
        max_tasks_per_run: this.config.max_tasks_per_run,
        max_parallel_tasks: this.config.max_parallel_tasks,
        max_repair_rounds: this.config.max_repair_rounds,
        max_files_per_task: this.config.max_files_per_task,
        max_validation_log_size: this.config.max_validation_log_size,
        max_patch_bytes: this.config.max_patch_bytes,
        lock_ttl_ms: this.config.lock_ttl_ms,
        enable_multi_perspective_review: this.config.enable_multi_perspective_review,
        enable_multi_plan_factory: this.config.enable_multi_plan_factory,
        enable_parallel_execution: this.config.enable_parallel_execution,
        validation_level: this.config.validation_level,
        require_human_approval_for_risky_files: this.config.require_human_approval_for_risky_files,
        validation_timeout: this.config.validation_timeout,
        safe_commands_allowlist: this.config.safe_commands_allowlist,
        swarm_worker_mode: this.config.swarm_worker_mode,
        use_planning_evidence: this.config.use_planning_evidence,
        planning_evidence_mode: this.config.planning_evidence_mode,
        max_evidence_items: this.config.max_evidence_items,
        min_evidence_confidence: this.config.min_evidence_confidence,
        allow_mock_evidence: this.config.allow_mock_evidence,
        prompt_writer_mode: this.config.prompt_writer_mode,
        prompt_writer_provider_mode: this.config.prompt_writer_provider_mode,
        enable_team_sub_planning: this.config.enable_team_sub_planning,
        team_sub_planning_mode: this.config.team_sub_planning_mode,
        max_team_sub_plans_per_run: this.config.max_team_sub_plans_per_run,
        max_team_sub_plan_tasks: this.config.max_team_sub_plan_tasks,
        max_team_sub_plan_depth: this.config.max_team_sub_plan_depth,
        allow_provider_team_sub_planning: this.config.allow_provider_team_sub_planning,
        enable_team_task_adoption: this.config.enable_team_task_adoption,
        team_task_adoption_mode: this.config.team_task_adoption_mode,
        max_adopted_tasks_per_run: this.config.max_adopted_tasks_per_run,
        max_adopted_tasks_per_team: this.config.max_adopted_tasks_per_team,
        allow_write_task_future_candidates: this.config.allow_write_task_future_candidates,
        allow_executable_adoption: this.config.allow_executable_adoption,
        enable_proposed_task_graph: this.config.enable_proposed_task_graph,
        proposed_task_graph_mode: this.config.proposed_task_graph_mode,
        max_proposed_nodes_per_run: this.config.max_proposed_nodes_per_run,
        max_proposed_edges_per_run: this.config.max_proposed_edges_per_run,
        block_cycles: this.config.block_cycles,
        dedupe_proposed_nodes: this.config.dedupe_proposed_nodes,
        execution_readiness_gate_enabled: this.config.execution_readiness_gate_enabled,
        execution_readiness_mode: this.config.execution_readiness_mode,
        allow_read_only_promotion_candidates: this.config.allow_read_only_promotion_candidates,
        allow_write_future_candidates: this.config.allow_write_future_candidates,
        require_human_approval_for_write: this.config.require_human_approval_for_write,
        allow_auto_approval_for_low_risk_read_only: this.config.allow_auto_approval_for_low_risk_read_only,
        max_nodes_evaluated_per_run: this.config.max_nodes_evaluated_per_run,
        enable_execution_promotion_queue: this.config.enable_execution_promotion_queue,
        promotion_queue_mode: this.config.promotion_queue_mode,
        allow_read_only_queue_without_human_approval: this.config.allow_read_only_queue_without_human_approval,
        approval_default_ttl_hours: this.config.approval_default_ttl_hours,
        allow_test_fixture_approvals: this.config.allow_test_fixture_approvals,
        track_blocked_promotion_requests: this.config.track_blocked_promotion_requests,
        enable_execution_preparation: this.config.enable_execution_preparation,
        execution_preparation_mode: this.config.execution_preparation_mode,
        max_preparation_plans_per_run: this.config.max_preparation_plans_per_run,
        require_human_approval_for_write_preparation: this.config.require_human_approval_for_write_preparation,
        allow_read_only_preparation_without_human_approval: this.config.allow_read_only_preparation_without_human_approval,
        block_on_stale_context: this.config.block_on_stale_context,
        block_on_prompt_quality_warning_for_write: this.config.block_on_prompt_quality_warning_for_write,
        enable_one_writer_dry_run: this.config.enable_one_writer_dry_run,
        one_writer_dry_run_mode: this.config.one_writer_dry_run_mode,
        enable_patch_proposal_review_gate: this.config.enable_patch_proposal_review_gate,
        patch_proposal_review_mode: this.config.patch_proposal_review_mode,
        enable_validation_candidate_gate: this.config.enable_validation_candidate_gate,
        validation_candidate_mode: this.config.validation_candidate_mode,
        enable_patch_apply_sandbox: this.config.enable_patch_apply_sandbox,
        patch_apply_sandbox_mode: this.config.patch_apply_sandbox_mode,
        enable_sandbox_validation: this.config.enable_sandbox_validation,
        sandbox_validation_mode: this.config.sandbox_validation_mode,
        enable_sandbox_integration_candidates: this.config.enable_sandbox_integration_candidates,
        sandbox_integration_candidate_mode: this.config.sandbox_integration_candidate_mode,
        enable_integration_apply_approval_gate: this.config.enable_integration_apply_approval_gate,
        integration_apply_approval_mode: this.config.integration_apply_approval_mode,
        enable_controlled_integration_apply: this.config.enable_controlled_integration_apply,
        controlled_apply_mode: this.config.controlled_apply_mode,
        enable_integration_finalization: this.config.enable_integration_finalization,
        integration_finalization_mode: this.config.integration_finalization_mode
      },
      artifacts_path: paths.runDir
    };
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.recordRunTransition(run.id, undefined, "created", "Run created.", "CoreOrchestrator");
    await this.artifactStore.appendEvent(this.event(run.id, "run.created", `Run created for request: ${userRequest}`));
    return run;
  }

  private async loadOrRebuildIndex(run: Run) {
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    if (freshness.status !== "fresh") {
      await this.artifactStore.appendEvent(this.event(run.id, "index.stale", `Repository index freshness before rebuild: ${freshness.status}.`, {
        changed_files: freshness.changedFiles,
        new_files: freshness.newFiles,
        deleted_files: freshness.deletedFiles,
        warnings: freshness.warnings
      }));
    }
    const snapshot = await rebuildRepoIndex(this.workspacePath, { memoryDir: this.memoryDir });
    run.memory_snapshot_ref = "sqlite:factory_memory_snapshots/repo_index";
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.artifactStore.appendEvent(this.event(run.id, "repo.indexed", `Indexed ${snapshot.repoIndex.totals.indexedFiles} file(s).`, {
      indexed_files: snapshot.repoIndex.totals.indexedFiles,
      commands: snapshot.commandInventory.commands.length
    }));
    return {
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    };
  }

  private async createMultiPlanIfNeeded(
    run: Run,
    repoIndex: RepoIndex,
    commandInventory: CommandInventory,
    planOnly: boolean
  ): Promise<MultiPlanFactoryResult> {
    const relevantFiles = chooseHighSignalFiles(run.user_request, repoIndex);
    const staffingPlan = new SwarmStaffingPlanner().createPlan({
      swarmRunId: `planning_${run.id}`,
      userGoal: run.user_request,
      mode: this.config.execution_mode === "exhaustive" ? "exhaustive" : this.config.execution_mode === "fast" ? "fast" : "deep",
      repoIndex,
      commandInventory,
      relevantFiles
    });
    return new MultiPlanFactory(this.workspacePath, this.memoryDir).create({
      run,
      rawUserRequest: run.user_request,
      taskObjective: run.user_request,
      repoIndex,
      commandInventory,
      staffingPlan,
      config: this.config,
      planOnly
    });
  }

  private async createTaskGraph(run: Run, repoIndex: RepoIndex, commandInventory: CommandInventory, mergedPlan?: MergedPlan) {
    const manager = new TaskGraphManager(run.id, this.workspacePath, this.artifactStore, this.memoryDir);
    const validationCommands = [
      ...commandInventory.byKind.test.slice(0, 1),
      ...commandInventory.byKind.typecheck.slice(0, 1),
      ...commandInventory.byKind.build.slice(0, 1)
    ].slice(0, 2);
    const forbiddenFiles = [
      ".env",
      "node_modules/",
      "dist/",
      "build/",
      "target/",
      ".git/",
      ".agent_memory/"
    ];
    const highSignalFiles = chooseHighSignalFiles(run.user_request, repoIndex);
    const scout = manager.createTask({
      id: `task_scout_${shortId()}`,
      run_id: run.id,
      title: "Scout repository evidence",
      objective: `Find relevant files, symbols, commands, and patterns for: ${run.user_request}`,
      role_required: "ScoutAgent",
      dependencies: [],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: mergedPlan
        ? `Use Phase 1 repo memory and snippets. Read-only. Advisory merged plan artifact: ${mergedPlan.artifact_ref}.`
        : "Use Phase 1 repo memory and snippets. Read-only.",
      expected_output_schema: getAgentRole("ScoutAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: this.maxTaskAttempts
    });
    const planner = manager.createTask({
      id: `task_planner_${shortId()}`,
      run_id: run.id,
      parent_id: scout.id,
      title: "Create narrow execution plan",
      objective: `Break the request into explicit, scoped work for: ${run.user_request}`,
      role_required: "PlannerAgent",
      dependencies: [scout.id],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: mergedPlan
        ? `Use Scout output, repo memory, command inventory, and advisory merged plan ${mergedPlan.merged_plan_id}. Read-only; do not create new executor autonomy from this artifact.`
        : "Use Scout output, repo memory, and command inventory. Read-only.",
      expected_output_schema: getAgentRole("PlannerAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: this.maxTaskAttempts
    });
    const executorObjectives = splitExecutorObjectives(run.user_request);
    const executorTasks = executorObjectives.map((objective, index) => manager.createTask({
      id: `task_executor_${index + 1}_${shortId()}`,
      run_id: run.id,
      parent_id: planner.id,
      title: executorObjectives.length > 1 ? `Execute narrow task ${index + 1}` : "Execute first narrow task",
      objective,
      role_required: "ExecutorAgent",
      dependencies: [planner.id],
      relevant_files: highSignalFiles,
      allowed_files_to_edit: inferAllowedEditScope(objective, highSignalFiles),
      forbidden_files: forbiddenFiles,
      input_context: mergedPlan
        ? `Use existing SeniorCodingAgent path. Do not write files directly. Merged plan is advisory only: ${mergedPlan.artifact_ref}.`
        : "Use existing SeniorCodingAgent path. Do not write files directly.",
      expected_output_schema: getAgentRole("ExecutorAgent").expected_output_schema,
      validation_commands: validationCommands,
      max_attempts: this.maxTaskAttempts
    }));
    manager.createTask({
      id: `task_reporter_${shortId()}`,
      run_id: run.id,
      parent_id: planner.id,
      title: "Produce final run report",
      objective: `Summarize Phase 4 orchestration artifacts for: ${run.user_request}`,
      role_required: "ReporterAgent",
      dependencies: executorTasks.map((task) => task.id),
      relevant_files: [],
      allowed_files_to_edit: [],
      forbidden_files: forbiddenFiles,
      input_context: "Use persisted run artifacts only. Read-only.",
      expected_output_schema: getAgentRole("ReporterAgent").expected_output_schema,
      validation_commands: [],
      max_attempts: 1
    });
    for (const task of manager.listTasks()) assertValid("Task", task, validateTask);
    await manager.recordCreatedEvents();
    const decomposition = taskDecompositionFromTasks(manager.listTasks());
    const decompositionValidation = validateStructuredOutput("TaskDecompositionResult", decomposition);
    if (!decompositionValidation.valid) {
      throw new Error(`TaskDecompositionResult validation failed: ${decompositionValidation.errors.join("; ")}`);
    }
    const decompositionRef = await this.artifactStore.saveParsedOutput(run.id, "task_decomposition", decomposition);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_parsed", "Validated task decomposition result.", {
      schema: "TaskDecompositionResult",
      parsed_output_ref: decompositionRef
    }));
    return manager;
  }

  private async invokeRole(run: Run, task: Task): Promise<ParsedAgentOutput> {
    const role = getAgentRole(task.role_required);
    const contextBuilder = new ContextPackBuilder(this.workspacePath, {
      memoryDir: this.memoryDir,
      maxFiles: this.maxContextFiles,
      maxChars: this.maxContextChars
    });
    const teamId = await this.teamIdForTask(run.id, task.id);
    const pack = await contextBuilder.build(run.id, task, teamId ? { team_id: teamId } : {});
    const packPath = await this.artifactStore.saveContextPack(pack);
    task.artifacts.push(packPath);
    await this.artifactStore.appendEvent(this.event(run.id, "context_pack.created", `Context pack created for ${task.id}.`, {
      context_pack: packPath,
      approximate_size: pack.approximate_size,
      relevant_files: pack.relevant_files
    }, task.id));
    const rolePromptInput = rolePromptInputFromTask({
      runId: run.id,
      task,
      pack,
      contextPackRef: packPath,
      sourceComponent: "CoreOrchestrator"
    });
    const promptResult = renderRolePrompt(rolePromptInput);
    if (!promptResult.ok) {
      await this.artifactStore.recordPromptRenderFailure(promptResult.error, {
        runId: run.id,
        taskId: task.id,
        contextPackRef: packPath
      });
      throw new Error(promptResult.error.message);
    }
    const promptMetadata = await this.artifactStore.savePromptArtifact(promptResult.rendered);
    const promptWriter = await new PromptWriterService({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      providerFactory: this.providerFactory
    }).run({
      runId: run.id,
      task,
      pack,
      contextPackRef: packPath,
      originalTemplateInput: rolePromptInput,
      targetPromptType: promptResult.template.prompt_type,
      templateId: promptResult.template.template_id,
      templateVersion: promptResult.template.version,
      originalPromptId: promptMetadata.prompt_id,
      originalPromptArtifactRef: promptMetadata.artifact_ref
    });
    const promptQuality = evaluatePromptQuality(promptResult.rendered, {
      task,
      contextPack: pack,
      contextPackRef: packPath,
      promptArtifactRef: promptMetadata.artifact_ref,
      promptMetadata,
      expectedOutputSchema: task.expected_output_schema,
      allowedFiles: task.allowed_files_to_edit,
      forbiddenFiles: task.forbidden_files,
      validationRequirements: pack.validation_requirements,
      successCriteria: [task.objective, task.expected_output_schema],
      stopConditions: ["Do not claim validation that was not run."],
      artifactRefs: task.artifacts
    });
    const promptQualityRef = await this.artifactStore.savePromptQualityResult(promptQuality);
    task.artifacts.push(promptMetadata.artifact_ref, promptQualityRef);
    if (promptWriter) {
      task.artifacts.push(...Object.values(promptWriter.artifact_refs).filter((ref): ref is string => typeof ref === "string"));
    }
    if (isPromptQualityBlocking(promptQuality)) {
      const impact = promptQualityStatusToRunImpact(promptQuality);
      return {
        summary: summarizePromptQuality(promptQuality),
        status: impact === "failed" ? "failed" : "blocked",
        files_changed: [],
        validation_results: [],
        artifacts: [promptMetadata.artifact_ref, promptQualityRef],
        limitations: promptQuality.findings
          .filter((finding) => finding.severity === "blocked" || finding.severity === "failed")
          .map((finding) => finding.message),
        next_recommendations: promptQuality.suggested_remediation.length
          ? promptQuality.suggested_remediation
          : ["Inspect the prompt quality artifact before retrying invocation."]
      };
    }
    let activePromptMetadata = promptMetadata;
    let activePromptText = promptResult.rendered.text;
    if (promptWriter?.adoption_decision.adopted && promptWriter.candidate_rendered_prompt) {
      activePromptMetadata = await this.artifactStore.savePromptArtifact(promptWriter.candidate_rendered_prompt);
      activePromptText = promptWriter.candidate_rendered_prompt.text;
      task.artifacts.push(activePromptMetadata.artifact_ref);
    }
    const invocation: AgentInvocation = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `invocation_${randomUUID()}`,
      run_id: run.id,
      task_id: task.id,
      role: role.name,
      prompt: activePromptText,
      context_pack_ref: packPath,
      started_at: new Date().toISOString(),
      status: "running",
      prompt_metadata: {
        prompt_id: activePromptMetadata.prompt_id,
        prompt_type: activePromptMetadata.prompt_type,
        template_id: activePromptMetadata.template_id,
        template_version: activePromptMetadata.template_version,
        renderer_version: activePromptMetadata.renderer_version,
        template_input_schema_version: activePromptMetadata.template_input_schema_version,
        input_hash: activePromptMetadata.input_hash,
        rendered_prompt_hash: activePromptMetadata.rendered_prompt_hash,
        context_pack_ref: activePromptMetadata.context_pack_ref,
        output_schema_name: activePromptMetadata.output_schema_name,
        prompt_artifact_ref: activePromptMetadata.artifact_ref,
        source_component: activePromptMetadata.source_component
      }
    };
    assertValid("AgentInvocation", invocation, validateAgentInvocation);
    await this.artifactStore.saveInvocation(invocation);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_started", `${role.name} started ${task.id}.`, {
      invocation_id: invocation.id
    }, task.id));

    try {
      const output = role.name === "ExecutorAgent"
        ? await this.invokeExecutor(run, task, pack, invocation)
        : await this.shouldInvokeProviderReadOnlyRole(task)
          ? await this.invokeProviderReadOnlyRole(run, task, pack, invocation)
          : await this.invokeDeterministicRole(run, task, pack, invocation);
      invocation.finished_at = new Date().toISOString();
      invocation.status = output.status === "succeeded" ? "succeeded" : "failed";
      invocation.parsed_output_ref = await this.artifactStore.saveParsedOutput(run.id, invocation.id, output);
      await this.artifactStore.saveInvocation(assertValid("AgentInvocation", invocation, validateAgentInvocation));
      await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_finished", `${role.name} finished ${task.id}: ${output.status}.`, {
        invocation_id: invocation.id,
        parsed_output_ref: invocation.parsed_output_ref
      }, task.id));
      return output;
    } catch (error) {
      invocation.finished_at = new Date().toISOString();
      invocation.status = "failed";
      invocation.error = error instanceof Error ? error.message : String(error);
      invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, { error: invocation.error });
      await this.artifactStore.saveInvocation(invocation);
      await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_finished", `${role.name} failed ${task.id}: ${invocation.error}`, {
        invocation_id: invocation.id
      }, task.id));
      return {
        summary: invocation.error,
        status: "failed",
        files_changed: [],
        validation_results: [],
        artifacts: [invocation.raw_output_ref],
        limitations: [invocation.error],
        next_recommendations: ["Inspect the failed invocation artifact."]
      };
    }
  }

  private async invokeExecutor(run: Run, task: Task, pack: ContextPack, invocation: AgentInvocation): Promise<ParsedAgentOutput> {
    const storageDir = path.join(run.artifacts_path, "runtime_session");
    const sessionManager = new SessionManager(storageDir, new EventBus(), { runtimeEventLoader: async () => [] });
    await sessionManager.load();
    const provider = this.providerFactory ? this.providerFactory(task.role_required) : undefined;
    if (!provider) throw new Error(`provider_required_for_executor:${task.role_required}`);
    const session = await sessionManager.createSession({
      workspacePath: this.workspacePath,
      mode: "real_provider",
      executionMode: "simple_mode",
      userPrompt: invocation.prompt,
      accessProfile: "default_permissions",
      activeProviderSource: "session_override"
    });
    const seniorAgent = new SeniorCodingAgent(provider, sessionManager);
    const completed = await seniorAgent.runTurn(session.id, invocation.prompt);
    invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, completed);
    return summarizeSeniorSession(completed, task, pack, invocation.raw_output_ref);
  }

  private async shouldInvokeProviderReadOnlyRole(task: Task) {
    if (task.allowed_files_to_edit.length > 0) return false;
    return true;
  }

  private async invokeProviderReadOnlyRole(run: Run, task: Task, pack: ContextPack, invocation: AgentInvocation): Promise<ParsedAgentOutput> {
    const provider = this.providerFactory?.(task.role_required);
    if (!provider) throw new Error(`provider_required_for_readonly_worker:${task.role_required}`);
    const generated = await invokeReasoningProviderStructured<unknown>(provider, {
      systemPrompt: [
        `You are ${task.role_required}, a read-only worker inside Hivo Studio's CoreOrchestrator.`,
        "Return only strict JSON matching this TypeScript shape:",
        "{ summary: string, status: 'succeeded' | 'failed' | 'blocked', files_changed: string[], validation_results: { command: string, status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'timed_out' | 'not_run', summary?: string }[], artifacts: string[], limitations: string[], next_recommendations: string[] }",
        "You may inspect and reason from the provided context only.",
        "Do not claim files were changed. Do not claim validation passed unless the context proves a command actually ran.",
        "If evidence is insufficient, set status to blocked or include the uncertainty in limitations."
      ].join("\n"),
      userPrompt: invocation.prompt,
      context: {
        run_id: run.id,
        task_id: task.id,
        role: task.role_required,
        objective: task.objective,
        expected_output_schema: task.expected_output_schema,
        relevant_files: pack.relevant_files,
        repo_index_refs: pack.repo_index_refs,
        validation_requirements: pack.validation_requirements,
        warnings: pack.warnings,
        context_pack_ref: invocation.context_pack_ref
      }
    }, { name: "parsed-agent-output" });
    const output = normalizeProviderReadOnlyOutput(generated);
    invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, {
      role: task.role_required,
      provider_backed: true,
      context_pack_ref: invocation.context_pack_ref,
      output: generated
    });
    output.artifacts.push(invocation.raw_output_ref);
    output.limitations = uniqueStrings([
      `Provider-backed read-only ${task.role_required} invocation used the configured provider; no deterministic role fallback was accepted.`,
      ...output.limitations
    ]);
    return output;
  }

  private async invokeDeterministicRole(run: Run, task: Task, pack: ContextPack, invocation: AgentInvocation): Promise<ParsedAgentOutput> {
    const output: ParsedAgentOutput = {
      summary: deterministicSummary(task.role_required, task, pack),
      status: "succeeded",
      files_changed: [],
      validation_results: pack.validation_requirements.map((command) => ({
        command,
        status: "not_run",
        summary: "Selected for downstream validation; Phase 4 runs only commands allowed by safety policy."
      })),
      artifacts: [],
      limitations: pack.warnings,
      next_recommendations: deterministicRecommendations(task.role_required, pack)
    };
    invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, {
      role: task.role_required,
      context_pack_ref: invocation.context_pack_ref,
      output
    });
    output.artifacts.push(invocation.raw_output_ref);
    return output;
  }

  private async applySafetyAndVerificationGates(input: {
    run: Run;
    task: Task;
    output: ParsedAgentOutput;
    commandInventory: CommandInventory;
    manager: TaskGraphManager;
    fingerprintTracker: PatchFingerprintTracker;
  }): Promise<ParsedAgentOutput> {
    const output = await this.validateParsedAgentOutput(input.run, input.task, input.output);
    await this.recordRoleSpecificStructuredOutput(input.run, input.task, output);
    if (input.task.role_required !== "ExecutorAgent" && input.task.role_required !== "IntegratorAgent") {
      return output;
    }

    const proposal = await this.validateCodePatchProposal(input.run, input.task, codePatchProposalFromParsedOutput(input.task.id, output));
    const safety = validatePatchProposalScope({
      workspacePath: this.workspacePath,
      task: input.task,
      proposal,
      config: this.config
    });
    const patchRef = await this.artifactStore.savePatchArtifact(input.run.id, `${input.task.id}_patch_safety`, {
      proposal,
      safety
    });
    output.artifacts.push(patchRef);
    await this.artifactStore.appendEvent(this.event(input.run.id, safety.accepted ? "patch.created" : "patch.rejected", safety.accepted ? "Patch safety manifest accepted." : "Patch safety manifest rejected.", {
      patch_ref: patchRef,
      changed_files: safety.changed_files,
      fingerprint: safety.fingerprint,
      reasons: safety.reasons
    }, input.task.id));

    await this.artifactStore.appendEvent(this.event(input.run.id, "review.started", `Review started for ${input.task.id}.`, {
      patch_ref: patchRef
    }, input.task.id));
    const review = runReviewLoop({
      task: input.task,
      proposal,
      safety,
      config: this.config
    });
    const reviewRef = await this.artifactStore.saveReviewArtifact(input.run.id, `${input.task.id}_review`, review);
    output.artifacts.push(reviewRef);
    await this.artifactStore.appendEvent(this.event(input.run.id, "review.completed", `Review completed with decision ${review.decision}.`, {
      review_ref: reviewRef,
      decision: review.decision,
      required_changes: review.required_changes,
      scope_violations: review.scope_violations
    }, input.task.id));

    if (review.decision !== "accept") {
      output.status = "failed";
      output.limitations.push(`Review decision: ${review.decision}. ${review.summary}`);
      output.next_recommendations.push("Create or inspect the repair task before integrating this output.");
      await this.maybeCreateRepairTask(input, {
        reason: review.summary,
        required_changes: review.required_changes,
        validation_logs: [],
        previous_patch_fingerprint: safety.fingerprint
      });
      return output;
    }

    const approvalGate = assessApprovalGate({
      task: input.task,
      proposal,
      config: this.config
    });
    if (approvalGate.required) {
      const approvalRef = await this.artifactStore.saveReviewArtifact(input.run.id, `${input.task.id}_approval_gate`, approvalGate);
      output.artifacts.push(approvalRef);
      output.status = "blocked";
      output.limitations.push(`Human approval required: ${approvalGate.reasons.join(" ")}`);
      output.next_recommendations.push("Approve or narrow the risky task scope before validation and integration.");
      await this.artifactStore.appendEvent(this.event(input.run.id, "approval.required", "Human approval gate triggered before validation.", {
        approval_ref: approvalRef,
        reasons: approvalGate.reasons,
        risky_files: approvalGate.risky_files
      }, input.task.id));
      return output;
    }

    if (!safety.changed_files.length) {
      output.next_recommendations.push("No file changes were proposed, so validation commands were recorded but not required for integration.");
      return output;
    }

    const verification = await new ValidationRunner(this.workspacePath, this.artifactStore, this.config).runForTask({
      runId: input.run.id,
      task: input.task,
      commandInventory: input.commandInventory,
      onEvent: async (event) => {
        await this.artifactStore.appendEvent(this.event(event.run_id, event.type, event.message, event.payload, event.task_id));
      }
    });
    mergeVerificationIntoOutput(output, verification);
    if (!verification.passed) {
      const validationStatus = verification.validation_status ? normalizeValidationStatus(verification.validation_status) : "failed";
      output.status = validationStatus === "failed" ? "failed" : "blocked";
      output.limitations.push(verification.summary);
      if (validationStatus !== "failed") {
        output.next_recommendations.push("Resolve blocked or incomplete validation before treating this task as complete.");
        return output;
      }
      const repeated = input.fingerprintTracker.recordFailedFingerprint(input.task.id, safety.fingerprint);
      if (repeated) {
        output.limitations.push(`Repeated failed patch fingerprint: ${safety.fingerprint}`);
      } else {
        await this.maybeCreateRepairTask(input, {
          reason: verification.summary,
          required_changes: [`Address failed validation commands: ${verification.failed_commands.join(", ")}`],
          validation_logs: verification.logs_refs,
          previous_patch_fingerprint: safety.fingerprint
        });
      }
    }
    return output;
  }

  private async validateParsedAgentOutput(run: Run, task: Task, output: ParsedAgentOutput): Promise<ParsedAgentOutput> {
    const validation = validateStructuredOutput("ParsedAgentOutput", output);
    if (validation.valid) {
      await this.artifactStore.appendEvent(this.event(run.id, "agent.output_parsed", `Parsed output validated for ${task.id}.`, {
        schema: "ParsedAgentOutput"
      }, task.id));
      return output;
    }
    const invalidRef = await this.artifactStore.saveRawOutput(run.id, `${task.id}_invalid_parsed_output`, {
      output,
      validation_errors: validation.errors
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_validation_failed", `Parsed output validation failed for ${task.id}.`, {
      raw_output_ref: invalidRef,
      validation_errors: validation.errors
    }, task.id));
    const repair = repairStructuredOutput<ParsedAgentOutput>("ParsedAgentOutput", output, validation.errors);
    const repairedRef = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_repaired_parsed_output`, {
      repair_prompt: repair.repair_prompt,
      repaired: repair.repaired,
      validation: repair.validation
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_repaired", `Parsed output repair ${repair.validation.valid ? "succeeded" : "failed"} for ${task.id}.`, {
      repaired_output_ref: repairedRef
    }, task.id));
    if (!repair.repaired) {
      return {
        summary: `Invalid parsed output: ${validation.errors.join("; ")}`,
        status: "failed",
        files_changed: [],
        validation_results: [],
        artifacts: [invalidRef, repairedRef],
        limitations: validation.errors,
        next_recommendations: ["Inspect raw and repaired output artifacts."]
      };
    }
    repair.repaired.artifacts.push(invalidRef, repairedRef);
    return repair.repaired;
  }

  private async validateCodePatchProposal(run: Run, task: Task, proposal: CodePatchProposal): Promise<CodePatchProposal> {
    const validation = validateStructuredOutput("CodePatchProposal", proposal);
    if (validation.valid) return proposal;
    const invalidRef = await this.artifactStore.saveRawOutput(run.id, `${task.id}_invalid_patch_proposal`, {
      proposal,
      validation_errors: validation.errors
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_validation_failed", `CodePatchProposal validation failed for ${task.id}.`, {
      raw_output_ref: invalidRef,
      validation_errors: validation.errors
    }, task.id));
    const repair = repairStructuredOutput<CodePatchProposal>("CodePatchProposal", proposal, validation.errors);
    const repairedRef = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_repaired_patch_proposal`, {
      repair_prompt: repair.repair_prompt,
      repaired: repair.repaired,
      validation: repair.validation
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_repaired", `CodePatchProposal repair ${repair.validation.valid ? "succeeded" : "failed"} for ${task.id}.`, {
      repaired_output_ref: repairedRef
    }, task.id));
    if (!repair.repaired) throw new Error(`CodePatchProposal validation failed: ${validation.errors.join("; ")}`);
    return repair.repaired;
  }

  private async recordRoleSpecificStructuredOutput(run: Run, task: Task, output: ParsedAgentOutput) {
    if (task.role_required !== "ScoutAgent") return;
    const scout = scoutResultFromParsedOutput(output, task.relevant_files);
    const validation = validateStructuredOutput("ScoutResult", scout);
    if (!validation.valid) throw new Error(`ScoutResult validation failed: ${validation.errors.join("; ")}`);
    const ref = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_scout_result`, scout);
    output.artifacts.push(ref);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_parsed", "Validated ScoutResult.", {
      schema: "ScoutResult",
      parsed_output_ref: ref
    }, task.id));
  }

  private async maybeCreateRepairTask(input: {
    run: Run;
    task: Task;
    manager: TaskGraphManager;
  }, failure: {
    reason: string;
    required_changes: string[];
    validation_logs: string[];
    previous_patch_fingerprint?: string;
  }) {
    const repairTask = createRepairTask({
      manager: input.manager,
      originalTask: input.task,
      failure,
      config: this.config
    });
    if (!repairTask) {
      await this.artifactStore.saveRepairArtifact(input.run.id, `${input.task.id}_repair_limit`, {
        task_id: input.task.id,
        failure,
        reason: "Maximum repair rounds reached."
      });
      return undefined;
    }
    await input.manager.persist();
    const repairRef = await this.artifactStore.saveRepairArtifact(input.run.id, repairTask.id, {
      original_task_id: input.task.id,
      repair_task: repairTask,
      failure
    });
    repairTask.artifacts.push(repairRef);
    await this.artifactStore.appendEvent(this.event(input.run.id, "repair.task_created", `Repair task created: ${repairTask.id}.`, {
      original_task_id: input.task.id,
      repair_task_id: repairTask.id,
      repair_ref: repairRef
    }, repairTask.id));
    await input.manager.persist();
    return repairTask;
  }

  private async writeCheckpoint(run: Run, tasks: Task[], label: string, notes: string[], indexFreshness?: unknown) {
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

  private async writeRunMetrics(run: Run, tasks: Task[], report: FinalRunReport): Promise<RunMetrics> {
    const events = await this.artifactStore.listRunEvents(run.id) as OrchestratorEvent[];
    const metrics = computeRunMetrics({ run, tasks, events, report });
    const ref = await this.artifactStore.saveRunMetrics(metrics);
    await this.artifactStore.appendEvent(this.event(run.id, "metrics.written", `Run metrics written: ${ref}`, {
      metrics_ref: ref,
      metrics
    }));
    return metrics;
  }

  private integrationManager(lockManager?: DurableLockManager) {
    return new IntegrationManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "IntegrationManager" }),
      lockManager,
      applyMode: "prepare_only",
      config: this.config
    });
  }

  private async createAgentTeamsIfNeeded(run: Run, multiPlan: MultiPlanFactoryResult, tasks: Task[], planOnly: boolean): Promise<AgentTeamHierarchy | undefined> {
    const shouldCreate = multiPlan.used || this.config.execution_mode !== "fast" || run.user_request.length > 160;
    if (!shouldCreate) return undefined;
    const manager = new AgentTeamManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "AgentTeamManager" })
    });
    const teams = await manager.proposeTeamsFromMergedPlan(run, multiPlan.merged_plan);
    const root = teams.find((team) => team.team_type === "root");
    if (root) {
      for (const task of tasks) {
        await manager.assignTaskToTeam(task.id, root.team_id);
      }
    }
    const validation = await manager.validateTeamHierarchy(run.id);
    const hierarchy = await manager.summarizeTeamHierarchy(run.id, validation);
    const hierarchyRef = await this.artifactStore.saveAgentTeamHierarchy(run.id, hierarchy.hierarchy_id, hierarchy);
    hierarchy.artifact_ref = hierarchyRef;
    await this.artifactStore.saveAgentTeamSummary(run.id, hierarchy.hierarchy_id, teamHierarchySummary(hierarchy, validation), {
      root_team_id: hierarchy.root_team_id,
      team_count: hierarchy.teams.length,
      max_depth: hierarchy.max_depth,
      mode: planOnly ? "plan_only" : "normal"
    });
    await this.generateTeamSubPlansIfAllowed(run, hierarchy, multiPlan.used, planOnly, tasks);
    return hierarchy;
  }

  private async generateTeamSubPlansIfAllowed(run: Run, hierarchy: AgentTeamHierarchy, multiPlanUsed: boolean, planOnly: boolean, tasks: Task[]) {
    if (!this.config.enable_team_sub_planning || this.config.team_sub_planning_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_sub_plan_skipped",
        lifecycle_stage: "planning",
        summary: "Team sub-planning skipped by configuration.",
        reason: "team_sub_planning_disabled",
        metadata_json: { run_id: run.id, mode: this.config.team_sub_planning_mode }
      });
      return;
    }
    const planner = new TeamSubPlanner({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      provider: this.config.allow_provider_team_sub_planning ? this.providerFactory?.("PlannerAgent") : undefined
    });
    const candidates = hierarchy.teams
      .filter((team) => planner.shouldSubPlanTeam(team, { teamCount: hierarchy.teams.length, multiPlanUsed }).should_plan)
      .slice(0, this.config.max_team_sub_plans_per_run);
    if (!candidates.length) {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_sub_plan_skipped",
        lifecycle_stage: "planning",
        summary: "No teams were eligible for read-only sub-planning.",
        reason: "no_eligible_teams",
        metadata_json: { run_id: run.id, team_count: hierarchy.teams.length, plan_only: planOnly }
      });
      await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, []);
      return;
    }
    const plans = [];
    for (const team of candidates) {
      try {
        const input = await planner.buildTeamSubPlanInput(team.team_id);
        const generated = await planner.generateTeamSubPlan(input);
        const withArtifacts = await planner.writeTeamSubPlanArtifacts(generated);
        plans.push(await planner.persistTeamSubPlan(withArtifacts));
      } catch (error) {
        await this.traceWriter.write({
          run_id: run.id,
          team_id: team.team_id,
          event_type: "team_sub_plan_blocked",
          lifecycle_stage: "planning",
          severity: "warning",
          summary: `Team sub-planning blocked for ${team.team_id}.`,
          reason: error instanceof Error ? error.message : String(error),
          metadata_json: {
            run_id: run.id,
            team_id: team.team_id,
            parent_team_id: team.parent_team_id,
            generation_mode: this.config.team_sub_planning_mode
          }
        });
      }
    }
    if (plans.length) {
      const aggregator = new TeamSubPlanAggregator({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        artifactStore: this.artifactStore
      });
      await aggregator.aggregate(run.id, plans);
      await this.adoptTeamSubPlanTaskDraftsIfAllowed(run, plans, tasks, planOnly);
    }
  }

  private async adoptTeamSubPlanTaskDraftsIfAllowed(run: Run, plans: Awaited<ReturnType<TeamSubPlanner["persistTeamSubPlan"]>>[], tasks: Task[], planOnly: boolean) {
    if (!this.config.enable_team_task_adoption || this.config.team_task_adoption_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "team_task_adoption_summary_created",
        lifecycle_stage: "planning",
        summary: "Team task adoption skipped by configuration.",
        reason: "team_task_adoption_disabled",
        metadata_json: { run_id: run.id, mode: this.config.team_task_adoption_mode, plan_only: planOnly }
      });
      await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, []);
      return;
    }
    const gate = new TeamTaskAdoptionGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    const adoption = await gate.adoptTeamSubPlanTasks(plans, { existingTasks: tasks });
    await this.buildProposedTaskGraphIfAllowed(run, tasks, planOnly, adoption.proposals);
  }

  private async buildProposedTaskGraphIfAllowed(run: Run, tasks: Task[], planOnly: boolean, adoptedProposals?: Awaited<ReturnType<TeamTaskAdoptionGate["adoptTeamSubPlanTasks"]>>["proposals"]) {
    if (!this.config.enable_proposed_task_graph || this.config.proposed_task_graph_mode === "off") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "proposed_task_graph_build_skipped",
        lifecycle_stage: "planning",
        summary: "Proposed task graph build skipped by configuration.",
        reason: "proposed_task_graph_disabled",
        metadata_json: { run_id: run.id, mode: this.config.proposed_task_graph_mode, plan_only: planOnly }
      });
      return;
    }
    const manager = new ProposedTaskGraphManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    const result = await manager.buildProposedGraphFromAdoptedTasks(run.id, { adoptedProposals, existingTasks: tasks });
    await this.evaluateExecutionReadinessIfAllowed(result.graph, planOnly);
  }

  private async evaluateExecutionReadinessIfAllowed(graph: Awaited<ReturnType<ProposedTaskGraphManager["buildProposedGraphFromAdoptedTasks"]>>["graph"], planOnly: boolean) {
    if (!this.config.execution_readiness_gate_enabled || this.config.execution_readiness_mode === "off") {
      await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "execution_readiness_batch_completed",
        lifecycle_stage: "planning",
        summary: "Execution readiness gate skipped by configuration.",
        reason: "execution_readiness_disabled",
        metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, mode: this.config.execution_readiness_mode, plan_only: planOnly }
      });
      return;
    }
    const gate = new ExecutionReadinessGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore
    });
    await gate.evaluateProposedGraph(graph);
    await this.prepareExecutionIfAllowed(graph.run_id, planOnly);
  }

  private async prepareExecutionIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_execution_preparation || this.config.execution_preparation_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "execution_preparation_batch_completed",
        lifecycle_stage: "planning",
        summary: "Execution preparation skipped by configuration.",
        reason: "execution_preparation_disabled",
        metadata_json: { run_id: runId, mode: this.config.execution_preparation_mode, plan_only: planOnly, no_execution: true }
      });
      return;
    }
    const planner = new ExecutionPreparationPlanner({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await planner.prepareRunPromotionQueue(runId);
    await this.generateOneWriterDryRunIfAllowed(runId, planOnly);
  }

  private async generateOneWriterDryRunIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_one_writer_dry_run || this.config.one_writer_dry_run_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "one_writer_dry_run_batch_completed",
        lifecycle_stage: "planning",
        summary: "One-writer dry-run skipped by configuration.",
        reason: "one_writer_dry_run_disabled",
        metadata_json: { run_id: runId, mode: this.config.one_writer_dry_run_mode, plan_only: planOnly, no_patch_applied: true }
      });
      return;
    }
    const executor = new OneWriterDryRunExecutor({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await executor.generatePatchProposalBatch(runId);
    await this.reviewPatchProposalsIfAllowed(runId, planOnly);
  }

  private async reviewPatchProposalsIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_patch_proposal_review_gate || this.config.patch_proposal_review_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "patch_proposal_review_batch_completed",
        lifecycle_stage: "planning",
        summary: "Patch proposal review gate skipped by configuration.",
        reason: "patch_proposal_review_disabled",
        metadata_json: { run_id: runId, mode: this.config.patch_proposal_review_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const gate = new PatchProposalReviewGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await gate.reviewPatchProposalBatch(runId);
    await this.createValidationCandidatesIfAllowed(runId, planOnly);
  }

  private async createValidationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_validation_candidate_gate || this.config.validation_candidate_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "validation_candidate_batch_completed",
        lifecycle_stage: "planning",
        summary: "Validation candidate gate skipped by configuration.",
        reason: "validation_candidate_gate_disabled",
        metadata_json: { run_id: runId, mode: this.config.validation_candidate_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const gate = new ValidationCandidateGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await gate.createValidationCandidateBatch(runId);
    await this.createPatchApplySandboxIfAllowed(runId, planOnly);
  }

  private async createPatchApplySandboxIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_patch_apply_sandbox || this.config.patch_apply_sandbox_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "patch_apply_sandbox_batch_completed",
        lifecycle_stage: "planning",
        summary: "Patch apply sandbox skipped by configuration.",
        reason: "patch_apply_sandbox_disabled",
        metadata_json: { run_id: runId, mode: this.config.patch_apply_sandbox_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const manager = new PatchApplySandboxManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await manager.runDryApplyBatch(runId);
    await this.runSandboxValidationIfAllowed(runId, planOnly);
  }

  private async runSandboxValidationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_sandbox_validation || this.config.sandbox_validation_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "sandbox_validation_batch_completed",
        lifecycle_stage: "validation",
        summary: "Sandbox validation skipped by configuration.",
        reason: "sandbox_validation_disabled",
        metadata_json: { run_id: runId, mode: this.config.sandbox_validation_mode, plan_only: planOnly, no_main_repo_validation: true, no_integration_created: true }
      });
      return;
    }
    const runner = new SandboxValidationRunner({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await runner.runSandboxValidationBatch(runId);
    await this.createSandboxIntegrationCandidatesIfAllowed(runId, planOnly);
  }

  private async createSandboxIntegrationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_sandbox_integration_candidates || this.config.sandbox_integration_candidate_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "sandbox_integration_candidate_batch_completed",
        lifecycle_stage: "planning",
        summary: "Sandbox integration candidate gate skipped by configuration.",
        reason: "sandbox_integration_candidate_disabled",
        metadata_json: { run_id: runId, mode: this.config.sandbox_integration_candidate_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await gate.createCandidateBatch(runId);
    await this.createIntegrationApplyApprovalsIfAllowed(runId, planOnly);
  }

  private async createIntegrationApplyApprovalsIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_integration_apply_approval_gate || this.config.integration_apply_approval_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "integration_apply_approval_batch_completed",
        lifecycle_stage: "planning",
        summary: "Integration apply approval gate skipped by configuration.",
        reason: "integration_apply_approval_disabled",
        metadata_json: { run_id: runId, mode: this.config.integration_apply_approval_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const gate = new IntegrationApplyApprovalGate({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await gate.createApplyApprovalBatch(runId);
    await this.applyControlledIntegrationIfAllowed(runId, planOnly);
  }

  private async applyControlledIntegrationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_controlled_integration_apply || this.config.controlled_apply_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "controlled_apply_batch_completed",
        lifecycle_stage: "integrating",
        summary: "Controlled integration apply skipped by configuration.",
        reason: "controlled_integration_apply_disabled",
        metadata_json: { run_id: runId, mode: this.config.controlled_apply_mode, plan_only: planOnly, no_apply: true }
      });
      return;
    }
    if (this.config.controlled_apply_mode === "report_only") {
      const manager = new ControlledIntegrationApplyManager({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        config: this.config,
        artifactStore: this.artifactStore,
        traceWriter: this.traceWriter
      });
      await manager.applyApprovedIntegrationBatch(runId);
      await this.finalizeIntegrationIfAllowed(runId, planOnly);
      return;
    }
    const manager = new ControlledIntegrationApplyManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await manager.applyApprovedIntegrationBatch(runId);
    await this.finalizeIntegrationIfAllowed(runId, planOnly);
  }

  private async finalizeIntegrationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.config.enable_integration_finalization || this.config.integration_finalization_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        event_type: "integration_finalization_batch_completed",
        lifecycle_stage: "memory_update",
        summary: "Integration finalization skipped by configuration.",
        reason: "integration_finalization_disabled",
        metadata_json: { run_id: runId, mode: this.config.integration_finalization_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const manager = new IntegrationFinalizationManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: this.config,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter
    });
    await manager.finalizeControlledApplyBatch(runId);
  }

  private async createFinalReport(
    run: Run,
    tasks: Task[],
    outputs: ParsedAgentOutput[],
    extraLimitations: string[],
    multiPlanSummary?: MultiPlanSummary,
    integration?: FactoryIntegrationResult,
    teamHierarchy?: AgentTeamHierarchy
  ): Promise<FinalRunReport> {
    const promptWriterSummary = await this.promptWriterReportSummary(tasks);
    const lockSummary = await this.lockReportSummary(run, tasks);
    const report: FinalRunReport = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      run_id: run.id,
      status: run.status,
      user_request: run.user_request,
      tasks_created: tasks.length,
      tasks_completed: tasks.filter((task) => task.status === "succeeded").length,
      tasks_failed: tasks.filter((task) => task.status === "failed" || task.status === "blocked").length,
      files_changed: uniqueStrings(outputs.flatMap((output) => output.files_changed)),
      validation_results: outputs.flatMap((output) => output.validation_results),
      artifacts_path: run.artifacts_path,
      limitations: uniqueStrings([
        "Phase 4 keeps parallel execution conservative by default; it is not a full background swarm yet.",
        executorProviderTruthLimitation(outputs),
        ...validationTruthLimitations(run, outputs),
        ...outputs.flatMap((output) => output.limitations),
        ...extraLimitations
      ]),
      next_recommendations: uniqueStrings([
        ...outputs.flatMap((output) => output.next_recommendations),
        "Next hardening should connect real provider-backed worker roles and shared Rust command execution authority."
      ]).slice(0, 8),
      completed_tasks: tasks.filter((task) => task.status === "succeeded").map((task) => task.id),
      failed_tasks: tasks.filter((task) => task.status === "failed" || task.status === "blocked").map((task) => task.id),
      changed_files: uniqueStrings(outputs.flatMap((output) => output.files_changed)),
      unresolved_risks: uniqueStrings([
        ...validationTruthLimitations(run, outputs),
        ...outputs.flatMap((output) => output.limitations),
        ...extraLimitations,
        ...(multiPlanSummary?.top_risks ?? [])
      ]),
      next_steps: uniqueStrings([
        ...outputs.flatMap((output) => output.next_recommendations),
        "Inspect review and validation artifacts before applying any proposed patch.",
        multiPlanSummary?.recommended_next_step ?? ""
      ]).slice(0, 8),
      multi_plan_used: multiPlanSummary?.multi_plan_used ?? false,
      generation_mode: multiPlanSummary?.generation_mode,
      plan_variant_count: multiPlanSummary?.plan_variant_count ?? 0,
      selected_perspectives: multiPlanSummary?.selected_perspectives ?? [],
      rejected_perspectives: multiPlanSummary?.rejected_perspectives ?? [],
      top_risks: multiPlanSummary?.top_risks ?? [],
      merged_plan_ref: multiPlanSummary?.merged_plan_ref,
      confidence: multiPlanSummary?.confidence,
      unresolved_questions: multiPlanSummary?.unresolved_questions ?? [],
      evidence_used: multiPlanSummary?.evidence_used ?? false,
      evidence_item_count: multiPlanSummary?.evidence_item_count ?? 0,
      provider_evidence_count: multiPlanSummary?.provider_evidence_count ?? 0,
      mock_evidence_count: multiPlanSummary?.mock_evidence_count ?? 0,
      low_confidence_count: multiPlanSummary?.low_confidence_count ?? 0,
      rejected_evidence_count: multiPlanSummary?.rejected_evidence_count ?? 0,
      evidence_conflict_count: multiPlanSummary?.evidence_conflict_count ?? 0,
      evidence_bundle_ref: multiPlanSummary?.evidence_bundle_ref,
      top_evidence_sources: multiPlanSummary?.top_evidence_sources ?? [],
      evidence_limitations: multiPlanSummary?.evidence_limitations ?? [],
      prompt_writer_mode: this.config.prompt_writer_mode,
      prompt_writer_runs: promptWriterSummary.prompt_writer_runs,
      adopted_count: promptWriterSummary.adopted_count,
      rejected_count: promptWriterSummary.rejected_count,
      shadow_count: promptWriterSummary.shadow_count,
      fallback_count: promptWriterSummary.fallback_count,
      failed_schema_count: promptWriterSummary.failed_schema_count,
      failed_quality_count: promptWriterSummary.failed_quality_count,
      top_missing_context_warnings: promptWriterSummary.top_missing_context_warnings,
      locks_requested: lockSummary.locks_requested,
      locks_acquired: lockSummary.locks_acquired,
      locks_rejected: lockSummary.locks_rejected,
      advisory_locks: lockSummary.advisory_locks,
      semantic_locks: lockSummary.semantic_locks,
      module_locks: lockSummary.module_locks,
      expired_locks_recovered: lockSummary.expired_locks_recovered,
      active_locks_at_end: lockSummary.active_locks_at_end,
      blocking_conflicts: lockSummary.blocking_conflicts,
      integration_status: integration?.status,
      candidates_found: integration
        ? integration.applied_candidates.length + integration.rejected_candidates.length + integration.blocked_candidates.length
        : undefined,
      candidates_applied: integration?.applied_candidates.length,
      conflicts_count: integration?.conflicts.length,
      integration_validation_status: integration?.validation_status,
      rollback_available: integration?.rollback_available,
      blocked_reason: integration?.blocked_reason,
      integration_result_ref: integration?.artifact_ref,
      root_team_id: teamHierarchy?.root_team_id,
      team_count: teamHierarchy?.teams.length,
      max_team_depth: teamHierarchy?.max_depth,
      domain_teams: teamHierarchy?.teams.filter((team) => team.team_type === "domain").map((team) => team.domain),
      blocked_teams: teamHierarchy?.teams.filter((team) => team.status === "blocked").map((team) => team.team_id),
      budget_warnings: teamHierarchy?.warnings,
      hierarchy_ref: teamHierarchy?.artifact_ref
    };
    const teamContextSummary = await this.teamContextReportSummary(run.id);
    report.team_context_used = teamContextSummary.team_context_used;
    report.team_context_scope_count = teamContextSummary.team_context_scope_count;
    report.team_memory_queries = teamContextSummary.team_memory_queries;
    report.team_scope_fallbacks = teamContextSummary.team_scope_fallbacks;
    report.team_scope_warnings = teamContextSummary.team_scope_warnings;
    report.stale_or_low_confidence_team_context_items = teamContextSummary.stale_or_low_confidence_team_context_items;
    const teamSubPlanningSummary = await this.teamSubPlanningReportSummary(run.id);
    report.team_sub_planning_used = teamSubPlanningSummary.team_sub_planning_used;
    report.sub_plan_count = teamSubPlanningSummary.sub_plan_count;
    report.invalid_sub_plan_count = teamSubPlanningSummary.invalid_sub_plan_count;
    report.teams_planned = teamSubPlanningSummary.teams_planned;
    report.cross_team_dependency_count = teamSubPlanningSummary.cross_team_dependency_count;
    report.scope_conflict_count = teamSubPlanningSummary.scope_conflict_count;
    report.top_team_risks = teamSubPlanningSummary.top_team_risks;
    report.aggregation_ref = teamSubPlanningSummary.aggregation_ref;
    const adoptionSummary = await this.teamTaskAdoptionReportSummary(run.id);
    report.team_task_adoption_used = adoptionSummary.team_task_adoption_used;
    report.drafts_evaluated = adoptionSummary.drafts_evaluated;
    report.adopted_metadata_only_count = adoptionSummary.adopted_metadata_only_count;
    report.adopted_read_only_count = adoptionSummary.adopted_read_only_count;
    report.task_adoption_rejected_count = adoptionSummary.rejected_count;
    report.task_adoption_duplicate_count = adoptionSummary.duplicate_count;
    report.task_adoption_blocked_count = adoptionSummary.blocked_count;
    report.future_write_candidate_count = adoptionSummary.future_write_candidate_count;
    report.executable_ready_count = adoptionSummary.executable_ready_count;
    report.adoption_summary_ref = adoptionSummary.adoption_summary_ref;
    const proposedGraphSummary = await this.proposedTaskGraphReportSummary(run.id);
    report.proposed_task_graph_used = proposedGraphSummary.proposed_task_graph_used;
    report.proposed_node_count = proposedGraphSummary.proposed_node_count;
    report.proposed_edge_count = proposedGraphSummary.proposed_edge_count;
    report.read_only_ready_count = proposedGraphSummary.read_only_ready_count;
    report.proposed_graph_future_write_candidate_count = proposedGraphSummary.future_write_candidate_count;
    report.proposed_graph_blocked_count = proposedGraphSummary.blocked_count;
    report.proposed_graph_duplicate_count = proposedGraphSummary.duplicate_count;
    report.cycle_count = proposedGraphSummary.cycle_count;
    report.proposed_graph_scope_overlap_count = proposedGraphSummary.scope_overlap_count;
    report.graph_summary_ref = proposedGraphSummary.graph_summary_ref;
    const executionReadinessSummary = await this.executionReadinessReportSummary(run.id);
    report.execution_readiness_used = executionReadinessSummary.execution_readiness_used;
    report.nodes_evaluated = executionReadinessSummary.nodes_evaluated;
    report.ready_read_only_count = executionReadinessSummary.ready_read_only_count;
    report.execution_future_write_candidate_count = executionReadinessSummary.future_write_candidate_count;
    report.requires_human_approval_count = executionReadinessSummary.requires_human_approval_count;
    report.execution_readiness_blocked_count = executionReadinessSummary.blocked_count;
    report.execution_readiness_rejected_count = executionReadinessSummary.rejected_count;
    report.requires_context_count = executionReadinessSummary.requires_context_count;
    report.requires_validation_count = executionReadinessSummary.requires_validation_count;
    report.requires_locks_count = executionReadinessSummary.requires_locks_count;
    report.readiness_summary_ref = executionReadinessSummary.readiness_summary_ref;
    const promotionSummary = await this.approvalPromotionReportSummary(run.id);
    report.promotion_requests_created = promotionSummary.promotion_requests_created;
    report.approvals_required = promotionSummary.approvals_required;
    report.approvals_granted = promotionSummary.approvals_granted;
    report.approvals_denied = promotionSummary.approvals_denied;
    report.approvals_expired = promotionSummary.approvals_expired;
    report.queue_items_created = promotionSummary.queue_items_created;
    report.queue_items_blocked = promotionSummary.queue_items_blocked;
    report.read_only_candidates = promotionSummary.read_only_candidates;
    report.write_candidates_waiting_approval = promotionSummary.write_candidates_waiting_approval;
    report.approval_summary_ref = promotionSummary.approval_summary_ref;
    report.promotion_queue_summary_ref = promotionSummary.promotion_queue_summary_ref;
    const preparationSummary = await this.executionPreparationReportSummary(run.id);
    report.execution_preparation_used = preparationSummary.execution_preparation_used;
    report.preparation_plan_count = preparationSummary.preparation_plan_count;
    report.prepared_count = preparationSummary.prepared_count;
    report.blocked_count = preparationSummary.blocked_count;
    report.missing_approval_count = preparationSummary.missing_approval_count;
    report.missing_context_count = preparationSummary.missing_context_count;
    report.missing_prompt_count = preparationSummary.missing_prompt_count;
    report.missing_validation_count = preparationSummary.missing_validation_count;
    report.missing_locks_count = preparationSummary.missing_locks_count;
    report.stale_context_count = preparationSummary.stale_context_count;
    report.preparation_summary_ref = preparationSummary.preparation_summary_ref;
    const dryRunSummary = await this.oneWriterDryRunReportSummary(run.id);
    report.one_writer_dry_run_used = dryRunSummary.one_writer_dry_run_used;
    report.dry_run_proposal_count = dryRunSummary.dry_run_proposal_count;
    report.generated_count = dryRunSummary.generated_count;
    report.schema_failed_count = dryRunSummary.schema_failed_count;
    report.scope_failed_count = dryRunSummary.scope_failed_count;
    report.dry_run_blocked_count = dryRunSummary.blocked_count;
    report.review_candidate_count = dryRunSummary.review_candidate_count;
    report.changed_files_preview = dryRunSummary.changed_files_preview;
    report.dry_run_summary_ref = dryRunSummary.dry_run_summary_ref;
    const patchReviewSummary = await this.patchProposalReviewReportSummary(run.id);
    report.patch_review_used = patchReviewSummary.patch_review_used;
    report.patch_reviews_count = patchReviewSummary.patch_reviews_count;
    report.accepted_for_validation_candidate_count = patchReviewSummary.accepted_for_validation_candidate_count;
    report.changes_requested_count = patchReviewSummary.changes_requested_count;
    report.patch_review_rejected_count = patchReviewSummary.rejected_count;
    report.patch_review_blocked_count = patchReviewSummary.blocked_count;
    report.review_schema_failed_count = patchReviewSummary.review_schema_failed_count;
    report.critical_findings_count = patchReviewSummary.critical_findings_count;
    report.high_findings_count = patchReviewSummary.high_findings_count;
    report.review_summary_ref = patchReviewSummary.review_summary_ref;
    const validationCandidateSummary = await this.validationCandidateReportSummary(run.id);
    report.validation_candidate_used = validationCandidateSummary.validation_candidate_used;
    report.validation_candidate_count = validationCandidateSummary.validation_candidate_count;
    report.preflight_passed_count = validationCandidateSummary.preflight_passed_count;
    report.incomplete_count = validationCandidateSummary.incomplete_count;
    report.command_blocked_count = validationCandidateSummary.command_blocked_count;
    report.environment_blocked_count = validationCandidateSummary.environment_blocked_count;
    report.validation_candidate_rejected_count = validationCandidateSummary.rejected_count;
    report.validation_candidate_summary_ref = validationCandidateSummary.validation_candidate_summary_ref;
    const patchApplySummary = await this.patchApplySandboxReportSummary(run.id);
    report.patch_apply_sandbox_used = patchApplySummary.patch_apply_sandbox_used;
    report.sandbox_result_count = patchApplySummary.sandbox_result_count;
    report.dry_apply_passed_count = patchApplySummary.dry_apply_passed_count;
    report.dry_apply_failed_count = patchApplySummary.dry_apply_failed_count;
    report.conflict_count = patchApplySummary.conflict_count;
    report.failed_hunk_count = patchApplySummary.failed_hunk_count;
    report.sandbox_unavailable_count = patchApplySummary.sandbox_unavailable_count;
    report.main_repo_integrity_ok = patchApplySummary.main_repo_integrity_ok;
    report.sandbox_summary_ref = patchApplySummary.sandbox_summary_ref;
    const sandboxValidationSummary = await this.sandboxValidationReportSummary(run.id);
    report.sandbox_validation_used = sandboxValidationSummary.sandbox_validation_used;
    report.sandbox_validation_count = sandboxValidationSummary.sandbox_validation_count;
    report.sandbox_validation_passed_count = sandboxValidationSummary.sandbox_validation_passed_count;
    report.sandbox_validation_failed_count = sandboxValidationSummary.sandbox_validation_failed_count;
    report.sandbox_validation_blocked_count = sandboxValidationSummary.sandbox_validation_blocked_count;
    report.sandbox_validation_partial_count = sandboxValidationSummary.sandbox_validation_partial_count;
    report.sandbox_validation_summary_ref = sandboxValidationSummary.sandbox_validation_summary_ref;
    const sandboxIntegrationCandidateSummary = await this.sandboxIntegrationCandidateReportSummary(run.id);
    report.sandbox_integration_candidate_used = sandboxIntegrationCandidateSummary.sandbox_integration_candidate_used;
    report.integration_candidate_count = sandboxIntegrationCandidateSummary.integration_candidate_count;
    report.candidate_created_count = sandboxIntegrationCandidateSummary.candidate_created_count;
    report.candidate_blocked_count = sandboxIntegrationCandidateSummary.blocked_count;
    report.candidate_rejected_count = sandboxIntegrationCandidateSummary.rejected_count;
    report.candidate_validation_failed_count = sandboxIntegrationCandidateSummary.validation_failed_count;
    report.candidate_validation_blocked_count = sandboxIntegrationCandidateSummary.validation_blocked_count;
    report.candidate_summary_ref = sandboxIntegrationCandidateSummary.candidate_summary_ref;
    const applyApprovalSummary = await this.integrationApplyApprovalReportSummary(run.id);
    report.integration_apply_approval_used = applyApprovalSummary.integration_apply_approval_used;
    report.apply_approval_count = applyApprovalSummary.apply_approval_count;
    report.approved_for_apply_candidate_count = applyApprovalSummary.approved_for_apply_candidate_count;
    report.apply_approval_requires_human_approval_count = applyApprovalSummary.requires_human_approval_count;
    report.apply_approval_blocked_count = applyApprovalSummary.blocked_count;
    report.apply_approval_rejected_count = applyApprovalSummary.rejected_count;
    report.dirty_worktree_blocked_count = applyApprovalSummary.dirty_worktree_blocked_count;
    report.apply_mode_recommendation_count = applyApprovalSummary.apply_mode_recommendation_count;
    report.apply_approval_summary_ref = applyApprovalSummary.apply_approval_summary_ref;
    const controlledApplySummary = await this.controlledApplyReportSummary(run.id);
    report.controlled_apply_used = controlledApplySummary.controlled_apply_used;
    report.controlled_apply_count = controlledApplySummary.controlled_apply_count;
    report.applied_count = controlledApplySummary.applied_count;
    report.post_validation_passed_count = controlledApplySummary.post_validation_passed_count;
    report.post_validation_failed_count = controlledApplySummary.post_validation_failed_count;
    report.rolled_back_count = controlledApplySummary.rolled_back_count;
    report.rollback_failed_count = controlledApplySummary.rollback_failed_count;
    report.lock_failed_count = controlledApplySummary.lock_failed_count;
    report.controlled_apply_blocked_count = controlledApplySummary.blocked_count;
    report.controlled_apply_summary_ref = controlledApplySummary.controlled_apply_summary_ref;
    const integrationFinalizationSummary = await this.integrationFinalizationReportSummary(run.id);
    report.integration_finalization_used = integrationFinalizationSummary.integration_finalization_used;
    report.integration_finalization_count = integrationFinalizationSummary.integration_finalization_count;
    report.finalized_count = integrationFinalizationSummary.finalized_count;
    report.finalization_validation_failed_count = integrationFinalizationSummary.validation_failed_count;
    report.finalization_rollback_completed_count = integrationFinalizationSummary.rollback_completed_count;
    report.finalization_rollback_failed_count = integrationFinalizationSummary.rollback_failed_count;
    report.memory_entries_created_count = integrationFinalizationSummary.memory_entries_created_count;
    report.lessons_created_count = integrationFinalizationSummary.lessons_created_count;
    report.finalization_summary_ref = integrationFinalizationSummary.finalization_summary_ref;
    assertValid("FinalRunReport", report, validateFinalRunReport);
    const reportPath = await this.artifactStore.saveFinalReport(report);
    await this.artifactStore.appendEvent(this.event(run.id, "run.reported", `Final report written: ${reportPath}`, {
      report: reportPath
    }));
    return report;
  }

  private async teamIdForTask(runId: string, taskId: string) {
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return undefined;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const row = store.get<{ team_id: string }>(
          "SELECT team_id FROM factory_agent_team_assignments WHERE run_id = ? AND target_id = ? AND assignment_type = 'task' ORDER BY created_at DESC LIMIT 1",
          runId,
          taskId
        );
        return row?.team_id;
      } finally {
        store.close();
      }
    } catch {
      return undefined;
    }
  }

  private async teamContextReportSummary(runId: string) {
    const empty = {
      team_context_used: false,
      team_context_scope_count: 0,
      team_memory_queries: 0,
      team_scope_fallbacks: 0,
      team_scope_warnings: 0,
      stale_or_low_confidence_team_context_items: 0
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const scopes = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_context_scopes WHERE run_id = ?", runId)?.count ?? 0;
        const queries = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_memory_queries WHERE run_id = ?", runId)?.count ?? 0;
        const fallbacks = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_memory_queries WHERE run_id = ? AND fallback_used = 1", runId)?.count ?? 0;
        const warningRows = store.all<{ metadata_json: string }>("SELECT metadata_json FROM factory_team_context_scopes WHERE run_id = ?", runId);
        const warningCount = warningRows.reduce((sum, row) => {
          const metadata = parseJsonRecord(row.metadata_json);
          return sum + (Array.isArray(metadata.warnings) ? metadata.warnings.length : 0);
        }, 0);
        const staleLow = store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM factory_team_context_items WHERE run_id = ? AND (freshness IN ('stale', 'possibly_stale', 'unknown') OR confidence = 'low')",
          runId
        )?.count ?? 0;
        return {
          team_context_used: scopes > 0 || queries > 0,
          team_context_scope_count: Number(scopes),
          team_memory_queries: Number(queries),
          team_scope_fallbacks: Number(fallbacks),
          team_scope_warnings: warningCount,
          stale_or_low_confidence_team_context_items: Number(staleLow)
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async teamSubPlanningReportSummary(runId: string) {
    const empty = {
      team_sub_planning_used: false,
      sub_plan_count: 0,
      invalid_sub_plan_count: 0,
      teams_planned: 0,
      cross_team_dependency_count: 0,
      scope_conflict_count: 0,
      top_team_risks: [] as string[],
      aggregation_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const plans = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plans WHERE run_id = ?", runId)?.count ?? 0;
        const invalid = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plans WHERE run_id = ? AND status IN ('invalid', 'blocked')", runId)?.count ?? 0;
        const aggregation = store.get<{ artifact_ref?: string; cross_team_dependencies_json: string; scope_conflicts_json: string; top_risks_json: string; teams_planned_json: string }>(
          "SELECT artifact_ref, cross_team_dependencies_json, scope_conflicts_json, top_risks_json, teams_planned_json FROM factory_team_sub_plan_aggregations WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          runId
        );
        const dependencies = parseJsonArray(aggregation?.cross_team_dependencies_json);
        const scopeConflicts = parseJsonArray(aggregation?.scope_conflicts_json);
        const topRisks = parseJsonArray(aggregation?.top_risks_json)
          .map((entry) => typeof entry === "object" && entry && "summary" in entry ? String((entry as Record<string, unknown>).summary) : "")
          .filter(Boolean)
          .slice(0, 8);
        const teamsPlanned = parseJsonArray(aggregation?.teams_planned_json).length;
        return {
          team_sub_planning_used: Number(plans) > 0,
          sub_plan_count: Number(plans),
          invalid_sub_plan_count: Number(invalid),
          teams_planned: teamsPlanned,
          cross_team_dependency_count: dependencies.length,
          scope_conflict_count: scopeConflicts.length,
          top_team_risks: topRisks,
          aggregation_ref: aggregation?.artifact_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async teamTaskAdoptionReportSummary(runId: string) {
    const empty = {
      team_task_adoption_used: false,
      drafts_evaluated: 0,
      adopted_metadata_only_count: 0,
      adopted_read_only_count: 0,
      rejected_count: 0,
      duplicate_count: 0,
      blocked_count: 0,
      future_write_candidate_count: 0,
      executable_ready_count: 0,
      adoption_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const decisions = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ?", runId)?.count ?? 0;
        const metadataOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_adopted_task_proposals WHERE run_id = ? AND adoption_status = 'adopted_metadata_only'", runId)?.count ?? 0;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_adopted_task_proposals WHERE run_id = ? AND adoption_status = 'adopted_read_only'", runId)?.count ?? 0;
        const rejected = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND adoption_status IN ('rejected', 'out_of_scope', 'unsafe_write_scope')", runId)?.count ?? 0;
        const duplicate = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND adoption_status = 'duplicate'", runId)?.count ?? 0;
        const blocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND (adoption_status = 'adopted_blocked' OR adoption_status LIKE 'missing_%')", runId)?.count ?? 0;
        const future = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_readiness_results WHERE run_id = ? AND readiness_status = 'future_write_candidate'", runId)?.count ?? 0;
        const executable = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_readiness_results WHERE run_id = ? AND readiness_status = 'executable_ready'", runId)?.count ?? 0;
        const summary = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_artifacts WHERE run_id = ? AND artifact_kind = 'team_task_adoption_summary' ORDER BY created_at DESC LIMIT 1", runId);
        return {
          team_task_adoption_used: Number(decisions) > 0,
          drafts_evaluated: Number(decisions),
          adopted_metadata_only_count: Number(metadataOnly),
          adopted_read_only_count: Number(readOnly),
          rejected_count: Number(rejected),
          duplicate_count: Number(duplicate),
          blocked_count: Number(blocked),
          future_write_candidate_count: Number(future),
          executable_ready_count: Number(executable),
          adoption_summary_ref: summary?.artifact_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async proposedTaskGraphReportSummary(runId: string) {
    const empty = {
      proposed_task_graph_used: false,
      proposed_node_count: 0,
      proposed_edge_count: 0,
      read_only_ready_count: 0,
      future_write_candidate_count: 0,
      blocked_count: 0,
      duplicate_count: 0,
      cycle_count: 0,
      scope_overlap_count: 0,
      graph_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const graph = store.get<{ graph_id: string; node_count: number; edge_count: number; summary_ref?: string }>(
          "SELECT graph_id, node_count, edge_count, summary_ref FROM factory_proposed_task_graphs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          runId
        );
        if (!graph) return empty;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status = 'read_only_ready'", runId)?.count ?? 0;
        const future = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status IN ('future_write_candidate', 'ready_for_approval_gate')", runId)?.count ?? 0;
        const blocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND (status = 'blocked' OR status LIKE 'needs_%')", runId)?.count ?? 0;
        const duplicate = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status = 'duplicate'", runId)?.count ?? 0;
        const validation = store.get<{ cycle_count: number; scope_overlap_count: number }>(
          "SELECT cycle_count, scope_overlap_count FROM factory_proposed_task_graph_validations WHERE run_id = ? AND graph_id = ? ORDER BY created_at DESC LIMIT 1",
          runId,
          graph.graph_id
        );
        return {
          proposed_task_graph_used: Number(graph.node_count) > 0,
          proposed_node_count: Number(graph.node_count),
          proposed_edge_count: Number(graph.edge_count),
          read_only_ready_count: Number(readOnly),
          future_write_candidate_count: Number(future),
          blocked_count: Number(blocked),
          duplicate_count: Number(duplicate),
          cycle_count: Number(validation?.cycle_count ?? 0),
          scope_overlap_count: Number(validation?.scope_overlap_count ?? 0),
          graph_summary_ref: graph.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async executionReadinessReportSummary(runId: string) {
    const empty = {
      execution_readiness_used: false,
      nodes_evaluated: 0,
      ready_read_only_count: 0,
      future_write_candidate_count: 0,
      requires_human_approval_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      requires_context_count: 0,
      requires_validation_count: 0,
      requires_locks_count: 0,
      readiness_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          node_count: number;
          ready_read_only_count: number;
          future_write_candidate_count: number;
          requires_human_approval_count: number;
          blocked_count: number;
          rejected_count: number;
          requires_context_count: number;
          requires_validation_count: number;
          requires_locks_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_execution_readiness_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          execution_readiness_used: Number(batch.node_count) > 0,
          nodes_evaluated: Number(batch.node_count),
          ready_read_only_count: Number(batch.ready_read_only_count),
          future_write_candidate_count: Number(batch.future_write_candidate_count),
          requires_human_approval_count: Number(batch.requires_human_approval_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          requires_context_count: Number(batch.requires_context_count),
          requires_validation_count: Number(batch.requires_validation_count),
          requires_locks_count: Number(batch.requires_locks_count),
          readiness_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async approvalPromotionReportSummary(runId: string) {
    const empty = {
      promotion_requests_created: 0,
      approvals_required: 0,
      approvals_granted: 0,
      approvals_denied: 0,
      approvals_expired: 0,
      queue_items_created: 0,
      queue_items_blocked: 0,
      read_only_candidates: 0,
      write_candidates_waiting_approval: 0,
      approval_summary_ref: undefined as string | undefined,
      promotion_queue_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const requests = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ?", runId)?.count ?? 0;
        const approvalsRequired = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND approval_required = 1", runId)?.count ?? 0;
        const approvalsGranted = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'approved'", runId)?.count ?? 0;
        const approvalsDenied = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'denied'", runId)?.count ?? 0;
        const approvalsExpired = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'expired'", runId)?.count ?? 0;
        const queueItems = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ?", runId)?.count ?? 0;
        const queueBlocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND queue_status = 'blocked'", runId)?.count ?? 0;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND promotion_type = 'read_only_candidate'", runId)?.count ?? 0;
        const writeWaiting = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND read_or_write_classification <> 'read_only' AND status = 'awaiting_human_approval'", runId)?.count ?? 0;
        const summary = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_artifacts WHERE run_id = ? AND artifact_kind = 'promotion_queue_summary' ORDER BY created_at DESC LIMIT 1", runId);
        const batch = summary ? undefined : store.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_execution_readiness_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        const batchMetadata = parseJsonRecord(batch?.metadata_json);
        const summaryRef = summary?.artifact_ref ?? (typeof batchMetadata.promotion_queue_summary_ref === "string" ? batchMetadata.promotion_queue_summary_ref : undefined);
        return {
          promotion_requests_created: Number(requests),
          approvals_required: Number(approvalsRequired),
          approvals_granted: Number(approvalsGranted),
          approvals_denied: Number(approvalsDenied),
          approvals_expired: Number(approvalsExpired),
          queue_items_created: Number(queueItems),
          queue_items_blocked: Number(queueBlocked),
          read_only_candidates: Number(readOnly),
          write_candidates_waiting_approval: Number(writeWaiting),
          approval_summary_ref: summaryRef,
          promotion_queue_summary_ref: summaryRef
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async executionPreparationReportSummary(runId: string) {
    const empty = {
      execution_preparation_used: false,
      preparation_plan_count: 0,
      prepared_count: 0,
      blocked_count: 0,
      missing_approval_count: 0,
      missing_context_count: 0,
      missing_prompt_count: 0,
      missing_validation_count: 0,
      missing_locks_count: 0,
      stale_context_count: 0,
      preparation_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          plan_count: number;
          prepared_count: number;
          blocked_count: number;
          missing_approval_count: number;
          missing_context_count: number;
          missing_prompt_count: number;
          missing_validation_count: number;
          missing_locks_count: number;
          stale_context_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_execution_preparation_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          execution_preparation_used: Number(batch.plan_count) > 0,
          preparation_plan_count: Number(batch.plan_count),
          prepared_count: Number(batch.prepared_count),
          blocked_count: Number(batch.blocked_count),
          missing_approval_count: Number(batch.missing_approval_count),
          missing_context_count: Number(batch.missing_context_count),
          missing_prompt_count: Number(batch.missing_prompt_count),
          missing_validation_count: Number(batch.missing_validation_count),
          missing_locks_count: Number(batch.missing_locks_count),
          stale_context_count: Number(batch.stale_context_count),
          preparation_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async oneWriterDryRunReportSummary(runId: string) {
    const empty = {
      one_writer_dry_run_used: false,
      dry_run_proposal_count: 0,
      generated_count: 0,
      schema_failed_count: 0,
      scope_failed_count: 0,
      blocked_count: 0,
      review_candidate_count: 0,
      changed_files_preview: [] as string[],
      dry_run_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          proposal_count: number;
          generated_count: number;
          schema_failed_count: number;
          scope_failed_count: number;
          blocked_count: number;
          review_candidate_count: number;
          changed_files_preview_json: string;
          summary_ref?: string;
        }>("SELECT * FROM factory_dry_run_writer_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          one_writer_dry_run_used: Number(batch.proposal_count) > 0,
          dry_run_proposal_count: Number(batch.proposal_count),
          generated_count: Number(batch.generated_count),
          schema_failed_count: Number(batch.schema_failed_count),
          scope_failed_count: Number(batch.scope_failed_count),
          blocked_count: Number(batch.blocked_count),
          review_candidate_count: Number(batch.review_candidate_count),
          changed_files_preview: parseJsonArray(batch.changed_files_preview_json).map(String),
          dry_run_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async patchProposalReviewReportSummary(runId: string) {
    const empty = {
      patch_review_used: false,
      patch_reviews_count: 0,
      accepted_for_validation_candidate_count: 0,
      changes_requested_count: 0,
      rejected_count: 0,
      blocked_count: 0,
      review_schema_failed_count: 0,
      critical_findings_count: 0,
      high_findings_count: 0,
      review_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          review_count: number;
          accepted_for_validation_candidate_count: number;
          changes_requested_count: number;
          rejected_count: number;
          blocked_count: number;
          review_schema_failed_count: number;
          critical_findings_count: number;
          high_findings_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_patch_review_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          patch_review_used: Number(batch.review_count) > 0,
          patch_reviews_count: Number(batch.review_count),
          accepted_for_validation_candidate_count: Number(batch.accepted_for_validation_candidate_count),
          changes_requested_count: Number(batch.changes_requested_count),
          rejected_count: Number(batch.rejected_count),
          blocked_count: Number(batch.blocked_count),
          review_schema_failed_count: Number(batch.review_schema_failed_count),
          critical_findings_count: Number(batch.critical_findings_count),
          high_findings_count: Number(batch.high_findings_count),
          review_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async validationCandidateReportSummary(runId: string) {
    const empty = {
      validation_candidate_used: false,
      validation_candidate_count: 0,
      preflight_passed_count: 0,
      incomplete_count: 0,
      command_blocked_count: 0,
      environment_blocked_count: 0,
      rejected_count: 0,
      validation_candidate_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          candidate_count: number;
          preflight_passed_count: number;
          incomplete_count: number;
          command_blocked_count: number;
          environment_blocked_count: number;
          rejected_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_validation_candidate_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          validation_candidate_used: Number(batch.candidate_count) > 0,
          validation_candidate_count: Number(batch.candidate_count),
          preflight_passed_count: Number(batch.preflight_passed_count),
          incomplete_count: Number(batch.incomplete_count),
          command_blocked_count: Number(batch.command_blocked_count),
          environment_blocked_count: Number(batch.environment_blocked_count),
          rejected_count: Number(batch.rejected_count),
          validation_candidate_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async patchApplySandboxReportSummary(runId: string) {
    const empty = {
      patch_apply_sandbox_used: false,
      sandbox_result_count: 0,
      dry_apply_passed_count: 0,
      dry_apply_failed_count: 0,
      conflict_count: 0,
      failed_hunk_count: 0,
      sandbox_unavailable_count: 0,
      main_repo_integrity_ok: true,
      sandbox_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          result_count: number;
          dry_apply_passed_count: number;
          dry_apply_failed_count: number;
          conflict_count: number;
          failed_hunk_count: number;
          sandbox_unavailable_count: number;
          main_repo_integrity_ok: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_patch_apply_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          patch_apply_sandbox_used: Number(batch.result_count) > 0,
          sandbox_result_count: Number(batch.result_count),
          dry_apply_passed_count: Number(batch.dry_apply_passed_count),
          dry_apply_failed_count: Number(batch.dry_apply_failed_count),
          conflict_count: Number(batch.conflict_count),
          failed_hunk_count: Number(batch.failed_hunk_count),
          sandbox_unavailable_count: Number(batch.sandbox_unavailable_count),
          main_repo_integrity_ok: Number(batch.main_repo_integrity_ok) === 1,
          sandbox_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async sandboxValidationReportSummary(runId: string) {
    const empty = {
      sandbox_validation_used: false,
      sandbox_validation_count: 0,
      sandbox_validation_passed_count: 0,
      sandbox_validation_failed_count: 0,
      sandbox_validation_blocked_count: 0,
      sandbox_validation_partial_count: 0,
      sandbox_validation_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          result_count: number;
          passed_count: number;
          failed_count: number;
          blocked_count: number;
          partial_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_sandbox_validation_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          sandbox_validation_used: Number(batch.result_count) > 0,
          sandbox_validation_count: Number(batch.result_count),
          sandbox_validation_passed_count: Number(batch.passed_count),
          sandbox_validation_failed_count: Number(batch.failed_count),
          sandbox_validation_blocked_count: Number(batch.blocked_count),
          sandbox_validation_partial_count: Number(batch.partial_count),
          sandbox_validation_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async sandboxIntegrationCandidateReportSummary(runId: string) {
    const empty = {
      sandbox_integration_candidate_used: false,
      integration_candidate_count: 0,
      candidate_created_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      validation_failed_count: 0,
      validation_blocked_count: 0,
      candidate_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          candidate_count: number;
          candidate_created_count: number;
          blocked_count: number;
          rejected_count: number;
          validation_failed_count: number;
          validation_blocked_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_sandbox_integration_candidate_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          sandbox_integration_candidate_used: Number(batch.candidate_count) > 0,
          integration_candidate_count: Number(batch.candidate_count),
          candidate_created_count: Number(batch.candidate_created_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          validation_failed_count: Number(batch.validation_failed_count),
          validation_blocked_count: Number(batch.validation_blocked_count),
          candidate_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async integrationApplyApprovalReportSummary(runId: string) {
    const empty = {
      integration_apply_approval_used: false,
      apply_approval_count: 0,
      approved_for_apply_candidate_count: 0,
      requires_human_approval_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      dirty_worktree_blocked_count: 0,
      apply_mode_recommendation_count: 0,
      apply_approval_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          approval_count: number;
          approved_for_apply_candidate_count: number;
          requires_human_approval_count: number;
          blocked_count: number;
          rejected_count: number;
          dirty_worktree_blocked_count: number;
          apply_mode_recommendation_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_integration_apply_approval_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          integration_apply_approval_used: Number(batch.approval_count) > 0,
          apply_approval_count: Number(batch.approval_count),
          approved_for_apply_candidate_count: Number(batch.approved_for_apply_candidate_count),
          requires_human_approval_count: Number(batch.requires_human_approval_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          dirty_worktree_blocked_count: Number(batch.dirty_worktree_blocked_count),
          apply_mode_recommendation_count: Number(batch.apply_mode_recommendation_count),
          apply_approval_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async controlledApplyReportSummary(runId: string) {
    const empty = {
      controlled_apply_used: false,
      controlled_apply_count: 0,
      applied_count: 0,
      post_validation_passed_count: 0,
      post_validation_failed_count: 0,
      rolled_back_count: 0,
      rollback_failed_count: 0,
      lock_failed_count: 0,
      blocked_count: 0,
      controlled_apply_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          controlled_apply_count: number;
          applied_count: number;
          post_validation_passed_count: number;
          post_validation_failed_count: number;
          rolled_back_count: number;
          rollback_failed_count: number;
          lock_failed_count: number;
          blocked_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_controlled_apply_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          controlled_apply_used: Number(batch.controlled_apply_count) > 0,
          controlled_apply_count: Number(batch.controlled_apply_count),
          applied_count: Number(batch.applied_count),
          post_validation_passed_count: Number(batch.post_validation_passed_count),
          post_validation_failed_count: Number(batch.post_validation_failed_count),
          rolled_back_count: Number(batch.rolled_back_count),
          rollback_failed_count: Number(batch.rollback_failed_count),
          lock_failed_count: Number(batch.lock_failed_count),
          blocked_count: Number(batch.blocked_count),
          controlled_apply_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async integrationFinalizationReportSummary(runId: string) {
    const empty = {
      integration_finalization_used: false,
      integration_finalization_count: 0,
      finalized_count: 0,
      validation_failed_count: 0,
      rollback_completed_count: 0,
      rollback_failed_count: 0,
      memory_entries_created_count: 0,
      lessons_created_count: 0,
      finalization_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          integration_finalization_count: number;
          finalized_count: number;
          validation_failed_count: number;
          rollback_completed_count: number;
          rollback_failed_count: number;
          memory_entries_created_count: number;
          lessons_created_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_integration_finalization_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          integration_finalization_used: Number(batch.integration_finalization_count) > 0,
          integration_finalization_count: Number(batch.integration_finalization_count),
          finalized_count: Number(batch.finalized_count),
          validation_failed_count: Number(batch.validation_failed_count),
          rollback_completed_count: Number(batch.rollback_completed_count),
          rollback_failed_count: Number(batch.rollback_failed_count),
          memory_entries_created_count: Number(batch.memory_entries_created_count),
          lessons_created_count: Number(batch.lessons_created_count),
          finalization_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  private async promptWriterReportSummary(tasks: Task[]) {
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

  private async lockReportSummary(run: Run, tasks: Task[]) {
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

  private async transitionRun(run: Run, status: RunStatus, message: string, options: {
    trigger?: RunTransitionTrigger;
    taskId?: string;
    artifactRefs?: string[];
    mode?: "normal" | "plan_only";
    validationStatus?: "passed" | "failed" | "blocked" | "skipped" | "partial" | "not_required" | "not_run";
  } = {}) {
    const previous = run.status;
    const requested = await this.traceWriter.recordRunTransitionRequested({
      runId: run.id,
      previousStatus: previous,
      nextStatus: status,
      reason: message,
      sourceComponent: "CoreOrchestrator",
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
        sourceComponent: "CoreOrchestrator",
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
        sourceComponent: "CoreOrchestrator",
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
        source_component: "CoreOrchestrator",
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

  private async recordRunTransition(runId: string, previous: RunStatus | undefined, status: RunStatus, message: string, sourceComponent: string) {
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

export async function loadRunDetails(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  const run = await store.loadRun(runId);
  const tasks = await store.loadTasks(runId);
  return { run, tasks };
}

export async function loadTaskDetails(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  const tasks = await store.loadTasks(runId);
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return { task };
}

export async function listOrchestrationRuns(workspacePath: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listRuns();
}

export async function loadContextPackForTask(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadContextPack(runId, taskId);
}

export async function loadRunEvents(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listRunEvents(runId);
}

export async function loadTaskArtifacts(workspacePath: string, runId: string, taskId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listTaskArtifacts(runId, taskId);
}

export async function loadValidationLogs(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listValidationLogs(runId);
}

export async function loadPatchHistory(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.listPatchHistory(runId);
}

export async function resumeOrchestrationRun(workspacePath: string, runId: string, memoryDir?: string) {
  return new CoreOrchestrator({ workspacePath, memoryDir }).resumeRun(runId);
}

export async function loadFinalRunReport(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadFinalReport(runId);
}

export async function loadRunMetrics(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.loadRunMetrics(runId);
}

export async function loadRunArtifactTree(workspacePath: string, runId: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.artifactTree(runId);
}

export async function readRunArtifact(workspacePath: string, runId: string, artifactPath: string, memoryDir?: string) {
  const store = new OrchestrationArtifactStore(path.resolve(workspacePath), memoryDir);
  return store.readArtifactText(runId, artifactPath);
}

function chooseHighSignalFiles(request: string, repoIndex: RepoIndex) {
  const normalized = request.toLowerCase();
  const directMatches = repoIndex.sourceFiles
    .filter((file) => normalized.includes(path.basename(file).replace(path.extname(file), "").toLowerCase()))
    .slice(0, 6);
  return uniqueStrings([
    ...directMatches,
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.docFiles
  ]).slice(0, 8);
}

function splitExecutorObjectives(userRequest: string) {
  const normalized = userRequest.trim();
  const parts = normalized
    .split(/\bthen\b|;|\n/gi)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12)
    .slice(0, 3);
  if (parts.length > 1) {
    return parts.map((part) => `Execute this narrow slice only: ${part}`);
  }
  if (/\b(refactor|rewrite|whole|entire|all)\b/i.test(normalized)) {
    return [
      `Inspect and propose the smallest safe first step for: ${normalized}`,
      `Execute only the first scoped implementation step for: ${normalized}`
    ];
  }
  return [`Execute the first narrow, auditable task for: ${normalized}`];
}

function inferAllowedEditScope(objective: string, highSignalFiles: string[]) {
  if (/\b(explain|inspect|summarize|review|scan)\b/i.test(objective)) return [];
  return highSignalFiles.filter((file) => /\.(ts|tsx|js|jsx|rs|py|md|json)$/i.test(file)).slice(0, 4);
}

function taskEditLockScopes(task: Task) {
  const role = getAgentRole(task.role_required);
  if (!role.can_edit_files) return [];
  if (isReadOnlyObjective(task.objective)) return [];
  return task.allowed_files_to_edit.length ? task.allowed_files_to_edit : ["."];
}

function isReadOnlyObjective(objective: string) {
  return /\b(explain|inspect|summarize|review|scan|do not change|read-only)\b/i.test(objective);
}

function mergeVerificationIntoOutput(output: ParsedAgentOutput, verification: VerificationResult) {
  output.validation_results.push(...verification.commands_run.map((run) => ({
    command: run.command,
    status: run.status,
    summary: `Validation ${run.status}${run.exit_code === undefined ? "" : ` (exit ${run.exit_code ?? "none"})`}.`
      + (run.summary ? ` ${run.summary}` : ""),
    required: run.required,
    log_ref: run.log_ref
  })));
  output.artifacts.push(...verification.logs_refs);
  if (verification.next_action === "no_validation_available") {
    output.limitations.push(verification.summary);
  }
  if (verification.next_action === "manual_review") {
    output.limitations.push(verification.summary);
    output.next_recommendations.push("Manually review blocked validation commands before integration.");
  }
}

function summarizeValidationStatus(outputs: ParsedAgentOutput[]): OverallValidationStatus {
  const requiredOutputs = outputs.filter((output) => output.files_changed.length > 0);
  const records = requiredOutputs.flatMap((output) => output.validation_results);
  if (!requiredOutputs.length) return "not_required";
  if (!records.length) return "not_run";
  return aggregateValidationStatus(records.map((record) => ({
    command: record.command,
    status: record.status === "not_required" || record.status === "partial" ? "not_run" : record.status,
    required: record.required ?? true,
    reason: record.summary,
    log_ref: record.log_ref
  }))).status;
}

function finalRunStatus(tasks: Task[], outputs: ParsedAgentOutput[], integration?: FactoryIntegrationResult): RunStatus {
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  const validation = summarizeValidationStatus(outputs);
  if (validation === "failed") return "failed";
  if (validation === "blocked" || validation === "skipped" || validation === "partial" || validation === "not_run") return "blocked";
  if (integration?.status === "failed") return "failed";
  if (integration && integration.status !== "passed" && integration.status !== "not_required") return "blocked";
  return "succeeded";
}

function integrationLimitations(integration: FactoryIntegrationResult) {
  if (integration.status === "passed" || integration.status === "not_required") return [];
  return [
    `Integration did not pass; status is ${integration.status}.`,
    integration.blocked_reason ?? "Integration requires safe apply and fully passed post-integration validation before success."
  ];
}

function teamHierarchySummary(hierarchy: AgentTeamHierarchy, validation: { valid: boolean; budget_warnings: string[] }) {
  return [
    "# Agent Team Hierarchy",
    "",
    `- root_team_id: ${hierarchy.root_team_id ?? "none"}`,
    `- team_count: ${hierarchy.teams.length}`,
    `- max_depth: ${hierarchy.max_depth}`,
    `- valid: ${validation.valid}`,
    "",
    "## Teams",
    ...hierarchy.teams.map((team) => `- ${team.team_id}: ${team.team_type}/${team.domain} (${team.status})`),
    "",
    "## Budget Warnings",
    ...(validation.budget_warnings.length ? validation.budget_warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}

function validationTruthLimitations(run: Run, outputs: ParsedAgentOutput[]) {
  const status = summarizeValidationStatus(outputs);
  const normalized = normalizeValidationStatus(status);
  if (normalized === "passed") return [];
  if (normalized === "not_required") {
    return [run.status === "succeeded"
      ? "Validation not required because this was a plan-only/read-only run."
      : "Validation not required because no mechanical changes required validation."];
  }
  const records = outputs.flatMap((output) => output.validation_results);
  const incomplete = records
    .filter((record) => record.status !== "passed")
    .map((record) => `${record.command}: ${record.status} (${record.summary})`)
    .slice(0, 6);
  return [
    `Validation was not fully passed; overall validation status is ${normalized}.`,
    ...incomplete,
    "Remaining risk: do not treat this run as fully mechanically verified until required validation passes."
  ];
}

async function readOptionalJson<T>(artifactRef: string): Promise<T | undefined> {
  try {
    if (!existsSync(artifactRef)) return undefined;
    return await readJson<T>(artifactRef);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function multiPlanLimitations(result: MultiPlanFactoryResult) {
  if (!result.used) return [`Multi-plan factory was skipped: ${result.trigger.reason}`];
  return [
    `Multi-plan factory used ${result.generation_mode} generation and wrote merged plan ${result.merged_plan?.artifact_ref ?? "unknown"}.`,
    "Merged plan is read-only advisory context; it did not create patches, modify source files, or authorize new executor behavior."
  ];
}

function executorProviderTruthLimitation(outputs: ParsedAgentOutput[]) {
  if (outputs.some((output) => output.limitations.some((entry) => /Provider-backed read-only/i.test(entry)))) {
    return "Read-only Scout/Planner/Reporter roles used configured provider calls; write-capable ExecutorAgent remains separately gated through SeniorCodingAgent and review/validation authority.";
  }
  return outputs.some((output) => output.limitations.some((entry) => /provider-backed planner/i.test(entry)))
    ? "ExecutorAgent used a provider-backed SeniorCodingAgent planner; write output remains gated by review, validation, and patch authority."
    : "ExecutorAgent cannot run because a providerFactory was not wired into the orchestrator.";
}

function summarizeSeniorSession(session: AgentRuntimeSession, task: Task, pack: ContextPack, rawOutputRef: string): ParsedAgentOutput {
  const patchFiles = uniqueStrings(session.patchProposals.flatMap((proposal) => proposal.filesChanged.map((file) => file.path)));
  const outsideScope = patchFiles.filter((file) => task.allowed_files_to_edit.length > 0 && !task.allowed_files_to_edit.includes(file));
  return {
    summary: session.runSummary?.summary ?? session.reasoningSummaries.at(-1) ?? `SeniorCodingAgent finished ${task.id}.`,
    status: session.status === "failed" || outsideScope.length ? "failed" : "succeeded",
    files_changed: patchFiles,
    validation_results: [
      ...pack.validation_requirements.map((command) => ({
        command,
        status: "not_run" as const,
        summary: "Validation selected by context pack; Phase 4 safety runner will execute only allowed safe commands."
      })),
      ...session.commandRequests.map((command) => ({
        command: command.command,
        status: "not_run" as const,
        summary: `Command request recorded with risk ${command.risk}.`
      }))
    ],
    artifacts: [rawOutputRef],
    limitations: [
      seniorSessionProviderTruthLimitation(session),
      ...outsideScope.map((file) => `Proposed file outside allowed scope: ${file}`)
    ],
    next_recommendations: [
      session.nextAction?.message ?? "Review executor output before applying any patch.",
      "Inspect Phase 4 review, validation, and patch safety artifacts before applying changes."
    ]
  };
}

function seniorSessionProviderTruthLimitation(session: AgentRuntimeSession) {
  if (session.mode === "real_provider") {
    return "ExecutorAgent invoked the existing SeniorCodingAgent path with a provider-backed planner; write output remains gated by review, validation, and patch authority.";
  }
  return "ExecutorAgent requires a configured provider-backed SeniorCodingAgent path.";
}

function normalizeProviderReadOnlyOutput(value: unknown): ParsedAgentOutput {
  if (!isRecord(value)) {
    return {
      summary: "Provider returned invalid read-only role output.",
      status: "failed",
      files_changed: [],
      validation_results: [],
      artifacts: [],
      limitations: ["Provider-backed read-only role output was not a JSON object; no deterministic fallback was accepted."],
      next_recommendations: ["Inspect the raw provider output artifact and retry with a schema-following provider response."]
    };
  }
  return {
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary : "Provider-backed read-only role returned no summary.",
    status: value.status === "succeeded" || value.status === "failed" || value.status === "blocked" ? value.status : "failed",
    files_changed: [],
    validation_results: Array.isArray(value.validation_results) ? value.validation_results as ParsedAgentOutput["validation_results"] : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((entry): entry is string => typeof entry === "string") : [],
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((entry): entry is string => typeof entry === "string") : [],
    next_recommendations: Array.isArray(value.next_recommendations) ? value.next_recommendations.filter((entry): entry is string => typeof entry === "string") : []
  };
}

function deterministicSummary(role: AgentRoleName, task: Task, pack: ContextPack) {
  if (role === "ScoutAgent") {
    return `Scout selected ${pack.relevant_files.length} relevant file(s), ${pack.validation_requirements.length} validation requirement(s), and ${pack.repo_index_refs.length} memory ref(s).`;
  }
  if (role === "PlannerAgent") {
    return `Planner confirmed a narrow task graph for "${task.objective}" with allowed edit scope: ${task.allowed_files_to_edit.join(", ") || "none"}.`;
  }
  if (role === "ReporterAgent") {
    return "Reporter gathered completed run artifacts for final report generation.";
  }
  return `${role} completed deterministic Phase 2 work for ${task.id}.`;
}

function deterministicRecommendations(role: AgentRoleName, pack: ContextPack) {
  if (role === "ScoutAgent") return [`Read ${pack.relevant_files[0] ?? "the selected context pack"} before implementation.`];
  if (role === "PlannerAgent") return ["Run ExecutorAgent on the first ready implementation task."];
  if (role === "ReporterAgent") return ["Use the final report artifact as the handoff summary."];
  return ["Continue to the next task when dependencies are satisfied."];
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
