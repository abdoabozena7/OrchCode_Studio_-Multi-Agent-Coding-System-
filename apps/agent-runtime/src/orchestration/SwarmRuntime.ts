import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { appendDecision, appendSuccessfulPattern, getFailedAttempts, resolveMemoryPaths } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { DurableLockManager } from "./DurableLockManager.js";
import { FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { ProviderBackedSwarmWorker, type SwarmProviderWorkerMode } from "./ProviderBackedSwarmWorker.js";
import { createSwarmAgentTemplates } from "./SwarmAgentTemplates.js";
import { SwarmArtifactStore } from "./SwarmArtifactStore.js";
import { createConsensusGroup, createInitialSwarmWorkItems } from "./SwarmFanInOut.js";
import { SwarmScheduler, createAgentInstancesForPlan, type SwarmWorker } from "./SwarmScheduler.js";
import { SwarmStaffingPlanner } from "./SwarmStaffingPlanner.js";
import { transitionRun as createRunTransition, type RunTransitionTrigger } from "./RunStateMachine.js";
import type {
  AgentInstance,
  AgentTemplate,
  StaffingPlan,
  SwarmEvent,
  SwarmMetrics,
  SwarmRun,
  SwarmRunMode,
  SwarmRunResult,
  WorkItem
} from "./SwarmModels.js";
import { MAX_SUPPORTED_LOGICAL_AGENTS, SWARM_SCHEMA_VERSION } from "./SwarmModels.js";

export type SwarmRuntimeOptions = {
  workspacePath: string;
  memoryDir?: string;
  mode?: SwarmRunMode;
  explicitAgentLimit?: number;
  worker?: SwarmWorker;
  workerMode?: SwarmProviderWorkerMode;
  providerFactory?: (role: string) => LlmProvider | undefined;
  providerName?: string;
  modelName?: string;
  responseLanguage?: "ar" | "en";
};

export type SwarmPlanResult = {
  run: SwarmRun;
  staffingPlan: StaffingPlan;
  agentTemplates: AgentTemplate[];
  agentInstances: AgentInstance[];
  workItems: WorkItem[];
};

export class SwarmAutopilotRuntime {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly mode: SwarmRunMode;
  private readonly explicitAgentLimit?: number;
  private readonly artifactStore: SwarmArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly worker?: SwarmWorker;
  private readonly workerMode: SwarmProviderWorkerMode;
  private readonly providerFactory?: (role: string) => LlmProvider | undefined;
  private readonly providerName?: string;
  private readonly modelName?: string;
  private readonly responseLanguage?: "ar" | "en";

  constructor(options: SwarmRuntimeOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.mode = options.mode ?? "auto";
    this.explicitAgentLimit = options.explicitAgentLimit;
    this.artifactStore = new SwarmArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "SwarmAutopilotRuntime" });
    this.worker = options.worker;
    this.workerMode = options.workerMode ?? (options.providerFactory ? "provider_read_only" : envSwarmWorkerMode());
    this.providerFactory = options.providerFactory;
    this.providerName = options.providerName;
    this.modelName = options.modelName;
    this.responseLanguage = options.responseLanguage;
  }

  async plan(userGoal: string): Promise<SwarmPlanResult> {
    const run = await this.createRun(userGoal);
    await this.transition(run, "intake", "Internal swarm intake started.");
    await this.transition(run, "prompt_rewrite", "Prompt rewrite is not implemented in this step; using the goal as provided.");
    await this.transition(run, "clarification_check", "No clarification was required for swarm planning.");
    await this.transition(run, "repo_mapping", "Analyzing repository and task request for internal swarm staffing.");
    const memory = await this.loadOrRebuildIndex(run);
    const previousFailures = await getFailedAttempts(this.workspacePath, this.memoryDir);
    await this.transition(run, "complexity_estimation", "Estimating complexity and repository scope for internal swarm staffing.");
    const staffingPlan = new SwarmStaffingPlanner().createPlan({
      swarmRunId: run.id,
      userGoal,
      mode: this.mode,
      repoIndex: memory.repoIndex,
      commandInventory: memory.commandInventory,
      previousFailures,
      explicitAgentLimit: this.explicitAgentLimit
    });

    await this.transition(run, "staffing_plan", "Internal swarm staffing plan created.");
    const staffingPlanRef = await this.artifactStore.saveStaffingPlan(staffingPlan);
    run.staffing_plan_ref = path.relative(run.artifacts_path, staffingPlanRef).replaceAll("\\", "/");
    run.effective_total_logical_agents = staffingPlan.recommended_total_logical_agents;
    run.scheduler_config = {
      max_parallel_agents: staffingPlan.max_parallel_agents,
      max_parallel_read_only_agents: staffingPlan.max_parallel_agents,
      executor_limit: staffingPlan.executor_limit,
      write_agent_limit: staffingPlan.write_agent_limit,
      reviewer_limit: staffingPlan.reviewer_limit,
      tester_limit: staffingPlan.tester_limit,
      risk_level: staffingPlan.risk_level,
      validation_level: staffingPlan.validation_level,
      backpressure_failure_threshold: staffingPlan.risk_level === "low" ? 3 : 1
    };
    await this.artifactStore.saveSwarmRun(run);
    await this.event(run.id, "swarm.task.analyzed", "Task analysis completed for swarm staffing.", {
      task_complexity: staffingPlan.task_complexity,
      repo_scope: staffingPlan.repo_scope,
      risk_level: staffingPlan.risk_level
    });
    await this.event(run.id, "swarm.staffing_plan.created", "Staffing plan created.", {
      staffing_plan_ref: run.staffing_plan_ref,
      recommended_total_logical_agents: staffingPlan.recommended_total_logical_agents,
      role_counts: staffingPlan.role_counts,
      reasoning: staffingPlan.reasoning
    });
    await this.event(run.id, "swarm.effective_agents.selected", "Effective internal logical agent count selected automatically.", {
      effective_total_logical_agents: run.effective_total_logical_agents,
      max_supported_logical_agents: run.max_supported_logical_agents
    });
    if (staffingPlan.specialist_agents.length) {
      await this.event(run.id, "swarm.specialist_agents.created", "Dynamic specialist agents created from task evidence.", {
        specialists: staffingPlan.specialist_agents
      });
    }

    const templates = createSwarmAgentTemplates(staffingPlan.specialist_agents);
    const instances = createAgentInstancesForPlan({ runId: run.id, staffingPlan, templates });
    const workItems = createInitialSwarmWorkItems({
      swarmRunId: run.id,
      userGoal,
      staffingPlan,
      repoIndex: memory.repoIndex,
      validationCommands: chooseValidationCommands(memory.commandInventory)
    });
    await this.transition(run, "planning", "Dependency-aware swarm work items created.");
    await this.artifactStore.saveAgentTemplates(run.id, templates);
    await this.artifactStore.saveAgentInstances(run.id, instances);
    await this.artifactStore.saveWorkItems(run.id, workItems);
    await this.artifactStore.saveLeases(run.id, []);
    await this.transition(run, "task_graph_ready", "Swarm work-item graph created and persisted.");
    for (const item of workItems) {
      await this.event(run.id, "swarm.work_item.queued", `Queued ${item.type} work item ${item.id}.`, {
        required_role: item.required_role,
        dependencies: item.dependencies,
        read_files: item.read_files,
        write_files: item.write_files
      }, item.id);
    }
    return { run, staffingPlan, agentTemplates: templates, agentInstances: instances, workItems };
  }

  async run(userGoal: string): Promise<SwarmRunResult> {
    const planned = await this.plan(userGoal);
    const run = planned.run;
    await this.transition(run, "executing", "Starting dependency-aware swarm scheduler.");
    const scheduler = new SwarmScheduler(
      this.workspacePath,
      this.artifactStore,
      new DurableLockManager({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        ownerComponent: "SwarmScheduler"
      }),
      this.worker ?? this.createConfiguredWorker()
    );
    const scheduled = await scheduler.run({
      run,
      staffingPlan: planned.staffingPlan,
      agentTemplates: planned.agentTemplates,
      agentInstances: planned.agentInstances,
      workItems: planned.workItems
    });
    run.active_agent_count = scheduled.metrics.peak_active_agents;
    run.metrics_ref = "metrics.json";

    const reviewItems = scheduled.workItems.filter((item) => item.type === "review");
    const consensus = createConsensusGroup({
      swarmRunId: run.id,
      topic: "Final integration readiness",
      participantWorkItems: reviewItems.map((item) => item.id),
      findings: reviewItems
        .slice(0, Math.max(1, planned.staffingPlan.reviewer_count))
        .map((item) => ({
          finding: item.status === "succeeded" ? `${item.id} accepted reviewed work.` : `${item.id} did not complete cleanly.`,
          confidence: item.status === "succeeded" ? 0.82 : 0.45,
          dissent: item.status !== "succeeded"
        }))
    });
    await this.transition(run, "reviewing", "Review work items completed inside the swarm scheduler.");
    await this.transition(run, "validating", "Validation work items completed inside the swarm scheduler.", {
      validationStatus: scheduled.metrics.validation_items ? validationStatusFromSwarmMetrics(scheduled.metrics) : "not_required"
    });
    await this.transition(run, "integrating", "Creating swarm integration consensus.");
    await this.artifactStore.saveConsensus(consensus);
    scheduled.metrics.consensus_groups = 1;
    await this.artifactStore.saveMetrics(run.id, scheduled.metrics);
    await this.event(run.id, "swarm.consensus.created", "Consensus group created for integration readiness.", {
      consensus_id: consensus.id
    });
    await this.event(run.id, "swarm.consensus.decision_made", `Consensus decision: ${consensus.decision}.`, {
      consensus
    });

    const failed = scheduled.workItems.filter((item) => item.status === "failed" || item.status === "blocked");
    const finalStatus = failed.some((item) => item.status === "failed") ? "failed" : failed.length ? "blocked" : "succeeded";
    await this.transition(run, "memory_update", "Recording swarm run memory handoff metadata.");
    await this.transition(run, "reporting", "Writing swarm final report.");
    await this.transition(run, finalStatus, failed.length ? "Swarm run completed with blocked or failed work items." : "Swarm run completed successfully.");
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "report_started",
      lifecycle_stage: "reporting",
      summary: "Swarm final report creation started.",
      metadata_json: {
        final_status: finalStatus
      }
    });
    const finalReport = buildFinalReport({
      run,
      staffingPlan: planned.staffingPlan,
      workItems: scheduled.workItems,
      metrics: scheduled.metrics,
      consensusDecision: consensus.decision,
      workerMode: this.workerMode
    });
    const finalReportRef = await this.artifactStore.saveFinalReport(run.id, finalReport);
    run.final_report_ref = path.relative(run.artifacts_path, finalReportRef).replaceAll("\\", "/");
    await this.artifactStore.saveSwarmRun(run);
    await this.event(run.id, "swarm.run.completed", `Swarm run completed with status ${run.status}.`, {
      metrics_ref: run.metrics_ref,
      final_report_ref: run.final_report_ref
    });
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "memory_append_started",
      lifecycle_stage: "memory_update",
      summary: "Swarm durable memory append started.",
      artifact_refs: [finalReportRef],
      metadata_json: { final_status: run.status }
    });
    await appendDecision(this.workspacePath, {
      agent: "SwarmAutopilotRuntime",
      summary: `Phase 5 swarm run ${run.id} selected ${run.effective_total_logical_agents} logical agents automatically.`,
      rationale: planned.staffingPlan.reasoning.join(" "),
      relatedFiles: scheduled.workItems.flatMap((item) => item.write_files),
      tags: ["phase-5", "internal-swarm", planned.staffingPlan.task_complexity, planned.staffingPlan.risk_level]
    }, this.memoryDir);
    if (run.status === "succeeded") {
      await appendSuccessfulPattern(this.workspacePath, {
        summary: `Internal swarm run ${run.id} completed with ${run.effective_total_logical_agents} logical agents and executor cap ${planned.staffingPlan.executor_limit}.`,
        relatedRunIds: [run.id],
        relatedFiles: scheduled.workItems.flatMap((item) => item.write_files),
        tags: ["phase-5", "swarm-autopilot"]
      }, this.memoryDir);
    }
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "memory_append_completed",
      lifecycle_stage: "memory_update",
      summary: "Swarm durable memory append completed.",
      artifact_refs: [finalReportRef],
      metadata_json: { final_status: run.status }
    });
    return {
      run,
      staffingPlan: planned.staffingPlan,
      agentTemplates: planned.agentTemplates,
      agentInstances: scheduled.agentInstances,
      workItems: scheduled.workItems,
      metrics: scheduled.metrics,
      finalReport
    };
  }

  async inspectRun(runId: string) {
    return {
      run: await this.artifactStore.loadSwarmRun(runId),
      staffingPlan: await this.artifactStore.loadStaffingPlan(runId),
      agentTemplates: await this.artifactStore.loadAgentTemplates(runId),
      agentInstances: await this.artifactStore.loadAgentInstances(runId),
      workItems: await this.artifactStore.loadWorkItems(runId),
      metrics: await optional(() => this.artifactStore.loadMetrics(runId)),
      events: await this.artifactStore.listEvents(runId),
      artifacts: await this.artifactStore.artifactTree(runId)
    };
  }

  async resume(runId: string) {
    const run = await this.artifactStore.loadSwarmRun(runId);
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    const reconciliation = await this.reconcileRunForResume(run);
    await this.event(run.id, "swarm.task.analyzed", `Resume inspected index freshness: ${freshness.status}.`, {
      index_freshness: freshness,
      reconciliation
    });
    if (!reconciliation.ok) {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: "run_resume_mismatch_detected",
        lifecycle_stage: "blocked",
        source_component: "SwarmAutopilotRuntime",
        severity: reconciliation.severity === "failed" ? "error" : "warning",
        reason: reconciliation.reason,
        summary: reconciliation.reason,
        artifact_refs: [run.artifacts_path],
        metadata_json: {
          severity: reconciliation.severity ?? "blocked"
        }
      });
      await this.transition(run, reconciliation.severity === "failed" ? "failed" : "blocked", reconciliation.reason, {
        trigger: "resume"
      });
    }
    return this.inspectRun(runId);
  }

  async report(runId: string) {
    return this.artifactStore.loadFinalReport(runId);
  }

  async staffingPlan(runId: string) {
    return this.artifactStore.loadStaffingPlan(runId);
  }

  async schedulerTrace(runId: string) {
    return this.artifactStore.listSchedulerTrace(runId);
  }

  async metrics(runId: string) {
    return this.artifactStore.loadMetrics(runId);
  }

  async listRuns() {
    return this.artifactStore.listRuns();
  }

  private createConfiguredWorker(): SwarmWorker | undefined {
    return new ProviderBackedSwarmWorker({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      mode: this.workerMode,
      providerFactory: this.providerFactory ?? defaultProviderFactory,
      providerName: this.providerName ?? (process.env.OPENAI_API_KEY ? "openai_compatible" : undefined),
      modelName: this.modelName ?? process.env.OPENAI_MODEL,
      responseLanguage: this.responseLanguage
    }).asWorker();
  }

  private async createRun(userGoal: string): Promise<SwarmRun> {
    const runId = `swarm_${randomUUID()}`;
    const paths = await this.artifactStore.ensureRunLayout(runId);
    const now = new Date().toISOString();
    const run: SwarmRun = {
      schema_version: SWARM_SCHEMA_VERSION,
      id: runId,
      user_goal: userGoal,
      status: "created",
      mode: this.mode,
      staffing_plan_ref: "pending",
      effective_total_logical_agents: 0,
      active_agent_count: 0,
      max_supported_logical_agents: MAX_SUPPORTED_LOGICAL_AGENTS,
      scheduler_config: {
        max_parallel_agents: 1,
        max_parallel_read_only_agents: 1,
        executor_limit: 1,
        write_agent_limit: 1,
        reviewer_limit: 1,
        tester_limit: 1,
        risk_level: "low",
        validation_level: "basic",
        backpressure_failure_threshold: 1
      },
      created_at: now,
      updated_at: now,
      artifacts_path: paths.runDir
    };
    await this.artifactStore.saveSwarmRun(run);
    await this.recordRunTransition(run.id, undefined, "created", "Internal swarm run created.");
    await this.event(run.id, "swarm.run.created", `Internal swarm run created for goal: ${userGoal}`, {
      max_supported_logical_agents: MAX_SUPPORTED_LOGICAL_AGENTS,
      mode: this.mode
    });
    return run;
  }

  private async loadOrRebuildIndex(run: SwarmRun): Promise<{ repoIndex: RepoIndex; commandInventory: CommandInventory }> {
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    const snapshot = await rebuildRepoIndex(this.workspacePath, { memoryDir: this.memoryDir });
    await this.event(run.id, "swarm.task.analyzed", `Repository index loaded for swarm staffing; prior freshness was ${freshness.status}.`, {
      memory_snapshot_ref: "sqlite:factory_memory_snapshots/repo_index",
      freshness_status: freshness.status,
      indexed_files: snapshot.repoIndex.totals.indexedFiles,
      commands: snapshot.commandInventory.commands.length
    });
    return {
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    };
  }

  private async reconcileRunForResume(run: SwarmRun): Promise<{ ok: boolean; reason: string; severity?: "blocked" | "failed" }> {
    const paths = await this.artifactStore.pathsForRun(run.id);
    if (!existsSync(paths.swarmRun)) {
      return { ok: false, reason: `Swarm run artifact is missing: ${paths.swarmRun}`, severity: "failed" };
    }
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
        return { ok: false, reason: `Factory metadata has no swarm run row for ${run.id}.`, severity: "blocked" };
      }
      if (row.status !== run.status) {
        return { ok: false, reason: `Swarm run status mismatch: artifact=${run.status}, metadata=${row.status}.`, severity: "blocked" };
      }
      if (path.resolve(row.run_artifact_ref) !== path.resolve(paths.swarmRun)) {
        return {
          ok: false,
          reason: `Swarm run artifact ref mismatch: artifact=${paths.swarmRun}, metadata=${row.run_artifact_ref}.`,
          severity: "blocked"
        };
      }
      return { ok: true, reason: "Swarm run artifact and factory metadata agree." };
    } finally {
      metadata.close();
    }
  }

  private async transition(run: SwarmRun, status: SwarmRun["status"], message: string, options: {
    trigger?: RunTransitionTrigger;
    validationStatus?: "passed" | "failed" | "blocked" | "skipped" | "partial" | "not_required" | "not_run";
  } = {}) {
    const previous = run.status;
    const requested = await this.traceWriter.recordRunTransitionRequested({
      runId: run.id,
      previousStatus: previous,
      nextStatus: status,
      reason: message,
      sourceComponent: "SwarmAutopilotRuntime",
      trigger: options.trigger
    });
    let record: ReturnType<typeof createRunTransition>;
    try {
      record = createRunTransition(run.id, status, {
        currentStatus: previous,
        reason: message,
        sourceComponent: "SwarmAutopilotRuntime",
        trigger: options.trigger,
        validationStatus: options.validationStatus
      });
    } catch (error) {
      await this.traceWriter.recordRunTransitionRejected({
        runId: run.id,
        previousStatus: previous,
        nextStatus: status,
        reason: error instanceof Error ? error.message : String(error),
        sourceComponent: "SwarmAutopilotRuntime",
        causalParentEventId: requested.trace_event_id,
        trigger: options.trigger
      });
      throw error;
    }
    run.status = status;
    run.updated_at = new Date().toISOString();
    await this.artifactStore.saveSwarmRun(run);
    await this.artifactStore.recordRunTransition(record);
    await this.traceWriter.recordRunTransitionAccepted(record, {
      causalParentEventId: requested.trace_event_id
    });
    if (status === "blocked" || status === "failed") {
      await this.traceWriter.write({
        run_id: run.id,
        event_type: status === "blocked" ? "run_blocked" : "run_failed",
        lifecycle_stage: status,
        previous_status: previous,
        next_status: status,
        source_component: "SwarmAutopilotRuntime",
        severity: status === "blocked" ? "warning" : "error",
        reason: message,
        summary: message,
        metadata_json: {
          transition_record_id: record.id,
          trigger: record.trigger
        }
      });
    }
    await this.event(run.id, "swarm.task.analyzed", message, {
      previous_status: previous,
      status,
      canonical_previous_status: record.canonical_previous_status,
      canonical_next_status: record.canonical_next_status,
      transition_trigger: record.trigger,
      transition_id: record.id
    });
  }

  private async recordRunTransition(runId: string, previous: SwarmRun["status"] | undefined, status: SwarmRun["status"], message: string) {
    const requested = await this.traceWriter.recordRunTransitionRequested({
      runId,
      previousStatus: previous,
      nextStatus: status,
      reason: message,
      sourceComponent: "SwarmAutopilotRuntime"
    });
    const record = createRunTransition(runId, status, {
      currentStatus: previous,
      reason: message,
      sourceComponent: "SwarmAutopilotRuntime"
    });
    await this.artifactStore.recordRunTransition(record);
    await this.traceWriter.recordRunTransitionAccepted(record, {
      causalParentEventId: requested.trace_event_id
    });
  }

  private async event(runId: string, type: SwarmEvent["type"], message: string, payload?: Record<string, unknown>, workItemId?: string) {
    await this.artifactStore.appendEvent({
      id: `event_${randomUUID()}`,
      swarm_run_id: runId,
      work_item_id: workItemId,
      type,
      message,
      created_at: new Date().toISOString(),
      payload
    });
  }
}

