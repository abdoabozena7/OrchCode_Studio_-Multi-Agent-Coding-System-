import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readJson } from "../memory/ProjectMemory.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { PatchApplySandboxResult } from "./PatchApplySandboxModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import type { OneWriterDryRunProposal } from "./OneWriterDryRunModels.js";
import type { SandboxValidatedIntegrationCandidate } from "./SandboxIntegrationCandidateModels.js";
import {
  createDirtyWorktreeFinding,
  createIntegrationApplyApproval,
  createIntegrationApplyApprovalBatch,
  createIntegrationApplyApprovalBlocker,
  createIntegrationApplyApprovalResult,
  createIntegrationApplyApprovalSummary,
  createIntegrationApplyApprovalWarning,
  createWorktreeSafetyCheck,
  type ApplyModeRecommendation,
  type DirtyWorktreeFinding,
  type IntegrationApplyApproval,
  type IntegrationApplyApprovalBatch,
  type IntegrationApplyApprovalBlocker,
  type IntegrationApplyApprovalDecision,
  type IntegrationApplyApprovalResult,
  type IntegrationApplyApprovalStatus,
  type IntegrationApplyApprovalSummary,
  type IntegrationApplyApprovalWarning,
  type IntegrationApplyScope,
  type WorktreeSafetyCheck
} from "./IntegrationApplyApprovalModels.js";
import {
  defaultApplyScopeForCandidate,
  evaluateApplyApprovalPolicy,
  KNOWN_DIRTY_DESKTOP_FILES,
  recommendApplyModeForStatus,
  validateIntegrationApplyApprovalScope
} from "./IntegrationApplyApprovalPolicy.js";

const execFileAsync = promisify(execFile);

export type IntegrationApplyApprovalGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type IntegrationApplyApprovalBatchOptions = {
  integrationCandidateIds?: string[];
  approvalDecision?: IntegrationApplyApprovalDecision;
  approvedScope?: IntegrationApplyScope;
};

export type CandidateApplyApprovalValidation = {
  status: IntegrationApplyApprovalStatus;
  blockers: IntegrationApplyApprovalBlocker[];
  warnings: IntegrationApplyApprovalWarning[];
};

export class IntegrationApplyApprovalGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: IntegrationApplyApprovalGateOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "IntegrationApplyApprovalGate" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async evaluateIntegrationCandidateForApplyApproval(
    candidate: SandboxValidatedIntegrationCandidate | undefined,
    input: { approvalDecision?: IntegrationApplyApprovalDecision; approvedScope?: IntegrationApplyScope } = {}
  ): Promise<IntegrationApplyApprovalResult> {
    const runId = candidate?.run_id ?? "unknown_run";
    const candidateId = candidate?.integration_candidate_id ?? "missing_candidate";
    const approvalId = `integration_apply_approval_${candidateId}`;
    await this.traceWriter.write({
      run_id: runId,
      event_type: "integration_apply_approval_started",
      lifecycle_stage: "planning",
      summary: `Integration apply approval evaluation started for ${candidateId}.`,
      artifact_refs: [candidate?.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_apply_approval_id: approvalId, no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });

    if (!candidate) {
      const blocker = createIntegrationApplyApprovalBlocker({
        integration_apply_approval_id: approvalId,
        run_id: runId,
        integration_candidate_id: candidateId,
        blocker_type: "candidate_not_created",
        severity: "blocking",
        reason: "Sandbox-validated integration candidate is missing.",
        refs: []
      });
      const result = createIntegrationApplyApprovalResult({
        run_id: runId,
        integration_candidate_id: candidateId,
        approval_status: "candidate_invalid",
        blockers: [blocker],
        warnings: [],
        apply_mode_recommendation: "blocked",
        artifact_refs: [],
        metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      await this.traceWriter.write({
        run_id: runId,
        event_type: "integration_apply_approval_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Integration apply approval blocked because candidate is missing.",
        metadata_json: { integration_apply_approval_id: approvalId, blocker_type: blocker.blocker_type }
      });
      return result;
    }

    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_candidate_loaded",
      lifecycle_stage: "planning",
      summary: `Integration apply candidate loaded with status ${candidate.status}.`,
      artifact_refs: [candidate.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id, candidate_status: candidate.status }
    });

    const validation = await this.validateCandidateForApplyApproval(candidate, approvalId);
    const worktreeSafetyCheck = await this.checkWorktreeSafety(candidate);
    const worktreeBlockers = this.worktreeBlockers(approvalId, candidate, worktreeSafetyCheck);
    const worktreeWarnings = this.worktreeWarnings(approvalId, candidate, worktreeSafetyCheck);
    const requestedScope = input.approvedScope ?? input.approvalDecision?.approved_scope ?? defaultApplyScopeForCandidate(candidate);
    const scopeBlockers = this.checkApprovalScope(candidate, requestedScope, approvalId);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_approval_scope_checked",
      lifecycle_stage: "planning",
      severity: scopeBlockers.length ? "warning" : "info",
      summary: `Integration apply approval scope checked with ${scopeBlockers.length} blocker(s).`,
      metadata_json: { integration_apply_approval_id: approvalId, blocker_count: scopeBlockers.length }
    });

    await this.emitVerificationTraces(candidate, approvalId, validation.blockers);
    const policy = evaluateApplyApprovalPolicy({
      approvalId,
      candidate,
      blockers: [...validation.blockers, ...worktreeBlockers, ...scopeBlockers],
      warnings: [...validation.warnings, ...worktreeWarnings],
      worktreeSafetyCheck,
      approvalDecision: input.approvalDecision,
      config: this.config
    });
    const applyMode = this.recommendApplyModeForStatus(policy.status);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_mode_recommended",
      lifecycle_stage: "planning",
      summary: `Integration apply mode recommended: ${applyMode}.`,
      metadata_json: { integration_apply_approval_id: approvalId, apply_mode: applyMode, approval_status: policy.status }
    });

    const approval = createIntegrationApplyApproval({
      integration_apply_approval_id: approvalId,
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      proposal_id: candidate.proposal_id,
      review_id: candidate.review_id,
      validation_candidate_id: candidate.validation_candidate_id,
      sandbox_result_id: candidate.sandbox_result_id,
      sandbox_validation_id: candidate.sandbox_validation_id,
      preparation_plan_id: candidate.preparation_plan_id,
      proposed_node_id: candidate.proposed_node_id,
      approval_required: policy.approvalRequired,
      approval_status: policy.status,
      approver_type: input.approvalDecision?.approver_type ?? "none",
      approver_id: input.approvalDecision?.approver_id,
      approval_reason: input.approvalDecision?.reason ?? approvalReason(policy.status),
      approved_scope: requestedScope,
      allowed_files: requestedScope.allowed_files,
      forbidden_files: requestedScope.forbidden_files,
      changed_files: candidate.changed_files,
      required_file_locks: candidate.required_file_locks,
      required_module_locks: candidate.required_module_locks,
      required_semantic_locks: candidate.required_semantic_locks,
      rollback_requirements_ref: candidate.rollback_requirements_ref,
      post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
      worktree_safety_status: worktreeSafetyCheck.status,
      dirty_worktree_findings: worktreeSafetyCheck.findings,
      apply_mode_recommendation: applyMode,
      risk_level: candidate.risk_level,
      blockers: policy.blockers,
      warnings: policy.warnings,
      expires_at: input.approvalDecision?.expires_at ?? defaultExpiresAt(this.config.apply_approval_default_ttl_hours),
      metadata_json: {
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true,
        integration_manager_required_for_future_apply: true,
        worktree_check_id: worktreeSafetyCheck.worktree_check_id
      }
    });
    const persisted = await this.persistApplyApproval(approval, {
      candidate,
      worktreeSafetyCheck,
      approvalScopeCheck: { approved_scope: requestedScope, blockers: scopeBlockers },
      applyModeRecommendation: { recommendation: applyMode, no_apply_executed: true }
    });
    const eventType = eventTypeForStatus(persisted.approval_status);
    await this.traceWriter.write({
      run_id: persisted.run_id,
      event_type: eventType,
      lifecycle_stage: eventType.endsWith("blocked") || eventType.endsWith("rejected") ? "blocked" : "planning",
      severity: eventType.endsWith("blocked") || eventType.endsWith("rejected") ? "warning" : "info",
      summary: `Integration apply approval ${persisted.approval_status}.`,
      artifact_refs: [persisted.artifact_ref, persisted.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        integration_apply_approval_id: persisted.integration_apply_approval_id,
        status: persisted.approval_status,
        no_apply: true,
        no_validation_run: true,
        no_locks_acquired: true
      }
    });
    const result = createIntegrationApplyApprovalResult({
      run_id: persisted.run_id,
      integration_candidate_id: persisted.integration_candidate_id,
      approval_status: persisted.approval_status,
      approval: persisted,
      blockers: persisted.blockers,
      warnings: persisted.warnings,
      worktree_safety_check: worktreeSafetyCheck,
      apply_mode_recommendation: applyMode,
      artifact_refs: [persisted.artifact_ref, persisted.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
    return result;
  }

  async createApplyApprovalBatch(runId: string, options: IntegrationApplyApprovalBatchOptions = {}): Promise<IntegrationApplyApprovalBatch> {
    if (!this.config.enable_integration_apply_approval_gate || this.config.integration_apply_approval_mode === "off") {
      const summary = this.summarizeApplyApprovals([], runId);
      const batch = createIntegrationApplyApprovalBatch({
        run_id: runId,
        integration_candidate_ids: [],
        approvals: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      const refs = await this.artifactStore.saveIntegrationApplyApprovalBatch(batch);
      batch.artifact_ref = refs.batchRef;
      batch.summary_ref = refs.summaryRef;
      batch.summary.apply_approval_summary_ref = refs.summaryRef;
      await this.metadata.recordIntegrationApplyApprovalBatchSaved(batch);
      return batch;
    }

    const candidates = await this.loadIntegrationCandidatesForRun(runId, options.integrationCandidateIds);
    const limit = this.config.max_apply_approvals_per_run ?? 12;
    const results: IntegrationApplyApprovalResult[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      results.push(await this.evaluateIntegrationCandidateForApplyApproval(candidate, {
        approvalDecision: options.approvalDecision,
        approvedScope: options.approvedScope
      }));
    }
    const approvals = results.flatMap((result) => result.approval ? [result.approval] : []);
    const summary = this.summarizeApplyApprovals(approvals, runId);
    const batch = createIntegrationApplyApprovalBatch({
      run_id: runId,
      integration_candidate_ids: candidates.slice(0, limit).map((candidate) => candidate.integration_candidate_id),
      approvals,
      results,
      summary,
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
    const refs = await this.artifactStore.saveIntegrationApplyApprovalBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.apply_approval_summary_ref = refs.summaryRef;
    await this.metadata.recordIntegrationApplyApprovalBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "integration_apply_approval_batch_completed",
      lifecycle_stage: "planning",
      summary: `Integration apply approval batch completed with ${approvals.length} approval record(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { ...summary, no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "integration_apply_approval_summary_created",
      lifecycle_stage: "planning",
      summary: "Integration apply approval summary created.",
      artifact_refs: [batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { summary_id: summary.summary_id }
    });
    return batch;
  }

  async validateCandidateForApplyApproval(candidate: SandboxValidatedIntegrationCandidate, approvalId = `integration_apply_approval_${candidate.integration_candidate_id}`): Promise<CandidateApplyApprovalValidation> {
    const blockers: IntegrationApplyApprovalBlocker[] = [];
    const warnings: IntegrationApplyApprovalWarning[] = [];
    const add = (blocker_type: IntegrationApplyApprovalBlocker["blocker_type"], reason: string, refs: string[] = []) => {
      blockers.push(createIntegrationApplyApprovalBlocker({
        integration_apply_approval_id: approvalId,
        run_id: candidate.run_id,
        integration_candidate_id: candidate.integration_candidate_id,
        blocker_type,
        severity: "blocking",
        reason,
        refs
      }));
    };
    if (candidate.status !== "candidate_created") add("candidate_not_created", `Sandbox integration candidate status is ${candidate.status}.`, [candidate.integration_candidate_id]);
    if (candidate.strict_validation_status !== "passed") add("sandbox_validation_not_passed", `Strict sandbox validation status is ${candidate.strict_validation_status}.`, [candidate.sandbox_validation_id]);
    if (!candidate.patch_artifact_ref || !existsSync(candidate.patch_artifact_ref)) add("missing_patch_artifact", "Patch artifact ref is missing.", [candidate.patch_artifact_ref ?? candidate.proposal_id]);
    if (!candidate.changed_files.length) add("missing_changed_files", "Candidate changed files are not known.", [candidate.integration_candidate_id]);
    if (!this.verifyLockRequirements(candidate)) add("missing_locks", "Required locks are missing or not derivable.", candidate.changed_files);
    if (!this.verifyRollbackRequirements(candidate)) add("missing_rollback_plan", "Rollback requirements are missing.", [candidate.rollback_requirements_ref ?? candidate.rollback_requirements.rollback_requirement_id]);
    if (!this.verifyPostIntegrationValidationPlan(candidate)) add("missing_post_validation_plan", "Post-integration validation plan is missing.", [candidate.post_integration_validation_plan_ref ?? candidate.post_integration_validation_plan.validation_plan_id]);

    const sandboxApply = await this.loadJsonIfExists<PatchApplySandboxResult>(candidate.sandbox_apply_ref);
    if (sandboxApply) {
      if (sandboxApply.dry_apply_status !== "dry_apply_passed") add("dry_apply_not_passed", `Sandbox dry apply status is ${sandboxApply.dry_apply_status}.`, [sandboxApply.sandbox_result_id]);
      if (sandboxApply.main_repo_modified !== false) add("main_repo_integrity_not_ok", "Sandbox phase did not prove main repo integrity.", [sandboxApply.sandbox_result_id]);
    } else if (candidate.sandbox_apply_ref) {
      add("dry_apply_not_passed", "Sandbox dry apply artifact could not be loaded.", [candidate.sandbox_apply_ref]);
    }
    const review = await this.loadJsonIfExists<PatchProposalReview>(candidate.review_ref);
    if (review && review.decision !== "accept_for_validation_candidate") add("review_not_accepted", `Patch review decision is ${review.decision}.`, [review.review_id]);
    const proposal = await this.loadProposal(candidate.proposal_id);
    const scopeStatus = proposal?.scope_check_result?.status ?? stringMetadata(candidate.metadata_json.scope_check_status);
    if (scopeStatus && scopeStatus !== "passed") add("scope_check_not_passed", `Patch proposal scope check status is ${scopeStatus}.`, [candidate.proposal_id]);
    return { status: blockers.length ? "candidate_invalid" : "pending", blockers, warnings };
  }

  checkApprovalScope(candidate: SandboxValidatedIntegrationCandidate, approvalInput: IntegrationApplyScope, approvalId = `integration_apply_approval_${candidate.integration_candidate_id}`) {
    return validateIntegrationApplyApprovalScope(approvalId, candidate, approvalInput);
  }

  async checkWorktreeSafety(candidate: SandboxValidatedIntegrationCandidate): Promise<WorktreeSafetyCheck> {
    let stdout = "";
    let exitCode = 0;
    let commandError: string | undefined;
    try {
      const result = await execFileAsync("git", ["status", "--short"], { cwd: this.workspacePath, windowsHide: true, timeout: 10_000 });
      stdout = result.stdout;
    } catch (error) {
      exitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
      commandError = error instanceof Error ? error.message : String(error);
    }
    const dirtyFiles = parseGitStatusShort(stdout);
    const findings = this.checkDirtyFileOverlap(candidate, dirtyFiles);
    const status = commandError ? "unavailable"
      : findings.some((finding) => finding.known_dirty_sensitive_path && finding.overlap) ? "dirty_known_desktop_overlap"
        : findings.some((finding) => finding.overlap) ? "dirty_overlap"
          : dirtyFiles.length ? "dirty_unrelated"
            : "clean";
    const check = createWorktreeSafetyCheck({
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      status,
      dirty_files: dirtyFiles.map((entry) => entry.path),
      findings,
      command: "git status --short",
      command_exit_code: exitCode,
      command_error: commandError,
      metadata_json: { read_only: true, no_apply: true, no_stage: true, no_clean: true }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_worktree_checked",
      lifecycle_stage: "planning",
      severity: status === "clean" ? "info" : "warning",
      summary: `Integration apply worktree checked: ${status}.`,
      metadata_json: { worktree_check_id: check.worktree_check_id, dirty_file_count: dirtyFiles.length, status }
    });
    if (dirtyFiles.length) {
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "integration_apply_dirty_worktree_detected",
        lifecycle_stage: "planning",
        severity: "warning",
        summary: `Dirty worktree detected with ${dirtyFiles.length} dirty file(s).`,
        metadata_json: { worktree_check_id: check.worktree_check_id, dirty_files: dirtyFiles.map((entry) => entry.path) }
      });
    }
    if (status === "dirty_overlap" || status === "dirty_known_desktop_overlap") {
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "integration_apply_dirty_overlap_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Dirty worktree overlap blocks future apply approval.",
        metadata_json: { worktree_check_id: check.worktree_check_id, overlap_files: findings.filter((finding) => finding.overlap).map((finding) => finding.path) }
      });
    }
    return check;
  }

  checkDirtyFileOverlap(candidate: SandboxValidatedIntegrationCandidate, dirtyFiles: Array<{ path: string; status: string }>): DirtyWorktreeFinding[] {
    const changed = new Set(candidate.changed_files.map(normalizeRepoPath));
    return dirtyFiles.map((dirty) => {
      const normalized = normalizeRepoPath(dirty.path);
      const overlap = changed.has(normalized);
      const knownDirtySensitivePath = KNOWN_DIRTY_DESKTOP_FILES.includes(normalized);
      return createDirtyWorktreeFinding({
        path: normalized,
        git_status: dirty.status,
        overlap,
        known_dirty_sensitive_path: knownDirtySensitivePath,
        severity: overlap || knownDirtySensitivePath ? "blocking" : "warning",
        reason: overlap ? "Dirty file overlaps candidate changed file." : "Dirty file does not overlap candidate changed files."
      });
    });
  }

  verifyRollbackRequirements(candidate: SandboxValidatedIntegrationCandidate) {
    return Boolean(candidate.rollback_requirements_ref)
      && candidate.rollback_requirements.changed_files.length > 0
      && candidate.rollback_requirements.instructions.length > 0;
  }

  verifyPostIntegrationValidationPlan(candidate: SandboxValidatedIntegrationCandidate) {
    return Boolean(candidate.post_integration_validation_plan_ref)
      && candidate.post_integration_validation_plan.commands_run === false
      && (candidate.post_integration_validation_plan.required_commands.length > 0 || candidate.post_integration_validation_plan.optional_commands.length > 0);
  }

  verifyLockRequirements(candidate: SandboxValidatedIntegrationCandidate) {
    return candidate.required_file_locks.length > 0
      && (candidate.required_module_locks.length > 0 || candidate.required_semantic_locks.length > 0);
  }

  recommendApplyMode(candidate: SandboxValidatedIntegrationCandidate): ApplyModeRecommendation {
    const validation = this.quickCandidateStatus(candidate);
    return this.recommendApplyModeForStatus(validation);
  }

  async persistApplyApproval(approval: IntegrationApplyApproval, artifacts: {
    candidate: SandboxValidatedIntegrationCandidate;
    worktreeSafetyCheck: WorktreeSafetyCheck;
    approvalScopeCheck: unknown;
    applyModeRecommendation: unknown;
  }) {
    const refs = await this.artifactStore.saveIntegrationApplyApproval({
      approval,
      input: artifacts.candidate,
      worktreeSafetyCheck: artifacts.worktreeSafetyCheck,
      approvalScopeCheck: artifacts.approvalScopeCheck,
      applyModeRecommendation: artifacts.applyModeRecommendation
    });
    approval.artifact_ref = refs.approvalRef;
    approval.summary_ref = refs.summaryRef;
    await this.metadata.recordIntegrationApplyApprovalSaved(approval, artifacts.worktreeSafetyCheck);
    await this.traceWriter.write({
      run_id: approval.run_id,
      event_type: "integration_apply_approval_persisted",
      lifecycle_stage: "planning",
      summary: `Integration apply approval persisted with status ${approval.approval_status}.`,
      artifact_refs: [approval.artifact_ref, approval.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_apply_approval_id: approval.integration_apply_approval_id, no_apply: true }
    });
    return approval;
  }

  summarizeApplyApprovals(approvals: IntegrationApplyApproval[], runId = approvals[0]?.run_id ?? ""): IntegrationApplyApprovalSummary {
    return createIntegrationApplyApprovalSummary({
      run_id: runId,
      integration_apply_approval_used: approvals.length > 0,
      apply_approval_count: approvals.length,
      approved_for_apply_candidate_count: approvals.filter((approval) => approval.approval_status === "approved_for_apply_candidate").length,
      requires_human_approval_count: approvals.filter((approval) => approval.approval_status === "requires_human_approval").length,
      blocked_count: approvals.filter((approval) => ["blocked", "candidate_invalid", "missing_locks", "missing_rollback_plan", "missing_post_validation_plan"].includes(approval.approval_status)).length,
      rejected_count: approvals.filter((approval) => approval.approval_status === "rejected").length,
      dirty_worktree_blocked_count: approvals.filter((approval) => approval.approval_status === "dirty_worktree_blocked").length,
      apply_mode_recommendation_count: approvals.filter((approval) => Boolean(approval.apply_mode_recommendation)).length,
      metadata_json: { no_apply: true, no_validation_run: true, no_locks_acquired: true }
    });
  }

  private recommendApplyModeForStatus(status: IntegrationApplyApprovalStatus) {
    return recommendApplyModeForStatus(status);
  }

  private quickCandidateStatus(candidate: SandboxValidatedIntegrationCandidate): IntegrationApplyApprovalStatus {
    if (candidate.status !== "candidate_created" || candidate.strict_validation_status !== "passed") return "candidate_invalid";
    if (!this.verifyLockRequirements(candidate)) return "missing_locks";
    if (!this.verifyRollbackRequirements(candidate)) return "missing_rollback_plan";
    if (!this.verifyPostIntegrationValidationPlan(candidate)) return "missing_post_validation_plan";
    return "requires_human_approval";
  }

  private worktreeBlockers(approvalId: string, candidate: SandboxValidatedIntegrationCandidate, check: WorktreeSafetyCheck) {
    const blockers: IntegrationApplyApprovalBlocker[] = [];
    for (const finding of check.findings) {
      if (finding.overlap && (this.config.block_dirty_overlap ?? true)) {
        blockers.push(createIntegrationApplyApprovalBlocker({
          integration_apply_approval_id: approvalId,
          run_id: candidate.run_id,
          integration_candidate_id: candidate.integration_candidate_id,
          blocker_type: finding.known_dirty_sensitive_path ? "dirty_known_desktop_file" : "dirty_worktree_overlap",
          severity: "blocking",
          reason: `Dirty worktree file overlaps candidate scope: ${finding.path}.`,
          refs: [finding.path]
        }));
      }
    }
    if (this.config.require_clean_worktree_for_apply_approval && check.dirty_files.length) {
      blockers.push(createIntegrationApplyApprovalBlocker({
        integration_apply_approval_id: approvalId,
        run_id: candidate.run_id,
        integration_candidate_id: candidate.integration_candidate_id,
        blocker_type: "clean_worktree_required",
        severity: "blocking",
        reason: "Policy requires a clean worktree before apply approval.",
        refs: check.dirty_files
      }));
    }
    return blockers;
  }

  private worktreeWarnings(approvalId: string, candidate: SandboxValidatedIntegrationCandidate, check: WorktreeSafetyCheck) {
    const warnings: IntegrationApplyApprovalWarning[] = [];
    if (check.status === "dirty_unrelated") {
      warnings.push(createIntegrationApplyApprovalWarning({
        integration_apply_approval_id: approvalId,
        run_id: candidate.run_id,
        integration_candidate_id: candidate.integration_candidate_id,
        warning_type: "unrelated_dirty_worktree",
        severity: "warning",
        message: "Unrelated dirty worktree files were detected and recorded.",
        refs: check.dirty_files
      }));
    }
    if (check.status === "unavailable") {
      warnings.push(createIntegrationApplyApprovalWarning({
        integration_apply_approval_id: approvalId,
        run_id: candidate.run_id,
        integration_candidate_id: candidate.integration_candidate_id,
        warning_type: "worktree_status_unavailable",
        severity: "warning",
        message: "Worktree status could not be checked.",
        refs: [check.command_error ?? "git status unavailable"]
      }));
    }
    return warnings;
  }

  private async emitVerificationTraces(candidate: SandboxValidatedIntegrationCandidate, approvalId: string, blockers: IntegrationApplyApprovalBlocker[]) {
    const has = (type: IntegrationApplyApprovalBlocker["blocker_type"]) => blockers.some((blocker) => blocker.blocker_type === type);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_locks_verified",
      lifecycle_stage: "planning",
      severity: has("missing_locks") ? "warning" : "info",
      summary: has("missing_locks") ? "Integration apply lock requirements missing." : "Integration apply lock requirements verified.",
      metadata_json: { integration_apply_approval_id: approvalId, no_locks_acquired: true }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_rollback_verified",
      lifecycle_stage: "planning",
      severity: has("missing_rollback_plan") ? "warning" : "info",
      summary: has("missing_rollback_plan") ? "Integration apply rollback requirements missing." : "Integration apply rollback requirements verified.",
      metadata_json: { integration_apply_approval_id: approvalId }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_post_validation_verified",
      lifecycle_stage: "planning",
      severity: has("missing_post_validation_plan") ? "warning" : "info",
      summary: has("missing_post_validation_plan") ? "Integration apply post-validation plan missing." : "Integration apply post-validation plan verified.",
      metadata_json: { integration_apply_approval_id: approvalId, commands_run: false }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "integration_apply_approval_required",
      lifecycle_stage: "planning",
      summary: "Integration apply approval requirement recorded.",
      metadata_json: { integration_apply_approval_id: approvalId, approval_required: true }
    });
  }

  private async loadIntegrationCandidatesForRun(runId: string, candidateIds?: string[]) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return [];
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = candidateIds?.length
        ? store.all<{ artifact_ref?: string }>(
          `SELECT artifact_ref FROM factory_sandbox_integration_candidates WHERE run_id = ? AND integration_candidate_id IN (${candidateIds.map(() => "?").join(",")}) ORDER BY created_at`,
          runId,
          ...candidateIds
        )
        : store.all<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_sandbox_integration_candidates WHERE run_id = ? ORDER BY created_at", runId);
      const candidates: SandboxValidatedIntegrationCandidate[] = [];
      for (const row of rows) {
        if (row.artifact_ref && existsSync(row.artifact_ref)) candidates.push(await readJson<SandboxValidatedIntegrationCandidate>(row.artifact_ref));
      }
      return candidates;
    } finally {
      store.close();
    }
  }

  private async loadProposal(proposalId: string) {
    const row = await this.getMetadataRow<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_one_writer_dry_run_proposals WHERE proposal_id = ?", proposalId);
    return this.loadJsonIfExists<OneWriterDryRunProposal>(row?.artifact_ref);
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

  private async loadJsonIfExists<T>(ref?: string) {
    return ref && existsSync(ref) ? readJson<T>(ref) : undefined;
  }
}

function parseGitStatusShort(stdout: string) {
  return stdout.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      if (!rawPath) return [];
      if (rawPath.includes(" -> ")) {
        return rawPath.split(" -> ").map((entry) => ({ status, path: normalizeRepoPath(entry) }));
      }
      return [{ status, path: normalizeRepoPath(rawPath) }];
    });
}

function normalizeRepoPath(value: string) {
  return value.replace(/\\/g, "/").replace(/^"+|"+$/g, "").replace(/^\/+/, "");
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function defaultExpiresAt(ttlHours?: number) {
  const hours = ttlHours ?? 168;
  if (!Number.isFinite(hours) || hours <= 0) return undefined;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function approvalReason(status: IntegrationApplyApprovalStatus) {
  switch (status) {
    case "approved_for_apply_candidate": return "Candidate is approved as a future controlled apply candidate; no apply occurred.";
    case "requires_human_approval": return "Candidate is eligible but requires human approval before future apply.";
    case "dirty_worktree_blocked": return "Dirty worktree overlap blocks approval.";
    case "rejected": return "Approval scope or decision rejected the candidate.";
    default: return `Approval evaluation ended with status ${status}.`;
  }
}

function eventTypeForStatus(status: IntegrationApplyApprovalStatus) {
  if (status === "approved_for_apply_candidate") return "integration_apply_approval_granted";
  if (status === "rejected") return "integration_apply_approval_rejected";
  return ["blocked", "candidate_invalid", "dirty_worktree_blocked", "missing_locks", "missing_rollback_plan", "missing_post_validation_plan"].includes(status)
    ? "integration_apply_approval_blocked"
    : "integration_apply_approval_required";
}
