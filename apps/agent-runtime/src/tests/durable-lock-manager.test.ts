import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  CoreOrchestrator,
  DurableLockManager,
  FactoryMetadataStore,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationFileLockManager,
  PromptWriterService,
  SwarmArtifactStore,
  SwarmScheduler,
  createAgentInstancesForPlan,
  defaultMockWorker,
  durableLocksConflict,
  moduleLocksForTask,
  reconstructFactoryRunTrace,
  renderRolePrompt,
  rolePromptInputFromTask,
  semanticLocksForTask,
  type AgentTemplate,
  type ContextPack,
  type StaffingPlan,
  type SwarmRun,
  type Task,
  type WorkItem
} from "../orchestration/index.js";
import { ContextPackBuilder } from "../orchestration/ContextPackBuilder.js";
import { SWARM_SCHEMA_VERSION } from "../orchestration/SwarmModels.js";

test("durable locks persist acquisition rejection refs and normalized scope keys", async () => {
  const workspace = await fixtureWorkspace("durable-lock-basic");
  try {
    const locks = new DurableLockManager({ workspacePath: workspace, ttlMs: 60_000 });
    const first = await locks.acquireFileLock("run_lock_basic", "task_a", "src/index.ts", "write");
    assert.equal(first.acquired, true);
    assert.match(first.locks[0].normalized_scope_key, /^file:src\/index\.ts$/);
    assert.equal(existsSync(first.artifact_refs[0]), true);

    const second = await locks.acquireFileLock("run_lock_basic", "task_b", "./src/index.ts", "write");
    assert.equal(second.acquired, false);
    assert.equal(second.conflicts[0]?.existing_lock.task_id, "task_a");
    assert.equal(existsSync(second.artifact_refs[1]), true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const rows = metadata.all<{ lock_id: string; status: string; normalized_scope_key: string; artifact_ref: string; metadata_json: string }>(
        "SELECT lock_id, status, normalized_scope_key, artifact_ref, metadata_json FROM factory_locks WHERE run_id = ? ORDER BY created_at",
        "run_lock_basic"
      );
      assert.equal(rows.some((row) => row.status === "acquired"), true);
      assert.equal(rows.some((row) => row.status === "rejected"), true);
      assert.equal(rows.every((row) => row.normalized_scope_key === "file:src/index.ts"), true);
      assert.equal(rows.every((row) => existsSync(row.artifact_ref)), true);
      assert.doesNotMatch(rows.map((row) => row.metadata_json).join("\n"), /export const/);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("durable file and directory conflict policy supports read read release and recovery", async () => {
  const workspace = await fixtureWorkspace("durable-lock-conflicts");
  try {
    const locks = new DurableLockManager({ workspacePath: workspace, ttlMs: 60_000 });
    const readA = await locks.acquireFileLock("run_lock_conflict", "task_read_a", "src/index.ts", "read");
    assert.equal(readA.acquired, true);
    const readB = await locks.acquireFileLock("run_lock_conflict", "task_read_b", "src/index.ts", "read");
    assert.equal(readB.acquired, true);
    const writeBlocked = await locks.acquireFileLock("run_lock_conflict", "task_write", "src/index.ts", "write");
    assert.equal(writeBlocked.acquired, false);

    await locks.releaseLocks({ runId: "run_lock_conflict", taskId: "task_read_a" });
    await locks.releaseLocks({ runId: "run_lock_conflict", taskId: "task_read_b" });
    assert.equal((await locks.acquireFileLock("run_lock_conflict", "task_write", "src/index.ts", "write")).acquired, true);
    await locks.releaseLocks({ runId: "run_lock_conflict", taskId: "task_write" });

    const dir = await locks.acquireLocks({
      request_id: "lock_request_dir",
      run_id: "run_lock_conflict",
      task_id: "task_dir",
      owner_component: "test",
      scopes: [locks.normalizeLockScope("src/", "write")],
      ttl_ms: 60_000,
      reason: "directory write"
    });
    assert.equal(dir.acquired, true);
    const child = await locks.acquireFileLock("run_lock_conflict", "task_child", "src/index.ts", "write");
    assert.equal(child.acquired, false);
    await locks.releaseLocks({ runId: "run_lock_conflict", taskId: "task_dir" });

    const expiringLocks = new DurableLockManager({ workspacePath: workspace, ttlMs: 25 });
    const expiring = await expiringLocks.acquireFileLock("run_lock_conflict", "task_expiring", "src/helper.ts", "write");
    assert.equal(expiring.acquired, true);
    await new Promise((resolve) => setTimeout(resolve, 35));
    const recovered = await expiringLocks.recoverExpiredLocks("run_lock_conflict");
    assert.equal(recovered.recovered.length >= 1, true);
    assert.equal((await locks.acquireFileLock("run_lock_conflict", "task_after_expire", "src/helper.ts", "write")).acquired, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("semantic and module locks derive deterministic keys and advisory unknowns do not block", async () => {
  const workspace = await fixtureWorkspace("durable-lock-semantic");
  try {
    const task = fakeTask("run_semantic", "task_semantic", {
      allowed_files_to_edit: [
        "apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts",
        "apps/agent-runtime/src/orchestration/PromptSystem.ts",
        "package.json"
      ],
      relevant_files: ["apps/agent-runtime/src/orchestration/DurableLockManager.ts"]
    });
    const modules = moduleLocksForTask(task);
    const semantics = semanticLocksForTask(task);
    assert.ok(modules.some((scope) => scope.normalized_scope_key === "module:orchestration"));
    assert.ok(semantics.some((scope) => scope.normalized_scope_key === "semantic:database-schema"));
    assert.ok(semantics.some((scope) => scope.normalized_scope_key === "semantic:prompt-system"));
    assert.ok(semantics.some((scope) => scope.normalized_scope_key === "semantic:dependency-manifest"));

    const unknown = semanticLocksForTask(fakeTask("run_semantic", "task_unknown", {
      allowed_files_to_edit: ["misc/readme.txt"],
      relevant_files: []
    }));
    assert.equal(unknown[0].mode, "advisory");

    const locks = new DurableLockManager({ workspacePath: workspace, ttlMs: 60_000 });
    const first = await locks.acquireSemanticLock("run_semantic", "task_a", "semantic:prompt-system", "write");
    assert.equal(first.acquired, true);
    const second = await locks.acquireSemanticLock("run_semantic", "task_b", "semantic:prompt-system", "write");
    assert.equal(second.acquired, false);
    const advisory = await locks.acquireLocks({
      request_id: "lock_request_advisory",
      run_id: "run_semantic",
      task_id: "task_advisory",
      owner_component: "test",
      scopes: [unknown[0]],
      ttl_ms: 60_000,
      reason: "advisory unknown"
    });
    assert.equal(advisory.acquired, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("durable locks emit trace events including derived semantic and module locks", async () => {
  const workspace = await fixtureWorkspace("durable-lock-trace");
  try {
    const locks = new DurableLockManager({ workspacePath: workspace, ttlMs: 60_000 });
    const task = fakeTask("run_lock_trace", "task_trace", {
      allowed_files_to_edit: ["apps/agent-runtime/src/orchestration/PromptSystem.ts"],
      relevant_files: []
    });
    const result = await locks.acquireLocks({
      request_id: "lock_request_trace",
      run_id: task.run_id,
      task_id: task.id,
      owner_component: "test",
      scopes: [
        locks.normalizeLockScope("apps/agent-runtime/src/orchestration/PromptSystem.ts", "write"),
        ...locks.deriveModuleLocksForTask(task),
        ...locks.deriveSemanticLocksForTask(task)
      ],
      ttl_ms: 60_000,
      reason: "trace derived locks"
    });
    assert.equal(result.acquired, true);
    await locks.heartbeatLocks({ runId: task.run_id, taskId: task.id });
    await locks.releaseLocks({ runId: task.run_id, taskId: task.id });
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: task.run_id });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("lock_requested"));
    assert.ok(events.has("lock_acquired"));
    assert.ok(events.has("lock_released"));
    assert.ok(events.has("lock_heartbeat"));
    assert.ok(events.has("semantic_lock_derived"));
    assert.ok(events.has("module_lock_derived"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator acquires durable executor locks and rejects conflicts before invocation", async () => {
  const workspace = await fixtureWorkspace("durable-lock-core");
  try {
    const clean = await new CoreOrchestrator({
      workspacePath: workspace,
      maxContextFiles: 3,
      maxContextChars: 2500,
      config: {
        prompt_writer_mode: "off",
        enable_multi_plan_factory: false
      }
    }).runAgenticTask("Change src/index.ts in a small safe way.");
    assert.ok((clean.report.locks_acquired ?? 0) > 0);
    assert.equal(clean.report.active_locks_at_end, 0);

    const blocker = new DurableLockManager({ workspacePath: workspace, ttlMs: 600_000 });
    const blockerResult = await blocker.acquireFileLock("external_run", "external_task", "src/index.ts", "write");
    assert.equal(blockerResult.acquired, true);
    const blocked = await new CoreOrchestrator({
      workspacePath: workspace,
      maxContextFiles: 3,
      maxContextChars: 2500,
      config: {
        prompt_writer_mode: "off",
        enable_multi_plan_factory: false
      }
    }).runAgenticTask("Change src/index.ts in a small safe way.");
    assert.equal(blocked.tasks.some((task) => task.status === "blocked"), true);
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: blocked.run.id });
    assert.ok(trace.events.some((event) => event.event_type === "lock_rejected" || event.event_type === "lock_conflict_detected"));
    const executorStarted = trace.events.some((event) => event.event_type === "agent_invocation_started" && /ExecutorAgent/i.test(JSON.stringify(event.metadata_json)));
    assert.equal(executorStarted, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SwarmScheduler can use durable locks for write work while read-only workers avoid write locks", async () => {
  const workspace = await fixtureWorkspace("durable-lock-swarm");
  try {
    const plan = fakeStaffingPlan("swarm_durable_locks");
    const run = fakeSwarmRun(workspace, "swarm_durable_locks", plan);
    const templates = fakeTemplates();
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const locks = new DurableLockManager({ workspacePath: workspace, ownerComponent: "SwarmScheduler" });
    await locks.acquireFileLock(run.id, "external_owner", "src/index.ts", "write");
    const workItems = [
      fakeWorkItem(run.id, "read_only_scout", "scout", "ScoutAgent", { write_files: [], read_files: ["src/index.ts"] }),
      fakeWorkItem(run.id, "locked_write", "execute", "ExecutorAgent", { write_files: ["src/index.ts"], read_files: ["src/index.ts"] })
    ];
    const result = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), locks, defaultMockWorker).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });
    assert.equal(result.workItems.find((item) => item.id === "read_only_scout")?.status, "succeeded");
    assert.equal(result.workItems.find((item) => item.id === "locked_write")?.status, "blocked");
    assert.equal(result.metrics.conflicts_detected >= 1, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PromptWriter does not acquire write locks or weaken future lock metadata", async () => {
  const workspace = await fixtureWorkspace("durable-lock-prompt-writer");
  try {
    const task = fakeTask("run_prompt_writer_no_locks", "task_prompt_writer_no_locks", {
      allowed_files_to_edit: ["src/index.ts"],
      relevant_files: ["src/index.ts"]
    });
    const pack = await new ContextPackBuilder(workspace, { maxFiles: 3, maxChars: 2000 }).build(task.run_id, task);
    const contextPackRef = path.join(workspace, ".agent_memory", "runs", task.run_id, "context_packs", `${task.id}.json`);
    const roleInput = rolePromptInputFromTask({ runId: task.run_id, task, pack, contextPackRef, sourceComponent: "CoreOrchestrator" });
    const render = renderRolePrompt(roleInput);
    assert.equal(render.ok, true);
    if (!render.ok) return;
    const result = await new PromptWriterService({
      workspacePath: workspace,
      config: {
        ...baseConfig(),
        prompt_writer_mode: "gated_adopt",
        prompt_writer_provider_mode: "deterministic"
      }
    }).run({
      runId: task.run_id,
      task,
      pack,
      contextPackRef,
      originalTemplateInput: roleInput,
      targetPromptType: render.template.prompt_type,
      templateId: render.template.template_id,
      templateVersion: render.template.version
    });
    assert.equal(result?.adoption_decision.adopted, true);
    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const lockRows = metadata.all("SELECT * FROM factory_locks WHERE run_id = ?", task.run_id);
      assert.equal(lockRows.length, 0);
    } finally {
      metadata.close();
    }
    assert.equal("lock_requirements" in (result?.template_input_patch ?? {}), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("in-memory file lock manager remains available as compatibility fallback", async () => {
  const workspace = await fixtureWorkspace("durable-lock-compat");
  try {
    const locks = new OrchestrationFileLockManager(workspace, 60_000);
    assert.equal(locks.acquire("run_compat", "task_a", ["src/index.ts"]).acquired, true);
    assert.equal(locks.acquire("run_compat", "task_b", ["src/index.ts"]).acquired, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function fakeTask(runId: string, id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: id,
    objective: "Exercise durable locks.",
    role_required: "ExecutorAgent",
    status: "pending",
    dependencies: [],
    relevant_files: ["src/index.ts"],
    allowed_files_to_edit: ["src/index.ts"],
    forbidden_files: [".env", ".agent_memory/"],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: ["npm run test"],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "apps", "agent-runtime", "src", "orchestration"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export const durableLockValue = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "helper.ts"), "export const helper = 2;\n", "utf8");
  await writeFile(path.join(root, "apps", "agent-runtime", "src", "orchestration", "FactoryMetadataStore.ts"), "export const metadata = true;\n", "utf8");
  await writeFile(path.join(root, "apps", "agent-runtime", "src", "orchestration", "PromptSystem.ts"), "export const prompt = true;\n", "utf8");
  await writeFile(path.join(root, "apps", "agent-runtime", "src", "orchestration", "DurableLockManager.ts"), "export const locks = true;\n", "utf8");
  return root;
}

function baseConfig() {
  return {
    execution_mode: "deep" as const,
    memory_path: ".agent_memory",
    enable_internal_swarm_autopilot: true,
    max_supported_logical_agents: 300,
    max_swarm_parallel_agents: 120,
    max_swarm_executors: 6,
    max_tasks_per_run: 20,
    max_parallel_tasks: 1,
    max_attempts_per_task: 2,
    max_repair_rounds: 1,
    max_files_per_task: 8,
    max_context_size: 12000,
    max_review_findings: 20,
    max_validation_log_size: 20000,
    max_patch_bytes: 120000,
    lock_ttl_ms: 300000,
    enable_multi_perspective_review: false,
    enable_multi_plan_factory: false,
    enable_parallel_execution: false,
    validation_level: "standard" as const,
    require_human_approval_for_risky_files: true,
    validation_timeout: 30000,
    safe_commands_allowlist: ["git diff --check"],
    swarm_worker_mode: "mock" as const,
    use_planning_evidence: true,
    planning_evidence_mode: "available" as const,
    max_evidence_items: 20,
    min_evidence_confidence: 0.2,
    allow_mock_evidence: false,
    prompt_writer_mode: "shadow" as const,
    prompt_writer_provider_mode: "deterministic" as const,
    enable_team_sub_planning: true,
    team_sub_planning_mode: "deterministic" as const,
    max_team_sub_plans_per_run: 12,
    max_team_sub_plan_tasks: 6,
    max_team_sub_plan_depth: 2,
    allow_provider_team_sub_planning: false,
    enable_team_task_adoption: true,
    team_task_adoption_mode: "metadata_only" as const,
    max_adopted_tasks_per_run: 24,
    max_adopted_tasks_per_team: 6,
    allow_write_task_future_candidates: true,
    allow_executable_adoption: false,
    enable_proposed_task_graph: true,
    proposed_task_graph_mode: "metadata_only" as const,
    max_proposed_nodes_per_run: 48,
    max_proposed_edges_per_run: 96,
    block_cycles: true,
    dedupe_proposed_nodes: true,
    execution_readiness_gate_enabled: true,
    execution_readiness_mode: "report_only" as const,
    allow_read_only_promotion_candidates: true,
    allow_write_future_candidates: true,
    require_human_approval_for_write: true,
    allow_auto_approval_for_low_risk_read_only: true,
    max_nodes_evaluated_per_run: 48
  };
}

function fakeStaffingPlan(runId: string): StaffingPlan {
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: `staffing_${runId}`,
    swarm_run_id: runId,
    task_complexity: "small",
    repo_scope: "few_files",
    risk_level: "low",
    recommended_total_logical_agents: 2,
    max_parallel_agents: 2,
    scout_count: 1,
    planner_count: 0,
    architect_count: 0,
    executor_count: 1,
    reviewer_count: 0,
    tester_count: 0,
    integrator_count: 0,
    specialist_agents: [],
    role_counts: {
      ScoutAgent: 1,
      PlannerAgent: 0,
      ArchitectAgent: 0,
      ExecutorAgent: 1,
      ReviewerAgent: 0,
      TesterAgent: 0,
      IntegratorAgent: 0,
      ReporterAgent: 0,
      RiskAnalyzerAgent: 0,
      MemoryUpdaterAgent: 0,
      ContextBuilderAgent: 0
    },
    executor_limit: 1,
    reviewer_limit: 1,
    tester_limit: 1,
    read_only_ratio: 0.5,
    write_agent_limit: 1,
    validation_level: "normal",
    requires_human_approval: false,
    reasoning: ["fixture"],
    confidence: 0.9,
    downgrade_conditions: [],
    escalation_conditions: [],
    created_at: new Date().toISOString()
  };
}

function fakeSwarmRun(workspace: string, id: string, plan: StaffingPlan): SwarmRun {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    user_goal: "Exercise durable swarm locks.",
    mode: "auto",
    status: "executing",
    artifacts_path: path.join(workspace, ".agent_memory", "swarm_runs", id),
    max_supported_logical_agents: 300,
    effective_total_logical_agents: plan.recommended_total_logical_agents,
    active_agent_count: 0,
    scheduler_config: {
      max_parallel_agents: plan.max_parallel_agents,
      max_parallel_read_only_agents: plan.max_parallel_agents,
      executor_limit: plan.executor_limit,
      write_agent_limit: plan.write_agent_limit,
      reviewer_limit: plan.reviewer_limit,
      tester_limit: plan.tester_limit,
      risk_level: plan.risk_level,
      validation_level: plan.validation_level,
      backpressure_failure_threshold: 1
    },
    created_at: now,
    updated_at: now,
    staffing_plan_ref: "",
    metrics_ref: undefined
  };
}

function fakeTemplates(): AgentTemplate[] {
  return [
    {
      schema_version: SWARM_SCHEMA_VERSION,
      id: "template_scout",
      role: "ScoutAgent",
      purpose: "Read-only scout.",
      allowed_operations: ["read_workspace_files"],
      forbidden_operations: ["write"],
      can_read_files: true,
      can_edit_files: false,
      can_run_commands: false,
      max_context_size: 4000,
      default_output_schema: "ScoutOutput",
      risk_level: "low",
      suitable_task_types: ["scout"],
    },
    {
      schema_version: SWARM_SCHEMA_VERSION,
      id: "template_executor",
      role: "ExecutorAgent",
      purpose: "Executor fixture.",
      allowed_operations: ["propose_patch"],
      forbidden_operations: [],
      can_read_files: true,
      can_edit_files: true,
      can_run_commands: false,
      max_context_size: 4000,
      default_output_schema: "ExecutorOutput",
      risk_level: "low",
      suitable_task_types: ["execute"],
    }
  ];
}

function fakeWorkItem(runId: string, id: string, type: WorkItem["type"], role: string, overrides: Partial<WorkItem> = {}): WorkItem {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    swarm_run_id: runId,
    type,
    priority: 1,
    dependencies: [],
    required_role: role,
    read_files: ["src/index.ts"],
    write_files: [],
    risk_level: "low",
    expected_output_schema: `${role}Output`,
    status: "queued",
    attempt_count: 0,
    max_attempts: 1,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}
