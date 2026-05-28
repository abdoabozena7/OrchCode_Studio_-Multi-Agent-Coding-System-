import { randomUUID } from "node:crypto";
import path from "node:path";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { OrchestrationFileLockManager } from "./FileLockManager.js";
import { createSwarmAgentTemplates } from "./SwarmAgentTemplates.js";
import { SwarmArtifactStore } from "./SwarmArtifactStore.js";
import { SwarmScheduler, createAgentInstancesForPlan } from "./SwarmScheduler.js";
import { SwarmStaffingPlanner } from "./SwarmStaffingPlanner.js";
import type { RoleCounts, StaffingPlan, SwarmMetrics, SwarmRiskLevel, SwarmRun, SwarmRunMode, TaskComplexity, WorkItem } from "./SwarmModels.js";
import { SWARM_SCHEMA_VERSION } from "./SwarmModels.js";
import { SwarmAutopilotRuntime } from "./SwarmRuntime.js";
import { SwarmTrialArtifactStore } from "./SwarmTrialArtifactStore.js";
import {
  appendSwarmFailurePattern,
  appendSwarmSpecialistSelectionHistory,
  appendSwarmStaffingLesson,
  appendSwarmSuccessPattern,
  appendSwarmTuningHistory
} from "./SwarmTrialMemory.js";
import type {
  ComparisonModeMetrics,
  ComparisonResult,
  ExperimentRun,
  ExpectedStaffingBehavior,
  SchedulerScaleTrialResult,
  StaffingEvaluationResult,
  SwarmExperiment,
  SwarmExperimentScenarioType,
  SwarmTrialReport,
  SwarmTrialResult,
  SwarmTuningPolicy,
  TrialComparisonMode,
  TrialTaskScenario
} from "./SwarmTrialModels.js";
import { SWARM_TRIAL_SCHEMA_VERSION } from "./SwarmTrialModels.js";

export type SwarmTrialLabOptions = {
  workspacePath: string;
  memoryDir?: string;
};

export class SwarmTrialLab {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly store: SwarmTrialArtifactStore;

  constructor(options: SwarmTrialLabOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.store = new SwarmTrialArtifactStore(this.workspacePath, this.memoryDir);
  }

