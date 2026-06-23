import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { readJson } from "../memory/ProjectMemory.js";
import type { CommandInventory } from "../memory/types.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { DurableLockManager } from "./DurableLockManager.js";
import type { FactoryLockScope, LockAcquisitionResult } from "./FactoryLockModels.js";
import { moduleLocksForTask, semanticLocksForTask } from "./FactoryLockModels.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { ParsedAgentOutput, Run, Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import {
  createExecutionIntegrationPreview,
  type ExecutionIntegrationPreview
} from "./ExecutionPreparationModels.js";
import { ValidationRunner } from "./ValidationRunner.js";
import { aggregateValidationStatus, normalizeValidationStatus, type OverallValidationStatus } from "./ValidationSemantics.js";
import type { VerificationResult } from "./StructuredOutputs.js";
import { GoalSteward } from "./GoalSteward.js";
import type { GoalStewardFinding, GoalStewardReview } from "./GoalStewardModels.js";
import {
  createIntegrationCandidate,
  createIntegrationPlan,
  createIntegrationResult,
  integrationStatusFromValidation,
  type IntegrationApplyMode,
  type IntegrationBatch,
  type IntegrationCandidate,
  type IntegrationConflict,
  type IntegrationPlan,
  type IntegrationResult,
  type IntegrationRollbackPlan,
  type IntegrationStatus
} from "./IntegrationModels.js";
import type { ControlledIntegrationApplyResult } from "./ControlledIntegrationApplyModels.js";

export type IntegrationApplyAdapterResult = {
  status: "applied" | "failed" | "blocked";
  changed_files?: string[];
  artifact_refs?: string[];
  message?: string;
  validation_status?: OverallValidationStatus;
  validation_refs?: string[];
};

export type IntegrationApplyAdapter = {
  prepare?: (plan: IntegrationPlan) => Promise<IntegrationApplyAdapterResult>;
  apply?: (batch: IntegrationBatch, plan: IntegrationPlan) => Promise<IntegrationApplyAdapterResult>;
};

export type IntegrationManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  lockManager?: DurableLockManager;
  validationRunner?: Pick<ValidationRunner, "runForTask">;
  adapter?: IntegrationApplyAdapter;
  applyMode?: IntegrationApplyMode;
  providerFactory?: (role: string) => LlmProvider | undefined;
  config: Pick<OrchestrationSafetyConfig, "lock_ttl_ms" | "validation_timeout" | "max_validation_log_size" | "safe_commands_allowlist"> &
    Partial<Pick<OrchestrationSafetyConfig, "enable_goal_steward" | "goal_steward_mode" | "require_active_project_goal_spec">>;
};

export type IntegrationRunMode = "normal" | "plan_only" | "read_only";

