import { randomUUID } from "node:crypto";
import type { CommandInventory, FailedAttemptRecord, RepoIndex } from "../memory/types.js";
import { SpecialistAgentFactory } from "./SpecialistAgentFactory.js";
import type {
  RepoScope,
  RoleCounts,
  StaffingPlan,
  SwarmRunMode,
  SwarmRiskLevel,
  SwarmValidationLevel,
  TaskComplexity
} from "./SwarmModels.js";
import { MAX_SUPPORTED_LOGICAL_AGENTS, SWARM_SCHEMA_VERSION } from "./SwarmModels.js";

export type SwarmStaffingPlannerInput = {
  swarmRunId: string;
  userGoal: string;
  mode?: SwarmRunMode;
  repoIndex: RepoIndex;
  commandInventory?: CommandInventory;
  relevantFiles?: string[];
  previousFailures?: FailedAttemptRecord[];
  explicitAgentLimit?: number;
};

export class SwarmStaffingPlanner {
  constructor(private readonly specialistFactory = new SpecialistAgentFactory()) {}

  createPlan(input: SwarmStaffingPlannerInput): StaffingPlan {
    const mode = input.mode ?? "auto";
    const relevantFiles = uniqueStrings(input.relevantFiles ?? inferRelevantFiles(input.userGoal, input.repoIndex));
    const taskComplexity = inferTaskComplexity(input.userGoal, input.repoIndex, relevantFiles, mode);
    const repoScope = inferRepoScope(input.userGoal, input.repoIndex, relevantFiles, taskComplexity);
    const riskLevel = inferRiskLevel(input.userGoal, relevantFiles, repoScope);
    const specialists = this.specialistFactory.create({
      userGoal: input.userGoal,
      taskComplexity,
      candidateFiles: relevantFiles,
      repoIndex: input.repoIndex,
      commandInventory: input.commandInventory,
      previousFailures: input.previousFailures?.map((attempt) => attempt.summary)
    });
    const isReadOnly = isReadOnlyGoal(input.userGoal);
    const hasValidation = Boolean(
      input.commandInventory?.byKind.test.length
      || input.commandInventory?.byKind.typecheck.length
      || input.commandInventory?.byKind.build.length
    );
    const roleCounts = baseRoleCounts(taskComplexity, repoScope, riskLevel, isReadOnly, hasValidation, input.repoIndex);
    for (const specialist of specialists) {
      roleCounts[specialist.role] = (roleCounts[specialist.role] ?? 0) + 1;
    }
    const executorCap = executorLimitFor(taskComplexity, riskLevel, isReadOnly);
    roleCounts.ExecutorAgent = Math.min(roleCounts.ExecutorAgent, executorCap);
    const specialistCount = specialists.length;
    let recommendedTotal = sumRoleCounts(roleCounts);
    if (input.explicitAgentLimit !== undefined) {
      const cappedOverride = clamp(Math.floor(input.explicitAgentLimit), 1, MAX_SUPPORTED_LOGICAL_AGENTS);
      recommendedTotal = Math.min(cappedOverride, MAX_SUPPORTED_LOGICAL_AGENTS);
      shrinkReadOnlyRolesToTotal(roleCounts, recommendedTotal, specialistCount);
    }
    if (sumRoleCounts(roleCounts) > MAX_SUPPORTED_LOGICAL_AGENTS) {
      shrinkReadOnlyRolesToTotal(roleCounts, MAX_SUPPORTED_LOGICAL_AGENTS, specialistCount);
    }
    recommendedTotal = Math.min(sumRoleCounts(roleCounts), MAX_SUPPORTED_LOGICAL_AGENTS);

    const writeAgentLimit = Math.min(roleCounts.ExecutorAgent + roleCounts.IntegratorAgent, executorCap + (roleCounts.IntegratorAgent ? 1 : 0));
    const readOnlyAgents = Math.max(0, recommendedTotal - writeAgentLimit);
    const maxParallelAgents = maxParallelFor(taskComplexity, riskLevel, isReadOnly, recommendedTotal);
    const validationLevel = validationLevelFor(taskComplexity, riskLevel, isReadOnly, hasValidation);
    const requiresHumanApproval = riskLevel === "critical"
      || (riskLevel === "high" && !isReadOnly)
      || relevantFiles.some(isSensitiveFile);
    const reasoning = buildReasoning({
      input,
      taskComplexity,
      repoScope,
      riskLevel,
      isReadOnly,
      relevantFiles,
      specialists: specialists.map((specialist) => `${specialist.role}: ${specialist.trigger}`),
      explicitAgentLimit: input.explicitAgentLimit,
      recommendedTotal
    });

    return {
      schema_version: SWARM_SCHEMA_VERSION,
      id: `staffing_${randomUUID()}`,
      swarm_run_id: input.swarmRunId,
      task_complexity: taskComplexity,
      repo_scope: repoScope,
      risk_level: riskLevel,
      recommended_total_logical_agents: recommendedTotal,
      max_parallel_agents: maxParallelAgents,
      scout_count: roleCounts.ScoutAgent,
      planner_count: roleCounts.PlannerAgent,
      architect_count: roleCounts.ArchitectAgent,
      executor_count: roleCounts.ExecutorAgent,
      reviewer_count: roleCounts.ReviewerAgent,
      tester_count: roleCounts.TesterAgent,
      integrator_count: roleCounts.IntegratorAgent,
      specialist_agents: specialists,
      role_counts: roleCounts,
      executor_limit: Math.min(roleCounts.ExecutorAgent, executorCap),
      reviewer_limit: roleCounts.ReviewerAgent + specialistCount,
      tester_limit: roleCounts.TesterAgent,
      read_only_ratio: recommendedTotal === 0 ? 1 : round(readOnlyAgents / recommendedTotal),
      write_agent_limit: writeAgentLimit,
      validation_level: validationLevel,
      requires_human_approval: requiresHumanApproval,
      reasoning,
      confidence: confidenceFor(taskComplexity, repoScope, riskLevel, relevantFiles),
      downgrade_conditions: [
        "Reduce executor fan-out after any validation failure or repeated patch fingerprint.",
        "Downgrade to fewer scouts when the repo index is fresh and relevant files are already narrow.",
        "Use a single executor when write scopes overlap or sensitive files are involved."
      ],
      escalation_conditions: [
        "Escalate scouts and reviewers when relevant modules remain unknown.",
        "Add specialists when security, database, API, dependency, performance, or UI evidence appears.",
        "Require human approval when high-risk files or critical safety gates are involved."
      ],
      created_at: new Date().toISOString()
    };
  }
}

