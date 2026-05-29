import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import type {
  AgentTeam,
  AgentTeamHierarchy,
  TeamContextScope,
  TeamContextSummary,
  TeamScopedMemoryQuery
} from "./AgentTeamModels.js";
import type {
  AgentInvocation,
  ContextPack,
  ContextPackInclusionRecord,
  FinalRunReport,
  OrchestratorEvent,
  Run,
  RunCheckpoint,
  RunMetrics,
  Task
} from "./OrchestrationModels.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import {
  createPromptArtifact,
  type PromptArtifactMetadata,
  type PromptRenderError,
  type RenderedPrompt
} from "./PromptSystem.js";
import type { PromptQualityResult } from "./PromptQualityGate.js";
import type { RunTransitionRecord } from "./RunStateMachine.js";
import type {
  MergedPlan,
  MultiPlanEvaluationContext,
  MultiPlanSummary,
  PlanEvaluation,
  PlanVariant,
  PlanningEvidenceBundle
} from "./MultiPlanModels.js";
import type { TeamSubPlan, TeamSubPlanAggregation, TeamSubPlanSummary } from "./TeamSubPlanningModels.js";
import type {
  AdoptedTaskProposal,
  TaskAdoptionDecision,
  TaskReadinessProfile,
  TeamTaskAdoptionRequest,
  TeamTaskAdoptionResult
} from "./TeamTaskAdoptionModels.js";
import type {
  ProposedTaskGraph,
  ProposedTaskGraphSummary,
  ProposedTaskGraphValidationResult
} from "./ProposedTaskGraphModels.js";
import type {
  ExecutionReadinessBatch,
  ExecutionReadinessDecision,
  HumanApprovalRequirement
} from "./ExecutionReadinessModels.js";
import type {
  ExecutionPromotionRequest,
  HumanApprovalRecord,
  PromotionQueueItem,
  PromotionQueueSummary
} from "./ExecutionApprovalModels.js";
import type {
  ExecutionPreparationBatch,
  ExecutionPreparationPlan,
  ExecutionPreparationSummary
} from "./ExecutionPreparationModels.js";
import type {
  OneWriterDryRunBatch,
  OneWriterDryRunProposal,
  OneWriterDryRunProviderInput
} from "./OneWriterDryRunModels.js";
import type {
  PatchProposal,
  PatchProposalScopeCheck,
  PatchProposalSummary
} from "./PatchProposalModels.js";
import type {
  PatchProposalReview,
  PatchProposalReviewBatch,
  PatchProposalReviewProviderInput,
  PatchProposalReviewSummary
} from "./PatchProposalReviewModels.js";
import type {
  ValidationCandidate,
  ValidationCandidateBatch,
  ValidationCandidateSummary,
  ValidationPreflightResult
} from "./ValidationCandidateModels.js";
import type {
  PatchApplySandboxRequest,
  PatchApplySandboxResult,
  PatchSandboxBatch,
  PatchSandboxSummary
} from "./PatchApplySandboxModels.js";
import type {
  SandboxValidationBatch,
  SandboxValidationRequest,
  SandboxValidationResult,
  SandboxValidationSummary
} from "./SandboxValidationModels.js";
import type {
  IntegrationCandidateBatch,
  IntegrationCandidateCreationRequest,
  IntegrationCandidateSummary,
  IntegrationRollbackRequirements,
  PostIntegrationValidationPlan,
  SandboxValidatedIntegrationCandidate
} from "./SandboxIntegrationCandidateModels.js";
import type {
  IntegrationApplyApproval,
  IntegrationApplyApprovalBatch,
  IntegrationApplyApprovalSummary,
  WorktreeSafetyCheck
} from "./IntegrationApplyApprovalModels.js";
import type { ValidationPlanDraft } from "./ValidationPreflightChecker.js";

export type RunArtifactPaths = {
  runDir: string;
  run: string;
  tasks: string;
  events: string;
  contextPacksDir: string;
  promptsDir: string;
  promptQualityDir: string;
  invocationsDir: string;
  rawOutputsDir: string;
  parsedOutputsDir: string;
  reportsDir: string;
  patchesDir: string;
  reviewsDir: string;
  validationDir: string;
  integrationDir: string;
  repairsDir: string;
  locksDir: string;
  checkpointsDir: string;
  metricsDir: string;
  plansDir: string;
  planningEvidenceDir: string;
  teamsDir: string;
  teamSubPlansDir: string;
  teamTaskAdoptionDir: string;
  proposedTaskGraphDir: string;
  executionReadinessDir: string;
  executionApprovalsDir: string;
  executionPreparationDir: string;
  dryRunWritersDir: string;
  patchReviewsDir: string;
  validationCandidatesDir: string;
  patchApplySandboxDir: string;
  sandboxValidationDir: string;
  sandboxIntegrationCandidatesDir: string;
  integrationApplyApprovalsDir: string;
  controlledIntegrationApplyDir: string;
  integrationFinalizationDir: string;
};