export class IntegrationManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly lockManager: DurableLockManager;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly validationRunner?: Pick<ValidationRunner, "runForTask">;
  private readonly adapter?: IntegrationApplyAdapter;
  private readonly applyMode: IntegrationApplyMode;
  private readonly providerFactory?: (role: string) => LlmProvider | undefined;
  private readonly config: IntegrationManagerOptions["config"];

  constructor(options: IntegrationManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.config = options.config;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "IntegrationManager" });
    this.lockManager = options.lockManager ?? new DurableLockManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      ttlMs: this.config.lock_ttl_ms,
      ownerComponent: "IntegrationManager"
    });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.validationRunner = options.validationRunner;
    this.adapter = options.adapter;
    this.applyMode = options.applyMode ?? "prepare_only";
    this.providerFactory = options.providerFactory;
  }

  async integrate(input: {
    run: Run;
    tasks: Task[];
    parsedOutputs: ParsedAgentOutput[];
    mode?: IntegrationRunMode;
    commandInventory?: CommandInventory;
  }): Promise<IntegrationResult> {
    const started = await this.traceWriter.write({
      run_id: input.run.id,
      event_type: "integration_started",
      lifecycle_stage: "integrating",
      summary: "Integration manager started.",
      metadata_json: { mode: input.mode ?? "normal", apply_mode: this.applyMode }
    });
    const candidates = await this.discoverCandidates(input.run, input.tasks, input.parsedOutputs, input.mode ?? "normal");
    const candidateRef = await this.artifactStore.saveIntegrationArtifact(input.run.id, `integration_candidates_${started.trace_event_id}`, {
      run_id: input.run.id,
      candidates
    });
    await Promise.all(candidates.map((candidate) => this.metadata.recordIntegrationCandidateSaved({ candidate, artifactRef: candidateRef })));
    if (!candidates.length) {
      return this.finishNotRequired(input.run, started.trace_event_id, candidateRef, input.mode ?? "normal");
    }

    const ordered = this.orderCandidates(input.tasks, candidates);
    const goalReview = await this.reviewGoalAlignment(input.run, input.tasks, ordered);
    const goalReviewRefs = [goalReview?.artifact_ref, goalReview?.summary_ref, goalReview?.spec_ref].filter((ref): ref is string => Boolean(ref));
    const conflicts = [
      ...this.detectConflicts(input.run.id, ordered),
      ...this.goalConflicts(input.run.id, goalReview, ordered)
    ];
    const conflictRef = await this.artifactStore.saveIntegrationArtifact(input.run.id, `integration_conflicts_${started.trace_event_id}`, {
      run_id: input.run.id,
      goal_steward_review_ref: goalReview?.artifact_ref,
      goal_alignment_status: goalReview?.status,
      project_goal_spec_ref: goalReview?.spec_ref,
      conflicts
    });
    await Promise.all(conflicts.map((conflict) => this.metadata.recordIntegrationConflictSaved({ conflict, artifactRef: conflictRef })));
    for (const conflict of conflicts) {
      await this.traceWriter.write({
        run_id: input.run.id,
        event_type: "integration_conflict_detected",
        lifecycle_stage: "integrating",
        severity: conflict.severity === "blocking" ? "warning" : "info",
        summary: conflict.reason,
        artifact_refs: [conflictRef],
        metadata_json: {
          conflict_id: conflict.conflict_id,
          candidate_ids: conflict.candidate_ids,
          conflict_type: conflict.conflict_type,
          changed_files: conflict.changed_files
        }
      });
    }

    const rollbackPlan = this.createRollbackPlan(input.run.id, ordered);
    const rollbackRef = await this.artifactStore.saveIntegrationArtifact(input.run.id, `rollback_plan_${started.trace_event_id}`, rollbackPlan);
    rollbackPlan.artifact_ref = rollbackRef;
    await this.traceWriter.write({
      run_id: input.run.id,
      event_type: "integration_rollback_planned",
      lifecycle_stage: "integrating",
      summary: "Manual rollback plan recorded before integration.",
      artifact_refs: [rollbackRef],
      metadata_json: { rollback_plan_id: rollbackPlan.rollback_plan_id, status: rollbackPlan.status }
    });

    const plan = createIntegrationPlan({
      integration_plan_id: `integration_plan_${started.trace_event_id}`,
      run_id: input.run.id,
      candidates: ordered,
      dependency_order: ordered.map((candidate) => candidate.candidate_id),
      conflict_checks: conflicts,
      required_locks: uniqueStrings(ordered.flatMap((candidate) => candidate.changed_files)),
      validation_plan: {
        status: "planned",
        commands: uniqueStrings(input.tasks.flatMap((task) => ordered.some((candidate) => candidate.task_id === task.id) ? task.validation_commands : [])),
        impacted_files: uniqueStrings(ordered.flatMap((candidate) => candidate.changed_files)),
        validation_refs: uniqueStrings(ordered.flatMap((candidate) => candidate.validation_ref ? [candidate.validation_ref] : [])),
        metadata_json: { strict_validation_required: true }
      },
      rollback_plan: rollbackPlan,
      batches: [this.createBatch(input.run.id, ordered)],
      artifact_ref: undefined,
      warnings: this.orderWarnings(input.tasks, ordered)
        .concat(this.goalWarnings(goalReview))
    });
    const planRef = await this.artifactStore.saveIntegrationArtifact(input.run.id, `integration_plan_${started.trace_event_id}`, plan);
    plan.artifact_ref = planRef;
    await this.metadata.recordIntegrationPlanSaved({ plan, artifactRef: planRef });
    await this.traceWriter.write({
      run_id: input.run.id,
      event_type: "integration_plan_created",
      lifecycle_stage: "integrating",
      summary: `Integration plan created for ${ordered.length} candidate(s).`,
      artifact_refs: [planRef],
      metadata_json: {
        integration_plan_id: plan.integration_plan_id,
        candidate_count: ordered.length,
        conflicts_count: conflicts.length,
        warnings: plan.warnings,
        goal_steward_review_ref: goalReview?.artifact_ref,
        goal_alignment_status: goalReview?.status,
        project_goal_spec_ref: goalReview?.spec_ref
      }
    });

    const blockingConflicts = conflicts.filter((conflict) => conflict.severity === "blocking");
    if (blockingConflicts.length) {
      return this.finishBlocked(input.run, plan, blockingConflicts, "Integration blocked by candidate conflict checks.", [candidateRef, conflictRef, rollbackRef, planRef, ...goalReviewRefs], started.trace_event_id, goalReview);
    }

    const lockResult = await this.acquireRequiredLocks(input.run.id, plan);
    if (!lockResult.acquired) {
      const lockConflict = this.conflict(input.run.id, ordered.map((candidate) => candidate.candidate_id), "lock_rejected", [], lockResult.artifact_refs, "Required durable integration locks could not be acquired.", "blocking");
      const result = await this.finishBlocked(input.run, plan, [lockConflict], "Required durable integration locks could not be acquired.", [candidateRef, conflictRef, rollbackRef, planRef, ...goalReviewRefs, ...lockResult.artifact_refs], started.trace_event_id, goalReview);
      return result;
    }

    try {
      const applyResult = await this.applyOrPrepare(plan);
      if (applyResult.status !== "applied") {
        const applyConflict = this.conflict(input.run.id, ordered.map((candidate) => candidate.candidate_id), "apply_failed", uniqueStrings(ordered.flatMap((candidate) => candidate.changed_files)), applyResult.artifact_refs ?? [], applyResult.message ?? "Integration could not safely apply in this runtime.", "blocking");
        return this.finishBlocked(input.run, plan, [applyConflict], applyResult.message ?? "Integration could not safely apply in this runtime.", [candidateRef, conflictRef, rollbackRef, planRef, ...goalReviewRefs, ...(applyResult.artifact_refs ?? [])], started.trace_event_id, goalReview);
      }

      const validation = await this.validateAfterApply(input.run, input.tasks, ordered, input.commandInventory, applyResult);
      const validationRef = await this.artifactStore.saveIntegrationArtifact(input.run.id, `integration_validation_${started.trace_event_id}`, validation);
      const validationStatus = normalizeValidationStatus(validation.validation_status ?? "not_run");
      const finalStatus = integrationStatusFromValidation(validationStatus);
      await this.traceWriter.write({
        run_id: input.run.id,
        event_type: validationStatus === "passed" ? "integration_validation_completed" : "integration_validation_failed",
        lifecycle_stage: "validating",
        severity: validationStatus === "passed" ? "info" : "warning",
        summary: `Post-integration validation status: ${validationStatus}.`,
        artifact_refs: [validationRef, ...(validation.validation_refs ?? [])],
        metadata_json: {
          integration_plan_id: plan.integration_plan_id,
          validation_status: validationStatus,
          validation_refs: validation.validation_refs
        }
      });
      const result = createIntegrationResult({
        run_id: input.run.id,
        status: finalStatus,
        applied_candidates: finalStatus === "passed" ? ordered.map((candidate) => candidate.candidate_id) : [],
        rejected_candidates: [],
        blocked_candidates: finalStatus === "passed" ? [] : ordered.map((candidate) => candidate.candidate_id),
        conflicts: [],
        validation_status: validationStatus,
        validation_refs: uniqueStrings([validationRef, ...(validation.validation_refs ?? [])]),
        rollback_refs: [rollbackRef],
        changed_files: uniqueStrings([...(applyResult.changed_files ?? []), ...ordered.flatMap((candidate) => candidate.changed_files)]),
        apply_mode: this.applyMode,
        rollback_available: rollbackPlan.status === "automatic_available",
        blocked_reason: finalStatus === "passed" ? undefined : `Post-integration validation status is ${validationStatus}.`,
        metadata_json: {
          integration_plan_id: plan.integration_plan_id,
          apply_artifact_refs: applyResult.artifact_refs ?? [],
          lock_artifact_refs: lockResult.artifact_refs,
          goal_steward_review_ref: goalReview?.artifact_ref,
          goal_alignment_status: goalReview?.status,
          project_goal_spec_ref: goalReview?.spec_ref
        }
      });
      return this.persistResult(result, started.trace_event_id, [candidateRef, conflictRef, rollbackRef, planRef, validationRef, ...goalReviewRefs]);
    } finally {
      await this.lockManager.releaseLocks({
        runId: input.run.id,
        lockIds: lockResult.locks.map((lock) => lock.lock_id),
        reason: "Release integration locks after integration attempt."
      });
    }
  }

  async previewExecutionPreparation(input: {
    runId: string;
    taskId: string;
    changedFiles: string[];
    validationCommands: string[];
    requiredReviews: string[];
    writeClassified: boolean;
  }): Promise<ExecutionIntegrationPreview> {
    if (!input.writeClassified) {
      return createExecutionIntegrationPreview({
        status: "not_required",
        integration_manager_required: false,
        expected_candidate_requirements: [],
        required_post_integration_validation: [],
        changed_files_preview: [],
        limitations: [],
        metadata_json: {
          run_id: input.runId,
          task_id: input.taskId,
          preview_only: true
        }
      });
    }
    return createExecutionIntegrationPreview({
      status: "available",
      integration_manager_required: true,
      expected_candidate_requirements: uniqueStrings([
        "accepted_review_ref",
        "passed_validation_ref",
        "patch_or_change_artifact_ref",
        "changed_files_within_approved_scope",
        ...input.requiredReviews.map((review) => `review:${review}`)
      ]),
      required_post_integration_validation: uniqueStrings(input.validationCommands),
      changed_files_preview: uniqueStrings(input.changedFiles),
      limitations: [
        "Preview only: no integration candidate is created.",
        "Preview only: no locks are acquired.",
        "Preview only: no apply path is called.",
        "Rollback remains manual/limited until a concrete integration candidate exists."
      ],
      metadata_json: {
        run_id: input.runId,
        task_id: input.taskId,
        apply_mode: this.applyMode,
        preview_only: true
      }
    });
  }

  async consumeControlledIntegrationApplyResult(result: ControlledIntegrationApplyResult): Promise<void> {
    await this.metadata.recordControlledApplyResultSaved(result);
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: "integration_controlled_apply_result_referenced",
      lifecycle_stage: "integrating",
      severity: result.status === "post_validation_passed" ? "info" : "warning",
      summary: `Integration manager referenced controlled apply result ${result.status}.`,
      artifact_refs: [result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        controlled_apply_id: result.controlled_apply_id,
        integration_candidate_id: result.integration_candidate_id,
        status: result.status
      }
    });
  }

  async discoverCandidates(run: Run, tasks: Task[], outputs: ParsedAgentOutput[], mode: IntegrationRunMode = "normal"): Promise<IntegrationCandidate[]> {
    if (mode === "plan_only" || mode === "read_only") return [];
    const outputsByTask = new Map(outputs.map((output) => [outputTaskId(output, tasks), output] as const));
    const candidates: IntegrationCandidate[] = [];
    for (const task of tasks) {
      const output = outputsByTask.get(task.id);
      const artifacts = uniqueStrings([...(output?.artifacts ?? []), ...task.artifacts]);
      const patchRef = findArtifact(artifacts, "patch");
      const patchChangedFiles = await readPatchChangedFiles(patchRef);
      const changedFiles = patchChangedFiles ?? uniqueStrings(output?.files_changed ?? []);
      const changeRef = patchRef ?? findArtifact(artifacts, "change");
      if (!changedFiles.length && !changeRef) continue;
      if (!changedFiles.length && patchRef) continue;
      const reviewRef = findArtifact(artifacts, "review");
      const validationRef = findArtifact(artifacts, "validation") ?? findArtifact(artifacts, "verification");
      const reviewDecision = await readReviewDecision(reviewRef);
      const validationStatus = await readValidationStatus(validationRef);
      const intentGatePassed = output?.intent_handoff_gate_status === "passed";
      const moduleLocks = moduleLocksForTask({ ...task, allowed_files_to_edit: changedFiles.length ? changedFiles : task.allowed_files_to_edit }).map((scope) => scope.normalized_scope_key);
      const semanticLocks = semanticLocksForTask({ ...task, allowed_files_to_edit: changedFiles.length ? changedFiles : task.allowed_files_to_edit }).filter((scope) => scope.type === "semantic").map((scope) => scope.normalized_scope_key);
      const rejectionReasons = [
        ...(!intentGatePassed ? [`Intent handoff gate did not pass (${output?.intent_handoff_gate_status ?? "missing"}).`] : []),
        ...(!reviewRef || reviewDecision !== "accept" ? [`Missing accepted review${reviewDecision ? ` (${reviewDecision})` : ""}.`] : []),
        ...(!validationRef ? ["Missing validation result."] : []),
        ...(validationRef && validationStatus !== "passed" ? [`Validation was not fully passed (${validationStatus ?? "unknown"}).`] : [])
      ];
      const status: IntegrationStatus = rejectionReasons.length ? "blocked" : "pending";
      const candidate = createIntegrationCandidate({
        candidate_id: `integration_candidate_${task.id}`,
        run_id: run.id,
        task_id: task.id,
        patch_ref: patchRef,
        change_artifact_ref: changeRef,
        review_ref: reviewRef,
        validation_ref: validationRef,
        changed_files: changedFiles,
        module_locks: moduleLocks,
        semantic_locks: semanticLocks,
        dependencies: task.dependencies,
        status,
        review_decision: reviewDecision,
        validation_status: validationStatus,
        rejection_reasons: rejectionReasons,
        metadata_json: {
          artifact_count: artifacts.length,
          output_summary: output?.summary,
          task_objective: task.objective,
          output_status: output?.status,
          intent_handoff_gate_status: output?.intent_handoff_gate_status,
          intent_handoff_gate_ref: output?.intent_handoff_gate_ref,
          task_status: task.status
        }
      });
      candidates.push(candidate);
      await this.traceWriter.write({
        run_id: run.id,
        task_id: task.id,
        event_type: status === "pending" ? "integration_candidate_discovered" : "integration_candidate_rejected",
        lifecycle_stage: "integrating",
        severity: status === "pending" ? "info" : "warning",
        summary: status === "pending" ? `Integration candidate discovered for ${task.id}.` : `Integration candidate rejected for ${task.id}.`,
        artifact_refs: [patchRef, changeRef, reviewRef, validationRef].filter((ref): ref is string => Boolean(ref)),
        metadata_json: {
          candidate_id: candidate.candidate_id,
          changed_files: candidate.changed_files,
          review_decision: candidate.review_decision,
          validation_status: candidate.validation_status,
          rejection_reasons: candidate.rejection_reasons
        }
      });
    }
    return candidates;
  }

  orderCandidates(tasks: Task[], candidates: IntegrationCandidate[]): IntegrationCandidate[] {
    const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
    const byId = new Map(candidates.map((candidate) => [candidate.task_id, candidate]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const ordered: IntegrationCandidate[] = [];
    const visit = (candidate: IntegrationCandidate) => {
      if (visited.has(candidate.candidate_id) || visiting.has(candidate.candidate_id)) return;
      visiting.add(candidate.candidate_id);
      for (const dependency of candidate.dependencies) {
        const dependencyCandidate = byId.get(dependency);
        if (dependencyCandidate) visit(dependencyCandidate);
      }
      visiting.delete(candidate.candidate_id);
      visited.add(candidate.candidate_id);
      ordered.push(candidate);
    };
    for (const candidate of [...candidates].sort((a, b) => (taskOrder.get(a.task_id) ?? 9999) - (taskOrder.get(b.task_id) ?? 9999) || a.candidate_id.localeCompare(b.candidate_id))) {
      visit(candidate);
    }
    return ordered;
  }

  detectConflicts(runId: string, candidates: IntegrationCandidate[]): IntegrationConflict[] {
    const conflicts: IntegrationConflict[] = [];
    const byFile = new Map<string, IntegrationCandidate[]>();
    for (const candidate of candidates) {
      for (const file of candidate.changed_files) {
        const key = normalizeFile(file);
        byFile.set(key, [...(byFile.get(key) ?? []), candidate]);
      }
      for (const reason of candidate.rejection_reasons ?? []) {
        const type = reason.startsWith("Missing accepted review")
          ? "missing_review"
          : reason.startsWith("Missing validation")
            ? "missing_validation"
            : "validation_not_passed";
        conflicts.push(this.conflict(runId, [candidate.candidate_id], type, candidate.changed_files, [], reason, "blocking"));
      }
    }
    for (const [file, fileCandidates] of byFile) {
      if (fileCandidates.length > 1) {
        conflicts.push(this.conflict(runId, fileCandidates.map((candidate) => candidate.candidate_id), "same_file", [file], [], `Multiple candidates change ${file}.`, "blocking"));
      }
    }
    for (const [left, right] of candidatePairs(candidates)) {
      const overlap = pathOverlap(left.changed_files, right.changed_files);
      if (overlap.length) conflicts.push(this.conflict(runId, [left.candidate_id, right.candidate_id], "path_overlap", overlap, [], "Candidate file paths overlap by directory/file boundary.", "blocking"));
      const moduleOverlap = intersect(left.module_locks, right.module_locks);
      if (moduleOverlap.length) conflicts.push(this.conflict(runId, [left.candidate_id, right.candidate_id], "module_lock", [], moduleOverlap, `Module lock overlap: ${moduleOverlap.join(", ")}.`, "blocking"));
      const semanticOverlap = intersect(left.semantic_locks, right.semantic_locks);
      if (semanticOverlap.length) conflicts.push(this.conflict(runId, [left.candidate_id, right.candidate_id], "semantic_lock", [], semanticOverlap, `Semantic lock overlap: ${semanticOverlap.join(", ")}.`, "blocking"));
    }
    for (const candidate of candidates) {
      const riskFiles = candidate.changed_files.map((file) => file.replace(/\\/g, "/").toLowerCase());
      if (riskFiles.some((file) => /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig[^/]*\.json|vite\.config|tauri\.conf)/.test(file))) {
        conflicts.push(this.conflict(runId, [candidate.candidate_id], "config_risk", candidate.changed_files, candidate.semantic_locks, "Candidate touches project config or dependency manifest.", "blocking"));
      }
      if (riskFiles.some((file) => file.includes("schema") || file.includes("migration") || file.endsWith(".sql"))) {
        conflicts.push(this.conflict(runId, [candidate.candidate_id], "database_schema_risk", candidate.changed_files, candidate.semantic_locks, "Candidate touches database schema or migration surface.", "blocking"));
      }
      if (riskFiles.some((file) => file.includes("/api/") || file.endsWith(".d.ts") || file.includes("packages/protocol"))) {
        conflicts.push(this.conflict(runId, [candidate.candidate_id], "public_api_risk", candidate.changed_files, candidate.semantic_locks, "Candidate may alter public API contracts.", "blocking"));
      }
      if (riskFiles.some((file) => /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock)/.test(file))) {
        conflicts.push(this.conflict(runId, [candidate.candidate_id], "dependency_manifest_risk", candidate.changed_files, candidate.semantic_locks, "Candidate touches dependency manifests.", "blocking"));
      }
    }
    return dedupeConflicts(conflicts);
  }

  private async reviewGoalAlignment(run: Run, tasks: Task[], candidates: IntegrationCandidate[]): Promise<GoalStewardReview | undefined> {
    if (this.config.enable_goal_steward === false) return undefined;
    const steward = new GoalSteward({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "GoalSteward" }),
      provider: this.providerFactory?.("GoalSteward"),
      mode: this.config.goal_steward_mode ?? "strict",
      requireActiveProjectGoalSpec: this.config.require_active_project_goal_spec ?? false
    });
    return steward.reviewIntegration({ run, tasks, candidates });
  }

  private goalConflicts(runId: string, review: GoalStewardReview | undefined, candidates: IntegrationCandidate[]): IntegrationConflict[] {
    if (!review) return [];
    const byId = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
    const allCandidateIds = candidates.map((candidate) => candidate.candidate_id);
    return review.findings
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => {
        const candidateIds = finding.candidate_id ? [finding.candidate_id] : allCandidateIds;
        const changedFiles = finding.candidate_id && byId.has(finding.candidate_id)
          ? byId.get(finding.candidate_id)!.changed_files
          : uniqueStrings(candidates.flatMap((candidate) => candidate.changed_files));
        const conflict = this.conflict(
          runId,
          candidateIds,
          goalConflictType(finding),
          changedFiles,
          uniqueStrings([review.artifact_ref, review.summary_ref, review.spec_ref, ...finding.spec_refs, ...finding.candidate_refs]),
          finding.rationale,
          "blocking"
        );
        conflict.metadata_json = {
          goal_steward_review_id: review.review_id,
          goal_steward_status: review.status,
          recommended_action: finding.recommended_action,
          finding_id: finding.finding_id,
          finding_type: finding.finding_type,
          task_id: finding.task_id,
          spec_refs: finding.spec_refs,
          candidate_refs: finding.candidate_refs,
          ...finding.metadata_json
        };
        return conflict;
      });
  }

  private goalWarnings(review: GoalStewardReview | undefined): string[] {
    if (!review) return [];
    return review.findings
      .filter((finding) => finding.severity !== "blocking")
      .map((finding) => `Goal Steward ${finding.finding_type}: ${finding.rationale}`)
      .slice(0, 8);
  }

  private async finishNotRequired(run: Run, parentTraceId: string, candidateRef: string, mode: IntegrationRunMode): Promise<IntegrationResult> {
    const result = createIntegrationResult({
      run_id: run.id,
      status: "not_required",
      applied_candidates: [],
      rejected_candidates: [],
      blocked_candidates: [],
      conflicts: [],
      validation_status: "not_required",
      validation_refs: [],
      rollback_refs: [],
      changed_files: [],
      apply_mode: this.applyMode,
      rollback_available: false,
      metadata_json: { reason: "No accepted patch or change artifacts required integration.", mode, candidate_ref: candidateRef }
    });
    return this.persistResult(result, parentTraceId, [candidateRef]);
  }

  private async finishBlocked(run: Run, plan: IntegrationPlan, conflicts: IntegrationConflict[], reason: string, artifactRefs: string[], parentTraceId: string, goalReview?: GoalStewardReview): Promise<IntegrationResult> {
    const result = createIntegrationResult({
      run_id: run.id,
      status: "blocked",
      applied_candidates: [],
      rejected_candidates: plan.candidates.filter((candidate) => candidate.status === "blocked").map((candidate) => candidate.candidate_id),
      blocked_candidates: plan.candidates.map((candidate) => candidate.candidate_id),
      conflicts,
      validation_status: "not_run",
      validation_refs: plan.validation_plan.validation_refs,
      rollback_refs: plan.rollback_plan.artifact_ref ? [plan.rollback_plan.artifact_ref] : [],
      changed_files: uniqueStrings(plan.candidates.flatMap((candidate) => candidate.changed_files)),
      apply_mode: this.applyMode,
      rollback_available: plan.rollback_plan.status === "automatic_available",
      blocked_reason: reason,
      metadata_json: {
        integration_plan_id: plan.integration_plan_id,
        reason,
        goal_steward_review_ref: goalReview?.artifact_ref,
        goal_alignment_status: goalReview?.status,
        project_goal_spec_ref: goalReview?.spec_ref
      }
    });
    return this.persistResult(result, parentTraceId, artifactRefs);
  }

  private async persistResult(result: IntegrationResult, parentTraceId: string, artifactRefs: string[]): Promise<IntegrationResult> {
    const eventType = result.status === "not_required"
      ? "integration_not_required"
      : result.status === "passed"
        ? "integration_passed"
        : result.status === "failed"
          ? "integration_failed"
          : "integration_blocked";
    const resultRef = await this.artifactStore.saveIntegrationArtifact(result.run_id, result.integration_result_id, result);
    result.artifact_ref = resultRef;
    await this.artifactStore.saveIntegrationSummary(result.run_id, `integration_summary_${result.integration_result_id}`, integrationSummary(result), { status: result.status, integration_result_id: result.integration_result_id });
    const trace = await this.traceWriter.write({
      run_id: result.run_id,
      event_type: eventType,
      lifecycle_stage: result.status === "not_required" || result.status === "passed" ? "integrating" : "blocked",
      severity: result.status === "passed" || result.status === "not_required" ? "info" : "warning",
      causal_parent_event_id: parentTraceId,
      summary: result.blocked_reason ?? `Integration ${result.status}.`,
      artifact_refs: uniqueStrings([...artifactRefs, resultRef]),
      metadata_json: {
        integration_result_id: result.integration_result_id,
        status: result.status,
        validation_status: result.validation_status,
        changed_files: result.changed_files,
        conflicts_count: result.conflicts.length
      }
    });
    result.trace_event_id = trace.trace_event_id;
    await this.metadata.recordIntegrationResultSaved({ result, artifactRef: resultRef });
    await this.traceWriter.write({
      run_id: result.run_id,
      event_type: result.status === "passed" || result.status === "not_required" ? "integration_completed" : eventType,
      lifecycle_stage: result.status === "passed" || result.status === "not_required" ? "integrating" : "blocked",
      severity: result.status === "passed" || result.status === "not_required" ? "info" : "warning",
      causal_parent_event_id: trace.trace_event_id,
      summary: `Integration result recorded: ${result.status}.`,
      artifact_refs: [resultRef],
      metadata_json: { integration_result_id: result.integration_result_id, trace_event_id: result.trace_event_id }
    });
    return result;
  }

  private async acquireRequiredLocks(runId: string, plan: IntegrationPlan): Promise<LockAcquisitionResult> {
    const scopes: FactoryLockScope[] = [
      ...uniqueStrings(plan.candidates.flatMap((candidate) => candidate.changed_files)).map((file) => this.lockManager.normalizeLockScope(file, "write")),
      ...uniqueStrings(plan.candidates.flatMap((candidate) => candidate.module_locks)).map((lock) => lockScope("module", lock, "Integration requires module lock.")),
      ...uniqueStrings(plan.candidates.flatMap((candidate) => candidate.semantic_locks)).map((lock) => lockScope("semantic", lock, "Integration requires semantic lock."))
    ];
    await this.traceWriter.write({
      run_id: runId,
      event_type: "integration_locks_requested",
      lifecycle_stage: "integrating",
      summary: `Requesting ${scopes.length} integration lock(s).`,
      metadata_json: { integration_plan_id: plan.integration_plan_id, scopes: scopes.map((scope) => scope.normalized_scope_key) }
    });
    const result = await this.lockManager.acquireLocks({
      request_id: `integration_lock_request_${randomUUID()}`,
      run_id: runId,
      owner_component: "IntegrationManager",
      scopes,
      ttl_ms: this.config.lock_ttl_ms,
      reason: "Acquire durable locks before integration batch.",
      metadata_json: { integration_plan_id: plan.integration_plan_id }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: result.acquired ? "integration_locks_acquired" : "integration_locks_rejected",
      lifecycle_stage: result.acquired ? "integrating" : "blocked",
      severity: result.acquired ? "info" : "warning",
      summary: result.acquired ? `Acquired ${result.locks.length} integration lock(s).` : "Integration lock request rejected.",
      artifact_refs: result.artifact_refs,
      metadata_json: {
        integration_plan_id: plan.integration_plan_id,
        lock_ids: result.locks.map((lock) => lock.lock_id),
        conflict_count: result.conflicts.length
      }
    });
    return result;
  }

  private async applyOrPrepare(plan: IntegrationPlan): Promise<IntegrationApplyAdapterResult> {
    await this.traceWriter.write({
      run_id: plan.run_id,
      event_type: "integration_apply_started",
      lifecycle_stage: "integrating",
      summary: `Integration apply mode: ${this.applyMode}.`,
      artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_plan_id: plan.integration_plan_id, apply_mode: this.applyMode }
    });
    if (this.applyMode === "safe_adapter" && this.adapter?.apply) {
      const result = await this.adapter.apply(plan.batches[0], plan);
      await this.traceWriter.write({
        run_id: plan.run_id,
        event_type: result.status === "applied" ? "integration_apply_completed" : "integration_apply_failed",
        lifecycle_stage: result.status === "applied" ? "integrating" : "blocked",
        severity: result.status === "applied" ? "info" : "warning",
        summary: result.message ?? `Safe adapter returned ${result.status}.`,
        artifact_refs: result.artifact_refs ?? [],
        metadata_json: { integration_plan_id: plan.integration_plan_id, apply_mode: this.applyMode, status: result.status }
      });
      return result;
    }
    if (this.adapter?.prepare) {
      const result = await this.adapter.prepare(plan);
      return result.status === "applied" ? { ...result, status: "blocked", message: "Prepare-only adapter cannot mark integration applied." } : result;
    }
    const limitation = "No safe patch application adapter is available in this runtime; integration was prepared but not applied.";
    await this.traceWriter.write({
      run_id: plan.run_id,
      event_type: "integration_apply_failed",
      lifecycle_stage: "blocked",
      severity: "warning",
      summary: limitation,
      artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { integration_plan_id: plan.integration_plan_id, apply_mode: this.applyMode }
    });
    return { status: "blocked", message: limitation, artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)) };
  }

  private async validateAfterApply(run: Run, tasks: Task[], candidates: IntegrationCandidate[], commandInventory: CommandInventory | undefined, applyResult: IntegrationApplyAdapterResult) {
    await this.traceWriter.write({
      run_id: run.id,
      event_type: "integration_validation_started",
      lifecycle_stage: "validating",
      summary: "Post-integration validation started.",
      metadata_json: { candidate_ids: candidates.map((candidate) => candidate.candidate_id) }
    });
    if (applyResult.validation_status) {
      return {
        validation_status: normalizeValidationStatus(applyResult.validation_status),
        validation_refs: applyResult.validation_refs ?? [],
        source: "adapter"
      };
    }
    const runner = this.validationRunner ?? new ValidationRunner(this.workspacePath, this.artifactStore, this.config);
    const results: VerificationResult[] = [];
    for (const candidate of candidates) {
      const task = tasks.find((entry) => entry.id === candidate.task_id);
      if (!task) continue;
      results.push(await runner.runForTask({ runId: run.id, task, commandInventory }));
    }
    const statuses = results.map((result) => normalizeValidationStatus(result.validation_status ?? "not_run"));
    const aggregate = aggregateValidationStatus(statuses.map((status) => ({
      command: "post-integration validation",
      status: status === "not_required" || status === "partial" ? "not_run" : status,
      required: true
    }))).status;
    return {
      validation_status: aggregate,
      validation_refs: uniqueStrings(results.flatMap((result) => result.logs_refs ?? [])),
      source: "ValidationRunner"
    };
  }

  private createRollbackPlan(runId: string, candidates: IntegrationCandidate[]): IntegrationRollbackPlan {
    return {
      rollback_plan_id: `rollback_plan_${randomUUID()}`,
      run_id: runId,
      status: "manual_limited",
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      changed_files: uniqueStrings(candidates.flatMap((candidate) => candidate.changed_files)),
      rollback_refs: [],
      instructions: [
        "Rollback is manual/limited because this TypeScript runtime does not own the Rust patch authority.",
        "Inspect changed files and candidate patch artifacts before reverting.",
        "Use repository VCS or the Rust patch authority to restore pre-integration file state."
      ],
      created_at: new Date().toISOString(),
      metadata_json: { automatic_rollback: false }
    };
  }

  private createBatch(runId: string, candidates: IntegrationCandidate[]): IntegrationBatch {
    return {
      integration_batch_id: `integration_batch_${randomUUID()}`,
      run_id: runId,
      candidate_ids: candidates.map((candidate) => candidate.candidate_id),
      changed_files: uniqueStrings(candidates.flatMap((candidate) => candidate.changed_files)),
      required_locks: uniqueStrings(candidates.flatMap((candidate) => candidate.changed_files)),
      module_locks: uniqueStrings(candidates.flatMap((candidate) => candidate.module_locks)),
      semantic_locks: uniqueStrings(candidates.flatMap((candidate) => candidate.semantic_locks)),
      status: "planned",
      created_at: new Date().toISOString(),
      metadata_json: {}
    };
  }

  private orderWarnings(tasks: Task[], ordered: IntegrationCandidate[]) {
    const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
    const byTaskOrder = [...ordered].sort((a, b) => (taskOrder.get(a.task_id) ?? 9999) - (taskOrder.get(b.task_id) ?? 9999) || a.candidate_id.localeCompare(b.candidate_id));
    return ordered.map((candidate) => candidate.candidate_id).join("|") === byTaskOrder.map((candidate) => candidate.candidate_id).join("|")
      ? []
      : ["Dependency ordering changed candidate order; ambiguous peers remain sorted deterministically."];
  }

  private conflict(runId: string, candidateIds: string[], type: IntegrationConflict["conflict_type"], changedFiles: string[], lockRefs: string[], reason: string, severity: IntegrationConflict["severity"]): IntegrationConflict {
    return {
      conflict_id: `integration_conflict_${randomUUID()}`,
      run_id: runId,
      candidate_ids: candidateIds,
      conflict_type: type,
      changed_files: changedFiles,
      lock_refs: lockRefs,
      severity,
      reason,
      created_at: new Date().toISOString(),
      metadata_json: {}
    };
  }
}

