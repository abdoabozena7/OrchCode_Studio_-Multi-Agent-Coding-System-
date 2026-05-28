import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJson } from "../memory/ProjectMemory.js";
import {
  AgentTeamManager,
  CoreOrchestrator,
  FactoryMetadataStore,
  OrchestrationArtifactStore,
  ORCHESTRATION_SCHEMA_VERSION,
  TeamSubPlanAggregator,
  TeamSubPlanner,
  createTeamSubPlan,
  createTeamSubPlanAggregation,
  createTeamSubPlanTaskDraft,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type AgentTeam,
  type AgentTeamType,
  type Run,
  type TeamSubPlan,
  type TeamSubPlanAggregation
} from "../orchestration/index.js";

test("TeamSubPlan models create task drafts dependencies risks validation strategy and aggregation", () => {
  const task = createTeamSubPlanTaskDraft({
    title: "Plan runtime work",
    objective: "Scope runtime implementation.",
    role_hint: "PlannerAgent",
    read_only: false,
    proposed_files: ["src/runtime.ts"],
    allowed_write_paths: ["src/runtime.ts"],
    forbidden_files: [".env"],
    required_context_refs: ["ctx"],
    evidence_refs: ["evidence"],
    validation_refs: ["validation"],
    rationale: "fixture"
  });
  const plan = createTeamSubPlan({
    run_id: "run_model",
    team_id: "team_runtime",
    team_domain: "runtime",
    team_type: "domain",
    objective: "Runtime objective",
    status: "generated",
    scope_summary: "runtime scope",
    assumptions: ["bounded"],
    proposed_tasks: [task],
    dependencies: [{
      dependency_id: "dep_model",
      dependency_type: "artifact",
      source_ref: "team_runtime",
      target_ref: "ctx",
      summary: "uses context",
      metadata_json: {}
    }],
    risks: [{
      risk_id: "risk_model",
      severity: "medium",
      summary: "scope risk",
      affected_files: ["src/runtime.ts"],
      mitigation: "validate scope",
      evidence_refs: ["evidence"],
      metadata_json: {}
    }],
    validation_strategy: {
      strategy_id: "validation_model",
      status: "planned",
      commands: ["git diff --check"],
      required_checks: ["scope"],
      artifact_refs: [],
      notes: ["not run"],
      metadata_json: {}
    },
    required_context_refs: ["ctx"],
    evidence_refs: ["evidence"],
    memory_scope_refs: [],
    lock_context_refs: [],
    budget_usage: {
      max_task_count: 6,
      proposed_task_count: 1,
      max_depth: 2,
      planned_depth: 1,
      max_active_writers: 1,
      provider_read_only_worker_budget: 4,
      budget_warnings: [],
      metadata_json: {}
    },
    unresolved_questions: [],
    confidence: 0.8,
    generation_mode: "deterministic",
    metadata_json: { team_allowed_files: ["src/runtime.ts"], team_forbidden_files: [".env"] }
  });
  const aggregation = createTeamSubPlanAggregation({
    run_id: "run_model",
    status: "generated",
    teams_planned: [plan.team_id],
    teams_skipped: [],
    accepted_sub_plans: [plan.sub_plan_id],
    invalid_sub_plans: [],
    cross_team_dependencies: [],
    duplicate_task_groups: [],
    scope_conflicts: [],
    validation_strategy_summary: ["planned"],
    top_risks: plan.risks,
    unresolved_questions: [],
    recommended_next_step: "review artifacts"
  });
  assert.equal(plan.proposed_tasks[0].task_draft_id, task.task_draft_id);
  assert.equal(aggregation.accepted_sub_plans[0], plan.sub_plan_id);
  assert.doesNotMatch(JSON.stringify(aggregation), /diff --git/);
});

