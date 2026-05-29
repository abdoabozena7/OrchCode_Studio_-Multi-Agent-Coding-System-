import { existsSync } from "node:fs";
import path from "node:path";
import { readJson } from "../memory/ProjectMemory.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { riskLevelForFiles } from "./IntegrationModels.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { PatchApplySandboxResult } from "./PatchApplySandboxModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import {
  createIntegrationCandidateBatch,
  createIntegrationCandidateBlocker,
  createIntegrationCandidateCreationRequest,
  createIntegrationCandidateCreationResult,
  createIntegrationCandidateSummary,
  createIntegrationCandidateWarning,
  createPostIntegrationValidationPlan,
  createRollbackRequirements,
  createSandboxValidatedIntegrationCandidate,
  type IntegrationCandidateBatch,
  type IntegrationCandidateBlocker,
  type IntegrationCandidateCreationResult,
  type IntegrationCandidateStatus,
  type PostIntegrationValidationPlan,
  type SandboxValidatedIntegrationCandidate
} from "./SandboxIntegrationCandidateModels.js";
import type { SandboxValidationResult } from "./SandboxValidationModels.js";
import type { ValidationCandidate } from "./ValidationCandidateModels.js";

export type SandboxIntegrationCandidateGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type IntegrationCandidateBatchOptions = {
  sandboxValidationIds?: string[];
};

type LoadedInputs = {
  sandboxValidationResult: SandboxValidationResult;
  sandboxApply?: PatchApplySandboxResult;
  validationCandidate?: ValidationCandidate;
  review?: PatchProposalReview;
  proposal?: OneWriterDryRunProposal;
};

type CandidateValidation = LoadedInputs & {
  status: IntegrationCandidateStatus;
  blockers: IntegrationCandidateBlocker[];
};

export class SandboxIntegrationCandidateGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: SandboxIntegrationCandidateGateOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "SandboxIntegrationCandidateGate" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async createCandidateFromSandboxValidation(sandboxValidationResult: SandboxValidationResult): Promise<IntegrationCandidateCreationResult> {
    const integrationCandidateId = `sandbox_integration_candidate_${sandboxValidationResult.sandbox_validation_id}`;
    await this.traceWriter.write({
      run_id: sandboxValidationResult.run_id,
      event_type: "sandbox_integration_candidate_started",
      lifecycle_stage: "planning",
      summary: `Sandbox integration candidacy started for ${sandboxValidationResult.sandbox_validation_id}.`,
      artifact_refs: [sandboxValidationResult.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_candidate_id: integrationCandidateId, no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
    const loaded = await this.validateCandidateInputs(sandboxValidationResult, integrationCandidateId);
    const rollback = this.buildRollbackRequirements(loaded);
    const postValidation = this.buildPostIntegrationValidationPlan(loaded);
    const locks = this.deriveIntegrationLocks(loaded);
    const warnings = [
      createIntegrationCandidateWarning({
        integration_candidate_id: integrationCandidateId,
        run_id: sandboxValidationResult.run_id,
        warning_type: "future_apply_required",
        severity: "info",
        message: "Candidate creation does not apply or integrate the patch.",
        refs: [sandboxValidationResult.sandbox_validation_id]
      }),
      createIntegrationCandidateWarning({
        integration_candidate_id: integrationCandidateId,
        run_id: sandboxValidationResult.run_id,
        warning_type: "locks_not_acquired",
        severity: "info",
        message: "Locks were derived for a future apply gate but not acquired.",
        refs: locks.required_file_locks
      }),
      createIntegrationCandidateWarning({
        integration_candidate_id: integrationCandidateId,
        run_id: sandboxValidationResult.run_id,
        warning_type: "manual_rollback_only",
        severity: "warning",
        message: "Rollback requirements are manual/limited until a tested automatic rollback path exists.",
        refs: rollback.changed_files
      }),
      createIntegrationCandidateWarning({
        integration_candidate_id: integrationCandidateId,
        run_id: sandboxValidationResult.run_id,
        warning_type: "post_integration_validation_not_run",
        severity: "info",
        message: "Post-integration validation was planned but not run.",
        refs: postValidation.required_commands
      })
    ];
    const status = loaded.blockers.length ? loaded.status : "candidate_created";
    const changedFiles = loaded.proposal?.changed_files.length ? loaded.proposal.changed_files : loaded.sandboxApply?.changed_files ?? [];
    const candidate = createSandboxValidatedIntegrationCandidate({
      integration_candidate_id: integrationCandidateId,
      run_id: sandboxValidationResult.run_id,
      proposal_id: sandboxValidationResult.proposal_id,
      review_id: sandboxValidationResult.review_id,
      validation_candidate_id: sandboxValidationResult.validation_candidate_id,
      sandbox_result_id: sandboxValidationResult.sandbox_result_id,
      sandbox_validation_id: sandboxValidationResult.sandbox_validation_id,
      preparation_plan_id: loaded.validationCandidate?.preparation_plan_id ?? loaded.proposal?.preparation_plan_id ?? "",
      proposed_node_id: loaded.validationCandidate?.proposed_node_id ?? loaded.proposal?.proposed_node_id ?? "",
      patch_artifact_ref: loaded.validationCandidate?.patch_artifact_ref ?? sandboxValidationResult.patch_artifact_ref,
      patch_summary: loaded.proposal?.patch_summary ?? "Patch proposal summary unavailable.",
      changed_files: changedFiles,
      required_file_locks: locks.required_file_locks,
      required_module_locks: locks.required_module_locks,
      required_semantic_locks: locks.required_semantic_locks,
      review_ref: loaded.review?.review_artifact_ref,
      sandbox_apply_ref: loaded.sandboxApply?.artifact_ref,
      sandbox_validation_ref: sandboxValidationResult.artifact_ref,
      strict_validation_status: sandboxValidationResult.strict_validation_status,
      rollback_requirements: rollback,
      post_integration_validation_plan: postValidation,
      risk_level: loaded.proposal?.risk_level ?? riskLevelForFiles(changedFiles),
      approval_required: true,
      status,
      blockers: loaded.blockers,
      warnings,
      metadata_json: {
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true,
        integration_manager_required_for_apply: true,
        review_decision: loaded.review?.decision,
        dry_apply_status: loaded.sandboxApply?.dry_apply_status,
        main_repo_modified: loaded.sandboxApply?.main_repo_modified,
        main_repo_integrity_ok: loaded.sandboxApply?.main_repo_modified === false,
        scope_check_status: loaded.proposal?.scope_check_result?.status,
        forbidden_files: loaded.proposal?.forbidden_files ?? []
      }
    });
    const persisted = await this.persistIntegrationCandidate(candidate, {
      sandboxValidationResult,
      sandboxApply: loaded.sandboxApply,
      validationCandidate: loaded.validationCandidate,
      review: loaded.review,
      proposal: loaded.proposal
    });
    const eventType = status === "candidate_created" ? "sandbox_integration_candidate_created"
      : status === "rejected" ? "sandbox_integration_candidate_rejected"
        : "sandbox_integration_candidate_blocked";
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: eventType,
      lifecycle_stage: status === "candidate_created" ? "planning" : "blocked",
      severity: status === "candidate_created" ? "info" : "warning",
      summary: `Sandbox integration candidate ${status}.`,
      artifact_refs: [persisted.artifact_ref, persisted.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id, blocker_count: candidate.blockers.length }
    });
    return createIntegrationCandidateCreationResult({
      run_id: sandboxValidationResult.run_id,
      sandbox_validation_id: sandboxValidationResult.sandbox_validation_id,
      status,
      candidate: persisted,
      blockers: persisted.blockers,
      warnings: persisted.warnings,
      artifact_refs: [persisted.artifact_ref, persisted.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
  }

  async createCandidateBatch(runId: string, options: IntegrationCandidateBatchOptions = {}): Promise<IntegrationCandidateBatch> {
    if (!this.config.enable_sandbox_integration_candidates || this.config.sandbox_integration_candidate_mode === "off") {
      const summary = this.summarizeIntegrationCandidates([], runId);
      const batch = createIntegrationCandidateBatch({
        run_id: runId,
        sandbox_validation_ids: [],
        candidates: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_apply: true, no_validation_run: true }
      });
      const refs = await this.artifactStore.saveSandboxIntegrationCandidateBatch(batch);
      batch.artifact_ref = refs.batchRef;
      batch.summary_ref = refs.summaryRef;
      batch.summary.candidate_summary_ref = refs.summaryRef;
      await this.metadata.recordSandboxIntegrationCandidateBatchSaved(batch);
      return batch;
    }
    const validations = await this.loadSandboxValidationResultsForRun(runId, options.sandboxValidationIds);
    const limit = this.config.max_integration_candidates_per_run ?? 12;
    const results: IntegrationCandidateCreationResult[] = [];
    for (const validation of validations.slice(0, limit)) {
      if (this.config.require_passed_sandbox_validation !== false && validation.strict_validation_status !== "passed") {
        results.push(await this.createCandidateFromSandboxValidation(validation));
        continue;
      }
      results.push(await this.createCandidateFromSandboxValidation(validation));
    }
    const candidates = results.flatMap((result) => result.candidate ? [result.candidate] : []);
    const summary = this.summarizeIntegrationCandidates(candidates, runId);
    const batch = createIntegrationCandidateBatch({
      run_id: runId,
      sandbox_validation_ids: validations.slice(0, limit).map((validation) => validation.sandbox_validation_id),
      candidates,
      results,
      summary,
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
    const refs = await this.artifactStore.saveSandboxIntegrationCandidateBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.candidate_summary_ref = refs.summaryRef;
    await this.metadata.recordSandboxIntegrationCandidateBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "sandbox_integration_candidate_batch_completed",
      lifecycle_stage: "planning",
      summary: `Sandbox integration candidate batch completed with ${candidates.length} candidate record(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...summary, no_apply: true, no_validation_run: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "sandbox_integration_candidate_summary_created",
      lifecycle_stage: "planning",
      summary: "Sandbox integration candidate summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { summary_id: summary.summary_id }
    });
    return batch;
  }

  async validateCandidateInputs(sandboxValidationResult: SandboxValidationResult, integrationCandidateId = `sandbox_integration_candidate_${sandboxValidationResult.sandbox_validation_id}`): Promise<CandidateValidation> {
    const blockers: IntegrationCandidateBlocker[] = [];
    const add = (blocker_type: IntegrationCandidateBlocker["blocker_type"], reason: string, refs: string[] = []) => {
      blockers.push(createIntegrationCandidateBlocker({
        integration_candidate_id: integrationCandidateId,
        run_id: sandboxValidationResult.run_id,
        blocker_type,
        severity: "blocking",
        reason,
        refs
      }));
    };
    const sandboxApply = await this.loadSandboxApply(sandboxValidationResult);
    const validationCandidate = await this.loadValidationCandidate(sandboxValidationResult);
    const review = validationCandidate ? await this.loadReview(validationCandidate) : undefined;
    const proposal = await this.loadProposal(sandboxValidationResult);
    if (!sandboxValidationResult.artifact_ref || !existsSync(sandboxValidationResult.artifact_ref)) add("missing_sandbox_validation", "Sandbox validation artifact is missing.", [sandboxValidationResult.sandbox_validation_id]);
    if (sandboxValidationResult.strict_validation_status === "failed") add("validation_failed", "Sandbox validation strict status failed.", [sandboxValidationResult.sandbox_validation_id]);
    if (["blocked", "partial", "skipped", "not_run"].includes(sandboxValidationResult.strict_validation_status)) add("validation_blocked", `Sandbox validation strict status is ${sandboxValidationResult.strict_validation_status}.`, [sandboxValidationResult.sandbox_validation_id]);
    if (sandboxValidationResult.status !== "passed") add(sandboxValidationResult.status === "failed" ? "validation_failed" : "validation_blocked", `Sandbox validation result status is ${sandboxValidationResult.status}.`, [sandboxValidationResult.sandbox_validation_id]);
    if (!sandboxApply) add("missing_sandbox_apply", "Patch apply sandbox artifact could not be loaded.", [sandboxValidationResult.sandbox_result_id]);
    if (sandboxApply && sandboxApply.dry_apply_status !== "dry_apply_passed") add("dry_apply_failed", `Patch apply sandbox status is ${sandboxApply.dry_apply_status}.`, [sandboxApply.sandbox_result_id]);
    if (sandboxApply && sandboxApply.main_repo_modified !== false) add("main_repo_integrity_failed", "Patch apply sandbox did not prove main repo integrity.", [sandboxApply.sandbox_result_id]);
    if (!validationCandidate) add("missing_validation_candidate", "Validation candidate artifact could not be loaded.", [sandboxValidationResult.validation_candidate_id]);
    if (validationCandidate && validationCandidate.status !== "preflight_passed") add("validation_candidate_not_preflight_passed", `Validation candidate status is ${validationCandidate.status}.`, [validationCandidate.validation_candidate_id]);
    if (!review) add("missing_review", "Patch proposal review artifact could not be loaded.", [sandboxValidationResult.review_id]);
    if (review && review.decision !== "accept_for_validation_candidate") add("review_not_accepted", `Review decision is ${review.decision}.`, [review.review_id]);
    if (review && review.findings.some((finding) => finding.blocking || finding.severity === "critical")) add("critical_review_blocker", "Review has blocking or critical findings.", [review.review_id]);
    if (!proposal) add("missing_proposal", "Patch proposal artifact could not be loaded.", [sandboxValidationResult.proposal_id]);
    if (proposal?.scope_check_result?.status !== "passed") add("scope_failed", "Patch proposal scope check has not passed.", [proposal?.proposal_id ?? sandboxValidationResult.proposal_id]);
    const patchRef = validationCandidate?.patch_artifact_ref ?? sandboxValidationResult.patch_artifact_ref;
    if (!patchRef || !existsSync(patchRef)) add("missing_patch_artifact", "Patch artifact ref is missing.", [patchRef ?? sandboxValidationResult.proposal_id]);
    const changedFiles = proposal?.changed_files.length ? proposal.changed_files : sandboxApply?.changed_files ?? [];
    if (!changedFiles.length) add("missing_changed_files", "Changed files are not known.", [sandboxValidationResult.proposal_id]);
    if (!this.deriveIntegrationLocks({ sandboxValidationResult, sandboxApply, validationCandidate, review, proposal }).required_file_locks.length) add("missing_locks", "Required file locks are not derivable.", changedFiles);
    if (this.config.require_post_integration_validation_plan !== false && validationCandidate && !validationCandidate.required_commands.length && !validationCandidate.optional_commands.length) {
      add("missing_post_integration_validation_plan", "Post-integration validation plan has no commands.", [validationCandidate.validation_candidate_id]);
    }
    if (this.config.require_rollback_plan !== false && !changedFiles.length) add("missing_rollback_plan", "Rollback requirements cannot be planned without changed files.", [sandboxValidationResult.proposal_id]);
    return {
      sandboxValidationResult,
      sandboxApply,
      validationCandidate,
      review,
      proposal,
      blockers,
      status: statusFromBlockers(blockers)
    };
  }

  buildRollbackRequirements(input: LoadedInputs) {
    const changedFiles = input.proposal?.changed_files.length ? input.proposal.changed_files : input.sandboxApply?.changed_files ?? [];
    return createRollbackRequirements({
      status: "manual_limited",
      changed_files: changedFiles,
      rollback_refs: [input.sandboxValidationResult.patch_artifact_ref, input.sandboxApply?.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      instructions: [
        "Do not apply this candidate without a future IntegrationManager apply gate.",
        "Before applying, capture a fresh main-repo diff and file snapshot for every changed file.",
        "If post-integration validation fails, revert using the captured snapshot or operator-reviewed reverse patch."
      ],
      limitations: ["Automatic rollback is not claimed by this candidacy artifact."],
      metadata_json: { no_apply: true, automatic_rollback_claimed: false }
    });
  }

  buildPostIntegrationValidationPlan(input: LoadedInputs): PostIntegrationValidationPlan {
    const candidate = input.validationCandidate;
    return createPostIntegrationValidationPlan({
      required_commands: candidate?.required_commands ?? [],
      optional_commands: candidate?.optional_commands ?? [],
      expected_outputs: candidate?.expected_validation_outputs ?? [],
      strict_validation_semantics_ref: candidate?.strict_validation_semantics_ref,
      sandbox_validation_id: input.sandboxValidationResult.sandbox_validation_id,
      sandbox_strict_validation_status: input.sandboxValidationResult.strict_validation_status,
      additional_checks: ["Re-run required validation after a future main-repo apply gate."],
      metadata_json: { commands_not_run: true, related_sandbox_validation_ref: input.sandboxValidationResult.artifact_ref }
    });
  }

  deriveIntegrationLocks(input: LoadedInputs) {
    const changedFiles = input.proposal?.changed_files.length ? input.proposal.changed_files : input.sandboxApply?.changed_files ?? [];
    const previewLocks = input.proposal?.required_locks_preview.filter(Boolean) ?? [];
    const requiredFileLocks = uniqueStrings(previewLocks.length ? previewLocks : changedFiles);
    const requiredModuleLocks = uniqueStrings(changedFiles.map((file) => moduleLockForFile(file)).filter(Boolean));
    const requiredSemanticLocks = uniqueStrings([
      input.validationCandidate?.preparation_plan_id ? `preparation:${input.validationCandidate.preparation_plan_id}` : "",
      input.proposal?.proposed_node_id ? `proposed_node:${input.proposal.proposed_node_id}` : ""
    ].filter(Boolean));
    return {
      required_file_locks: requiredFileLocks,
      required_module_locks: requiredModuleLocks,
      required_semantic_locks: requiredSemanticLocks
    };
  }

  async persistIntegrationCandidate(candidate: SandboxValidatedIntegrationCandidate, input?: LoadedInputs) {
    const refs = await this.artifactStore.saveSandboxIntegrationCandidate({
      candidate,
      input,
      rollbackRequirements: candidate.rollback_requirements,
      postIntegrationValidationPlan: candidate.post_integration_validation_plan
    });
    candidate.artifact_ref = refs.candidateRef;
    candidate.rollback_requirements_ref = refs.rollbackRef;
    candidate.rollback_requirements.artifact_ref = refs.rollbackRef;
    candidate.post_integration_validation_plan_ref = refs.postValidationRef;
    candidate.post_integration_validation_plan.artifact_ref = refs.postValidationRef;
    candidate.summary_ref = refs.summaryRef;
    await this.metadata.recordSandboxIntegrationCandidateSaved(candidate);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "sandbox_integration_candidate_locks_derived",
      lifecycle_stage: "planning",
      summary: "Sandbox integration candidate locks derived for future apply gate.",
      metadata_json: {
        integration_candidate_id: candidate.integration_candidate_id,
        file_lock_count: candidate.required_file_locks.length,
        module_lock_count: candidate.required_module_locks.length,
        semantic_lock_count: candidate.required_semantic_locks.length,
        no_locks_acquired: true
      }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "sandbox_integration_candidate_rollback_planned",
      lifecycle_stage: "planning",
      summary: "Sandbox integration candidate rollback requirements planned.",
      artifact_refs: [candidate.rollback_requirements_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id, rollback_status: candidate.rollback_requirements.status }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "sandbox_integration_candidate_post_validation_planned",
      lifecycle_stage: "planning",
      summary: "Sandbox integration candidate post-integration validation planned.",
      artifact_refs: [candidate.post_integration_validation_plan_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        integration_candidate_id: candidate.integration_candidate_id,
        required_command_count: candidate.post_integration_validation_plan.required_commands.length,
        commands_run: false
      }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "sandbox_integration_candidate_persisted",
      lifecycle_stage: "planning",
      summary: `Sandbox integration candidate persisted with status ${candidate.status}.`,
      artifact_refs: [candidate.artifact_ref, candidate.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id, status: candidate.status }
    });
    return candidate;
  }

  summarizeIntegrationCandidates(candidates: SandboxValidatedIntegrationCandidate[], runId = candidates[0]?.run_id ?? "") {
    return createIntegrationCandidateSummary({
      run_id: runId,
      sandbox_integration_candidate_used: candidates.length > 0,
      integration_candidate_count: candidates.length,
      candidate_created_count: candidates.filter((candidate) => candidate.status === "candidate_created").length,
      blocked_count: candidates.filter((candidate) => candidate.status === "blocked" || candidate.status === "missing_review" || candidate.status === "missing_sandbox_apply" || candidate.status === "missing_sandbox_validation" || candidate.status === "dry_apply_failed" || candidate.status === "scope_failed").length,
      rejected_count: candidates.filter((candidate) => candidate.status === "rejected").length,
      validation_failed_count: candidates.filter((candidate) => candidate.status === "validation_failed").length,
      validation_blocked_count: candidates.filter((candidate) => candidate.status === "validation_blocked").length,
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
  }

  private async loadSandboxValidationResultsForRun(runId: string, sandboxValidationIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return [];
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = sandboxValidationIds?.length
        ? store.all<{ artifact_ref?: string }>(
          `SELECT artifact_ref FROM factory_sandbox_validation_results WHERE run_id = ? AND sandbox_validation_id IN (${sandboxValidationIds.map(() => "?").join(",")}) ORDER BY created_at`,
          runId,
          ...sandboxValidationIds
        )
        : store.all<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_sandbox_validation_results WHERE run_id = ? ORDER BY created_at", runId);
      const results: SandboxValidationResult[] = [];
      for (const row of rows) {
        if (row.artifact_ref && existsSync(row.artifact_ref)) results.push(await readJson<SandboxValidationResult>(row.artifact_ref));
      }
      return results;
    } finally {
      store.close();
    }
  }

  private async loadSandboxApply(sandboxValidationResult: SandboxValidationResult) {
    const row = await this.getMetadataRow<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_patch_apply_sandbox_results WHERE sandbox_result_id = ?", sandboxValidationResult.sandbox_result_id);
    return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<PatchApplySandboxResult>(row.artifact_ref) : undefined;
  }

  private async loadValidationCandidate(sandboxValidationResult: SandboxValidationResult) {
    const row = await this.getMetadataRow<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_validation_candidates WHERE validation_candidate_id = ?", sandboxValidationResult.validation_candidate_id);
    return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<ValidationCandidate>(row.artifact_ref) : undefined;
  }

  private async loadReview(candidate: ValidationCandidate) {
    return candidate.review_artifact_ref && existsSync(candidate.review_artifact_ref) ? readJson<PatchProposalReview>(candidate.review_artifact_ref) : undefined;
  }

  private async loadProposal(sandboxValidationResult: SandboxValidationResult) {
    const row = await this.getMetadataRow<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_one_writer_dry_run_proposals WHERE proposal_id = ?", sandboxValidationResult.proposal_id);
    return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<OneWriterDryRunProposal>(row.artifact_ref) : undefined;
  }

  private async getMetadataRow<T extends Record<string, unknown>>(sql: string, ...params: unknown[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.get<T>(sql, ...params);
    } finally {
      store.close();
    }
  }
}

function statusFromBlockers(blockers: IntegrationCandidateBlocker[]): IntegrationCandidateStatus {
  if (!blockers.length) return "pending";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_review")) return "missing_review";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_sandbox_apply")) return "missing_sandbox_apply";
  if (blockers.some((blocker) => blocker.blocker_type === "missing_sandbox_validation")) return "missing_sandbox_validation";
  if (blockers.some((blocker) => blocker.blocker_type === "validation_failed")) return "validation_failed";
  if (blockers.some((blocker) => blocker.blocker_type === "validation_blocked")) return "validation_blocked";
  if (blockers.some((blocker) => blocker.blocker_type === "dry_apply_failed")) return "dry_apply_failed";
  if (blockers.some((blocker) => blocker.blocker_type === "scope_failed")) return "scope_failed";
  if (blockers.some((blocker) => blocker.blocker_type === "review_not_accepted")) return "rejected";
  if (blockers.some((blocker) => blocker.blocker_type === "cancelled")) return "cancelled";
  return "blocked";
}

function moduleLockForFile(file: string) {
  const normalized = file.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return "";
  if (parts[0] === "apps" && parts.length >= 3) return `module:${parts.slice(0, 3).join("/")}`;
  if (parts.length >= 2) return `module:${parts.slice(0, 2).join("/")}`;
  return `module:${parts[0]}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
