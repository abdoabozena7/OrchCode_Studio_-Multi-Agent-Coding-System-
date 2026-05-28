import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveFactoryMetadataDatabasePath, FactoryMetadataAdapter, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionPreparationPlan } from "./ExecutionPreparationModels.js";
import { isWriteClassified } from "./ExecutionPreparationPolicy.js";
import {
  createOneWriterDryRunBatch,
  createOneWriterDryRunBlocker,
  createOneWriterDryRunProposal,
  createOneWriterDryRunRequest,
  createOneWriterDryRunResult,
  createOneWriterDryRunWarning,
  type OneWriterDryRunBatch,
  type OneWriterDryRunBlocker,
  type OneWriterDryRunProvider,
  type OneWriterDryRunProviderInput,
  type OneWriterDryRunProviderResult,
  type OneWriterDryRunProposal,
  type OneWriterDryRunRequest,
  type OneWriterDryRunResult,
  type OneWriterDryRunStatus,
  type OneWriterDryRunWarning
} from "./OneWriterDryRunModels.js";
import {
  createPatchProposal,
  createPatchProposalFileChange,
  createPatchProposalSummary,
  type PatchProposal,
  type PatchProposalFileChange,
  type PatchProposalScopeCheck
} from "./PatchProposalModels.js";
import { checkPatchProposalScope as runScopeCheck } from "./PatchProposalScopeChecker.js";
import { evaluatePromptQuality, isPromptQualityBlocking } from "./PromptQualityGate.js";
import { hashPromptInput, hashRenderedPrompt, renderRolePrompt, type RenderedPrompt } from "./PromptSystem.js";
import { readJson } from "../memory/ProjectMemory.js";

export type OneWriterDryRunExecutorOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  provider?: OneWriterDryRunProvider;
};

export type OneWriterDryRunBatchOptions = {
  allowDuplicatePreparation?: boolean;
  preparationPlanIds?: string[];
};

type DryRunPreparationValidation = {
  allowed: boolean;
  status: OneWriterDryRunStatus;
  blockers: OneWriterDryRunBlocker[];
  warnings: OneWriterDryRunWarning[];
};

export class OneWriterDryRunExecutor {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly provider?: OneWriterDryRunProvider;

