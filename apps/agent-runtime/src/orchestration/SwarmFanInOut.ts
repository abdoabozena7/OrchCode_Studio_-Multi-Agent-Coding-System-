import { randomUUID } from "node:crypto";
import type { RepoIndex } from "../memory/types.js";
import type {
  ConsensusGroup,
  ScoutAggregate,
  SwarmScoutResult,
  StaffingPlan,
  SwarmRiskLevel,
  WorkItem,
  WorkItemType
} from "./SwarmModels.js";
import { SWARM_SCHEMA_VERSION } from "./SwarmModels.js";

export function createInitialSwarmWorkItems(input: {
  swarmRunId: string;
  userGoal: string;
  staffingPlan: StaffingPlan;
  repoIndex: RepoIndex;
  validationCommands: string[];
}): WorkItem[] {
  const now = new Date().toISOString();
  const workItems: WorkItem[] = [];
  const scoutClusters = createScoutClusters(input.repoIndex, input.staffingPlan.scout_count);
  for (let index = 0; index < scoutClusters.length; index += 1) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_scout_${index + 1}_${shortId()}`,
      type: "scout",
      priority: 10,
      dependencies: [],
      requiredRole: "ScoutAgent",
      readFiles: scoutClusters[index],
      writeFiles: [],
      riskLevel: "low",
      expectedOutputSchema: "ScoutResult",
      maxAttempts: 2,
      now
    }));
  }

  const scoutIds = workItems.filter((item) => item.type === "scout").map((item) => item.id);
  const risk = createWorkItem({
    swarmRunId: input.swarmRunId,
    id: `swarm_risk_${shortId()}`,
    type: "risk_analysis",
    priority: 20,
    dependencies: scoutIds,
    requiredRole: "RiskAnalyzerAgent",
    readFiles: highSignalFiles(input.repoIndex),
    writeFiles: [],
    riskLevel: input.staffingPlan.risk_level,
    expectedOutputSchema: "RiskAnalysisOutput",
    maxAttempts: 2,
    now
  });
  if (input.staffingPlan.role_counts.RiskAnalyzerAgent > 0) workItems.push(risk);

  const plannerIds: string[] = [];
  for (let index = 0; index < input.staffingPlan.planner_count; index += 1) {
    const planner = createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_plan_${index + 1}_${shortId()}`,
      type: "plan",
      priority: 30,
      dependencies: input.staffingPlan.role_counts.RiskAnalyzerAgent > 0 ? [...scoutIds, risk.id] : scoutIds,
      requiredRole: "PlannerAgent",
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles: [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "PlannerOutput",
      maxAttempts: 2,
      now
    });
    plannerIds.push(planner.id);
    workItems.push(planner);
  }

  const architectIds: string[] = [];
  for (let index = 0; index < input.staffingPlan.architect_count; index += 1) {
    const architect = createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_architect_${index + 1}_${shortId()}`,
      type: "plan",
      priority: 35,
      dependencies: plannerIds.length ? plannerIds : scoutIds,
      requiredRole: "ArchitectAgent",
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles: [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "ArchitectOutput",
      maxAttempts: 2,
      now
    });
    architectIds.push(architect.id);
    workItems.push(architect);
  }

  const planningDeps = [...plannerIds, ...architectIds];
  const executorIds: string[] = [];
  for (let index = 0; index < input.staffingPlan.executor_count; index += 1) {
    const writeFiles = chooseExecutorWriteFiles(input.repoIndex, input.staffingPlan.risk_level, index);
    const executor = createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_execute_${index + 1}_${shortId()}`,
      type: "execute",
      priority: 50,
      dependencies: planningDeps.length ? planningDeps : scoutIds,
      requiredRole: "ExecutorAgent",
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles,
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "ExecutorOutput",
      maxAttempts: 2,
      now
    });
    executorIds.push(executor.id);
    workItems.push(executor);
  }

  const reviewDeps = executorIds.length ? executorIds : planningDeps.length ? planningDeps : scoutIds;
  for (let index = 0; index < input.staffingPlan.reviewer_count; index += 1) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_review_${index + 1}_${shortId()}`,
      type: "review",
      priority: 70,
      dependencies: reviewDeps,
      requiredRole: "ReviewerAgent",
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles: [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "ReviewerOutput",
      maxAttempts: 2,
      now
    }));
  }

  for (const specialist of input.staffingPlan.specialist_agents) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_specialist_${specialist.id}_${shortId()}`,
      type: "review",
      priority: 75,
      dependencies: reviewDeps,
      requiredRole: specialist.role,
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles: [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: specialist.output_schema,
      maxAttempts: 2,
      now
    }));
  }

  const reviewIds = workItems.filter((item) => item.type === "review").map((item) => item.id);
  for (let index = 0; index < input.staffingPlan.tester_count; index += 1) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_test_${index + 1}_${shortId()}`,
      type: "test",
      priority: 80,
      dependencies: reviewIds.length ? reviewIds : reviewDeps,
      requiredRole: "TesterAgent",
      readFiles: input.validationCommands,
      writeFiles: [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "TesterOutput",
      maxAttempts: 1,
      now
    }));
  }

  const validationIds = workItems.filter((item) => item.type === "test").map((item) => item.id);
  for (let index = 0; index < input.staffingPlan.integrator_count; index += 1) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_integrate_${index + 1}_${shortId()}`,
      type: "integrate",
      priority: 90,
      dependencies: validationIds.length ? validationIds : reviewDeps,
      requiredRole: "IntegratorAgent",
      readFiles: highSignalFiles(input.repoIndex),
      writeFiles: input.staffingPlan.executor_count > 0 ? [] : [],
      riskLevel: input.staffingPlan.risk_level,
      expectedOutputSchema: "IntegratorOutput",
      maxAttempts: 1,
      now
    }));
  }

  const finalDeps = terminalDeps(workItems);
  if (input.staffingPlan.role_counts.MemoryUpdaterAgent > 0) {
    workItems.push(createWorkItem({
      swarmRunId: input.swarmRunId,
      id: `swarm_memory_${shortId()}`,
      type: "memory_update",
      priority: 95,
      dependencies: finalDeps,
      requiredRole: "MemoryUpdaterAgent",
      readFiles: [],
      writeFiles: [],
      riskLevel: "low",
      expectedOutputSchema: "MemoryUpdateOutput",
      maxAttempts: 1,
      now
    }));
  }
  workItems.push(createWorkItem({
    swarmRunId: input.swarmRunId,
    id: `swarm_report_${shortId()}`,
    type: "summarize",
    priority: 100,
    dependencies: finalDeps,
    requiredRole: "ReporterAgent",
    readFiles: [],
    writeFiles: [],
    riskLevel: "low",
    expectedOutputSchema: "FinalSwarmReport",
    maxAttempts: 1,
    now
  }));

  return workItems.slice(0, Math.max(input.staffingPlan.recommended_total_logical_agents, workItems.length));
}

