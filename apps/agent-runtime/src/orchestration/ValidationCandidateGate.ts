import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolveFactoryMetadataDatabasePath, FactoryMetadataAdapter, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionPreparationPlan } from "./ExecutionPreparationModels.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import { readJson, readMemorySnapshot } from "../memory/ProjectMemory.js";
import type { CommandInventory } from "../memory/types.js";
import { runValidationPreflightCheck, type ValidationPlanDraft } from "./ValidationPreflightChecker.js";
import {
  createValidationCandidate,
  createValidationCandidateBatch,
  createValidationCandidateBlocker,
  createValidationCandidateResult,
  createValidationCandidateSummary,
  createValidationCandidateWarning,
  type ValidationCandidate,
  type ValidationCandidateBatch,
  type ValidationCandidateBlocker,
  type ValidationCandidateResult,
  type ValidationCandidateStatus,
  type ValidationCandidateWarning
} from "./ValidationCandidateModels.js";

export type ValidationCandidateGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type ValidationCandidateBatchOptions = {
  reviewIds?: string[];
};

type ReviewEligibility = {
  eligible: boolean;
  status: ValidationCandidateStatus;
  blockers: ValidationCandidateBlocker[];
  warnings: ValidationCandidateWarning[];
  proposal?: OneWriterDryRunProposal;
  preparation?: ExecutionPreparationPlan;
};

type CandidateInput = {
  review: PatchProposalReview;
  proposal: OneWriterDryRunProposal;
  preparation?: ExecutionPreparationPlan;
};