function baseRoleCounts(
  taskComplexity: TaskComplexity,
  repoScope: RepoScope,
  riskLevel: SwarmRiskLevel,
  isReadOnly: boolean,
  hasValidation: boolean,
  repoIndex: RepoIndex
): RoleCounts {
  const counts = emptyRoleCounts();
  if (taskComplexity === "tiny") {
    counts.ScoutAgent = 1;
    counts.PlannerAgent = 0;
    counts.ExecutorAgent = isReadOnly ? 0 : 1;
    counts.ReviewerAgent = 1;
    counts.TesterAgent = hasValidation && !isReadOnly ? 1 : 0;
    counts.ReporterAgent = 1;
  } else if (taskComplexity === "small") {
    counts.ScoutAgent = repoScope === "single_file" ? 1 : 2;
    counts.PlannerAgent = 1;
    counts.ExecutorAgent = isReadOnly ? 0 : 1;
    counts.ReviewerAgent = riskLevel === "low" ? 1 : 2;
    counts.TesterAgent = hasValidation ? 1 : 0;
    counts.ReporterAgent = 1;
  } else if (taskComplexity === "medium") {
    counts.ScoutAgent = repoScope === "single_module" ? 4 : 6;
    counts.ContextBuilderAgent = 1;
    counts.PlannerAgent = 2;
    counts.ArchitectAgent = 1;
    counts.RiskAnalyzerAgent = riskLevel === "low" ? 0 : 1;
    counts.ExecutorAgent = isReadOnly ? 0 : riskLevel === "high" || riskLevel === "critical" ? 1 : 2;
    counts.ReviewerAgent = riskLevel === "low" ? 3 : 5;
    counts.TesterAgent = hasValidation ? 2 : 1;
    counts.IntegratorAgent = isReadOnly ? 0 : 1;
    counts.ReporterAgent = 1;
  } else if (taskComplexity === "large") {
    const scoutBase = Math.min(40, Math.max(10, Math.ceil(repoIndex.totals.indexedFiles / 12)));
    counts.ScoutAgent = scoutBase;
    counts.ContextBuilderAgent = 3;
    counts.PlannerAgent = 3;
    counts.ArchitectAgent = 3;
    counts.RiskAnalyzerAgent = riskLevel === "low" ? 1 : 3;
    counts.ExecutorAgent = isReadOnly ? 0 : riskLevel === "high" || riskLevel === "critical" ? 2 : 4;
    counts.ReviewerAgent = riskLevel === "low" ? 10 : 18;
    counts.TesterAgent = hasValidation ? 5 : 3;
    counts.IntegratorAgent = isReadOnly ? 1 : 2;
    counts.MemoryUpdaterAgent = 1;
    counts.ReporterAgent = 1;
  } else {
    const forceMax = isReadOnly && (repoIndex.totals.indexedFiles >= 500 || repoScope === "whole_repo");
    counts.ScoutAgent = forceMax ? 180 : Math.min(180, Math.max(50, Math.ceil(repoIndex.totals.indexedFiles / 6)));
    counts.ContextBuilderAgent = forceMax ? 15 : 8;
    counts.PlannerAgent = forceMax ? 10 : 6;
    counts.ArchitectAgent = forceMax ? 6 : 5;
    counts.RiskAnalyzerAgent = forceMax ? 5 : 4;
    counts.ExecutorAgent = isReadOnly ? 0 : riskLevel === "critical" ? 1 : 3;
    counts.ReviewerAgent = forceMax ? 74 : 35;
    counts.TesterAgent = hasValidation ? forceMax ? 7 : 6 : 3;
    counts.IntegratorAgent = 1;
    counts.MemoryUpdaterAgent = 1;
    counts.ReporterAgent = 1;
  }
  if (riskLevel === "critical") {
    counts.ExecutorAgent = Math.min(counts.ExecutorAgent, 1);
    counts.RiskAnalyzerAgent = Math.max(counts.RiskAnalyzerAgent, 2);
    counts.ReviewerAgent = Math.max(counts.ReviewerAgent, taskComplexity === "huge" ? 50 : taskComplexity === "large" ? 20 : 3);
  }
  return counts;
}