function outputTaskId(output: ParsedAgentOutput, tasks: Task[]) {
  for (const artifact of output.artifacts) {
    const basename = path.basename(artifact);
    const match = tasks.find((task) => basename.includes(task.id));
    if (match) return match.id;
  }
  return tasks.find((task) => task.status === output.status && arraysOverlap(task.allowed_files_to_edit, output.files_changed))?.id ?? tasks[0]?.id ?? "";
}

function findArtifact(artifacts: string[], kind: string) {
  const needle = kind.toLowerCase();
  return artifacts.find((artifact) => {
    const basename = path.basename(artifact).toLowerCase();
    const segments = artifact.replace(/\\/g, "/").toLowerCase().split("/");
    return basename.includes(needle) || segments.includes(`${needle}s`) || segments.includes(needle);
  });
}

async function readReviewDecision(ref: string | undefined): Promise<string | undefined> {
  const value = await readOptionalRecord(ref);
  if (!value) return undefined;
  if (typeof value.decision === "string") return value.decision;
  if (typeof value.status === "string") return value.status === "succeeded" ? "accept" : value.status;
  return undefined;
}

async function readValidationStatus(ref: string | undefined): Promise<OverallValidationStatus | undefined> {
  const value = await readOptionalRecord(ref);
  if (!value) return undefined;
  const nestedResult = asRecord(value.result);
  const aggregate = asRecord(value.aggregate);
  const status = stringValue(value.status) ?? stringValue(value.validation_status) ?? stringValue(nestedResult?.validation_status) ?? stringValue(aggregate?.status);
  return status ? normalizeValidationStatus(status) : undefined;
}

