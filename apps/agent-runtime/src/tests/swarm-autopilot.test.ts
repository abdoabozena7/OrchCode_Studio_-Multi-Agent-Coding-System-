import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  createConsensusGroup,
  createSwarmAgentTemplates,
  type AgentInstance,
  type AgentTemplate,
  type RoleCounts,
  type StaffingPlan,
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
    const result = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), new OrchestrationFileLockManager(workspace)).run({
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

    const result = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), locks).run({
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

    const result = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), new OrchestrationFileLockManager(workspace)).run({
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
});

test("Phase 5 runtime writes artifacts, metrics, trace, and explanatory final report", async () => {
  const workspace = await fixtureWorkspace("swarm-runtime");
  try {
    const result = await new SwarmAutopilotRuntime({ workspacePath: workspace }).run("Fix a small bug in src/file0.ts");
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

    const readOnly = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), new OrchestrationFileLockManager(workspace)).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });

    assert.equal(agents.length, 300);
    assert.equal(readOnly.metrics.work_items_completed, 300);
    assert.equal(readOnly.metrics.peak_active_agents, 300);

    const executorPlan = fakeStaffingPlan("swarm_exec_stress", {
      ExecutorAgent: 300
    }, { maxParallelAgents: 300, executorLimit: 2, total: 300 });
    const executorRun = fakeSwarmRun(workspace, "swarm_exec_stress", executorPlan);
    const executorAgents = createAgentInstancesForPlan({ runId: executorRun.id, staffingPlan: executorPlan, templates });
    const executorItems = Array.from({ length: 30 }, (_, index) => fakeWorkItem(executorRun.id, `exec_${index}`, "execute", "ExecutorAgent", {
      write_files: [`src/stress${index}.ts`]
    }));
    const writeLimited = await new SwarmScheduler(workspace, new SwarmArtifactStore(workspace), new OrchestrationFileLockManager(workspace)).run({
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
    const result = await new CoreOrchestrator({ workspacePath: workspace }).planOnly("Explain src/file0.ts and do not change files.");
    assert.equal(result.run.status, "succeeded");
    assert.ok(result.report.limitations.some((limitation) => limitation.includes("Plan-only mode")));
    assert.ok(result.tasks.some((task) => task.role_required === "ScoutAgent"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

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
    artifacts_path: path.join(workspace, ".agent_memory", "swarm_runs", id)
  };
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