function emptyRoleCounts(): RoleCounts {
  return {
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
    ContextBuilderAgent: 0
  };
}

function inferTaskComplexity(goal: string, repoIndex: RepoIndex, relevantFiles: string[], mode: SwarmRunMode): TaskComplexity {
  const normalized = goal.toLowerCase();
  if (matches(normalized, [
    "huge",
    "entire repo",
    "whole repo",
    "whole repository",
    "framework upgrade",
    "major framework",
    "multi-stage campaign",
    "staged campaign",
    "deep audit",
    "all modules",
    "across the project"
  ])) return "huge";
  if (matches(normalized, ["large", "migration", "cross-cutting", "cross-module", "multi-module", "repository-wide"])) return "large";
  if (matches(normalized, ["feature", "refactor", "several files", "add tests", "touching several", "orchestration", "runtime", "shared ui", "shared component"])) return "medium";
  if (matches(normalized, ["copy text", "label text", "wording", "small html", "simple html", "typo", "one line", "rename label"])) return "tiny";
  if (mode === "exhaustive" && repoIndex.totals.indexedFiles > 250 && isReadOnlyGoal(goal)) return "large";
  if (relevantFiles.length <= 1 && matches(normalized, ["change", "fix", "update"])) return "tiny";
  if (repoIndex.totals.indexedFiles > 100 && matches(normalized, ["inspect", "map", "audit"])) return "medium";
  return "small";
}

