import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import {
  type MergedPlan,
  type MultiPlanEvaluationContext,
  type MultiPlanFactoryResult,
  type MultiPlanGenerationMode,
  type MultiPlanInput,
  type MultiPlanSummary,
  type MultiPlanTriggerDecision,
  type PlanPerspective,
  type PlanVariant,
  type PlanningAssumption,
  type PlanningDependency,
  type PlanningRisk,
  type PlanningTaskDraft,
  type PlanningValidationStrategy,
  type PlanningEvidenceBundle,
  type PlanningEvidenceItem,
  type PlanningEvidenceSourceType,
  REQUIRED_PLAN_PERSPECTIVES
} from "./MultiPlanModels.js";
import { evaluatePlanVariants } from "./PlanEvaluator.js";
import { mergePlanVariants } from "./PlanMerger.js";
import { PlanningEvidenceCollector } from "./PlanningEvidenceCollector.js";

export class MultiPlanFactory {
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly workspacePath: string, private readonly memoryDir?: string) {
    this.artifactStore = new OrchestrationArtifactStore(workspacePath, memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath, memoryDir, sourceComponent: "MultiPlanFactory" });
    this.metadata = new FactoryMetadataAdapter(workspacePath, memoryDir);
  }

  async create(input: MultiPlanInput): Promise<MultiPlanFactoryResult> {
    const trigger = shouldUseMultiPlanFactory(input);
    if (!trigger.use_multi_plan) {
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: "multi_plan_skipped",
        lifecycle_stage: "planning",
        severity: "info",
        reason: trigger.reason,
        summary: `Multi-plan factory skipped: ${trigger.reason}`,
        metadata_json: {
          run_id: input.run.id,
          task_id: input.taskId,
          inferred_complexity: trigger.inferred_complexity,
          inferred_risk: trigger.inferred_risk,
          confidence: trigger.confidence
        }
      });
      return { used: false, trigger, variants: [], evaluations: [] };
    }

    const evidenceBundle = await this.resolvePlanningEvidence(input);
    const context = createEvaluationContext(input, trigger, evidenceBundle);
    const started = await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "multi_plan_started",
      lifecycle_stage: "planning",
      summary: `Multi-plan factory started with ${context.generation_mode} generation.`,
      metadata_json: {
        run_id: input.run.id,
        task_id: input.taskId,
        generation_mode: context.generation_mode,
        inferred_complexity: trigger.inferred_complexity,
        inferred_risk: trigger.inferred_risk,
        confidence: trigger.confidence,
        evidence_bundle_id: evidenceBundle?.evidence_bundle_id,
        evidence_item_count: evidenceBundle?.items.length ?? 0
      }
    });

    const variants = [];
    for (const variant of generatePlanVariants(input, context)) {
      const persisted = await this.artifactStore.savePlanVariant(variant);
      variants.push(persisted);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: "plan_variant_created",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        summary: `Plan variant created: ${persisted.perspective}.`,
        artifact_refs: [persisted.artifact_ref],
        metadata_json: {
          run_id: input.run.id,
          task_id: input.taskId,
          perspective: persisted.perspective,
          plan_id: persisted.plan_id,
          generation_mode: persisted.generation_mode,
          confidence: persisted.confidence,
          artifact_ref: persisted.artifact_ref,
          prompt_ref: persisted.prompt_ref ?? null,
          prompt_used: false
        }
      });
      await this.recordEvidenceUse({
        runId: input.run.id,
        taskId: input.taskId,
        planId: persisted.plan_id,
        evidenceItems: evidenceItemsForPlan(persisted, evidenceBundle),
        eventType: "planning_evidence_used_by_plan",
        usageType: "informed_plan_variant",
        summary: `Evidence used by ${persisted.perspective} plan variant.`
      });
    }

    const evaluations = evaluatePlanVariants(variants, context);
    const evaluationArtifact = await this.artifactStore.savePlanEvaluations(input.run.id, evaluations, context);
    const persistedEvaluations = evaluations.map((evaluation) => ({
      ...evaluation,
      artifact_ref: evaluationArtifact
    }));
    for (const evaluation of persistedEvaluations) {
      await this.artifactStore.recordPlanEvaluation(evaluation);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: "plan_variant_evaluated",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        summary: `Plan variant evaluated: ${evaluation.perspective}.`,
        artifact_refs: [evaluationArtifact],
        metadata_json: {
          run_id: input.run.id,
          task_id: input.taskId,
          perspective: evaluation.perspective,
          plan_id: evaluation.plan_id,
          scores: evaluation.scores,
          confidence: evaluation.confidence,
          artifact_ref: evaluationArtifact
        }
      });
      await this.recordEvidenceUse({
        runId: input.run.id,
        taskId: input.taskId,
        planId: evaluation.plan_id,
        evidenceItems: evidenceItemsFromRefs(evidenceBundle, evaluation.evidence_item_refs ?? []),
        eventType: "planning_evidence_used_by_evaluation",
        usageType: "adjusted_evaluation",
        summary: `Evidence used by ${evaluation.perspective} evaluation.`
      });
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: evaluation.selected ? "plan_variant_selected" : "plan_variant_rejected",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        severity: evaluation.selected ? "info" : "warning",
        reason: evaluation.rejected_reason,
        summary: evaluation.selected
          ? `Plan variant selected: ${evaluation.perspective}.`
          : `Plan variant rejected: ${evaluation.perspective}.`,
        artifact_refs: [evaluationArtifact],
        metadata_json: {
          run_id: input.run.id,
          task_id: input.taskId,
          perspective: evaluation.perspective,
          plan_id: evaluation.plan_id,
          selected: evaluation.selected,
          scores: evaluation.scores,
          confidence: evaluation.confidence,
          artifact_ref: evaluationArtifact
        }
      });
    }

    const mergeStarted = await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "plan_merge_started",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: "Plan merge started.",
      artifact_refs: [evaluationArtifact],
      metadata_json: {
        run_id: input.run.id,
        task_id: input.taskId,
        selected_plan_ids: persistedEvaluations.filter((evaluation) => evaluation.selected).map((evaluation) => evaluation.plan_id)
      }
    });

    const merged = mergePlanVariants(variants, persistedEvaluations, context);
    const persistedMerged = await this.artifactStore.saveMergedPlan(merged);
    await this.recordEvidenceUse({
      runId: input.run.id,
      taskId: input.taskId,
      mergedPlanId: persistedMerged.merged_plan_id,
      evidenceItems: evidenceItemsFromRefs(evidenceBundle, persistedMerged.evidence_item_refs ?? []),
      eventType: "planning_evidence_used_by_merge",
      usageType: "merged_into_plan",
      summary: "Evidence preserved in merged plan."
    });
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "plan_merge_completed",
      lifecycle_stage: "planning",
      causal_parent_event_id: mergeStarted.trace_event_id,
      summary: "Plan merge completed.",
      artifact_refs: [persistedMerged.artifact_ref],
      metadata_json: {
        run_id: input.run.id,
        task_id: input.taskId,
        merged_plan_id: persistedMerged.merged_plan_id,
        selected_plan_ids: persistedMerged.selected_plan_ids,
        rejected_plan_ids: persistedMerged.rejected_plan_ids,
        confidence: persistedMerged.confidence,
        artifact_ref: persistedMerged.artifact_ref
      }
    });
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "merged_plan_artifact_written",
      lifecycle_stage: "planning",
      causal_parent_event_id: mergeStarted.trace_event_id,
      summary: "Merged plan artifact written.",
      artifact_refs: [persistedMerged.artifact_ref],
      metadata_json: {
        run_id: input.run.id,
        task_id: input.taskId,
        merged_plan_id: persistedMerged.merged_plan_id,
        generation_mode: persistedMerged.generation_mode,
        confidence: persistedMerged.confidence,
        artifact_ref: persistedMerged.artifact_ref
      }
    });

    const summary = summarizePlanningDecision({
      trigger,
      variants,
      mergedPlan: persistedMerged,
      generationMode: context.generation_mode
    });
    const summaryRef = await this.artifactStore.savePlanningSummary(input.run.id, summary, persistedMerged, persistedEvaluations);
    summary.merged_plan_ref = persistedMerged.artifact_ref;
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "artifact_written",
      lifecycle_stage: "planning",
      summary: "Planning summary artifact written.",
      artifact_refs: [summaryRef],
      metadata_json: {
        artifact_kind: "planning_summary",
        merged_plan_id: persistedMerged.merged_plan_id
      }
    });

    return {
      used: true,
      trigger,
      generation_mode: context.generation_mode,
      variants,
      evaluations: persistedEvaluations,
      merged_plan: persistedMerged,
      summary
    };
  }

  private async resolvePlanningEvidence(input: MultiPlanInput): Promise<PlanningEvidenceBundle | undefined> {
    const config = input.config;
    if (config?.use_planning_evidence === false || config?.planning_evidence_mode === "off") return undefined;
    if (input.planningEvidence) {
      return input.planningEvidence.artifact_ref
        ? input.planningEvidence
        : this.artifactStore.savePlanningEvidenceBundle(input.planningEvidence);
    }
    return new PlanningEvidenceCollector(this.workspacePath, this.memoryDir).collect(input);
  }

  private async recordEvidenceUse(input: {
    runId: string;
    taskId?: string;
    planId?: string;
    mergedPlanId?: string;
    evidenceItems: PlanningEvidenceItem[];
    eventType: "planning_evidence_used_by_plan" | "planning_evidence_used_by_evaluation" | "planning_evidence_used_by_merge";
    usageType: "informed_plan_variant" | "adjusted_evaluation" | "merged_into_plan";
    summary: string;
  }) {
    for (const item of input.evidenceItems) {
      await this.traceWriter.write({
        run_id: input.runId,
        task_id: input.taskId,
        event_type: input.eventType,
        lifecycle_stage: "planning",
        summary: input.summary,
        artifact_refs: [item.parsed_output_ref, item.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: {
          run_id: input.runId,
          task_id: input.taskId,
          evidence_id: item.evidence_id,
          source_role: item.source_role,
          source_type: item.source_type,
          artifact_ref: item.artifact_ref,
          parsed_output_ref: item.parsed_output_ref,
          confidence: item.confidence,
          freshness: item.freshness,
          plan_id: input.planId,
          merged_plan_id: input.mergedPlanId,
          usage_type: input.usageType
        }
      });
      await this.metadata.recordPlanEvidenceLinkSaved({
        linkId: `evidence_link_${randomUUID().slice(0, 12)}`,
        runId: input.runId,
        evidenceId: item.evidence_id,
        planId: input.planId,
        mergedPlanId: input.mergedPlanId,
        usageType: input.usageType,
        influenceSummary: input.summary
      });
    }
  }
}