async function readPatchChangedFiles(ref: string | undefined): Promise<string[] | undefined> {
  const value = await readOptionalRecord(ref);
  if (!value) return undefined;
  const safety = asRecord(value.safety);
  if (Array.isArray(safety?.changed_files)) return safety.changed_files.filter((entry): entry is string => typeof entry === "string");
  if (Array.isArray(value.changed_files)) return value.changed_files.filter((entry): entry is string => typeof entry === "string");
  return undefined;
}

async function readOptionalRecord(ref: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!ref || !existsSync(ref)) return undefined;
  try {
    const value = await readJson<unknown>(ref);
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function lockScope(type: "module" | "semantic", key: string, reason: string): FactoryLockScope {
  return {
    type,
    mode: "write",
    scope: key,
    normalized_scope_key: key,
    confidence: "high",
    reason,
    metadata_json: {}
  };
}

function normalizeFile(file: string) {
  return file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function pathOverlap(left: string[], right: string[]) {
  const overlaps: string[] = [];
  for (const a of left.map(normalizeFile)) {
    for (const b of right.map(normalizeFile)) {
      if (a === b) continue;
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) overlaps.push(a.length <= b.length ? a : b);
    }
  }
  return uniqueStrings(overlaps);
}

function candidatePairs(candidates: IntegrationCandidate[]) {
  const pairs: Array<[IntegrationCandidate, IntegrationCandidate]> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    for (let next = index + 1; next < candidates.length; next += 1) {
      pairs.push([candidates[index], candidates[next]]);
    }
  }
  return pairs;
}

