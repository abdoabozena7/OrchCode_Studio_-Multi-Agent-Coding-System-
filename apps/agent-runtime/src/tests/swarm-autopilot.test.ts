import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { CoreOrchestrator } from "../orchestration/Orchestrator.js";
import {
  MAX_SUPPORTED_LOGICAL_AGENTS,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationFileLockManager,
  SpecialistAgentFactory,
  SWARM_SCHEMA_VERSION,
  SwarmArtifactStore,
  SwarmAutopilotRuntime,
  SwarmScheduler,
  SwarmStaffingPlanner,
  aggregateScoutResults,
  createAgentInstancesForPlan,
  createInitialSwarmWorkItems,
  createConsensusGroup,
  createSwarmAgentTemplates,
  type AgentInstance,
  type AgentTemplate,
  type RoleCounts,
  type StaffingPlan,
  type SwarmSchedulerOptions,
  type SwarmWorker,
  type SwarmRun,
  type WorkItem
} from "../orchestration/index.js";

test("Phase 5 staffing planner selects small counts automatically for tiny and small tasks", () => {
  const repo = fixtureRepoIndex({ indexedFiles: 12, sourceFiles: ["src/app.ts"], importantFiles: ["src/app.ts"] });
  const planner = new SwarmStaffingPlanner();

  const tiny = planner.createPlan({
    swarmRunId: "swarm_tiny",
    userGoal: "Change copy text in index.html",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });
  const small = planner.createPlan({
    swarmRunId: "swarm_small",
    userGoal: "Fix the small bug in src/app.ts",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });

  assert.equal(tiny.task_complexity, "tiny");
  assert.ok(tiny.recommended_total_logical_agents >= 3 && tiny.recommended_total_logical_agents <= 5);
  assert.ok(small.recommended_total_logical_agents < 300);
  assert.ok(small.executor_count <= 1);
});

test("Phase 5 staffing planner scales scouts for large read-only and caps risky executors", () => {
  const repo = fixtureRepoIndex({ indexedFiles: 720 });
  const planner = new SwarmStaffingPlanner();

  const largeReadOnly = planner.createPlan({
    swarmRunId: "swarm_large",
    userGoal: "Run a whole repo read-only deep audit and map every module without changing files",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });
  const riskyEdit = planner.createPlan({
    swarmRunId: "swarm_risky",
    userGoal: "Implement an auth migration touching package.json and database schema",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });

  assert.equal(largeReadOnly.recommended_total_logical_agents, 300);
  assert.ok(Object.values(largeReadOnly.role_counts).reduce((sum, count) => sum + count, 0) <= 300);
  assert.ok(largeReadOnly.scout_count >= 150);
  assert.equal(largeReadOnly.executor_count, 0);
  assert.ok(riskyEdit.executor_limit <= 1);
  assert.equal(riskyEdit.requires_human_approval, true);
  assert.ok(riskyEdit.recommended_total_logical_agents <= MAX_SUPPORTED_LOGICAL_AGENTS);
});

test("Phase 5 staffing planner treats artifact inventory questions as read-only", () => {
  const repo = fixtureRepoIndex({
    indexedFiles: 48,
    sourceFiles: ["backend/services/action_executor.py", "backend/services/arima_model.py", "backend/routes.py"],
    importantFiles: ["backend/services/action_executor.py", "backend/services/arima_model.py", "backend/routes.py"]
  });
  const plan = new SwarmStaffingPlanner().createPlan({
    swarmRunId: "swarm_artifact_inventory",
    userGoal: "Which project files produce durable artifacts such as models, data, and logs? What is the difference between training artifacts and runtime logs? Answer from current project files only.",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });

  assert.equal(plan.executor_count, 0);
  assert.equal(plan.executor_limit, 0);
  assert.equal(plan.write_agent_limit, 0);
  assert.equal(plan.read_only_ratio, 1);
  assert.ok(plan.reasoning.some((reason) => /read-only/i.test(reason)));
  const workItems = createInitialSwarmWorkItems({
    swarmRunId: "swarm_artifact_inventory",
    userGoal: "Which project files produce durable artifacts such as models, data, and logs? What is the difference between training artifacts and runtime logs? Answer from current project files only.",
    staffingPlan: plan,
    repoIndex: repo,
    validationCommands: fixtureCommandInventory().byKind.test
  });
  assert.equal(workItems.some((item) => item.type === "execute"), false);
  assert.equal(workItems.some((item) => item.write_files.length > 0), false);

  const arabicPlan = new SwarmStaffingPlanner().createPlan({
    swarmRunId: "swarm_arabic_artifact_inventory",
    userGoal: "إيه الملفات اللي بتنتج artifacts ثابتة زي models/data/logs؟ وإيه الفرق بين training artifacts و runtime logs؟",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });
  assert.equal(arabicPlan.executor_count, 0);
  assert.equal(arabicPlan.executor_limit, 0);
  assert.equal(arabicPlan.write_agent_limit, 0);
});

