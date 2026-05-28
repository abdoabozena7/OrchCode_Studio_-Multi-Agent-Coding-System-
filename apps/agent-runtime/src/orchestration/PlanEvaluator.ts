import { randomUUID } from "node:crypto";
import type {
  MultiPlanEvaluationContext,
  PlanEvaluation,
  PlanEvaluationScore,
  PlanVariant
} from "./MultiPlanModels.js";

export function evaluatePlanVariants(
  variants: PlanVariant[],
  context: MultiPlanEvaluationContext
): PlanEvaluation[] {
  const scoresByPlan = new Map<string, PlanEvaluationScore>();
  for (const variant of variants) {
    scoresByPlan.set(variant.plan_id, scoreVariant(variant, context));
  }

  const duplicateGroups = findDuplicateTaskGroups(variants);
  const selectedPlanIds = selectPlanIds(variants, scoresByPlan, context);

  return variants.map((variant) => {
    const scores = scoresByPlan.get(variant.plan_id)!;
    const duplicateWeakness = duplicateGroups.get(variant.plan_id);
    const riskyAssumptions = variant.assumptions
      .filter((assumption) => assumption.confidence === "low")
      .map((assumption) => assumption.statement);
    const contradictions = findContradictions(variant, context);
    const selected = selectedPlanIds.has(variant.plan_id);
    return {
      evaluation_id: `eval_${randomUUID()}`,
      run_id: variant.run_id,
      plan_id: variant.plan_id,
      perspective: variant.perspective,
      scores,
      strengths: strengthsFor(variant, scores, context),
      weaknesses: [
        ...weaknessesFor(variant, scores),
        ...(duplicateWeakness ? [duplicateWeakness] : [])
      ],
      contradictions,
      risky_assumptions: riskyAssumptions,
      selected,
      rejected_reason: selected ? undefined : rejectionReason(variant, scores, duplicateWeakness),
      confidence: round((scores.confidence + variant.confidence) / 2),
      artifact_ref: "",
      evidence_item_refs: variant.evidence_item_refs ?? [],
      evidence_influence_notes: evidenceInfluenceNotes(variant, context),
      created_at: new Date().toISOString()
    };
  });
}