export function aggregateScoutResults(results: SwarmScoutResult[]): ScoutAggregate {
  const confidence = results.length
    ? Math.round((results.reduce((sum, result) => sum + result.confidence, 0) / results.length) * 100) / 100
    : 0;
  return {
    relevant_files: uniqueStrings(results.flatMap((result) => result.relevant_files)),
    relevant_symbols: uniqueStrings(results.flatMap((result) => result.relevant_symbols)),
    risks: uniqueStrings(results.flatMap((result) => result.risks)),
    test_recommendations: uniqueStrings(results.flatMap((result) => result.test_recommendations)),
    unknowns: uniqueStrings(results.flatMap((result) => result.unknowns)),
    confidence
  };
}

export function createConsensusGroup(input: {
  swarmRunId: string;
  topic: string;
  participantWorkItems: string[];
  findings: Array<{ finding: string; confidence: number; dissent?: boolean }>;
  quorumPolicy?: ConsensusGroup["quorum_policy"];
}): ConsensusGroup {
  const consolidated = input.findings.filter((finding) => !finding.dissent);
  const dissent = input.findings.filter((finding) => finding.dissent);
  const confidence = input.findings.length
    ? Math.round((consolidated.reduce((sum, finding) => sum + finding.confidence, 0) / input.findings.length) * 100) / 100
    : 0;
  const decision = input.findings.length === 0
    ? "blocked_no_review"
    : consolidated.length === 0
      ? "blocked_with_dissent"
      : dissent.length
        ? "accepted_with_dissent"
        : "accepted";
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: `consensus_${randomUUID()}`,
    swarm_run_id: input.swarmRunId,
    topic: input.topic,
    participant_work_items: uniqueStrings(input.participantWorkItems),
    quorum_policy: input.quorumPolicy ?? "reviewer_quorum",
    decision,
    consolidated_findings: uniqueStrings(consolidated.map((finding) => finding.finding)),
    dissenting_findings: uniqueStrings(dissent.map((finding) => finding.finding)),
    confidence,
    created_at: new Date().toISOString()
  };
}