export class ValidationCandidateGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: ValidationCandidateGateOptions) {
    this.workspacePath = options.workspacePath;
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(options.workspacePath, options.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: options.workspacePath, memoryDir: options.memoryDir, sourceComponent: "ValidationCandidateGate" });
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
  }

  async createValidationCandidateFromReview(review: PatchProposalReview): Promise<ValidationCandidateResult> {
    const candidateId = `validation_candidate_${randomUUID()}`;
    await this.traceWriter.write({
      run_id: review.run_id,
      event_type: "validation_candidate_started",
      lifecycle_stage: "planning",
      summary: `Validation candidate gate started for review ${review.review_id}.`,
      artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { validation_candidate_id: candidateId, review_id: review.review_id, proposal_id: review.proposal_id, no_validation_run: true, no_patch_applied: true }
    });

    const eligibility = await this.validateReviewForCandidate(review, candidateId);
    if (!eligibility.eligible || !eligibility.proposal) {
      const candidate = this.baseCandidate(review, candidateId, eligibility.proposal, eligibility.preparation, eligibility.status, eligibility.blockers, eligibility.warnings);
      await this.persistValidationCandidate(candidate, { candidateInput: { review, proposal: eligibility.proposal, preparation: eligibility.preparation } });
      await this.traceWriter.write({
        run_id: review.run_id,
        event_type: "validation_candidate_rejected",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: `Validation candidate rejected for review ${review.review_id}.`,
        reason: eligibility.blockers[0]?.reason,
        artifact_refs: [candidate.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { validation_candidate_id: candidate.validation_candidate_id, status: candidate.status, no_validation_run: true, no_patch_applied: true }
      });
      return createValidationCandidateResult({
        run_id: review.run_id,
        review_id: review.review_id,
        candidate,
        status: candidate.status,
        blockers: candidate.blockers,
        warnings: candidate.warnings,
        artifact_refs: [candidate.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { no_validation_run: true, no_patch_applied: true }
      });
    }

    const candidate = this.baseCandidate(review, candidateId, eligibility.proposal, eligibility.preparation, "candidate_created", eligibility.blockers, eligibility.warnings);
    const plan = this.buildValidationPlan({ review, proposal: eligibility.proposal, preparation: eligibility.preparation });
    candidate.required_commands = plan.required_commands;
    candidate.optional_commands = plan.optional_commands;
    candidate.strict_validation_semantics_ref = plan.strict_validation_semantics_ref;
    candidate.expected_validation_outputs = expectedOutputs(plan);
    candidate.validation_plan_ref = candidate.validation_plan_ref ?? eligibility.proposal.validation_plan_ref ?? eligibility.preparation?.validation_plan_ref;

    if (!plan.required_commands.length && !plan.not_required_reason) {
      candidate.status = "missing_validation_plan";
      candidate.blockers.push(blocker(candidate.validation_candidate_id, "missing_validation_plan", "Validation plan is missing required commands and has no explicit not_required reason.", [review.review_id, review.proposal_id]));
      await this.persistValidationCandidate(candidate, { candidateInput: { review, proposal: eligibility.proposal, preparation: eligibility.preparation }, validationPlan: plan });
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "validation_candidate_rejected",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Validation candidate missing validation plan.",
        reason: candidate.blockers.at(-1)?.reason,
        artifact_refs: [candidate.artifact_ref, candidate.validation_plan_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { validation_candidate_id: candidate.validation_candidate_id, status: candidate.status }
      });
      return createValidationCandidateResult({
        run_id: candidate.run_id,
        review_id: review.review_id,
        candidate,
        status: candidate.status,
        blockers: candidate.blockers,
        warnings: candidate.warnings,
        artifact_refs: [candidate.artifact_ref, candidate.validation_plan_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { no_validation_run: true, no_patch_applied: true }
      });
    }

    if (planClaimsValidationPassed(plan, review)) {
      candidate.status = "rejected";
      candidate.blockers.push(blocker(candidate.validation_candidate_id, "incomplete_plan", "Validation plan or review recommendation claims validation already passed.", [review.review_id]));
      await this.persistValidationCandidate(candidate, { candidateInput: { review, proposal: eligibility.proposal, preparation: eligibility.preparation }, validationPlan: plan });
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "validation_candidate_rejected",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Validation candidate rejected because plan claimed validation had passed.",
        reason: candidate.blockers.at(-1)?.reason,
        metadata_json: { validation_candidate_id: candidate.validation_candidate_id, no_validation_run: true }
      });
      return createValidationCandidateResult({
        run_id: candidate.run_id,
        review_id: review.review_id,
        candidate,
        status: candidate.status,
        blockers: candidate.blockers,
        warnings: candidate.warnings,
        artifact_refs: [candidate.artifact_ref, candidate.validation_plan_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { no_validation_run: true, no_patch_applied: true }
      });
    }

    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "validation_candidate_created",
      lifecycle_stage: "planning",
      summary: `Validation candidate created for review ${review.review_id}.`,
      artifact_refs: [candidate.patch_artifact_ref, candidate.review_artifact_ref, candidate.validation_plan_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { validation_candidate_id: candidate.validation_candidate_id, required_command_count: plan.required_commands.length, no_validation_run: true }
    });

    if (this.config.validation_candidate_mode === "report_only") {
      await this.persistValidationCandidate(candidate, {
        candidateInput: { review, proposal: eligibility.proposal, preparation: eligibility.preparation },
        validationPlan: plan
      });
      return createValidationCandidateResult({
        run_id: candidate.run_id,
        review_id: review.review_id,
        candidate,
        status: candidate.status,
        blockers: candidate.blockers,
        warnings: candidate.warnings,
        artifact_refs: [candidate.artifact_ref, candidate.validation_plan_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { no_validation_run: true, no_patch_applied: true, report_only: true }
      });
    }

    const preflight = await this.runValidationPreflight(candidate, plan);
    candidate.command_safety_results = preflight.command_preflights;
    candidate.environment_readiness = preflight.environment_readiness;
    candidate.status = statusFromPreflight(
      preflight.status,
      preflight.environment_readiness.status,
      preflight.command_preflights.some((entry) => entry.required && (
        ["blocked", "not_allowed", "missing", "requires_environment", "requires_human_approval"].includes(entry.safety_status)
        || (entry.safety_status === "unknown" && (this.config.block_unknown_required_commands ?? true))
      ))
    );
    candidate.warnings.push(...warningsFromPreflight(candidate.validation_candidate_id, preflight));
    if (candidate.status === "command_blocked") candidate.blockers.push(blocker(candidate.validation_candidate_id, "command_blocked", "One or more required validation commands are blocked or unknown.", [review.review_id]));
    if (candidate.status === "environment_blocked") candidate.blockers.push(blocker(candidate.validation_candidate_id, "environment_blocked", "Validation environment preflight is blocked.", [review.review_id]));
    if (candidate.status === "incomplete") candidate.blockers.push(blocker(candidate.validation_candidate_id, "incomplete_plan", "Validation plan preflight is incomplete.", [review.review_id]));
    await this.persistValidationCandidate(candidate, {
      candidateInput: { review, proposal: eligibility.proposal, preparation: eligibility.preparation },
      validationPlan: plan,
      preflight
    });

    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: candidate.status === "preflight_passed" ? "validation_candidate_preflight_passed" : "validation_candidate_preflight_blocked",
      lifecycle_stage: candidate.status === "preflight_passed" ? "planning" : "blocked",
      severity: candidate.status === "preflight_passed" ? "info" : "warning",
      summary: `Validation candidate preflight ${candidate.status}.`,
      reason: candidate.blockers[0]?.reason,
      artifact_refs: [candidate.artifact_ref, candidate.command_preflight_ref, candidate.environment_preflight_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { validation_candidate_id: candidate.validation_candidate_id, status: candidate.status, no_validation_run: true, no_patch_applied: true }
    });

    return createValidationCandidateResult({
      run_id: candidate.run_id,
      review_id: review.review_id,
      candidate,
      status: candidate.status,
      blockers: candidate.blockers,
      warnings: candidate.warnings,
      artifact_refs: [candidate.artifact_ref, candidate.validation_plan_artifact_ref, candidate.command_preflight_ref, candidate.environment_preflight_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_validation_run: true, no_patch_applied: true }
    });
  }

  async createValidationCandidateBatch(runId: string, options: ValidationCandidateBatchOptions = {}): Promise<ValidationCandidateBatch> {
    const reviews = await this.loadAcceptedReviewsForRun(runId, options.reviewIds);
    const limit = this.config.max_validation_candidates_per_run ?? 12;
    const candidates: ValidationCandidate[] = [];
    for (const review of reviews.slice(0, limit)) {
      const result = await this.createValidationCandidateFromReview(review);
      if (result.candidate) candidates.push(result.candidate);
    }
    const summary = this.summarizeValidationCandidates(candidates, runId);
    const batch = createValidationCandidateBatch({
      run_id: runId,
      review_ids: reviews.slice(0, limit).map((review) => review.review_id),
      candidates,
      summary,
      metadata_json: { no_validation_run: true, no_patch_applied: true }
    });
    const refs = await this.artifactStore.saveValidationCandidateBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.validation_candidate_summary_ref = refs.summaryRef;
    await this.metadata.recordValidationCandidateBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "validation_candidate_batch_completed",
      lifecycle_stage: "planning",
      summary: `Validation candidate batch completed with ${candidates.length} candidate(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...summary, no_validation_run: true, no_patch_applied: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "validation_candidate_summary_created",
      lifecycle_stage: "planning",
      summary: "Validation candidate summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { summary_id: summary.summary_id, no_validation_run: true }
    });
    return batch;
  }

  async validateReviewForCandidate(review: PatchProposalReview, candidateId = `validation_candidate_${randomUUID()}`): Promise<ReviewEligibility> {
    const blockers: ValidationCandidateBlocker[] = [];
    const warnings: ValidationCandidateWarning[] = [];
    const proposal = await this.loadProposal(review);
    const preparation = proposal ? await this.loadPreparation(proposal) : undefined;
    if (this.config.enable_validation_candidate_gate === false || this.config.validation_candidate_mode === "off") {
      blockers.push(blocker(candidateId, "validation_candidate_disabled", "Validation candidate gate is disabled.", [review.review_id]));
      return { eligible: false, status: "not_required", blockers, warnings, proposal, preparation };
    }
    if (review.decision !== "accept_for_validation_candidate") blockers.push(blocker(candidateId, "ineligible_review", `Review decision is ${review.decision}, not accept_for_validation_candidate.`, [review.review_id]));
    if (!["accepted_for_validation_candidate", "reviewed"].includes(review.status)) blockers.push(blocker(candidateId, "ineligible_review", `Review status is ${review.status}, not accepted/reviewed.`, [review.review_id]));
    if (review.findings.some((finding) => finding.blocking || finding.severity === "critical")) blockers.push(blocker(candidateId, "ineligible_review", "Review has blocking or critical findings.", [review.review_id]));
    if (!proposal) blockers.push(blocker(candidateId, "missing_proposal", "Patch proposal artifact could not be loaded.", [review.proposal_id]));
    if (proposal && proposal.status !== "accepted_for_review_candidate") blockers.push(blocker(candidateId, "ineligible_review", `Patch proposal status is ${proposal.status}.`, [proposal.proposal_id]));
    if (proposal && (!proposal.patch_artifact_ref || !refLooksPresent(proposal.patch_artifact_ref))) blockers.push(blocker(candidateId, "missing_patch_artifact", "Patch artifact ref is missing or unavailable.", [proposal.proposal_id]));
    if (proposal && proposal.scope_check_result?.status !== "passed") blockers.push(blocker(candidateId, "ineligible_review", "Patch proposal scope check has not passed.", [proposal.proposal_id]));
    if (proposal && !review.validation_recommendations.length && !proposal.validation_plan_ref && !preparation?.validation_plan.required_commands.length && preparation?.validation_plan.status !== "not_required") {
      warnings.push(createValidationCandidateWarning({
        validation_candidate_id: candidateId,
        warning_type: "environment_warning",
        severity: "warning",
        message: "Review has no validation recommendations and preparation has no validation plan; candidate may become incomplete.",
        refs: [review.review_id, proposal.proposal_id]
      }));
    }
    warnings.push(createValidationCandidateWarning({
      validation_candidate_id: candidateId,
      warning_type: "preflight_only",
      severity: "info",
      message: "Validation candidate gate performs static preflight only; no commands are run.",
      refs: [review.review_id]
    }));
    return { eligible: blockers.length === 0, status: blockers.length ? "rejected" : "candidate_created", blockers, warnings, proposal, preparation };
  }

  buildValidationPlan(input: CandidateInput): ValidationPlanDraft {
    const metadata = metadataRecord(input.preparation?.validation_plan.metadata_json);
    const reviewMetadata = metadataRecord(input.review.metadata_json);
    const requiredCommands = uniqueStrings([
      ...(input.preparation?.validation_plan.required_commands ?? []),
      ...stringArray(metadata.required_commands)
    ]);
    const optionalCommands = uniqueStrings([
      ...stringArray(metadata.optional_commands),
      ...stringArray(reviewMetadata.optional_validation_commands)
    ]).filter((command) => !requiredCommands.includes(command));
    const commandMetadata = commandMetadataFrom(metadata.command_metadata, [...requiredCommands, ...optionalCommands]);
    const notRequiredReason = stringValue(reviewMetadata.validation_not_required_reason)
      ?? stringValue(metadata.not_required_reason)
      ?? (input.preparation?.validation_plan.status === "not_required" ? "Preparation validation plan marked validation not required." : undefined);
    return {
      required_commands: requiredCommands,
      optional_commands: optionalCommands,
      command_metadata: commandMetadata,
      not_required_reason: notRequiredReason,
      strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1"
    };
  }

  async runValidationPreflight(candidate: ValidationCandidate, plan?: ValidationPlanDraft) {
    const validationPlan = plan ?? this.planFromCandidate(candidate);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "validation_candidate_preflight_started",
      lifecycle_stage: "planning",
      summary: `Validation candidate preflight started for ${candidate.validation_candidate_id}.`,
      metadata_json: { validation_candidate_id: candidate.validation_candidate_id, no_validation_run: true }
    });
    const commandInventory = await this.loadCommandInventory();
    const preflight = runValidationPreflightCheck({
      workspacePath: this.workspacePath,
      config: this.config,
      commandInventory,
      validationPlan,
      candidate
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: preflight.command_preflights.some((entry) => entry.required && entry.safety_status !== "safe") ? "validation_command_preflight_blocked" : "validation_command_preflight_checked",
      lifecycle_stage: preflight.status === "blocked" ? "blocked" : "planning",
      severity: preflight.status === "blocked" ? "warning" : "info",
      summary: `Validation command preflight checked ${preflight.command_preflights.length} command(s).`,
      metadata_json: {
        validation_candidate_id: candidate.validation_candidate_id,
        command_count: preflight.command_preflights.length,
        blocked_count: preflight.command_preflights.filter((entry) => entry.required && entry.safety_status !== "safe").length,
        no_validation_run: true
      }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "validation_environment_preflight_checked",
      lifecycle_stage: preflight.environment_readiness.status === "blocked" ? "blocked" : "planning",
      severity: preflight.environment_readiness.status === "blocked" ? "warning" : "info",
      summary: `Validation environment preflight ${preflight.environment_readiness.status}.`,
      metadata_json: {
        validation_candidate_id: candidate.validation_candidate_id,
        environment_status: preflight.environment_readiness.status,
        no_shell_commands_run: true
      }
    });
    return preflight;
  }

  async persistValidationCandidate(candidate: ValidationCandidate, artifacts: {
    candidateInput?: Partial<CandidateInput>;
    validationPlan?: ValidationPlanDraft;
    preflight?: ReturnType<typeof runValidationPreflightCheck>;
  } = {}) {
    const refs = await this.artifactStore.saveValidationCandidateArtifacts({
      candidate,
      candidateInput: artifacts.candidateInput,
      validationPlan: artifacts.validationPlan,
      preflight: artifacts.preflight
    });
    candidate.artifact_ref = refs.candidateRef;
    candidate.validation_plan_artifact_ref = refs.validationPlanRef;
    candidate.command_preflight_ref = refs.commandPreflightRef;
    candidate.environment_preflight_ref = refs.environmentPreflightRef;
    await this.metadata.recordValidationCandidateSaved(candidate);
    return candidate;
  }

  summarizeValidationCandidates(candidates: ValidationCandidate[], runId = candidates[0]?.run_id ?? "") {
    return createValidationCandidateSummary({
      run_id: runId,
      validation_candidate_used: candidates.length > 0,
      validation_candidate_count: candidates.length,
      preflight_passed_count: candidates.filter((candidate) => candidate.status === "preflight_passed").length,
      incomplete_count: candidates.filter((candidate) => candidate.status === "incomplete" || candidate.status === "missing_validation_plan").length,
      command_blocked_count: candidates.filter((candidate) => candidate.status === "command_blocked").length,
      environment_blocked_count: candidates.filter((candidate) => candidate.status === "environment_blocked").length,
      rejected_count: candidates.filter((candidate) => candidate.status === "rejected" || candidate.status === "blocked").length,
      metadata_json: { preflight_only: true, no_validation_run: true, no_patch_applied: true }
    });
  }

  private baseCandidate(
    review: PatchProposalReview,
    candidateId: string,
    proposal: OneWriterDryRunProposal | undefined,
    preparation: ExecutionPreparationPlan | undefined,
    status: ValidationCandidateStatus,
    blockers: ValidationCandidateBlocker[],
    warnings: ValidationCandidateWarning[]
  ): ValidationCandidate {
    return createValidationCandidate({
      validation_candidate_id: candidateId,
      run_id: review.run_id,
      proposal_id: review.proposal_id,
      review_id: review.review_id,
      preparation_plan_id: review.preparation_plan_id,
      proposed_node_id: review.proposed_node_id,
      patch_artifact_ref: proposal?.patch_artifact_ref,
      review_artifact_ref: review.review_artifact_ref,
      validation_plan_ref: proposal?.validation_plan_ref ?? preparation?.validation_plan_ref,
      required_commands: [],
      optional_commands: [],
      command_safety_results: [],
      expected_validation_outputs: [],
      strict_validation_semantics_ref: "ValidationSemantics.aggregateValidationStatus:v1",
      status,
      blockers,
      warnings,
      metadata_json: {
        review_decision: review.decision,
        review_status: review.status,
        proposal_status: proposal?.status,
        preparation_status: preparation?.status,
        validation_not_run: true,
        patch_not_applied: true
      }
    });
  }

  private async loadAcceptedReviewsForRun(runId: string, reviewIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = reviewIds?.length
        ? store.all<{ review_artifact_ref?: string }>(
          `SELECT review_artifact_ref FROM factory_patch_proposal_reviews
           WHERE run_id = ? AND review_id IN (${reviewIds.map(() => "?").join(",")})
           ORDER BY created_at`,
          runId,
          ...reviewIds
        )
        : store.all<{ review_artifact_ref?: string }>(
          `SELECT review_artifact_ref FROM factory_patch_proposal_reviews
           WHERE run_id = ? AND decision = 'accept_for_validation_candidate'
           AND status IN ('accepted_for_validation_candidate', 'reviewed')
           ORDER BY created_at`,
          runId
        );
      const reviews: PatchProposalReview[] = [];
      for (const row of rows) {
        if (row.review_artifact_ref && existsSync(row.review_artifact_ref)) {
          reviews.push(await readJson<PatchProposalReview>(row.review_artifact_ref));
        }
      }
      return reviews;
    } finally {
      store.close();
    }
  }

  private async loadProposal(review: PatchProposalReview) {
    const proposalRef = await this.artifactRefFor("factory_one_writer_dry_run_proposals", "proposal_id", review.proposal_id, "artifact_ref");
    if (!proposalRef || !existsSync(proposalRef)) return undefined;
    return readJson<OneWriterDryRunProposal>(proposalRef);
  }

  private async loadPreparation(proposal: OneWriterDryRunProposal) {
    const preparationRef = await this.artifactRefFor("factory_execution_preparation_plans", "preparation_plan_id", proposal.preparation_plan_id, "artifact_ref");
    if (!preparationRef || !existsSync(preparationRef)) return undefined;
    return readJson<ExecutionPreparationPlan>(preparationRef);
  }

  private async artifactRefFor(table: string, idColumn: string, id: string, refColumn: string) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>(`SELECT ${refColumn} FROM ${table} WHERE ${idColumn} = ?`, id);
      const ref = row?.[refColumn];
      return typeof ref === "string" && ref.length ? ref : undefined;
    } finally {
      store.close();
    }
  }

  private async loadCommandInventory(): Promise<CommandInventory | undefined> {
    return readMemorySnapshot<CommandInventory>(this.workspacePath, "command_inventory", this.memoryDir);
  }

  private planFromCandidate(candidate: ValidationCandidate): ValidationPlanDraft {
    return {
      required_commands: candidate.required_commands,
      optional_commands: candidate.optional_commands,
      command_metadata: commandMetadataFrom({}, [...candidate.required_commands, ...candidate.optional_commands]),
      strict_validation_semantics_ref: candidate.strict_validation_semantics_ref ?? "ValidationSemantics.aggregateValidationStatus:v1"
    };
  }
}

function blocker(candidateId: string, type: ValidationCandidateBlocker["blocker_type"], reason: string, refs: string[] = []) {
  return createValidationCandidateBlocker({
    validation_candidate_id: candidateId,
    blocker_type: type,
    severity: "blocking",
    reason,
    refs
  });
}

function statusFromPreflight(status: "passed" | "blocked" | "incomplete", environmentStatus: "ready" | "warning" | "blocked", requiredCommandBlocked: boolean): ValidationCandidateStatus {
  if (environmentStatus === "blocked") return "environment_blocked";
  if (requiredCommandBlocked) return "command_blocked";
  if (status === "incomplete") return "incomplete";
  if (status === "blocked") return "blocked";
  return "preflight_passed";
}

function warningsFromPreflight(candidateId: string, preflight: ReturnType<typeof runValidationPreflightCheck>) {
  const warnings: ValidationCandidateWarning[] = [];
  for (const command of preflight.command_preflights.filter((entry) => !entry.required && entry.safety_status !== "safe")) {
    warnings.push(createValidationCandidateWarning({
      validation_candidate_id: candidateId,
      warning_type: command.safety_status === "unknown" ? "unknown_optional_command" : "optional_command_blocked",
      severity: "warning",
      message: `Optional validation command is ${command.safety_status}: ${command.command}.`,
      refs: [command.command],
      metadata_json: { safety_status: command.safety_status, no_validation_run: true }
    }));
  }
  if (!preflight.environment_readiness.command_inventory_available) {
    warnings.push(createValidationCandidateWarning({
      validation_candidate_id: candidateId,
      warning_type: "missing_command_inventory",
      severity: "warning",
      message: "Command inventory was not available for static preflight.",
      refs: []
    }));
  }
  warnings.push(createValidationCandidateWarning({
    validation_candidate_id: candidateId,
    warning_type: "patch_not_applied_expected",
    severity: "info",
    message: "Patch remains unapplied; validation has not run.",
    refs: []
  }));
  return warnings;
}

function expectedOutputs(plan: ValidationPlanDraft) {
  return uniqueStrings([
    ...Object.values(plan.command_metadata).map((metadata) => metadata.expected_output).filter(Boolean),
    plan.not_required_reason ? `No validation commands required: ${plan.not_required_reason}` : undefined
  ]);
}

function commandMetadataFrom(value: unknown, commands: string[]) {
  const source = metadataRecord(value);
  const result: ValidationPlanDraft["command_metadata"] = {};
  for (const command of commands) {
    const entry = metadataRecord(source[command]);
    result[command] = {
      purpose: stringValue(entry.purpose) ?? "Required validation command from the prepared execution plan.",
      expected_output: stringValue(entry.expected_output) ?? "A validation artifact whose result is mapped by strict validation semantics.",
      fallback_behavior: stringValue(entry.fallback_behavior) ?? "If unavailable, record blocked/not_run and do not mark validation passed."
    };
  }
  return result;
}

function planClaimsValidationPassed(plan: ValidationPlanDraft, review: PatchProposalReview) {
  const text = [
    ...review.validation_recommendations,
    ...plan.required_commands,
    ...plan.optional_commands,
    ...Object.values(plan.command_metadata).flatMap((metadata) => [metadata.purpose, metadata.expected_output, metadata.fallback_behavior])
  ].join("\n").toLowerCase()
    .replace(/\bdo not\s+(?:mark|claim|state|report)\s+(?:that\s+)?(?:the\s+)?(?:validation|tests?|lint|build|typecheck)\s+(?:passed|succeeded|green|complete)\b/g, "")
    .replace(/\bnot\s+(?:validated|passed|applied|integrated)\b/g, "");
  return /\b(validation|tests?|lint|build|typecheck)\s+(passed|succeeded|green|complete)\b/.test(text);
}

function refLooksPresent(ref: string) {
  return !ref.length ? false : existsSync(ref) || !/[\\/]/.test(ref);
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}
