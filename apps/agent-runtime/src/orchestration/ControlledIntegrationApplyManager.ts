import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import type { CommandInventory } from "../memory/types.js";
import type { FactoryLockScope, LockAcquisitionResult } from "./FactoryLockModels.js";
import { DurableLockManager } from "./DurableLockManager.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { IntegrationApplyApproval } from "./IntegrationApplyApprovalModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { Task } from "./OrchestrationModels.js";
import type { PatchApplySandboxResult } from "./PatchApplySandboxModels.js";
import type { PatchProposalReview } from "./PatchProposalReviewModels.js";
import type { SandboxValidatedIntegrationCandidate } from "./SandboxIntegrationCandidateModels.js";
import { aggregateValidationStatus, normalizeValidationStatus, type OverallValidationStatus } from "./ValidationSemantics.js";
import { ValidationRunner } from "./ValidationRunner.js";
import { StructuredPatchControlledApplyAdapter } from "./ControlledApplyAdapter.js";
import { ControlledRollbackManager } from "./ControlledRollbackManager.js";
import {
  createControlledApplyBatch,
  createControlledApplyBlocker,
  createControlledApplySummary,
  createControlledApplyWarning,
  createControlledIntegrationApplyRequest,
  createControlledIntegrationApplyResult,
  type ControlledApplyAdapter,
  type ControlledApplyBatch,
  type ControlledApplyBlocker,
  type ControlledApplySummary,
  type ControlledIntegrationApplyResult,
  type ControlledIntegrationApplyStatus,
  type PreApplySnapshot,
  type RollbackResult
} from "./ControlledIntegrationApplyModels.js";

const execFileAsync = promisify(execFile);

export type ControlledIntegrationApplyManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  lockManager?: DurableLockManager;
  validationRunner?: Pick<ValidationRunner, "runForTask">;
  adapter?: ControlledApplyAdapter;
};

export type ControlledApplyBatchOptions = {
  integrationCandidateIds?: string[];
  commandInventory?: CommandInventory;
};

type Eligibility = {
  eligible: boolean;
  status: ControlledIntegrationApplyStatus;
  blockers: ControlledApplyBlocker[];
};

export class ControlledIntegrationApplyManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly config: OrchestrationSafetyConfig;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly lockManager: DurableLockManager;
  private readonly adapter: ControlledApplyAdapter;
  private readonly rollbackManager: ControlledRollbackManager;
  private readonly validationRunner?: Pick<ValidationRunner, "runForTask">;

  constructor(options: ControlledIntegrationApplyManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ControlledIntegrationApplyManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.lockManager = options.lockManager ?? new DurableLockManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      ttlMs: this.config.lock_ttl_ms,
      ownerComponent: "ControlledIntegrationApplyManager"
    });
    this.adapter = options.adapter ?? new StructuredPatchControlledApplyAdapter();
    this.rollbackManager = new ControlledRollbackManager(this.workspacePath);
    this.validationRunner = options.validationRunner;
  }

  async applyApprovedIntegrationCandidate(candidate: SandboxValidatedIntegrationCandidate, approval?: IntegrationApplyApproval, commandInventory?: CommandInventory): Promise<ControlledIntegrationApplyResult> {
    const controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}`;
    const request = createControlledIntegrationApplyRequest({
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      integration_apply_approval_id: approval?.integration_apply_approval_id,
      requested_by: "ControlledIntegrationApplyManager"
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_started",
      lifecycle_stage: "integrating",
      summary: `Controlled integration apply started for ${candidate.integration_candidate_id}.`,
      artifact_refs: [candidate.artifact_ref, approval?.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { controlled_apply_id: controlledApplyId }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_candidate_loaded",
      lifecycle_stage: "integrating",
      summary: `Controlled apply candidate loaded with status ${candidate.status}.`,
      metadata_json: { controlled_apply_id: controlledApplyId, candidate_status: candidate.status }
    });

    const loadedApproval = approval ?? await this.loadApprovalForCandidate(candidate.integration_candidate_id);
    const eligibility = await this.validateApplyEligibility(candidate, loadedApproval, controlledApplyId);
    if (!eligibility.eligible || !loadedApproval) {
      await this.traceWriter.write({
        run_id: candidate.run_id,
        event_type: "controlled_apply_eligibility_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: "Controlled apply eligibility blocked.",
        metadata_json: { controlled_apply_id: controlledApplyId, blocker_count: eligibility.blockers.length }
      });
      const result = this.baseResult(controlledApplyId, candidate, loadedApproval, eligibility.status, eligibility.blockers);
      result.completed_at = new Date().toISOString();
      await this.writeControlledApplyArtifacts(result, { request });
      return this.persistControlledApplyResult(result);
    }
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_eligibility_passed",
      lifecycle_stage: "integrating",
      summary: "Controlled apply eligibility passed.",
      metadata_json: { controlled_apply_id: controlledApplyId }
    });

    let result = this.baseResult(controlledApplyId, candidate, loadedApproval, "pending", []);
    let locks: LockAcquisitionResult | undefined;
    let snapshot: PreApplySnapshot | undefined;
    let rollbackResult: RollbackResult | undefined;
    try {
      locks = await this.acquireApplyLocks(candidate, controlledApplyId);
      result.acquired_lock_refs = locks.locks.filter((lock) => lock.status === "acquired").map((lock) => lock.lock_id);
      if (!locks.acquired) {
        result.status = "lock_failed";
        result.blockers.push(blockerFor(candidate, controlledApplyId, "lock_failed", "Required durable locks could not be acquired.", locks.artifact_refs));
        result.completed_at = new Date().toISOString();
        await this.writeControlledApplyArtifacts(result, { request });
        return this.persistControlledApplyResult(result);
      }

      snapshot = await this.createPreApplySnapshot(candidate, controlledApplyId);
      result.pre_apply_snapshot_ref = snapshot.artifact_ref;
      result.rollback_plan_ref = candidate.rollback_requirements_ref;
      const applyResult = await this.applyPatchThroughAdapter(candidate, loadedApproval, controlledApplyId);
      result.apply_adapter = applyResult.adapter_name;
      result.apply_status = applyResult.status;
      result.applied_files = applyResult.applied_files;
      result.failed_files = applyResult.failed_files;
      result.blockers.push(...applyResult.blockers);
      result.warnings.push(...applyResult.warnings);
      result.status = applyResult.status === "applied" ? "applied" : "apply_failed";
      if (applyResult.status !== "applied") {
        rollbackResult = await this.rollbackIfRequired(result, snapshot);
        result.rollback_result_ref = rollbackResult.artifact_ref;
        result.status = rollbackResult.status === "rolled_back" ? "rolled_back" : "rollback_failed";
        result.completed_at = new Date().toISOString();
        await this.writeControlledApplyArtifacts(result, { request, snapshot, applyResult, rollbackResult });
        return this.persistControlledApplyResult(result);
      }

      result.status = "post_validation_running";
      const postValidation = await this.runPostApplyValidation(candidate, commandInventory);
      result.post_validation_result_ref = postValidation.ref;
      result.strict_validation_status = postValidation.status;
      if (postValidation.status === "passed") {
        result.status = "post_validation_passed";
      } else {
        result.status = postValidation.status === "failed" ? "post_validation_failed" : "validation_blocked";
        result.blockers.push(blockerFor(candidate, controlledApplyId, "post_validation_failed", `Post-apply strict validation status is ${postValidation.status}.`, [postValidation.ref].filter((ref): ref is string => Boolean(ref))));
        rollbackResult = await this.rollbackIfRequired(result, snapshot);
        result.rollback_result_ref = rollbackResult.artifact_ref;
        if (rollbackResult.status === "rollback_failed") result.status = "rollback_failed";
      }
      result.completed_at = new Date().toISOString();
      await this.writeControlledApplyArtifacts(result, { request, snapshot, applyResult, postValidation, rollbackResult });
      return this.persistControlledApplyResult(result);
    } catch (error) {
      result.status = "apply_failed";
      result.blockers.push(blockerFor(candidate, controlledApplyId, "apply_failed", error instanceof Error ? error.message : String(error), []));
      if (snapshot) {
        rollbackResult = await this.rollbackIfRequired(result, snapshot);
        result.rollback_result_ref = rollbackResult.artifact_ref;
        if (rollbackResult.status === "rollback_failed") result.status = "rollback_failed";
      }
      result.completed_at = new Date().toISOString();
      await this.writeControlledApplyArtifacts(result, { request, snapshot, rollbackResult });
      return this.persistControlledApplyResult(result);
    } finally {
      if (locks?.locks.length) await this.releaseApplyLocks(result);
    }
  }

  async applyApprovedIntegrationBatch(runId: string, options: ControlledApplyBatchOptions = {}): Promise<ControlledApplyBatch> {
    if (!this.config.enable_controlled_integration_apply || this.config.controlled_apply_mode === "off") {
      const summary = this.summarizeControlledApplyBatch([], runId);
      const batch = createControlledApplyBatch({
        run_id: runId,
        integration_candidate_ids: [],
        results: [],
        summary,
        metadata_json: { disabled: true, no_apply: true }
      });
      await this.writeControlledApplyBatchArtifacts(batch);
      await this.metadata.recordControlledApplyBatchSaved(batch);
      return batch;
    }
    if (this.config.controlled_apply_mode === "report_only") {
      const summary = this.summarizeControlledApplyBatch([], runId);
      const batch = createControlledApplyBatch({
        run_id: runId,
        integration_candidate_ids: [],
        results: [],
        summary,
        metadata_json: { report_only: true, no_apply: true }
      });
      await this.writeControlledApplyBatchArtifacts(batch);
      await this.metadata.recordControlledApplyBatchSaved(batch);
      return batch;
    }
    const candidates = await this.loadCandidatesForRun(runId, options.integrationCandidateIds);
    const limit = this.config.max_controlled_applies_per_run ?? 4;
    const results: ControlledIntegrationApplyResult[] = [];
    for (const candidate of candidates.slice(0, limit)) {
      const approval = await this.loadApprovalForCandidate(candidate.integration_candidate_id);
      results.push(await this.applyApprovedIntegrationCandidate(candidate, approval, options.commandInventory));
    }
    const summary = this.summarizeControlledApplyBatch(results, runId);
    const batch = createControlledApplyBatch({
      run_id: runId,
      integration_candidate_ids: candidates.slice(0, limit).map((candidate) => candidate.integration_candidate_id),
      results,
      summary,
      metadata_json: { controlled_apply_mode: this.config.controlled_apply_mode }
    });
    await this.writeControlledApplyBatchArtifacts(batch);
    await this.metadata.recordControlledApplyBatchSaved(batch);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "controlled_apply_batch_completed",
      lifecycle_stage: "integrating",
      summary: `Controlled apply batch completed with ${results.length} result(s).`,
      artifact_refs: [batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: summary
    });
    return batch;
  }

  async validateApplyEligibility(candidate: SandboxValidatedIntegrationCandidate, approval: IntegrationApplyApproval | undefined, controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}`): Promise<Eligibility> {
    const blockers: ControlledApplyBlocker[] = [];
    const add = (type: ControlledApplyBlocker["blocker_type"], reason: string, refs: string[] = []) => blockers.push(blockerFor(candidate, controlledApplyId, type, reason, refs));
    if (!this.config.enable_controlled_integration_apply || this.config.controlled_apply_mode !== "apply_with_approval") add("controlled_apply_disabled", "Controlled integration apply is disabled or not in apply_with_approval mode.");
    if (candidate.status !== "candidate_created") add("candidate_not_created", `Integration candidate status is ${candidate.status}.`, [candidate.integration_candidate_id]);
    if (!approval) add("approval_missing", "Integration apply approval is missing.", [candidate.integration_candidate_id]);
    if (approval && approval.approval_status !== "approved_for_apply_candidate") add("approval_not_approved", `Approval status is ${approval.approval_status}.`, [approval.integration_apply_approval_id]);
    if (approval && approval.apply_mode_recommendation !== "controlled_apply_requires_approval") add("approval_scope_invalid", `Approval mode recommendation is ${approval.apply_mode_recommendation}.`, [approval.integration_apply_approval_id]);
    if (approval && this.config.require_human_approval_for_controlled_apply !== false && approval.approver_type !== "human" && approval.approver_type !== "test_fixture") add("missing_human_approval", "Controlled apply requires human or test fixture approval.", [approval.integration_apply_approval_id]);
    if (candidate.strict_validation_status !== "passed") add("sandbox_validation_not_passed", `Sandbox strict validation status is ${candidate.strict_validation_status}.`, [candidate.sandbox_validation_id]);
    if (!candidate.patch_artifact_ref || !existsSync(candidate.patch_artifact_ref)) add("missing_patch_artifact", "Patch artifact is missing.", [candidate.patch_artifact_ref ?? candidate.proposal_id]);
    if (!candidate.changed_files.length) add("missing_changed_files", "Candidate changed files are empty.", [candidate.integration_candidate_id]);
    if (!candidate.required_file_locks.length || (!candidate.required_module_locks.length && !candidate.required_semantic_locks.length)) add("missing_locks", "Required locks are not derivable.", candidate.changed_files);
    if (!candidate.rollback_requirements_ref || (this.config.require_automatic_rollback !== false && candidate.rollback_requirements.status !== "automatic_available")) add(candidate.rollback_requirements.status === "manual_limited" ? "manual_rollback_not_allowed" : "missing_rollback_plan", "Automatic rollback requirements are required for controlled apply.", [candidate.rollback_requirements_ref ?? "missing"]);
    if (!candidate.post_integration_validation_plan_ref || !candidate.post_integration_validation_plan.required_commands.length) add("missing_post_validation_plan", "Post-integration validation plan is missing required commands.", [candidate.post_integration_validation_plan_ref ?? "missing"]);
    if (approval && !sameSet(candidate.changed_files, approval.changed_files)) add("approval_scope_invalid", "Approval changed files do not match candidate changed files.", [approval.integration_apply_approval_id]);
    if (approval && (approval.approved_scope.integration_manager_required !== true || approval.approved_scope.durable_locks_required !== true || approval.approved_scope.strict_validation_required !== true || approval.approved_scope.provider_write_workers_allowed !== false)) add("approval_scope_invalid", "Approval scope weakens required integration controls.", [approval.integration_apply_approval_id]);

    const dryApply = await loadJsonIfExists<PatchApplySandboxResult>(candidate.sandbox_apply_ref);
    if (dryApply && dryApply.dry_apply_status !== "dry_apply_passed") add("dry_apply_not_passed", `Sandbox dry apply status is ${dryApply.dry_apply_status}.`, [dryApply.sandbox_result_id]);
    const review = await loadJsonIfExists<PatchProposalReview>(candidate.review_ref);
    if (review && review.decision !== "accept_for_validation_candidate") add("review_not_accepted", `Patch review decision is ${review.decision}.`, [review.review_id]);
    const scopeStatus = typeof candidate.metadata_json.scope_check_status === "string" ? candidate.metadata_json.scope_check_status : undefined;
    if (scopeStatus && scopeStatus !== "passed") add("scope_check_not_passed", `Scope check status is ${scopeStatus}.`, [candidate.proposal_id]);
    const worktree = await this.checkWorktreeSafety(candidate);
    if (worktree.status === "unavailable") add("worktree_check_unavailable", "Worktree safety check could not run.", [worktree.error ?? "git status"]);
    if (worktree.overlap.length) add("dirty_worktree_overlap", "Dirty worktree files overlap candidate changed files.", worktree.overlap);
    if ((this.config.require_clean_candidate_paths ?? true) && worktree.overlap.length) add("dirty_worktree_overlap", "Policy requires clean candidate paths.", worktree.overlap);
    return {
      eligible: blockers.length === 0,
      status: blockers.some((blocker) => blocker.blocker_type === "dirty_worktree_overlap") ? "dirty_worktree_blocked" : blockers.length ? "blocked" : "pending",
      blockers
    };
  }

  async acquireApplyLocks(candidate: SandboxValidatedIntegrationCandidate, controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}`) {
    const scopes: FactoryLockScope[] = [
      ...candidate.required_file_locks.map((file) => this.lockManager.normalizeLockScope(file, "write")),
      ...candidate.required_module_locks.map((lock) => lockScope("module", lock)),
      ...candidate.required_semantic_locks.map((lock) => lockScope("semantic", lock))
    ];
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_locks_requested",
      lifecycle_stage: "integrating",
      summary: `Requesting ${scopes.length} controlled apply lock(s).`,
      metadata_json: { controlled_apply_id: controlledApplyId, scopes: scopes.map((scope) => scope.normalized_scope_key) }
    });
    const result = await this.lockManager.acquireLocks({
      request_id: `controlled_apply_lock_request_${randomUUID()}`,
      run_id: candidate.run_id,
      owner_component: "ControlledIntegrationApplyManager",
      scopes,
      ttl_ms: this.config.lock_ttl_ms,
      reason: "Acquire durable locks before controlled integration apply.",
      metadata_json: { controlled_apply_id: controlledApplyId, integration_candidate_id: candidate.integration_candidate_id }
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: result.acquired ? "controlled_apply_locks_acquired" : "controlled_apply_locks_failed",
      lifecycle_stage: result.acquired ? "integrating" : "blocked",
      severity: result.acquired ? "info" : "warning",
      summary: result.acquired ? `Acquired ${result.locks.length} controlled apply lock(s).` : "Controlled apply lock acquisition failed.",
      artifact_refs: result.artifact_refs,
      metadata_json: { controlled_apply_id: controlledApplyId, lock_ids: result.locks.map((lock) => lock.lock_id) }
    });
    return result;
  }

  async createPreApplySnapshot(candidate: SandboxValidatedIntegrationCandidate, controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}`) {
    const dir = await this.controlledApplyDir(candidate.run_id, controlledApplyId);
    const snapshot = await this.rollbackManager.createSnapshot({
      controlled_apply_id: controlledApplyId,
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      changed_files: candidate.changed_files,
      snapshotDir: path.join(dir, "pre_apply_snapshot")
    });
    snapshot.artifact_ref = path.join(dir, "pre_apply_snapshot.json");
    await writeJson(snapshot.artifact_ref, snapshot);
    await this.metadata.recordPreApplySnapshotSaved(snapshot);
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_pre_snapshot_created",
      lifecycle_stage: "integrating",
      summary: "Controlled apply pre-apply snapshot created.",
      artifact_refs: [snapshot.artifact_ref],
      metadata_json: { controlled_apply_id: controlledApplyId, file_count: snapshot.files.length }
    });
    return snapshot;
  }

  async applyPatchThroughAdapter(candidate: SandboxValidatedIntegrationCandidate, approval: IntegrationApplyApproval, controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}`) {
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_patch_started",
      lifecycle_stage: "integrating",
      summary: "Controlled patch apply adapter started.",
      metadata_json: { controlled_apply_id: controlledApplyId, adapter: this.adapter.adapter_name }
    });
    const result = await this.adapter.apply({
      controlled_apply_id: controlledApplyId,
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      workspacePath: this.workspacePath,
      patch_artifact_ref: candidate.patch_artifact_ref ?? "",
      changed_files: candidate.changed_files,
      allowed_files: approval.allowed_files,
      forbidden_files: approval.forbidden_files,
      allow_delete: approval.approved_scope.metadata_json.delete_approved === true,
      allow_rename: approval.approved_scope.metadata_json.rename_approved === true
    });
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: result.status === "applied" ? "controlled_apply_patch_completed" : "controlled_apply_patch_failed",
      lifecycle_stage: result.status === "applied" ? "integrating" : "blocked",
      severity: result.status === "applied" ? "info" : "warning",
      summary: `Controlled patch adapter ${result.status}.`,
      metadata_json: { controlled_apply_id: controlledApplyId, applied_files: result.applied_files, failed_files: result.failed_files }
    });
    return result;
  }

  async runPostApplyValidation(candidate: SandboxValidatedIntegrationCandidate, commandInventory?: CommandInventory) {
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: "controlled_apply_post_validation_started",
      lifecycle_stage: "validating",
      summary: "Controlled apply post-validation started.",
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id }
    });
    const commands = candidate.post_integration_validation_plan.required_commands;
    if (!commands.length) return { status: "not_run" as OverallValidationStatus, ref: undefined };
    const runner = this.validationRunner ?? new ValidationRunner(this.workspacePath, this.artifactStore, {
      validation_timeout: this.config.controlled_apply_validation_timeout_ms ?? this.config.validation_timeout,
      max_validation_log_size: this.config.max_validation_log_size,
      safe_commands_allowlist: this.config.safe_commands_allowlist
    });
    const task = validationTaskFor(candidate, commands);
    const verification = await runner.runForTask({ runId: candidate.run_id, task, commandInventory: commandInventory ?? commandInventoryFor(commands) });
    const status = normalizeValidationStatus(verification.validation_status ?? "not_run");
    const ref = verification.logs_refs?.[verification.logs_refs.length - 1];
    await this.traceWriter.write({
      run_id: candidate.run_id,
      event_type: status === "passed" ? "controlled_apply_post_validation_completed" : "controlled_apply_post_validation_failed",
      lifecycle_stage: status === "passed" ? "validating" : "blocked",
      severity: status === "passed" ? "info" : "warning",
      summary: `Controlled apply post-validation ${status}.`,
      artifact_refs: verification.logs_refs ?? [],
      metadata_json: { integration_candidate_id: candidate.integration_candidate_id, status }
    });
    return { status, ref, verification };
  }

  async rollbackIfRequired(result: ControlledIntegrationApplyResult, snapshot: PreApplySnapshot): Promise<RollbackResult> {
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "controlled_apply_rollback_started",
      lifecycle_stage: "integrating",
      severity: "warning",
      summary: "Controlled apply rollback started.",
      artifact_refs: [snapshot.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { controlled_apply_id: result.controlled_apply_id }
    });
    const rollback = await this.rollbackManager.rollback({
      controlled_apply_id: result.controlled_apply_id,
      run_id: result.run_id,
      integration_candidate_id: result.integration_candidate_id,
      snapshot
    });
    const dir = await this.controlledApplyDir(result.run_id, result.controlled_apply_id);
    rollback.artifact_ref = path.join(dir, "rollback_result.json");
    await writeJson(rollback.artifact_ref, rollback);
    await this.metadata.recordControlledRollbackResultSaved(rollback);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: rollback.status === "rolled_back" ? "controlled_apply_rollback_completed" : "controlled_apply_rollback_failed",
      lifecycle_stage: rollback.status === "rolled_back" ? "integrating" : "blocked",
      severity: rollback.status === "rolled_back" ? "warning" : "critical",
      summary: `Controlled apply rollback ${rollback.status}.`,
      artifact_refs: [rollback.artifact_ref],
      metadata_json: { controlled_apply_id: result.controlled_apply_id, failed_files: rollback.failed_files }
    });
    return rollback;
  }

  async releaseApplyLocks(result: ControlledIntegrationApplyResult) {
    const release = await this.lockManager.releaseLocks({
      runId: result.run_id,
      lockIds: result.acquired_lock_refs,
      reason: "Release controlled apply locks after apply attempt."
    });
    result.warnings.push(createControlledApplyWarning({
      controlled_apply_id: result.controlled_apply_id,
      run_id: result.run_id,
      integration_candidate_id: result.integration_candidate_id,
      warning_type: "locks_released",
      severity: "info",
      message: `Released ${release.released.length} controlled apply lock(s).`,
      refs: release.released.map((lock) => lock.lock_id)
    }));
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "controlled_apply_locks_released",
      lifecycle_stage: "integrating",
      summary: `Released ${release.released.length} controlled apply lock(s).`,
      artifact_refs: release.artifact_refs,
      metadata_json: { controlled_apply_id: result.controlled_apply_id, lock_ids: release.released.map((lock) => lock.lock_id) }
    });
  }

  async persistControlledApplyResult(result: ControlledIntegrationApplyResult) {
    await this.metadata.recordControlledApplyResultSaved(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "controlled_apply_result_persisted",
      lifecycle_stage: result.status === "post_validation_passed" ? "integrating" : "blocked",
      severity: result.status === "post_validation_passed" ? "info" : "warning",
      summary: `Controlled apply result persisted: ${result.status}.`,
      artifact_refs: [result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { controlled_apply_id: result.controlled_apply_id, status: result.status }
    });
    return result;
  }

  summarizeControlledApplyBatch(results: ControlledIntegrationApplyResult[], runId = results[0]?.run_id ?? ""): ControlledApplySummary {
    return createControlledApplySummary({
      run_id: runId,
      controlled_apply_used: results.length > 0,
      controlled_apply_count: results.length,
      applied_count: results.filter((result) => ["applied", "post_validation_passed", "post_validation_failed", "validation_blocked"].includes(result.status)).length,
      post_validation_passed_count: results.filter((result) => result.status === "post_validation_passed").length,
      post_validation_failed_count: results.filter((result) => result.status === "post_validation_failed").length,
      rolled_back_count: results.filter((result) => result.status === "rolled_back" || result.rollback_result_ref).length,
      rollback_failed_count: results.filter((result) => result.status === "rollback_failed").length,
      lock_failed_count: results.filter((result) => result.status === "lock_failed").length,
      blocked_count: results.filter((result) => ["blocked", "rejected", "dirty_worktree_blocked", "validation_blocked", "apply_failed"].includes(result.status)).length
    });
  }

  private baseResult(controlledApplyId: string, candidate: SandboxValidatedIntegrationCandidate, approval: IntegrationApplyApproval | undefined, status: ControlledIntegrationApplyStatus, blockers: ControlledApplyBlocker[]): ControlledIntegrationApplyResult {
    return createControlledIntegrationApplyResult({
      controlled_apply_id: controlledApplyId,
      run_id: candidate.run_id,
      integration_candidate_id: candidate.integration_candidate_id,
      integration_apply_approval_id: approval?.integration_apply_approval_id ?? "missing_approval",
      proposal_id: candidate.proposal_id,
      patch_artifact_ref: candidate.patch_artifact_ref,
      approval_ref: approval?.artifact_ref,
      changed_files: candidate.changed_files,
      acquired_lock_refs: [],
      apply_adapter: this.adapter.adapter_name,
      apply_status: "not_run",
      applied_files: [],
      failed_files: [],
      strict_validation_status: candidate.strict_validation_status,
      rollback_plan_ref: candidate.rollback_requirements_ref,
      worktree_safety_ref: approval?.metadata_json.worktree_check_id as string | undefined,
      status,
      blockers,
      warnings: [],
      metadata_json: {
        no_provider_writer: true,
        no_patch_generation: true,
        deterministic_controlled_apply: true
      }
    });
  }

  private async checkWorktreeSafety(candidate: SandboxValidatedIntegrationCandidate) {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--short"], { cwd: this.workspacePath, windowsHide: true, timeout: 10_000 });
      const dirty = parseGitStatusShort(stdout);
      const changed = new Set(candidate.changed_files.map(normalizeRelativePath));
      const overlap = dirty.filter((entry) => changed.has(normalizeRelativePath(entry.path))).map((entry) => normalizeRelativePath(entry.path));
      return { status: overlap.length ? "dirty_overlap" : dirty.length ? "dirty_unrelated" : "clean", dirty, overlap };
    } catch (error) {
      if (!existsSync(path.join(this.workspacePath, ".git"))) return { status: "clean", dirty: [], overlap: [] };
      return { status: "unavailable", dirty: [], overlap: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async writeControlledApplyArtifacts(result: ControlledIntegrationApplyResult, extras: Record<string, unknown>) {
    const dir = await this.controlledApplyDir(result.run_id, result.controlled_apply_id);
    await writeJson(path.join(dir, "apply_request.json"), extras.request ?? {});
    if (extras.snapshot) await writeJson(path.join(dir, "pre_apply_snapshot.json"), extras.snapshot);
    if (extras.applyResult) await writeJson(path.join(dir, "apply_result.json"), extras.applyResult);
    if (extras.postValidation) await writeJson(path.join(dir, "post_validation_result.json"), extras.postValidation);
    if (extras.rollbackResult) await writeJson(path.join(dir, "rollback_result.json"), extras.rollbackResult);
    const resultRef = path.join(dir, "controlled_apply_result.json");
    const summaryRef = path.join(dir, "controlled_apply_summary.md");
    result.artifact_ref = resultRef;
    await writeJson(resultRef, result);
    await writeFile(summaryRef, controlledApplySummaryMarkdown(result), "utf8");
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "controlled_apply_summary_created",
      lifecycle_stage: "integrating",
      summary: "Controlled apply summary created.",
      artifact_refs: [summaryRef],
      metadata_json: { controlled_apply_id: result.controlled_apply_id }
    });
  }

  private async writeControlledApplyBatchArtifacts(batch: ControlledApplyBatch) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const dir = path.join(memory.runsDir, batch.run_id, "controlled_integration_apply");
    await mkdir(dir, { recursive: true });
    batch.artifact_ref = path.join(dir, `controlled_apply_batch_${batch.batch_id}.json`);
    batch.summary_ref = path.join(dir, `controlled_apply_batch_summary_${batch.batch_id}.md`);
    batch.summary.controlled_apply_summary_ref = batch.summary_ref;
    await writeJson(batch.artifact_ref, batch);
    await writeFile(batch.summary_ref, controlledApplyBatchSummaryMarkdown(batch.summary), "utf8");
  }

  private async controlledApplyDir(runId: string, controlledApplyId: string) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const dir = path.join(memory.runsDir, runId, "controlled_integration_apply", controlledApplyId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async loadApprovalForCandidate(candidateId: string) {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ databasePath, workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_integration_apply_approvals WHERE integration_candidate_id = ? AND approval_status = 'approved_for_apply_candidate' ORDER BY created_at DESC", candidateId);
      return row?.artifact_ref && existsSync(row.artifact_ref) ? readJson<IntegrationApplyApproval>(row.artifact_ref) : undefined;
    } finally {
      store.close();
    }
  }

  private async loadCandidatesForRun(runId: string, candidateIds?: string[]) {
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
}

function blockerFor(candidate: SandboxValidatedIntegrationCandidate, controlledApplyId: string, blockerType: ControlledApplyBlocker["blocker_type"], reason: string, refs: string[]) {
  return createControlledApplyBlocker({
    controlled_apply_id: controlledApplyId,
    run_id: candidate.run_id,
    integration_candidate_id: candidate.integration_candidate_id,
    blocker_type: blockerType,
    severity: blockerType === "rollback_failed" || blockerType === "path_traversal" ? "critical" : "blocking",
    reason,
    refs
  });
}

function lockScope(type: "module" | "semantic", key: string): FactoryLockScope {
  return {
    type,
    mode: "write",
    scope: key,
    normalized_scope_key: key,
    confidence: "high",
    reason: `Controlled apply requires ${type} lock ${key}.`
  };
}

function validationTaskFor(candidate: SandboxValidatedIntegrationCandidate, commands: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: `controlled_apply_validation_${candidate.integration_candidate_id}`,
    run_id: candidate.run_id,
    title: "Controlled apply post-validation",
    objective: "Run post-integration validation for controlled apply.",
    role_required: "TesterAgent",
    status: "running",
    dependencies: [],
    relevant_files: candidate.changed_files,
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "VerificationResult",
    validation_commands: commands,
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function commandInventoryFor(commands: string[]): CommandInventory {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: now,
    packageManagers: [],
    commands: commands.map((command, index) => ({
      id: `controlled_apply_command_${index}`,
      kind: "test",
      command,
      cwd: ".",
      sourceFile: "controlled_integration_apply",
      source: "ci",
      confidence: "high"
    })),
    byKind: {
      test: commands,
      lint: [],
      typecheck: [],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}

async function loadJsonIfExists<T>(ref?: string) {
  return ref && existsSync(ref) ? readJson<T>(ref) : undefined;
}

function parseGitStatusShort(stdout: string) {
  return stdout.split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      if (!rawPath) return [];
      if (rawPath.includes(" -> ")) return rawPath.split(" -> ").map((entry) => ({ status, path: normalizeRelativePath(entry) }));
      return [{ status, path: normalizeRelativePath(rawPath) }];
    });
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^"+|"+$/g, "").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function sameSet(left: string[], right: string[]) {
  const a = [...new Set(left.map(normalizeRelativePath))].sort();
  const b = [...new Set(right.map(normalizeRelativePath))].sort();
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function controlledApplySummaryMarkdown(result: ControlledIntegrationApplyResult) {
  return [
    `# Controlled Integration Apply ${result.controlled_apply_id}`,
    "",
    `- status: ${result.status}`,
    `- candidate: ${result.integration_candidate_id}`,
    `- approval: ${result.integration_apply_approval_id}`,
    `- adapter: ${result.apply_adapter}`,
    `- apply_status: ${result.apply_status}`,
    `- strict_validation_status: ${result.strict_validation_status}`,
    `- changed_files: ${result.changed_files.join(", ") || "none"}`,
    `- applied_files: ${result.applied_files.join(", ") || "none"}`,
    `- failed_files: ${result.failed_files.join(", ") || "none"}`,
    `- locks: ${result.acquired_lock_refs.join(", ") || "none"}`,
    `- snapshot: ${result.pre_apply_snapshot_ref ?? "n/a"}`,
    `- rollback: ${result.rollback_result_ref ?? "n/a"}`,
    `- blockers: ${result.blockers.length}`,
    "",
    "This layer only applies approved sandbox-validated integration candidates through the controlled adapter. It does not call provider writers or generate patches."
  ].join("\n");
}

function controlledApplyBatchSummaryMarkdown(summary: ControlledApplySummary) {
  return [
    `# Controlled Integration Apply Summary ${summary.summary_id}`,
    "",
    `- controlled_apply_used: ${summary.controlled_apply_used}`,
    `- controlled_apply_count: ${summary.controlled_apply_count}`,
    `- applied_count: ${summary.applied_count}`,
    `- post_validation_passed_count: ${summary.post_validation_passed_count}`,
    `- post_validation_failed_count: ${summary.post_validation_failed_count}`,
    `- rolled_back_count: ${summary.rolled_back_count}`,
    `- rollback_failed_count: ${summary.rollback_failed_count}`,
    `- lock_failed_count: ${summary.lock_failed_count}`,
    `- blocked_count: ${summary.blocked_count}`,
    `- controlled_apply_summary_ref: ${summary.controlled_apply_summary_ref ?? "n/a"}`
  ].join("\n");
}