export function shouldUseMultiPlanFactory(input: MultiPlanInput): MultiPlanTriggerDecision {
  if (input.config && input.config.enable_multi_plan_factory === false) {
    return skipped("Disabled by orchestration config.", "small", "low", 0.9);
  }
  const inferred = inferComplexityAndRisk(input);
  if (inferred.complexity === "tiny") {
    return skipped("Tiny/simple task keeps existing single-plan path.", inferred.complexity, inferred.risk, inferred.confidence);
  }
  if (inferred.complexity === "small" && !input.planOnly) {
    return skipped("Small execution task keeps existing single-plan path.", inferred.complexity, inferred.risk, inferred.confidence);
  }
  if (input.planOnly && inferred.complexity === "small" && input.rawUserRequest && input.rawUserRequest.length < 180) {
    return skipped("Small plan-only task keeps existing single-plan path.", inferred.complexity, inferred.risk, inferred.confidence);
  }
  return {
    use_multi_plan: true,
    reason: input.staffingPlan
      ? `Staffing planner classified task as ${input.staffingPlan.task_complexity}.`
      : "Heuristic trigger classified task as medium or larger.",
    inferred_complexity: inferred.complexity,
    inferred_risk: inferred.risk,
    confidence: inferred.confidence
  };
}

export function generatePlanVariants(input: MultiPlanInput, context?: MultiPlanEvaluationContext): PlanVariant[] {
  const actualContext = context ?? createEvaluationContext(input, shouldUseMultiPlanFactory(input), input.planningEvidence);
  return REQUIRED_PLAN_PERSPECTIVES.map((perspective) => createVariant(input, actualContext, perspective));
}

