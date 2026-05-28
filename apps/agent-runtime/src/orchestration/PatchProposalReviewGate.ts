import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolveFactoryMetadataDatabasePath, FactoryMetadataAdapter, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionPreparationPlan } from "./ExecutionPreparationModels.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import {
  countSeverities,
  createPatchProposalReview,
  createPatchProposalReviewBatch,
  createPatchProposalReviewBlocker,
  createPatchProposalReviewFinding,
  createPatchProposalReviewRequest,
  createPatchProposalReviewResult,
  createPatchProposalReviewSummary,
  createPatchProposalReviewWarning,
  type PatchProposalReview,
  type PatchProposalReviewBatch,
  type PatchProposalReviewBlocker,
  type PatchProposalReviewDecision,
  type PatchProposalReviewFinding,
  type PatchProposalReviewProvider,
  type PatchProposalReviewProviderInput,
  type PatchProposalReviewProviderResult,
  type PatchProposalReviewRequest,
  type PatchProposalReviewResult,
  type PatchProposalReviewStatus,
  type PatchProposalReviewWarning
} from "./PatchProposalReviewModels.js";
import {
  parsePatchProposalReviewOutput,
  validatePatchProposalReviewOutput,
  type ParsedPatchProposalReviewOutput
} from "./PatchProposalReviewSchemas.js";
import { evaluatePromptQuality, isPromptQualityBlocking } from "./PromptQualityGate.js";
import { hashPromptInput, hashRenderedPrompt, renderRolePrompt, type RenderedPrompt } from "./PromptSystem.js";
import { readJson } from "../memory/ProjectMemory.js";

export type PatchProposalReviewGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  provider?: PatchProposalReviewProvider;
};

export type PatchProposalReviewBatchOptions = {
  proposalIds?: string[];
};

type EligibilityResult = {
  eligible: boolean;
  status: PatchProposalReviewStatus;
  blockers: PatchProposalReviewBlocker[];
  warnings: PatchProposalReviewWarning[];
};

