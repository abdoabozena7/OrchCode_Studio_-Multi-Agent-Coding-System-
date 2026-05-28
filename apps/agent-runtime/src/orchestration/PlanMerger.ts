import { randomUUID } from "node:crypto";
import type {
  MergedPlan,
  MultiPlanEvaluationContext,
  PlanEvaluation,
  PlanningDependency,
  PlanningMergeDecision,
  PlanningRisk,
  PlanningTaskDraft,
  PlanningValidationStrategy,
  PlanVariant
} from "./MultiPlanModels.js";

export function mergePlanVariants(
  variants: PlanVariant[],
  evaluations: PlanEvaluation[],
  context: MultiPlanEvaluationContext
): MergedPlan {
  const selectedIds = evaluations.filter((evaluation) => evaluation.selected).map((evaluation) => evaluation.plan_id);
  const selected = variants.filter((variant) => selectedIds.includes(variant.plan_id));
  const source = selected.length ? selected : variants;
  const rejectedIds = variants.map((variant) => variant.plan_id).filter((planId) => !selectedIds.includes(planId));
  const tasks = dedupeTasks(source.flatMap((variant) => variant.proposed_tasks));
  const dependencies = dedupeDependencies(source.flatMap((variant) => variant.dependencies));
  const risks = dedupeRisks(source.flatMap((variant) => variant.risks));
  const assumptions = dedupeByStatement(source.flatMap((variant) => variant.assumptions));
  const validationStrategy = mergeValidationStrategies(source.map((variant) => variant.validation_strategy));
  const confidence = average(evaluations.filter((evaluation) => selectedIds.includes(evaluation.plan_id)).map((evaluation) => evaluation.confidence)) || 0.6;
  const topEvaluation = evaluations
    .slice()
    .sort((left, right) => average(Object.values(right.scores)) - average(Object.values(left.scores)))[0];

  return {
    merged_plan_id: `merged_plan_${randomUUID()}`,
    run_id: variants[0]?.run_id ?? "unknown_run",
    task_id: variants[0]?.task_id,
    generation_mode: context.generation_mode,
    selected_plan_ids: selectedIds,
    rejected_plan_ids: rejectedIds,
    summary: `Merged ${source.length} read-only planning perspective(s) into an advisory plan focused on ${context.trigger.inferred_complexity} complexity and ${context.trigger.inferred_risk} risk.`,
    chosen_strategy: chooseStrategy(source, context),
    merged_tasks: tasks,
    dependencies,
    risks,
    assumptions,
    validation_strategy: validationStrategy,
    recommended_limits: mergeLimits(source),
    merge_rationale: [
      "Combined selected high-scoring perspectives without creating executor work.",
      "Deduplicated task drafts by normalized objective.",
      "Preserved safety, validation, and architecture concerns even when a narrower MVP task is recommended first.",
      ...evidenceMergeRationale(context),
      topEvaluation ? `Highest scoring perspective by aggregate score: ${topEvaluation.perspective}.` : "No evaluation scores were available."
    ],
    merge_decisions: mergeDecisions(source, rejectedIds),
    unresolved_questions: uniqueStrings([
      ...source.flatMap((variant) => variant.unknowns),
      ...(context.evidence_bundle?.conflicts.map((conflict) => `Evidence conflict: ${conflict.summary}`) ?? [])
    ]),
    confidence,
    artifact_ref: "",
    evidence_bundle_ref: context.evidence_bundle?.artifact_ref,
    evidence_item_refs: uniqueStrings(source.flatMap((variant) => variant.evidence_item_refs ?? [])),
    evidence_used_summary: context.evidence_bundle?.summary,
    evidence_conflicts: context.evidence_bundle?.conflicts ?? [],
    evidence_limitations: context.evidence_bundle?.limitations ?? [],
    evidence_influence_notes: uniqueStrings(source.flatMap((variant) => variant.evidence_used_summary ?? [])),
    created_at: new Date().toISOString()
  };
}