export class OrchestrationArtifactStore {
  private readonly metadata: FactoryMetadataAdapter;
  private readonly traceWriter: FactoryTraceWriter;

  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {
    this.metadata = new FactoryMetadataAdapter(workspacePath, memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath, memoryDir, sourceComponent: "OrchestrationArtifactStore" });
  }

  async pathsForRun(runId: string): Promise<RunArtifactPaths> {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const runDir = path.join(memory.runsDir, runId);
    return {
      runDir,
      run: path.join(runDir, "run.json"),
      tasks: path.join(runDir, "tasks.json"),
      events: path.join(runDir, "events.jsonl"),
      contextPacksDir: path.join(runDir, "context_packs"),
      promptsDir: path.join(runDir, "prompts"),
      promptQualityDir: path.join(runDir, "prompt_quality"),
      invocationsDir: path.join(runDir, "invocations"),
      rawOutputsDir: path.join(runDir, "raw_outputs"),
      parsedOutputsDir: path.join(runDir, "parsed_outputs"),
      reportsDir: path.join(runDir, "reports"),
      patchesDir: path.join(runDir, "patches"),
      reviewsDir: path.join(runDir, "reviews"),
      validationDir: path.join(runDir, "validation"),
      integrationDir: path.join(runDir, "integration"),
      repairsDir: path.join(runDir, "repairs"),
      locksDir: path.join(runDir, "locks"),
      checkpointsDir: path.join(runDir, "checkpoints"),
      metricsDir: path.join(runDir, "metrics"),
      plansDir: path.join(runDir, "plans"),
      planningEvidenceDir: path.join(runDir, "planning_evidence"),
      teamsDir: path.join(runDir, "teams"),
      teamSubPlansDir: path.join(runDir, "teams", "sub_plans"),
      teamTaskAdoptionDir: path.join(runDir, "teams", "task_adoption"),
      proposedTaskGraphDir: path.join(runDir, "task_graph", "proposed"),
      executionReadinessDir: path.join(runDir, "execution_readiness"),
      executionApprovalsDir: path.join(runDir, "execution_approvals"),
      executionPreparationDir: path.join(runDir, "execution_preparation"),
      dryRunWritersDir: path.join(runDir, "dry_run_writers"),
      patchReviewsDir: path.join(runDir, "patch_reviews"),
      validationCandidatesDir: path.join(runDir, "validation_candidates"),
      patchApplySandboxDir: path.join(runDir, "patch_apply_sandbox"),
      sandboxValidationDir: path.join(runDir, "sandbox_validation"),
      sandboxIntegrationCandidatesDir: path.join(runDir, "integration_candidates"),
      integrationApplyApprovalsDir: path.join(runDir, "integration_apply_approvals"),
      controlledIntegrationApplyDir: path.join(runDir, "controlled_integration_apply"),
      integrationFinalizationDir: path.join(runDir, "integration_finalization")
    };
  }

  async ensureRunLayout(runId: string) {
    const paths = await this.pathsForRun(runId);
    await mkdir(paths.contextPacksDir, { recursive: true });
    await mkdir(paths.promptsDir, { recursive: true });
    await mkdir(paths.promptQualityDir, { recursive: true });
    await mkdir(paths.invocationsDir, { recursive: true });
    await mkdir(paths.rawOutputsDir, { recursive: true });
    await mkdir(paths.parsedOutputsDir, { recursive: true });
    await mkdir(paths.reportsDir, { recursive: true });
    await mkdir(paths.patchesDir, { recursive: true });
    await mkdir(paths.reviewsDir, { recursive: true });
    await mkdir(paths.validationDir, { recursive: true });
    await mkdir(paths.integrationDir, { recursive: true });
    await mkdir(paths.repairsDir, { recursive: true });
    await mkdir(paths.locksDir, { recursive: true });
    await mkdir(paths.checkpointsDir, { recursive: true });
    await mkdir(paths.metricsDir, { recursive: true });
    await mkdir(paths.plansDir, { recursive: true });
    await mkdir(paths.planningEvidenceDir, { recursive: true });
    await mkdir(paths.teamsDir, { recursive: true });
    await mkdir(paths.teamSubPlansDir, { recursive: true });
    await mkdir(paths.teamTaskAdoptionDir, { recursive: true });
    await mkdir(paths.proposedTaskGraphDir, { recursive: true });
    await mkdir(paths.executionReadinessDir, { recursive: true });
    await mkdir(paths.executionApprovalsDir, { recursive: true });
    await mkdir(paths.executionPreparationDir, { recursive: true });
    await mkdir(paths.dryRunWritersDir, { recursive: true });
    await mkdir(paths.patchReviewsDir, { recursive: true });
    await mkdir(paths.validationCandidatesDir, { recursive: true });
    await mkdir(paths.patchApplySandboxDir, { recursive: true });
    await mkdir(paths.sandboxValidationDir, { recursive: true });
    await mkdir(paths.sandboxIntegrationCandidatesDir, { recursive: true });
    await mkdir(paths.integrationApplyApprovalsDir, { recursive: true });
    await mkdir(paths.controlledIntegrationApplyDir, { recursive: true });
    await mkdir(paths.integrationFinalizationDir, { recursive: true });
    return paths;
  }

  async saveRun(run: Run) {
    const paths = await this.ensureRunLayout(run.id);
    await writeJson(paths.run, run);
    await this.metadata.recordRunSaved(run, paths.run);
    return paths.run;
  }

  async loadRun(runId: string): Promise<Run> {
    const paths = await this.pathsForRun(runId);
    return readJson<Run>(paths.run);
  }

  async savePlanVariant(variant: PlanVariant): Promise<PlanVariant> {
    const paths = await this.ensureRunLayout(variant.run_id);
    const filePath = path.join(paths.plansDir, `plan_variant_${variant.perspective}_${variant.plan_id}.json`);
    const persisted = { ...variant, artifact_ref: filePath };
    await writeJson(filePath, persisted);
    await this.metadata.recordPlanVariantSaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: variant.run_id,
      taskId: variant.task_id,
      kind: "plan_variant",
      artifactRef: filePath,
      status: "created",
      createdAt: variant.created_at,
      updatedAt: variant.created_at,
      metadata: {
        plan_id: variant.plan_id,
        perspective: variant.perspective,
        generation_mode: variant.generation_mode,
        confidence: variant.confidence
      }
    });
    return persisted;
  }

  async savePlanEvaluations(runId: string, evaluations: PlanEvaluation[], context: MultiPlanEvaluationContext): Promise<string> {
    const paths = await this.ensureRunLayout(runId);
    const id = `eval_${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const filePath = path.join(paths.plansDir, `plan_evaluation_${id}.json`);
    await writeJson(filePath, {
      artifact_kind: "plan_evaluation",
      run_id: runId,
      generation_mode: context.generation_mode,
      trigger: context.trigger,
      evaluations: evaluations.map((evaluation) => ({ ...evaluation, artifact_ref: filePath }))
    });
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "plan_evaluation",
      artifactRef: filePath,
      status: "evaluated",
      metadata: {
        evaluation_count: evaluations.length,
        generation_mode: context.generation_mode
      }
    });
    return filePath;
  }

  async recordPlanEvaluation(evaluation: PlanEvaluation) {
    await this.metadata.recordPlanEvaluationSaved(evaluation);
  }

  async saveMergedPlan(mergedPlan: MergedPlan): Promise<MergedPlan> {
    const paths = await this.ensureRunLayout(mergedPlan.run_id);
    const filePath = path.join(paths.plansDir, `merged_plan_${mergedPlan.merged_plan_id}.json`);
    const persisted = { ...mergedPlan, artifact_ref: filePath };
    await writeJson(filePath, persisted);
    await this.metadata.recordMergedPlanSaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: mergedPlan.run_id,
      taskId: mergedPlan.task_id,
      kind: "merged_plan",
      artifactRef: filePath,
      status: "merged",
      createdAt: mergedPlan.created_at,
      updatedAt: mergedPlan.created_at,
      metadata: {
        merged_plan_id: mergedPlan.merged_plan_id,
        selected_plan_count: mergedPlan.selected_plan_ids.length,
        rejected_plan_count: mergedPlan.rejected_plan_ids.length,
        confidence: mergedPlan.confidence
      }
    });
    return persisted;
  }

  async savePlanningSummary(runId: string, summary: MultiPlanSummary, mergedPlan: MergedPlan, evaluations: PlanEvaluation[]): Promise<string> {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.plansDir, `planning_summary_${mergedPlan.merged_plan_id}.md`);
    const text = [
      "# Multi-Plan Planning Summary",
      "",
      `- multi_plan_used: ${summary.multi_plan_used}`,
      `- generation_mode: ${summary.generation_mode ?? "n/a"}`,
      `- plan_variant_count: ${summary.plan_variant_count}`,
      `- selected_perspectives: ${summary.selected_perspectives.join(", ") || "none"}`,
      `- rejected_perspectives: ${summary.rejected_perspectives.join(", ") || "none"}`,
      `- confidence: ${summary.confidence}`,
      `- merged_plan_ref: ${mergedPlan.artifact_ref}`,
      "",
      "## Merge Rationale",
      ...mergedPlan.merge_rationale.map((entry) => `- ${entry}`),
      "",
      "## Top Risks",
      ...(summary.top_risks.length ? summary.top_risks.map((risk) => `- ${risk}`) : ["- none recorded"]),
      "",
      "## Unresolved Questions",
      ...(summary.unresolved_questions.length ? summary.unresolved_questions.map((question) => `- ${question}`) : ["- none recorded"]),
      "",
      "## Recommended Next Step",
      summary.recommended_next_step,
      "",
      "## Evidence",
      `- evidence_used: ${summary.evidence_used ?? false}`,
      `- evidence_item_count: ${summary.evidence_item_count ?? 0}`,
      `- provider_evidence_count: ${summary.provider_evidence_count ?? 0}`,
      `- evidence_bundle_ref: ${summary.evidence_bundle_ref ?? "n/a"}`,
      ...(summary.evidence_limitations?.length ? summary.evidence_limitations.map((entry) => `- limitation: ${entry}`) : []),
      "",
      "## Evaluation Scores",
      ...evaluations.map((evaluation) => `- ${evaluation.perspective}: selected=${evaluation.selected}; confidence=${evaluation.confidence}; safety=${evaluation.scores.safety}; testability=${evaluation.scores.testability}`)
    ].join("\n");
    await writeFile(filePath, text, "utf8");
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "planning_summary",
      artifactRef: filePath,
      status: "written",
      metadata: {
        merged_plan_id: mergedPlan.merged_plan_id,
        plan_variant_count: summary.plan_variant_count
      }
    });
    return filePath;
  }

  async savePlanningEvidenceBundle(bundle: PlanningEvidenceBundle): Promise<PlanningEvidenceBundle> {
    const paths = await this.ensureRunLayout(bundle.run_id);
    const bundlePath = path.join(paths.planningEvidenceDir, `evidence_bundle_${bundle.evidence_bundle_id}.json`);
    const summaryPath = path.join(paths.planningEvidenceDir, `evidence_summary_${bundle.evidence_bundle_id}.md`);
    const persisted: PlanningEvidenceBundle = {
      ...bundle,
      artifact_ref: bundlePath,
      summary_ref: summaryPath,
      summary: {
        ...bundle.summary,
        evidence_bundle_ref: bundlePath
      }
    };
    await writeJson(bundlePath, persisted);
    const text = [
      "# Planning Evidence Summary",
      "",
      `- evidence_used: ${persisted.summary.evidence_used}`,
      `- evidence_item_count: ${persisted.summary.evidence_item_count}`,
      `- provider_evidence_count: ${persisted.summary.provider_evidence_count}`,
      `- mock_evidence_count: ${persisted.summary.mock_evidence_count}`,
      `- low_confidence_count: ${persisted.summary.low_confidence_count}`,
      `- rejected_evidence_count: ${persisted.summary.rejected_evidence_count}`,
      `- evidence_conflict_count: ${persisted.summary.evidence_conflict_count}`,
      `- evidence_bundle_ref: ${bundlePath}`,
      "",
      "## Sources",
      ...(persisted.items.length
        ? persisted.items.map((item) => `- ${item.source_type} (${item.source_role ?? "unknown role"}): ${item.summary} [${item.evidence_id}]`)
        : ["- none"]),
      "",
      "## Limitations",
      ...(persisted.limitations.length ? persisted.limitations.map((entry) => `- ${entry}`) : ["- none recorded"])
    ].join("\n");
    await writeFile(summaryPath, text, "utf8");
    for (const item of persisted.items) {
      await this.metadata.recordPlanningEvidenceSaved(item);
    }
    await this.metadata.recordArtifactSaved({
      runId: persisted.run_id,
      taskId: persisted.task_id,
      kind: "planning_evidence_bundle",
      artifactRef: bundlePath,
      status: "created",
      createdAt: persisted.created_at,
      updatedAt: persisted.created_at,
      metadata: {
        evidence_bundle_id: persisted.evidence_bundle_id,
        evidence_item_count: persisted.items.length,
        provider_evidence_count: persisted.summary.provider_evidence_count,
        rejected_evidence_count: persisted.rejected_items.length
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: persisted.run_id,
      taskId: persisted.task_id,
      kind: "planning_evidence_summary",
      artifactRef: summaryPath,
      status: "written",
      createdAt: persisted.created_at,
      updatedAt: persisted.created_at,
      metadata: {
        evidence_bundle_id: persisted.evidence_bundle_id,
        evidence_item_count: persisted.items.length
      }
    });
    return persisted;
  }

  async saveTasks(runId: string, tasks: Task[]) {
    const paths = await this.ensureRunLayout(runId);
    await writeJson(paths.tasks, tasks);
    await this.metadata.recordTasksSaved(runId, tasks, paths.tasks);
    return paths.tasks;
  }

  async loadTasks(runId: string): Promise<Task[]> {
    const paths = await this.pathsForRun(runId);
    return readJson<Task[]>(paths.tasks);
  }

  async appendEvent(event: OrchestratorEvent) {
    const paths = await this.ensureRunLayout(event.run_id);
    await appendJsonl(paths.events, event);
    await this.traceWriter.recordArtifactEvent(event, paths.events);
    return paths.events;
  }

  async saveContextPack(pack: ContextPack) {
    const paths = await this.ensureRunLayout(pack.run_id);
    const filePath = path.join(paths.contextPacksDir, `${pack.task_id}.json`);
    const packTrace = await this.traceWriter.write({
      run_id: pack.run_id,
      task_id: pack.task_id,
      event_type: "context_pack_created",
      lifecycle_stage: "executing",
      summary: `Context pack artifact written for ${pack.task_id}.`,
      artifact_refs: [filePath],
      metadata_json: {
        approximate_size: pack.approximate_size,
        relevant_file_count: pack.relevant_files.length,
        warning_count: pack.warnings.length,
        retrieval_summary: pack.retrieval_summary,
        team_id: pack.team_context?.scope.team_id,
        parent_team_id: pack.team_context?.scope.parent_team_id,
        memory_scope: pack.team_context?.scope.memory_scope,
        team_context_used: Boolean(pack.team_context)
      }
    });
    if (pack.team_context) {
      await this.traceWriter.write({
        run_id: pack.run_id,
        task_id: pack.task_id,
        team_id: pack.team_context.scope.team_id,
        event_type: "team_context_pack_created",
        lifecycle_stage: "executing",
        causal_parent_event_id: packTrace.trace_event_id,
        summary: `Team-aware context pack created for ${pack.team_context.scope.team_id}.`,
        artifact_refs: [filePath, pack.team_context.scope.artifact_ref, pack.team_context.scope.summary_ref].filter((ref): ref is string => Boolean(ref)),
        severity: pack.team_context.warnings.some((warning) => warning.severity === "blocking" || warning.severity === "warning") ? "warning" : "info",
        metadata_json: {
          run_id: pack.run_id,
          task_id: pack.task_id,
          team_id: pack.team_context.scope.team_id,
          parent_team_id: pack.team_context.scope.parent_team_id,
          memory_scope: pack.team_context.scope.memory_scope,
          team_memory_query_count: pack.team_context.memory_queries.length,
          fallback_used: pack.team_context.fallback_used,
          warning_count: pack.team_context.warnings.length
        }
      });
    }
    for (const item of pack.included_items ?? []) {
      const trace = await this.traceWriter.write({
        run_id: pack.run_id,
        task_id: pack.task_id,
        team_id: typeof item.metadata_json.team_id === "string" ? item.metadata_json.team_id : pack.team_context?.scope.team_id,
        event_type: "context_item_included",
        lifecycle_stage: "executing",
        causal_parent_event_id: packTrace.trace_event_id,
        summary: `${item.item_type} included from ${item.source_type}.`,
        reason: item.inclusion_reason,
        artifact_refs: [filePath],
        severity: item.freshness === "stale" || item.freshness === "possibly_stale" ? "warning" : "info",
        metadata_json: contextItemTraceMetadata(pack.id, item)
      });
      item.trace_event_ref = trace.trace_event_id;
      if (pack.team_context && isTeamContextItem(item)) {
        await this.traceWriter.write({
          run_id: pack.run_id,
          task_id: pack.task_id,
          team_id: pack.team_context.scope.team_id,
          event_type: "team_context_item_included",
          lifecycle_stage: "executing",
          causal_parent_event_id: trace.trace_event_id,
          summary: `Team context item included from ${item.source_type}.`,
          reason: item.inclusion_reason,
          artifact_refs: [filePath],
          severity: item.freshness === "stale" || item.freshness === "possibly_stale" ? "warning" : "info",
          metadata_json: {
            ...contextItemTraceMetadata(pack.id, item),
            parent_team_id: pack.team_context.scope.parent_team_id,
            memory_scope: pack.team_context.scope.memory_scope
          }
        });
      }
    }
    for (const item of pack.excluded_items ?? []) {
      const trace = await this.traceWriter.write({
        run_id: pack.run_id,
        task_id: pack.task_id,
        team_id: typeof item.metadata_json.team_id === "string" ? item.metadata_json.team_id : pack.team_context?.scope.team_id,
        event_type: "context_item_excluded",
        lifecycle_stage: "executing",
        causal_parent_event_id: packTrace.trace_event_id,
        summary: `${item.item_type} excluded or constrained from ${item.source_type}.`,
        reason: item.inclusion_reason,
        artifact_refs: [filePath],
        severity: "warning",
        metadata_json: contextItemTraceMetadata(pack.id, item)
      });
      item.trace_event_ref = trace.trace_event_id;
      if (pack.team_context && isTeamContextItem(item)) {
        await this.traceWriter.write({
          run_id: pack.run_id,
          task_id: pack.task_id,
          team_id: pack.team_context.scope.team_id,
          event_type: "team_context_item_excluded",
          lifecycle_stage: "executing",
          causal_parent_event_id: trace.trace_event_id,
          summary: `Team context item excluded or constrained from ${item.source_type}.`,
          reason: item.inclusion_reason,
          artifact_refs: [filePath],
          severity: "warning",
          metadata_json: {
            ...contextItemTraceMetadata(pack.id, item),
            parent_team_id: pack.team_context.scope.parent_team_id,
            memory_scope: pack.team_context.scope.memory_scope
          }
        });
      }
    }
    for (const item of pack.fallback_items ?? []) {
      await this.traceWriter.write({
        run_id: pack.run_id,
        task_id: pack.task_id,
        event_type: "context_fallback_used",
        lifecycle_stage: "executing",
        causal_parent_event_id: item.trace_event_ref ?? packTrace.trace_event_id,
        summary: `Fallback context item used for ${item.source_ref}.`,
        reason: item.inclusion_reason,
        artifact_refs: [filePath],
        severity: "warning",
        metadata_json: contextItemTraceMetadata(pack.id, item)
      });
    }
    for (const warning of pack.freshness_warnings ?? []) {
      await this.traceWriter.write({
        run_id: pack.run_id,
        task_id: pack.task_id,
        event_type: "context_freshness_warning",
        lifecycle_stage: "executing",
        causal_parent_event_id: packTrace.trace_event_id,
        summary: warning,
        reason: warning,
        artifact_refs: [filePath],
        severity: "warning",
        metadata_json: {
          context_pack_id: pack.id
        }
      });
    }
    await writeJson(filePath, pack);
    await this.metadata.recordContextPackSaved(pack, filePath);
    return filePath;
  }

  async loadContextPack(runId: string, taskId: string): Promise<ContextPack> {
    const paths = await this.pathsForRun(runId);
    return readJson<ContextPack>(path.join(paths.contextPacksDir, `${taskId}.json`));
  }

  async savePromptArtifact(rendered: RenderedPrompt): Promise<PromptArtifactMetadata> {
    const paths = await this.ensureRunLayout(rendered.run_id);
    const filePath = path.join(paths.promptsDir, `${rendered.prompt_id}.md`);
    const selectedTrace = await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_template_selected",
      lifecycle_stage: "executing",
      summary: `Prompt template selected: ${rendered.template_id}@${rendered.template_version}.`,
      artifact_refs: [rendered.context_pack_ref],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    const renderStartedTrace = await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_render_started",
      lifecycle_stage: "executing",
      causal_parent_event_id: selectedTrace.trace_event_id,
      summary: `Prompt render started for ${rendered.agent_role}.`,
      artifact_refs: [rendered.context_pack_ref],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    await writeFile(filePath, rendered.text, "utf8");
    const metadata = createPromptArtifact(rendered, filePath);
    await this.metadata.recordPromptArtifactSaved(metadata);
    await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_created",
      lifecycle_stage: "executing",
      causal_parent_event_id: renderStartedTrace.trace_event_id,
      summary: `Rendered prompt artifact created for ${rendered.agent_role}.`,
      artifact_refs: [filePath, rendered.context_pack_ref],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_rendered",
      lifecycle_stage: "executing",
      causal_parent_event_id: renderStartedTrace.trace_event_id,
      summary: `Prompt rendered for ${rendered.agent_role}.`,
      artifact_refs: [filePath, rendered.context_pack_ref],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_artifact_written",
      lifecycle_stage: "executing",
      summary: `Prompt artifact written: ${rendered.prompt_id}.`,
      artifact_refs: [filePath],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    await this.traceWriter.write({
      run_id: rendered.run_id,
      task_id: rendered.task_id,
      event_type: "prompt_metadata_recorded",
      lifecycle_stage: "metadata",
      summary: `Prompt metadata recorded: ${rendered.prompt_id}.`,
      artifact_refs: [filePath],
      metadata_json: promptTraceMetadata(rendered, filePath)
    });
    return metadata;
  }

  async recordPromptRenderFailure(error: PromptRenderError, input: { runId: string; taskId?: string; contextPackRef?: string }) {
    await this.traceWriter.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: "prompt_render_failed",
      lifecycle_stage: "executing",
      severity: "error",
      summary: error.message,
      reason: error.message,
      artifact_refs: input.contextPackRef ? [input.contextPackRef] : [],
      metadata_json: {
        template_id: error.template_id,
        template_version: error.template_version,
        missing_fields: error.missing_fields ?? [],
        code: error.code
      }
    });
  }

  async savePromptQualityResult(result: PromptQualityResult): Promise<string> {
    const paths = await this.ensureRunLayout(result.run_id);
    const filePath = path.join(paths.promptQualityDir, `${result.prompt_id}.json`);
    const started = await this.traceWriter.write({
      run_id: result.run_id,
      task_id: result.task_id,
      event_type: "prompt_quality_started",
      lifecycle_stage: "executing",
      summary: `Prompt quality gate started for ${result.prompt_id}.`,
      artifact_refs: result.checked_metadata.prompt_artifact_ref ? [String(result.checked_metadata.prompt_artifact_ref)] : [],
      metadata_json: promptQualityTraceMetadata(result, filePath)
    });
    result.artifact_ref = filePath;
    await writeJson(filePath, result);
    await this.metadata.recordPromptQualityResultSaved(result, filePath, started.trace_event_id);
    const terminalEvent = result.status === "blocked"
      ? "prompt_quality_blocked"
      : result.status === "failed"
        ? "prompt_quality_failed"
        : result.status === "warning"
          ? "prompt_quality_warning"
          : "prompt_quality_completed";
    const completed = await this.traceWriter.write({
      run_id: result.run_id,
      task_id: result.task_id,
      event_type: terminalEvent,
      lifecycle_stage: result.blocking ? "blocked" : "executing",
      causal_parent_event_id: started.trace_event_id,
      severity: result.status === "blocked" || result.status === "failed" ? "error" : result.status === "warning" ? "warning" : "info",
      summary: `Prompt quality gate ${result.status} for ${result.prompt_id}.`,
      reason: result.suggested_remediation[0],
      artifact_refs: [filePath, ...qualityArtifactRefs(result)],
      metadata_json: promptQualityTraceMetadata(result, filePath)
    });
    result.trace_event_id = completed.trace_event_id;
    await writeJson(filePath, result);
    await this.metadata.recordPromptQualityResultSaved(result, filePath, completed.trace_event_id);
    await this.traceWriter.write({
      run_id: result.run_id,
      task_id: result.task_id,
      event_type: "prompt_quality_metadata_recorded",
      lifecycle_stage: "metadata",
      causal_parent_event_id: completed.trace_event_id,
      summary: `Prompt quality metadata recorded for ${result.prompt_id}.`,
      artifact_refs: [filePath],
      metadata_json: promptQualityTraceMetadata(result, filePath)
    });
    return filePath;
  }

  async saveInvocation(invocation: AgentInvocation) {
    const paths = await this.ensureRunLayout(invocation.run_id);
    const filePath = path.join(paths.invocationsDir, `${invocation.id}.json`);
    await writeJson(filePath, invocation);
    await this.metadata.recordInvocationSaved(invocation, filePath);
    if (!invocation.finished_at && !invocation.prompt_metadata?.prompt_artifact_ref) {
      await this.traceWriter.write({
        run_id: invocation.run_id,
        task_id: invocation.task_id,
        event_type: "prompt_created",
        lifecycle_stage: "executing",
        summary: `Invocation prompt saved for ${invocation.task_id}.`,
        artifact_refs: [filePath, invocation.context_pack_ref],
        metadata_json: {
          invocation_id: invocation.id,
          role: invocation.role,
          prompt_chars: invocation.prompt.length
        }
      });
      await this.traceWriter.write({
        run_id: invocation.run_id,
        task_id: invocation.task_id,
        event_type: "prompt_rendered",
        lifecycle_stage: "executing",
        summary: `Prompt rendered for ${invocation.role}.`,
        artifact_refs: [filePath],
        metadata_json: {
          invocation_id: invocation.id,
          prompt_chars: invocation.prompt.length
        }
      });
    }
    return filePath;
  }

  async saveRawOutput(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.rawOutputsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordOutputSaved(runId, id, "raw_output", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: "raw_output_saved",
      lifecycle_stage: "executing",
      summary: `Raw output artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveParsedOutput(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.parsedOutputsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordOutputSaved(runId, id, "parsed_output", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: "parsed_output_saved",
      lifecycle_stage: "executing",
      summary: `Parsed output artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveFinalReport(report: FinalRunReport) {
    const paths = await this.ensureRunLayout(report.run_id);
    const filePath = path.join(paths.reportsDir, "final_report.json");
    await writeJson(filePath, report);
    await this.metadata.recordFinalReportSaved(report, filePath);
    await this.traceWriter.write({
      run_id: report.run_id,
      event_type: "report_completed",
      lifecycle_stage: "reporting",
      next_status: report.status,
      summary: "Final run report artifact written.",
      artifact_refs: [filePath],
      metadata_json: {
        tasks_created: report.tasks_created,
        tasks_completed: report.tasks_completed,
        tasks_failed: report.tasks_failed,
        validation_results: report.validation_results.length
      }
    });
    return filePath;
  }

  async loadFinalReport(runId: string): Promise<FinalRunReport> {
    const paths = await this.pathsForRun(runId);
    return readJson<FinalRunReport>(path.join(paths.reportsDir, "final_report.json"));
  }

  async saveCheckpoint(checkpoint: RunCheckpoint) {
    const paths = await this.ensureRunLayout(checkpoint.run_id);
    const filePath = path.join(paths.checkpointsDir, `${checkpoint.created_at.replace(/[:.]/g, "-")}_${checkpoint.label}.json`);
    await writeJson(filePath, sanitizeForArtifact(checkpoint));
    await this.metadata.recordArtifactSaved({
      runId: checkpoint.run_id,
      kind: "checkpoint",
      artifactRef: filePath,
      status: checkpoint.run_status,
      createdAt: checkpoint.created_at,
      updatedAt: checkpoint.created_at,
      metadata: { label: checkpoint.label, task_count: checkpoint.task_graph_state.length }
    });
    await this.traceWriter.write({
      run_id: checkpoint.run_id,
      event_type: "artifact_written",
      lifecycle_stage: checkpoint.run_status,
      summary: `Checkpoint artifact written: ${checkpoint.label}.`,
      artifact_refs: [filePath],
      metadata_json: {
        artifact_kind: "checkpoint",
        label: checkpoint.label,
        task_count: checkpoint.task_graph_state.length
      }
    });
    return filePath;
  }

  async listCheckpoints(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.checkpointsDir);
  }

  async saveRunMetrics(metrics: RunMetrics) {
    const paths = await this.ensureRunLayout(metrics.run_id);
    const filePath = path.join(paths.metricsDir, "run_metrics.json");
    await writeJson(filePath, sanitizeForArtifact(metrics));
    await this.metadata.recordRunMetricsSaved(metrics, filePath);
    await this.traceWriter.write({
      run_id: metrics.run_id,
      event_type: "metadata_record_written",
      lifecycle_stage: metrics.status,
      summary: "Run metrics artifact written.",
      artifact_refs: [filePath],
      metadata_json: {
        metric_scope: "run",
        tasks_created: metrics.tasks_created,
        tasks_failed: metrics.tasks_failed
      }
    });
    return filePath;
  }

  async loadRunMetrics(runId: string): Promise<RunMetrics> {
    const paths = await this.pathsForRun(runId);
    return readJson<RunMetrics>(path.join(paths.metricsDir, "run_metrics.json"));
  }

  async savePatchArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.patchesDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordOutputSaved(runId, id, "patch", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: "patch_scope_checked",
      lifecycle_stage: "reviewing",
      summary: `Patch scope artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveReviewArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.reviewsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordReviewSaved(runId, id, filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: reviewTraceType(value),
      lifecycle_stage: "reviewing",
      summary: `Review artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveValidationArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.validationDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordValidationSaved(runId, id, "validation", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: validationTraceType(value),
      lifecycle_stage: "validating",
      summary: `Validation artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveValidationLog(runId: string, id: string, value: string) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.validationDir, `${id}.log`);
    await writeFile(filePath, redactSecrets(value), "utf8");
    await this.metadata.recordValidationSaved(runId, id, "validation_log", filePath, { status: inferValidationLogStatus(value) });
    await this.traceWriter.write({
      run_id: runId,
      task_id: inferTaskIdFromSourceId(id),
      event_type: "validation_command_completed",
      lifecycle_stage: "validating",
      summary: `Validation log artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: {
        status: inferValidationLogStatus(value),
        log_chars: value.length
      }
    });
    return filePath;
  }

  async saveIntegrationArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.integrationDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordOutputSaved(runId, id, "integration", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: integrationTraceType(value),
      lifecycle_stage: "integrating",
      summary: `Integration artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveIntegrationSummary(runId: string, id: string, value: string, metadata: Record<string, unknown> = {}) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.integrationDir, `${id}.md`);
    await writeFile(filePath, value, "utf8");
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "integration_summary",
      artifactRef: filePath,
      status: typeof metadata.status === "string" ? metadata.status : undefined,
      metadata
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "artifact_written",
      lifecycle_stage: "integrating",
      summary: `Integration summary written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: metadata
    });
    return filePath;
  }

  async saveAgentTeamArtifact(team: AgentTeam) {
    const paths = await this.ensureRunLayout(team.run_id);
    const filePath = path.join(paths.teamsDir, `team_${team.team_id}.json`);
    const persisted = { ...team, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordAgentTeamSaved({ team: persisted, artifactRef: filePath });
    await this.traceWriter.write({
      run_id: team.run_id,
      campaign_id: team.campaign_id,
      event_type: team.parent_team_id ? "agent_team_child_created" : team.team_type === "root" ? "agent_team_root_created" : "agent_team_created",
      lifecycle_stage: "planning",
      summary: `Agent team artifact written: ${team.team_id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeAgentTeam(team, filePath)
    });
    return filePath;
  }

  async saveAgentTeamHierarchy(runId: string, id: string, hierarchy: AgentTeamHierarchy) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.teamsDir, `hierarchy_${id}.json`);
    const persisted = { ...hierarchy, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "agent_team_hierarchy",
      artifactRef: filePath,
      status: "validated",
      metadata: {
        hierarchy_id: hierarchy.hierarchy_id,
        root_team_id: hierarchy.root_team_id,
        team_count: hierarchy.teams.length,
        max_depth: hierarchy.max_depth
      }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "agent_team_hierarchy_validated",
      lifecycle_stage: "planning",
      summary: `Agent team hierarchy written: ${hierarchy.teams.length} team(s).`,
      artifact_refs: [filePath],
      metadata_json: {
        hierarchy_id: hierarchy.hierarchy_id,
        root_team_id: hierarchy.root_team_id,
        team_count: hierarchy.teams.length,
        max_depth: hierarchy.max_depth,
        warnings: hierarchy.warnings
      }
    });
    return filePath;
  }

  async saveProposedAgentTeams(runId: string, id: string, teams: AgentTeam[], metadata: Record<string, unknown> = {}) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.teamsDir, `proposed_teams_${id}.json`);
    await writeJson(filePath, sanitizeForArtifact({ run_id: runId, teams, metadata_json: metadata }));
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "agent_team_proposals",
      artifactRef: filePath,
      status: "proposed",
      metadata: { team_count: teams.length, ...metadata }
    });
    return filePath;
  }

  async saveAgentTeamAssignments(runId: string, id: string, assignments: unknown, metadata: Record<string, unknown> = {}) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.teamsDir, `assignments_${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(assignments));
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "agent_team_assignments",
      artifactRef: filePath,
      status: "assigned",
      metadata
    });
    return filePath;
  }

  async saveTeamContextScope(scope: TeamContextScope) {
    const paths = await this.ensureRunLayout(scope.run_id);
    const safeTeamId = sanitizeFilePart(scope.team_id);
    const filePath = path.join(paths.teamsDir, `team_context_scope_${safeTeamId}.json`);
    const persisted = { ...scope, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordTeamContextScopeSaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: scope.run_id,
      campaignId: scope.campaign_id,
      kind: "team_context_scope",
      artifactRef: filePath,
      status: scope.warnings.some((warning) => warning.severity === "blocking") ? "warning" : "resolved",
      metadata: {
        team_context_scope_id: scope.team_context_scope_id,
        team_id: scope.team_id,
        parent_team_id: scope.parent_team_id,
        memory_scope: scope.memory_scope,
        allowed_file_count: scope.allowed_files.length,
        forbidden_file_count: scope.forbidden_files.length,
        module_lock_count: scope.module_locks.length,
        semantic_lock_count: scope.semantic_locks.length,
        evidence_ref_count: scope.evidence_refs.length,
        warning_count: scope.warnings.length
      }
    });
    return filePath;
  }

  async saveTeamContextSummary(summary: TeamContextSummary, markdown?: string) {
    const paths = await this.ensureRunLayout(summary.run_id);
    const safeTeamId = sanitizeFilePart(summary.team_id);
    const filePath = path.join(paths.teamsDir, `team_context_summary_${safeTeamId}.md`);
    await writeFile(filePath, markdown ?? teamContextSummaryMarkdown(summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: summary.run_id,
      kind: "team_context_summary",
      artifactRef: filePath,
      status: "written",
      metadata: {
        team_id: summary.team_id,
        parent_team_id: summary.parent_team_id,
        memory_scope: summary.memory_scope,
        warning_count: summary.warning_count,
        confidence: summary.confidence,
        freshness: summary.freshness
      }
    });
    return filePath;
  }

  async saveTeamMemoryQuery(query: TeamScopedMemoryQuery) {
    const paths = await this.ensureRunLayout(query.run_id);
    const filePath = path.join(paths.teamsDir, `team_memory_query_${sanitizeFilePart(query.query_id)}.json`);
    const persisted = { ...query, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordTeamMemoryQuerySaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: query.run_id,
      taskId: query.task_id,
      kind: "team_memory_query",
      artifactRef: filePath,
      status: query.fallback_used ? "fallback" : "queried",
      metadata: {
        query_id: query.query_id,
        team_id: query.team_id,
        memory_scope: query.memory_scope,
        query_type: query.query_type,
        result_count: query.result_count,
        fallback_used: query.fallback_used,
        result_ref_count: query.result_refs.length
      }
    });
    return filePath;
  }

  async saveTeamSubPlan(plan: TeamSubPlan) {
    const paths = await this.ensureRunLayout(plan.run_id);
    const filePath = path.join(paths.teamSubPlansDir, `team_sub_plan_${sanitizeFilePart(plan.team_id)}_${sanitizeFilePart(plan.sub_plan_id)}.json`);
    const persisted = { ...plan, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordTeamSubPlanSaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: plan.run_id,
      kind: "team_sub_plan",
      artifactRef: filePath,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.created_at,
      metadata: {
        sub_plan_id: plan.sub_plan_id,
        team_id: plan.team_id,
        parent_team_id: plan.parent_team_id,
        generation_mode: plan.generation_mode,
        proposed_task_count: plan.proposed_tasks.length,
        risk_count: plan.risks.length,
        read_only_recursive_planning_only: true
      }
    });
    return filePath;
  }

  async saveTeamSubPlanSummary(summary: TeamSubPlanSummary, plan: TeamSubPlan, markdown?: string) {
    const paths = await this.ensureRunLayout(plan.run_id);
    const filePath = path.join(paths.teamSubPlansDir, `team_sub_plan_summary_${sanitizeFilePart(plan.team_id)}_${sanitizeFilePart(plan.sub_plan_id)}.md`);
    await writeFile(filePath, markdown ?? teamSubPlanSummaryMarkdown(summary, plan), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: plan.run_id,
      kind: "team_sub_plan_summary",
      artifactRef: filePath,
      status: "written",
      createdAt: plan.created_at,
      updatedAt: plan.created_at,
      metadata: {
        sub_plan_id: plan.sub_plan_id,
        team_id: plan.team_id,
        status: plan.status,
        generation_mode: plan.generation_mode
      }
    });
    return filePath;
  }

  async saveTeamSubPlanAggregation(aggregation: TeamSubPlanAggregation) {
    const paths = await this.ensureRunLayout(aggregation.run_id);
    const filePath = path.join(paths.teamSubPlansDir, `sub_plan_aggregation_${sanitizeFilePart(aggregation.aggregation_id)}.json`);
    const persisted = { ...aggregation, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordTeamSubPlanAggregationSaved(persisted);
    await this.metadata.recordArtifactSaved({
      runId: aggregation.run_id,
      kind: "team_sub_plan_aggregation",
      artifactRef: filePath,
      status: aggregation.status,
      createdAt: aggregation.created_at,
      updatedAt: aggregation.created_at,
      metadata: {
        aggregation_id: aggregation.aggregation_id,
        accepted_sub_plan_count: aggregation.accepted_sub_plans.length,
        invalid_sub_plan_count: aggregation.invalid_sub_plans.length,
        cross_team_dependency_count: aggregation.cross_team_dependencies.length,
        scope_conflict_count: aggregation.scope_conflicts.length
      }
    });
    return filePath;
  }

  async saveTeamSubPlanAggregationSummary(aggregation: TeamSubPlanAggregation, markdown?: string) {
    const paths = await this.ensureRunLayout(aggregation.run_id);
    const filePath = path.join(paths.teamSubPlansDir, `sub_plan_aggregation_summary_${sanitizeFilePart(aggregation.aggregation_id)}.md`);
    await writeFile(filePath, markdown ?? teamSubPlanAggregationMarkdown(aggregation), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: aggregation.run_id,
      kind: "team_sub_plan_aggregation_summary",
      artifactRef: filePath,
      status: "written",
      createdAt: aggregation.created_at,
      updatedAt: aggregation.created_at,
      metadata: {
        aggregation_id: aggregation.aggregation_id,
        accepted_sub_plan_count: aggregation.accepted_sub_plans.length,
        invalid_sub_plan_count: aggregation.invalid_sub_plans.length
      }
    });
    return filePath;
  }

  async saveTeamTaskAdoptionRequest(request: TeamTaskAdoptionRequest) {
    const paths = await this.ensureRunLayout(request.run_id);
    const filePath = path.join(paths.teamTaskAdoptionDir, `adoption_request_${sanitizeFilePart(request.adoption_request_id)}.json`);
    const persisted = { ...request, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: request.run_id,
      kind: "team_task_adoption_request",
      artifactRef: filePath,
      status: request.mode,
      createdAt: request.created_at,
      updatedAt: request.created_at,
      metadata: {
        adoption_request_id: request.adoption_request_id,
        team_id: request.team_id,
        sub_plan_count: request.sub_plan_ids.length,
        mode: request.mode
      }
    });
    return filePath;
  }

  async saveAdoptedTaskProposal(proposal: AdoptedTaskProposal) {
    const paths = await this.ensureRunLayout(proposal.run_id);
    const filePath = path.join(paths.teamTaskAdoptionDir, `adopted_task_proposal_${sanitizeFilePart(proposal.adopted_task_id)}.json`);
    const persisted = { ...proposal, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: proposal.run_id,
      kind: "adopted_task_proposal",
      artifactRef: filePath,
      status: proposal.adoption_status,
      createdAt: proposal.created_at,
      updatedAt: proposal.created_at,
      metadata: {
        adopted_task_id: proposal.adopted_task_id,
        team_id: proposal.team_id,
        sub_plan_id: proposal.sub_plan_id,
        source_task_draft_id: proposal.source_task_draft_id,
        readiness_status: proposal.readiness_status,
        read_or_write_classification: proposal.read_or_write_classification,
        no_executor_task_created: true
      }
    });
    return filePath;
  }

  async saveRejectedTaskDraft(decision: TaskAdoptionDecision, draft: unknown) {
    const paths = await this.ensureRunLayout(decision.run_id);
    const filePath = path.join(paths.teamTaskAdoptionDir, `rejected_task_draft_${sanitizeFilePart(decision.task_draft_id)}.json`);
    await writeJson(filePath, sanitizeForArtifact({ decision, draft }));
    await this.metadata.recordArtifactSaved({
      runId: decision.run_id,
      kind: "rejected_task_draft",
      artifactRef: filePath,
      status: decision.adoption_status,
      createdAt: decision.created_at,
      updatedAt: decision.created_at,
      metadata: {
        adoption_decision_id: decision.adoption_decision_id,
        team_id: decision.team_id,
        sub_plan_id: decision.sub_plan_id,
        task_draft_id: decision.task_draft_id,
        reason: decision.reason
      }
    });
    return filePath;
  }

  async saveTaskReadinessResult(profile: TaskReadinessProfile) {
    const paths = await this.ensureRunLayout(profile.run_id);
    const filePath = path.join(paths.teamTaskAdoptionDir, `readiness_result_${sanitizeFilePart(profile.readiness_id)}.json`);
    const persisted = { ...profile, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: profile.run_id,
      kind: "task_readiness_result",
      artifactRef: filePath,
      status: profile.readiness_status,
      createdAt: profile.created_at,
      updatedAt: profile.created_at,
      metadata: {
        readiness_id: profile.readiness_id,
        team_id: profile.team_id,
        sub_plan_id: profile.sub_plan_id,
        task_draft_id: profile.task_draft_id,
        adopted_task_id: profile.adopted_task_id,
        finding_count: profile.findings.length
      }
    });
    return filePath;
  }

  async saveTeamTaskAdoptionSummary(result: TeamTaskAdoptionResult) {
    const paths = await this.ensureRunLayout(result.run_id);
    const jsonPath = path.join(paths.teamTaskAdoptionDir, `adoption_summary_${sanitizeFilePart(result.adoption_result_id)}.json`);
    const mdPath = path.join(paths.teamTaskAdoptionDir, `adoption_summary_${sanitizeFilePart(result.adoption_result_id)}.md`);
    const persisted = { ...result, artifact_ref: jsonPath, summary_ref: mdPath };
    await writeJson(jsonPath, sanitizeForArtifact(persisted));
    await writeFile(mdPath, teamTaskAdoptionSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: result.run_id,
      kind: "team_task_adoption_summary",
      artifactRef: jsonPath,
      status: "written",
      createdAt: result.created_at,
      updatedAt: result.created_at,
      metadata: {
        adoption_result_id: result.adoption_result_id,
        drafts_evaluated: result.evaluated_drafts,
        ...result.summary
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: result.run_id,
      kind: "team_task_adoption_summary_markdown",
      artifactRef: mdPath,
      status: "written",
      createdAt: result.created_at,
      updatedAt: result.created_at,
      metadata: {
        adoption_result_id: result.adoption_result_id,
        drafts_evaluated: result.evaluated_drafts
      }
    });
    return { artifactRef: jsonPath, summaryRef: mdPath };
  }

  async saveProposedTaskGraph(graph: ProposedTaskGraph, validation: ProposedTaskGraphValidationResult, summary: ProposedTaskGraphSummary) {
    const paths = await this.ensureRunLayout(graph.run_id);
    const graphPath = path.join(paths.proposedTaskGraphDir, `proposed_task_graph_${sanitizeFilePart(graph.graph_id)}.json`);
    const nodesPath = path.join(paths.proposedTaskGraphDir, `proposed_task_nodes_${sanitizeFilePart(graph.graph_id)}.json`);
    const edgesPath = path.join(paths.proposedTaskGraphDir, `proposed_task_edges_${sanitizeFilePart(graph.graph_id)}.json`);
    const validationPath = path.join(paths.proposedTaskGraphDir, `proposed_task_graph_validation_${sanitizeFilePart(validation.validation_id)}.json`);
    const summaryPath = path.join(paths.proposedTaskGraphDir, `proposed_task_graph_summary_${sanitizeFilePart(graph.graph_id)}.md`);
    const persistedGraph = {
      ...graph,
      artifact_ref: graphPath,
      nodes_ref: nodesPath,
      edges_ref: edgesPath,
      validation_ref: validationPath,
      summary_ref: summaryPath
    };
    const persistedValidation = { ...validation, artifact_ref: validationPath };
    const persistedSummary = { ...summary, graph_summary_ref: summaryPath };
    await writeJson(graphPath, sanitizeForArtifact(persistedGraph));
    await writeJson(nodesPath, sanitizeForArtifact({ graph_id: graph.graph_id, run_id: graph.run_id, nodes: graph.nodes }));
    await writeJson(edgesPath, sanitizeForArtifact({ graph_id: graph.graph_id, run_id: graph.run_id, edges: graph.edges }));
    await writeJson(validationPath, sanitizeForArtifact(persistedValidation));
    await writeFile(summaryPath, proposedTaskGraphSummaryMarkdown(persistedSummary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: graph.run_id,
      kind: "proposed_task_graph",
      artifactRef: graphPath,
      status: graph.status,
      createdAt: graph.created_at,
      updatedAt: graph.updated_at,
      metadata: {
        graph_id: graph.graph_id,
        proposed_node_count: graph.nodes.length,
        proposed_edge_count: graph.edges.length,
        non_executable: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: graph.run_id,
      kind: "proposed_task_graph_nodes",
      artifactRef: nodesPath,
      status: "written",
      createdAt: graph.created_at,
      updatedAt: graph.updated_at,
      metadata: { graph_id: graph.graph_id, proposed_node_count: graph.nodes.length }
    });
    await this.metadata.recordArtifactSaved({
      runId: graph.run_id,
      kind: "proposed_task_graph_edges",
      artifactRef: edgesPath,
      status: "written",
      createdAt: graph.created_at,
      updatedAt: graph.updated_at,
      metadata: { graph_id: graph.graph_id, proposed_edge_count: graph.edges.length }
    });
    await this.metadata.recordArtifactSaved({
      runId: graph.run_id,
      kind: "proposed_task_graph_validation",
      artifactRef: validationPath,
      status: validation.valid ? "valid" : "needs_review",
      createdAt: validation.created_at,
      updatedAt: validation.created_at,
      metadata: {
        graph_id: graph.graph_id,
        validation_id: validation.validation_id,
        cycle_count: validation.cycle_count,
        duplicate_count: validation.duplicate_count,
        scope_overlap_count: validation.scope_overlap_count
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: graph.run_id,
      kind: "proposed_task_graph_summary",
      artifactRef: summaryPath,
      status: graph.status,
      createdAt: summary.created_at,
      updatedAt: summary.created_at,
      metadata: {
        graph_id: graph.graph_id,
        proposed_node_count: summary.proposed_node_count,
        proposed_edge_count: summary.proposed_edge_count
      }
    });
    return {
      graphRef: graphPath,
      nodesRef: nodesPath,
      edgesRef: edgesPath,
      validationRef: validationPath,
      summaryRef: summaryPath
    };
  }

  async saveExecutionReadinessDecision(decision: ExecutionReadinessDecision) {
    const paths = await this.ensureRunLayout(decision.run_id);
    const filePath = path.join(paths.executionReadinessDir, `readiness_decision_${sanitizeFilePart(decision.decision_id)}.json`);
    const persisted = { ...decision, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: decision.run_id,
      kind: "execution_readiness_decision",
      artifactRef: filePath,
      status: decision.readiness_status,
      createdAt: decision.created_at,
      updatedAt: decision.created_at,
      metadata: {
        decision_id: decision.decision_id,
        proposed_node_id: decision.proposed_node_id,
        team_id: decision.team_id,
        approval_status: decision.approval_status,
        blocker_count: decision.blockers.length,
        warning_count: decision.warnings.length
      }
    });
    return filePath;
  }

  async saveExecutionApprovalRequirement(requirement: HumanApprovalRequirement) {
    const paths = await this.ensureRunLayout(requirement.run_id);
    const filePath = path.join(paths.executionReadinessDir, `approval_requirement_${sanitizeFilePart(requirement.approval_requirement_id)}.json`);
    const persisted = { ...requirement, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: requirement.run_id,
      kind: "execution_approval_requirement",
      artifactRef: filePath,
      status: requirement.required ? "required" : "not_required",
      createdAt: requirement.created_at,
      updatedAt: requirement.created_at,
      metadata: {
        approval_requirement_id: requirement.approval_requirement_id,
        proposed_node_id: requirement.proposed_node_id,
        team_id: requirement.team_id,
        trigger_count: requirement.triggers.length,
        risk_level: requirement.risk_level
      }
    });
    return filePath;
  }

  async saveExecutionReadinessBatch(batch: ExecutionReadinessBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const batchPath = path.join(paths.executionReadinessDir, `readiness_batch_${sanitizeFilePart(batch.batch_id)}.json`);
    const summaryPath = path.join(paths.executionReadinessDir, `readiness_summary_${sanitizeFilePart(batch.summary.summary_id)}.md`);
    const persisted = { ...batch, artifact_ref: batchPath, summary_ref: summaryPath, summary: { ...batch.summary, readiness_summary_ref: summaryPath } };
    await writeJson(batchPath, sanitizeForArtifact(persisted));
    await writeFile(summaryPath, executionReadinessSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "execution_readiness_batch",
      artifactRef: batchPath,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        graph_id: batch.graph_id,
        decision_count: batch.decisions.length,
        approval_requirement_count: batch.approval_requirements.length
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "execution_readiness_summary",
      artifactRef: summaryPath,
      status: "written",
      createdAt: batch.summary.created_at,
      updatedAt: batch.summary.created_at,
      metadata: {
        summary_id: batch.summary.summary_id,
        graph_id: batch.graph_id,
        nodes_evaluated: batch.summary.nodes_evaluated,
        blocked_count: batch.summary.blocked_count
      }
    });
    return { batchRef: batchPath, summaryRef: summaryPath };
  }

  async saveExecutionDryRunPromptCheck(runId: string, proposedNodeId: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.executionReadinessDir, `dry_run_prompt_check_${sanitizeFilePart(proposedNodeId)}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "execution_readiness_dry_run_prompt_check",
      artifactRef: filePath,
      status: "written",
      metadata: { proposed_node_id: proposedNodeId, text_stored: false }
    });
    return filePath;
  }

  async saveExecutionContextPreview(runId: string, proposedNodeId: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.executionReadinessDir, `context_preview_${sanitizeFilePart(proposedNodeId)}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "execution_readiness_context_preview",
      artifactRef: filePath,
      status: "written",
      metadata: { proposed_node_id: proposedNodeId, snippets_stored: false }
    });
    return filePath;
  }

  async saveExecutionPromotionRequest(request: ExecutionPromotionRequest) {
    const paths = await this.ensureRunLayout(request.run_id);
    const filePath = path.join(paths.executionApprovalsDir, `promotion_request_${sanitizeFilePart(request.promotion_request_id)}.json`);
    const persisted = { ...request, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: request.run_id,
      kind: "execution_promotion_request",
      artifactRef: filePath,
      status: request.status,
      createdAt: request.created_at,
      updatedAt: request.updated_at,
      metadata: {
        promotion_request_id: request.promotion_request_id,
        proposed_node_id: request.proposed_node_id,
        readiness_decision_id: request.readiness_decision_id,
        approval_required: request.approval_required,
        risk_level: request.risk_level
      }
    });
    return filePath;
  }

  async saveHumanApprovalRecord(approval: HumanApprovalRecord) {
    const paths = await this.ensureRunLayout(approval.run_id);
    const prefix = approval.decision === "denied"
      ? "approval_denial"
      : approval.decision === "revoked"
        ? "approval_revocation"
        : "human_approval";
    const filePath = path.join(paths.executionApprovalsDir, `${prefix}_${sanitizeFilePart(approval.approval_id)}.json`);
    const persisted = { ...approval, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: approval.run_id,
      kind: prefix,
      artifactRef: filePath,
      status: approval.approval_status,
      createdAt: approval.created_at,
      updatedAt: approval.created_at,
      metadata: {
        approval_id: approval.approval_id,
        promotion_request_id: approval.promotion_request_id,
        proposed_node_id: approval.proposed_node_id,
        approver_type: approval.approver_type,
        decision: approval.decision
      }
    });
    return filePath;
  }

  async savePromotionQueueItem(item: PromotionQueueItem) {
    const paths = await this.ensureRunLayout(item.run_id);
    const filePath = path.join(paths.executionApprovalsDir, `promotion_queue_item_${sanitizeFilePart(item.queue_item_id)}.json`);
    const persisted = { ...item, artifact_ref: filePath };
    await writeJson(filePath, sanitizeForArtifact(persisted));
    await this.metadata.recordArtifactSaved({
      runId: item.run_id,
      kind: "promotion_queue_item",
      artifactRef: filePath,
      status: item.queue_status,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      metadata: {
        queue_item_id: item.queue_item_id,
        promotion_request_id: item.promotion_request_id,
        approval_id: item.approval_id,
        proposed_node_id: item.proposed_node_id,
        promotion_type: item.promotion_type,
        blocker_count: item.blockers.length
      }
    });
    return filePath;
  }

  async savePromotionQueueSummary(summary: PromotionQueueSummary) {
    const paths = await this.ensureRunLayout(summary.run_id);
    const filePath = path.join(paths.executionApprovalsDir, `promotion_queue_summary_${sanitizeFilePart(summary.summary_id)}.md`);
    await writeFile(filePath, promotionQueueSummaryMarkdown(summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: summary.run_id,
      kind: "promotion_queue_summary",
      artifactRef: filePath,
      status: "written",
      createdAt: summary.created_at,
      updatedAt: summary.created_at,
      metadata: {
        summary_id: summary.summary_id,
        promotion_requests_created: summary.promotion_requests_created,
        queue_items_created: summary.queue_items_created,
        approvals_required: summary.approvals_required
      }
    });
    return filePath;
  }

  async saveExecutionPreparationPlan(plan: ExecutionPreparationPlan) {
    const paths = await this.ensureRunLayout(plan.run_id);
    const id = sanitizeFilePart(plan.preparation_plan_id);
    const planRef = path.join(paths.executionPreparationDir, `preparation_plan_${id}.json`);
    const lockPlanRef = path.join(paths.executionPreparationDir, `lock_plan_${id}.json`);
    const validationPlanRef = path.join(paths.executionPreparationDir, `validation_plan_${id}.json`);
    const reviewPolicyRef = path.join(paths.executionPreparationDir, `review_policy_${id}.json`);
    const integrationPreviewRef = path.join(paths.executionPreparationDir, `integration_preview_${id}.json`);
    const rollbackPreviewRef = path.join(paths.executionPreparationDir, `rollback_preview_${id}.json`);
    const persisted: ExecutionPreparationPlan = {
      ...plan,
      artifact_ref: planRef,
      lock_plan_ref: lockPlanRef,
      validation_plan_ref: validationPlanRef,
      review_policy_ref: reviewPolicyRef,
      integration_preview_ref: integrationPreviewRef,
      rollback_preview_ref: rollbackPreviewRef
    };
    await writeJson(lockPlanRef, {
      preparation_plan_id: plan.preparation_plan_id,
      run_id: plan.run_id,
      queue_item_id: plan.queue_item_id,
      required_file_locks: plan.required_file_locks,
      required_module_locks: plan.required_module_locks,
      required_semantic_locks: plan.required_semantic_locks,
      no_locks_acquired: true
    });
    await writeJson(validationPlanRef, plan.validation_plan);
    await writeJson(reviewPolicyRef, plan.review_policy);
    await writeJson(integrationPreviewRef, plan.integration_preview);
    await writeJson(rollbackPreviewRef, plan.rollback_preview);
    await writeJson(planRef, persisted);
    await this.metadata.recordArtifactSaved({
      runId: plan.run_id,
      taskId: plan.proposed_node_id,
      kind: "execution_preparation_plan",
      artifactRef: planRef,
      status: plan.status,
      createdAt: plan.created_at,
      updatedAt: plan.created_at,
      metadata: {
        preparation_plan_id: plan.preparation_plan_id,
        queue_item_id: plan.queue_item_id,
        promotion_request_id: plan.promotion_request_id,
        blocker_count: plan.blockers.length,
        warning_count: plan.warnings.length,
        no_execution: true
      }
    });
    return { planRef, lockPlanRef, validationPlanRef, reviewPolicyRef, integrationPreviewRef, rollbackPreviewRef };
  }

  async saveExecutionPreparationBatch(batch: ExecutionPreparationBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.executionPreparationDir, `preparation_batch_${id}.json`);
    const summaryRef = path.join(paths.executionPreparationDir, `preparation_summary_${id}.md`);
    const persisted: ExecutionPreparationBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        preparation_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, persisted);
    await writeFile(summaryRef, executionPreparationSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "execution_preparation_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        preparation_plan_count: batch.summary.preparation_plan_count,
        prepared_count: batch.summary.prepared_count,
        blocked_count: batch.summary.blocked_count,
        no_execution: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "execution_preparation_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        summary_id: batch.summary.summary_id
      }
    });
    return { batchRef, summaryRef };
  }

  async saveOneWriterDryRunProposalArtifacts(input: {
    proposal: OneWriterDryRunProposal;
    writerInput?: OneWriterDryRunProviderInput;
    promptText?: string;
    rawOutput?: string;
    parsedOutput?: unknown;
    patchProposal?: PatchProposal;
    scopeCheck?: PatchProposalScopeCheck;
  }) {
    const paths = await this.ensureRunLayout(input.proposal.run_id);
    const id = sanitizeFilePart(input.proposal.proposal_id);
    const proposalDir = path.join(paths.dryRunWritersDir, id);
    await mkdir(proposalDir, { recursive: true });
    const writerInputRef = path.join(proposalDir, "writer_input.json");
    const promptRef = path.join(proposalDir, "prompt.md");
    const rawOutputRef = path.join(proposalDir, "raw_output.md");
    const parsedOutputRef = path.join(proposalDir, "parsed_output.json");
    const patchProposalRef = path.join(proposalDir, "patch_proposal.json");
    const scopeCheckRef = path.join(proposalDir, "scope_check.json");
    const summaryRef = path.join(proposalDir, "proposal_summary.md");
    const artifactRef = patchProposalRef;
    if (input.writerInput) await writeJson(writerInputRef, sanitizeForArtifact(input.writerInput));
    if (input.promptText !== undefined) await writeFile(promptRef, input.promptText, "utf8");
    if (input.rawOutput !== undefined) await writeFile(rawOutputRef, redactSecrets(input.rawOutput), "utf8");
    if (input.parsedOutput !== undefined) await writeJson(parsedOutputRef, sanitizeForArtifact(input.parsedOutput));
    await writeJson(patchProposalRef, sanitizeForArtifact({
      ...input.proposal,
      raw_output_ref: input.rawOutput !== undefined ? rawOutputRef : input.proposal.raw_output_ref,
      parsed_output_ref: input.parsedOutput !== undefined ? parsedOutputRef : input.proposal.parsed_output_ref,
      patch_artifact_ref: patchProposalRef,
      artifact_ref: artifactRef
    }));
    if (input.scopeCheck) await writeJson(scopeCheckRef, sanitizeForArtifact(input.scopeCheck));
    await writeFile(summaryRef, oneWriterDryRunProposalSummaryMarkdown(input.proposal, input.scopeCheck), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.proposal.run_id,
      taskId: input.proposal.proposed_node_id,
      kind: "one_writer_dry_run_proposal",
      artifactRef,
      status: input.proposal.status,
      createdAt: input.proposal.created_at,
      updatedAt: input.proposal.created_at,
      metadata: {
        proposal_id: input.proposal.proposal_id,
        preparation_plan_id: input.proposal.preparation_plan_id,
        changed_file_count: input.proposal.changed_files.length,
        no_patch_applied: true,
        no_integration_candidate_created: true
      }
    });
    return {
      proposalDir,
      writerInputRef,
      promptRef,
      rawOutputRef,
      parsedOutputRef,
      patchProposalRef,
      scopeCheckRef,
      summaryRef,
      artifactRef
    };
  }

  async saveOneWriterDryRunBatch(batch: OneWriterDryRunBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.dryRunWritersDir, `dry_run_batch_${id}.json`);
    const summaryRef = path.join(paths.dryRunWritersDir, `dry_run_summary_${id}.md`);
    const persisted: OneWriterDryRunBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        dry_run_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, patchProposalSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "one_writer_dry_run_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        dry_run_proposal_count: batch.summary.dry_run_proposal_count,
        review_candidate_count: batch.summary.review_candidate_count,
        no_patch_applied: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "one_writer_dry_run_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        summary_id: batch.summary.summary_id
      }
    });
    return { batchRef, summaryRef };
  }

  async savePatchProposalReviewArtifacts(input: {
    review: PatchProposalReview;
    reviewInput?: PatchProposalReviewProviderInput;
    promptText?: string;
    rawOutput?: string;
    parsedOutput?: unknown;
  }) {
    const paths = await this.ensureRunLayout(input.review.run_id);
    const proposalId = sanitizeFilePart(input.review.proposal_id);
    const reviewDir = path.join(paths.patchReviewsDir, proposalId);
    await mkdir(reviewDir, { recursive: true });
    const reviewInputRef = path.join(reviewDir, "review_input.json");
    const promptRef = path.join(reviewDir, "prompt.md");
    const rawOutputRef = path.join(reviewDir, "raw_review_output.md");
    const parsedOutputRef = path.join(reviewDir, "parsed_review_output.json");
    const reviewResultRef = path.join(reviewDir, "review_result.json");
    const summaryRef = path.join(reviewDir, "review_summary.md");
    if (input.reviewInput) await writeJson(reviewInputRef, sanitizeForArtifact(input.reviewInput));
    if (input.promptText !== undefined) await writeFile(promptRef, input.promptText, "utf8");
    if (input.rawOutput !== undefined) await writeFile(rawOutputRef, redactSecrets(input.rawOutput), "utf8");
    if (input.parsedOutput !== undefined) await writeJson(parsedOutputRef, sanitizeForArtifact(input.parsedOutput));
    await writeJson(reviewResultRef, sanitizeForArtifact({
      ...input.review,
      raw_review_output_ref: input.rawOutput !== undefined ? rawOutputRef : input.review.raw_review_output_ref,
      parsed_review_output_ref: input.parsedOutput !== undefined ? parsedOutputRef : input.review.parsed_review_output_ref,
      review_artifact_ref: reviewResultRef
    }));
    await writeFile(summaryRef, patchProposalReviewSummaryMarkdown(input.review), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.review.run_id,
      taskId: input.review.proposed_node_id,
      kind: "patch_proposal_review",
      artifactRef: reviewResultRef,
      status: input.review.status,
      createdAt: input.review.created_at,
      updatedAt: input.review.created_at,
      metadata: {
        review_id: input.review.review_id,
        proposal_id: input.review.proposal_id,
        decision: input.review.decision,
        finding_count: input.review.findings.length,
        no_validation_run: true,
        no_patch_applied: true
      }
    });
    return { reviewDir, reviewInputRef, promptRef, rawOutputRef, parsedOutputRef, reviewResultRef, summaryRef };
  }

  async savePatchProposalReviewBatch(batch: PatchProposalReviewBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.patchReviewsDir, `review_batch_${id}.json`);
    const summaryRef = path.join(paths.patchReviewsDir, `review_summary_${id}.md`);
    const persisted: PatchProposalReviewBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        review_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, patchProposalReviewBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "patch_proposal_review_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        review_count: batch.summary.patch_reviews_count,
        accepted_for_validation_candidate_count: batch.summary.accepted_for_validation_candidate_count,
        no_validation_run: true,
        no_patch_applied: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "patch_proposal_review_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        summary_id: batch.summary.summary_id
      }
    });
    return { batchRef, summaryRef };
  }

  async saveValidationCandidateArtifacts(input: {
    candidate: ValidationCandidate;
    candidateInput?: unknown;
    validationPlan?: ValidationPlanDraft;
    preflight?: ValidationPreflightResult;
  }) {
    const paths = await this.ensureRunLayout(input.candidate.run_id);
    const id = sanitizeFilePart(input.candidate.validation_candidate_id);
    const candidateDir = path.join(paths.validationCandidatesDir, id);
    await mkdir(candidateDir, { recursive: true });
    const candidateInputRef = path.join(candidateDir, "candidate_input.json");
    const validationPlanRef = path.join(candidateDir, "validation_plan.json");
    const commandPreflightRef = path.join(candidateDir, "command_preflight.json");
    const environmentPreflightRef = path.join(candidateDir, "environment_preflight.json");
    const candidateRef = path.join(candidateDir, "validation_candidate.json");
    const summaryRef = path.join(candidateDir, "validation_candidate_summary.md");
    if (input.candidateInput !== undefined) await writeJson(candidateInputRef, sanitizeForArtifact(input.candidateInput));
    await writeJson(validationPlanRef, sanitizeForArtifact(input.validationPlan ?? {
      required_commands: input.candidate.required_commands,
      optional_commands: input.candidate.optional_commands,
      strict_validation_semantics_ref: input.candidate.strict_validation_semantics_ref,
      no_validation_run: true
    }));
    await writeJson(commandPreflightRef, sanitizeForArtifact(input.preflight?.command_preflights ?? input.candidate.command_safety_results));
    await writeJson(environmentPreflightRef, sanitizeForArtifact(input.preflight?.environment_readiness ?? input.candidate.environment_readiness ?? {
      status: "not_run",
      no_shell_commands_run: true
    }));
    const persisted: ValidationCandidate = {
      ...input.candidate,
      artifact_ref: candidateRef,
      validation_plan_artifact_ref: validationPlanRef,
      command_preflight_ref: commandPreflightRef,
      environment_preflight_ref: environmentPreflightRef
    };
    await writeJson(candidateRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, validationCandidateSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.candidate.run_id,
      taskId: input.candidate.proposed_node_id,
      kind: "validation_candidate",
      artifactRef: candidateRef,
      status: input.candidate.status,
      createdAt: input.candidate.created_at,
      updatedAt: input.candidate.created_at,
      metadata: {
        validation_candidate_id: input.candidate.validation_candidate_id,
        proposal_id: input.candidate.proposal_id,
        review_id: input.candidate.review_id,
        required_command_count: input.candidate.required_commands.length,
        no_validation_run: true,
        no_patch_applied: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: input.candidate.run_id,
      taskId: input.candidate.proposed_node_id,
      kind: "validation_candidate_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: input.candidate.created_at,
      updatedAt: input.candidate.created_at,
      metadata: {
        validation_candidate_id: input.candidate.validation_candidate_id,
        no_validation_run: true
      }
    });
    return { candidateDir, candidateInputRef, validationPlanRef, commandPreflightRef, environmentPreflightRef, candidateRef, summaryRef };
  }

  async saveValidationCandidateBatch(batch: ValidationCandidateBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.validationCandidatesDir, `validation_candidate_batch_${id}.json`);
    const summaryRef = path.join(paths.validationCandidatesDir, `validation_candidate_summary_${id}.md`);
    const persisted: ValidationCandidateBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        validation_candidate_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, validationCandidateBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "validation_candidate_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        validation_candidate_count: batch.summary.validation_candidate_count,
        preflight_passed_count: batch.summary.preflight_passed_count,
        no_validation_run: true,
        no_patch_applied: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "validation_candidate_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        summary_id: batch.summary.summary_id
      }
    });
    return { batchRef, summaryRef };
  }

  async savePatchApplySandboxResult(input: {
    result: PatchApplySandboxResult;
    request?: PatchApplySandboxRequest;
    mainRepoIntegrity?: unknown;
  }) {
    const paths = await this.ensureRunLayout(input.result.run_id);
    const id = sanitizeFilePart(input.result.sandbox_result_id);
    const resultDir = path.join(paths.patchApplySandboxDir, id);
    await mkdir(resultDir, { recursive: true });
    const requestRef = path.join(resultDir, "sandbox_request.json");
    const resultRef = path.join(resultDir, "dry_apply_result.json");
    const conflictsRef = path.join(resultDir, "conflicts.json");
    const failedHunksRef = path.join(resultDir, "failed_hunks.json");
    const integrityRef = path.join(resultDir, "main_repo_integrity.json");
    const summaryRef = path.join(resultDir, "sandbox_summary.md");
    if (input.request) await writeJson(requestRef, sanitizeForArtifact(input.request));
    await writeJson(conflictsRef, sanitizeForArtifact(input.result.conflicts));
    await writeJson(failedHunksRef, sanitizeForArtifact(input.result.failed_hunks));
    await writeJson(integrityRef, sanitizeForArtifact(input.mainRepoIntegrity ?? {
      main_repo_modified: false,
      validation_run: false,
      integration_created: false
    }));
    const persisted: PatchApplySandboxResult = {
      ...input.result,
      artifact_ref: resultRef,
      summary_ref: summaryRef,
      sandbox_artifact_ref: resultDir
    };
    await writeJson(resultRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, patchApplySandboxResultSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.result.run_id,
      taskId: input.result.validation_candidate_id,
      kind: "patch_apply_sandbox_result",
      artifactRef: resultRef,
      status: input.result.dry_apply_status,
      createdAt: input.result.created_at,
      updatedAt: input.result.created_at,
      metadata: {
        sandbox_result_id: input.result.sandbox_result_id,
        validation_candidate_id: input.result.validation_candidate_id,
        proposal_id: input.result.proposal_id,
        conflict_count: input.result.conflicts.length,
        failed_hunk_count: input.result.failed_hunks.length,
        unsafe_finding_count: input.result.unsafe_findings.length,
        main_repo_modified: false,
        validation_run: false,
        integration_created: false
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: input.result.run_id,
      kind: "patch_apply_sandbox_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: input.result.created_at,
      updatedAt: input.result.created_at,
      metadata: {
        sandbox_result_id: input.result.sandbox_result_id,
        dry_apply_status: input.result.dry_apply_status
      }
    });
    return { resultDir, requestRef, resultRef, conflictsRef, failedHunksRef, integrityRef, summaryRef };
  }

  async savePatchApplySandboxBatch(batch: PatchSandboxBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.patchApplySandboxDir, `patch_apply_sandbox_batch_${id}.json`);
    const summaryRef = path.join(paths.patchApplySandboxDir, `patch_apply_sandbox_summary_${id}.md`);
    const persisted: PatchSandboxBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        sandbox_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, patchApplySandboxBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "patch_apply_sandbox_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        sandbox_result_count: batch.summary.sandbox_result_count,
        dry_apply_passed_count: batch.summary.dry_apply_passed_count,
        conflict_count: batch.summary.conflict_count,
        no_validation_run: true,
        no_patch_applied: true
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "patch_apply_sandbox_summary",
      artifactRef: summaryRef,
      status: "written",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        summary_id: batch.summary.summary_id
      }
    });
    return { batchRef, summaryRef };
  }

  async saveSandboxValidationLog(runId: string, sandboxValidationId: string, commandId: string, log: string) {
    const paths = await this.ensureRunLayout(runId);
    const logsDir = path.join(paths.sandboxValidationDir, sanitizeFilePart(sandboxValidationId), "logs");
    await mkdir(logsDir, { recursive: true });
    const logRef = path.join(logsDir, `${sanitizeFilePart(commandId)}.log`);
    await writeFile(logRef, redactSecrets(log), "utf8");
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "sandbox_validation_log",
      artifactRef: logRef,
      status: "written",
      metadata: { sandbox_validation_id: sandboxValidationId, command_id: commandId }
    });
    return logRef;
  }

  async saveSandboxValidationResult(input: {
    result: SandboxValidationResult;
    request?: SandboxValidationRequest;
    commandExecutionPlan?: unknown;
  }) {
    const paths = await this.ensureRunLayout(input.result.run_id);
    const id = sanitizeFilePart(input.result.sandbox_validation_id);
    const resultDir = path.join(paths.sandboxValidationDir, id);
    const logsDir = path.join(resultDir, "logs");
    await mkdir(logsDir, { recursive: true });
    const requestRef = path.join(resultDir, "validation_request.json");
    const planRef = path.join(resultDir, "command_execution_plan.json");
    const commandResultsRef = path.join(resultDir, "command_results.json");
    const strictResultRef = path.join(resultDir, "strict_validation_result.json");
    const resultRef = path.join(resultDir, "sandbox_validation_result.json");
    const summaryRef = path.join(resultDir, "sandbox_validation_summary.md");
    if (input.request) await writeJson(requestRef, sanitizeForArtifact(input.request));
    await writeJson(planRef, sanitizeForArtifact(input.commandExecutionPlan ?? []));
    await writeJson(commandResultsRef, sanitizeForArtifact(input.result.command_results));
    await writeJson(strictResultRef, sanitizeForArtifact({
      status: input.result.strict_validation_status,
      required_command_count: input.result.required_command_count,
      optional_command_count: input.result.optional_command_count,
      passed_count: input.result.passed_count,
      failed_count: input.result.failed_count,
      blocked_count: input.result.blocked_count,
      skipped_count: input.result.skipped_count,
      timed_out_count: input.result.timed_out_count,
      not_run_count: input.result.not_run_count
    }));
    const persisted: SandboxValidationResult = {
      ...input.result,
      artifact_ref: resultRef,
      summary_ref: summaryRef,
      logs_ref: logsDir
    };
    await writeJson(resultRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, sandboxValidationResultSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.result.run_id,
      kind: "sandbox_validation_result",
      artifactRef: resultRef,
      status: input.result.status,
      createdAt: input.result.created_at,
      updatedAt: input.result.created_at,
      metadata: {
        sandbox_validation_id: input.result.sandbox_validation_id,
        sandbox_result_id: input.result.sandbox_result_id,
        validation_candidate_id: input.result.validation_candidate_id,
        strict_validation_status: input.result.strict_validation_status,
        command_count: input.result.command_results.length,
        no_main_repo_validation: true,
        no_integration_created: true
      }
    });
    return { resultDir, logsDir, requestRef, planRef, commandResultsRef, strictResultRef, resultRef, summaryRef };
  }

  async saveSandboxValidationBatch(batch: SandboxValidationBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.sandboxValidationDir, `sandbox_validation_batch_${id}.json`);
    const summaryRef = path.join(paths.sandboxValidationDir, `sandbox_validation_summary_${id}.md`);
    const persisted: SandboxValidationBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        sandbox_validation_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, sandboxValidationBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "sandbox_validation_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        sandbox_validation_count: batch.summary.sandbox_validation_count,
        passed_count: batch.summary.sandbox_validation_passed_count,
        no_main_repo_validation: true
      }
    });
    return { batchRef, summaryRef };
  }

  async saveSandboxIntegrationCandidate(input: {
    candidate: SandboxValidatedIntegrationCandidate;
    request?: IntegrationCandidateCreationRequest;
    input?: unknown;
    rollbackRequirements?: IntegrationRollbackRequirements;
    postIntegrationValidationPlan?: PostIntegrationValidationPlan;
  }) {
    const paths = await this.ensureRunLayout(input.candidate.run_id);
    const id = sanitizeFilePart(input.candidate.integration_candidate_id);
    const candidateDir = path.join(paths.sandboxIntegrationCandidatesDir, id);
    await mkdir(candidateDir, { recursive: true });
    const inputRef = path.join(candidateDir, "candidate_input.json");
    const candidateRef = path.join(candidateDir, "integration_candidate.json");
    const rollbackRef = path.join(candidateDir, "rollback_requirements.json");
    const postValidationRef = path.join(candidateDir, "post_integration_validation_plan.json");
    const summaryRef = path.join(candidateDir, "integration_candidate_summary.md");
    await writeJson(inputRef, sanitizeForArtifact(input.request ?? input.input ?? {
      sandbox_validation_id: input.candidate.sandbox_validation_id,
      proposal_id: input.candidate.proposal_id,
      review_id: input.candidate.review_id,
      validation_candidate_id: input.candidate.validation_candidate_id
    }));
    const rollback = {
      ...(input.rollbackRequirements ?? input.candidate.rollback_requirements),
      artifact_ref: rollbackRef
    };
    const postValidation = {
      ...(input.postIntegrationValidationPlan ?? input.candidate.post_integration_validation_plan),
      artifact_ref: postValidationRef
    };
    const persisted: SandboxValidatedIntegrationCandidate = {
      ...input.candidate,
      artifact_ref: candidateRef,
      rollback_requirements_ref: rollbackRef,
      post_integration_validation_plan_ref: postValidationRef,
      summary_ref: summaryRef,
      rollback_requirements: rollback,
      post_integration_validation_plan: postValidation
    };
    await writeJson(rollbackRef, sanitizeForArtifact(rollback));
    await writeJson(postValidationRef, sanitizeForArtifact(postValidation));
    await writeJson(candidateRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, sandboxIntegrationCandidateSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.candidate.run_id,
      kind: "sandbox_integration_candidate",
      artifactRef: candidateRef,
      status: input.candidate.status,
      createdAt: input.candidate.created_at,
      updatedAt: input.candidate.created_at,
      metadata: {
        integration_candidate_id: input.candidate.integration_candidate_id,
        sandbox_validation_id: input.candidate.sandbox_validation_id,
        strict_validation_status: input.candidate.strict_validation_status,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    return { candidateDir, inputRef, candidateRef, rollbackRef, postValidationRef, summaryRef };
  }

  async saveSandboxIntegrationCandidateBatch(batch: IntegrationCandidateBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.sandboxIntegrationCandidatesDir, `sandbox_integration_candidate_batch_${id}.json`);
    const summaryRef = path.join(paths.sandboxIntegrationCandidatesDir, `sandbox_integration_candidate_summary_${id}.md`);
    const persisted: IntegrationCandidateBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        candidate_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, sandboxIntegrationCandidateBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "sandbox_integration_candidate_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        integration_candidate_count: batch.summary.integration_candidate_count,
        candidate_created_count: batch.summary.candidate_created_count,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    return { batchRef, summaryRef };
  }

  async saveIntegrationApplyApproval(input: {
    approval: IntegrationApplyApproval;
    input?: unknown;
    worktreeSafetyCheck: WorktreeSafetyCheck;
    approvalScopeCheck: unknown;
    applyModeRecommendation: unknown;
  }) {
    const paths = await this.ensureRunLayout(input.approval.run_id);
    const id = sanitizeFilePart(input.approval.integration_apply_approval_id);
    const approvalDir = path.join(paths.integrationApplyApprovalsDir, id);
    await mkdir(approvalDir, { recursive: true });
    const inputRef = path.join(approvalDir, "apply_approval_input.json");
    const worktreeRef = path.join(approvalDir, "worktree_safety_check.json");
    const scopeRef = path.join(approvalDir, "approval_scope_check.json");
    const approvalRef = path.join(approvalDir, "apply_approval_result.json");
    const modeRef = path.join(approvalDir, "apply_mode_recommendation.json");
    const summaryRef = path.join(approvalDir, "apply_approval_summary.md");
    const persisted: IntegrationApplyApproval = {
      ...input.approval,
      artifact_ref: approvalRef,
      summary_ref: summaryRef
    };
    await writeJson(inputRef, sanitizeForArtifact(input.input ?? {
      integration_candidate_id: input.approval.integration_candidate_id,
      proposal_id: input.approval.proposal_id,
      sandbox_validation_id: input.approval.sandbox_validation_id
    }));
    await writeJson(worktreeRef, sanitizeForArtifact(input.worktreeSafetyCheck));
    await writeJson(scopeRef, sanitizeForArtifact(input.approvalScopeCheck));
    await writeJson(modeRef, sanitizeForArtifact(input.applyModeRecommendation));
    await writeJson(approvalRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, integrationApplyApprovalSummaryMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.approval.run_id,
      kind: "integration_apply_approval",
      artifactRef: approvalRef,
      status: input.approval.approval_status,
      createdAt: input.approval.created_at,
      updatedAt: input.approval.created_at,
      metadata: {
        integration_apply_approval_id: input.approval.integration_apply_approval_id,
        integration_candidate_id: input.approval.integration_candidate_id,
        approval_status: input.approval.approval_status,
        apply_mode_recommendation: input.approval.apply_mode_recommendation,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    return { approvalDir, inputRef, worktreeRef, scopeRef, approvalRef, modeRef, summaryRef };
  }

  async saveIntegrationApplyApprovalBatch(batch: IntegrationApplyApprovalBatch) {
    const paths = await this.ensureRunLayout(batch.run_id);
    const id = sanitizeFilePart(batch.batch_id);
    const batchRef = path.join(paths.integrationApplyApprovalsDir, `integration_apply_approval_batch_${id}.json`);
    const summaryRef = path.join(paths.integrationApplyApprovalsDir, `integration_apply_approval_summary_${id}.md`);
    const persisted: IntegrationApplyApprovalBatch = {
      ...batch,
      artifact_ref: batchRef,
      summary_ref: summaryRef,
      summary: {
        ...batch.summary,
        apply_approval_summary_ref: summaryRef
      }
    };
    await writeJson(batchRef, sanitizeForArtifact(persisted));
    await writeFile(summaryRef, integrationApplyApprovalBatchSummaryMarkdown(persisted.summary), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: batch.run_id,
      kind: "integration_apply_approval_batch",
      artifactRef: batchRef,
      status: "created",
      createdAt: batch.created_at,
      updatedAt: batch.created_at,
      metadata: {
        batch_id: batch.batch_id,
        apply_approval_count: batch.summary.apply_approval_count,
        approved_for_apply_candidate_count: batch.summary.approved_for_apply_candidate_count,
        requires_human_approval_count: batch.summary.requires_human_approval_count,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    return { batchRef, summaryRef };
  }

  async saveAgentTeamSummary(runId: string, id: string, value: string, metadata: Record<string, unknown> = {}) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.teamsDir, `team_summary_${id}.md`);
    await writeFile(filePath, value, "utf8");
    await this.metadata.recordArtifactSaved({
      runId,
      kind: "agent_team_summary",
      artifactRef: filePath,
      status: "written",
      metadata
    });
    return filePath;
  }

  async saveRepairArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.repairsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordOutputSaved(runId, id, "repair", filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: taskIdFromValue(value) ?? inferTaskIdFromSourceId(id),
      event_type: repairTraceType(value),
      lifecycle_stage: "executing",
      summary: `Repair artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async saveLockSnapshot(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.locksDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    await this.metadata.recordLockSnapshotSaved(runId, id, filePath, value);
    await this.traceWriter.write({
      run_id: runId,
      task_id: inferTaskIdFromSourceId(id),
      event_type: id.includes("released") ? "lock_released" : "lock_acquired",
      lifecycle_stage: "executing",
      summary: `Lock snapshot artifact written: ${id}.`,
      artifact_refs: [filePath],
      metadata_json: summarizeArtifactValue(value)
    });
    return filePath;
  }

  async listRunEvents(runId: string): Promise<unknown[]> {
    const paths = await this.pathsForRun(runId);
    if (!existsSync(paths.events)) return [];
    const raw = await readFile(paths.events, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  }

  async listTaskArtifacts(runId: string, taskId: string) {
    const tasks = await this.loadTasks(runId);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task.artifacts;
  }

  async listValidationLogs(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.validationDir);
  }

  async listPatchHistory(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.patchesDir);
  }

  async recordRunTransition(record: RunTransitionRecord) {
    await this.metadata.recordRunTransition(record);
  }

  async artifactTree(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return walkFiles(paths.runDir, paths.runDir);
  }

  async readArtifactText(runId: string, relativeArtifactPath: string) {
    const paths = await this.ensureRunLayout(runId);
    const target = path.resolve(paths.runDir, relativeArtifactPath);
    const relative = path.relative(paths.runDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path is outside the selected run.");
    }
    return readFile(target, "utf8");
  }

  async listRuns() {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    if (!existsSync(memory.runsDir)) return [];
    const entries = await readdir(memory.runsDir, { withFileTypes: true });
    const runs: Run[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(memory.runsDir, entry.name, "run.json");
      if (!existsSync(runPath)) continue;
      try {
        runs.push(JSON.parse(await readFile(runPath, "utf8")) as Run);
      } catch {
        // Ignore malformed run dirs during listing; show-run will fail loudly.
      }
    }
    return runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }
}