export class PatchProposalReviewGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly provider?: PatchProposalReviewProvider;

  constructor(options: PatchProposalReviewGateOptions) {
    this.workspacePath = options.workspacePath;
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(options.workspacePath, options.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: options.workspacePath, memoryDir: options.memoryDir, sourceComponent: "PatchProposalReviewGate" });
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.provider = options.provider;
  }

  async reviewPatchProposal(proposal: OneWriterDryRunProposal, request?: PatchProposalReviewRequest): Promise<PatchProposalReviewResult> {
    const reviewId = `patch_review_${randomUUID()}`;
    const reviewRequest = request ?? createPatchProposalReviewRequest({
      run_id: proposal.run_id,
      proposal_ids: [proposal.proposal_id],
      requested_by: "PatchProposalReviewGate",
      mode: this.config.patch_proposal_review_mode ?? "off"
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_review_started",
      lifecycle_stage: "planning",
      summary: `Patch proposal review started for ${proposal.proposal_id}.`,
      artifact_refs: [proposal.artifact_ref, proposal.patch_artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { review_id: reviewId, proposal_id: proposal.proposal_id, no_validation_run: true, no_apply: true }
    });

    const eligibility = await this.validateProposalForReview(proposal, reviewId);
    if (!eligibility.eligible) {
      const review = this.createBaseReview(proposal, reviewId, eligibility.status, "block", eligibility.blockers, eligibility.warnings);
      await this.persistReview(review);
      await this.traceWriter.write({
        run_id: review.run_id,
        event_type: "patch_proposal_review_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: `Patch proposal review blocked for ${proposal.proposal_id}.`,
        reason: eligibility.blockers[0]?.reason,
        artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id }
      });
      return createPatchProposalReviewResult({
        run_id: review.run_id,
        proposal_id: proposal.proposal_id,
        review,
        status: review.status,
        blockers: eligibility.blockers,
        warnings: eligibility.warnings,
        artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: false, no_validation_run: true, no_apply: true }
      });
    }

    const prompt = await this.buildReviewPrompt(proposal, reviewId);
    const promptMetadata = await this.artifactStore.savePromptArtifact(prompt);
    const quality = evaluatePromptQuality(prompt, {
      promptArtifactRef: promptMetadata.artifact_ref,
      promptMetadata,
      contextPackRef: proposal.context_pack_ref,
      allowedFiles: proposal.allowed_files,
      forbiddenFiles: proposal.forbidden_files,
      validationRequirements: [],
      stopConditions: ["Stop if proposal scope, schema, review policy, or preparation refs are missing."],
      successCriteria: ["Structured patch proposal review output only."],
      expectedOutputSchema: "PatchProposalReviewOutput"
    });
    const qualityRef = await this.artifactStore.savePromptQualityResult(quality);
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_review_prompt_checked",
      lifecycle_stage: isPromptQualityBlocking(quality) ? "blocked" : "planning",
      severity: isPromptQualityBlocking(quality) ? "warning" : "info",
      summary: `Patch proposal review prompt quality ${quality.status}.`,
      artifact_refs: [promptMetadata.artifact_ref, qualityRef],
      metadata_json: { review_id: reviewId, proposal_id: proposal.proposal_id, prompt_id: prompt.prompt_id, status: quality.status }
    });
    if (isPromptQualityBlocking(quality)) {
      const blockers = [blocker(reviewId, "prompt_quality_blocked", `PromptQualityGate returned ${quality.status}.`, [qualityRef])];
      const review = this.createBaseReview(proposal, reviewId, "blocked", "block", blockers, eligibility.warnings);
      review.prompt_id = prompt.prompt_id;
      review.prompt_quality_result_ref = qualityRef;
      await this.persistReview(review, { reviewInput: this.providerInput(reviewRequest, proposal, review, prompt.text), promptText: prompt.text });
      await this.traceDecisionEvent(review);
      return createPatchProposalReviewResult({
        run_id: review.run_id,
        proposal_id: proposal.proposal_id,
        review,
        status: review.status,
        blockers,
        warnings: review.warnings,
        artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: false, no_validation_run: true, no_apply: true }
      });
    }

    const review = this.createBaseReview(proposal, reviewId, "pending", "block", [], eligibility.warnings);
    review.prompt_id = prompt.prompt_id;
    review.prompt_quality_result_ref = qualityRef;
    const input = this.providerInput(reviewRequest, proposal, review, prompt.text);
    const mode = reviewRequest.mode;
    let parsed: ParsedPatchProposalReviewOutput;
    let rawOutput: string | undefined;
    if (mode === "deterministic" || (mode === "auto" && !this.provider)) {
      review.warnings.push(createPatchProposalReviewWarning({
        review_id: review.review_id,
        warning_type: "deterministic_review",
        severity: "info",
        message: "Deterministic review fallback was used; no provider/API call was made.",
        refs: []
      }));
      parsed = this.deterministicReview(proposal, review.review_id);
    } else {
      const provider = this.selectProvider(mode);
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_review_provider_selected",
        lifecycle_stage: "planning",
        summary: `Patch proposal review provider selected: ${provider.provider_name}.`,
        metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id, reviewer_mode: provider.reviewer_mode, real_provider_allowed: this.config.allow_real_provider_review ?? false }
      });
      try {
        const providerResult = await this.callReviewProvider(input, provider);
        rawOutput = providerResult.raw_output;
        review.provider_name = providerResult.provider_name ?? provider.provider_name;
        review.model_name = providerResult.model_name;
        await this.traceWriter.write({
          run_id: proposal.run_id,
          team_id: proposal.team_id,
          event_type: "patch_proposal_review_provider_completed",
          lifecycle_stage: "planning",
          summary: "Patch proposal review provider returned raw output.",
          metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id, raw_output_chars: rawOutput.length }
        });
      } catch (error) {
        review.status = "provider_failed";
        review.decision = "block";
        review.blockers = [blocker(review.review_id, "provider_failed", error instanceof Error ? error.message : String(error))];
        await this.persistReview(review, { reviewInput: input, promptText: prompt.text });
        await this.traceWriter.write({
          run_id: proposal.run_id,
          team_id: proposal.team_id,
          event_type: "patch_proposal_review_provider_failed",
          lifecycle_stage: "blocked",
          severity: "warning",
          summary: "Patch proposal review provider failed.",
          reason: review.blockers[0].reason,
          artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
          metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id }
        });
        return createPatchProposalReviewResult({
          run_id: review.run_id,
          proposal_id: proposal.proposal_id,
          review,
          status: review.status,
          blockers: review.blockers,
          warnings: review.warnings,
          artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
          metadata_json: { provider_called: true, no_validation_run: true, no_apply: true }
        });
      }
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_review_output_saved",
        lifecycle_stage: "planning",
        summary: "Patch proposal review raw output will be persisted.",
        metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id }
      });
      try {
        parsed = this.parseReviewOutput(rawOutput, review.review_id);
      } catch (error) {
        review.status = "schema_failed";
        review.decision = "block";
        review.blockers = [blocker(review.review_id, "schema_failed", error instanceof Error ? error.message : String(error))];
        await this.persistReview(review, { reviewInput: input, promptText: prompt.text, rawOutput });
        await this.traceWriter.write({
          run_id: proposal.run_id,
          team_id: proposal.team_id,
          event_type: "patch_proposal_review_schema_failed",
          lifecycle_stage: "blocked",
          severity: "warning",
          summary: "Patch proposal review schema validation failed.",
          reason: review.blockers[0].reason,
          artifact_refs: [review.raw_review_output_ref, review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
          metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id }
        });
        return createPatchProposalReviewResult({
          run_id: review.run_id,
          proposal_id: proposal.proposal_id,
          review,
          status: review.status,
          blockers: review.blockers,
          warnings: review.warnings,
          artifact_refs: [review.review_artifact_ref, review.raw_review_output_ref].filter((ref): ref is string => Boolean(ref)),
          metadata_json: { provider_called: true, no_validation_run: true, no_apply: true }
        });
      }
    }

    this.applyParsedReview(review, proposal, parsed);
    review.status = this.statusForDecision(review.decision);
    await this.persistReview(review, { reviewInput: input, promptText: prompt.text, rawOutput, parsedOutput: parsed });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_review_schema_validated",
      lifecycle_stage: "planning",
      summary: "Patch proposal review schema validated.",
      artifact_refs: [review.parsed_review_output_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { review_id: review.review_id, proposal_id: proposal.proposal_id, finding_count: review.findings.length }
    });
    await this.traceDecisionEvent(review);
    return createPatchProposalReviewResult({
      run_id: review.run_id,
      proposal_id: proposal.proposal_id,
      review,
      status: review.status,
      blockers: review.blockers,
      warnings: review.warnings,
      artifact_refs: [review.review_artifact_ref, review.raw_review_output_ref, review.parsed_review_output_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_validation_run: true, no_apply: true, no_integration_candidate: true }
    });
  }

  async reviewPatchProposalBatch(runId: string, options: PatchProposalReviewBatchOptions = {}): Promise<PatchProposalReviewBatch> {
    const proposals = await this.loadEligibleProposalsForRun(runId, options.proposalIds);
    const limited = proposals.slice(0, this.config.max_patch_proposal_reviews_per_run ?? 12);
    const request = createPatchProposalReviewRequest({
      run_id: runId,
      proposal_ids: limited.map((proposal) => proposal.proposal_id),
      requested_by: "PatchProposalReviewGate",
      mode: this.config.patch_proposal_review_mode ?? "off",
      metadata_json: { no_validation_run: true, no_apply: true, no_scheduler_enqueue: true }
    });
    const results: PatchProposalReviewResult[] = [];
    for (const proposal of limited) {
      results.push(await this.reviewPatchProposal(proposal, request));
    }
    const reviews = results.flatMap((result) => result.review ? [result.review] : []);
    const summary = this.summarizeReviewBatch(reviews, runId);
    const batch = createPatchProposalReviewBatch({
      run_id: runId,
      request,
      reviews,
      summary,
      metadata_json: { no_validation_run: true, no_apply: true, no_integration_candidate: true }
    });
    const refs = await this.artifactStore.savePatchProposalReviewBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.review_summary_ref = refs.summaryRef;
    await this.metadata.recordPatchProposalReviewBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "patch_proposal_review_batch_completed",
      lifecycle_stage: "planning",
      summary: `Patch proposal review batch completed with ${reviews.length} review(s).`,
      artifact_refs: [batch.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { batch_id: batch.batch_id, review_count: reviews.length }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "patch_proposal_review_summary_created",
      lifecycle_stage: "planning",
      summary: "Patch proposal review summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { batch_id: batch.batch_id, summary_id: summary.summary_id }
    });
    return batch;
  }

  async validateProposalForReview(proposal: OneWriterDryRunProposal, reviewId = `patch_review_${randomUUID()}`): Promise<EligibilityResult> {
    const blockers: PatchProposalReviewBlocker[] = [];
    const warnings: PatchProposalReviewWarning[] = [];
    const add = (type: PatchProposalReviewBlocker["blocker_type"], reason: string, refs: string[] = []) => blockers.push(blocker(reviewId, type, reason, refs));
    const mode = this.config.patch_proposal_review_mode ?? "off";
    if (!this.config.enable_patch_proposal_review_gate || mode === "off") add("review_disabled", "Patch proposal review gate is disabled by configuration.");
    if (mode === "provider" && !this.config.allow_real_provider_review) add("provider_unavailable", "Real provider review requires allow_real_provider_review opt-in.");
    if (proposal.status !== "accepted_for_review_candidate") add("ineligible_proposal", `Proposal status ${proposal.status} is not eligible for review.`, [proposal.proposal_id]);
    if (!proposal.scope_check_result || proposal.scope_check_result.status !== "passed" || !proposal.scope_check_result.review_candidate_allowed) add("missing_scope_check", "Proposal scope check did not pass.", [proposal.proposal_id]);
    if (!proposal.patch_artifact_ref || !existsSync(proposal.patch_artifact_ref)) add("missing_patch_artifact", "Patch proposal artifact ref is missing or not file-backed.", [proposal.patch_artifact_ref ?? ""]);
    if (!proposal.changed_files.length) add("missing_changed_files", "Review requires at least one changed file.");
    if (!proposal.review_policy_ref) add("missing_review_policy", "Review requires review policy ref or default policy metadata.", [proposal.proposal_id]);
    if (!await this.loadPreparationPlan(proposal)) add("missing_preparation_plan", "Review requires file-backed preparation plan metadata.", [proposal.preparation_plan_id]);
    if (["rejected", "blocked", "cancelled", "schema_failed", "scope_failed"].includes(proposal.status)) add("ineligible_proposal", `Proposal status ${proposal.status} blocks review.`, [proposal.proposal_id]);
    if (this.config.require_specialist_review_for_high_risk && (proposal.risk_level === "high" || proposal.risk_level === "critical")) {
      warnings.push(warning(reviewId, "specialist_review_required", "High-risk proposal requires specialist review before future validation.", [proposal.proposal_id]));
    }
    return {
      eligible: blockers.length === 0,
      status: blockers.some((entry) => entry.blocker_type === "review_disabled") ? "not_required" : "blocked",
      blockers,
      warnings
    };
  }

  async buildReviewPrompt(proposal: OneWriterDryRunProposal, reviewId: string): Promise<RenderedPrompt> {
    const render = renderRolePrompt({
      run_id: proposal.run_id,
      task_id: proposal.proposed_node_id,
      agent_role: "ReviewerAgent",
      task_title: `Review dry-run patch proposal ${proposal.proposal_id}`,
      task_objective: `Review proposal ${proposal.proposal_id} for future validation candidacy only.`,
      context_pack_ref: proposal.context_pack_ref ?? proposal.proposal_id,
      allowed_files: proposal.allowed_files,
      forbidden_files: proposal.forbidden_files,
      relevant_files: proposal.changed_files,
      validation_requirements: [],
      expected_output_schema: "PatchProposalReviewOutput",
      output_schema_name: "PatchProposalReviewOutput",
      source_component: "PatchProposalReviewGate",
      metadata_json: {
        review_id: reviewId,
        proposal_id: proposal.proposal_id,
        preparation_plan_id: proposal.preparation_plan_id
      }
    });
    if (!render.ok) throw new Error(render.error.message);
    const text = [
      render.rendered.text,
      "",
      "Patch proposal review inputs:",
      `- proposal_id: ${proposal.proposal_id}`,
      `- preparation_plan_id: ${proposal.preparation_plan_id}`,
      `- patch_artifact_ref: ${proposal.patch_artifact_ref ?? "missing"}`,
      `- scope_check_status: ${proposal.scope_check_result?.status ?? "missing"}`,
      `- patch_summary: ${proposal.patch_summary || "none"}`,
      `- validation_plan_ref: ${proposal.validation_plan_ref ?? "missing"}`,
      `- review_policy_ref: ${proposal.review_policy_ref ?? "missing"}`,
      `- integration_preview_ref: ${proposal.integration_preview_ref ?? "missing"}`,
      `- risk_level: ${proposal.risk_level}`,
      "",
      "Changed files:",
      ...(proposal.changed_files.length ? proposal.changed_files.map((file) => `- ${file}`) : ["- none"]),
      "",
      "Patch proposal risks:",
      ...(proposal.patch_proposal?.risks.length ? proposal.patch_proposal.risks.map((risk) => `- ${risk}`) : ["- none"]),
      "",
      "Patch proposal validation recommendations:",
      ...(proposal.patch_proposal?.validation_recommendations.length ? proposal.patch_proposal.validation_recommendations.map((entry) => `- ${entry}`) : ["- none"]),
      "",
      "Review constraints:",
      "- Return structured review JSON only.",
      "- Do not state that validation passed; validation remains pending for a later gate.",
      "- Do not state that the patch was applied, merged, committed, or integrated.",
      "- Do not request lock acquisition, command execution, patch application, integration acceptance, scheduler enqueue, or recursive execution.",
      "",
      "Return strict JSON with keys: decision, findings, required_changes, validation_recommendations, integration_risks, security_risks, performance_risks, test_coverage_risks, confidence.",
      "Each finding must include category, severity, message, blocking, and optional file, suggested_change, evidence_ref."
    ].join("\n");
    return {
      ...render.rendered,
      prompt_id: `prompt_${hashRenderedPrompt([render.rendered.prompt_id, reviewId, text].join("\0")).slice(0, 24)}`,
      output_schema_name: "PatchProposalReviewOutput",
      text,
      input_hash: hashPromptInput({ review_id: reviewId, proposal_id: proposal.proposal_id, output_schema_name: "PatchProposalReviewOutput" }),
      rendered_prompt_hash: hashRenderedPrompt(text),
      metadata_json: {
        ...render.rendered.metadata_json,
        patch_proposal_review: true,
        review_only: true,
        no_validation_run: true,
        no_apply: true
      }
    };
  }

  async callReviewProvider(input: PatchProposalReviewProviderInput, provider = this.selectProvider(input.request.mode)): Promise<PatchProposalReviewProviderResult> {
    await this.traceWriter.write({
      run_id: input.run_id,
      event_type: "patch_proposal_review_provider_started",
      lifecycle_stage: "planning",
      summary: `Patch proposal review provider started for ${input.proposal_id}.`,
      metadata_json: { review_id: input.review_id, proposal_id: input.proposal_id, provider_name: provider.provider_name, reviewer_mode: provider.reviewer_mode }
    });
    return provider.reviewPatchProposal(input);
  }

  parseReviewOutput(raw: string, reviewId: string) {
    return parsePatchProposalReviewOutput(raw, reviewId);
  }

  validateReviewOutput(parsed: unknown, reviewId: string) {
    return validatePatchProposalReviewOutput(parsed, reviewId);
  }

  async persistReview(review: PatchProposalReview, artifacts: {
    reviewInput?: PatchProposalReviewProviderInput;
    promptText?: string;
    rawOutput?: string;
    parsedOutput?: unknown;
  } = {}) {
    const refs = await this.artifactStore.savePatchProposalReviewArtifacts({
      review,
      reviewInput: artifacts.reviewInput,
      promptText: artifacts.promptText,
      rawOutput: artifacts.rawOutput,
      parsedOutput: artifacts.parsedOutput
    });
    review.review_artifact_ref = refs.reviewResultRef;
    if (artifacts.rawOutput !== undefined) review.raw_review_output_ref = refs.rawOutputRef;
    if (artifacts.parsedOutput !== undefined) review.parsed_review_output_ref = refs.parsedOutputRef;
    await this.metadata.recordPatchProposalReviewSaved(review);
    return review;
  }

  summarizeReviewBatch(reviews: PatchProposalReview[], runId = reviews[0]?.run_id ?? "") {
    return createPatchProposalReviewSummary({
      run_id: runId,
      patch_review_used: reviews.length > 0,
      patch_reviews_count: reviews.length,
      accepted_for_validation_candidate_count: reviews.filter((review) => review.status === "accepted_for_validation_candidate").length,
      changes_requested_count: reviews.filter((review) => review.status === "changes_requested").length,
      rejected_count: reviews.filter((review) => review.status === "rejected").length,
      blocked_count: reviews.filter((review) => review.status === "blocked" || review.status === "provider_failed").length,
      review_schema_failed_count: reviews.filter((review) => review.status === "schema_failed").length,
      critical_findings_count: reviews.reduce((sum, review) => sum + review.severity_counts.critical, 0),
      high_findings_count: reviews.reduce((sum, review) => sum + review.severity_counts.high, 0),
      metadata_json: { review_only: true, no_validation_run: true, no_apply: true }
    });
  }

  private deterministicReview(proposal: OneWriterDryRunProposal, reviewId: string): ParsedPatchProposalReviewOutput {
    const findings: PatchProposalReviewFinding[] = [];
    const sensitiveFiles = proposal.changed_files.filter(isSensitivePath);
    if (proposal.scope_check_result?.status !== "passed") {
      findings.push(reviewFinding(reviewId, "scope", "critical", "Scope check did not pass.", true, proposal.proposal_id));
    }
    if (!proposal.validation_plan_ref && !(proposal.patch_proposal?.validation_recommendations.length)) {
      findings.push(reviewFinding(reviewId, "validation", "high", "Validation plan or recommendations are missing.", true));
    }
    if (proposal.risk_level === "critical" || proposal.risk_level === "high") {
      findings.push(reviewFinding(reviewId, "risk", "high", `Proposal risk level is ${proposal.risk_level}; specialist review is required before validation candidacy.`, this.config.require_specialist_review_for_high_risk ?? true));
    }
    if (proposal.changed_files.length > 5) {
      findings.push(reviewFinding(reviewId, "maintainability", "medium", "Proposal changes too many files for a single validation candidate.", false));
    }
    if (sensitiveFiles.length && this.config.require_human_approval_for_risky_files) {
      findings.push(reviewFinding(reviewId, "security", "high", `Sensitive file changes require human approval scope: ${sensitiveFiles.join(", ")}.`, true, sensitiveFiles[0]));
    }
    const blocking = findings.some((finding) => finding.blocking || finding.severity === "critical");
    const decision: PatchProposalReviewDecision = blocking
      ? (sensitiveFiles.length ? "require_human_approval" : "block")
      : proposal.changed_files.length > 5
        ? "split_further"
        : "accept_for_validation_candidate";
    return {
      decision,
      findings,
      required_changes: decision === "split_further" ? ["Split broad proposal into smaller validation candidates."] : [],
      validation_recommendations: proposal.patch_proposal?.validation_recommendations.length
        ? proposal.patch_proposal.validation_recommendations
        : ["Run the prepared validation plan in a later validation gate."],
      integration_risks: proposal.patch_proposal?.risks ?? [],
      security_risks: sensitiveFiles.length ? [`Sensitive file review required for ${sensitiveFiles.join(", ")}.`] : [],
      performance_risks: [],
      test_coverage_risks: proposal.patch_proposal?.validation_recommendations.length ? [] : ["Validation recommendations were sparse."],
      confidence: blocking ? 0.68 : 0.82
    };
  }

  private applyParsedReview(review: PatchProposalReview, proposal: OneWriterDryRunProposal, parsed: ParsedPatchProposalReviewOutput) {
    const decision = this.enforceDecisionRules(proposal, parsed);
    review.decision = decision;
    review.findings = parsed.findings;
    review.severity_counts = countSeverities(parsed.findings);
    review.required_changes = parsed.required_changes;
    review.validation_recommendations = parsed.validation_recommendations;
    review.integration_risks = parsed.integration_risks;
    review.security_risks = parsed.security_risks;
    review.performance_risks = parsed.performance_risks;
    review.test_coverage_risks = parsed.test_coverage_risks;
    review.confidence = parsed.confidence;
    if (decision === "block") review.blockers = [blocker(review.review_id, "decision_blocked", "Review decision blocked validation candidacy.")];
    if (decision === "accept_for_validation_candidate") {
      review.warnings.push(createPatchProposalReviewWarning({
        review_id: review.review_id,
        warning_type: "validation_candidate_only",
        severity: "info",
        message: "Proposal is accepted only as a future validation candidate; it is not validated, applied, or integrated.",
        refs: [proposal.proposal_id]
      }));
    }
  }

  private enforceDecisionRules(proposal: OneWriterDryRunProposal, parsed: ParsedPatchProposalReviewOutput): PatchProposalReviewDecision {
    const hasBlocking = parsed.findings.some((finding) => finding.blocking || finding.severity === "critical");
    if (hasBlocking && parsed.decision === "accept_for_validation_candidate") return "block";
    if (proposal.scope_check_result?.status !== "passed" && parsed.decision === "accept_for_validation_candidate") return "block";
    if (!parsed.validation_recommendations.length && !proposal.validation_plan_ref && parsed.decision === "accept_for_validation_candidate") return "request_changes";
    if (parsed.confidence < 0.6 && parsed.decision === "accept_for_validation_candidate") return "request_changes";
    return parsed.decision;
  }

  private statusForDecision(decision: PatchProposalReviewDecision): PatchProposalReviewStatus {
    if (decision === "accept_for_validation_candidate") return "accepted_for_validation_candidate";
    if (decision === "request_changes" || decision === "split_further" || decision === "require_human_approval") return "changes_requested";
    if (decision === "reject") return "rejected";
    if (decision === "block") return "blocked";
    return "reviewed";
  }

  private createBaseReview(
    proposal: OneWriterDryRunProposal,
    reviewId: string,
    status: PatchProposalReviewStatus,
    decision: PatchProposalReviewDecision,
    blockers: PatchProposalReviewBlocker[] = [],
    warnings: PatchProposalReviewWarning[] = []
  ) {
    return createPatchProposalReview({
      review_id: reviewId,
      run_id: proposal.run_id,
      proposal_id: proposal.proposal_id,
      preparation_plan_id: proposal.preparation_plan_id,
      proposed_node_id: proposal.proposed_node_id,
      reviewer_role: "ReviewerAgent",
      reviewer_mode: this.config.patch_proposal_review_mode ?? "off",
      decision,
      status,
      findings: [],
      required_changes: [],
      validation_recommendations: [],
      integration_risks: [],
      security_risks: [],
      performance_risks: [],
      test_coverage_risks: [],
      confidence: 0,
      blockers,
      warnings,
      metadata_json: { review_only: true, no_validation_run: true, no_apply: true, no_integration_candidate: true }
    });
  }

  private providerInput(request: PatchProposalReviewRequest, proposal: OneWriterDryRunProposal, review: PatchProposalReview, prompt: string): PatchProposalReviewProviderInput {
    return {
      request,
      review_id: review.review_id,
      run_id: proposal.run_id,
      proposal_id: proposal.proposal_id,
      preparation_plan_id: proposal.preparation_plan_id,
      prompt,
      prompt_id: review.prompt_id ?? "",
      reviewer_role: review.reviewer_role,
      patch_summary: proposal.patch_summary,
      changed_files: proposal.changed_files,
      allowed_files: proposal.allowed_files,
      forbidden_files: proposal.forbidden_files,
      scope_check_status: proposal.scope_check_result?.status,
      validation_plan_ref: proposal.validation_plan_ref,
      review_policy_ref: proposal.review_policy_ref,
      integration_preview_ref: proposal.integration_preview_ref,
      risk_level: proposal.risk_level,
      metadata_json: { review_only: true }
    };
  }

  private selectProvider(mode: PatchProposalReviewRequest["mode"]): PatchProposalReviewProvider {
    if (this.provider) return this.provider;
    if (mode === "provider" && !(this.config.allow_real_provider_review ?? false)) {
      throw new Error("Real provider review was requested without allow_real_provider_review.");
    }
    return new FakePatchProposalReviewProvider(mode === "provider" ? "provider" : "fake_provider");
  }

  private async loadEligibleProposalsForRun(runId: string, ids?: string[]) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = store.all<Record<string, unknown>>(
        "SELECT * FROM factory_one_writer_dry_run_proposals WHERE run_id = ? AND status = 'accepted_for_review_candidate' ORDER BY created_at",
        runId
      );
      const selected = ids?.length ? new Set(ids) : undefined;
      const proposals: OneWriterDryRunProposal[] = [];
      for (const row of rows) {
        const proposalId = String(row.proposal_id);
        if (selected && !selected.has(proposalId)) continue;
        const artifactRef = typeof row.artifact_ref === "string" ? row.artifact_ref : undefined;
        if (artifactRef && existsSync(artifactRef)) proposals.push(await readJson<OneWriterDryRunProposal>(artifactRef));
      }
      return proposals;
    } finally {
      store.close();
    }
  }

  private async loadPreparationPlan(proposal: OneWriterDryRunProposal): Promise<ExecutionPreparationPlan | undefined> {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_execution_preparation_plans WHERE preparation_plan_id = ?", proposal.preparation_plan_id);
      if (!row?.artifact_ref || !existsSync(row.artifact_ref)) return undefined;
      return readJson<ExecutionPreparationPlan>(row.artifact_ref);
    } finally {
      store.close();
    }
  }

  private async traceDecisionEvent(review: PatchProposalReview) {
    const eventType = review.status === "accepted_for_validation_candidate"
      ? "patch_proposal_review_validation_candidate_created"
      : review.status === "changes_requested"
        ? "patch_proposal_review_changes_requested"
        : review.status === "rejected"
          ? "patch_proposal_review_rejected"
          : review.status === "blocked" || review.status === "provider_failed" || review.status === "schema_failed"
            ? "patch_proposal_review_blocked"
            : "patch_proposal_review_completed";
    await this.traceWriter.write({
      run_id: review.run_id,
      event_type: eventType,
      lifecycle_stage: review.status === "accepted_for_validation_candidate" || review.status === "reviewed" ? "planning" : "blocked",
      severity: review.status === "accepted_for_validation_candidate" || review.status === "reviewed" ? "info" : "warning",
      summary: `Patch proposal review ${review.status} for ${review.proposal_id}.`,
      reason: review.blockers[0]?.reason,
      artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { review_id: review.review_id, proposal_id: review.proposal_id, decision: review.decision, no_validation_run: true, no_apply: true }
    });
    if (eventType !== "patch_proposal_review_completed") {
      await this.traceWriter.write({
        run_id: review.run_id,
        event_type: "patch_proposal_review_completed",
        lifecycle_stage: "planning",
        summary: `Patch proposal review completed with status ${review.status}.`,
        artifact_refs: [review.review_artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { review_id: review.review_id, proposal_id: review.proposal_id, decision: review.decision }
      });
    }
  }
}