function chooseStrategy(variants: PlanVariant[], context: MultiPlanEvaluationContext) {
  const perspectives = variants.map((variant) => variant.perspective);
  if (context.trigger.inferred_risk === "high" || context.trigger.inferred_risk === "critical") {
    return "Safety-led plan: execute the smallest useful slice only after validation and approval risks are explicit.";
  }
  if (perspectives.includes("mvp_first") && perspectives.includes("test_first")) {
    return "MVP plus proof: start with the smallest useful implementation plan and carry forward the test-first validation strategy.";
  }
  if (perspectives.includes("architecture_first")) {
    return "Architecture-aware incremental plan: preserve module and contract boundaries while keeping first steps narrow.";
  }
  return "Incremental read-only advisory plan.";
}

function dedupeTasks(tasks: PlanningTaskDraft[]) {
  const seen = new Set<string>();
  const output: PlanningTaskDraft[] = [];
  for (const task of tasks) {
    const key = normalize(task.objective);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({
      ...task,
      read_only: true,
      allowed_write_paths: []
    });
  }
  return output;
}

function dedupeDependencies(dependencies: PlanningDependency[]) {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = normalize(`${dependency.dependency_type}:${dependency.summary}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRisks(risks: PlanningRisk[]) {
  const seen = new Set<string>();
  return risks.filter((risk) => {
    const key = normalize(risk.summary);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function dedupeByStatement<T extends { statement: string }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = normalize(item.statement);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeValidationStrategies(strategies: PlanningValidationStrategy[]): PlanningValidationStrategy {
  const severity = strategies.map((strategy) => strategy.validation_risk).sort((left, right) => severityRank(right) - severityRank(left))[0] ?? "medium";
  return {
    required_commands: uniqueStrings(strategies.flatMap((strategy) => strategy.required_commands)),
    optional_commands: uniqueStrings(strategies.flatMap((strategy) => strategy.optional_commands)),
    smoke_checks: uniqueStrings(strategies.flatMap((strategy) => strategy.smoke_checks)),
    manual_checks: uniqueStrings(strategies.flatMap((strategy) => strategy.manual_checks)),
    success_criteria: uniqueStrings(strategies.flatMap((strategy) => strategy.success_criteria)),
    validation_risk: severity
  };
}

function mergeLimits(variants: PlanVariant[]) {
  const merged: Record<string, number | string | boolean> = {
    read_only: true,
    write_capable_executor_tasks_created: false
  };
  for (const variant of variants) {
    for (const [key, value] of Object.entries(variant.suggested_limits)) {
      if (typeof value === "number") {
        const prior = typeof merged[key] === "number" ? merged[key] as number : value;
        merged[key] = Math.min(prior, value);
      } else if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function mergeDecisions(variants: PlanVariant[], rejectedPlanIds: string[]): PlanningMergeDecision[] {
  return [
    {
      decision_id: `merge_decision_${randomUUID()}`,
      source_plan_ids: variants.map((variant) => variant.plan_id),
      decision: "selected_read_only_advisory_merge",
      rationale: "Only task drafts, dependencies, risks, assumptions, and validation guidance were merged; no source edits or executor jobs were produced.",
      confidence: round(average(variants.map((variant) => variant.confidence)))
    },
    {
      decision_id: `merge_decision_${randomUUID()}`,
      source_plan_ids: rejectedPlanIds,
      decision: "preserved_rejections_as_context",
      rationale: "Rejected variants remain in artifacts and metadata for auditability but do not drive the merged task draft list.",
      confidence: 0.8
    }
  ];
}

function evidenceMergeRationale(context: MultiPlanEvaluationContext) {
  const bundle = context.evidence_bundle;
  if (!bundle?.items.length) return ["No provider-backed planning evidence was available; deterministic/heuristic fallback signals remain in effect."];
  return [
    `Preserved ${bundle.items.length} planning evidence item ref(s) from read-only swarm workers.`,
    `Evidence sources: ${uniqueStrings(bundle.items.map((item) => item.source_type)).join(", ")}.`,
    ...(bundle.conflicts.length ? [`Preserved ${bundle.conflicts.length} evidence conflict(s) for audit rather than resolving them silently.`] : [])
  ];
}

function severityRank(severity: string) {
  if (severity === "critical") return 4;
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function average(values: number[]) {
  if (!values.length) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