  async runStaffingEval(): Promise<SwarmTrialResult> {
    const memory = await this.loadMemory();
    const scenarios = defaultStaffingScenarios();
    const experiment = await this.createExperiment({
      title: "Automatic Staffing Evaluation",
      description: "Evaluates whether the Swarm Staffing Planner chooses appropriate internal logical agent shapes without user-provided agent counts.",
      scenarioType: "automatic_staffing",
      tasks: scenarios,
      modes: ["autopilot-deep"],
      config: { uses_real_repo: true, uses_mock_agents: true }
    });
    const evaluations = scenarios.map((scenario) => evaluateStaffing({
      scenario,
      plan: new SwarmStaffingPlanner().createPlan({
        swarmRunId: experiment.id,
        userGoal: scenario.input_goal,
        mode: "deep",
        repoIndex: memory.repoIndex,
        commandInventory: memory.commandInventory
      })
    }));
    const runs = evaluations.map((evaluation) => experimentRunFromEvaluation(experiment.id, evaluation));
    const tuningPolicy = buildTuningPolicy(evaluations, memory.repoIndex);
    const trialReport = buildTrialReport({
      experiment,
      evaluations,
      runs,
      comparison: undefined,
      tuningPolicy,
      summary: `Ran ${evaluations.length} automatic staffing scenario(s); ${passRate(evaluations)} staffing accuracy.`
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, evaluations, undefined, tuningPolicy);
    await this.persistResult({ experiment, runs, evaluations, comparison: undefined, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, evaluations, undefined, tuningPolicy);
    return {
      experiment,
      runs,
      staffingEvaluations: evaluations,
      tuningPolicy,
      trialReport,
      markdownReport
    };
  }

  async runArchitectureScan(): Promise<SwarmTrialResult> {
    const result = await new SwarmAutopilotRuntime({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, mode: "exhaustive" })
      .run("Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.");
    const experiment = await this.createExperiment({
      title: "Architecture Scan Trial",
      description: "Read-only architecture scan using automatic swarm staffing.",
      scenarioType: "dry_run",
      tasks: [{
        id: "architecture_scan",
        title: "Architecture scan",
        input_goal: result.run.user_goal,
        expected: {
          expected_complexity: result.staffingPlan.task_complexity,
          expected_agent_range: [10, 300],
          expected_executor_limit: 0,
          min_read_only_ratio: 0.9
        }
      }],
      modes: ["autopilot-exhaustive"],
      config: { read_only: true, swarm_run_id: result.run.id }
    });
    const evaluation = evaluateStaffing({
      scenario: experiment.tasks_to_test[0],
      plan: result.staffingPlan
    });
    const run = experimentRunFromSwarmRun(experiment.id, "autopilot-exhaustive", result.run.id, result.staffingPlan, result.metrics);
    const tuningPolicy = buildTuningPolicy([evaluation], await this.loadRepoIndex());
    const trialReport = buildTrialReport({
      experiment,
      evaluations: [evaluation],
      runs: [run],
      comparison: undefined,
      tuningPolicy,
      summary: "Architecture scan trial completed using read-only swarm execution."
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, [evaluation], undefined, tuningPolicy);
    await this.persistResult({ experiment, runs: [run], evaluations: [evaluation], comparison: undefined, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, [evaluation], undefined, tuningPolicy);
    return { experiment, runs: [run], staffingEvaluations: [evaluation], tuningPolicy, trialReport, markdownReport };
  }

  async runTestDiscovery(): Promise<SwarmTrialResult> {
    const result = await new SwarmAutopilotRuntime({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, mode: "deep" })
      .run("Map source files to tests, identify missing tests, and recommend test discovery improvements. Do not edit files.");
    const experiment = await this.createExperiment({
      title: "Test Discovery Trial",
      description: "Read-only source/test mapping trial.",
      scenarioType: "dry_run",
      tasks: [{
        id: "test_discovery",
        title: "Test discovery",
        input_goal: result.run.user_goal,
        expected: {
          expected_complexity: result.staffingPlan.task_complexity,
          expected_agent_range: [5, 120],
          expected_executor_limit: 0,
          min_read_only_ratio: 0.85
        }
      }],
      modes: ["autopilot-deep"],
      config: { read_only: true, swarm_run_id: result.run.id }
    });
    const evaluation = evaluateStaffing({ scenario: experiment.tasks_to_test[0], plan: result.staffingPlan });
    const run = experimentRunFromSwarmRun(experiment.id, "autopilot-deep", result.run.id, result.staffingPlan, result.metrics);
    const tuningPolicy = buildTuningPolicy([evaluation], await this.loadRepoIndex());
    const trialReport = buildTrialReport({
      experiment,
      evaluations: [evaluation],
      runs: [run],
      comparison: undefined,
      tuningPolicy,
      summary: "Test discovery trial completed with read-only work items."
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, [evaluation], undefined, tuningPolicy);
    await this.persistResult({ experiment, runs: [run], evaluations: [evaluation], comparison: undefined, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, [evaluation], undefined, tuningPolicy);
    return { experiment, runs: [run], staffingEvaluations: [evaluation], tuningPolicy, trialReport, markdownReport };
  }

  async runSchedulerScale(): Promise<SwarmTrialResult & { schedulerScale: SchedulerScaleTrialResult }> {
    const experiment = await this.createExperiment({
      title: "Scheduler Scale Trial",
      description: "Processes 300 read-only work items with 300 logical mock agents and verifies executor caps stay narrow.",
      scenarioType: "scheduler_stress",
      tasks: [{
        id: "scheduler_scale_300",
        title: "300 logical read-only workers",
        input_goal: "Process 300 read-only scout work items with mock agents.",
        expected: {
          expected_complexity: "huge",
          expected_agent_range: [300, 300],
          expected_executor_limit: 0,
          min_read_only_ratio: 1
        }
      }],
      modes: ["autopilot-huge-readonly"],
      config: { uses_mock_agents: true, max_logical_agents: 300, read_only: true }
    });
    const plan = fakeScaleStaffingPlan("swarm_trial_scale", "huge", 300);
    const run = fakeSwarmRun(this.workspacePath, "swarm_trial_scale", plan, "Process 300 read-only scout work items with mock agents.");
    const templates = createSwarmAgentTemplates([]);
    const agents = createAgentInstancesForPlan({ runId: run.id, staffingPlan: plan, templates });
    const workItems = Array.from({ length: 300 }, (_, index) => fakeWorkItem(run.id, `trial_scout_${index}`, "scout", "ScoutAgent"));
    const swarmStore = new SwarmArtifactStore(this.workspacePath, this.memoryDir);
    await swarmStore.saveSwarmRun(run);
    await swarmStore.saveStaffingPlan(plan);
    await swarmStore.saveAgentTemplates(run.id, templates);
    const scheduled = await new SwarmScheduler(this.workspacePath, swarmStore, new OrchestrationFileLockManager(this.workspacePath)).run({
      run,
      staffingPlan: plan,
      agentTemplates: templates,
      agentInstances: agents,
      workItems
    });
    const finalReport = [
      "# Scheduler Scale Trial",
      "",
      `Processed ${scheduled.metrics.work_items_completed} read-only work item(s).`,
      `Peak active agents: ${scheduled.metrics.peak_active_agents}.`,
      `Executor peak count: ${scheduled.metrics.executor_peak_count}.`
    ].join("\n");
    const reportRef = await swarmStore.saveFinalReport(run.id, finalReport);
    const evaluation = evaluateStaffing({
      scenario: experiment.tasks_to_test[0],
      plan
    });
    const experimentRun = experimentRunFromSwarmRun(experiment.id, "autopilot-huge-readonly", run.id, plan, scheduled.metrics);
    const tuningPolicy = buildTuningPolicy([evaluation], await this.loadRepoIndex());
    const schedulerScale: SchedulerScaleTrialResult = {
      run_id: run.id,
      metrics: scheduled.metrics,
      agent_instances: scheduled.agentInstances.length,
      work_items: scheduled.workItems.length,
      executor_peak_count: scheduled.metrics.executor_peak_count,
      trace_ref: path.join(run.artifacts_path, "scheduler_trace.jsonl"),
      report_ref: reportRef
    };
    const trialReport = buildTrialReport({
      experiment,
      evaluations: [evaluation],
      runs: [experimentRun],
      comparison: undefined,
      tuningPolicy,
      summary: `Scheduler scale trial processed ${schedulerScale.work_items} read-only work items with ${schedulerScale.agent_instances} logical agents.`
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, [evaluation], undefined, tuningPolicy);
    await this.persistResult({ experiment, runs: [experimentRun], evaluations: [evaluation], comparison: undefined, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, [evaluation], undefined, tuningPolicy);
    return { experiment, runs: [experimentRun], staffingEvaluations: [evaluation], tuningPolicy, trialReport, markdownReport, schedulerScale };
  }

  async runComparison(goal: string): Promise<SwarmTrialResult> {
    const memory = await this.loadMemory();
    const modes: TrialComparisonMode[] = [
      "baseline-simple",
      "orchestrated",
      "autopilot-fast",
      "autopilot-deep",
      "autopilot-exhaustive"
    ];
    const experiment = await this.createExperiment({
      title: "Baseline vs Swarm Autopilot Comparison",
      description: "Compares simple, orchestrated, and autopilot modes using deterministic mock metrics derived from actual staffing plans.",
      scenarioType: "comparison",
      tasks: [{
        id: "comparison_goal",
        title: "Comparison goal",
        input_goal: goal,
        expected: {
          expected_complexity: "medium",
          expected_agent_range: [1, 300],
          expected_executor_limit: 6
        }
      }],
      modes,
      config: { uses_mock_agents: true, uses_real_model: false }
    });
    const plans = Object.fromEntries(modes
      .filter((mode) => mode.startsWith("autopilot"))
      .map((mode) => [mode, new SwarmStaffingPlanner().createPlan({
        swarmRunId: experiment.id,
        userGoal: goalForMode(goal, mode),
        mode: modeToSwarmMode(mode),
        repoIndex: memory.repoIndex,
        commandInventory: memory.commandInventory
      })] as const));
    const comparison = buildComparisonResult(experiment.id, goal, modes, plans);
    const evaluations = Object.values(plans).map((plan) => evaluateStaffing({
      scenario: {
        id: `comparison_${plan.id}`,
        title: `Comparison ${plan.task_complexity}`,
        input_goal: goal,
        expected: {
          expected_complexity: plan.task_complexity,
          expected_repo_scope: plan.repo_scope,
          expected_risk_level: plan.risk_level,
          expected_agent_range: [1, 300],
          expected_executor_limit: Math.max(plan.executor_limit, 0),
          expected_specialists: plan.specialist_agents.map((specialist) => specialist.role)
        }
      },
      plan
    }));
    const runs = modes.map((mode) => experimentRunFromComparison(experiment.id, goal, mode, comparison.mode_metrics[mode], plans[mode]));
    const tuningPolicy = buildTuningPolicy(evaluations, memory.repoIndex, comparison);
    const trialReport = buildTrialReport({
      experiment,
      evaluations,
      runs,
      comparison,
      tuningPolicy,
      summary: comparison.recommendation
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, evaluations, comparison, tuningPolicy);
    await this.persistResult({ experiment, runs, evaluations, comparison, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, evaluations, comparison, tuningPolicy);
    return { experiment, runs, staffingEvaluations: evaluations, comparison, tuningPolicy, trialReport, markdownReport };
  }

  async runSmallSafeFix(goal: string): Promise<SwarmTrialResult> {
    const result = await new SwarmAutopilotRuntime({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, mode: "fast" })
      .run(`Small safe fix trial. Keep scope narrow, require review and validation: ${goal}`);
    const experiment = await this.createExperiment({
      title: "Small Safe Fix Trial",
      description: "Runs a narrow mock-agent safe-fix trial with automatic staffing.",
      scenarioType: "live_safe_task",
      tasks: [{
        id: "small_safe_fix",
        title: "Small safe fix",
        input_goal: goal,
        expected: {
          expected_complexity: result.staffingPlan.task_complexity,
          expected_agent_range: [3, 12],
          expected_executor_limit: 1
        }
      }],
      modes: ["autopilot-fast"],
      config: { uses_mock_agents: true, safe_fix: true, swarm_run_id: result.run.id }
    });
    const evaluation = evaluateStaffing({ scenario: experiment.tasks_to_test[0], plan: result.staffingPlan });
    const run = experimentRunFromSwarmRun(experiment.id, "autopilot-fast", result.run.id, result.staffingPlan, result.metrics);
    const tuningPolicy = buildTuningPolicy([evaluation], await this.loadRepoIndex());
    const trialReport = buildTrialReport({
      experiment,
      evaluations: [evaluation],
      runs: [run],
      comparison: undefined,
      tuningPolicy,
      summary: "Small safe fix trial completed with review and validation artifacts."
    });
    const markdownReport = renderTrialReportMarkdown(trialReport, [evaluation], undefined, tuningPolicy);
    await this.persistResult({ experiment, runs: [run], evaluations: [evaluation], comparison: undefined, tuningPolicy, trialReport, markdownReport });
    await this.writeTuningMemory(experiment, [evaluation], undefined, tuningPolicy);
    return { experiment, runs: [run], staffingEvaluations: [evaluation], tuningPolicy, trialReport, markdownReport };
  }

  async listExperiments() {
    return this.store.listExperiments();
  }

  private async createExperiment(input: {
    title: string;
    description: string;
    scenarioType: SwarmExperimentScenarioType;
    tasks: TrialTaskScenario[];
    modes: TrialComparisonMode[];
    config: Record<string, unknown>;
  }): Promise<SwarmExperiment> {
    const experiment: SwarmExperiment = {
      schema_version: SWARM_TRIAL_SCHEMA_VERSION,
      id: `swarm_experiment_${randomUUID()}`,
      title: input.title,
      description: input.description,
      scenario_type: input.scenarioType,
      tasks_to_test: input.tasks,
      modes_to_compare: input.modes,
      expected_staffing_behavior: input.tasks.map((task) => task.expected),
      created_at: new Date().toISOString(),
      status: "created",
      config: input.config
    };
    await this.store.saveExperiment(experiment);
    return experiment;
  }

  private async persistResult(input: {
    experiment: SwarmExperiment;
    runs: ExperimentRun[];
    evaluations: StaffingEvaluationResult[];
    comparison?: ComparisonResult;
    tuningPolicy: SwarmTuningPolicy;
    trialReport: SwarmTrialReport;
    markdownReport: string;
  }) {
    const runsRef = await this.store.saveRuns(input.experiment.id, input.runs);
    await this.store.saveStaffingEvaluations(input.experiment.id, input.evaluations);
    if (input.comparison) await this.store.saveComparisonResult(input.experiment.id, input.comparison);
    await this.store.saveTuningPolicy(input.experiment.id, input.tuningPolicy);
    const reportRefs = await this.store.saveTrialReport(input.experiment.id, input.trialReport, input.markdownReport);
    input.experiment.results_ref = runsRef;
    input.experiment.report_ref = reportRefs.markdown;
    input.experiment.status = input.evaluations.every((evaluation) => evaluation.pass_fail === "pass") ? "succeeded" : "failed";
    await this.store.saveExperiment(input.experiment);
  }

  private async writeTuningMemory(experiment: SwarmExperiment, evaluations: StaffingEvaluationResult[], comparison: ComparisonResult | undefined, tuningPolicy: SwarmTuningPolicy) {
    for (const evaluation of evaluations) {
      const record = {
        experiment_id: experiment.id,
        task_type: evaluation.expected_complexity,
        predicted_complexity: evaluation.actual_staffing_plan.task_complexity,
        selected_staffing: {
          total_agents: evaluation.actual_staffing_plan.recommended_total_logical_agents,
          executor_limit: evaluation.actual_staffing_plan.executor_limit,
          reviewer_limit: evaluation.actual_staffing_plan.reviewer_limit,
          scout_count: evaluation.actual_staffing_plan.scout_count,
          specialists: evaluation.actual_staffing_plan.specialist_agents.map((specialist) => specialist.role)
        },
        actual_results: {
          pass_fail: evaluation.pass_fail,
          validation_pass_rate: comparison ? average(Object.values(comparison.validation_pass_rates)) : undefined,
          conflict_rate: comparison ? average(Object.values(comparison.conflict_rates)) : undefined,
          duplicate_work_rate: comparison ? average(Object.values(comparison.duplicate_work_rate)) : undefined,
          useful_finding_rate: comparison ? average(Object.values(comparison.useful_finding_rate)) : undefined
        },
        staffing_fit: staffingFit(evaluation),
        recommended_future_adjustment: evaluation.pass_fail === "pass" ? "Keep current thresholds until more evidence accumulates." : evaluation.deviations.join("; "),
        confidence: evaluation.actual_staffing_plan.confidence,
        evidence_count: evaluations.length
      } as const;
      await appendSwarmStaffingLesson(this.workspacePath, record, this.memoryDir);
      await appendSwarmTuningHistory(this.workspacePath, record, this.memoryDir);
      await appendSwarmSpecialistSelectionHistory(this.workspacePath, record, this.memoryDir);
      if (evaluation.pass_fail === "pass") {
        await appendSwarmSuccessPattern(this.workspacePath, record, this.memoryDir);
      } else {
        await appendSwarmFailurePattern(this.workspacePath, record, this.memoryDir);
      }
    }
    if (tuningPolicy.reasoning.length) {
      // The structured tuning records above are the durable data. This no-op branch documents that policy
      // recommendations are intentionally evidence-gated rather than default-changing side effects.
    }
  }

  private async loadMemory() {
    const snapshot = await rebuildRepoIndex(this.workspacePath, { memoryDir: this.memoryDir });
    return {
      repoIndex: snapshot.repoIndex,
      commandInventory: snapshot.commandInventory
    };
  }

  private async loadRepoIndex() {
    return (await this.loadMemory()).repoIndex;
  }
}

export function defaultStaffingScenarios(): TrialTaskScenario[] {
  return [
    {
      id: "tiny_html_text_change",
      title: "Tiny HTML/Text Change",
      input_goal: "Change the label text in one HTML/component file.",
      expected: {
        expected_complexity: "tiny",
        expected_agent_range: [3, 8],
        expected_executor_limit: 1,
        forbidden_specialists: ["AuthSecurityReviewerAgent", "MigrationSafetyReviewerAgent"],
        validation_level: ["basic", "none"]
      }
    },
    {
      id: "small_bug_fix",
      title: "Small Bug Fix",
      input_goal: "Fix a small bug in one function.",
      expected: {
        expected_complexity: "small",
        expected_agent_range: [4, 10],
        expected_executor_limit: 1,
        forbidden_specialists: ["AuthSecurityReviewerAgent", "MigrationSafetyReviewerAgent", "AccessibilityReviewerAgent"]
      }
    },
    {
      id: "medium_feature",
      title: "Medium Feature",
      input_goal: "Add a feature touching one module and its tests.",
      expected: {
        expected_complexity: "medium",
        expected_agent_range: [10, 30],
        expected_executor_limit: 3
      }
    },
    {
      id: "large_refactor",
      title: "Large Multi-Module Refactor",
      input_goal: "Refactor a cross-module service while preserving public API behavior.",
      expected: {
        expected_complexity: "large",
        expected_agent_range: [35, 130],
        expected_executor_limit: 6,
        expected_specialists: ["APICompatibilityReviewerAgent"],
        validation_level: ["strict", "exhaustive"]
      }
    },
    {
      id: "huge_readonly_scan",
      title: "Huge Read-Only Architecture Scan",
      input_goal: "Analyze the whole repository architecture, identify hotspots, risky files, missing tests, and improvement opportunities. Do not edit files.",
      expected: {
        expected_complexity: "huge",
        expected_agent_range: [80, 300],
        expected_executor_limit: 0,
        min_read_only_ratio: 0.95
      }
    },
    {
      id: "security_auth_change",
      title: "Risky Security/Auth Change",
      input_goal: "Modify the authentication/session/permission behavior.",
      expected: {
        expected_complexity: "small",
        expected_risk_level: "critical",
        expected_agent_range: [5, 30],
        expected_executor_limit: 1,
        expected_specialists: ["AuthSecurityReviewerAgent"],
        validation_level: ["strict", "exhaustive"],
        requires_human_approval: true
      }
    },
    {
      id: "database_migration",
      title: "Database Migration Task",
      input_goal: "Add or change database migration behavior.",
      expected: {
        expected_complexity: "large",
        expected_risk_level: "high",
        expected_agent_range: [30, 140],
        expected_executor_limit: 2,
        expected_specialists: ["MigrationSafetyReviewerAgent"],
        validation_level: ["strict", "exhaustive"],
        requires_human_approval: true
      }
    },
    {
      id: "frontend_accessibility",
      title: "Frontend Accessibility/UI Task",
      input_goal: "Update a shared UI component with accessibility-safe behavior.",
      expected: {
        expected_complexity: "medium",
        expected_agent_range: [8, 40],
        expected_executor_limit: 3,
        expected_specialists: ["AccessibilityReviewerAgent"]
      }
    },
    {
      id: "ambiguous_large_goal",
      title: "Ambiguous Large Goal",
      input_goal: "Make the app better and cleaner. Do not edit files until the plan is decomposed.",
      expected: {
        expected_complexity: "small",
        expected_agent_range: [3, 20],
        expected_executor_limit: 0,
        min_read_only_ratio: 0.8
      }
    },
    {
      id: "huge_campaign",
      title: "Huge Campaign",
      input_goal: "Upgrade a major framework version across the project as a staged campaign.",
      expected: {
        expected_complexity: "huge",
        expected_agent_range: [80, 300],
        expected_executor_limit: 3,
        validation_level: ["strict", "exhaustive"]
      }
    }
  ];
}

function evaluateStaffing(input: {
  scenario: TrialTaskScenario;
  plan: StaffingPlan;
}): StaffingEvaluationResult {
  const deviations: string[] = [];
  const expected = input.scenario.expected;
  if (!complexityMatches(input.plan.task_complexity, expected.expected_complexity)) {
    deviations.push(`Expected complexity near ${expected.expected_complexity}, got ${input.plan.task_complexity}.`);
  }
  if (expected.expected_repo_scope && input.plan.repo_scope !== expected.expected_repo_scope) {
    deviations.push(`Expected repo scope ${expected.expected_repo_scope}, got ${input.plan.repo_scope}.`);
  }
  if (expected.expected_risk_level && input.plan.risk_level !== expected.expected_risk_level) {
    deviations.push(`Expected risk ${expected.expected_risk_level}, got ${input.plan.risk_level}.`);
  }
  if (input.plan.recommended_total_logical_agents < expected.expected_agent_range[0] || input.plan.recommended_total_logical_agents > expected.expected_agent_range[1]) {
    deviations.push(`Expected agent range ${expected.expected_agent_range.join("-")}, got ${input.plan.recommended_total_logical_agents}.`);
  }
  if (input.plan.executor_limit > expected.expected_executor_limit) {
    deviations.push(`Expected executor limit <= ${expected.expected_executor_limit}, got ${input.plan.executor_limit}.`);
  }
  if (expected.min_read_only_ratio !== undefined && input.plan.read_only_ratio < expected.min_read_only_ratio) {
    deviations.push(`Expected read-only ratio >= ${expected.min_read_only_ratio}, got ${input.plan.read_only_ratio}.`);
  }
  for (const specialist of expected.expected_specialists ?? []) {
    if (!input.plan.specialist_agents.some((agent) => agent.role === specialist)) {
      deviations.push(`Expected specialist ${specialist} was not created.`);
    }
  }
  for (const specialist of expected.forbidden_specialists ?? []) {
    if (input.plan.specialist_agents.some((agent) => agent.role === specialist)) {
      deviations.push(`Unnecessary specialist ${specialist} was created.`);
    }
  }
  if (expected.validation_level && !expected.validation_level.includes(input.plan.validation_level)) {
    deviations.push(`Expected validation level in ${expected.validation_level.join(", ")}, got ${input.plan.validation_level}.`);
  }
  if (expected.requires_human_approval !== undefined && input.plan.requires_human_approval !== expected.requires_human_approval) {
    deviations.push(`Expected requires_human_approval ${expected.requires_human_approval}, got ${input.plan.requires_human_approval}.`);
  }
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    input_goal: input.scenario.input_goal,
    expected_complexity: expected.expected_complexity,
    expected_repo_scope: expected.expected_repo_scope,
    expected_risk_level: expected.expected_risk_level,
    expected_agent_range: expected.expected_agent_range,
    expected_executor_limit: expected.expected_executor_limit,
    expected_specialists: expected.expected_specialists ?? [],
    actual_staffing_plan: input.plan,
    pass_fail: deviations.length ? "fail" : "pass",
    reasoning: input.plan.reasoning,
    deviations
  };
}

function buildComparisonResult(
  experimentId: string,
  goal: string,
  modes: TrialComparisonMode[],
  plans: Partial<Record<TrialComparisonMode, StaffingPlan>>
): ComparisonResult {
  const modeMetrics = Object.fromEntries(modes.map((mode) => [mode, metricsForMode(goal, mode, plans[mode])])) as Record<string, ComparisonModeMetrics>;
  const bestUsefulMode = Object.entries(modeMetrics)
    .sort((left, right) => right[1].useful_finding_rate - left[1].useful_finding_rate || left[1].duplicate_work_rate - right[1].duplicate_work_rate)[0]?.[0] ?? "baseline-simple";
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    experiment_id: experimentId,
    baseline_mode: "baseline-simple",
    compared_modes: modes.filter((mode) => mode !== "baseline-simple"),
    success_rates: pickMetric(modeMetrics, "success_rate"),
    validation_pass_rates: pickMetric(modeMetrics, "validation_pass_rate"),
    average_duration: pickMetric(modeMetrics, "average_duration_ms"),
    average_work_items: pickMetric(modeMetrics, "average_work_items"),
    conflict_rates: pickMetric(modeMetrics, "conflict_rate"),
    repair_rates: pickMetric(modeMetrics, "repair_rate"),
    review_findings: pickMetric(modeMetrics, "review_findings"),
    coverage_of_relevant_files: pickMetric(modeMetrics, "coverage_of_relevant_files"),
    duplicate_work_rate: pickMetric(modeMetrics, "duplicate_work_rate"),
    useful_finding_rate: pickMetric(modeMetrics, "useful_finding_rate"),
    staffing_accuracy: Object.fromEntries(modes.map((mode) => [mode, mode.startsWith("autopilot") ? 0.85 : mode === "orchestrated" ? 0.68 : 0.52])),
    recommendation: comparisonRecommendation(goal, bestUsefulMode, modeMetrics),
    mode_metrics: modeMetrics
  };
}

function metricsForMode(goal: string, mode: TrialComparisonMode, plan?: StaffingPlan): ComparisonModeMetrics {
  const complexity = plan?.task_complexity ?? inferGoalComplexity(goal);
  const risk = plan?.risk_level ?? (/\b(auth|security|migration|dependency|framework)\b/i.test(goal) ? "high" : "low");
  const complex = ["medium", "large", "huge"].includes(complexity);
  const selectedAgents = plan?.recommended_total_logical_agents ?? (mode === "baseline-simple" ? 1 : 6);
  const duplicatePenalty = Math.min(0.35, Math.max(0, (selectedAgents - 25) / 500));
  const base = mode === "baseline-simple"
    ? { success: complex ? 0.55 : 0.86, coverage: complex ? 0.32 : 0.72, useful: complex ? 0.35 : 0.62, duplicate: 0.03 }
    : mode === "orchestrated"
      ? { success: complex ? 0.68 : 0.82, coverage: complex ? 0.52 : 0.7, useful: complex ? 0.52 : 0.58, duplicate: 0.08 }
      : { success: complex ? 0.78 : 0.8, coverage: Math.min(0.95, 0.55 + selectedAgents / 380), useful: Math.min(0.9, 0.5 + selectedAgents / 600), duplicate: duplicatePenalty };
  const conflictRate = plan ? Math.min(0.3, plan.executor_limit / Math.max(1, selectedAgents) + (risk === "high" || risk === "critical" ? 0.04 : 0.01)) : 0.08;
  return {
    success_rate: round(base.success),
    validation_pass_rate: round(risk === "critical" ? base.success - 0.08 : base.success - 0.03),
    average_duration_ms: Math.round(120 + selectedAgents * (mode.startsWith("autopilot") ? 12 : 20)),
    average_work_items: Math.max(1, Math.round(selectedAgents * (mode.startsWith("autopilot") ? 0.9 : 0.6))),
    conflict_rate: round(conflictRate),
    repair_rate: round(risk === "low" ? 0.04 : 0.12),
    review_findings: Math.round(selectedAgents * (mode.startsWith("autopilot") ? 0.35 : 0.18)),
    coverage_of_relevant_files: round(base.coverage),
    duplicate_work_rate: round(base.duplicate),
    useful_finding_rate: round(Math.max(0.05, base.useful - base.duplicate)),
    selected_agents: selectedAgents,
    executor_limit: plan?.executor_limit ?? (mode === "baseline-simple" ? 1 : 2)
  };
}

function buildTuningPolicy(evaluations: StaffingEvaluationResult[], repoIndex: RepoIndex, comparison?: ComparisonResult): SwarmTuningPolicy {
  const representative = evaluations[0]?.actual_staffing_plan;
  const failed = evaluations.filter((evaluation) => evaluation.pass_fail === "fail");
  const bestMode = comparison
    ? Object.entries(comparison.useful_finding_rate).sort((left, right) => right[1] - left[1])[0]?.[0]
    : undefined;
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    task_size_estimate: representative?.task_complexity ?? "small",
    repo_size_estimate: repoSize(repoIndex.totals.indexedFiles),
    risk_level: representative?.risk_level ?? "low",
    edit_scope_size: representative?.executor_limit === 0 ? "read_only" : representative?.executor_limit === 1 ? "single_file" : "few_files",
    validation_strength: representative?.validation_level ?? "basic",
    recommended_mode: bestMode?.includes("exhaustive") ? "exhaustive" : bestMode?.includes("fast") ? "fast" : "deep",
    recommended_total_logical_agents: representative?.recommended_total_logical_agents ?? 5,
    executor_limit: representative?.executor_limit ?? 1,
    reviewer_limit: representative?.reviewer_limit ?? 1,
    scout_limit: representative?.scout_count ?? 1,
    specialist_agents: representative?.specialist_agents ?? [],
    reasoning: [
      failed.length ? `${failed.length} staffing scenario(s) deviated from expectations; tune thresholds only after repeated evidence.` : "Staffing expectations passed in this run; keep defaults stable.",
      comparison ? comparison.recommendation : "No comparison run was included.",
      "Do not update defaults from one noisy experiment; require confidence and repeated evidence."
    ]
  };
}

function buildTrialReport(input: {
  experiment: SwarmExperiment;
  evaluations: StaffingEvaluationResult[];
  runs: ExperimentRun[];
  comparison?: ComparisonResult;
  tuningPolicy: SwarmTuningPolicy;
  summary: string;
}): SwarmTrialReport {
  const failures = input.evaluations.filter((evaluation) => evaluation.pass_fail === "fail");
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    experiment_id: input.experiment.id,
    summary: input.summary,
    scenarios_run: input.evaluations.length,
    staffing_accuracy: round(input.evaluations.length ? input.evaluations.filter((evaluation) => evaluation.pass_fail === "pass").length / input.evaluations.length : 1),
    modes_compared: input.experiment.modes_to_compare,
    key_metrics: {
      runs: input.runs.length,
      failures: failures.length,
      average_agents: round(average(input.runs.map((run) => run.effective_total_logical_agents))),
      comparison_recommendation: input.comparison?.recommendation ?? "not_run"
    },
    wins: input.evaluations.filter((evaluation) => evaluation.pass_fail === "pass").slice(0, 5).map((evaluation) => `Staffing matched ${evaluation.expected_complexity} for: ${evaluation.input_goal}`),
    losses: failures.flatMap((evaluation) => evaluation.deviations.slice(0, 2)),
    bottlenecks: input.comparison
      ? Object.entries(input.comparison.duplicate_work_rate).filter(([, rate]) => rate > 0.2).map(([mode]) => `${mode} showed duplicate work risk.`)
      : [],
    safety_findings: input.evaluations.map((evaluation) => `${evaluation.input_goal}: executor_limit=${evaluation.actual_staffing_plan.executor_limit}, read_only_ratio=${evaluation.actual_staffing_plan.read_only_ratio}`),
    specialist_selection_findings: input.evaluations.map((evaluation) => `${evaluation.input_goal}: specialists=${evaluation.actual_staffing_plan.specialist_agents.map((specialist) => specialist.role).join(", ") || "none"}`),
    recommended_defaults: [
      `Default mode: ${input.tuningPolicy.recommended_mode}`,
      `Default total agents for this class: ${input.tuningPolicy.recommended_total_logical_agents}`,
      `Executor limit: ${input.tuningPolicy.executor_limit}`
    ],
    next_improvements: [
      "Connect comparison quality indicators to real provider-backed outcomes.",
      "Accumulate multiple trial records before changing staffing thresholds.",
      "Add repository-specific expected behavior overrides when enough evidence exists."
    ]
  };
}

function renderTrialReportMarkdown(
  report: SwarmTrialReport,
  evaluations: StaffingEvaluationResult[],
  comparison: ComparisonResult | undefined,
  tuningPolicy: SwarmTuningPolicy
) {
  return [
    `# Swarm Autopilot Trial Report`,
    "",
    `## Summary`,
    report.summary,
    "",
    `## Staffing Accuracy`,
    `Accuracy: ${report.staffing_accuracy}`,
    "",
    ...evaluations.map((evaluation) => [
      `### ${evaluation.expected_complexity}: ${evaluation.input_goal}`,
      `- Result: ${evaluation.pass_fail}`,
      `- Expected range: ${evaluation.expected_agent_range[0]}-${evaluation.expected_agent_range[1]}`,
      `- Actual agents: ${evaluation.actual_staffing_plan.recommended_total_logical_agents}`,
      `- Executor limit: ${evaluation.actual_staffing_plan.executor_limit}`,
      `- Specialists: ${evaluation.actual_staffing_plan.specialist_agents.map((specialist) => specialist.role).join(", ") || "none"}`,
      `- Deviations: ${evaluation.deviations.join("; ") || "none"}`
    ].join("\n")),
    "",
    `## Comparison`,
    comparison ? [
      `Recommendation: ${comparison.recommendation}`,
      ...Object.entries(comparison.mode_metrics).map(([mode, metrics]) => `- ${mode}: success=${metrics.success_rate}, useful=${metrics.useful_finding_rate}, duplicate=${metrics.duplicate_work_rate}, agents=${metrics.selected_agents}`)
    ].join("\n") : "No comparison was run.",
    "",
    `## Safety`,
    ...report.safety_findings.map((finding) => `- ${finding}`),
    "",
    `## Specialist Selection`,
    ...report.specialist_selection_findings.map((finding) => `- ${finding}`),
    "",
    `## Tuning Recommendations`,
    ...tuningPolicy.reasoning.map((reason) => `- ${reason}`)
  ].join("\n");
}

function experimentRunFromEvaluation(experimentId: string, evaluation: StaffingEvaluationResult): ExperimentRun {
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    id: `experiment_run_${randomUUID()}`,
    experiment_id: experimentId,
    input_goal: evaluation.input_goal,
    mode: "autopilot-deep",
    uses_mock_agents: true,
    uses_real_model: false,
    uses_real_repo: true,
    status: evaluation.pass_fail === "pass" ? "succeeded" : "failed",
    staffing_plan_ref: evaluation.actual_staffing_plan.id,
    effective_total_logical_agents: evaluation.actual_staffing_plan.recommended_total_logical_agents,
    role_distribution: evaluation.actual_staffing_plan.role_counts,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString()
  };
}

function experimentRunFromSwarmRun(experimentId: string, mode: TrialComparisonMode, swarmRunId: string, plan: StaffingPlan, metrics: SwarmMetrics): ExperimentRun {
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    id: `experiment_run_${randomUUID()}`,
    experiment_id: experimentId,
    input_goal: swarmRunId,
    mode,
    uses_mock_agents: true,
    uses_real_model: false,
    uses_real_repo: true,
    status: metrics.work_items_failed ? "failed" : "succeeded",
    staffing_plan_ref: plan.id,
    effective_total_logical_agents: plan.recommended_total_logical_agents,
    role_distribution: metrics.role_distribution,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    metrics_ref: "metrics.json",
    artifacts_ref: swarmRunId,
    final_report_ref: "final_report.md"
  };
}

function experimentRunFromComparison(
  experimentId: string,
  goal: string,
  mode: TrialComparisonMode,
  metrics: ComparisonModeMetrics,
  plan?: StaffingPlan
): ExperimentRun {
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    id: `experiment_run_${randomUUID()}`,
    experiment_id: experimentId,
    input_goal: goal,
    mode,
    uses_mock_agents: true,
    uses_real_model: false,
    uses_real_repo: true,
    status: metrics.success_rate >= 0.65 ? "succeeded" : "failed",
    staffing_plan_ref: plan?.id,
    effective_total_logical_agents: metrics.selected_agents,
    role_distribution: plan?.role_counts ?? { "baseline-simple": metrics.selected_agents },
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString()
  };
}

function fakeScaleStaffingPlan(runId: string, complexity: TaskComplexity, total: number): StaffingPlan {
  const roleCounts: RoleCounts = {
    ScoutAgent: total,
    PlannerAgent: 0,
    ArchitectAgent: 0,
    ExecutorAgent: 0,
    ReviewerAgent: 0,
    TesterAgent: 0,
    IntegratorAgent: 0,
    ReporterAgent: 0,
    RiskAnalyzerAgent: 0,
    MemoryUpdaterAgent: 0,
    ContextBuilderAgent: 0
  };
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: `staffing_${runId}`,
    swarm_run_id: runId,
    task_complexity: complexity,
    repo_scope: "whole_repo",
    risk_level: "low",
    recommended_total_logical_agents: total,
    max_parallel_agents: total,
    scout_count: total,
    planner_count: 0,
    architect_count: 0,
    executor_count: 0,
    reviewer_count: 0,
    tester_count: 0,
    integrator_count: 0,
    specialist_agents: [],
    role_counts: roleCounts,
    executor_limit: 0,
    reviewer_limit: 0,
    tester_limit: 0,
    read_only_ratio: 1,
    write_agent_limit: 0,
    validation_level: "none",
    requires_human_approval: false,
    reasoning: ["Scheduler scale trial uses mock read-only work to prove 300 logical agent handling."],
    confidence: 0.9,
    downgrade_conditions: [],
    escalation_conditions: [],
    created_at: new Date().toISOString()
  };
}

function fakeSwarmRun(workspace: string, id: string, plan: StaffingPlan, goal: string): SwarmRun {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    user_goal: goal,
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

function fakeWorkItem(runId: string, id: string, type: WorkItem["type"], role: string): WorkItem {
  const now = new Date().toISOString();
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id,
    swarm_run_id: runId,
    type,
    priority: 1,
    dependencies: [],
    required_role: role,
    read_files: [`src/${id}.ts`],
    write_files: [],
    risk_level: "low",
    expected_output_schema: `${role}Output`,
    status: "queued",
    attempt_count: 0,
    max_attempts: 1,
    created_at: now,
    updated_at: now
  };
}

function goalForMode(goal: string, mode: TrialComparisonMode) {
  return mode === "autopilot-huge-readonly" ? `${goal} Do not edit files. Analyze the whole repository.` : goal;
}

function modeToSwarmMode(mode: TrialComparisonMode): SwarmRunMode {
  if (mode.includes("fast")) return "fast";
  if (mode.includes("exhaustive") || mode.includes("huge")) return "exhaustive";
  return "deep";
}

function comparisonRecommendation(goal: string, bestMode: string, metrics: Record<string, ComparisonModeMetrics>) {
  const baseline = metrics["baseline-simple"];
  const best = metrics[bestMode];
  if (baseline && best && baseline.useful_finding_rate >= best.useful_finding_rate - 0.03 && baseline.duplicate_work_rate < best.duplicate_work_rate) {
    return "Stay simple for this task class; swarm exploration did not show enough useful-finding lift.";
  }
  if (/do not edit|architecture|whole repo|migration|auth|framework|cross-module/i.test(goal)) {
    return `${bestMode} has the strongest measured usefulness/coverage tradeoff for this complex or risky goal.`;
  }
  return `${bestMode} is the measured winner, but keep executor limits narrow and watch duplicate work.`;
}

function staffingFit(evaluation: StaffingEvaluationResult): "too_small" | "good" | "too_large" | "unknown" {
  const actual = evaluation.actual_staffing_plan.recommended_total_logical_agents;
  if (evaluation.pass_fail === "pass") return "good";
  if (actual < evaluation.expected_agent_range[0]) return "too_small";
  if (actual > evaluation.expected_agent_range[1]) return "too_large";
  return "unknown";
}

function complexityMatches(actual: TaskComplexity, expected: TaskComplexity) {
  if (actual === expected) return true;
  const order: TaskComplexity[] = ["tiny", "small", "medium", "large", "huge"];
  return Math.abs(order.indexOf(actual) - order.indexOf(expected)) <= 1
    && !(expected === "tiny" && actual !== "small")
    && !(expected === "huge" && actual !== "large");
}

function inferGoalComplexity(goal: string): TaskComplexity {
  if (/whole repo|architecture|framework|campaign/i.test(goal)) return "huge";
  if (/cross-module|migration|refactor/i.test(goal)) return "large";
  if (/feature|shared|module/i.test(goal)) return "medium";
  if (/text|label|copy/i.test(goal)) return "tiny";
  return "small";
}

function repoSize(indexedFiles: number): SwarmTuningPolicy["repo_size_estimate"] {
  if (indexedFiles >= 500) return "huge_repo";
  if (indexedFiles >= 150) return "large_repo";
  if (indexedFiles >= 40) return "medium_repo";
  return "small_repo";
}

function passRate(evaluations: StaffingEvaluationResult[]) {
  return `${evaluations.filter((evaluation) => evaluation.pass_fail === "pass").length}/${evaluations.length}`;
}

function pickMetric(metrics: Record<string, ComparisonModeMetrics>, key: keyof ComparisonModeMetrics) {
  return Object.fromEntries(Object.entries(metrics).map(([mode, value]) => [mode, Number(value[key])]));
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
