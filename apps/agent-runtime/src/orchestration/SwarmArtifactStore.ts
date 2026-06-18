import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { RunTransitionRecord } from "./RunStateMachine.js";
import type {
  AgentInstance,
  AgentTemplate,
  ConsensusGroup,
  SchedulerTraceEntry,
  StaffingPlan,
  SwarmEvent,
  SwarmMetrics,
  SwarmRun,
  WorkItem,
  WorkItemResult
} from "./SwarmModels.js";

export type SwarmArtifactPaths = {
  runDir: string;
  swarmRun: string;
  staffingPlan: string;
  schedulerConfig: string;
  agentTemplates: string;
  agentInstances: string;
  workItems: string;
  leases: string;
  events: string;
  schedulerTrace: string;
  metrics: string;
  finalReport: string;
  providerWorkersDir: string;
  scoutResultsDir: string;
  plannerResultsDir: string;
  executorResultsDir: string;
  reviewerResultsDir: string;
  testerResultsDir: string;
  specialistResultsDir: string;
  consensusDir: string;
};

export class SwarmArtifactStore {
  private readonly metadata: FactoryMetadataAdapter;
  private readonly traceWriter: FactoryTraceWriter;

  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {
    this.metadata = new FactoryMetadataAdapter(workspacePath, memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath, memoryDir, sourceComponent: "SwarmArtifactStore" });
  }

  async pathsForRun(runId: string): Promise<SwarmArtifactPaths> {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const runDir = path.join(memory.rootDir, "swarm_runs", runId);
    return {
      runDir,
      swarmRun: path.join(runDir, "swarm_run.json"),
      staffingPlan: path.join(runDir, "staffing_plan.json"),
      schedulerConfig: path.join(runDir, "scheduler_config.json"),
      agentTemplates: path.join(runDir, "agent_templates.json"),
      agentInstances: path.join(runDir, "agent_instances.json"),
      workItems: path.join(runDir, "work_items.json"),
      leases: path.join(runDir, "leases.json"),
      events: path.join(runDir, "events.jsonl"),
      schedulerTrace: path.join(runDir, "scheduler_trace.jsonl"),
      metrics: path.join(runDir, "metrics.json"),
      finalReport: path.join(runDir, "final_report.md"),
      providerWorkersDir: path.join(runDir, "provider_workers"),
      scoutResultsDir: path.join(runDir, "scout_results"),
      plannerResultsDir: path.join(runDir, "planner_results"),
      executorResultsDir: path.join(runDir, "executor_results"),
      reviewerResultsDir: path.join(runDir, "reviewer_results"),
      testerResultsDir: path.join(runDir, "tester_results"),
      specialistResultsDir: path.join(runDir, "specialist_results"),
      consensusDir: path.join(runDir, "consensus")
    };
  }

  async ensureRunLayout(runId: string) {
    const paths = await this.pathsForRun(runId);
    await mkdir(paths.providerWorkersDir, { recursive: true });
    await mkdir(paths.scoutResultsDir, { recursive: true });
    await mkdir(paths.plannerResultsDir, { recursive: true });
    await mkdir(paths.executorResultsDir, { recursive: true });
    await mkdir(paths.reviewerResultsDir, { recursive: true });
    await mkdir(paths.testerResultsDir, { recursive: true });
    await mkdir(paths.specialistResultsDir, { recursive: true });
    await mkdir(paths.consensusDir, { recursive: true });
    return paths;
  }

  async saveSwarmRun(run: SwarmRun) {
    const paths = await this.ensureRunLayout(run.id);
    await this.saveStructuredState("swarm_run", run.id, run, run.status, paths.swarmRun);
    await writeJson(paths.swarmRun, run);
    await writeJson(paths.schedulerConfig, run.scheduler_config);
    await this.metadata.recordSwarmRunSaved(run, paths.swarmRun);
    await this.metadata.recordSwarmConfigArtifactSaved({ runId: run.id, kind: "swarm_scheduler_config", artifactRef: paths.schedulerConfig });
    return paths.swarmRun;
  }

  async loadSwarmRun(runId: string): Promise<SwarmRun> {
    return this.requireStructuredState<SwarmRun>("swarm_run", runId);
  }

  async saveStaffingPlan(plan: StaffingPlan) {
    const paths = await this.ensureRunLayout(plan.swarm_run_id);
    await this.saveStructuredState("swarm_staffing_plan", plan.swarm_run_id, plan, undefined, paths.staffingPlan, plan.swarm_run_id);
    await writeJson(paths.staffingPlan, plan);
    await this.metadata.recordSwarmStaffingPlanSaved(plan, paths.staffingPlan);
    await this.traceWriter.write({
      run_id: plan.swarm_run_id,
      event_type: "policy_decision_recorded",
      lifecycle_stage: "staffing_plan",
      summary: "Swarm staffing plan artifact written.",
      artifact_refs: [paths.staffingPlan],
      metadata_json: {
        recommended_total_logical_agents: plan.recommended_total_logical_agents,
        executor_limit: plan.executor_limit,
        validation_level: plan.validation_level,
        risk_level: plan.risk_level
      }
    });
    return paths.staffingPlan;
  }

  async loadStaffingPlan(runId: string): Promise<StaffingPlan> {
    return this.requireStructuredState<StaffingPlan>("swarm_staffing_plan", runId);
  }

  async saveAgentTemplates(runId: string, templates: AgentTemplate[]) {
    const paths = await this.ensureRunLayout(runId);
    await this.saveStructuredState("swarm_agent_templates", runId, templates, undefined, paths.agentTemplates, runId);
    await writeJson(paths.agentTemplates, templates);
    await this.metadata.recordSwarmAgentTemplatesSaved(runId, templates, paths.agentTemplates);
    return paths.agentTemplates;
  }

  async loadAgentTemplates(runId: string): Promise<AgentTemplate[]> {
    return this.requireStructuredState<AgentTemplate[]>("swarm_agent_templates", runId);
  }

  async saveAgentInstances(runId: string, instances: AgentInstance[]) {
    const paths = await this.ensureRunLayout(runId);
    await this.saveStructuredState("swarm_agent_instances", runId, instances, undefined, paths.agentInstances, runId);
    await writeJson(paths.agentInstances, instances);
    await this.metadata.recordSwarmAgentInstancesSaved(runId, instances, paths.agentInstances);
    return paths.agentInstances;
  }

  async loadAgentInstances(runId: string): Promise<AgentInstance[]> {
    return this.requireStructuredState<AgentInstance[]>("swarm_agent_instances", runId);
  }

  async saveWorkItems(runId: string, workItems: WorkItem[]) {
    const paths = await this.ensureRunLayout(runId);
    await this.saveStructuredState("swarm_work_items", runId, workItems, undefined, paths.workItems, runId);
    await writeJson(paths.workItems, workItems);
    await this.metadata.recordWorkItemsSaved(runId, workItems, paths.workItems);
    return paths.workItems;
  }

  async loadWorkItems(runId: string): Promise<WorkItem[]> {
    return this.requireStructuredState<WorkItem[]>("swarm_work_items", runId);
  }

  async saveLeases(runId: string, leases: unknown[]) {
    const paths = await this.ensureRunLayout(runId);
    await this.saveStructuredState("swarm_leases", runId, leases, undefined, paths.leases, runId);
    await writeJson(paths.leases, leases);
    await this.metadata.recordSwarmConfigArtifactSaved({ runId, kind: "swarm_leases", artifactRef: paths.leases, count: leases.length });
    return paths.leases;
  }

  async appendEvent(event: SwarmEvent) {
    const paths = await this.ensureRunLayout(event.swarm_run_id);
    await this.traceWriter.recordArtifactEvent(event, paths.events);
    await appendJsonl(paths.events, event);
    return paths.events;
  }

  async appendSchedulerTrace(entry: SchedulerTraceEntry) {
    const paths = await this.ensureRunLayout(entry.swarm_run_id);
    await this.traceWriter.recordSchedulerTrace(entry, paths.schedulerTrace);
    await appendJsonl(paths.schedulerTrace, entry);
    return paths.schedulerTrace;
  }

  async saveWorkItemResult(runId: string, result: WorkItemResult, role: string, type: WorkItem["type"]) {
    const paths = await this.ensureRunLayout(runId);
    const directory = resultDirectory(paths, role, type);
    const filePath = path.join(directory, `${result.work_item_id}.json`);
    await writeJson(filePath, result);
    await this.metadata.recordSwarmWorkItemResultSaved({ runId, result, role, type, artifactRef: filePath });
    await this.traceWriter.write({
      run_id: runId,
      task_id: result.work_item_id,
      event_type: result.status === "succeeded" ? "agent_invocation_completed" : "agent_invocation_failed",
      lifecycle_stage: type === "test" ? "validating" : type === "review" ? "reviewing" : "executing",
      next_status: result.status,
      summary: result.summary,
      artifact_refs: [filePath],
      metadata_json: {
        role,
        work_item_type: type,
        structured_output_valid: result.structured_output_valid,
        validation_passed: result.validation_passed,
        confidence: result.confidence
      },
      severity: result.status === "succeeded" ? "info" : result.status === "blocked" ? "warning" : "error"
    });
    await this.traceWriter.write({
      run_id: runId,
      task_id: result.work_item_id,
      event_type: result.structured_output_valid ? "output_schema_validated" : "output_schema_failed",
      lifecycle_stage: type === "test" ? "validating" : "executing",
      summary: result.structured_output_valid ? "Swarm worker output schema accepted." : "Swarm worker output schema failed.",
      artifact_refs: [filePath],
      metadata_json: {
        work_item_type: type,
        role
      },
      severity: result.structured_output_valid ? "info" : "error"
    });
    return filePath;
  }

  async saveProviderWorkerArtifact(input: {
    runId: string;
    workItemId: string;
    name: string;
    extension: "json" | "md";
    value: unknown;
    metadata?: Record<string, unknown>;
  }) {
    const paths = await this.ensureRunLayout(input.runId);
    const directory = path.join(paths.providerWorkersDir, input.workItemId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${input.name}.${input.extension}`);
    if (input.extension === "md") {
      await writeFile(filePath, typeof input.value === "string" ? input.value : JSON.stringify(input.value, null, 2), "utf8");
    } else {
      await writeJson(filePath, input.value);
    }
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      taskId: input.workItemId,
      kind: `provider_worker_${input.name}`,
      artifactRef: filePath,
      status: "recorded",
      metadata: input.metadata
    });
    return filePath;
  }

  async saveConsensus(group: ConsensusGroup) {
    const paths = await this.ensureRunLayout(group.swarm_run_id);
    const filePath = path.join(paths.consensusDir, `${group.id}.json`);
    await writeJson(filePath, group);
    await this.metadata.recordSwarmConsensusSaved(group, filePath);
    await this.traceWriter.write({
      run_id: group.swarm_run_id,
      event_type: "integration_completed",
      lifecycle_stage: "integrating",
      summary: `Swarm consensus artifact written: ${group.decision}.`,
      artifact_refs: [filePath],
      metadata_json: {
        consensus_id: group.id,
        participant_count: group.participant_work_items.length,
        confidence: group.confidence
      }
    });
    return filePath;
  }

  async saveMetrics(runId: string, metrics: SwarmMetrics) {
    const paths = await this.ensureRunLayout(runId);
    await this.saveStructuredState("swarm_metrics", runId, metrics, undefined, paths.metrics, runId);
    await writeJson(paths.metrics, metrics);
    await this.metadata.recordSwarmMetricsSaved(metrics, paths.metrics);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "metadata_record_written",
      lifecycle_stage: "reporting",
      summary: "Swarm metrics artifact written.",
      artifact_refs: [paths.metrics],
      metadata_json: {
        metric_scope: "swarm",
        work_items_created: metrics.work_items_created,
        work_items_failed: metrics.work_items_failed,
        validation_pass_rate: metrics.validation_pass_rate
      }
    });
    return paths.metrics;
  }

  async loadMetrics(runId: string): Promise<SwarmMetrics> {
    return this.requireStructuredState<SwarmMetrics>("swarm_metrics", runId);
  }

  async saveFinalReport(runId: string, markdown: string) {
    const paths = await this.ensureRunLayout(runId);
    await writeFile(paths.finalReport, markdown, "utf8");
    await this.metadata.recordOutputSaved(runId, "final_report", "swarm_final_report", paths.finalReport, { status: "recorded" });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "report_completed",
      lifecycle_stage: "reporting",
      summary: "Swarm final report artifact written.",
      artifact_refs: [paths.finalReport],
      metadata_json: {
        report_chars: markdown.length
      }
    });
    return paths.finalReport;
  }

  async recordRunTransition(record: RunTransitionRecord) {
    await this.metadata.recordRunTransition(record);
  }

  async loadFinalReport(runId: string) {
    const paths = await this.pathsForRun(runId);
    return readFile(paths.finalReport, "utf8");
  }

  async listEvents(runId: string): Promise<SwarmEvent[]> {
    return this.structuredEvents<SwarmEvent>("swarm", runId);
  }

  async listSchedulerTrace(runId: string): Promise<SchedulerTraceEntry[]> {
    return this.structuredEvents<SchedulerTraceEntry>("scheduler", runId);
  }

  async artifactTree(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return walkFiles(paths.runDir, paths.runDir);
  }

  async listRuns() {
    return this.withStructuredStore((store) => store.states<SwarmRun>("swarm_run").sort((left, right) => right.created_at.localeCompare(left.created_at)));
  }

  private async saveStructuredState(kind: string, id: string, state: unknown, status?: string, artifactRef?: string, parentId?: string) {
    await this.withStructuredStore((store) => store.saveState({ kind, id, parentId, status, state, artifactRef }));
  }

  private async requireStructuredState<T>(kind: string, id: string): Promise<T> {
    const value = await this.withStructuredStore((store) => store.state<T>(kind, id));
    if (value === undefined) throw new Error(`SQLite structured state not found: ${kind}/${id}`);
    return value;
  }

  private async structuredEvents<T>(kind: "swarm" | "scheduler", streamId: string): Promise<T[]> {
    return this.withStructuredStore((store) => store.events<T>(kind, streamId));
  }

  private async withStructuredStore<T>(operation: (store: SqliteMemoryStore) => T): Promise<T> {
    const store = await SqliteMemoryStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
    try {
      return operation(store);
    } finally {
      store.close();
    }
  }
}

function resultDirectory(paths: SwarmArtifactPaths, role: string, type: WorkItem["type"]) {
  if (type === "scout") return paths.scoutResultsDir;
  if (type === "plan") return paths.plannerResultsDir;
  if (type === "execute" || type === "integrate") return paths.executorResultsDir;
  if (type === "test") return paths.testerResultsDir;
  if (role.includes("Reviewer") || type === "review" || type === "risk_analysis") return role === "ReviewerAgent" ? paths.reviewerResultsDir : paths.specialistResultsDir;
  return paths.specialistResultsDir;
}

async function walkFiles(rootDir: string, currentDir: string): Promise<Array<{ path: string; sizeBytes: number }>> {
  if (!existsSync(currentDir)) return [];
  const entries = await readdir(currentDir, { withFileTypes: true });
  const output: Array<{ path: string; sizeBytes: number }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await walkFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      output.push({
        path: path.relative(rootDir, fullPath).replaceAll("\\", "/"),
        sizeBytes: (await stat(fullPath)).size
      });
    }
  }
  return output;
}