test("Phase 5 staffing planner supports user-free count selection and capped advanced override", () => {
  const repo = fixtureRepoIndex({ indexedFiles: 80 });
  const plan = new SwarmStaffingPlanner().createPlan({
    swarmRunId: "swarm_no_user_count",
    userGoal: "Add a focused feature with tests in one module",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory()
  });
  const overridden = new SwarmStaffingPlanner().createPlan({
    swarmRunId: "swarm_override",
    userGoal: "Inspect the whole repository",
    repoIndex: repo,
    commandInventory: fixtureCommandInventory(),
    explicitAgentLimit: 999
  });

  assert.ok(plan.recommended_total_logical_agents > 0);
  assert.ok(plan.reasoning.some((reason) => reason.includes("user did not need")));
  assert.ok(overridden.recommended_total_logical_agents <= 300);
  assert.ok(overridden.executor_limit <= overridden.write_agent_limit);
});

test("Phase 5 specialist factory creates only justified specialists", () => {
  const factory = new SpecialistAgentFactory();
  const repo = fixtureRepoIndex({ indexedFiles: 20 });

  assert.ok(factory.create({ userGoal: "Review auth token handling", repoIndex: repo }).some((agent) => agent.role === "AuthSecurityReviewerAgent"));
  assert.ok(factory.create({ userGoal: "Improve React component accessibility", taskComplexity: "medium", candidateFiles: ["src/App.tsx"], repoIndex: repo }).some((agent) => agent.role === "AccessibilityReviewerAgent"));
  assert.ok(factory.create({ userGoal: "Add database migration for accounts", repoIndex: repo }).some((agent) => agent.role === "MigrationSafetyReviewerAgent"));
  assert.equal(factory.create({ userGoal: "Change copy text in index.html", taskComplexity: "tiny", candidateFiles: ["index.html"], repoIndex: repo }).length, 0);
});