class FakePatchProposalReviewProvider implements PatchProposalReviewProvider {
  provider_name = "fake_patch_proposal_review_provider";
  reviewer_mode: "fake_provider" | "provider";

  constructor(mode: "fake_provider" | "provider") {
    this.reviewer_mode = mode;
  }

  async reviewPatchProposal(input: PatchProposalReviewProviderInput): Promise<PatchProposalReviewProviderResult> {
    return {
      provider_name: this.provider_name,
      model_name: "fake-review-v1",
      raw_output: JSON.stringify({
        decision: "accept_for_validation_candidate",
        findings: [{
          category: "validation",
          severity: "low",
          message: "Validation remains pending for the later validation gate.",
          blocking: false,
          evidence_ref: input.validation_plan_ref
        }],
        required_changes: [],
        validation_recommendations: ["Run the prepared validation plan in a later validation gate."],
        integration_risks: ["IntegrationManager acceptance remains pending."],
        security_risks: [],
        performance_risks: [],
        test_coverage_risks: [],
        confidence: 0.82
      }, null, 2)
    };
  }
}

function blocker(reviewId: string, type: PatchProposalReviewBlocker["blocker_type"], reason: string, refs: string[] = []) {
  return createPatchProposalReviewBlocker({
    review_id: reviewId,
    blocker_type: type,
    severity: "blocking",
    reason,
    refs: refs.filter(Boolean)
  });
}

function warning(reviewId: string, type: PatchProposalReviewWarning["warning_type"], message: string, refs: string[] = []) {
  return createPatchProposalReviewWarning({
    review_id: reviewId,
    warning_type: type,
    severity: "warning",
    message,
    refs: refs.filter(Boolean)
  });
}

function reviewFinding(
  reviewId: string,
  category: PatchProposalReviewFinding["category"],
  severity: PatchProposalReviewFinding["severity"],
  message: string,
  blocking: boolean,
  file?: string
) {
  return createPatchProposalReviewFinding({
    review_id: reviewId,
    category,
    severity,
    message,
    file,
    blocking
  });
}

function isSensitivePath(file: string) {
  return /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/|migrations?\/|schema\/|schemas\/|openapi|api\/|security\/|auth\/|\.env)/i.test(file);
}