function createScoutClusters(repoIndex: RepoIndex, count: number) {
  const files = uniqueStrings([
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.sourceFiles,
    ...repoIndex.testFiles,
    ...repoIndex.configFiles,
    ...repoIndex.docFiles
  ]);
  const clusterCount = Math.max(1, count);
  const clusters = Array.from({ length: clusterCount }, () => [] as string[]);
  for (let index = 0; index < files.length; index += 1) {
    clusters[index % clusterCount].push(files[index]);
  }
  return clusters.map((cluster) => cluster.slice(0, 12));
}

function createWorkItem(input: {
  swarmRunId: string;
  id: string;
  type: WorkItemType;
  priority: number;
  dependencies: string[];
  requiredRole: string;
  readFiles: string[];
  writeFiles: string[];
  riskLevel: SwarmRiskLevel;
  expectedOutputSchema: string;
  maxAttempts: number;
  now: string;
}): WorkItem {
  return {
    schema_version: SWARM_SCHEMA_VERSION,
    id: input.id,
    swarm_run_id: input.swarmRunId,
    type: input.type,
    priority: input.priority,
    dependencies: uniqueStrings(input.dependencies),
    required_role: input.requiredRole,
    read_files: uniqueStrings(input.readFiles),
    write_files: uniqueStrings(input.writeFiles),
    risk_level: input.riskLevel,
    expected_output_schema: input.expectedOutputSchema,
    status: "queued",
    attempt_count: 0,
    max_attempts: input.maxAttempts,
    created_at: input.now,
    updated_at: input.now
  };
}

function chooseExecutorWriteFiles(repoIndex: RepoIndex, riskLevel: SwarmRiskLevel, index: number) {
  const editable = uniqueStrings([
    ...repoIndex.sourceFiles,
    ...repoIndex.docFiles,
    ...repoIndex.configFiles.filter((file) => riskLevel === "low" && !isSensitiveFile(file))
  ]).filter((file) => !isSensitiveFile(file));
  if (!editable.length) return [];
  return [editable[index % editable.length]];
}

function highSignalFiles(repoIndex: RepoIndex) {
  return uniqueStrings([
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.sourceFiles.slice(0, 12),
    ...repoIndex.testFiles.slice(0, 8)
  ]).slice(0, 24);
}

function terminalDeps(workItems: WorkItem[]) {
  const dependedOn = new Set(workItems.flatMap((item) => item.dependencies));
  return workItems.filter((item) => !dependedOn.has(item.id)).map((item) => item.id);
}

function isSensitiveFile(file: string) {
  return /(^|\/)(\.env|package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig[^/]*\.json|tauri\.conf\.json)$/i.test(file);
}

function shortId() {
  return randomUUID().slice(0, 8);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