test("Phase 5 scheduler obeys dependencies, role counts, read fan-out, and write limits", async () => {
  const workspace = await fixtureWorkspace("swarm-scheduler");
  try {
    const plan = fakeStaffingPlan("swarm_sched", {
      ScoutAgent: 10,
      ExecutorAgent: 4,
      ReviewerAgent: 1,
      ReporterAgent: 1
    }, { maxParallelAgents: 10, executorLimit: 2 });
    const run = fakeSwarmRun(workspace, "swarm_sched", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [
      ...Array.from({ length: 10 }, (_, index) => fakeWorkItem(run.id, `scout_${index}`, "scout", "ScoutAgent")),
      ...Array.from({ length: 4 }, (_, index) => fakeWorkItem(run.id, `exec_${index}`, "execute", "ExecutorAgent", {
        dependencies: ["scout_0"],
        write_files: [`src/file${index}.ts`]
      }))
    ];
    const result = await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      successfulSwarmWorker,
      fixedSchedulerCapacity(10)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.workItems.every((item) => item.status === "succeeded"), true);
    assert.equal(result.metrics.scout_peak_count, 10);
    assert.ok(result.metrics.executor_peak_count <= 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 scheduler blocks lock conflicts, forbidden writes, and high-risk executor fan-out", async () => {
  const workspace = await fixtureWorkspace("swarm-locks");
  try {
    const plan = fakeStaffingPlan("swarm_locks", {
      ExecutorAgent: 6,
      ReviewerAgent: 2,
      ReporterAgent: 1
    }, { riskLevel: "high", maxParallelAgents: 20, executorLimit: 6 });
    const run = fakeSwarmRun(workspace, "swarm_locks", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const locks = new OrchestrationFileLockManager(workspace);
    locks.acquire(run.id, "external_owner", ["src/file0.ts"]);
    const workItems = [
      fakeWorkItem(run.id, "locked_write", "execute", "ExecutorAgent", { write_files: ["src/file0.ts"] }),
      fakeWorkItem(run.id, "forbidden_write", "execute", "ExecutorAgent", { write_files: [".agent_memory/hidden.json"] }),
      ...Array.from({ length: 6 }, (_, index) => fakeWorkItem(run.id, `high_${index}`, "execute", "ExecutorAgent", { write_files: [`src/high${index}.ts`] }))
    ];

    const result = await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      locks,
      successfulSwarmWorker,
      fixedSchedulerCapacity(20)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.workItems.find((item) => item.id === "locked_write")?.status, "blocked");
    assert.equal(result.workItems.find((item) => item.id === "forbidden_write")?.status, "blocked");
    assert.ok(result.metrics.executor_peak_count <= 2);
    assert.ok(result.metrics.conflicts_detected >= 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 scheduler retries invalid structured output and creates repair work after validation failure", async () => {
  const workspace = await fixtureWorkspace("swarm-repair");
  try {
    const plan = fakeStaffingPlan("swarm_repair", {
      ExecutorAgent: 2,
      TesterAgent: 1,
      ReporterAgent: 1
    }, { maxParallelAgents: 3, executorLimit: 1 });
    const run = fakeSwarmRun(workspace, "swarm_repair", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [
      fakeWorkItem(run.id, "invalid_output", "execute", "ExecutorAgent", {
        expected_output_schema: "InvalidOutput",
        write_files: ["src/file1.ts"],
        max_attempts: 2
      }),
      fakeWorkItem(run.id, "failing_validation", "test", "TesterAgent", {
        read_files: ["node -e \"process.exit(3)\""],
        expected_output_schema: "TesterOutput"
      })
    ];

    const result = await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      repairScenarioWorker,
      fixedSchedulerCapacity(3)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.workItems.find((item) => item.id === "invalid_output")?.attempt_count, 2);
    assert.equal(result.metrics.invalid_structured_outputs, 2);
    assert.ok(result.metrics.retries >= 1);
    assert.equal(result.metrics.repair_tasks, 1);
    assert.ok(result.workItems.some((item) => item.id.startsWith("swarm_repair_failing_validation")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Adaptive scheduler runs ready work concurrently while leasing unique agents", async () => {
  const workspace = await fixtureWorkspace("swarm-adaptive-concurrency");
  try {
    const plan = fakeStaffingPlan("swarm_adaptive_concurrency", {
      ScoutAgent: 4
    }, { maxParallelAgents: 4, executorLimit: 0, total: 4 });
    const run = fakeSwarmRun(workspace, "swarm_adaptive_concurrency", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = Array.from({ length: 4 }, (_, index) => fakeWorkItem(run.id, `scout_${index}`, "scout", "ScoutAgent"));
    let active = 0;
    let peakActive = 0;
    const leasedAgents = new Set<string>();
    const worker: SwarmWorker = async (input) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      leasedAgents.add(input.agent.id);
      await delay(30);
      active -= 1;
      return successfulResult(input);
    };

    const store = new SwarmArtifactStore(workspace);
    const result = await new SwarmScheduler(
      workspace,
      store,
      new OrchestrationFileLockManager(workspace),
      worker,
      fixedSchedulerCapacity(4)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.metrics.work_items_completed, 4);
    assert.ok(peakActive > 1);
    assert.equal(leasedAgents.size, 4);
    assert.equal(result.metrics.peak_active_agents, 4);
    assert.equal((await store.listSchedulerTrace(run.id))[0]?.parallel_limit, 4);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Adaptive scheduler caps fan-out from injected resource pressure", async () => {
  const workspace = await fixtureWorkspace("swarm-adaptive-resource-cap");
  try {
    const plan = fakeStaffingPlan("swarm_resource_cap", {
      ScoutAgent: 8
    }, { maxParallelAgents: 8, executorLimit: 0, total: 8 });
    const run = fakeSwarmRun(workspace, "swarm_resource_cap", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = Array.from({ length: 8 }, (_, index) => fakeWorkItem(run.id, `scout_${index}`, "scout", "ScoutAgent"));
    const store = new SwarmArtifactStore(workspace);

    const result = await new SwarmScheduler(
      workspace,
      store,
      new OrchestrationFileLockManager(workspace),
      successfulSwarmWorker,
      fixedSchedulerCapacity(2)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(result.metrics.work_items_completed, 8);
    assert.equal(result.metrics.peak_active_agents, 2);
    assert.ok((await store.listSchedulerTrace(run.id)).every((entry) => entry.parallel_limit === 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Adaptive scheduler reduces after failures and grows after healthy batches", async () => {
  const workspace = await fixtureWorkspace("swarm-adaptive-backpressure");
  try {
    const plan = fakeStaffingPlan("swarm_backpressure", {
      ScoutAgent: 11
    }, { maxParallelAgents: 4, executorLimit: 0, total: 11 });
    const run = fakeSwarmRun(workspace, "swarm_backpressure", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = Array.from({ length: 11 }, (_, index) => fakeWorkItem(run.id, `scout_${index}`, "scout", "ScoutAgent"));
    const worker: SwarmWorker = async (input) => input.workItem.id === "scout_0"
      ? {
          ...successfulResult(input),
          status: "failed",
          summary: "intentional failure",
          structured_output_valid: true,
          confidence: 0.1
        }
      : successfulResult(input);
    const store = new SwarmArtifactStore(workspace);

    await new SwarmScheduler(
      workspace,
      store,
      new OrchestrationFileLockManager(workspace),
      worker,
      fixedSchedulerCapacity(4)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });
    const limits = (await store.listSchedulerTrace(run.id)).map((entry) => entry.parallel_limit);
    const events = await store.listEvents(run.id);

    assert.deepEqual(limits.slice(0, 3), [4, 3, 4]);
    assert.ok(events.some((event) => event.type === "swarm.scheduler.backpressure_applied"));
    assert.ok(events.some((event) => event.type === "swarm.concurrency.increased"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Adaptive scheduler priority aging prevents repeatedly retried work from starving older ready work", async () => {
  const workspace = await fixtureWorkspace("swarm-adaptive-aging");
  try {
    const plan = fakeStaffingPlan("swarm_aging", {
      ScoutAgent: 2
    }, { maxParallelAgents: 1, executorLimit: 0, total: 2 });
    const run = fakeSwarmRun(workspace, "swarm_aging", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = [
      fakeWorkItem(run.id, "flaky_high", "scout", "ScoutAgent", { priority: 1, max_attempts: 4 }),
      fakeWorkItem(run.id, "steady_low", "scout", "ScoutAgent", { priority: 10 })
    ];
    const calls: string[] = [];
    const worker: SwarmWorker = async (input) => {
      calls.push(input.workItem.id);
      if (input.workItem.id === "flaky_high" && input.workItem.attempt_count < 3) {
        return {
          ...successfulResult(input),
          status: "failed",
          summary: "retry high priority",
          structured_output_valid: true,
          confidence: 0.2
        };
      }
      return successfulResult(input);
    };

    await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      worker,
      fixedSchedulerCapacity(1)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(calls[0], "flaky_high");
    assert.ok(calls.indexOf("steady_low") < calls.lastIndexOf("flaky_high"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 fan-in aggregates scouts and consensus preserves dissent", () => {
  const aggregate = aggregateScoutResults([
    { work_item_id: "a", relevant_files: ["src/a.ts"], relevant_symbols: ["A"], risks: ["risk"], test_recommendations: ["npm test"], unknowns: ["x"], confidence: 0.8 },
    { work_item_id: "b", relevant_files: ["src/a.ts", "src/b.ts"], relevant_symbols: ["A", "B"], risks: ["risk"], test_recommendations: ["npm test"], unknowns: ["y"], confidence: 0.6 }
  ]);
  const consensus = createConsensusGroup({
    swarmRunId: "swarm_consensus",
    topic: "Patch readiness",
    participantWorkItems: ["review_a", "review_b"],
    findings: [
      { finding: "safe to integrate", confidence: 0.8 },
      { finding: "missing validation", confidence: 0.5, dissent: true }
    ]
  });

  assert.deepEqual(aggregate.relevant_files, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(aggregate.risks, ["risk"]);
  assert.equal(consensus.decision, "accepted_with_dissent");
  assert.deepEqual(consensus.dissenting_findings, ["missing validation"]);

  const blockedConsensus = createConsensusGroup({
    swarmRunId: "swarm_consensus_blocked",
    topic: "Patch readiness",
    participantWorkItems: ["review_failed"],
    findings: [
      { finding: "review_failed did not complete cleanly", confidence: 0.4, dissent: true }
    ]
  });
  assert.equal(blockedConsensus.decision, "blocked_with_dissent");
  assert.deepEqual(blockedConsensus.consolidated_findings, []);
});

test("Phase 5 swarm plan records original request and intent review refs", async () => {
  const workspace = await fixtureWorkspace("swarm-intent-plan");
  try {
    const result = await new SwarmAutopilotRuntime({
      workspacePath: workspace,
      providerFactory: () => new SwarmIntentProvider()
    }).plan("Inspect src/file0.ts without changing files");
    assert.equal(existsSync(result.run.original_request_ref ?? ""), true);
    assert.equal(existsSync(result.run.intent_ledger_ref ?? ""), true);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "intent", "intent_contract.json")), true);
    assert.equal(result.run.intent_contract_status, "ready");
    assert.equal(result.run.original_request_ref?.includes(path.join(".agent_memory", "swarm_runs").replaceAll("\\", path.sep)), true);

    const ledgerSnapshot = JSON.parse(await readFile(path.join(result.run.artifacts_path, "intent", "intent_ledger.json"), "utf8")) as {
      entries?: Array<{ entry_kind?: string }>;
    };
    assert.ok(ledgerSnapshot.entries?.some((entry) => entry.entry_kind === "original_request_recorded"));
    assert.ok(ledgerSnapshot.entries?.some((entry) => entry.entry_kind === "intent_contract_compiled"));
    assert.ok(ledgerSnapshot.entries?.some((entry) => entry.entry_kind === "initial_intent_review"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 swarm blocks staffing without a ready intent contract", async () => {
  const workspace = await fixtureWorkspace("swarm-intent-blocked");
  try {
    const result = await new SwarmAutopilotRuntime({ workspacePath: workspace }).plan("Inspect src/file0.ts without changing files");
    assert.equal(result.run.status, "blocked");
    assert.equal(result.run.intent_contract_status, "provider_unavailable");
    assert.equal(result.workItems.length, 0);
    assert.equal(result.agentInstances.length, 0);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "staffing_plan.json")), false);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "work_items.json")), false);
    assert.equal(existsSync(path.join(result.run.artifacts_path, "intent", "intent_contract.json")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 runtime writes artifacts, metrics, trace, and explanatory final report", async () => {
  const workspace = await fixtureWorkspace("swarm-runtime");
  try {
    const result = await new SwarmAutopilotRuntime({
      workspacePath: workspace,
      providerFactory: () => new SwarmIntentProvider(),
      worker: successfulSwarmWorker
    }).run("Fix a small bug in src/file0.ts");
    const runDir = result.run.artifacts_path;

    assert.equal(existsSync(path.join(runDir, "staffing_plan.json")), true);
    assert.equal(existsSync(path.join(runDir, "scheduler_trace.jsonl")), true);
    assert.equal(existsSync(path.join(runDir, "metrics.json")), true);
    assert.equal(existsSync(path.join(runDir, "final_report.md")), true);
    assert.ok(result.metrics.role_distribution.ExecutorAgent >= 1);
    assert.match(result.finalReport, /The system selected \d+ internal logical agent/);
    assert.match(result.finalReport, /300 is treated as the maximum supported internal capacity/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 failed swarm reports planned write targets without claiming changed files", async () => {
  const workspace = await fixtureWorkspace("swarm-failed-truth");
  try {
    const failingWorker = async (input: Parameters<import("../orchestration/SwarmScheduler.js").SwarmWorker>[0]) => ({
      schema_version: SWARM_SCHEMA_VERSION,
      work_item_id: input.workItem.id,
      status: "failed" as const,
      summary: "Provider output schema failed: findings must be an array; relevant_files must be an array",
      relevant_files: input.workItem.read_files,
      findings: [],
      risks: ["provider output did not match the required schema"],
      unknowns: [],
      confidence: 0,
      structured_output_valid: false,
      created_at: new Date().toISOString()
    });
    const result = await new SwarmAutopilotRuntime({
      workspacePath: workspace,
      providerFactory: () => new SwarmIntentProvider(),
      worker: failingWorker
    }).run("Fix a small bug in src/file0.ts");

    assert.equal(result.run.status, "failed");
    assert.match(result.finalReport, /- Work items completed: 0/);
    assert.match(result.finalReport, /- Consensus decision: blocked_with_dissent/);
    assert.match(result.finalReport, /- Terminal status: failed/);
    assert.match(result.finalReport, /No work item completed successfully, so no integration or patch was accepted/);
    assert.match(result.finalReport, /## Files Changed\s+- none/);
    assert.match(result.finalReport, /## Planned Write Targets\s+- src\/file0\.ts \(planned only; no accepted patch is implied\)/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 stress uses 300 logical mock agents without creating 300 executors", async () => {
  const workspace = await fixtureWorkspace("swarm-stress");
  try {
    const plan = fakeStaffingPlan("swarm_stress", {
      ScoutAgent: 300,
      ExecutorAgent: 0
    }, { maxParallelAgents: 300, executorLimit: 0, total: 300 });
    const run = fakeSwarmRun(workspace, "swarm_stress", plan);
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = Array.from({ length: 300 }, (_, index) => fakeWorkItem(run.id, `scout_${index}`, "scout", "ScoutAgent"));

    const readOnly = await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      successfulSwarmWorker,
      fixedSchedulerCapacity(32)
    ).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(agents.length, 300);
    assert.equal(readOnly.metrics.work_items_completed, 300);
    assert.equal(readOnly.metrics.peak_active_agents, 32);

    const executorPlan = fakeStaffingPlan("swarm_exec_stress", {
      ExecutorAgent: 300
    }, { maxParallelAgents: 300, executorLimit: 2, total: 300 });
    const executorRun = fakeSwarmRun(workspace, "swarm_exec_stress", executorPlan);
    const executorAgents = createAgentInstancesForPlan({ runId: executorRun.id, staffingPlan: executorPlan, templates });
    const executorItems = Array.from({ length: 30 }, (_, index) => fakeWorkItem(executorRun.id, `exec_${index}`, "execute", "ExecutorAgent", {
      write_files: [`src/stress${index}.ts`]
    }));
    const writeLimited = await new SwarmScheduler(
      workspace,
      new SwarmArtifactStore(workspace),
      new OrchestrationFileLockManager(workspace),
      successfulSwarmWorker,
      fixedSchedulerCapacity(32)
    ).run({
      run: executorRun,
      staffingPlan: executorPlan,
      agentTemplates: templates,
      agentInstances: executorAgents,
      workItems: executorItems
    });

    assert.ok(writeLimited.metrics.executor_peak_count <= 2);
    assert.equal(writeLimited.metrics.effective_total_logical_agents, 300);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 5 keeps previous orchestrator plan path working", async () => {
  const workspace = await fixtureWorkspace("swarm-backcompat");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new SwarmIntentProvider()
    }).planOnly("Explain src/file0.ts and do not change files.");
    assert.equal(result.run.status, "succeeded");
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Plan-only mode")));
    assert.ok(result.tasks.some((task) => task.role_required === "ScoutAgent"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

const successfulSwarmWorker: SwarmWorker = async (input) => successfulResult(input);

class SwarmIntentProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest): Promise<T> {
    if (input.purpose === "route") {
      const context = input.context as { original_user_request?: string } | undefined;
      return readyIntentContractOutput(context?.original_user_request ?? "unknown request") as T;
    }
    if (input.purpose === "verify") {
      return {
        status: "aligned",
        rationale: "Synthetic provider fixture verified the artifact against the ready intent contract.",
        findings: []
      } as T;
    }
    return {} as T;
  }

  async generateText(): Promise<string> {
    return "{}";
  }
}

function readyIntentContractOutput(originalRequest: string) {
  return {
    original_user_request: originalRequest,
    precise_rewrite: originalRequest,
    assumptions: ["The current repository contains the target files."],
    missing_questions: [] satisfies IntentContract["missing_questions"],
    tradeoffs: [{
      name: "scope_vs_speed",
      options: ["small plan", "broad scan"],
      preferred: "small plan",
      rationale: "The test requests a focused swarm run."
    }],
    priorities: {
      speed: { score: 50, rationale: "Keep the fixture fast." },
      quality: { score: 80, rationale: "Create a valid work graph." },
      realism: { score: 70, rationale: "Use indexed repository files." },
      fun: { score: 10, rationale: "Not relevant." },
      security: { score: 80, rationale: "Keep write gates active." },
      cost: { score: 50, rationale: "Avoid extra provider calls." }
    },
    definition_of_done: ["The swarm plan/run records intent contract refs before work items."],
    non_goals: ["Do not bypass the intent compiler gate."],
    conflict_rules: ["Ready intent contract status is required before staffing."]
  };
}

const repairScenarioWorker: SwarmWorker = async (input) => {
  if (input.workItem.id === "invalid_output") {
    return {
      ...successfulResult(input),
      status: "failed",
      summary: "invalid structured output",
      structured_output_valid: false,
      confidence: 0
    };
  }
  if (input.workItem.id === "failing_validation") {
    return {
      ...successfulResult(input),
      status: "failed",
      summary: "validation failed",
      validation_passed: false,
      structured_output_valid: true,
      confidence: 0.2
    };
  }
  return successfulResult(input);
};

function successfulResult(input: Parameters<SwarmWorker>[0]) {
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    work_item_id: input.workItem.id,
    status: "succeeded" as const,
    summary: `completed ${input.workItem.id}`,
    relevant_files: input.workItem.read_files,
    findings: [],
    risks: [],
    unknowns: [],
    validation_passed: input.workItem.type === "test" ? true : undefined,
    structured_output_valid: true,
    confidence: 0.9,
    intent_alignment: intentAlignmentForWorkItem(input)
  };
}

function fixedSchedulerCapacity(parallelism: number): SwarmSchedulerOptions {
  return {
    resourceMonitor: () => ({
      available_parallelism: parallelism,
      recommended_parallelism: parallelism,
      cpu_pressure: 0,
      reason: "test_fixed_capacity"
    })
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "swarm-fixture",
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  }, null, 2), "utf8");
  for (let index = 0; index < 32; index += 1) {
    await writeFile(path.join(workspace, "src", `file${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
  }
  return workspace;
}

type RepoIndexFixtureOverrides = Partial<Omit<RepoIndex, "totals" | "sourceFiles">> & {
  indexedFiles?: number;
  sourceFiles?: string[];
};

function fixtureRepoIndex(overrides: RepoIndexFixtureOverrides = {}): RepoIndex {
  const indexedFiles = overrides.indexedFiles ?? 60;
  const sourceFiles = overrides.sourceFiles ?? Array.from({ length: Math.min(indexedFiles, 80) }, (_, index) => `src/file${index}.ts`);
  return {
    schemaVersion: 1,
    generatedAt: new Date("2026-05-23T00:00:00.000Z").toISOString(),
    workspaceRoot: "fixture",
    projectName: "fixture",
    totals: {
      indexedFiles,
      sourceFiles: sourceFiles.length,
      testFiles: 4,
      configFiles: 2,
      docFiles: 2,
      skippedFiles: 0,
      indexedBytes: indexedFiles * 100,
      ...pickTotals(overrides)
    },
    languages: { TypeScript: sourceFiles.length },
    extensions: { ".ts": sourceFiles.length },
    topLevelDirectories: [{ path: "src", files: sourceFiles.length }, { path: "docs", files: 2 }],
    ignoredDirectories: [],
    skippedFiles: [],
    sourceFiles,
    testFiles: ["src/file0.test.ts", "src/file1.test.ts"],
    configFiles: ["package.json", "tsconfig.json"],
    docFiles: ["README.md"],
    importantFiles: overrides.importantFiles ?? ["src/file0.ts", "package.json"],
    entrypoints: ["src/file0.ts"],
    packageFiles: ["package.json"],
    dependencyFiles: ["package-lock.json"],
    buildFiles: ["package.json"],
    ...overrides
  };
}

function pickTotals(value: RepoIndexFixtureOverrides) {
  return {
    ...(value.indexedFiles !== undefined ? { indexedFiles: value.indexedFiles } : {}),
    ...(value.sourceFiles !== undefined && Array.isArray(value.sourceFiles) ? { sourceFiles: value.sourceFiles.length } : {})
  };
}

function fixtureCommandInventory(): CommandInventory {
  return {
    schemaVersion: 1,
    generatedAt: new Date("2026-05-23T00:00:00.000Z").toISOString(),
    packageManagers: ["npm"],
    commands: [
      { id: "test", kind: "test", command: "npm run test", cwd: ".", sourceFile: "package.json", source: "package_json", packageManager: "npm", scriptName: "test", confidence: "high" },
      { id: "typecheck", kind: "typecheck", command: "npm run typecheck", cwd: ".", sourceFile: "package.json", source: "package_json", packageManager: "npm", scriptName: "typecheck", confidence: "high" }
    ],
    byKind: {
      test: ["npm run test"],
      lint: [],
      typecheck: ["npm run typecheck"],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}

function fakeStaffingPlan(
  runId: string,
  counts: Partial<RoleCounts>,
  options: {
    riskLevel?: StaffingPlan["risk_level"];
    maxParallelAgents?: number;
    executorLimit?: number;
    total?: number;
  } = {}
): StaffingPlan {
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
  const total = options.total ?? Object.values(roleCounts).reduce((sum, count) => sum + count, 0);
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: `staffing_${runId}`,
    swarm_run_id: runId,
    task_complexity: total >= 120 ? "huge" : "medium",
    repo_scope: total >= 120 ? "whole_repo" : "single_module",
    risk_level: options.riskLevel ?? "low",
    recommended_total_logical_agents: total,
    max_parallel_agents: options.maxParallelAgents ?? 4,
    scout_count: roleCounts.ScoutAgent,
    planner_count: roleCounts.PlannerAgent,
    architect_count: roleCounts.ArchitectAgent,
    executor_count: roleCounts.ExecutorAgent,
    reviewer_count: roleCounts.ReviewerAgent,
    tester_count: roleCounts.TesterAgent,
    integrator_count: roleCounts.IntegratorAgent,
    specialist_agents: [],
    role_counts: roleCounts,
    executor_limit: options.executorLimit ?? roleCounts.ExecutorAgent,
    reviewer_limit: roleCounts.ReviewerAgent,
    tester_limit: roleCounts.TesterAgent,
    read_only_ratio: roleCounts.ExecutorAgent ? 0.5 : 1,
    write_agent_limit: options.executorLimit ?? roleCounts.ExecutorAgent,
    validation_level: "normal",
    requires_human_approval: false,
    reasoning: ["test staffing plan"],
    confidence: 0.9,
    downgrade_conditions: [],
    escalation_conditions: [],
    created_at: new Date().toISOString()
  };
}

function fakeSwarmRun(workspace: string, id: string, plan: StaffingPlan): SwarmRun {
  const now = new Date().toISOString();
  const artifactsPath = path.join(workspace, ".agent_memory", "swarm_runs", id);
  writeReadySwarmIntentArtifacts({ runId: id, userGoal: "test swarm", artifactsPath, createdAt: now });
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    user_goal: "test swarm",
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
    artifacts_path: artifactsPath,
    original_request_ref: path.join(artifactsPath, "intent", "original_request.json"),
    intent_contract_ref: path.join(artifactsPath, "intent", "intent_contract.json"),
    intent_contract_status: "ready",
    intent_ledger_ref: path.join(artifactsPath, "intent", "intent_ledger.json")
  };
}

function writeReadySwarmIntentArtifacts(input: {
  runId: string;
  userGoal: string;
  artifactsPath: string;
  createdAt: string;
}) {
  const intentDir = path.join(input.artifactsPath, "intent");
  mkdirSync(intentDir, { recursive: true });
  const originalRef = path.join(intentDir, "original_request.json");
  const contractRef = path.join(intentDir, "intent_contract.json");
  const ledgerRef = path.join(intentDir, "intent_ledger.json");
  const requestHash = sha256(input.userGoal);
  const original = {
    schema_version: 1,
    run_id: input.runId,
    run_kind: "swarm",
    original_request: input.userGoal,
    request_hash: requestHash,
    source: "user",
    created_at: input.createdAt,
    artifact_ref: originalRef,
    summary_ref: path.join(intentDir, "original_request.md"),
    metadata_json: {}
  };
  const contract = {
    schema_version: 1,
    contract_id: `intent_contract_${input.runId}`,
    run_id: input.runId,
    run_kind: "swarm",
    revision: 1,
    original_user_request: input.userGoal,
    precise_rewrite: input.userGoal,
    assumptions: ["The scheduler fixture writes a ready intent contract before work starts."],
    missing_questions: [],
    tradeoffs: [{
      name: "fixture_scope",
      options: ["direct scheduler unit test"],
      preferred: "direct scheduler unit test",
      rationale: "The test isolates scheduler behavior."
    }],
    priorities: {
      speed: { score: 70, rationale: "Keep scheduler fixtures fast." },
      quality: { score: 80, rationale: "Exercise the gate with valid intent data." },
      realism: { score: 60, rationale: "Use real persisted intent artifacts." },
      fun: { score: 10, rationale: "Not relevant." },
      security: { score: 80, rationale: "Keep write gates active." },
      cost: { score: 80, rationale: "Avoid external providers." }
    },
    definition_of_done: ["Scheduler work items complete with intent-aligned outputs."],
    non_goals: ["Do not bypass the intent handoff gate."],
    conflict_rules: ["Block outputs that are not tied to the ready contract."],
    status: "ready",
    created_at: input.createdAt,
    artifact_ref: contractRef,
    summary_ref: path.join(intentDir, "intent_contract.md"),
    metadata_json: {}
  };
  writeFileSync(originalRef, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  writeFileSync(contractRef, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  writeFileSync(ledgerRef, `${JSON.stringify({
    schema_version: 1,
    run_id: input.runId,
    run_kind: "swarm",
    latest_revision: 2,
    entries: [],
    updated_at: input.createdAt
  }, null, 2)}\n`, "utf8");
}

function intentAlignmentForWorkItem(input: Parameters<SwarmWorker>[0]) {
  return {
    schema_version: 1,
    run_id: input.run.id,
    task_id: input.workItem.id,
    original_request_hash: sha256(input.run.user_goal),
    intent_contract_ref: path.join(input.run.artifacts_path, "intent", "intent_contract.json"),
    intent_contract_revision: 1,
    task_slice_id: stableId("intent_slice", input.workItem.swarm_run_id, input.workItem.id, input.workItem.required_role, input.workItem.type),
    task_understanding: `${input.workItem.required_role} ${input.workItem.type} work item ${input.workItem.id}`,
    original_goal_contribution: `This work item contributes to the swarm goal: ${input.run.user_goal}`,
    possible_intent_conflicts: [],
    assumptions_used: ["The scheduler fixture writes a ready intent contract before work starts."],
    evidence_refs: [
      path.join(input.run.artifacts_path, "intent", "original_request.json"),
      path.join(input.run.artifacts_path, "intent", "intent_contract.json")
    ]
  };
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 24)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function fakeWorkItem(
  runId: string,
  id: string,
  type: WorkItem["type"],
  role: string,
  overrides: Partial<WorkItem> = {}
): WorkItem {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    swarm_run_id: runId,
    type,
    priority: type === "scout" ? 1 : type === "execute" ? 5 : 10,
    dependencies: [],
    required_role: role,
    read_files: [],
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
