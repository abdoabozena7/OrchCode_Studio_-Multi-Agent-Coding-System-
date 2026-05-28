import { randomUUID } from "node:crypto";
import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import {
  createTeamSubPlanAggregation,
  type TeamSubPlan,
  type TeamSubPlanAggregation,
  type TeamSubPlanConflict,
  type TeamSubPlanRisk
} from "./TeamSubPlanningModels.js";

export type TeamSubPlanAggregatorOptions = {
  workspacePath: string;
  memoryDir?: string;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export class TeamSubPlanAggregator {
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly options: TeamSubPlanAggregatorOptions) {
    const workspacePath = path.resolve(options.workspacePath);
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(workspacePath, options.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath, memoryDir: options.memoryDir, sourceComponent: "TeamSubPlanAggregator" });
    this.metadata = new FactoryMetadataAdapter(workspacePath, options.memoryDir);
  }

  async aggregate(runId: string, plans: TeamSubPlan[]): Promise<TeamSubPlanAggregation> {
    await this.traceWriter.write({
      run_id: runId,
      event_type: "team_sub_plan_aggregation_started",
      lifecycle_stage: "planning",
      summary: `Team sub-plan aggregation started for ${plans.length} plan(s).`,
      metadata_json: { run_id: runId, sub_plan_count: plans.length }
    });

    const accepted = plans.filter((plan) => plan.status === "generated" || plan.status === "aggregated");
    const invalid = plans.filter((plan) => plan.status === "invalid" || plan.status === "blocked");
    const skipped = plans.filter((plan) => plan.status === "skipped");
    const duplicates = detectDuplicateTasks(accepted);
    const dependencies = detectCrossTeamDependencies(accepted);
    const scopeConflicts = detectScopeOverlaps(accepted);
    const validationConflicts = detectValidationConflicts(accepted);
    const topRisks = accepted.flatMap((plan) => plan.risks).sort(riskSort).slice(0, 8);
    const aggregation = createTeamSubPlanAggregation({
      run_id: runId,
      status: accepted.length ? invalid.length ? "partial" : "generated" : "empty",
      teams_planned: uniqueStrings(accepted.map((plan) => plan.team_id)),
      teams_skipped: uniqueStrings(skipped.map((plan) => plan.team_id)),
      accepted_sub_plans: accepted.map((plan) => plan.sub_plan_id),
      invalid_sub_plans: invalid.map((plan) => plan.sub_plan_id),
      cross_team_dependencies: dependencies,
      duplicate_task_groups: duplicates,
      scope_conflicts: [...scopeConflicts, ...validationConflicts],
      validation_strategy_summary: summarizeValidationStrategies(accepted),
      top_risks: topRisks,
      unresolved_questions: uniqueStrings(accepted.flatMap((plan) => plan.unresolved_questions)).slice(0, 12),
      recommended_next_step: accepted.length
        ? "Review recursive team sub-plan artifacts before converting any draft into executable work in a future phase."
        : "No accepted team sub-plans were available to aggregate.",
      metadata_json: {
        read_only_recursive_planning_only: true,
        no_executor_tasks_created: true,
        duplicate_task_group_count: duplicates.length,
        cross_team_dependency_count: dependencies.length,
        scope_conflict_count: scopeConflicts.length,
        validation_conflict_count: validationConflicts.length
      }
    });

    for (const conflict of [...duplicates, ...dependencies, ...scopeConflicts, ...validationConflicts]) {
      await this.traceWriter.write({
        run_id: runId,
        team_id: conflict.team_ids[0],
        event_type: conflict.conflict_type === "cross_team_dependency" ? "team_sub_plan_dependency_detected" : "team_sub_plan_scope_conflict_detected",
        lifecycle_stage: "planning",
        severity: conflict.severity === "blocking" ? "error" : conflict.severity,
        summary: conflict.summary,
        metadata_json: {
          run_id: runId,
          conflict_refs: conflict.refs,
          conflict_type: conflict.conflict_type,
          sub_plan_ids: conflict.sub_plan_ids,
          team_ids: conflict.team_ids
        }
      });
    }

    const artifactRef = await this.artifactStore.saveTeamSubPlanAggregation(aggregation);
    const persisted = { ...aggregation, artifact_ref: artifactRef };
    const summaryRef = await this.artifactStore.saveTeamSubPlanAggregationSummary(persisted);
    const complete = { ...persisted, summary_ref: summaryRef };
    const trace = await this.traceWriter.write({
      run_id: runId,
      event_type: "team_sub_plan_aggregation_completed",
      lifecycle_stage: "planning",
      summary: `Team sub-plan aggregation completed: ${accepted.length} accepted, ${invalid.length} invalid.`,
      artifact_refs: [artifactRef, summaryRef],
      metadata_json: {
        run_id: runId,
        aggregation_id: complete.aggregation_id,
        status: complete.status,
        accepted_sub_plan_count: complete.accepted_sub_plans.length,
        invalid_sub_plan_count: complete.invalid_sub_plans.length,
        cross_team_dependency_count: complete.cross_team_dependencies.length,
        scope_conflict_count: complete.scope_conflicts.length
      }
    });
    const traced = { ...complete, trace_event_id: trace.trace_event_id };
    await this.metadata.recordTeamSubPlanAggregationSaved(traced);
    return traced;
  }
}