export function createMergedPlanningArtifact(mergedPlan: MergedPlan) {
  return {
    artifact_kind: "merged_plan",
    generation_mode: mergedPlan.generation_mode,
    merged_plan: mergedPlan,
    recommended_next_step: "Use this merged plan as advisory input before task graph expansion; do not treat it as execution authorization."
  };
}

export function summarizePlanningDecision(input: {
  trigger: MultiPlanTriggerDecision;
  variants: PlanVariant[];
  mergedPlan?: MergedPlan;
  generationMode?: MultiPlanGenerationMode;
}): MultiPlanSummary {
  const selected = input.mergedPlan?.selected_plan_ids ?? [];
  const rejected = input.mergedPlan?.rejected_plan_ids ?? [];
  return {
    multi_plan_used: Boolean(input.mergedPlan),
    generation_mode: input.generationMode,
    plan_variant_count: input.variants.length,
    selected_perspectives: input.variants.filter((variant) => selected.includes(variant.plan_id)).map((variant) => variant.perspective),
    rejected_perspectives: input.variants.filter((variant) => rejected.includes(variant.plan_id)).map((variant) => variant.perspective),
    top_risks: (input.mergedPlan?.risks ?? []).slice(0, 5).map((risk) => risk.summary),
    merged_plan_ref: input.mergedPlan?.artifact_ref,
    confidence: input.mergedPlan?.confidence ?? input.trigger.confidence,
    unresolved_questions: input.mergedPlan?.unresolved_questions ?? [],
    recommended_next_step: input.mergedPlan
      ? "Use the merged plan as read-only advisory context for existing planning stages."
      : `Continue with existing single-plan behavior because: ${input.trigger.reason}`,
    evidence_used: input.mergedPlan?.evidence_used_summary?.evidence_used ?? false,
    evidence_item_count: input.mergedPlan?.evidence_used_summary?.evidence_item_count ?? 0,
    provider_evidence_count: input.mergedPlan?.evidence_used_summary?.provider_evidence_count ?? 0,
    mock_evidence_count: input.mergedPlan?.evidence_used_summary?.mock_evidence_count ?? 0,
    low_confidence_count: input.mergedPlan?.evidence_used_summary?.low_confidence_count ?? 0,
    rejected_evidence_count: input.mergedPlan?.evidence_used_summary?.rejected_evidence_count ?? 0,
    evidence_conflict_count: input.mergedPlan?.evidence_used_summary?.evidence_conflict_count ?? 0,
    evidence_bundle_ref: input.mergedPlan?.evidence_bundle_ref,
    top_evidence_sources: input.mergedPlan?.evidence_used_summary?.top_evidence_sources ?? [],
    evidence_limitations: input.mergedPlan?.evidence_limitations ?? []
  };
}