  constructor(options: OneWriterDryRunExecutorOptions) {
    this.workspacePath = options.workspacePath;
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(options.workspacePath, options.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: options.workspacePath, memoryDir: options.memoryDir, sourceComponent: "OneWriterDryRunExecutor" });
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.provider = options.provider;
  }

  async generatePatchProposalFromPreparation(preparationPlan: ExecutionPreparationPlan, request?: OneWriterDryRunRequest): Promise<OneWriterDryRunResult> {
    const proposalId = `one_writer_dry_run_${randomUUID()}`;
    const dryRunRequest = request ?? createOneWriterDryRunRequest({
      run_id: preparationPlan.run_id,
      preparation_plan_ids: [preparationPlan.preparation_plan_id],
      requested_by: "OneWriterDryRunExecutor",
      mode: this.config.one_writer_dry_run_mode ?? "off"
    });
    await this.traceWriter.write({
      run_id: preparationPlan.run_id,
      team_id: preparationPlan.team_id,
      event_type: "one_writer_dry_run_started",
      lifecycle_stage: "planning",
      summary: `One-writer dry-run started for ${preparationPlan.preparation_plan_id}.`,
      metadata_json: { proposal_id: proposalId, preparation_plan_id: preparationPlan.preparation_plan_id, no_apply: true }
    });
    await this.traceWriter.write({
      run_id: preparationPlan.run_id,
      team_id: preparationPlan.team_id,
      event_type: "one_writer_dry_run_preparation_loaded",
      lifecycle_stage: "planning",
      summary: `Execution preparation loaded for dry-run proposal ${proposalId}.`,
      artifact_refs: [preparationPlan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { preparation_plan_id: preparationPlan.preparation_plan_id, status: preparationPlan.status }
    });

    const validation = await this.validatePreparationForDryRun(preparationPlan, proposalId, dryRunRequest);
    if (!validation.allowed) {
      const proposal = this.createBaseProposal(preparationPlan, proposalId, validation.status, dryRunRequest.mode, validation.blockers, validation.warnings);
      await this.persistPatchProposal(proposal);
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: `Dry-run patch proposal blocked for ${proposal.preparation_plan_id}.`,
        reason: validation.blockers[0]?.reason,
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { proposal_id: proposal.proposal_id, blocker_count: validation.blockers.length }
      });
      return createOneWriterDryRunResult({
        run_id: proposal.run_id,
        preparation_plan_id: proposal.preparation_plan_id,
        proposal,
        status: proposal.status,
        blockers: validation.blockers,
        warnings: validation.warnings,
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: false, no_patch_applied: true }
      });
    }

    const prompt = await this.buildWriterPrompt(preparationPlan, proposalId);
    const promptMetadata = await this.artifactStore.savePromptArtifact(prompt);
    const quality = evaluatePromptQuality(prompt, {
      promptArtifactRef: promptMetadata.artifact_ref,
      promptMetadata,
      contextPackRef: preparationPlan.context_pack_ref,
      allowedFiles: preparationPlan.allowed_files,
      forbiddenFiles: preparationPlan.forbidden_files,
      validationRequirements: [
        ...preparationPlan.validation_plan.required_commands,
        ...preparationPlan.validation_plan.required_checks
      ],
      stopConditions: [
        "Stop if approval, scope, context, prompt quality, validation plan, review policy, integration preview, or lock preview is missing.",
        "Return patch proposal JSON only; validation remains pending until a later gate records evidence."
      ],
      successCriteria: ["Valid OneWriterDryRunProposal schema.", "No forbidden or out-of-scope files."],
      expectedOutputSchema: "OneWriterDryRunPatchProposalOutput"
    });
    const qualityRef = await this.artifactStore.savePromptQualityResult(quality);
    await this.traceWriter.write({
      run_id: preparationPlan.run_id,
      team_id: preparationPlan.team_id,
      event_type: "one_writer_dry_run_prompt_checked",
      lifecycle_stage: isPromptQualityBlocking(quality) ? "blocked" : "planning",
      severity: isPromptQualityBlocking(quality) ? "warning" : "info",
      summary: `Dry-run writer prompt quality ${quality.status}.`,
      artifact_refs: [promptMetadata.artifact_ref, qualityRef],
      metadata_json: { proposal_id: proposalId, prompt_id: prompt.prompt_id, status: quality.status }
    });
    if (isPromptQualityBlocking(quality) || (quality.status === "warning" && this.config.block_on_prompt_quality_warning_for_writer)) {
      const blockers = [blocker(proposalId, "prompt_quality_blocked", `PromptQualityGate returned ${quality.status}.`, [qualityRef])];
      const proposal = this.createBaseProposal(preparationPlan, proposalId, "blocked", dryRunRequest.mode, blockers, validation.warnings);
      proposal.prompt_id = prompt.prompt_id;
      proposal.prompt_quality_result_ref = qualityRef;
      await this.persistPatchProposal(proposal, { writerInput: this.providerInput(dryRunRequest, proposal, prompt.text), promptText: prompt.text });
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Dry-run patch proposal blocked by prompt quality.",
        artifact_refs: [proposal.artifact_ref, qualityRef].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { proposal_id: proposal.proposal_id, no_provider_call: true }
      });
      return createOneWriterDryRunResult({
        run_id: proposal.run_id,
        preparation_plan_id: proposal.preparation_plan_id,
        proposal,
        status: proposal.status,
        blockers,
        warnings: validation.warnings,
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: false, no_patch_applied: true }
      });
    }

    const proposal = this.createBaseProposal(preparationPlan, proposalId, "pending", dryRunRequest.mode, [], validation.warnings);
    proposal.prompt_id = prompt.prompt_id;
    proposal.prompt_quality_result_ref = qualityRef;
    const writerInput = this.providerInput(dryRunRequest, proposal, prompt.text);
    const provider = this.selectProvider(dryRunRequest.mode);
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "one_writer_dry_run_provider_selected",
      lifecycle_stage: "planning",
      summary: `Dry-run writer provider selected: ${provider.provider_name}.`,
      metadata_json: { proposal_id: proposal.proposal_id, provider_mode: provider.provider_mode, real_provider_allowed: this.config.allow_real_provider_dry_run ?? false }
    });
    let providerResult: OneWriterDryRunProviderResult;
    try {
      providerResult = await this.callDryRunWriterProvider(writerInput, provider);
    } catch (error) {
      const blockers = [blocker(proposal.proposal_id, "provider_failed", error instanceof Error ? error.message : String(error))];
      proposal.status = "blocked";
      proposal.blockers = blockers;
      await this.persistPatchProposal(proposal, { writerInput, promptText: prompt.text });
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "one_writer_dry_run_provider_failed",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Dry-run writer provider failed.",
        reason: blockers[0].reason,
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { proposal_id: proposal.proposal_id }
      });
      return createOneWriterDryRunResult({
        run_id: proposal.run_id,
        preparation_plan_id: proposal.preparation_plan_id,
        proposal,
        status: "blocked",
        blockers,
        warnings: proposal.warnings,
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: true, provider_calls: 1, no_patch_applied: true }
      });
    }

    proposal.provider_name = providerResult.provider_name ?? provider.provider_name;
    proposal.model_name = providerResult.model_name;
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "one_writer_dry_run_provider_completed",
      lifecycle_stage: "planning",
      summary: "Dry-run writer provider returned raw output.",
      metadata_json: { proposal_id: proposal.proposal_id, raw_output_chars: providerResult.raw_output.length, provider_calls: 1 }
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_raw_output_saved",
      lifecycle_stage: "planning",
      summary: "Dry-run raw output will be persisted as an artifact.",
      metadata_json: { proposal_id: proposal.proposal_id }
    });

    let parsed: PatchProposal | undefined;
    try {
      parsed = this.parsePatchProposalOutput(providerResult.raw_output, proposal);
    } catch (error) {
      const blockers = [blocker(proposal.proposal_id, "schema_failed", error instanceof Error ? error.message : String(error))];
      proposal.status = "schema_failed";
      proposal.blockers = blockers;
      await this.persistPatchProposal(proposal, { writerInput, promptText: prompt.text, rawOutput: providerResult.raw_output });
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_schema_failed",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Dry-run patch proposal schema validation failed.",
        reason: blockers[0].reason,
        artifact_refs: [proposal.raw_output_ref, proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { proposal_id: proposal.proposal_id }
      });
      return createOneWriterDryRunResult({
        run_id: proposal.run_id,
        preparation_plan_id: proposal.preparation_plan_id,
        proposal,
        status: "schema_failed",
        blockers,
        warnings: proposal.warnings,
        artifact_refs: [proposal.artifact_ref, proposal.raw_output_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { provider_called: true, provider_calls: 1, no_patch_applied: true }
      });
    }
    proposal.patch_proposal = parsed;
    proposal.patch_summary = parsed.summary;
    proposal.changed_files = parsed.changed_files;
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_schema_validated",
      lifecycle_stage: "planning",
      summary: "Dry-run patch proposal schema validated.",
      metadata_json: { proposal_id: proposal.proposal_id, changed_file_count: parsed.changed_files.length }
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_scope_check_started",
      lifecycle_stage: "planning",
      summary: "Dry-run patch proposal scope check started.",
      metadata_json: { proposal_id: proposal.proposal_id }
    });
    const scopeCheck = this.checkPatchProposalScope(proposal, preparationPlan);
    proposal.scope_check_result = scopeCheck;
    proposal.forbidden_file_violations = scopeCheck.forbidden_file_violations;
    proposal.out_of_scope_changes = scopeCheck.out_of_scope_changes;
    proposal.status = scopeCheck.review_candidate_allowed ? "accepted_for_review_candidate" : "scope_failed";
    if (!scopeCheck.review_candidate_allowed) {
      proposal.blockers = [blocker(proposal.proposal_id, "scope_failed", "Patch proposal scope check failed.", scopeCheck.findings.map((finding) => finding.path ?? finding.finding_id))];
    } else {
      proposal.warnings.push(createOneWriterDryRunWarning({
        proposal_id: proposal.proposal_id,
        warning_type: "review_candidate_only",
        severity: "info",
        message: "Proposal is accepted only as a future review candidate; it is not applied, validated, or integrated.",
        refs: []
      }));
    }
    await this.persistPatchProposal(proposal, {
      writerInput,
      promptText: prompt.text,
      rawOutput: providerResult.raw_output,
      parsedOutput: parsed,
      patchProposal: parsed,
      scopeCheck
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: scopeCheck.review_candidate_allowed ? "patch_proposal_scope_check_passed" : "patch_proposal_scope_check_failed",
      lifecycle_stage: scopeCheck.review_candidate_allowed ? "planning" : "blocked",
      severity: scopeCheck.review_candidate_allowed ? "info" : "warning",
      summary: `Dry-run patch proposal scope check ${scopeCheck.status}.`,
      artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { proposal_id: proposal.proposal_id, finding_count: scopeCheck.findings.length }
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "patch_proposal_generated",
      lifecycle_stage: "planning",
      summary: "Dry-run patch proposal artifact generated.",
      artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { proposal_id: proposal.proposal_id, status: proposal.status, no_apply: true }
    });
    if (proposal.status === "accepted_for_review_candidate") {
      await this.traceWriter.write({
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        event_type: "patch_proposal_review_candidate_created",
        lifecycle_stage: "planning",
        summary: "Dry-run patch proposal is available for future review candidate flow only.",
        artifact_refs: [proposal.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        metadata_json: { proposal_id: proposal.proposal_id, not_accepted_change: true }
      });
    }
    return createOneWriterDryRunResult({
      run_id: proposal.run_id,
      preparation_plan_id: proposal.preparation_plan_id,
      proposal,
      status: proposal.status,
      blockers: proposal.blockers,
      warnings: proposal.warnings,
      artifact_refs: [proposal.artifact_ref, proposal.raw_output_ref, proposal.parsed_output_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { provider_called: true, provider_calls: 1, no_patch_applied: true, no_validation_run: true }
    });
  }

  async generatePatchProposalBatch(runId: string, options: OneWriterDryRunBatchOptions = {}): Promise<OneWriterDryRunBatch> {
    const plans = await this.loadPreparedPlansForRun(runId, options.preparationPlanIds);
    const limited = plans.slice(0, this.config.max_dry_run_proposals_per_run ?? 12);
    const request = createOneWriterDryRunRequest({
      run_id: runId,
      preparation_plan_ids: limited.map((plan) => plan.preparation_plan_id),
      requested_by: "OneWriterDryRunExecutor",
      mode: this.config.one_writer_dry_run_mode ?? "off",
      allow_duplicate_preparation: options.allowDuplicatePreparation,
      metadata_json: { no_scheduler_enqueue: true, no_recursive_execution: true }
    });
    const results: OneWriterDryRunResult[] = [];
    for (const plan of limited) {
      results.push(await this.generatePatchProposalFromPreparation(plan, request));
    }
    const proposals = results.flatMap((result) => result.proposal ? [result.proposal] : []);
    const summary = this.summarizePatchProposalBatch(proposals, runId);
    const batch = createOneWriterDryRunBatch({
      run_id: runId,
      request,
      proposals,
      summary,
      metadata_json: { no_patch_applied: true, no_validation_run: true, no_scheduler_enqueue: true }
    });
    const refs = await this.artifactStore.saveOneWriterDryRunBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.dry_run_summary_ref = refs.summaryRef;
    await this.metadata.recordOneWriterDryRunBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "one_writer_dry_run_batch_completed",
      lifecycle_stage: "planning",
      summary: `One-writer dry-run batch completed with ${proposals.length} proposal(s).`,
      artifact_refs: [batch.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { batch_id: batch.batch_id, proposal_count: proposals.length }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "one_writer_dry_run_summary_created",
      lifecycle_stage: "planning",
      summary: "One-writer dry-run summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { batch_id: batch.batch_id, summary_id: summary.summary_id }
    });
    return batch;
  }

  async validatePreparationForDryRun(preparationPlan: ExecutionPreparationPlan, proposalId = `one_writer_dry_run_${randomUUID()}`, request?: OneWriterDryRunRequest): Promise<DryRunPreparationValidation> {
    const blockers: OneWriterDryRunBlocker[] = [];
    const warnings: OneWriterDryRunWarning[] = [];
    const mode = request?.mode ?? this.config.one_writer_dry_run_mode ?? "off";
    const add = (type: OneWriterDryRunBlocker["blocker_type"], reason: string, refs: string[] = []) => blockers.push(blocker(proposalId, type, reason, refs));
    if (!this.config.enable_one_writer_dry_run || mode === "off") add("dry_run_disabled", "One-writer dry-run is disabled by configuration.");
    if (mode === "provider" && !this.config.allow_real_provider_dry_run) add("provider_unavailable", "Real provider dry-run requires explicit allow_real_provider_dry_run opt-in.");
    if (preparationPlan.status !== "prepared") add("not_prepared", `Preparation plan status ${preparationPlan.status} is not dry-run eligible.`, [preparationPlan.preparation_plan_id]);
    if (isWriteClassified(preparationPlan.read_or_write_classification) && !preparationPlan.approval_id) add("missing_approval", "Write-classified dry-run requires human approval.", [preparationPlan.promotion_request_id]);
    if (!preparationPlan.prompt_id || !preparationPlan.prompt_quality_result_ref) add("missing_prompt", "Preparation plan is missing prompt or prompt quality refs.", [preparationPlan.preparation_plan_id]);
    if (!preparationPlan.context_pack_ref || !existsSync(preparationPlan.context_pack_ref)) add("missing_context", "Preparation plan context pack ref is missing or not file-backed.", [preparationPlan.context_pack_ref ?? ""]);
    if (this.config.block_on_stale_context_for_writer && String(preparationPlan.context_freshness_summary.status ?? "") === "stale") add("stale_context", "Writer dry-run blocks on stale context by policy.");
    if (String(preparationPlan.context_freshness_summary.status ?? "") === "stale") {
      warnings.push(createOneWriterDryRunWarning({ proposal_id: proposalId, warning_type: "stale_context_warning", severity: "warning", message: "Preparation context is stale.", refs: [preparationPlan.context_pack_ref ?? ""] }));
    }
    if (!preparationPlan.validation_plan_ref || preparationPlan.validation_plan.status !== "planned") add("missing_validation_plan", "Write dry-run requires a planned validation plan artifact.", [preparationPlan.validation_plan_ref ?? ""]);
    if (!preparationPlan.review_policy_ref || preparationPlan.review_policy.status !== "planned") add("missing_review_policy", "Dry-run requires a planned review policy artifact.", [preparationPlan.review_policy_ref ?? ""]);
    if (!preparationPlan.integration_preview_ref || preparationPlan.integration_preview.status !== "available") add("missing_integration_preview", "Dry-run requires an available IntegrationManager preview artifact.", [preparationPlan.integration_preview_ref ?? ""]);
    if (!preparationPlan.lock_plan_ref || !requiredLockPreview(preparationPlan).length) add("missing_lock_preview", "Dry-run requires derived lock preview refs; locks are not acquired.", [preparationPlan.lock_plan_ref ?? ""]);
    if (preparationPlan.intended_writer_slot.max_active_writers !== 1 || preparationPlan.intended_writer_slot.invocation_allowed !== false) add("invalid_writer_slot", "Preparation must contain exactly one non-invoked writer slot.");
    if (!preparationPlan.allowed_files.length || !Array.isArray(preparationPlan.forbidden_files)) add("missing_scope", "Dry-run requires known allowed_files and forbidden_files.");
    const nodeStatus = await this.proposedNodeStatus(preparationPlan);
    if (nodeStatus && ["blocked", "rejected", "duplicate", "superseded"].includes(nodeStatus)) add("blocked_proposed_node", `Proposed node status ${nodeStatus} blocks dry-run.`, [preparationPlan.proposed_node_id]);
    if (!request?.allow_duplicate_preparation && await this.hasActiveProposal(preparationPlan.preparation_plan_id)) add("duplicate_proposal", "An active dry-run proposal already exists for this preparation plan.", [preparationPlan.preparation_plan_id]);
    if (mode === "fake_provider" || (mode === "auto" && !(this.config.allow_real_provider_dry_run ?? false))) {
      warnings.push(createOneWriterDryRunWarning({ proposal_id: proposalId, warning_type: "fake_provider", severity: "info", message: "Fake provider mode selected; no real provider/API call will be made.", refs: [] }));
    }
    return {
      allowed: blockers.length === 0,
      status: blockers.length ? "blocked" : "pending",
      blockers,
      warnings
    };
  }

  async callDryRunWriterProvider(input: OneWriterDryRunProviderInput, provider = this.selectProvider(input.request.mode)): Promise<OneWriterDryRunProviderResult> {
    await this.traceWriter.write({
      run_id: input.run_id,
      event_type: "one_writer_dry_run_provider_started",
      lifecycle_stage: "planning",
      summary: `Dry-run writer provider started for ${input.preparation_plan_id}.`,
      metadata_json: { proposal_id: input.proposal_id, provider_name: provider.provider_name, provider_mode: provider.provider_mode, provider_calls: 1 }
    });
    return provider.generatePatchProposal(input);
  }

  parsePatchProposalOutput(rawOutput: string, proposal: OneWriterDryRunProposal): PatchProposal {
    const value = JSON.parse(rawOutput) as Record<string, unknown>;
    const requiredArrays = ["changed_files", "file_changes", "risks", "assumptions", "validation_recommendations", "review_notes"];
    if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Patch proposal output missing summary.");
    for (const key of requiredArrays) {
      if (!Array.isArray(value[key])) throw new Error(`Patch proposal output missing array ${key}.`);
    }
    if (!Number.isFinite(Number(value.confidence))) throw new Error("Patch proposal output missing numeric confidence.");
    const fileChanges = (value.file_changes as unknown[]).map((entry, index) => parseFileChange(entry, proposal.proposal_id, index));
    const changedFiles = uniqueStrings((value.changed_files as unknown[]).map(String));
    if (fileChanges.length === 0 && changedFiles.length > 0) throw new Error("Patch proposal changed_files requires file_changes entries.");
    return createPatchProposal({
      proposal_id: proposal.proposal_id,
      run_id: proposal.run_id,
      preparation_plan_id: proposal.preparation_plan_id,
      summary: value.summary,
      changed_files: changedFiles,
      file_changes: fileChanges,
      risks: (value.risks as unknown[]).map(String),
      assumptions: (value.assumptions as unknown[]).map(String),
      validation_recommendations: (value.validation_recommendations as unknown[]).map(String),
      review_notes: (value.review_notes as unknown[]).map(String),
      confidence: Number(value.confidence),
      metadata_json: { dry_run_only: true, no_patch_applied: true }
    });
  }

  checkPatchProposalScope(proposal: OneWriterDryRunProposal, preparationPlan: ExecutionPreparationPlan): PatchProposalScopeCheck {
    if (!proposal.patch_proposal) {
      throw new Error("Patch proposal is missing parsed output.");
    }
    return runScopeCheck({ proposalId: proposal.proposal_id, patchProposal: proposal.patch_proposal, preparationPlan });
  }

  async persistPatchProposal(proposal: OneWriterDryRunProposal, artifacts: Partial<Parameters<OrchestrationArtifactStore["saveOneWriterDryRunProposalArtifacts"]>[0]> = {}) {
    const refs = await this.artifactStore.saveOneWriterDryRunProposalArtifacts({
      proposal,
      ...artifacts
    });
    proposal.artifact_ref = refs.artifactRef;
    proposal.patch_artifact_ref = refs.patchProposalRef;
    if (artifacts.rawOutput !== undefined) proposal.raw_output_ref = refs.rawOutputRef;
    if (artifacts.parsedOutput !== undefined) proposal.parsed_output_ref = refs.parsedOutputRef;
    await this.metadata.recordOneWriterDryRunProposalSaved(proposal);
    return proposal;
  }

  summarizePatchProposalBatch(proposals: OneWriterDryRunProposal[], runId = proposals[0]?.run_id ?? "") {
    return createPatchProposalSummary({
      run_id: runId,
      one_writer_dry_run_used: proposals.length > 0,
      dry_run_proposal_count: proposals.length,
      generated_count: proposals.filter((proposal) => ["generated", "accepted_for_review_candidate"].includes(proposal.status)).length,
      schema_failed_count: proposals.filter((proposal) => proposal.status === "schema_failed").length,
      scope_failed_count: proposals.filter((proposal) => proposal.status === "scope_failed").length,
      blocked_count: proposals.filter((proposal) => proposal.status === "blocked").length,
      review_candidate_count: proposals.filter((proposal) => proposal.status === "accepted_for_review_candidate").length,
      changed_files_preview: uniqueStrings(proposals.flatMap((proposal) => proposal.changed_files)).slice(0, 25),
      metadata_json: { no_patch_applied: true, no_validation_run: true }
    });
  }

  private createBaseProposal(
    plan: ExecutionPreparationPlan,
    proposalId: string,
    status: OneWriterDryRunStatus,
    providerMode: OneWriterDryRunRequest["mode"],
    blockers: OneWriterDryRunBlocker[] = [],
    warnings: OneWriterDryRunWarning[] = []
  ): OneWriterDryRunProposal {
    return createOneWriterDryRunProposal({
      proposal_id: proposalId,
      run_id: plan.run_id,
      preparation_plan_id: plan.preparation_plan_id,
      queue_item_id: plan.queue_item_id,
      promotion_request_id: plan.promotion_request_id,
      approval_id: plan.approval_id,
      proposed_node_id: plan.proposed_node_id,
      team_id: plan.team_id,
      writer_role: plan.writer_role,
      provider_mode: providerMode,
      prompt_id: plan.prompt_id,
      prompt_quality_result_ref: plan.prompt_quality_result_ref,
      context_pack_ref: plan.context_pack_ref,
      patch_summary: "",
      changed_files: [],
      allowed_files: plan.allowed_files,
      forbidden_files: plan.forbidden_files,
      forbidden_file_violations: [],
      out_of_scope_changes: [],
      required_locks_preview: requiredLockPreview(plan),
      validation_plan_ref: plan.validation_plan_ref,
      review_policy_ref: plan.review_policy_ref,
      integration_preview_ref: plan.integration_preview_ref,
      risk_level: plan.risk_level,
      status,
      blockers,
      warnings,
      metadata_json: {
        dry_run_only: true,
        no_patch_applied: true,
        no_validation_run: true,
        no_locks_acquired: true,
        no_scheduler_enqueue: true,
        no_recursive_execution: true
      }
    });
  }

  private async buildWriterPrompt(plan: ExecutionPreparationPlan, proposalId: string): Promise<RenderedPrompt> {
    const validationRequirements = [
      ...plan.validation_plan.required_commands,
      ...plan.validation_plan.required_checks
    ];
    const render = renderRolePrompt({
      run_id: plan.run_id,
      task_id: plan.proposed_node_id,
      agent_role: plan.writer_role,
      task_title: `Dry-run patch proposal for ${plan.proposed_node_id}`,
      task_objective: plan.objective,
      context_pack_ref: plan.context_pack_ref ?? plan.preparation_plan_id,
      allowed_files: plan.allowed_files,
      forbidden_files: plan.forbidden_files,
      relevant_files: uniqueStrings([...plan.allowed_files, ...plan.read_only_files]),
      validation_requirements: validationRequirements,
      expected_output_schema: "OneWriterDryRunPatchProposalOutput",
      output_schema_name: "OneWriterDryRunPatchProposalOutput",
      source_component: "OneWriterDryRunExecutor",
      metadata_json: {
        proposal_id: proposalId,
        preparation_plan_id: plan.preparation_plan_id,
        approval_id: plan.approval_id,
        prompt_writer_output_ref: plan.prompt_writer_output_ref,
        gated_prompt_writer_only: Boolean(plan.prompt_writer_output_ref)
      }
    });
    if (!render.ok) throw new Error(render.error.message);
    const extra = [
      render.rendered.text,
      "",
      "Dry-run patch proposal constraints:",
      "- Output is a patch proposal artifact only.",
      "- Do not state that repository files were modified.",
      "- Do not state that validation passed; validation remains pending until a later validation gate records evidence.",
      "- Do not touch forbidden files.",
      "- Do not propose changes outside allowed files.",
      "- Do not request recursive execution, sub-runs, scheduler enqueue, lock acquisition, patch application, or integration acceptance.",
      "- Stop with blockers when scope, context, prompt quality, validation, review, integration preview, or lock preview is missing.",
      "",
      "Read-only files:",
      ...(plan.read_only_files.length ? plan.read_only_files.map((file) => `- ${file}`) : ["- none"]),
      "",
      "Review policy:",
      JSON.stringify(plan.review_policy, null, 2),
      "",
      "Integration preview:",
      JSON.stringify(plan.integration_preview, null, 2),
      "",
      "Required lock preview:",
      ...requiredLockPreview(plan).map((lock) => `- ${lock}`),
      "",
      "Return strict JSON with keys: summary, changed_files, file_changes, risks, assumptions, validation_recommendations, review_notes, confidence.",
      "Each file_changes item must include path, change_type, proposed_diff or replacement_snippet_ref, rationale, risk, within_allowed_scope."
    ].join("\n");
    return {
      ...render.rendered,
      prompt_id: `prompt_${hashRenderedPrompt([render.rendered.prompt_id, proposalId, extra].join("\0")).slice(0, 24)}`,
      output_schema_name: "OneWriterDryRunPatchProposalOutput",
      text: extra,
      input_hash: hashPromptInput({
        preparation_plan_id: plan.preparation_plan_id,
        proposal_id: proposalId,
        output_schema_name: "OneWriterDryRunPatchProposalOutput"
      }),
      rendered_prompt_hash: hashRenderedPrompt(extra),
      metadata_json: {
        ...render.rendered.metadata_json,
        one_writer_dry_run: true,
        no_patch_applied: true,
        no_validation_run: true
      }
    };
  }

  private providerInput(request: OneWriterDryRunRequest, proposal: OneWriterDryRunProposal, prompt: string): OneWriterDryRunProviderInput {
    return {
      request,
      proposal_id: proposal.proposal_id,
      run_id: proposal.run_id,
      preparation_plan_id: proposal.preparation_plan_id,
      prompt,
      prompt_id: proposal.prompt_id ?? "",
      objective: proposal.patch_summary || "",
      allowed_files: proposal.allowed_files,
      forbidden_files: proposal.forbidden_files,
      read_only_files: [],
      validation_requirements: [],
      review_policy: { ref: proposal.review_policy_ref },
      integration_preview: { ref: proposal.integration_preview_ref },
      required_locks_preview: proposal.required_locks_preview,
      metadata_json: { dry_run_only: true }
    };
  }

  private selectProvider(mode: OneWriterDryRunRequest["mode"]): OneWriterDryRunProvider {
    if (this.provider) return this.provider;
    if (mode === "provider" && !(this.config.allow_real_provider_dry_run ?? false)) {
      throw new Error("Real provider dry-run was requested without allow_real_provider_dry_run.");
    }
    return new FakeOneWriterDryRunProvider(mode === "provider" ? "provider" : "fake_provider");
  }

  private async loadPreparedPlansForRun(runId: string, ids?: string[]) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = store.all<Record<string, unknown>>(
        "SELECT * FROM factory_execution_preparation_plans WHERE run_id = ? AND status = 'prepared' ORDER BY created_at",
        runId
      );
      const allowedIds = ids?.length ? new Set(ids) : undefined;
      const filtered = allowedIds ? rows.filter((row) => allowedIds.has(String(row.preparation_plan_id))) : rows;
      const plans: ExecutionPreparationPlan[] = [];
      for (const row of filtered) {
        const artifactRef = typeof row.artifact_ref === "string" ? row.artifact_ref : undefined;
        if (artifactRef && existsSync(artifactRef)) plans.push(await readJson<ExecutionPreparationPlan>(artifactRef));
      }
      return plans;
    } finally {
      store.close();
    }
  }

  private async proposedNodeStatus(plan: ExecutionPreparationPlan) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ status?: string }>("SELECT status FROM factory_proposed_task_nodes WHERE proposed_node_id = ? ORDER BY created_at DESC LIMIT 1", plan.proposed_node_id);
      return row?.status;
    } finally {
      store.close();
    }
  }

  private async hasActiveProposal(preparationPlanId: string) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return false;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM factory_one_writer_dry_run_proposals WHERE preparation_plan_id = ? AND status IN ('pending','generated','accepted_for_review_candidate')",
        preparationPlanId
      );
      return Number(row?.count ?? 0) > 0;
    } finally {
      store.close();
    }
  }
}