async function listFiles(directory: string) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name)).sort();
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

function sanitizeForArtifact(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeForArtifact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /token|secret|password|api[_-]?key/i.test(key) ? "[REDACTED]" : sanitizeForArtifact(entry)
      ])
    );
  }
  return value;
}

function redactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]");
}

function inferValidationLogStatus(value: string) {
  const match = value.match(/^status:\s*(\S+)/m);
  return match?.[1] ?? "recorded";
}

function taskIdFromValue(value: unknown): string | undefined {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) return undefined;
  if (typeof record.task_id === "string") return record.task_id;
  if (typeof record.original_task_id === "string") return record.original_task_id;
  const task = record.task && typeof record.task === "object" && !Array.isArray(record.task) ? record.task as Record<string, unknown> : undefined;
  if (typeof task?.id === "string") return task.id;
  const proposal = record.proposal && typeof record.proposal === "object" && !Array.isArray(record.proposal) ? record.proposal as Record<string, unknown> : undefined;
  if (typeof proposal?.task_id === "string") return proposal.task_id;
  return undefined;
}

function inferTaskIdFromSourceId(sourceId: string) {
  const suffixes = [
    "_verification",
    "_review",
    "_approval_gate",
    "_patch_safety",
    "_repair_limit",
    "_invalid_parsed_output",
    "_repaired_parsed_output",
    "_invalid_patch_proposal",
    "_repaired_patch_proposal",
    "_scout_result",
    "_acquired",
    "_released"
  ];
  for (const suffix of suffixes) {
    if (sourceId.endsWith(suffix)) return sourceId.slice(0, -suffix.length);
  }
  return undefined;
}