function createVariant(input: MultiPlanInput, context: MultiPlanEvaluationContext, perspective: PlanPerspective): PlanVariant {
  const now = new Date().toISOString();
  const runId = input.run.id;
  const objective = objectiveText(input);
  const domains = proposedDomains(input);
  const highSignalFiles = uniqueStrings([...context.high_signal_files, ...evidenceFiles(context.evidence_bundle)]).slice(0, 12);
  const validation = validationStrategy(input, context, perspective);
  const baseAssumptions = assumptions(input, context);
  return {
    plan_id: `plan_${perspective}_${randomUUID().slice(0, 8)}`,
    run_id: runId,
    task_id: input.taskId,
    perspective,
    title: titleFor(perspective),
    summary: summaryFor(perspective, objective),
    generation_mode: context.generation_mode,
    prompt_ref: undefined,
    model_used: undefined,
    assumptions: [
      ...baseAssumptions,
      {
        id: `assumption_${randomUUID().slice(0, 8)}`,
        statement: context.evidence_bundle?.items.length
          ? "No planning model prompt was used; this variant was generated deterministically with read-only swarm evidence as advisory input."
          : "No model prompt was used; this variant was generated from deterministic repository and request signals.",
        confidence: "high",
        evidence_refs: context.evidence_bundle?.items.map((item) => item.evidence_id) ?? []
      }
    ],
    proposed_domains: domains,
    proposed_tasks: tasksFor(perspective, objective, highSignalFiles, validation, context.evidence_bundle),
    dependencies: dependenciesFor(input, validation),
    risks: risksFor(input, context, perspective),
    unknowns: unknownsFor(input, context, perspective),
    validation_strategy: validation,
    suggested_agents: agentsFor(perspective, input),
    suggested_limits: limitsFor(perspective, input, context),
    confidence: confidenceFor(input, context, perspective),
    artifact_ref: "",
    evidence_bundle_ref: context.evidence_bundle?.artifact_ref,
    evidence_item_refs: evidenceRefsForPerspective(context.evidence_bundle, perspective),
    evidence_used_summary: evidenceNotesForPerspective(context.evidence_bundle, perspective),
    created_at: now
  };
}

function createEvaluationContext(input: MultiPlanInput, trigger: MultiPlanTriggerDecision, evidenceBundle?: PlanningEvidenceBundle): MultiPlanEvaluationContext {
  const validationCommands = selectValidationCommands(input.commandInventory);
  const highSignalFiles = selectHighSignalFiles(input.rawUserRequest ?? input.run.user_request, input.repoIndex);
  const evidenceValidationCommands = evidenceBundle?.items.flatMap((item) => item.extracted_validation_recommendations).filter(looksLikeValidationCommand) ?? [];
  return {
    trigger,
    generation_mode: evidenceBundle?.items.some((item) => item.source_type.startsWith("provider_"))
      ? "mixed"
      : input.staffingPlan || input.repoIndex || input.commandInventory || evidenceBundle?.items.length ? "heuristic" : "deterministic",
    validation_commands: uniqueStrings([...validationCommands, ...evidenceValidationCommands]).slice(0, 8),
    high_signal_files: uniqueStrings([...highSignalFiles, ...evidenceFiles(evidenceBundle)]).slice(0, 12),
    risk_signals: uniqueStrings([
      ...riskSignals(input, highSignalFiles, validationCommands),
      ...(evidenceBundle?.items.some((item) => item.extracted_risks.length) ? ["provider_evidence_risk"] : []),
      ...(evidenceBundle?.items.some((item) => item.extracted_validation_recommendations.length) ? ["validation"] : [])
    ]),
    evidence_bundle: evidenceBundle
  };
}

function inferComplexityAndRisk(input: MultiPlanInput) {
  if (input.staffingPlan) {
    return {
      complexity: input.staffingPlan.task_complexity,
      risk: planningRiskFromSwarm(input.staffingPlan.risk_level),
      confidence: input.staffingPlan.confidence
    };
  }
  const request = objectiveText(input).toLowerCase();
  const fileHits = Array.from(request.matchAll(/\b[\w.-]+\/[\w./-]+\b/g)).length;
  const repoFiles = input.repoIndex?.totals.indexedFiles ?? 0;
  let complexity: MultiPlanTriggerDecision["inferred_complexity"] = "small";
  if (matches(request, ["whole repo", "entire repo", "repository-wide", "deep audit", "framework upgrade"])) complexity = "huge";
  else if (matches(request, ["migration", "cross-module", "multi-module", "large", "orchestration layer"])) complexity = "large";
  else if (request.length > 220 || fileHits >= 3 || matches(request, ["implement", "feature", "refactor", "add tests", "architecture", "metadata", "trace"])) complexity = "medium";
  else if (request.length < 80 && matches(request, ["typo", "copy", "label", "explain", "inspect"])) complexity = "tiny";
  if (repoFiles > 250 && complexity === "small" && matches(request, ["audit", "map", "inspect"])) complexity = "medium";

  let risk: MultiPlanTriggerDecision["inferred_risk"] = "low";
  if (matches(request, ["credential", "secret", "auth", "payment", "delete data", "security"])) risk = "critical";
  else if (matches(request, ["migration", "sqlite", "metadata", "state machine", "package-lock", "validation", "trace"])) risk = "high";
  else if (matches(request, ["orchestrator", "runtime", "scheduler", "refactor", "multi-agent"])) risk = "medium";
  const confidence = input.repoIndex || input.commandInventory ? 0.72 : 0.58;
  return { complexity, risk, confidence };
}