function scoreVariant(variant: PlanVariant, context: MultiPlanEvaluationContext): PlanEvaluationScore {
  const taskCount = variant.proposed_tasks.length;
  const riskCount = variant.risks.length;
  const requiredValidation = variant.validation_strategy.required_commands.length;
  const smokeChecks = variant.validation_strategy.smoke_checks.length;
  const hasArchitectureConcern = /architecture|module|api|contract|boundary|integration/i.test([
    variant.summary,
    ...variant.proposed_tasks.map((task) => task.objective),
    ...variant.risks.map((risk) => risk.summary)
  ].join("\n"));
  const hasSafetyConcern = /risk|safety|approval|rollback|blocked|scope/i.test([
    variant.summary,
    ...variant.risks.map((risk) => risk.summary),
    ...variant.validation_strategy.manual_checks
  ].join("\n"));
  const hasUserValue = /mvp|value|useful|smallest|deliver|first/i.test(variant.summary);
  const highRisk = context.trigger.inferred_risk === "high" || context.trigger.inferred_risk === "critical";
  const mediumPlus = ["medium", "large", "huge"].includes(context.trigger.inferred_complexity);

  const evidence = context.evidence_bundle;
  const highRiskEvidence = evidence?.items.some((item) => item.extracted_risks.some((risk) => /critical|high|block|unsafe|approval/i.test(risk))) ?? false;
  const testerEvidence = evidence?.items.some((item) => item.source_type === "provider_tester_planner_output" && item.extracted_validation_recommendations.length) ?? false;
  const scoutEvidence = evidence?.items.some((item) => item.source_type === "provider_scout_output" && item.extracted_dependencies.some((file) => variant.proposed_tasks.some((task) => task.proposed_files.includes(file)))) ?? false;
  const addressesEvidenceRisk = !highRiskEvidence || /evidence-backed risk|approval|risk|blocked|safety|validation/i.test([
    ...variant.risks.map((risk) => risk.summary),
    variant.summary,
    ...variant.proposed_tasks.map((task) => task.objective)
  ].join("\n"));

  const minimality = clamp(92 - Math.max(0, taskCount - 3) * 8 - variant.dependencies.length * 2);
  const implementationSpeed = clamp(88 - Math.max(0, taskCount - 2) * 7 + (variant.perspective === "speed_first" ? 8 : 0));
  const testability = clamp(55 + requiredValidation * 10 + smokeChecks * 6 + (variant.perspective === "test_first" ? 12 : 0) + (testerEvidence ? 8 : 0));
  const architectureQuality = clamp(50 + (hasArchitectureConcern ? 24 : 0) + (variant.perspective === "architecture_first" ? 14 : 0) + (mediumPlus ? 5 : 0));
  const safety = clamp(58 + (hasSafetyConcern ? 22 : 0) + (variant.perspective === "risk_first" ? 14 : 0) - riskCount * 2 - (highRiskEvidence && !addressesEvidenceRisk ? 18 : 0));
  const completeness = clamp(55 + Math.min(taskCount, 5) * 7 + variant.dependencies.length * 3 + variant.unknowns.length * 2);
  const integrationRisk = clamp(88 - riskCount * 8 - variant.unknowns.length * 5 + (hasArchitectureConcern ? 6 : 0) - (highRiskEvidence && !addressesEvidenceRisk ? 10 : 0));
  const userValue = clamp(62 + (hasUserValue ? 18 : 0) + (variant.perspective === "mvp_first" ? 8 : 0));
  const confidence = clamp(variant.confidence * 100 - variant.unknowns.length * 3 - riskyAssumptionPenalty(variant) + (scoutEvidence ? 6 : 0) + (variant.evidence_item_refs?.length ? 4 : 0));

  return {
    safety: highRisk ? Math.max(safety, variant.perspective === "risk_first" ? 88 : safety) : safety,
    completeness,
    minimality,
    testability,
    architecture_quality: architectureQuality,
    implementation_speed: implementationSpeed,
    integration_risk: integrationRisk,
    user_value: userValue,
    confidence
  };
}

function selectPlanIds(
  variants: PlanVariant[],
  scoresByPlan: Map<string, PlanEvaluationScore>,
  context: MultiPlanEvaluationContext
) {
  const selected = new Set<string>();
  const bestBy = (field: keyof PlanEvaluationScore) => variants
    .slice()
    .sort((left, right) => scoresByPlan.get(right.plan_id)![field] - scoresByPlan.get(left.plan_id)![field])[0];

  if (context.trigger.inferred_risk === "high" || context.trigger.inferred_risk === "critical") {
    selected.add(bestBy("safety").plan_id);
  }
  if (context.trigger.inferred_complexity === "small" || context.trigger.inferred_complexity === "tiny") {
    selected.add(bestBy("minimality").plan_id);
  }
  if (context.risk_signals.includes("validation")) {
    selected.add(bestBy("testability").plan_id);
  }
  if (["medium", "large", "huge"].includes(context.trigger.inferred_complexity)) {
    selected.add(bestBy("architecture_quality").plan_id);
    selected.add(bestBy("testability").plan_id);
  }
  selected.add(bestBy("user_value").plan_id);
  selected.add(bestBy("implementation_speed").plan_id);
  selected.add(bestBy("confidence").plan_id);
  if (selected.size <= 3) return selected;
  return new Set([...selected]
    .sort((left, right) => aggregate(scoresByPlan.get(right)!) - aggregate(scoresByPlan.get(left)!))
    .slice(0, 3));
}

function findDuplicateTaskGroups(variants: PlanVariant[]) {
  const seen = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const variant of variants) {
    for (const task of variant.proposed_tasks) {
      const key = normalizeTask(task.objective);
      const prior = seen.get(key);
      if (prior && prior !== variant.plan_id) {
        duplicates.set(variant.plan_id, `Duplicates task intent already covered by ${prior}.`);
      } else {
        seen.set(key, variant.plan_id);
      }
    }
  }
  return duplicates;
}