function summarizeArtifactValue(value: unknown): Record<string, unknown> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) return typeof value === "string" ? { value_chars: value.length } : {};
  const summary: Record<string, unknown> = {
    top_level_keys: Object.keys(record).sort()
  };
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && entry.length <= 200) summary[key] = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") summary[key] = entry;
    else if (Array.isArray(entry)) summary[`${key}_count`] = entry.length;
    else if (entry && typeof entry === "object") summary[`${key}_keys`] = Object.keys(entry as Record<string, unknown>).sort();
  }
  return summary;
}

function contextItemTraceMetadata(contextPackId: string, item: ContextPackInclusionRecord): Record<string, unknown> {
  return {
    context_pack_id: contextPackId,
    item_id: item.item_id,
    item_type: item.item_type,
    source_type: item.source_type,
    source_ref: item.source_ref,
    source_path: item.source_path,
    inclusion_reason: item.inclusion_reason,
    relevance_score: item.relevance_score,
    confidence: item.confidence,
    freshness: item.freshness,
    access_mode: item.access_mode,
    task_id: item.task_id,
    agent_role: item.agent_role,
    evidence_ref_count: item.evidence_refs.length,
    warning_count: item.warnings.length,
    metadata_json: item.metadata_json
  };
}

function isTeamContextItem(item: ContextPackInclusionRecord) {
  return typeof item.metadata_json.team_id === "string" || String(item.source_type).startsWith("team_");
}

function sanitizeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "team";
}

function teamContextSummaryMarkdown(summary: TeamContextSummary) {
  return [
    "# Team Context Summary",
    "",
    `- team_id: ${summary.team_id}`,
    `- parent_team_id: ${summary.parent_team_id ?? "n/a"}`,
    `- domain: ${summary.domain}`,
    `- team_type: ${summary.team_type}`,
    `- memory_scope: ${summary.memory_scope}`,
    `- allowed_file_count: ${summary.allowed_file_count}`,
    `- forbidden_file_count: ${summary.forbidden_file_count}`,
    `- module_lock_count: ${summary.module_lock_count}`,
    `- semantic_lock_count: ${summary.semantic_lock_count}`,
    `- evidence_ref_count: ${summary.evidence_ref_count}`,
    `- decision_ref_count: ${summary.decision_ref_count}`,
    `- failure_ref_count: ${summary.failure_ref_count}`,
    `- warning_count: ${summary.warning_count}`,
    `- confidence: ${summary.confidence}`,
    `- freshness: ${summary.freshness}`
  ].join("\n");
}

function teamSubPlanSummaryMarkdown(summary: TeamSubPlanSummary, plan: TeamSubPlan) {
  return [
    "# Team Sub-Plan Summary",
    "",
    `- sub_plan_id: ${summary.sub_plan_id}`,
    `- team_id: ${summary.team_id}`,
    `- parent_team_id: ${summary.parent_team_id ?? "n/a"}`,
    `- status: ${summary.status}`,
    `- generation_mode: ${summary.generation_mode}`,
    `- proposed_task_count: ${summary.proposed_task_count}`,
    `- dependency_count: ${summary.dependency_count}`,
    `- risk_count: ${summary.risk_count}`,
    `- confidence: ${summary.confidence}`,
    `- artifact_ref: ${summary.artifact_ref ?? "n/a"}`,
    "",
    "## Scope",
    plan.scope_summary || "No scope summary recorded.",
    "",
    "## Proposed Tasks",
    ...(plan.proposed_tasks.length ? plan.proposed_tasks.map((task) => `- ${task.title}: ${task.objective}`) : ["- none"]),
    "",
    "## Risks",
    ...(plan.risks.length ? plan.risks.map((risk) => `- ${risk.severity}: ${risk.summary}`) : ["- none"])
  ].join("\n");
}