function tasksFor(
  perspective: PlanPerspective,
  objective: string,
  files: string[],
  validation: PlanningValidationStrategy,
  evidenceBundle?: PlanningEvidenceBundle
): PlanningTaskDraft[] {
  const common = {
    read_only: true,
    allowed_write_paths: [],
    proposed_files: files,
    validation_refs: validation.required_commands
  };
  if (perspective === "mvp_first") {
    return [
      task("Identify smallest useful planning slice", `Define the minimum useful read-only planning slice for: ${objective}`, "PlannerAgent", [], common, "Prioritizes user value and narrow scope."),
      task("Map integration point", "Identify where the existing task graph can consume advisory merged-plan context without changing executor behavior.", "ArchitectAgent", [], common, "Keeps integration minimal."),
      ...evidenceTask("Apply scout evidence", evidenceBundle, ["provider_scout_output"], "Use scout findings to keep the first slice focused on the highest-signal files.", "ScoutAgent", common)
    ];
  }
  if (perspective === "architecture_first") {
    return [
      task("Map module boundaries", "Document planning, artifact, metadata, trace, and task graph boundaries before integration.", "ArchitectAgent", [], common, "Protects public contracts and ownership boundaries."),
      task("Review API contract", "Define strict planning model fields and advisory handoff semantics.", "PlannerAgent", [], common, "Keeps future extension predictable."),
      task("Identify integration risks", "List task graph and reporting integration risks before enabling behavior changes.", "RiskAnalyzerAgent", [], common, "Prevents broad behavioral changes."),
      ...evidenceTask("Carry architecture evidence", evidenceBundle, ["provider_planner_output", "provider_specialist_output", "provider_reviewer_output"], "Carry module, API, integration, and specialist concerns from evidence artifacts.", "ArchitectAgent", common)
    ];
  }
  if (perspective === "risk_first") {
    return [
      task("Inspect safety constraints", "Confirm the multi-plan layer cannot edit files, create patches, or launch write-capable workers.", "RiskAnalyzerAgent", [], common, "Protects read-only scope."),
      task("Define approval and rollback path", "Record approval needs, blocked dependencies, and repair path before any future executor use.", "ReviewerAgent", [], common, "Makes risks auditable."),
      ...evidenceTask("Triage evidence-backed risks", evidenceBundle, ["provider_risk_analyst_output", "provider_reviewer_output", "provider_specialist_output"], "Preserve risks, blockers, and reviewer concerns from read-only evidence.", "RiskAnalyzerAgent", common)
    ];
  }
  if (perspective === "test_first") {
    return [
      task("Specify proof strategy", "Define model, trigger, generation, evaluation, merge, artifact, metadata, trace, and orchestrator tests.", "TesterAgent", [], common, "Proves success before execution behavior changes."),
      task("Select regression commands", "Select available test, typecheck, lint, build, and smoke commands for validation.", "TesterAgent", [], common, "Keeps validation concrete."),
      ...evidenceTask("Apply tester planner evidence", evidenceBundle, ["provider_tester_planner_output"], "Use tester planner recommendations as validation strategy input, without marking validation passed.", "TesterAgent", common)
    ];
  }
  return [
    task("Reuse existing components", "Use existing artifact, metadata, trace, staffing, and task graph primitives for the fastest safe planning path.", "PlannerAgent", [], common, `Avoids unnecessary recursion.${evidenceBundle?.items.length ? " Scout and planner evidence inform the reusable surface." : ""}`),
    task("Minimize touched surface", "Keep task graph behavior compatible and store merged plan as advisory context.", "ArchitectAgent", [], common, "Reduces file touch count.")
  ];
}

function task(
  title: string,
  objective: string,
  roleHint: string,
  dependencies: string[],
  common: { read_only: boolean; allowed_write_paths: string[]; proposed_files: string[]; validation_refs: string[] },
  rationale: string
): PlanningTaskDraft {
  return {
    id: `draft_${randomUUID().slice(0, 8)}`,
    title,
    objective,
    role_hint: roleHint,
    read_only: common.read_only,
    proposed_files: common.proposed_files,
    allowed_write_paths: common.allowed_write_paths,
    dependencies,
    validation_refs: common.validation_refs,
    rationale
  };
}

function evidenceTask(
  title: string,
  bundle: PlanningEvidenceBundle | undefined,
  sourceTypes: PlanningEvidenceSourceType[],
  objective: string,
  roleHint: string,
  common: { read_only: boolean; allowed_write_paths: string[]; proposed_files: string[]; validation_refs: string[] }
): PlanningTaskDraft[] {
  const matching = bundle?.items.filter((item) => sourceTypes.includes(item.source_type)) ?? [];
  if (!matching.length) return [];
  return [task(
    title,
    `${objective} Evidence refs: ${matching.map((item) => item.evidence_id).join(", ")}.`,
    roleHint,
    [],
    common,
    `Evidence-backed advisory task from ${uniqueStrings(matching.map((item) => item.source_role ?? item.source_type)).join(", ")}.`
  )];
}