function detectDuplicateTasks(plans: TeamSubPlan[]): TeamSubPlanConflict[] {
  const byTitle = new Map<string, TeamSubPlan[]>();
  for (const plan of plans) {
    for (const task of plan.proposed_tasks) {
      const key = normalizeText(`${task.title}:${task.objective}`);
      byTitle.set(key, [...byTitle.get(key) ?? [], plan]);
    }
  }
  return [...byTitle.entries()]
    .filter(([, entries]) => uniqueStrings(entries.map((entry) => entry.sub_plan_id)).length > 1)
    .map(([key, entries]) => conflict("duplicate_task", "warning", entries, `Duplicate team task draft detected: ${key}.`, [key]));
}

function detectCrossTeamDependencies(plans: TeamSubPlan[]): TeamSubPlanConflict[] {
  const output: TeamSubPlanConflict[] = [];
  for (const plan of plans) {
    for (const dependency of plan.dependencies) {
      if (dependency.depends_on_team_id && dependency.depends_on_team_id !== plan.team_id) {
        const target = plans.find((candidate) => candidate.team_id === dependency.depends_on_team_id);
        output.push(conflict(
          "cross_team_dependency",
          "info",
          [plan, target].filter((entry): entry is TeamSubPlan => Boolean(entry)),
          `Cross-team dependency detected from ${plan.team_id} to ${dependency.depends_on_team_id}.`,
          [dependency.source_ref, dependency.target_ref]
        ));
      }
    }
  }
  return output;
}

function detectScopeOverlaps(plans: TeamSubPlan[]): TeamSubPlanConflict[] {
  const conflicts: TeamSubPlanConflict[] = [];
  for (let index = 0; index < plans.length; index += 1) {
    for (let inner = index + 1; inner < plans.length; inner += 1) {
      const left = plans[index];
      const right = plans[inner];
      const overlap = intersection(proposedFiles(left), proposedFiles(right));
      if (overlap.length) {
        conflicts.push(conflict(
          "scope_overlap",
          "warning",
          [left, right],
          `Team sub-plan scope overlap detected between ${left.team_id} and ${right.team_id}.`,
          overlap
        ));
      }
    }
  }
  return conflicts;
}

function detectValidationConflicts(plans: TeamSubPlan[]): TeamSubPlanConflict[] {
  const commands = plans.map((plan) => ({ plan, commands: plan.validation_strategy.commands }));
  const noValidation = commands.filter((entry) => entry.commands.length === 0);
  const withValidation = commands.filter((entry) => entry.commands.length > 0);
  if (!noValidation.length || !withValidation.length) return [];
  return [conflict(
    "validation_strategy",
    "info",
    plans,
    "Some team sub-plans require validation commands while others are artifact-review only.",
    withValidation.flatMap((entry) => entry.commands)
  )];
}

function summarizeValidationStrategies(plans: TeamSubPlan[]) {
  return plans.map((plan) => {
    const commands = plan.validation_strategy.commands.length ? plan.validation_strategy.commands.join(", ") : "artifact review only";
    return `${plan.team_id}: ${plan.validation_strategy.status}; ${commands}`;
  });
}

function proposedFiles(plan: TeamSubPlan) {
  return uniqueStrings(plan.proposed_tasks.flatMap((task) => [...task.proposed_files, ...task.allowed_write_paths]));
}

function conflict(type: TeamSubPlanConflict["conflict_type"], severity: TeamSubPlanConflict["severity"], plans: TeamSubPlan[], summary: string, refs: string[]): TeamSubPlanConflict {
  return {
    conflict_id: `team_sub_plan_conflict_${randomUUID()}`,
    conflict_type: type,
    severity,
    sub_plan_ids: uniqueStrings(plans.map((plan) => plan.sub_plan_id)),
    team_ids: uniqueStrings(plans.map((plan) => plan.team_id)),
    summary,
    refs: uniqueStrings(refs),
    metadata_json: {}
  };
}

function riskSort(left: TeamSubPlanRisk, right: TeamSubPlanRisk) {
  return severityRank(right.severity) - severityRank(left.severity);
}

function severityRank(value: TeamSubPlanRisk["severity"]) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value];
}

function intersection(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((entry) => rightSet.has(entry));
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}