function teamSubPlanAggregationMarkdown(aggregation: TeamSubPlanAggregation) {
  return [
    "# Recursive Team Sub-Planning Summary",
    "",
    `- aggregation_id: ${aggregation.aggregation_id}`,
    `- status: ${aggregation.status}`,
    `- teams_planned: ${aggregation.teams_planned.length}`,
    `- teams_skipped: ${aggregation.teams_skipped.length}`,
    `- accepted_sub_plans: ${aggregation.accepted_sub_plans.length}`,
    `- invalid_sub_plans: ${aggregation.invalid_sub_plans.length}`,
    `- cross_team_dependencies: ${aggregation.cross_team_dependencies.length}`,
    `- duplicate_task_groups: ${aggregation.duplicate_task_groups.length}`,
    `- scope_conflicts: ${aggregation.scope_conflicts.length}`,
    "",
    "## Top Risks",
    ...(aggregation.top_risks.length ? aggregation.top_risks.map((risk) => `- ${risk.severity}: ${risk.summary}`) : ["- none"]),
    "",
    "## Recommended Next Step",
    aggregation.recommended_next_step
  ].join("\n");
}

function teamTaskAdoptionSummaryMarkdown(result: TeamTaskAdoptionResult) {
  return [
    "# Team Task Adoption Summary",
    "",
    `- adoption_result_id: ${result.adoption_result_id}`,
    `- drafts_evaluated: ${result.evaluated_drafts}`,
    `- adopted_metadata_only_count: ${result.summary.adopted_metadata_only_count}`,
    `- adopted_read_only_count: ${result.summary.adopted_read_only_count}`,
    `- rejected_count: ${result.summary.rejected_count}`,
    `- duplicate_count: ${result.summary.duplicate_count}`,
    `- blocked_count: ${result.summary.blocked_count}`,
    `- future_write_candidate_count: ${result.summary.future_write_candidate_count}`,
    `- executable_ready_count: ${result.summary.executable_ready_count}`,
    "",
    "## Adopted Proposals",
    ...(result.proposals.length
      ? result.proposals.map((proposal) => `- ${proposal.adopted_task_id}: ${proposal.adoption_status}; readiness=${proposal.readiness_status}; title=${proposal.title}`)
      : ["- none"]),
    "",
    "## Rejected Or Blocked Drafts",
    ...(result.decisions.filter((decision) => !decision.adopted_task_id).length
      ? result.decisions.filter((decision) => !decision.adopted_task_id).map((decision) => `- ${decision.task_draft_id}: ${decision.adoption_status}; ${decision.reason}`)
      : ["- none"])
  ].join("\n");
}