function validationStrategy(input: MultiPlanInput, context: MultiPlanEvaluationContext, perspective: PlanPerspective): PlanningValidationStrategy {
  const required = context.validation_commands.slice(0, perspective === "test_first" ? 4 : 2);
  const optional = context.validation_commands.slice(required.length, 5);
  const evidenceValidation = uniqueStrings(context.evidence_bundle?.items.flatMap((item) => item.extracted_validation_recommendations) ?? []);
  return {
    required_commands: required,
    optional_commands: optional,
    smoke_checks: [
      "Confirm generated plan artifacts are under .agent_memory/runs/<run_id>/plans.",
      "Confirm no patch or source modification artifact is produced by multi-plan generation.",
      ...(perspective === "test_first" ? ["Confirm trace reconstruction includes multi-plan planning chain."] : []),
      ...(perspective === "test_first" ? evidenceValidation.filter((entry) => !looksLikeValidationCommand(entry)).slice(0, 4) : [])
    ],
    manual_checks: [
      "Review merged plan before using it to influence future execution stages.",
      ...(context.trigger.inferred_risk === "high" || context.trigger.inferred_risk === "critical"
        ? ["Require operator approval before any later write-capable execution path expands from the plan."]
        : [])
    ],
    success_criteria: [
      "Five required perspectives are generated.",
      "Each variant is scored deterministically.",
      "Merged plan deduplicates task drafts and preserves validation guidance.",
      "SQLite stores metadata only, not full plan text.",
      "Existing single-plan task graph behavior remains available."
    ],
    validation_risk: input.commandInventory ? "medium" : "high"
  };
}

function dependenciesFor(input: MultiPlanInput, validation: PlanningValidationStrategy): PlanningDependency[] {
  const deps: PlanningDependency[] = [];
  deps.push({
    id: `dep_${randomUUID().slice(0, 8)}`,
    summary: input.repoIndex ? "Fresh repository index is available for planning signals." : "Repository index may be unavailable; heuristic context is used.",
    dependency_type: "repo_context",
    required: false,
    evidence_refs: input.repoIndex ? ["repo_index"] : []
  });
  for (const command of validation.required_commands) {
    deps.push({
      id: `dep_${randomUUID().slice(0, 8)}`,
      summary: `Validation command available: ${command}`,
      dependency_type: "command",
      required: true,
      evidence_refs: ["command_inventory"]
    });
  }
  return deps;
}

function risksFor(input: MultiPlanInput, context: MultiPlanEvaluationContext, perspective: PlanPerspective): PlanningRisk[] {
  const risks: PlanningRisk[] = [
    {
      id: `risk_${randomUUID().slice(0, 8)}`,
      summary: "Merged plan is advisory and must not authorize new write-capable execution by itself.",
      severity: "high",
      affected_domains: ["orchestration", "task_graph"],
      mitigation: "Keep existing task graph behavior as fallback and record read-only limits in artifacts.",
      approval_required: false
    }
  ];
  if (!input.repoIndex) {
    risks.push({
      id: `risk_${randomUUID().slice(0, 8)}`,
      summary: "Repository context is incomplete; planning confidence is reduced.",
      severity: "medium",
      affected_domains: ["context"],
      mitigation: "Record assumptions and use conservative tasks until repo signals are available.",
      approval_required: false
    });
  }
  if (context.trigger.inferred_risk === "high" || context.trigger.inferred_risk === "critical" || perspective === "risk_first") {
    risks.push({
      id: `risk_${randomUUID().slice(0, 8)}`,
      summary: "Validation, metadata, or trace contract changes can regress auditability.",
      severity: context.trigger.inferred_risk === "critical" ? "critical" : "high",
      affected_domains: ["metadata", "trace", "validation"],
      mitigation: "Persist artifacts first, store only metadata in SQLite, and run focused regression tests.",
      approval_required: context.trigger.inferred_risk === "critical"
    });
  }
  for (const risk of evidenceRisks(context.evidence_bundle).slice(0, perspective === "risk_first" ? 6 : 3)) {
    risks.push({
      id: `risk_${randomUUID().slice(0, 8)}`,
      summary: `Evidence-backed risk: ${risk.summary}`,
      severity: risk.severity,
      affected_domains: risk.affected_domains,
      mitigation: "Preserve evidence ref in the merged plan and require explicit validation or review before any future write path.",
      approval_required: risk.severity === "critical",
    });
  }
  return risks;
}

function assumptions(input: MultiPlanInput, context: MultiPlanEvaluationContext): PlanningAssumption[] {
  return [
    {
      id: `assumption_${randomUUID().slice(0, 8)}`,
      statement: input.structuredRequest ? "Structured request data is available." : "Structured request data is unavailable; raw user request is the primary objective source.",
      confidence: input.structuredRequest ? "high" : "medium",
      evidence_refs: input.structuredRequest ? ["structured_request"] : ["run.user_request"]
    },
    {
      id: `assumption_${randomUUID().slice(0, 8)}`,
      statement: context.high_signal_files.length ? "Relevant files can be inferred from repository signals." : "Relevant files are not confidently known yet.",
      confidence: context.high_signal_files.length ? "medium" : "low",
      evidence_refs: context.high_signal_files
    },
    {
      id: `assumption_${randomUUID().slice(0, 8)}`,
      statement: context.evidence_bundle?.items.length
        ? "Read-only swarm evidence is advisory and must be cross-checked against repository facts."
        : "No read-only swarm evidence was available; deterministic planning signals are the fallback.",
      confidence: context.evidence_bundle?.items.length ? "medium" : "high",
      evidence_refs: context.evidence_bundle?.items.map((item) => item.evidence_id) ?? []
    }
  ];
}