function inferRepoScope(goal: string, repoIndex: RepoIndex, relevantFiles: string[], taskComplexity: TaskComplexity): RepoScope {
  const normalized = goal.toLowerCase();
  if (matches(normalized, ["whole repo", "whole repository", "entire repo", "repository-wide", "all modules", "framework upgrade", "major framework", "deep audit", "across the project"])) return "whole_repo";
  if (taskComplexity === "large" || taskComplexity === "huge") return taskComplexity === "huge" ? "whole_repo" : "multiple_modules";
  const modules = new Set(relevantFiles.map((file) => file.split(/[\\/]/)[0]).filter(Boolean));
  if (relevantFiles.length <= 1) return "single_file";
  if (relevantFiles.length <= 4 && modules.size <= 2) return "few_files";
  if (modules.size <= 1) return "single_module";
  if (repoIndex.topLevelDirectories.length > 4 && modules.size > 2) return "multiple_modules";
  return "few_files";
}

function inferRiskLevel(goal: string, files: string[], repoScope: RepoScope): SwarmRiskLevel {
  const normalized = `${goal}\n${files.join("\n")}`.toLowerCase();
  if (matches(normalized, ["delete data", "credentials", "secret", ".env", "auth", "security", "payment", "permission", "production"])) return "critical";
  if (matches(normalized, ["migration", "database", "dependency", "package-lock", "package.json", "cargo.lock", "tsconfig", "tauri.conf", "breaking change"])) return "high";
  if (repoScope === "multiple_modules" || repoScope === "whole_repo" || matches(normalized, ["refactor", "runtime", "scheduler", "orchestrator"])) return "medium";
  return "low";
}

function validationLevelFor(
  complexity: TaskComplexity,
  riskLevel: SwarmRiskLevel,
  isReadOnly: boolean,
  hasValidation: boolean
): SwarmValidationLevel {
  if (isReadOnly && !hasValidation) return "none";
  if (complexity === "tiny") return hasValidation ? "basic" : "none";
  if (riskLevel === "critical" || complexity === "huge") return "exhaustive";
  if (riskLevel === "high" || complexity === "large") return "strict";
  if (complexity === "medium") return "normal";
  return hasValidation ? "basic" : "none";
}

function executorLimitFor(complexity: TaskComplexity, riskLevel: SwarmRiskLevel, isReadOnly: boolean) {
  if (isReadOnly) return 0;
  if (riskLevel === "critical") return 1;
  if (riskLevel === "high") return complexity === "large" || complexity === "huge" ? 2 : 1;
  if (complexity === "tiny" || complexity === "small") return 1;
  if (complexity === "medium") return 3;
  if (complexity === "large") return 6;
  return 6;
}

function maxParallelFor(complexity: TaskComplexity, riskLevel: SwarmRiskLevel, isReadOnly: boolean, total: number) {
  const base = complexity === "huge" ? 120
    : complexity === "large" ? 48
      : complexity === "medium" ? 16
        : complexity === "small" ? 8
          : 4;
  const riskAdjusted = riskLevel === "critical" ? Math.min(base, 24)
    : riskLevel === "high" ? Math.min(base, 32)
      : base;
  return Math.max(1, Math.min(total, isReadOnly ? riskAdjusted : Math.max(3, Math.floor(riskAdjusted * 0.75))));
}

function confidenceFor(complexity: TaskComplexity, repoScope: RepoScope, riskLevel: SwarmRiskLevel, relevantFiles: string[]) {
  let confidence = 0.78;
  if (relevantFiles.length > 0) confidence += 0.08;
  if (complexity === "tiny" || complexity === "small") confidence += 0.05;
  if (repoScope === "whole_repo") confidence -= 0.08;
  if (riskLevel === "high" || riskLevel === "critical") confidence -= 0.06;
  return round(clamp(confidence, 0.35, 0.95));
}