function proposedTaskGraphSummaryMarkdown(summary: ProposedTaskGraphSummary) {
  return [
    `# Proposed Task Graph ${summary.graph_id}`,
    "",
    `- status: ${summary.status}`,
    `- proposed_node_count: ${summary.proposed_node_count}`,
    `- proposed_edge_count: ${summary.proposed_edge_count}`,
    `- read_only_ready_count: ${summary.read_only_ready_count}`,
    `- future_write_candidate_count: ${summary.future_write_candidate_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- duplicate_count: ${summary.duplicate_count}`,
    `- cycle_count: ${summary.cycle_count}`,
    `- scope_overlap_count: ${summary.scope_overlap_count}`,
    "",
    "This graph is a non-executable planning representation. Nodes are not scheduled, promoted, or given write authority by this artifact."
  ].join("\n");
}

function executionReadinessSummaryMarkdown(summary: ExecutionReadinessBatch["summary"]) {
  return [
    `# Execution Readiness Summary ${summary.summary_id}`,
    "",
    `- nodes_evaluated: ${summary.nodes_evaluated}`,
    `- ready_read_only_count: ${summary.ready_read_only_count}`,
    `- future_write_candidate_count: ${summary.future_write_candidate_count}`,
    `- requires_human_approval_count: ${summary.requires_human_approval_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- rejected_count: ${summary.rejected_count}`,
    `- requires_context_count: ${summary.requires_context_count}`,
    `- requires_validation_count: ${summary.requires_validation_count}`,
    `- requires_locks_count: ${summary.requires_locks_count}`,
    "",
    "This is an approval-readiness report only. It does not schedule proposed nodes, create executable tasks, acquire locks, run validation, or invoke workers."
  ].join("\n");
}

function promotionQueueSummaryMarkdown(summary: PromotionQueueSummary) {
  return [
    `# Promotion Queue Summary ${summary.summary_id}`,
    "",
    `- promotion_requests_created: ${summary.promotion_requests_created}`,
    `- approvals_required: ${summary.approvals_required}`,
    `- approvals_granted: ${summary.approvals_granted}`,
    `- approvals_denied: ${summary.approvals_denied}`,
    `- approvals_expired: ${summary.approvals_expired}`,
    `- queue_items_created: ${summary.queue_items_created}`,
    `- queue_items_blocked: ${summary.queue_items_blocked}`,
    `- read_only_candidates: ${summary.read_only_candidates}`,
    `- write_candidates_waiting_approval: ${summary.write_candidates_waiting_approval}`,
    "",
    "This queue is bookkeeping only. Items are not scheduled, executed, assigned to workers, given write authority, or promoted into executable task graph nodes by this artifact."
  ].join("\n");
}

function executionPreparationSummaryMarkdown(summary: ExecutionPreparationSummary) {
  return [
    `# Execution Preparation Summary ${summary.summary_id}`,
    "",
    `- execution_preparation_used: ${summary.execution_preparation_used}`,
    `- preparation_plan_count: ${summary.preparation_plan_count}`,
    `- prepared_count: ${summary.prepared_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- missing_approval_count: ${summary.missing_approval_count}`,
    `- missing_context_count: ${summary.missing_context_count}`,
    `- missing_prompt_count: ${summary.missing_prompt_count}`,
    `- missing_validation_count: ${summary.missing_validation_count}`,
    `- missing_locks_count: ${summary.missing_locks_count}`,
    `- stale_context_count: ${summary.stale_context_count}`,
    "",
    "This is preparation only. Execution is not started, tasks are not scheduled, write providers are not invoked, locks are not acquired, validation commands are not run, patches are not created, and patches are not applied."
  ].join("\n");
}

function oneWriterDryRunProposalSummaryMarkdown(proposal: OneWriterDryRunProposal, scopeCheck?: PatchProposalScopeCheck) {
  return [
    `# One Writer Dry-Run Proposal ${proposal.proposal_id}`,
    "",
    `- status: ${proposal.status}`,
    `- preparation_plan_id: ${proposal.preparation_plan_id}`,
    `- writer_role: ${proposal.writer_role}`,
    `- provider_mode: ${proposal.provider_mode}`,
    `- changed_files: ${proposal.changed_files.length ? proposal.changed_files.join(", ") : "none"}`,
    `- forbidden_file_violations: ${proposal.forbidden_file_violations.length ? proposal.forbidden_file_violations.join(", ") : "none"}`,
    `- out_of_scope_changes: ${proposal.out_of_scope_changes.length ? proposal.out_of_scope_changes.join(", ") : "none"}`,
    `- scope_check_status: ${scopeCheck?.status ?? "not_run"}`,
    "",
    proposal.patch_summary || "No patch summary was accepted.",
    "",
    "This is dry-run writer output only. The patch was not applied, integrated, validated, scheduled, committed, or accepted as an executable change."
  ].join("\n");
}

function patchProposalSummaryMarkdown(summary: PatchProposalSummary) {
  return [
    `# One Writer Dry-Run Summary ${summary.summary_id}`,
    "",
    `- one_writer_dry_run_used: ${summary.one_writer_dry_run_used}`,
    `- dry_run_proposal_count: ${summary.dry_run_proposal_count}`,
    `- generated_count: ${summary.generated_count}`,
    `- schema_failed_count: ${summary.schema_failed_count}`,
    `- scope_failed_count: ${summary.scope_failed_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- review_candidate_count: ${summary.review_candidate_count}`,
    `- changed_files_preview: ${summary.changed_files_preview.length ? summary.changed_files_preview.join(", ") : "none"}`,
    "",
    "No patch was applied or integrated. Review, validation, lock acquisition, and IntegrationManager acceptance remain future gates."
  ].join("\n");
}

function patchProposalReviewSummaryMarkdown(review: PatchProposalReview) {
  return [
    `# Patch Proposal Review ${review.review_id}`,
    "",
    `- proposal_id: ${review.proposal_id}`,
    `- status: ${review.status}`,
    `- decision: ${review.decision}`,
    `- reviewer_mode: ${review.reviewer_mode}`,
    `- confidence: ${review.confidence}`,
    `- critical_findings: ${review.severity_counts.critical}`,
    `- high_findings: ${review.severity_counts.high}`,
    `- required_changes: ${review.required_changes.length ? review.required_changes.join("; ") : "none"}`,
    "",
    "This review is advisory gate output only. It does not validate, apply, integrate, schedule, or mark the patch proposal as succeeded."
  ].join("\n");
}

function patchProposalReviewBatchSummaryMarkdown(summary: PatchProposalReviewSummary) {
  return [
    `# Patch Proposal Review Summary ${summary.summary_id}`,
    "",
    `- patch_review_used: ${summary.patch_review_used}`,
    `- patch_reviews_count: ${summary.patch_reviews_count}`,
    `- accepted_for_validation_candidate_count: ${summary.accepted_for_validation_candidate_count}`,
    `- changes_requested_count: ${summary.changes_requested_count}`,
    `- rejected_count: ${summary.rejected_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- review_schema_failed_count: ${summary.review_schema_failed_count}`,
    `- critical_findings_count: ${summary.critical_findings_count}`,
    `- high_findings_count: ${summary.high_findings_count}`,
    "",
    "No validation commands were run, no locks were acquired, no patches were applied, and no integration candidates were accepted."
  ].join("\n");
}