function unknownsFor(input: MultiPlanInput, context: MultiPlanEvaluationContext, perspective: PlanPerspective) {
  const unknowns: string[] = [];
  if (!input.contextPack) unknowns.push("No context pack output was provided to the multi-plan factory.");
  if (!input.staffingPlan) unknowns.push("No SwarmStaffingPlanner signal was provided; heuristic complexity was used.");
  unknowns.push(...(context.evidence_bundle?.limitations ?? []));
  if (perspective === "architecture_first") unknowns.push("Future public API consumers of merged plans are not fully known.");
  if (perspective === "risk_first") unknowns.push("Human approval needs depend on later execution configuration.");
  return uniqueStrings(unknowns);
}

function agentsFor(perspective: PlanPerspective, input: MultiPlanInput) {
  const agents = {
    mvp_first: ["PlannerAgent", "ScoutAgent"],
    architecture_first: ["ArchitectAgent", "PlannerAgent", "ReviewerAgent"],
    risk_first: ["RiskAnalyzerAgent", "ReviewerAgent", "TesterAgent"],
    test_first: ["TesterAgent", "ReviewerAgent"],
    speed_first: ["PlannerAgent", "ArchitectAgent"]
  } satisfies Record<PlanPerspective, string[]>;
  return uniqueStrings([
    ...agents[perspective],
    ...Object.entries(input.staffingPlan?.role_counts ?? {})
      .filter(([, count]) => Number(count) > 0)
      .map(([role]) => role)
      .slice(0, 4)
  ]);
}

function limitsFor(perspective: PlanPerspective, input: MultiPlanInput, context: MultiPlanEvaluationContext) {
  return {
    read_only: true,
    max_plan_tasks: perspective === "architecture_first" ? 5 : 3,
    max_files_to_touch: 0,
    write_capable_executor_tasks_created: false,
    suggested_executor_cap_for_future: input.staffingPlan?.executor_limit ?? (context.trigger.inferred_risk === "high" ? 1 : 2)
  };
}

function confidenceFor(input: MultiPlanInput, context: MultiPlanEvaluationContext, perspective: PlanPerspective) {
  let confidence = context.trigger.confidence;
  if (input.repoIndex) confidence += 0.06;
  if (input.commandInventory) confidence += 0.04;
  if (input.contextPack) confidence += 0.04;
  if (perspective === "risk_first" && context.trigger.inferred_risk !== "low") confidence += 0.04;
  if (!input.staffingPlan) confidence -= 0.04;
  return round(Math.max(0.35, Math.min(0.95, confidence)));
}

function selectValidationCommands(commandInventory?: CommandInventory) {
  if (!commandInventory) return [];
  return uniqueStrings([
    ...commandInventory.byKind.test,
    ...commandInventory.byKind.typecheck,
    ...commandInventory.byKind.lint,
    ...commandInventory.byKind.build,
    ...commandInventory.byKind.smoke
  ]).slice(0, 6);
}

function selectHighSignalFiles(request: string, repoIndex?: RepoIndex) {
  if (!repoIndex) return [];
  const normalized = request.toLowerCase();
  const direct = [
    ...repoIndex.sourceFiles,
    ...repoIndex.testFiles,
    ...repoIndex.configFiles,
    ...repoIndex.docFiles
  ].filter((file) => normalized.includes(file.toLowerCase()) || normalized.includes(path.basename(file).toLowerCase()));
  return uniqueStrings([
    ...direct,
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.configFiles
  ]).slice(0, 10);
}

function proposedDomains(input: MultiPlanInput) {
  const request = objectiveText(input).toLowerCase();
  const domains = ["planning", "orchestration"];
  if (matches(request, ["metadata", "sqlite"])) domains.push("metadata");
  if (matches(request, ["trace", "event"])) domains.push("trace");
  if (matches(request, ["artifact", "report"])) domains.push("artifacts");
  if (matches(request, ["test", "validation", "typecheck"])) domains.push("validation");
  if (matches(request, ["swarm", "staffing"])) domains.push("swarm");
  if (input.planningEvidence?.items.some((item) => item.source_type.includes("tester"))) domains.push("validation");
  if (input.planningEvidence?.items.some((item) => item.source_type.includes("risk"))) domains.push("risk");
  return uniqueStrings(domains);
}

function riskSignals(input: MultiPlanInput, files: string[], validationCommands: string[]) {
  const request = objectiveText(input).toLowerCase();
  const signals: string[] = [];
  if (matches(request, ["metadata", "sqlite", "state machine"])) signals.push("metadata");
  if (matches(request, ["validation", "test", "typecheck"]) || validationCommands.length === 0) signals.push("validation");
  if (matches(request, ["trace", "audit"])) signals.push("trace");
  if (files.some((file) => /package-lock|package\.json|schema|migration|config/i.test(file))) signals.push("sensitive_files");
  return signals;
}