export async function loadSwarmRunDetails(workspacePath: string, runId: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).inspectRun(runId);
}

export async function loadSwarmFinalReport(workspacePath: string, runId: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).report(runId);
}

export async function loadSwarmStaffingPlan(workspacePath: string, runId: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).staffingPlan(runId);
}

export async function loadSwarmSchedulerTrace(workspacePath: string, runId: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).schedulerTrace(runId);
}

export async function loadSwarmMetrics(workspacePath: string, runId: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).metrics(runId);
}

export async function listSwarmRuns(workspacePath: string, memoryDir?: string) {
  return new SwarmAutopilotRuntime({ workspacePath, memoryDir }).listRuns();
}

function chooseValidationCommands(commandInventory: CommandInventory) {
  return [
    ...commandInventory.byKind.test.slice(0, 1),
    ...commandInventory.byKind.typecheck.slice(0, 1),
    ...commandInventory.byKind.build.slice(0, 1)
  ].slice(0, 3);
}

function envSwarmWorkerMode(): SwarmProviderWorkerMode {
  return "provider_read_only";
}

function defaultProviderFactory(): LlmProvider | undefined {
  if (!process.env.OPENAI_API_KEY) return undefined;
  return new OpenAIProvider(
    process.env.OPENAI_API_KEY,
    process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
    process.env.OPENAI_MODEL ?? "gpt-4o-mini"
  );
}