function validationCandidateSummaryMarkdown(candidate: ValidationCandidate) {
  return [
    `# Validation Candidate ${candidate.validation_candidate_id}`,
    "",
    `- status: ${candidate.status}`,
    `- proposal_id: ${candidate.proposal_id}`,
    `- review_id: ${candidate.review_id}`,
    `- preparation_plan_id: ${candidate.preparation_plan_id}`,
    `- required_commands: ${candidate.required_commands.length ? candidate.required_commands.join("; ") : "none"}`,
    `- optional_commands: ${candidate.optional_commands.length ? candidate.optional_commands.join("; ") : "none"}`,
    `- environment_readiness: ${candidate.environment_readiness?.status ?? "not_run"}`,
    `- blockers: ${candidate.blockers.length}`,
    `- warnings: ${candidate.warnings.length}`,
    "",
    "This is validation planning and preflight only. Commands were not run, the patch was not applied, locks were not acquired, and nothing is marked validated."
  ].join("\n");
}

function validationCandidateBatchSummaryMarkdown(summary: ValidationCandidateSummary) {
  return [
    `# Validation Candidate Summary ${summary.summary_id}`,
    "",
    `- validation_candidate_used: ${summary.validation_candidate_used}`,
    `- validation_candidate_count: ${summary.validation_candidate_count}`,
    `- preflight_passed_count: ${summary.preflight_passed_count}`,
    `- incomplete_count: ${summary.incomplete_count}`,
    `- command_blocked_count: ${summary.command_blocked_count}`,
    `- environment_blocked_count: ${summary.environment_blocked_count}`,
    `- rejected_count: ${summary.rejected_count}`,
    "",
    "No validation commands were run, no patches were applied, no locks were acquired, and no integration candidates were accepted."
  ].join("\n");
}

function patchApplySandboxResultSummaryMarkdown(result: PatchApplySandboxResult) {
  return [
    `# Patch Apply Sandbox ${result.sandbox_result_id}`,
    "",
    `- status: ${result.dry_apply_status}`,
    `- sandbox_mode: ${result.sandbox_mode}`,
    `- validation_candidate_id: ${result.validation_candidate_id}`,
    `- proposal_id: ${result.proposal_id}`,
    `- review_id: ${result.review_id}`,
    `- changed_files: ${result.changed_files.length ? result.changed_files.join(", ") : "none"}`,
    `- conflict_count: ${result.conflicts.length}`,
    `- failed_hunk_count: ${result.failed_hunks.length}`,
    `- unsafe_finding_count: ${result.unsafe_findings.length}`,
    `- main_repo_modified: ${result.main_repo_modified}`,
    `- validation_run: ${result.validation_run}`,
    `- integration_created: ${result.integration_created}`,
    "",
    "This is sandbox dry-apply preflight only. It does not apply patches to the main repository, run validation commands, mark validation passed, create integration candidates, or enable execution."
  ].join("\n");
}

function patchApplySandboxBatchSummaryMarkdown(summary: PatchSandboxSummary) {
  return [
    `# Patch Apply Sandbox Summary ${summary.summary_id}`,
    "",
    `- patch_apply_sandbox_used: ${summary.patch_apply_sandbox_used}`,
    `- sandbox_result_count: ${summary.sandbox_result_count}`,
    `- dry_apply_passed_count: ${summary.dry_apply_passed_count}`,
    `- dry_apply_failed_count: ${summary.dry_apply_failed_count}`,
    `- conflict_count: ${summary.conflict_count}`,
    `- failed_hunk_count: ${summary.failed_hunk_count}`,
    `- sandbox_unavailable_count: ${summary.sandbox_unavailable_count}`,
    `- unsafe_patch_count: ${summary.unsafe_patch_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- main_repo_integrity_ok: ${summary.main_repo_integrity_ok}`,
    "",
    "No validation commands were run, no patches were applied to the main repository, and no integration candidates were accepted."
  ].join("\n");
}

function sandboxValidationResultSummaryMarkdown(result: SandboxValidationResult) {
  return [
    `# Sandbox Validation ${result.sandbox_validation_id}`,
    "",
    `- status: ${result.status}`,
    `- strict_validation_status: ${result.strict_validation_status}`,
    `- sandbox_result_id: ${result.sandbox_result_id}`,
    `- validation_candidate_id: ${result.validation_candidate_id}`,
    `- proposal_id: ${result.proposal_id}`,
    `- review_id: ${result.review_id}`,
    `- command_count: ${result.command_results.length}`,
    `- required_command_count: ${result.required_command_count}`,
    `- optional_command_count: ${result.optional_command_count}`,
    `- passed_count: ${result.passed_count}`,
    `- failed_count: ${result.failed_count}`,
    `- blocked_count: ${result.blocked_count}`,
    `- skipped_count: ${result.skipped_count}`,
    `- timed_out_count: ${result.timed_out_count}`,
    `- not_run_count: ${result.not_run_count}`,
    "",
    "This is sandbox-only validation. Commands were not run in the main repository, patches were not applied to the main repository, and no integration candidate was accepted."
  ].join("\n");
}

function sandboxValidationBatchSummaryMarkdown(summary: SandboxValidationSummary) {
  return [
    `# Sandbox Validation Summary ${summary.summary_id}`,
    "",
    `- sandbox_validation_used: ${summary.sandbox_validation_used}`,
    `- sandbox_validation_count: ${summary.sandbox_validation_count}`,
    `- sandbox_validation_passed_count: ${summary.sandbox_validation_passed_count}`,
    `- sandbox_validation_failed_count: ${summary.sandbox_validation_failed_count}`,
    `- sandbox_validation_blocked_count: ${summary.sandbox_validation_blocked_count}`,
    `- sandbox_validation_partial_count: ${summary.sandbox_validation_partial_count}`,
    `- sandbox_validation_summary_ref: ${summary.sandbox_validation_summary_ref ?? "n/a"}`,
    "",
    "Sandbox validation results are pre-integration evidence only. They do not mark the run succeeded or create accepted integration candidates."
  ].join("\n");
}

function sandboxIntegrationCandidateSummaryMarkdown(candidate: SandboxValidatedIntegrationCandidate) {
  return [
    `# Sandbox Integration Candidate ${candidate.integration_candidate_id}`,
    "",
    `- status: ${candidate.status}`,
    `- proposal_id: ${candidate.proposal_id}`,
    `- review_id: ${candidate.review_id}`,
    `- validation_candidate_id: ${candidate.validation_candidate_id}`,
    `- sandbox_result_id: ${candidate.sandbox_result_id}`,
    `- sandbox_validation_id: ${candidate.sandbox_validation_id}`,
    `- strict_validation_status: ${candidate.strict_validation_status}`,
    `- approval_required: ${candidate.approval_required}`,
    `- risk_level: ${candidate.risk_level}`,
    `- changed_files: ${candidate.changed_files.join(", ") || "none"}`,
    `- required_file_locks: ${candidate.required_file_locks.join(", ") || "none"}`,
    `- required_module_locks: ${candidate.required_module_locks.join(", ") || "none"}`,
    `- required_semantic_locks: ${candidate.required_semantic_locks.join(", ") || "none"}`,
    `- blockers: ${candidate.blockers.length}`,
    `- warnings: ${candidate.warnings.length}`,
    "",
    "This is integration candidacy only. It does not apply the patch, run validation, acquire locks, or integrate automatically."
  ].join("\n");
}

function sandboxIntegrationCandidateBatchSummaryMarkdown(summary: IntegrationCandidateSummary) {
  return [
    `# Sandbox Integration Candidate Summary ${summary.summary_id}`,
    "",
    `- sandbox_integration_candidate_used: ${summary.sandbox_integration_candidate_used}`,
    `- integration_candidate_count: ${summary.integration_candidate_count}`,
    `- candidate_created_count: ${summary.candidate_created_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- rejected_count: ${summary.rejected_count}`,
    `- validation_failed_count: ${summary.validation_failed_count}`,
    `- validation_blocked_count: ${summary.validation_blocked_count}`,
    `- candidate_summary_ref: ${summary.candidate_summary_ref ?? "n/a"}`,
    "",
    "Candidate creation records future IntegrationManager inputs only. No apply, validation command, lock acquisition, or integration occurred."
  ].join("\n");
}

function integrationApplyApprovalSummaryMarkdown(approval: IntegrationApplyApproval) {
  return [
    `# Integration Apply Approval ${approval.integration_apply_approval_id}`,
    "",
    `- status: ${approval.approval_status}`,
    `- integration_candidate_id: ${approval.integration_candidate_id}`,
    `- proposal_id: ${approval.proposal_id}`,
    `- review_id: ${approval.review_id}`,
    `- validation_candidate_id: ${approval.validation_candidate_id}`,
    `- sandbox_result_id: ${approval.sandbox_result_id}`,
    `- sandbox_validation_id: ${approval.sandbox_validation_id}`,
    `- approval_required: ${approval.approval_required}`,
    `- approver_type: ${approval.approver_type}`,
    `- worktree_safety_status: ${approval.worktree_safety_status}`,
    `- apply_mode_recommendation: ${approval.apply_mode_recommendation}`,
    `- risk_level: ${approval.risk_level}`,
    `- changed_files: ${approval.changed_files.join(", ") || "none"}`,
    `- required_file_locks: ${approval.required_file_locks.join(", ") || "none"}`,
    `- required_module_locks: ${approval.required_module_locks.join(", ") || "none"}`,
    `- required_semantic_locks: ${approval.required_semantic_locks.join(", ") || "none"}`,
    `- rollback_requirements_ref: ${approval.rollback_requirements_ref ?? "n/a"}`,
    `- post_integration_validation_plan_ref: ${approval.post_integration_validation_plan_ref ?? "n/a"}`,
    `- blockers: ${approval.blockers.length}`,
    `- warnings: ${approval.warnings.length}`,
    "",
    approval.approval_reason,
    "",
    "This is a final pre-apply approval gate record only. It does not apply patches to the main repository, acquire durable locks, run post-integration validation, mark integration passed, or mark the run succeeded."
  ].join("\n");
}

function integrationApplyApprovalBatchSummaryMarkdown(summary: IntegrationApplyApprovalSummary) {
  return [
    `# Integration Apply Approval Summary ${summary.summary_id}`,
    "",
    `- integration_apply_approval_used: ${summary.integration_apply_approval_used}`,
    `- apply_approval_count: ${summary.apply_approval_count}`,
    `- approved_for_apply_candidate_count: ${summary.approved_for_apply_candidate_count}`,
    `- requires_human_approval_count: ${summary.requires_human_approval_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- rejected_count: ${summary.rejected_count}`,
    `- dirty_worktree_blocked_count: ${summary.dirty_worktree_blocked_count}`,
    `- apply_mode_recommendation_count: ${summary.apply_mode_recommendation_count}`,
    `- apply_approval_summary_ref: ${summary.apply_approval_summary_ref ?? "n/a"}`,
    "",
    "Apply approvals are future-apply eligibility records only. No main-repository apply, lock acquisition, validation command, integration pass, or run success transition occurred."
  ].join("\n");
}

function promptTraceMetadata(rendered: RenderedPrompt, artifactRef: string): Record<string, unknown> {
  return {
    prompt_id: rendered.prompt_id,
    template_id: rendered.template_id,
    template_version: rendered.template_version,
    prompt_type: rendered.prompt_type,
    agent_role: rendered.agent_role,
    input_hash: rendered.input_hash,
    rendered_prompt_hash: rendered.rendered_prompt_hash,
    context_pack_ref: rendered.context_pack_ref,
    artifact_ref: artifactRef,
    task_id: rendered.task_id,
    run_id: rendered.run_id,
    output_schema_name: rendered.output_schema_name,
    renderer_version: rendered.renderer_version,
    template_input_schema_version: rendered.template_input_schema_version
  };
}

function promptQualityTraceMetadata(result: PromptQualityResult, artifactRef: string): Record<string, unknown> {
  return {
    quality_result_id: result.quality_result_id,
    prompt_id: result.prompt_id,
    template_id: result.metadata_json.template_id,
    template_version: result.metadata_json.template_version,
    role_profile: result.role_profile,
    status: result.status,
    blocking: result.blocking,
    checks_passed_count: result.checks_passed_count,
    warnings_count: result.warnings_count,
    failures_count: result.failures_count,
    blocked_count: result.blocked_count,
    artifact_ref: artifactRef,
    run_id: result.run_id,
    task_id: result.task_id,
    agent_role: result.agent_role,
    unsafe_pattern_count: result.unsafe_pattern_hits.length,
    metadata_mismatch_count: Object.values(result.consistency_checks).filter((status) => status === "failed" || status === "blocked").length
  };
}

function qualityArtifactRefs(result: PromptQualityResult) {
  return [
    typeof result.checked_metadata.prompt_artifact_ref === "string" ? result.checked_metadata.prompt_artifact_ref : "",
    typeof result.checked_metadata.context_pack_ref === "string" ? result.checked_metadata.context_pack_ref : ""
  ].filter(Boolean);
}

function summarizeAgentTeam(team: AgentTeam, artifactRef: string): Record<string, unknown> {
  return {
    team_id: team.team_id,
    parent_team_id: team.parent_team_id,
    team_type: team.team_type,
    domain: team.domain,
    status: team.status,
    memory_scope: team.memory_scope.scope_id,
    allowed_file_count: team.allowed_files.length,
    forbidden_file_count: team.forbidden_files.length,
    module_locks: team.module_locks,
    semantic_locks: team.semantic_locks,
    budgets: team.budgets,
    artifact_ref: artifactRef
  };
}

function reviewTraceType(value: unknown) {
  const decision = stringProperty(value, "decision") ?? stringProperty(value, "status");
  return decision && decision !== "accept" && decision !== "succeeded" ? "review_requested_changes" : "review_completed";
}

function validationTraceType(value: unknown) {
  const status = stringProperty(value, "status") ?? resultStatus(value);
  if (status === "failed") return "validation_failed";
  if (status === "blocked") return "validation_blocked";
  if (status === "skipped") return "validation_skipped";
  if (status === "not_run") return "validation_not_run";
  if (status === "partial") return "validation_partial";
  if (status === "not_required") return "validation_not_required";
  return "validation_completed";
}

function integrationTraceType(value: unknown) {
  const status = stringProperty(value, "final_status") ?? stringProperty(value, "status");
  if (status === "not_required") return "integration_not_required";
  if (status === "blocked") return "integration_blocked";
  if (status === "partial") return "integration_blocked";
  if (status === "passed" || status === "applied") return "integration_passed";
  return status === "failed" ? "integration_failed" : "integration_completed";
}

function repairTraceType(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return record?.repair_task ? "task_created" : "artifact_written";
}

function resultStatus(value: unknown) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const result = record?.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result as Record<string, unknown> : undefined;
  if (typeof result?.status === "string") return result.status;
  if (typeof result?.passed === "boolean") return result.passed ? "passed" : "failed";
  if (typeof record?.passed === "boolean") return record.passed ? "passed" : "failed";
  return undefined;
}

function stringProperty(value: unknown, key: string) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const entry = record?.[key];
  return typeof entry === "string" ? entry : undefined;
}