function evidenceFiles(bundle?: PlanningEvidenceBundle) {
  return uniqueStrings(bundle?.items.flatMap((item) => item.extracted_dependencies.filter((entry) => /[./\\]/.test(entry))) ?? []);
}

function evidenceRisks(bundle?: PlanningEvidenceBundle): Array<{ summary: string; severity: PlanningRisk["severity"]; affected_domains: string[] }> {
  if (!bundle) return [];
  return bundle.items.flatMap((item) => item.extracted_risks.map((risk) => ({
    summary: `${risk} (${item.source_role ?? item.source_type}; ${item.evidence_id})`,
    severity: /critical/i.test(risk) ? "critical" as const : /high|block|unsafe|approval/i.test(risk) ? "high" as const : "medium" as const,
    affected_domains: uniqueStrings([
      item.source_type.includes("risk") ? "risk" : "",
      item.source_type.includes("tester") ? "validation" : "",
      ...item.extracted_dependencies.filter((entry) => !looksLikeValidationCommand(entry)).slice(0, 3)
    ]).length ? uniqueStrings([
      item.source_type.includes("risk") ? "risk" : "",
      item.source_type.includes("tester") ? "validation" : "",
      ...item.extracted_dependencies.filter((entry) => !looksLikeValidationCommand(entry)).slice(0, 3)
    ]) : ["planning_evidence"]
  })));
}

function evidenceRefsForPerspective(bundle: PlanningEvidenceBundle | undefined, perspective: PlanPerspective) {
  if (!bundle) return [];
  const sourceByPerspective: Record<PlanPerspective, PlanningEvidenceSourceType[]> = {
    mvp_first: ["provider_scout_output", "provider_planner_output", "mock_worker_output"],
    architecture_first: ["provider_planner_output", "provider_specialist_output", "provider_reviewer_output"],
    risk_first: ["provider_risk_analyst_output", "provider_reviewer_output", "provider_specialist_output", "prior_failure"],
    test_first: ["provider_tester_planner_output", "validation_history", "provider_reviewer_output"],
    speed_first: ["provider_scout_output", "provider_planner_output", "deterministic_context", "repo_index"]
  };
  return bundle.items
    .filter((item) => sourceByPerspective[perspective].includes(item.source_type))
    .map((item) => item.evidence_id);
}

function evidenceNotesForPerspective(bundle: PlanningEvidenceBundle | undefined, perspective: PlanPerspective) {
  if (!bundle?.items.length) return ["No provider-backed evidence was available; deterministic/heuristic planning fallback used."];
  const refs = new Set(evidenceRefsForPerspective(bundle, perspective));
  return bundle.items
    .filter((item) => refs.has(item.evidence_id))
    .slice(0, 4)
    .map((item) => `${item.source_type} from ${item.source_role ?? "unknown role"}: ${item.summary}`);
}

function evidenceItemsForPlan(plan: PlanVariant, bundle?: PlanningEvidenceBundle) {
  return evidenceItemsFromRefs(bundle, plan.evidence_item_refs ?? []);
}

function evidenceItemsFromRefs(bundle: PlanningEvidenceBundle | undefined, refs: string[]) {
  if (!bundle || !refs.length) return [];
  const refSet = new Set(refs);
  return bundle.items.filter((item) => refSet.has(item.evidence_id));
}

function looksLikeValidationCommand(value: string) {
  return /\b(npm|pnpm|yarn|node|tsc|vitest|jest|pytest|cargo|eslint)\b/.test(value);
}

function titleFor(perspective: PlanPerspective) {
  return {
    mvp_first: "MVP-first read-only plan",
    architecture_first: "Architecture-first read-only plan",
    risk_first: "Risk-first read-only plan",
    test_first: "Test-first read-only plan",
    speed_first: "Speed-first read-only plan"
  }[perspective];
}

function summaryFor(perspective: PlanPerspective, objective: string) {
  return {
    mvp_first: `Smallest useful implementation path for ${objective}; prioritize immediate user value and minimal safe scope.`,
    architecture_first: `Architecture-led plan for ${objective}; preserve module boundaries, contracts, extensibility, and integration safety.`,
    risk_first: `Risk-led plan for ${objective}; surface safety, validation gaps, blockers, rollback path, and approvals.`,
    test_first: `Test-led plan for ${objective}; define validation, smoke checks, typecheck/lint/build proof, and success criteria.`,
    speed_first: `Fastest safe plan for ${objective}; reuse current components, avoid recursion, and minimize touched surface.`
  }[perspective];
}

function objectiveText(input: MultiPlanInput) {
  return input.taskObjective ?? input.rawUserRequest ?? input.run.user_request;
}

function planningRiskFromSwarm(value: string): MultiPlanTriggerDecision["inferred_risk"] {
  if (value === "critical") return "critical";
  if (value === "high") return "high";
  if (value === "medium") return "medium";
  return "low";
}

function skipped(
  reason: string,
  complexity: MultiPlanTriggerDecision["inferred_complexity"],
  risk: MultiPlanTriggerDecision["inferred_risk"],
  confidence: number
): MultiPlanTriggerDecision {
  return {
    use_multi_plan: false,
    reason,
    inferred_complexity: complexity,
    inferred_risk: risk,
    confidence
  };
}

function matches(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