class FakeOneWriterDryRunProvider implements OneWriterDryRunProvider {
  provider_name = "fake_one_writer_dry_run_provider";
  provider_mode: "fake_provider" | "provider";

  constructor(mode: "fake_provider" | "provider") {
    this.provider_mode = mode;
  }

  async generatePatchProposal(input: OneWriterDryRunProviderInput): Promise<OneWriterDryRunProviderResult> {
    const file = input.allowed_files[0] ?? "README.md";
    return {
      provider_name: this.provider_name,
      model_name: "fake-dry-run-v1",
      raw_output: JSON.stringify({
        summary: `Dry-run patch proposal for ${file}.`,
        changed_files: [file],
        file_changes: [{
          path: file,
          change_type: "modify",
          proposed_diff: `--- a/${file}\n+++ b/${file}\n@@\n+// dry-run proposal only\n`,
          rationale: "Demonstrates a scoped dry-run patch proposal without modifying the repository.",
          risk: "low",
          within_allowed_scope: true
        }],
        risks: ["Requires later review, validation, lock acquisition, and IntegrationManager acceptance."],
        assumptions: ["Fake provider output is deterministic for tests and local dry-run previews."],
        validation_recommendations: input.validation_requirements.length ? input.validation_requirements : ["Run required validation later; no validation has been executed by this dry-run."],
        review_notes: ["Review before any future integration candidate is created."],
        confidence: 0.72
      }, null, 2)
    };
  }
}