function validationStatusFromSwarmMetrics(metrics: SwarmMetrics): "passed" | "failed" | "blocked" | "partial" | "not_required" {
  if (metrics.validation_items === 0) return "not_required";
  if (metrics.validation_pass_rate >= 1) return "passed";
  if (metrics.validation_pass_rate <= 0) return "failed";
  return "partial";
}

function buildFinalReport(input: {
  run: SwarmRun;
  staffingPlan: StaffingPlan;
  workItems: WorkItem[];
  metrics: SwarmMetrics;
  consensusDecision: string;
  workerMode: SwarmProviderWorkerMode;
}) {
  const plannedWriteTargets = uniqueStrings(input.workItems.flatMap((item) => item.write_files));
  const actualChangedFiles: string[] = [];
  const terminalStatus = input.run.status;
  const completedItems = input.workItems.filter((item) => item.status === "succeeded").length;
  const integrationTruth = terminalStatus === "succeeded"
    ? "Swarm finished successfully; accepted patch/application evidence is still reported separately from planned write targets."
    : completedItems === 0
      ? "No work item completed successfully, so no integration or patch was accepted."
      : "Some work items completed, but the swarm did not reach a successful integration state.";
  const roleDistribution = Object.entries(input.metrics.role_distribution)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, count]) => `- ${role}: ${count}`)
    .join("\n");
  const validationSummary = input.metrics.validation_items
    ? `${input.metrics.validation_items} validation item(s), pass rate ${input.metrics.validation_pass_rate}`
    : "No validation work items were required.";
  return [
    `# Internal Swarm Autopilot Report`,
    "",
    `## User Goal`,
    input.run.user_goal,
    "",
    `## Internal Decision`,
    `The system selected ${input.staffingPlan.recommended_total_logical_agents} internal logical agent(s) automatically. The user did not need to choose an agent count.`,
    `300 is treated as the maximum supported internal capacity, not a default.`,
    "",
    `## Staffing Plan`,
    `- Complexity: ${input.staffingPlan.task_complexity}`,
    `- Repository scope: ${input.staffingPlan.repo_scope}`,
    `- Risk level: ${input.staffingPlan.risk_level}`,
    `- Max parallel agents: ${input.staffingPlan.max_parallel_agents}`,
    `- Executor limit: ${input.staffingPlan.executor_limit}`,
    `- Read-only ratio: ${input.staffingPlan.read_only_ratio}`,
    `- Validation level: ${input.staffingPlan.validation_level}`,
    `- Human approval required: ${input.staffingPlan.requires_human_approval}`,
    "",
    `## Why This Agent Count`,
    ...input.staffingPlan.reasoning.map((reason) => `- ${reason}`),
    "",
    `## Role Distribution`,
    roleDistribution || "- none",
    "",
    `## Dynamic Specialists`,
    input.staffingPlan.specialist_agents.length
      ? input.staffingPlan.specialist_agents.map((specialist) => `- ${specialist.role}: ${specialist.trigger}`).join("\n")
      : "- none",
    "",
    `## Execution`,
    `- Work items created: ${input.metrics.work_items_created}`,
    `- Work items completed: ${input.metrics.work_items_completed}`,
    `- Work items failed or blocked: ${input.metrics.work_items_failed}`,
    `- Read-only work items: ${input.metrics.read_only_items}`,
    `- Edit work items: ${input.metrics.edit_items}`,
    `- Review work items: ${input.metrics.review_items}`,
    `- Consensus decision: ${input.consensusDecision}`,
    `- Terminal status: ${terminalStatus}`,
    `- Integration truth: ${integrationTruth}`,
    "",
    `## Review And Validation`,
    `- Reviewer peak count: ${input.metrics.reviewer_peak_count}`,
    `- Scout peak count: ${input.metrics.scout_peak_count}`,
    `- Executor peak count: ${input.metrics.executor_peak_count}`,
    `- ${validationSummary}`,
    "",
    `## File-Lock And Write Safety`,
    `- Write-capable agents were capped at ${input.staffingPlan.write_agent_limit}.`,
    `- Lock waits: ${input.metrics.lock_wait_count}`,
    `- Conflicts detected: ${input.metrics.conflicts_detected}`,
    "",
    `## Files Changed`,
    actualChangedFiles.length ? actualChangedFiles.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    `## Planned Write Targets`,
    plannedWriteTargets.length ? plannedWriteTargets.map((file) => `- ${file} (planned only; no accepted patch is implied)`).join("\n") : "- none",
    "",
    `## Risks And Limitations`,
    `- Logical agents are internal scheduling units and do not map one-to-one to OS processes.`,
    `- Provider-backed read-only workers were used for eligible non-writing work items; write-capable work remains guarded by approval and validation gates.`,
    `- Any high-risk write path still requires approval and validation before integration.`
  ].join("\n");
}

async function optional<T>(loader: () => Promise<T>): Promise<T | undefined> {
  try {
    return await loader();
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