function buildReasoning(input: {
  input: SwarmStaffingPlannerInput;
  taskComplexity: TaskComplexity;
  repoScope: RepoScope;
  riskLevel: SwarmRiskLevel;
  isReadOnly: boolean;
  relevantFiles: string[];
  specialists: string[];
  explicitAgentLimit?: number;
  recommendedTotal: number;
}) {
  return [
    `Classified task as ${input.taskComplexity} with ${input.repoScope} scope and ${input.riskLevel} risk.`,
    input.isReadOnly
      ? "Goal appears read-only, so staffing favors scouts, reviewers, testers, and reporters over executors."
      : "Goal may require edits, so executor fan-out is capped separately from total logical agents.",
    `Repository index reports ${input.input.repoIndex.totals.indexedFiles} indexed file(s); ${input.relevantFiles.length} candidate relevant file(s) were selected.`,
    input.specialists.length
      ? `Created dynamic specialists only for matched evidence: ${input.specialists.join("; ")}.`
      : "No dynamic specialists were created because no specialist trigger was justified.",
    input.explicitAgentLimit !== undefined
      ? `Advanced agent-limit override was capped and safety limits still apply; effective recommendation is ${input.recommendedTotal}.`
      : `The system selected ${input.recommendedTotal} logical agents automatically; the user did not need to provide an agent count.`
  ];
}

function inferRelevantFiles(goal: string, repoIndex: RepoIndex) {
  const normalized = goal.toLowerCase();
  const direct = [
    ...repoIndex.sourceFiles,
    ...repoIndex.testFiles,
    ...repoIndex.configFiles,
    ...repoIndex.docFiles
  ].filter((file) => normalized.includes(file.toLowerCase()) || normalized.includes(basenameWithoutExtension(file).toLowerCase()));
  if (isSimpleTextGoal(normalized)) {
    return direct.slice(0, 3);
  }
  return uniqueStrings([
    ...direct,
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles
  ]).slice(0, 24);
}

function isSimpleTextGoal(normalizedGoal: string) {
  return /\b(change|update|replace|rename)\b/.test(normalizedGoal)
    && /\b(copy|text|label|wording|headline)\b/.test(normalizedGoal)
    && !/\b(accessibility|a11y|aria|keyboard|form|focus|semantic|layout|migration|security|api|protocol|dependency)\b/.test(normalizedGoal);
}

function isReadOnlyGoal(goal: string) {
  const normalized = goal.toLowerCase();
  if (/\b(do not|don't|without)\s+(edit|change|write|modify)\b/.test(normalized)) {
    return !matches(normalized, ["implement", "fix", "migrate", "refactor"]);
  }
  if (matches(normalized, ["do not change", "read-only", "readonly", "inspect", "explain", "audit", "review", "map", "analyze", "report"])) {
    return !matches(normalized, ["implement", "fix", "change", "update", "edit", "write", "migrate", "refactor"]);
  }
  return false;
}

function isSensitiveFile(file: string) {
  return /(^|\/)(\.env|package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig[^/]*\.json|tauri\.conf\.json|vite\.config\.[tj]s|.*migration.*|.*schema.*)$/i.test(file);
}

function matches(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function basenameWithoutExtension(file: string) {
  const normalized = file.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

function sumRoleCounts(roleCounts: RoleCounts) {
  return Object.values(roleCounts).reduce((sum, value) => sum + value, 0);
}

function shrinkReadOnlyRolesToTotal(roleCounts: RoleCounts, targetTotal: number, specialistCount: number) {
  const protectedWrite = roleCounts.ExecutorAgent + roleCounts.IntegratorAgent + specialistCount;
  const floorTotal = Math.max(1, protectedWrite + roleCounts.ReporterAgent);
  const target = Math.max(floorTotal, targetTotal);
  const shrinkOrder = ["ScoutAgent", "ReviewerAgent", "ContextBuilderAgent", "PlannerAgent", "ArchitectAgent", "TesterAgent", "RiskAnalyzerAgent"];
  while (sumRoleCounts(roleCounts) > target) {
    const role = shrinkOrder.find((candidate) => roleCounts[candidate] > minimumFor(candidate));
    if (!role) break;
    roleCounts[role] -= 1;
  }
}

function minimumFor(role: string) {
  if (role === "ScoutAgent" || role === "ReviewerAgent" || role === "ReporterAgent") return 1;
  return 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
