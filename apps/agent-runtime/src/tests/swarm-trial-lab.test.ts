import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMemoryRecords } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import {
  SpecialistAgentFactory,
  SwarmStaffingPlanner,
  type StaffingEvaluationResult,
  SwarmTrialArtifactStore,
  SwarmTrialLab,
  defaultStaffingScenarios
} from "../orchestration/index.js";

test("Phase 6 staffing eval creates experiment artifacts and run lifecycle records", async () => {
  const workspace = await fixtureWorkspace("trial-staffing", 72);
  try {
    await rebuildRepoIndex(workspace);
    const result = await new SwarmTrialLab({ workspacePath: workspace }).runStaffingEval();
    const store = new SwarmTrialArtifactStore(workspace);
    const paths = await store.pathsForExperiment(result.experiment.id);

    assert.equal(result.experiment.scenario_type, "automatic_staffing");
    assert.equal(result.staffingEvaluations.length, defaultStaffingScenarios().length);
    assert.equal(result.runs.length, result.staffingEvaluations.length);
    assert.ok(["succeeded", "failed"].includes(result.experiment.status));
    assert.equal(existsSync(paths.experiment), true);
    assert.equal(existsSync(paths.staffingEvaluations), true);
    assert.equal(existsSync(paths.trialReportJson), true);
    assert.equal(existsSync(paths.trialReportMarkdown), true);
    assert.match(await readFile(paths.trialReportMarkdown, "utf8"), /Staffing Accuracy/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 automatic staffing eval keeps tiny tasks small and huge read-only tasks wide", async () => {
  const workspace = await fixtureWorkspace("trial-sizing", 80);
  try {
    await rebuildRepoIndex(workspace);
    const result = await new SwarmTrialLab({ workspacePath: workspace }).runStaffingEval();
    const tiny = findEval(result.staffingEvaluations, "Tiny HTML/Text Change");
    const huge = findEval(result.staffingEvaluations, "Huge Read-Only Architecture Scan");

    assert.ok(tiny.actual_staffing_plan.recommended_total_logical_agents <= 8);
    assert.equal(tiny.actual_staffing_plan.executor_limit, 1);
    assert.ok(tiny.actual_staffing_plan.recommended_total_logical_agents < 300);
    assert.ok(huge.actual_staffing_plan.recommended_total_logical_agents >= 80);
    assert.equal(huge.actual_staffing_plan.executor_limit, 0);
    assert.ok(huge.actual_staffing_plan.read_only_ratio >= 0.95);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 risky edits cap executors and require justified specialists", async () => {
  const workspace = await fixtureWorkspace("trial-risk", 64);
  try {
    const snapshot = await rebuildRepoIndex(workspace);
    const planner = new SwarmStaffingPlanner();
    const auth = planner.createPlan({
      swarmRunId: "trial_auth",
      userGoal: "Modify the authentication/session/permission behavior.",
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    });
    const db = planner.createPlan({
      swarmRunId: "trial_db",
      userGoal: "Add or change database migration behavior.",
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    });

    assert.equal(auth.risk_level, "critical");
    assert.equal(auth.executor_limit, 1);
    assert.equal(auth.requires_human_approval, true);
    assert.ok(auth.specialist_agents.some((agent) => agent.role === "AuthSecurityReviewerAgent"));
    assert.equal(db.executor_limit, 2);
    assert.equal(db.requires_human_approval, true);
    assert.ok(db.specialist_agents.some((agent) => agent.role === "MigrationSafetyReviewerAgent"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 specialist selection adds only evidence-backed review-only specialists", () => {
  const factory = new SpecialistAgentFactory();
  const auth = factory.create({ userGoal: "Review auth token and session security" });
  const ui = factory.create({ userGoal: "Update shared React UI component accessibility", taskComplexity: "medium", candidateFiles: ["src/Button.tsx"] });
  const perf = factory.create({ userGoal: "Improve hot path cache performance" });
  const api = factory.create({ userGoal: "Preserve public API compatibility for SDK clients" });
  const simple = factory.create({ userGoal: "Change label text in one HTML file", taskComplexity: "tiny", candidateFiles: ["index.html"] });

  assert.ok(auth.some((agent) => agent.role === "AuthSecurityReviewerAgent" && agent.read_only));
  assert.ok(ui.some((agent) => agent.role === "AccessibilityReviewerAgent" && agent.read_only));
  assert.ok(perf.some((agent) => agent.role === "PerformanceReviewerAgent" && agent.read_only));
  assert.ok(api.some((agent) => agent.role === "APICompatibilityReviewerAgent" && agent.read_only));
  assert.equal(simple.length, 0);
});

test("Phase 6 comparison records baseline vs autopilot metrics and recommendations", async () => {
  const workspace = await fixtureWorkspace("trial-compare", 96);
  try {
    await rebuildRepoIndex(workspace);
    const result = await new SwarmTrialLab({ workspacePath: workspace }).runComparison("Refactor a cross-module service while preserving public API behavior.");
    const store = new SwarmTrialArtifactStore(workspace);
    const paths = await store.pathsForExperiment(result.experiment.id);

    assert.equal(result.experiment.scenario_type, "comparison");
    assert.ok(result.comparison);
    assert.equal(result.comparison.baseline_mode, "baseline-simple");
    assert.ok(result.comparison.compared_modes.includes("autopilot-deep"));
    assert.ok(result.comparison.mode_metrics["autopilot-deep"].selected_agents > result.comparison.mode_metrics["baseline-simple"].selected_agents);
    assert.match(result.comparison.recommendation, /tradeoff|winner|simple/);
    assert.equal(existsSync(paths.comparisonResult), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 scheduler-scale trial handles 300 logical mock agents without 300 executors", async () => {
  const workspace = await fixtureWorkspace("trial-scale", 32);
  try {
    await rebuildRepoIndex(workspace);
    const result = await new SwarmTrialLab({ workspacePath: workspace }).runSchedulerScale();
    const store = new SwarmTrialArtifactStore(workspace);
    const paths = await store.pathsForExperiment(result.experiment.id);

    assert.equal(result.schedulerScale.agent_instances, 300);
    assert.equal(result.schedulerScale.work_items, 300);
    assert.equal(result.schedulerScale.metrics.work_items_completed, 300);
    assert.equal(result.schedulerScale.executor_peak_count, 0);
    assert.equal(result.schedulerScale.metrics.peak_active_agents, 300);
    assert.equal(existsSync(result.schedulerScale.trace_ref), true);
    assert.match(await readFile(paths.trialReportMarkdown, "utf8"), /Scheduler Scale Trial|Safety/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Phase 6 reports include safety findings and tuning lessons with confidence metadata", async () => {
  const workspace = await fixtureWorkspace("trial-memory", 48);
  try {
    await rebuildRepoIndex(workspace);
    const result = await new SwarmTrialLab({ workspacePath: workspace }).runStaffingEval();
    const staffingLessons = await readMemoryRecords<Record<string, any>>(workspace, "swarm_staffing_lesson");
    const tuningHistory = await readMemoryRecords<Record<string, any>>(workspace, "swarm_tuning_history");
    const specialistHistory = await readMemoryRecords<Record<string, any>>(workspace, "swarm_specialist_selection");

    assert.ok(result.trialReport.safety_findings.length >= result.staffingEvaluations.length);
    assert.ok(result.trialReport.specialist_selection_findings.length >= result.staffingEvaluations.length);
    assert.ok(staffingLessons.length >= result.staffingEvaluations.length);
    assert.ok(tuningHistory.some((record) => typeof record.confidence === "number" && record.evidence_count >= 1));
    assert.ok(specialistHistory.some((record) => Array.isArray(record.selected_staffing.specialists)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string, fileCount: number) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
  await mkdir(path.join(workspace, "src", "db"), { recursive: true });
  await mkdir(path.join(workspace, "src", "ui"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "swarm-trial-fixture",
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  }, null, 2), "utf8");
  await writeFile(path.join(workspace, "src", "auth", "session.ts"), "export const session = 'ok';\n", "utf8");
  await writeFile(path.join(workspace, "src", "db", "migration.ts"), "export const migration = 'safe';\n", "utf8");
  await writeFile(path.join(workspace, "src", "ui", "Button.tsx"), "export const Button = () => null;\n", "utf8");
  await writeFile(path.join(workspace, "tests", "session.test.ts"), "import '../src/auth/session';\n", "utf8");
  for (let index = 0; index < fileCount; index += 1) {
    await writeFile(path.join(workspace, "src", `module${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
  }
  return workspace;
}

function findEval(evaluations: StaffingEvaluationResult[], title: string) {
  const scenario = defaultStaffingScenarios().find((entry) => entry.title === title);
  assert.ok(scenario);
  const evaluation = evaluations.find((entry) => entry.input_goal === scenario.input_goal);
  assert.ok(evaluation);
  return evaluation;
}