function findContradictions(variant: PlanVariant, context: MultiPlanEvaluationContext) {
  const contradictions: string[] = [];
  const writes = variant.proposed_tasks.flatMap((task) => task.allowed_write_paths);
  if (writes.length) contradictions.push("Plan variant contains write paths even though multi-plan generation must be read-only.");
  if (variant.proposed_tasks.some((task) => !task.read_only)) {
    contradictions.push("Plan variant includes a non-read-only task draft.");
  }
  if (variant.risks.some((risk) => risk.severity === "critical") && !variant.validation_strategy.manual_checks.length) {
    contradictions.push("Critical risk present without a manual check or approval path.");
  }
  const highRiskEvidence = context.evidence_bundle?.items.some((item) => item.extracted_risks.some((risk) => /critical|high|block|unsafe|approval/i.test(risk))) ?? false;
  if (highRiskEvidence && !/evidence-backed risk|approval|risk|blocked|safety|validation/i.test([
    ...variant.risks.map((risk) => risk.summary),
    variant.summary,
    ...variant.proposed_tasks.map((task) => task.objective)
  ].join("\n"))) {
    contradictions.push("Plan does not visibly address high-risk planning evidence.");
  }
  for (const conflict of context.evidence_bundle?.conflicts ?? []) {
    contradictions.push(`Evidence conflict preserved: ${conflict.summary}`);
  }
  return contradictions;
}

function strengthsFor(variant: PlanVariant, scores: PlanEvaluationScore, context: MultiPlanEvaluationContext) {
  const strengths: string[] = [];
  if (scores.safety >= 80) strengths.push("Strong safety posture for planning-only use.");
  if (scores.minimality >= 80) strengths.push("Keeps scope narrow and avoids over-planning.");
  if (scores.testability >= 80) strengths.push("Provides a clear validation strategy.");
  if (scores.architecture_quality >= 80) strengths.push("Captures module boundaries and integration concerns.");
  if (scores.implementation_speed >= 80) strengths.push("Favors fast reuse of existing components.");
  if (variant.perspective === "risk_first" && context.trigger.inferred_risk !== "low") strengths.push("Matches elevated risk signals.");
  return strengths.length ? strengths : ["Useful perspective coverage for the merged plan."];
}

function weaknessesFor(variant: PlanVariant, scores: PlanEvaluationScore) {
  const weaknesses: string[] = [];
  if (scores.safety < 65) weaknesses.push("Safety coverage is thin compared with other variants.");
  if (scores.testability < 65) weaknesses.push("Validation proof is underspecified.");
  if (scores.architecture_quality < 65) weaknesses.push("Architecture and API implications are lightly covered.");
  if (scores.minimality < 65) weaknesses.push("Scope may be larger than needed for the first safe step.");
  if (variant.unknowns.length > 2) weaknesses.push("Leaves multiple unknowns for later reconciliation.");
  return weaknesses;
}

function rejectionReason(variant: PlanVariant, scores: PlanEvaluationScore, duplicateWeakness?: string) {
  if (duplicateWeakness) return duplicateWeakness;
  if (scores.confidence < 55) return "Lower confidence than selected alternatives.";
  if (scores.safety < 60) return "Lower safety score than selected alternatives.";
  return `${variant.perspective} contributes less unique value than selected variants.`;
}

function evidenceInfluenceNotes(variant: PlanVariant, context: MultiPlanEvaluationContext) {
  const refs = new Set(variant.evidence_item_refs ?? []);
  const items = (context.evidence_bundle?.items ?? []).filter((item) => refs.has(item.evidence_id));
  const notes = items.slice(0, 4).map((item) => `${item.source_type} influenced ${variant.perspective}: ${item.summary}`);
  if (context.evidence_bundle?.conflicts.length) notes.push(`${context.evidence_bundle.conflicts.length} evidence conflict(s) preserved for review.`);
  return notes;
}

function riskyAssumptionPenalty(variant: PlanVariant) {
  return variant.assumptions.filter((assumption) => assumption.confidence === "low").length * 6;
}

function normalizeTask(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function aggregate(scores: PlanEvaluationScore) {
  return Object.values(scores).reduce((sum, value) => sum + value, 0) / Object.values(scores).length;
}
