import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  OrchestrationFileLockManager,
  SWARM_SCHEMA_VERSION,
  SwarmArtifactStore,
  SwarmScheduler,
  createAgentInstancesForPlan,
  createSwarmAgentTemplates,
  runSwarmSchedulerThroughCanonicalGraph,
  type RoleCounts,
  type StaffingPlan,
  type SwarmRun,
  type SwarmWorker,
  type WorkItem
} from "../orchestration/index.js";

test("canonical swarm adapter runs SwarmScheduler through the shared lifecycle graph", async () => {
  const workspace = await fixtureWorkspace("canonical-swarm-ok");
  try {
    const plan = fakeStaffingPlan("swarm_canonical_ok", { ScoutAgent: 1 });
    const run = fakeSwarmRun(workspace, "swarm_canonical_ok", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [fakeWorkItem(run.id, "scout_1", "ScoutAgent")];
    const scheduler = new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      successfulWorker,
      { resourceMonitor: () => ({ available_parallelism: 1, recommended_parallelism: 1 }) }
    );

    const result = await runSwarmSchedulerThroughCanonicalGraph({
      scheduler,
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.graph.status, "awaiting_approval");
    assert.equal(result.graph.finalStatus, "needs_approval");
    assert.equal(result.scheduled.workItems[0]?.status, "succeeded");
    assert.equal(result.taskExecution.completed, 1);
    assert.equal(result.taskExecution.failed, 0);
    assert.deepEqual(result.blockingReasons, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical swarm adapter reports blocked swarm work as graph review failure", async () => {
  const workspace = await fixtureWorkspace("canonical-swarm-blocked");
  try {
    const plan = fakeStaffingPlan("swarm_canonical_blocked", { ScoutAgent: 1 });
    const run = fakeSwarmRun(workspace, "swarm_canonical_blocked", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [fakeWorkItem(run.id, "scout_blocked", "ScoutAgent")];
    const scheduler = new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      blockedWorker,
      { resourceMonitor: () => ({ available_parallelism: 1, recommended_parallelism: 1 }) }
    );

    const result = await runSwarmSchedulerThroughCanonicalGraph({
      scheduler,
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.graph.status, "blocked");
    assert.equal(result.graph.finalStatus, "failed");
    assert.equal(result.scheduled.workItems[0]?.status, "blocked");
    assert.match(result.blockingReasons.join("\n"), /scout_blocked/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical swarm adapter blocks malformed dependencies before scheduler execution", async () => {
  const workspace = await fixtureWorkspace("canonical-swarm-invalid");
  try {
    const plan = fakeStaffingPlan("swarm_canonical_invalid", { ScoutAgent: 1 });
    const run = fakeSwarmRun(workspace, "swarm_canonical_invalid", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [fakeWorkItem(run.id, "scout_invalid", "ScoutAgent", ["missing-work-item"])];
    let executed = false;
    const scheduler = new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      async (input) => {
        executed = true;
        return successfulWorker(input);
      },
      { resourceMonitor: () => ({ available_parallelism: 1, recommended_parallelism: 1 }) }
    );

    const result = await runSwarmSchedulerThroughCanonicalGraph({
      scheduler,
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(executed, false);
    assert.equal(result.graph.status, "blocked");
    assert.equal(result.graph.finalStatus, "failed");
    assert.equal(result.scheduled.workItems[0]?.status, "queued");
    assert.equal(result.taskExecution.completed, 0);
    assert.equal(result.taskExecution.failed, 0);
    assert.match(result.blockingReasons.join("\n"), /missing-work-item/);
    assert.doesNotMatch(result.blockingReasons.join("\n"), /Swarm scheduler did not return/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const successfulWorker: SwarmWorker = async ({ workItem }) => ({
  schema_version: SWARM_SCHEMA_VERSION,
  work_item_id: workItem.id,
  status: "succeeded",
  summary: `completed ${workItem.id}`,
  relevant_files: workItem.read_files,
  findings: [],
  risks: [],
  unknowns: [],
  structured_output_valid: true,
  confidence: 0.9,
  intent_handoff_gate_status: "passed",
  intent_handoff_gate_ref: "fixture_gate"
});

const blockedWorker: SwarmWorker = async ({ workItem }) => ({
  schema_version: SWARM_SCHEMA_VERSION,
  work_item_id: workItem.id,
  status: "blocked",
  summary: `blocked ${workItem.id}`,
  relevant_files: workItem.read_files,
  findings: [],
  risks: ["fixture_blocked"],
  unknowns: [],
  structured_output_valid: true,
  confidence: 0.1
});

async function fixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "file.ts"), "export const value = 1;\n", "utf8");
  return workspace;
}

function fakeStaffingPlan(runId: string, counts: Partial<RoleCounts>): StaffingPlan {
  const roleCounts: RoleCounts = {
    ScoutAgent: 0,
    PlannerAgent: 0,
    ArchitectAgent: 0,
    ExecutorAgent: 0,
    ReviewerAgent: 0,
    TesterAgent: 0,
    IntegratorAgent: 0,
    ReporterAgent: 0,
    RiskAnalyzerAgent: 0,
    MemoryUpdaterAgent: 0,
    ContextBuilderAgent: 0,
    ...counts
  };
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: `staffing_${runId}`,
    swarm_run_id: runId,
    task_complexity: "small",
    repo_scope: "single_module",
    risk_level: "low",
    recommended_total_logical_agents: Object.values(roleCounts).reduce((sum, count) => sum + count, 0),
    max_parallel_agents: 1,
    scout_count: roleCounts.ScoutAgent,
    planner_count: roleCounts.PlannerAgent,
    architect_count: roleCounts.ArchitectAgent,
    executor_count: roleCounts.ExecutorAgent,
    reviewer_count: roleCounts.ReviewerAgent,
    tester_count: roleCounts.TesterAgent,
    integrator_count: roleCounts.IntegratorAgent,
    specialist_agents: [],
    role_counts: roleCounts,
    executor_limit: roleCounts.ExecutorAgent,
    reviewer_limit: roleCounts.ReviewerAgent,
    tester_limit: roleCounts.TesterAgent,
    read_only_ratio: 1,
    write_agent_limit: roleCounts.ExecutorAgent,
    validation_level: "basic",
    requires_human_approval: false,
    reasoning: ["canonical adapter fixture"],
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
    user_goal: "test canonical swarm adapter",
    status: "scheduling",
    mode: "auto",
    staffing_plan_ref: "staffing_plan.json",
    effective_total_logical_agents: plan.recommended_total_logical_agents,
    active_agent_count: 0,
    max_supported_logical_agents: 300,
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
    artifacts_path: path.join(workspace, ".agent_memory", "swarm_runs", id)
  };
}

function fakeWorkItem(runId: string, id: string, role: string, dependencies: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    swarm_run_id: runId,
    type: "scout",
    priority: 1,
    dependencies,
    required_role: role,
    read_files: ["src/file.ts"],
    write_files: [],
    risk_level: "low",
    expected_output_schema: "ScoutOutput",
    status: "queued",
    attempt_count: 0,
    max_attempts: 1,
    created_at: now,
    updated_at: now
  };
}