function intersect(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return uniqueStrings(left.filter((entry) => rightSet.has(entry)));
}

function arraysOverlap(left: string[], right: string[]) {
  return intersect(left.map(normalizeFile), right.map(normalizeFile)).length > 0;
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function dedupeConflicts(conflicts: IntegrationConflict[]) {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.conflict_type}:${conflict.candidate_ids.slice().sort().join(",")}:${conflict.changed_files.slice().sort().join(",")}:${conflict.lock_refs.slice().sort().join(",")}:${conflict.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function goalConflictType(finding: GoalStewardFinding): IntegrationConflict["conflict_type"] {
  if (finding.finding_type === "provider_unavailable") return "goal_steward_unavailable";
  if (finding.finding_type === "insufficient_spec") return "goal_spec_missing";
  if (finding.finding_type === "requires_human_approval" || finding.recommended_action === "require_human_approval") return "goal_change_requires_approval";
  return "goal_spec_conflict";
}

function integrationSummary(result: IntegrationResult) {
  return [
    `# Integration ${result.status}`,
    "",
    `- Result: ${result.integration_result_id}`,
    `- Validation: ${result.validation_status}`,
    `- Candidates applied: ${result.applied_candidates.length}`,
    `- Candidates blocked: ${result.blocked_candidates.length}`,
    `- Conflicts: ${result.conflicts.length}`,
    `- Rollback: ${result.rollback_available ? "automatic" : "manual/limited"}`,
    result.blocked_reason ? `- Blocked reason: ${result.blocked_reason}` : ""
  ].filter(Boolean).join("\n");
}