function parseFileChange(value: unknown, proposalId: string, index: number): PatchProposalFileChange {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) throw new Error(`file_changes[${index}] must be an object.`);
  const changeType = String(record.change_type ?? "");
  if (!["create", "modify", "delete", "rename"].includes(changeType)) throw new Error(`file_changes[${index}].change_type is invalid.`);
  if (typeof record.path !== "string" || !record.path.trim()) throw new Error(`file_changes[${index}].path is required.`);
  if (typeof record.rationale !== "string") throw new Error(`file_changes[${index}].rationale is required.`);
  const risk = String(record.risk ?? "medium");
  if (!["low", "medium", "high", "critical"].includes(risk)) throw new Error(`file_changes[${index}].risk is invalid.`);
  if (typeof record.within_allowed_scope !== "boolean") throw new Error(`file_changes[${index}].within_allowed_scope is required.`);
  return createPatchProposalFileChange({
    proposal_id: proposalId,
    path: record.path,
    change_type: changeType as PatchProposalFileChange["change_type"],
    proposed_diff: typeof record.proposed_diff === "string" ? record.proposed_diff : undefined,
    replacement_snippet_ref: typeof record.replacement_snippet_ref === "string" ? record.replacement_snippet_ref : undefined,
    rationale: record.rationale,
    risk: risk as PatchProposalFileChange["risk"],
    within_allowed_scope: record.within_allowed_scope
  });
}

function blocker(proposalId: string, type: OneWriterDryRunBlocker["blocker_type"], reason: string, refs: string[] = []) {
  return createOneWriterDryRunBlocker({
    proposal_id: proposalId,
    blocker_type: type,
    severity: "blocking",
    reason,
    refs: refs.filter(Boolean)
  });
}

function requiredLockPreview(plan: ExecutionPreparationPlan) {
  return uniqueStrings([
    ...plan.required_file_locks,
    ...plan.required_module_locks,
    ...plan.required_semantic_locks
  ]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean).map((value) => value.replaceAll("\\", "/")))].sort((left, right) => left.localeCompare(right));
}
