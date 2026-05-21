import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentRuntimeSession } from "@orchcode/protocol";
import { appendDecision, appendFailedAttempt, appendSuccessfulPattern, readJson, resolveMemoryPaths } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { SeniorCodingAgent } from "../agents/SeniorCodingAgent.js";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { assessApprovalGate } from "./ApprovalGates.js";
import { ContextPackBuilder } from "./ContextPackBuilder.js";
import { OrchestrationFileLockManager } from "./FileLockManager.js";
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
  type IntegrationResult,
  type VerificationResult
} from "./StructuredOutputs.js";
import { TaskGraphManager } from "./TaskGraphManager.js";
import { ValidationRunner } from "./ValidationRunner.js";
import { computeRunMetrics } from "./Metrics.js";
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
  }

  async planOnly(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.createRun(userRequest);
    await this.writeCheckpoint(run, [], "created", ["Plan-only run created."]);
    await this.transitionRun(run, "indexing", "Loading repository memory for planning.");
    const memory = await this.loadOrRebuildIndex(run);
    await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded for plan-only mode."]);
    await this.transitionRun(run, "planning", "Creating deterministic task graph.");
    const manager = await this.createTaskGraph(run, memory.repoIndex, memory.commandInventory);
    run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
    run.summary = `Planned ${manager.listTasks().length} task(s) for: ${userRequest}`;
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    const report = await this.createFinalReport(run, manager.listTasks(), [], [
      "Plan-only mode did not invoke agents.",
      "Validation commands were selected but not run."
    ]);
    await this.writeCheckpoint(run, manager.listTasks(), "planned", ["Task graph persisted in plan-only mode."]);
    await this.writeRunMetrics(run, manager.listTasks(), report);
    return { run, tasks: manager.listTasks(), report };
  }

  async runAgenticTask(userRequest: string): Promise<AgenticRunResult> {
    const run = await this.createRun(userRequest);
    let manager: TaskGraphManager | undefined;
    const parsedOutputs: ParsedAgentOutput[] = [];
    const fingerprintTracker = new PatchFingerprintTracker();
    const lockManager = new OrchestrationFileLockManager(this.workspacePath, this.config.lock_ttl_ms);
    try {
      await this.writeCheckpoint(run, [], "created", ["Run created."]);
      await this.transitionRun(run, "indexing", "Loading or rebuilding repository index.");
      const memory = await this.loadOrRebuildIndex(run);
      await this.writeCheckpoint(run, [], "indexed", ["Repository memory loaded."]);
      await this.transitionRun(run, "planning", "Creating orchestration task graph.");
      manager = await this.createTaskGraph(run, memory.repoIndex, memory.commandInventory);
      run.root_task_ids = manager.listTasks().filter((task) => !task.parent_id).map((task) => task.id);
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
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
          const lockResult = lockScopes.length ? lockManager.acquire(run.id, task.id, lockScopes) : undefined;
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
              const released = lockManager.releaseByTask(task.id);
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
      await this.transitionRun(run, "verifying", "Validation runner completed safe command execution where available.");
      await this.transitionRun(run, "integrating", "Integrating completed task artifacts into final report.");
      const integration = await this.createIntegrationResult(run, manager.listTasks(), parsedOutputs);
      const failedTasks = manager.listTasks().filter((task) => task.status === "failed" || task.status === "blocked");
      await this.transitionRun(run, failedTasks.length ? "failed" : "succeeded", failedTasks.length ? "One or more tasks failed or blocked." : "Orchestration run succeeded.");
      const report = await this.createFinalReport(run, manager.listTasks(), parsedOutputs, failedTasks.length ? ["Some tasks did not complete successfully."] : []);
      run.summary = report.next_recommendations[0] ?? "Run completed.";
      await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
      await this.writeCheckpoint(run, manager.listTasks(), "final", [`Run completed with status ${run.status}.`]);
      const metrics = await this.writeRunMetrics(run, manager.listTasks(), report);
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
      await this.artifactStore.appendEvent(this.event(run.id, "run.completed", `Run completed with integration status ${integration.final_status}.`, {
        integration,
        metrics
      }));
      return { run, tasks: manager.listTasks(), report };
    } catch (error) {
      run.status = "failed";
      run.updated_at = new Date().toISOString();
      run.summary = error instanceof Error ? error.message : String(error);
      await this.artifactStore.saveRun(run);
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
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    await this.artifactStore.appendEvent(this.event(run.id, "run.resumed", `Resume requested for run ${run.id}.`, {
      index_freshness: freshness.status
    }));
    if (freshness.status !== "fresh") {
      await this.artifactStore.appendEvent(this.event(run.id, "index.stale", "Repository changed since the saved run checkpoint.", {
        changed_files: freshness.changedFiles,
        new_files: freshness.newFiles,
        deleted_files: freshness.deletedFiles
      }));
    }
    await this.writeCheckpoint(run, tasks, "resume_requested", [
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
        max_context_files: this.maxContextFiles,
        max_context_chars: this.maxContextChars,
        max_task_attempts: this.maxTaskAttempts,
        provider_mode: "mock",
        execution_mode: this.config.execution_mode,
        max_tasks_per_run: this.config.max_tasks_per_run,
        max_parallel_tasks: this.config.max_parallel_tasks,
        max_repair_rounds: this.config.max_repair_rounds,
        max_files_per_task: this.config.max_files_per_task,
        max_validation_log_size: this.config.max_validation_log_size,
        max_patch_bytes: this.config.max_patch_bytes,
        lock_ttl_ms: this.config.lock_ttl_ms,
        enable_multi_perspective_review: this.config.enable_multi_perspective_review,
        enable_parallel_execution: this.config.enable_parallel_execution,
        validation_level: this.config.validation_level,
        require_human_approval_for_risky_files: this.config.require_human_approval_for_risky_files,
        validation_timeout: this.config.validation_timeout,
        safe_commands_allowlist: this.config.safe_commands_allowlist
      },
      artifacts_path: paths.runDir
    };
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
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
    const memoryPaths = resolveMemoryPaths(this.workspacePath, this.memoryDir);
    run.memory_snapshot_ref = path.relative(run.artifacts_path, memoryPaths.repoIndex).replaceAll("\\", "/");
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

  private async createTaskGraph(run: Run, repoIndex: RepoIndex, commandInventory: CommandInventory) {
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
      input_context: "Use Phase 1 repo memory and snippets. Read-only.",
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
      input_context: "Use Scout output, repo memory, and command inventory. Read-only.",
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
      input_context: "Use existing SeniorCodingAgent path. Do not write files directly.",
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
    const pack = await contextBuilder.build(run.id, task);
    const packPath = await this.artifactStore.saveContextPack(pack);
    task.artifacts.push(packPath);
    await this.artifactStore.appendEvent(this.event(run.id, "context_pack.created", `Context pack created for ${task.id}.`, {
      context_pack: packPath,
      approximate_size: pack.approximate_size,
      relevant_files: pack.relevant_files
    }, task.id));
    const invocation: AgentInvocation = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `invocation_${randomUUID()}`,
      run_id: run.id,
      task_id: task.id,
      role: role.name,
      prompt: buildRolePrompt(role.name, task, pack),
      context_pack_ref: packPath,
      started_at: new Date().toISOString(),
      status: "running"
    };
    assertValid("AgentInvocation", invocation, validateAgentInvocation);
    await this.artifactStore.saveInvocation(invocation);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.invocation_started", `${role.name} started ${task.id}.`, {
      invocation_id: invocation.id
    }, task.id));

    try {
      const output = role.name === "ExecutorAgent"
        ? await this.invokeExecutor(run, task, pack, invocation)
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
    const session = await sessionManager.createSession({
      workspacePath: this.workspacePath,
      mode: "demo_mock",
      executionMode: "simple_mode",
      userPrompt: invocation.prompt,
      accessProfile: "default_permissions"
    });
    const seniorAgent = new SeniorCodingAgent(new MockLlmProvider(), sessionManager);
    const completed = await seniorAgent.runTurn(session.id, invocation.prompt);
    invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, completed);
    return summarizeSeniorSession(completed, task, pack, invocation.raw_output_ref);
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
      output.status = "failed";
      output.limitations.push(verification.summary);
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

  private async createIntegrationResult(run: Run, tasks: Task[], outputs: ParsedAgentOutput[]): Promise<IntegrationResult> {
    const failedTasks = tasks.filter((task) => task.status === "failed" || task.status === "blocked");
    const result: IntegrationResult = {
      accepted_tasks: tasks.filter((task) => task.status === "succeeded").map((task) => task.id),
      rejected_tasks: failedTasks.map((task) => task.id),
      conflicts: failedTasks.flatMap((task) => task.result_summary?.includes("lock") ? [task.result_summary] : []),
      files_changed: uniqueStrings(outputs.flatMap((output) => output.files_changed)),
      final_status: failedTasks.length ? "partial" : "succeeded",
      notes: failedTasks.length ? ["One or more tasks failed or blocked before integration."] : ["All completed outputs accepted into the final report."]
    };
    const validation = validateStructuredOutput("IntegrationResult", result);
    if (!validation.valid) throw new Error(`IntegrationResult validation failed: ${validation.errors.join("; ")}`);
    const ref = await this.artifactStore.saveIntegrationArtifact(run.id, "integration_result", result);
    await this.artifactStore.appendEvent(this.event(run.id, "integration.decision_recorded", `Integration decision recorded: ${result.final_status}.`, {
      integration_ref: ref,
      result
    }));
    return result;
  }

  private async createFinalReport(run: Run, tasks: Task[], outputs: ParsedAgentOutput[], extraLimitations: string[]): Promise<FinalRunReport> {
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
        "ExecutorAgent uses mock provider mode unless a future phase wires provider selection.",
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
        ...outputs.flatMap((output) => output.limitations),
        ...extraLimitations
      ]),
      next_steps: uniqueStrings([
        ...outputs.flatMap((output) => output.next_recommendations),
        "Inspect review and validation artifacts before applying any proposed patch."
      ]).slice(0, 8)
    };
    assertValid("FinalRunReport", report, validateFinalRunReport);
    const reportPath = await this.artifactStore.saveFinalReport(report);
    await this.artifactStore.appendEvent(this.event(run.id, "run.reported", `Final report written: ${reportPath}`, {
      report: reportPath
    }));
    return report;
  }

  private async transitionRun(run: Run, status: RunStatus, message: string) {
    const previous = run.status;
    run.status = status;
    run.updated_at = new Date().toISOString();
    await this.artifactStore.saveRun(assertValid("Run", run, validateRun));
    await this.artifactStore.appendEvent(this.event(run.id, "run.status_changed", message, {
      previous_status: previous,
      next_status: status
    }));
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
    status: run.status === "passed" ? "passed" as const : run.status === "blocked" ? "blocked" as const : "failed" as const,
    summary: `Validation ${run.status}${run.exit_code === undefined ? "" : ` (exit ${run.exit_code ?? "none"})`}.`
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

function buildRolePrompt(role: AgentRoleName, task: Task, pack: ContextPack) {
  return [
    `Role: ${role}`,
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    "",
    "Allowed files to edit:",
    ...(pack.allowed_files_to_edit.length ? pack.allowed_files_to_edit.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Forbidden files:",
    ...(pack.forbidden_files.length ? pack.forbidden_files.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Relevant files:",
    ...(pack.relevant_files.length ? pack.relevant_files.map((file) => `- ${file}`) : ["- none"]),
    "",
    "Validation requirements:",
    ...(pack.validation_requirements.length ? pack.validation_requirements.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Return structured output and do not claim validation that was not run."
  ].join("\n");
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
      "ExecutorAgent invoked the existing SeniorCodingAgent path in demo mock mode.",
      ...outsideScope.map((file) => `Proposed file outside allowed scope: ${file}`)
    ],
    next_recommendations: [
      session.nextAction?.message ?? "Review executor output before applying any patch.",
      "Inspect Phase 4 review, validation, and patch safety artifacts before applying changes."
    ]
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