test("TeamSubPlanner validates scope budget provider read-only and validation truth", async () => {
  const workspace = await fixtureWorkspace("team-sub-plan-validation");
  try {
    const planner = new TeamSubPlanner({ workspacePath: workspace, config: config({ max_team_sub_plan_tasks: 1 }) });
    const base = manualPlan({
      proposedFiles: ["src/runtime.ts"],
      writePaths: ["src/runtime.ts"],
      allowedFiles: ["src/runtime.ts"],
      forbiddenFiles: [".env"],
      maxTasks: 1,
      plannedDepth: 1
    });
    assert.equal(planner.validateTeamSubPlan(base).valid, true);
    assert.equal(planner.validateTeamSubPlan(manualPlan({ proposedFiles: ["package.json"], allowedFiles: ["src/"] })).valid, false);
    assert.equal(planner.validateTeamSubPlan(manualPlan({ proposedFiles: ["src/runtime.ts"], writePaths: [".env"], allowedFiles: ["src/", ".env"], forbiddenFiles: [".env"] })).valid, false);
    assert.equal(planner.validateTeamSubPlan(manualPlan({ taskCount: 2, allowedFiles: ["src/"], maxTasks: 1 })).valid, false);
    assert.equal(planner.validateTeamSubPlan(manualPlan({ plannedDepth: 3, allowedFiles: ["src/"], maxDepth: 2 })).valid, false);
    const passed = manualPlan({ allowedFiles: ["src/"] });
    passed.validation_strategy = { ...passed.validation_strategy, status: "passed" as "planned" };
    assert.equal(planner.validateTeamSubPlan(passed).valid, false);
    const providerWrite = manualPlan({ allowedFiles: ["src/"], generationMode: "provider_read_only", readOnly: false });
    assert.equal(planner.validateTeamSubPlan(providerWrite).valid, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamSubPlanner generates focused deterministic sub-plans for supported team types and auto provider fallback", async () => {
  const workspace = await fixtureWorkspace("team-sub-plan-generation");
  try {
    const run = fakeRun(workspace, "run_sub_plan_generation");
    const { manager, teams } = await createTeamFixture(workspace, run, ["domain", "review", "validation", "integration", "memory"]);
    const planner = new TeamSubPlanner({ workspacePath: workspace, config: config(), teamManager: manager });
    for (const team of teams) {
      const input = await planner.buildTeamSubPlanInput(team.team_id);
      const plan = await planner.generateTeamSubPlan(input);
      assert.equal(plan.status, "generated");
      assert.equal(plan.team_type, team.team_type);
      assert.notEqual(String(plan.validation_strategy.status), "passed");
      if (team.team_type === "review") assert.match(plan.proposed_tasks[0].title, /Review/);
      if (team.team_type === "validation") assert.match(plan.proposed_tasks[0].title, /validation/i);
      if (team.team_type === "integration") assert.match(plan.proposed_tasks[0].title, /integration/i);
      if (team.team_type === "memory") assert.match(plan.proposed_tasks[0].title, /memory/i);
    }
    const autoPlanner = new TeamSubPlanner({
      workspacePath: workspace,
      config: config({ team_sub_planning_mode: "auto", allow_provider_team_sub_planning: true }),
      teamManager: manager
    });
    const input = await autoPlanner.buildTeamSubPlanInput(teams[0].team_id);
    const fallback = await autoPlanner.generateTeamSubPlan(input);
    assert.equal(fallback.status, "generated");
    assert.equal(fallback.generation_mode, "mixed");
    assert.equal(fallback.metadata_json.deterministic_fallback, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamSubPlanner writes artifacts persists metadata and emits traces without full snippets", async () => {
  const workspace = await fixtureWorkspace("team-sub-plan-artifacts");
  try {
    const run = fakeRun(workspace, "run_sub_plan_artifacts");
    const { manager, teams } = await createTeamFixture(workspace, run, ["domain"]);
    const planner = new TeamSubPlanner({ workspacePath: workspace, config: config(), teamManager: manager });
    const input = await planner.buildTeamSubPlanInput(teams[0].team_id);
    const generated = await planner.generateTeamSubPlan(input);
    const withArtifacts = await planner.writeTeamSubPlanArtifacts(generated);
    const persisted = await planner.persistTeamSubPlan(withArtifacts);
    assert.ok(persisted.artifact_ref && existsSync(persisted.artifact_ref));
    assert.ok(persisted.summary_ref && existsSync(persisted.summary_ref));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const planRow = metadata.get<{ artifact_ref: string; metadata_json: string }>("SELECT artifact_ref, metadata_json FROM factory_team_sub_plans WHERE sub_plan_id = ?", persisted.sub_plan_id);
      assert.equal(planRow?.artifact_ref, persisted.artifact_ref);
      assert.doesNotMatch(planRow?.metadata_json ?? "", /export const/);
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plan_tasks WHERE sub_plan_id = ?", persisted.sub_plan_id)?.count, 1);
      assert.ok((metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plan_dependencies WHERE sub_plan_id = ?", persisted.sub_plan_id)?.count ?? 0) >= 1);
    } finally {
      metadata.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("team_sub_planning_started"));
    assert.ok(events.has("team_sub_plan_input_created"));
    assert.ok(events.has("team_sub_plan_generated"));
    assert.ok(events.has("team_sub_plan_persisted"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("TeamSubPlanAggregator skips invalid plans detects duplicates dependencies overlaps validation conflicts and persists summary", async () => {
  const workspace = await fixtureWorkspace("team-sub-plan-aggregation");
  try {
    const left = manualPlan({ teamId: "team_left", subPlanId: "sub_left", proposedFiles: ["src/shared.ts"], allowedFiles: ["src/"] });
    const right = manualPlan({ teamId: "team_right", subPlanId: "sub_right", proposedFiles: ["src/shared.ts"], allowedFiles: ["src/"] });
    right.dependencies.push({
      dependency_id: "dep_cross",
      dependency_type: "team",
      source_ref: right.team_id,
      target_ref: left.team_id,
      depends_on_team_id: left.team_id,
      summary: "right needs left",
      metadata_json: {}
    });
    const invalid = { ...manualPlan({ teamId: "team_invalid", subPlanId: "sub_invalid", allowedFiles: ["src/"] }), status: "invalid" as const };
    right.validation_strategy = { ...right.validation_strategy, commands: [] };
    const aggregator = new TeamSubPlanAggregator({ workspacePath: workspace });
    const aggregation = await aggregator.aggregate("run_manual", [left, right, invalid]);
    assert.equal(aggregation.accepted_sub_plans.length, 2);
    assert.deepEqual(aggregation.invalid_sub_plans, ["sub_invalid"]);
    assert.ok(aggregation.duplicate_task_groups.length >= 1);
    assert.ok(aggregation.cross_team_dependencies.length >= 1);
    assert.ok(aggregation.scope_conflicts.length >= 1);
    assert.ok(aggregation.artifact_ref && existsSync(aggregation.artifact_ref));
    assert.ok(aggregation.summary_ref && existsSync(aggregation.summary_ref));
    assertAggregateRoundTrips(aggregation);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(metadata.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plan_aggregations WHERE aggregation_id = ?", aggregation.aggregation_id)?.count, 1);
    } finally {
      metadata.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: "run_manual" });
    const events = new Set(trace.events.map((event) => event.event_type));
    assert.ok(events.has("team_sub_plan_aggregation_started"));
    assert.ok(events.has("team_sub_plan_aggregation_completed"));
    assert.ok(events.has("team_sub_plan_scope_conflict_detected"));
    assert.ok(events.has("team_sub_plan_dependency_detected"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only run records recursive planning summary without executor task graph changes", async () => {
  const workspace = await fixtureWorkspace("team-sub-plan-core");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      maxContextFiles: 3,
      maxContextChars: 3000,
      config: {
        execution_mode: "deep",
        enable_multi_plan_factory: true,
        enable_team_sub_planning: true,
        team_sub_planning_mode: "deterministic"
      }
    }).planOnly("Plan a medium orchestration and runtime change across src/runtime.ts and src/review.ts without editing files.");
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.tasks.every((task) => !task.id.startsWith("team_sub_plan_")), true);
    assert.equal(result.report.team_sub_planning_used, true);
    assert.ok((result.report.sub_plan_count ?? 0) >= 1);
    assert.ok(result.report.aggregation_ref && existsSync(result.report.aggregation_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createTeamFixture(workspace: string, run: Run, types: AgentTeamType[]) {
  const store = new OrchestrationArtifactStore(workspace);
  const manager = new AgentTeamManager({ workspacePath: workspace, artifactStore: store });
  const root = (await manager.createRootTeam(run, {
    scope: { allowed_files: ["src/"], forbidden_files: [".env", ".agent_memory/"] },
    budgets: { max_depth: 2, max_tasks: 6, max_active_writers: 1 }
  })).team;
  const teams: AgentTeam[] = [];
  for (const type of types) {
    teams.push((await manager.createChildTeam(root.team_id, {
      run_id: run.id,
      domain: `${type}-domain`,
      objective: `${type} objective`,
      team_type: type,
      scope: {
        allowed_files: [`src/${type}.ts`],
        forbidden_files: [".env", ".agent_memory/"],
        module_locks: [`module:${type}`],
        semantic_locks: [`semantic:${type}`],
        evidence_refs: [`evidence:${type}`]
      },
      budgets: { max_tasks: 4, max_depth: 2, max_active_writers: 1 }
    })).team);
  }
  return { manager, teams };
}

function manualPlan(input: {
  teamId?: string;
  subPlanId?: string;
  proposedFiles?: string[];
  writePaths?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  taskCount?: number;
  maxTasks?: number;
  maxDepth?: number;
  plannedDepth?: number;
  generationMode?: "deterministic" | "heuristic" | "provider_read_only" | "mixed";
  readOnly?: boolean;
}): TeamSubPlan {
  const taskCount = input.taskCount ?? 1;
  const tasks = Array.from({ length: taskCount }, (_, index) => createTeamSubPlanTaskDraft({
    task_draft_id: `task_draft_${input.teamId ?? "team"}_${index}`,
    title: "Duplicate scoped task",
    objective: "Plan the scoped work.",
    role_hint: "PlannerAgent",
    read_only: input.readOnly ?? false,
    proposed_files: input.proposedFiles ?? ["src/runtime.ts"],
    allowed_write_paths: input.writePaths ?? input.proposedFiles ?? ["src/runtime.ts"],
    forbidden_files: input.forbiddenFiles ?? [],
    required_context_refs: ["ctx"],
    evidence_refs: ["evidence"],
    validation_refs: [],
    rationale: "manual"
  }));
  return createTeamSubPlan({
    sub_plan_id: input.subPlanId ?? `sub_${input.teamId ?? "manual"}`,
    run_id: "run_manual",
    team_id: input.teamId ?? "team_manual",
    team_domain: "runtime",
    team_type: "domain",
    objective: "Manual plan",
    status: "generated",
    scope_summary: "manual scope",
    assumptions: [],
    proposed_tasks: tasks,
    dependencies: [],
    risks: [{
      risk_id: `risk_${input.teamId ?? "manual"}`,
      severity: "medium",
      summary: "Manual risk",
      affected_files: input.proposedFiles ?? [],
      mitigation: "Review",
      evidence_refs: [],
      metadata_json: {}
    }],
    validation_strategy: {
      strategy_id: "validation_manual",
      status: "planned",
      commands: ["git diff --check"],
      required_checks: ["scope"],
      artifact_refs: [],
      notes: ["not run"],
      metadata_json: {}
    },
    required_context_refs: ["ctx"],
    evidence_refs: ["evidence"],
    memory_scope_refs: [],
    lock_context_refs: [],
    budget_usage: {
      max_task_count: input.maxTasks ?? 6,
      proposed_task_count: taskCount,
      max_depth: input.maxDepth ?? 2,
      planned_depth: input.plannedDepth ?? 1,
      max_active_writers: 1,
      provider_read_only_worker_budget: 2,
      budget_warnings: [],
      metadata_json: {}
    },
    unresolved_questions: [],
    confidence: 0.8,
    generation_mode: input.generationMode ?? "deterministic",
    metadata_json: {
      team_allowed_files: input.allowedFiles ?? ["src/"],
      team_forbidden_files: input.forbiddenFiles ?? [],
      team_budget_max_tasks: input.maxTasks ?? 6,
      team_budget_max_depth: input.maxDepth ?? 2
    }
  });
}

function assertAggregateRoundTrips(aggregation: TeamSubPlanAggregation) {
  const parsed = JSON.parse(JSON.stringify(aggregation)) as TeamSubPlanAggregation;
  assert.equal(parsed.aggregation_id, aggregation.aggregation_id);
  assert.equal(parsed.accepted_sub_plans.length, aggregation.accepted_sub_plans.length);
}

function config(overrides: Partial<ReturnType<typeof loadOrchestrationConfig>> = {}) {
  return loadOrchestrationConfig({
    ...overrides,
    memory_path: ".agent_memory"
  });
}

function fakeRun(workspace: string, id: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Plan team sub-planning.",
    status: "planning",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: "memory",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 6,
      max_context_chars: 12000,
      max_task_attempts: 1,
      provider_mode: "mock"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "runtime.ts"), "export const runtime = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "review.ts"), "export const review = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "validation.ts"), "export const validation = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "integration.ts"), "export const integration = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "memory.ts"), "export const memory = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "domain.ts"), "export const domain = 1;\n", "utf8");
  await writeFile(path.join(root, "src", "shared.ts"), "export const shared = 1;\n", "utf8");
  return root;
}
