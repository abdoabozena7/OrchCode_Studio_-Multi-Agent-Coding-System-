import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ControlledIntegrationApplyManager,
  CoreOrchestrator,
  DurableLockManager,
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  IntegrationFinalizationManager,
  OrchestrationArtifactStore,
  createControlledIntegrationApplyResult,
  createIntegrationApplyApproval,
  createIntegrationApplyScope,
  createIntegrationFinalizationBatch,
  createIntegrationFinalizationBlocker,
  createIntegrationFinalizationResult,
  createIntegrationFinalizationSummary,
  createIntegrationLesson,
  createIntegrationMemoryEntry,
  createPatchProposal,
  createPatchProposalFileChange,
  createPostIntegrationValidationPlan,
  createRollbackRequirements,
  createSandboxValidatedIntegrationCandidate,
  createTaskStatusUpdateRef,
  createWorktreeSafetyCheck,
  createRollbackResult,
  loadOrchestrationConfig,
  reconstructFactoryRunTrace,
  type ControlledIntegrationApplyResult,
  type PatchProposalChangeType,
  type SandboxValidatedIntegrationCandidate
} from "../orchestration/index.js";

test("integration finalization models create result memory lesson update summary and batch", () => {
  const blocker = createIntegrationFinalizationBlocker({
    integration_finalization_id: "final_model",
    run_id: "run_model",
    controlled_apply_id: "controlled_model",
    integration_candidate_id: "candidate_model",
    blocker_type: "strict_validation_not_passed",
    severity: "blocking",
    reason: "Validation failed.",
    refs: []
  });
  const memory = createIntegrationMemoryEntry({
    integration_finalization_id: "final_model",
    run_id: "run_model",
    controlled_apply_id: "controlled_model",
    integration_candidate_id: "candidate_model",
    scope: "run",
    entry_type: "integration",
    summary: "Integrated.",
    source_refs: [],
    confidence: 0.9,
    freshness: "fresh",
    tags: ["test"]
  });
  const lesson = createIntegrationLesson({
    integration_finalization_id: "final_model",
    run_id: "run_model",
    controlled_apply_id: "controlled_model",
    integration_candidate_id: "candidate_model",
    lesson_type: "validation",
    summary: "Validate after apply.",
    evidence_refs: [],
    tags: ["test"]
  });
  const update = createTaskStatusUpdateRef({
    integration_finalization_id: "final_model",
    run_id: "run_model",
    controlled_apply_id: "controlled_model",
    integration_candidate_id: "candidate_model",
    target_type: "proposal",
    target_id: "proposal_model",
    next_status: "integrated"
  });
  const result = createIntegrationFinalizationResult({
    integration_finalization_id: "final_model",
    run_id: "run_model",
    controlled_apply_id: "controlled_model",
    integration_candidate_id: "candidate_model",
    proposal_id: "proposal_model",
    controlled_apply_status: "post_validation_failed",
    strict_validation_status: "failed",
    finalized_files: [],
    rejected_files: ["src/runtime.ts"],
    validation_refs: [],
    apply_refs: [],
    rollback_refs: [],
    status: "validation_failed",
    blockers: [blocker],
    memory_entries_created: [memory],
    lessons_created: [lesson],
    task_status_updates: [update]
  });
  const summary = createIntegrationFinalizationSummary({
    run_id: "run_model",
    integration_finalization_used: true,
    integration_finalization_count: 1,
    finalized_count: 0,
    validation_failed_count: 1,
    rollback_completed_count: 0,
    rollback_failed_count: 0,
    memory_entries_created_count: 1,
    lessons_created_count: 1
  });
  const batch = createIntegrationFinalizationBatch({ run_id: "run_model", controlled_apply_ids: ["controlled_model"], results: [result], summary });
  assert.equal(result.status, "validation_failed");
  assert.equal(result.blockers[0]?.blocker_type, "strict_validation_not_passed");
  assert.equal(batch.summary.validation_failed_count, 1);
});

test("passed controlled apply finalizes metadata, memory, lessons, artifacts, traces, and does not apply or validate again", async () => {
  const workspace = await fixtureWorkspace("integration-finalization-pass");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const { result } = await appliedControlledResult(workspace, artifactStore, "run_final_pass");
    const beforeContent = await readFile(path.join(workspace, "src/runtime.ts"), "utf8");
    const before = await counts(workspace);
    const finalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(result);
    const after = await counts(workspace);
    assert.equal(finalization.status, "finalized");
    assert.deepEqual(finalization.finalized_files, ["src/runtime.ts"]);
    assert.ok(finalization.artifact_ref && existsSync(finalization.artifact_ref));
    assert.ok(finalization.report_summary_ref && existsSync(finalization.report_summary_ref));
    assert.ok(existsSync(path.join(path.dirname(finalization.artifact_ref), "memory_updates.json")));
    assert.ok(existsSync(path.join(path.dirname(finalization.artifact_ref), "lessons.json")));
    assert.ok(existsSync(path.join(path.dirname(finalization.artifact_ref), "task_status_updates.json")));
    assert.ok(finalization.memory_entries_created.length >= 3);
    assert.ok(finalization.lessons_created.length >= 3);
    assert.ok(finalization.task_status_updates.some((update) => update.target_type === "integration_candidate"));
    assert.equal(await readFile(path.join(workspace, "src/runtime.ts"), "utf8"), beforeContent);
    assert.equal(after.controlledApplies, before.controlledApplies);
    assert.equal(after.validations, before.validations);
    const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_finalizations WHERE status = 'finalized'")?.count, 1);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_memory_updates")?.count, finalization.memory_entries_created.length);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_lessons")?.count, finalization.lessons_created.length);
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_task_status_updates")?.count, finalization.task_status_updates.length);
    } finally {
      store.close();
    }
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: result.run_id });
    for (const eventType of [
      "integration_finalization_started",
      "integration_finalization_eligibility_passed",
      "integration_finalization_status_updated",
      "integration_finalization_memory_update_started",
      "integration_finalization_memory_update_completed",
      "integration_finalization_lesson_created",
      "integration_finalization_task_status_updated",
      "integration_finalization_completed",
      "integration_finalization_summary_created"
    ]) {
      assert.ok(trace.events.some((event) => event.event_type === eventType), `missing trace ${eventType}`);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("failed and blocked validation do not mark integration finalized", async () => {
  const workspace = await fixtureWorkspace("integration-finalization-validation-blocks");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const failed = await appliedControlledResult(workspace, artifactStore, "run_final_failed", ["node -e \"process.exit(1)\""]);
    const failedFinalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(failed.result);
    assert.equal(failedFinalization.status, "rollback_completed");
    assert.equal(failedFinalization.finalized_files.length, 0);

    const blocked = await manualControlledResult(workspace, artifactStore, "run_final_blocked", {
      status: "validation_blocked",
      strict_validation_status: "blocked"
    });
    const blockedFinalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(blocked.result);
    assert.equal(blockedFinalization.status, "validation_blocked");
    assert.ok(blockedFinalization.blockers.some((blocker) => blocker.blocker_type === "strict_validation_not_passed"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rollback failed missing post-validation ref and missing candidate block finalization", async () => {
  const workspace = await fixtureWorkspace("integration-finalization-failures");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    const rollbackFailed = await manualControlledResult(workspace, artifactStore, "run_final_rollback_failed", {
      status: "rollback_failed",
      strict_validation_status: "failed",
      rollbackStatus: "rollback_failed"
    });
    const rollbackFinalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(rollbackFailed.result);
    assert.equal(rollbackFinalization.status, "rollback_failed");
    assert.ok(rollbackFinalization.blockers.some((blocker) => blocker.severity === "critical"));

    const missingValidation = await manualControlledResult(workspace, artifactStore, "run_final_missing_validation", {
      status: "post_validation_passed",
      strict_validation_status: "passed",
      omitPostValidationRef: true
    });
    const missingValidationFinalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(missingValidation.result);
    assert.equal(missingValidationFinalization.status, "blocked");
    assert.ok(missingValidationFinalization.blockers.some((blocker) => blocker.blocker_type === "post_validation_ref_missing"));

    const missingCandidate = await manualControlledResult(workspace, artifactStore, "run_final_missing_candidate", {
      status: "post_validation_passed",
      strict_validation_status: "passed",
      persistCandidate: false
    });
    const missingCandidateFinalization = await new IntegrationFinalizationManager({ workspacePath: workspace, config: config(), artifactStore })
      .finalizeControlledApplyResult(missingCandidate.result);
    assert.equal(missingCandidateFinalization.status, "blocked");
    assert.ok(missingCandidateFinalization.blockers.some((blocker) => blocker.blocker_type === "integration_candidate_missing"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("batch and CoreOrchestrator disabled enabled behavior records final report summary fields", async () => {
  const workspace = await fixtureWorkspace("integration-finalization-core");
  try {
    await writeWorkspaceFile(workspace, "src/runtime.ts", "main\n");
    const artifactStore = new OrchestrationArtifactStore(workspace);
    await appliedControlledResult(workspace, artifactStore, "run_final_core");
    const disabled = new CoreOrchestrator({ workspacePath: workspace, config: config({ enable_integration_finalization: false }) });
    await (disabled as unknown as { finalizeIntegrationIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .finalizeIntegrationIfAllowed("run_final_core", false);
    let store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_finalization_batches")?.count, 0);
    } finally {
      store.close();
    }

    const enabled = new CoreOrchestrator({ workspacePath: workspace, config: config() });
    await (enabled as unknown as { finalizeIntegrationIfAllowed(runId: string, planOnly: boolean): Promise<void> })
      .finalizeIntegrationIfAllowed("run_final_core", false);
    const summary = await (enabled as unknown as { integrationFinalizationReportSummary(runId: string): Promise<{
      integration_finalization_used: boolean;
      integration_finalization_count: number;
      finalized_count: number;
      memory_entries_created_count: number;
      lessons_created_count: number;
      finalization_summary_ref?: string;
    }> }).integrationFinalizationReportSummary("run_final_core");
    assert.equal(summary.integration_finalization_used, true);
    assert.equal(summary.integration_finalization_count, 1);
    assert.equal(summary.finalized_count, 1);
    assert.ok(summary.memory_entries_created_count > 0);
    assert.ok(summary.lessons_created_count > 0);
    assert.ok(summary.finalization_summary_ref && existsSync(summary.finalization_summary_ref));
    store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_integration_finalization_batches")?.count, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function appliedControlledResult(workspace: string, artifactStore: OrchestrationArtifactStore, runId: string, validationCommands = ["node -e \"process.exit(0)\""]) {
  const candidate = await persistedCandidate(workspace, artifactStore, { runId, validationCommands });
  const approval = await persistedApproval(workspace, artifactStore, candidate);
  const result = await new ControlledIntegrationApplyManager({ workspacePath: workspace, config: config(), artifactStore })
    .applyApprovedIntegrationCandidate(candidate, approval);
  return { candidate, approval, result };
}

async function manualControlledResult(workspace: string, artifactStore: OrchestrationArtifactStore, runId: string, options: {
  status: ControlledIntegrationApplyResult["status"];
  strict_validation_status: ControlledIntegrationApplyResult["strict_validation_status"];
  rollbackStatus?: "rolled_back" | "rollback_failed";
  omitPostValidationRef?: boolean;
  persistCandidate?: boolean;
}) {
  const candidate = await candidateFixture(workspace, { runId, validationCommands: ["node -e \"process.exit(0)\""] });
  if (options.persistCandidate !== false) {
    const refs = await artifactStore.saveSandboxIntegrationCandidate({ candidate });
    candidate.artifact_ref = refs.candidateRef;
    candidate.rollback_requirements_ref = refs.rollbackRef;
    candidate.post_integration_validation_plan_ref = refs.postValidationRef;
    await new FactoryMetadataAdapter(workspace).recordSandboxIntegrationCandidateSaved(candidate);
  }
  const approval = await persistedApproval(workspace, artifactStore, candidate);
  const lockRefs = await releasedLocks(workspace, runId, candidate.changed_files);
  const postValidationRef = options.omitPostValidationRef
    ? undefined
    : await writeJsonFile(workspace, `.agent_memory/fixtures/post_validation_${runId}.json`, { status: options.strict_validation_status });
  const controlledApplyId = `controlled_apply_${candidate.integration_candidate_id}_${options.status}`;
  let rollbackRef: string | undefined;
  if (options.rollbackStatus) {
    const rollback = createRollbackResult({
      controlled_apply_id: controlledApplyId,
      run_id: runId,
      integration_candidate_id: candidate.integration_candidate_id,
      status: options.rollbackStatus,
      restored_files: options.rollbackStatus === "rolled_back" ? candidate.changed_files : [],
      failed_files: options.rollbackStatus === "rollback_failed" ? candidate.changed_files : []
    });
    rollbackRef = await writeJsonFile(workspace, `.agent_memory/fixtures/rollback_${runId}.json`, rollback);
    rollback.artifact_ref = rollbackRef;
    await new FactoryMetadataAdapter(workspace).recordControlledRollbackResultSaved(rollback);
  }
  const result = createControlledIntegrationApplyResult({
    controlled_apply_id: controlledApplyId,
    run_id: runId,
    integration_candidate_id: candidate.integration_candidate_id,
    integration_apply_approval_id: approval.integration_apply_approval_id,
    proposal_id: candidate.proposal_id,
    patch_artifact_ref: candidate.patch_artifact_ref,
    approval_ref: approval.artifact_ref,
    changed_files: candidate.changed_files,
    acquired_lock_refs: lockRefs,
    pre_apply_snapshot_ref: await writeJsonFile(workspace, `.agent_memory/fixtures/pre_snapshot_${runId}.json`, { changed_files: candidate.changed_files }),
    apply_adapter: "manual_fixture_adapter",
    apply_status: "applied",
    applied_files: options.status === "post_validation_passed" ? candidate.changed_files : [],
    failed_files: [],
    post_validation_result_ref: postValidationRef,
    strict_validation_status: options.strict_validation_status,
    rollback_plan_ref: candidate.rollback_requirements_ref,
    rollback_result_ref: rollbackRef,
    status: options.status,
    metadata_json: { no_provider_writer: true, no_patch_generation: true }
  });
  const artifactRef = await writeJsonFile(workspace, `.agent_memory/runs/${runId}/controlled_integration_apply/${result.controlled_apply_id}/controlled_apply_result.json`, result);
  result.artifact_ref = artifactRef;
  await writeFile(artifactRef, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await new FactoryMetadataAdapter(workspace).recordControlledApplyResultSaved(result);
  return { candidate, approval, result };
}

async function releasedLocks(workspace: string, runId: string, files: string[]) {
  const lockManager = new DurableLockManager({ workspacePath: workspace, ownerComponent: "IntegrationFinalizationFixture" });
  const acquired: string[] = [];
  for (const file of files) {
    const result = await lockManager.acquireFileLock(runId, "finalization_fixture", file);
    acquired.push(...result.locks.filter((lock) => lock.status === "acquired").map((lock) => lock.lock_id));
  }
  await lockManager.releaseLocks({ runId, lockIds: acquired, reason: "Fixture lock release before finalization." });
  return acquired;
}

async function counts(workspace: string) {
  const store = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
  try {
    return {
      controlledApplies: store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_controlled_integration_applies")?.count ?? 0,
      validations: store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_validations")?.count ?? 0
    };
  } finally {
    store.close();
  }
}

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeWorkspaceFile(workspace: string, relative: string, content: string) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function writeJsonFile(workspace: string, relative: string, value: unknown) {
  const target = path.join(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

function config(overrides: Parameters<typeof loadOrchestrationConfig>[0] = {}) {
  return loadOrchestrationConfig({
    enable_controlled_integration_apply: true,
    controlled_apply_mode: "apply_with_approval",
    require_human_approval_for_controlled_apply: true,
    require_automatic_rollback: true,
    require_clean_candidate_paths: true,
    controlled_apply_validation_timeout_ms: 10_000,
    safe_commands_allowlist: ["node -e", "git diff --check"],
    enable_integration_apply_approval_gate: true,
    integration_apply_approval_mode: "require_approval",
    enable_sandbox_integration_candidates: true,
    sandbox_integration_candidate_mode: "create_candidates",
    enable_integration_finalization: true,
    integration_finalization_mode: "finalize_metadata",
    create_integration_memory_entries: true,
    create_integration_lessons: true,
    require_passed_post_apply_validation: true,
    max_finalizations_per_run: 4,
    require_environment_readiness: false,
    ...overrides
  });
}

async function persistedCandidate(workspace: string, artifactStore: OrchestrationArtifactStore, options: {
  runId: string;
  validationCommands: string[];
}) {
  const candidate = await candidateFixture(workspace, options);
  const refs = await artifactStore.saveSandboxIntegrationCandidate({ candidate });
  candidate.artifact_ref = refs.candidateRef;
  candidate.rollback_requirements_ref = refs.rollbackRef;
  candidate.rollback_requirements.artifact_ref = refs.rollbackRef;
  candidate.post_integration_validation_plan_ref = refs.postValidationRef;
  candidate.post_integration_validation_plan.artifact_ref = refs.postValidationRef;
  candidate.summary_ref = refs.summaryRef;
  await new FactoryMetadataAdapter(workspace).recordSandboxIntegrationCandidateSaved(candidate);
  return candidate;
}

async function persistedApproval(workspace: string, artifactStore: OrchestrationArtifactStore, candidate: SandboxValidatedIntegrationCandidate) {
  const scope = createIntegrationApplyScope({
    integration_candidate_id: candidate.integration_candidate_id,
    allowed_files: candidate.changed_files,
    forbidden_files: ["secrets.env"],
    changed_files: candidate.changed_files,
    required_file_locks: candidate.required_file_locks,
    required_module_locks: candidate.required_module_locks,
    required_semantic_locks: candidate.required_semantic_locks,
    validation_requirements: candidate.post_integration_validation_plan.required_commands,
    rollback_requirements_ref: candidate.rollback_requirements_ref,
    post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
    integration_manager_required: true,
    durable_locks_required: true,
    strict_validation_required: true,
    provider_write_workers_allowed: false,
    dirty_overlap_override: false
  });
  const approval = createIntegrationApplyApproval({
    integration_apply_approval_id: `integration_apply_approval_${candidate.integration_candidate_id}`,
    run_id: candidate.run_id,
    integration_candidate_id: candidate.integration_candidate_id,
    proposal_id: candidate.proposal_id,
    review_id: candidate.review_id,
    validation_candidate_id: candidate.validation_candidate_id,
    sandbox_result_id: candidate.sandbox_result_id,
    sandbox_validation_id: candidate.sandbox_validation_id,
    preparation_plan_id: candidate.preparation_plan_id,
    proposed_node_id: candidate.proposed_node_id,
    approval_required: true,
    approval_status: "approved_for_apply_candidate",
    approver_type: "human",
    approver_id: "operator",
    approval_reason: "Fixture approval for finalization.",
    approved_scope: scope,
    allowed_files: scope.allowed_files,
    forbidden_files: scope.forbidden_files,
    changed_files: candidate.changed_files,
    required_file_locks: candidate.required_file_locks,
    required_module_locks: candidate.required_module_locks,
    required_semantic_locks: candidate.required_semantic_locks,
    rollback_requirements_ref: candidate.rollback_requirements_ref,
    post_integration_validation_plan_ref: candidate.post_integration_validation_plan_ref,
    worktree_safety_status: "clean",
    apply_mode_recommendation: "controlled_apply_requires_approval",
    risk_level: "low"
  });
  const worktreeSafetyCheck = createWorktreeSafetyCheck({
    run_id: candidate.run_id,
    integration_candidate_id: candidate.integration_candidate_id,
    status: "clean",
    dirty_files: [],
    findings: [],
    command: "git status --short"
  });
  const refs = await artifactStore.saveIntegrationApplyApproval({
    approval,
    worktreeSafetyCheck,
    approvalScopeCheck: { approved_scope: scope, blockers: [] },
    applyModeRecommendation: { recommendation: "controlled_apply_requires_approval" }
  });
  approval.artifact_ref = refs.approvalRef;
  approval.summary_ref = refs.summaryRef;
  await new FactoryMetadataAdapter(workspace).recordIntegrationApplyApprovalSaved(approval, worktreeSafetyCheck);
  return approval;
}

async function candidateFixture(workspace: string, options: {
  runId: string;
  validationCommands: string[];
}): Promise<SandboxValidatedIntegrationCandidate> {
  const changedFiles = ["src/runtime.ts"];
  const proposalRef = await patchArtifact(workspace, options.runId, [
    change(`proposal_${options.runId}`, "src/runtime.ts", "modify", true, "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@\n-main\n+main changed\n")
  ], changedFiles);
  const sandboxApplyRef = await writeJsonFile(workspace, `.agent_memory/fixtures/sandbox_apply_${options.runId}.json`, {
    sandbox_result_id: `sandbox_result_${options.runId}`,
    run_id: options.runId,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    patch_artifact_ref: proposalRef,
    sandbox_mode: "simulate_only",
    changed_files: changedFiles,
    dry_apply_status: "dry_apply_passed",
    conflicts: [],
    failed_hunks: [],
    unsafe_findings: [],
    main_repo_modified: false,
    validation_run: false,
    integration_created: false,
    metadata_json: {},
    created_at: new Date().toISOString()
  });
  const reviewRef = await writeJsonFile(workspace, `.agent_memory/fixtures/review_${options.runId}.json`, {
    review_id: `review_${options.runId}`,
    decision: "accept_for_validation_candidate",
    findings: []
  });
  return createSandboxValidatedIntegrationCandidate({
    integration_candidate_id: `integration_candidate_${options.runId}`,
    run_id: options.runId,
    proposal_id: `proposal_${options.runId}`,
    review_id: `review_${options.runId}`,
    validation_candidate_id: `validation_candidate_${options.runId}`,
    sandbox_result_id: `sandbox_result_${options.runId}`,
    sandbox_validation_id: `sandbox_validation_${options.runId}`,
    preparation_plan_id: `preparation_${options.runId}`,
    proposed_node_id: `node_${options.runId}`,
    patch_artifact_ref: proposalRef,
    patch_summary: "Patch summary.",
    changed_files: changedFiles,
    required_file_locks: changedFiles,
    required_module_locks: ["module:src"],
    required_semantic_locks: [`preparation:preparation_${options.runId}`],
    review_ref: reviewRef,
    sandbox_apply_ref: sandboxApplyRef,
    sandbox_validation_ref: `sandbox_validation_ref_${options.runId}`,
    strict_validation_status: "passed",
    rollback_requirements: createRollbackRequirements({
      status: "automatic_available",
      changed_files: changedFiles,
      rollback_refs: [proposalRef],
      instructions: ["Restore from pre-apply snapshot."],
      limitations: []
    }),
    post_integration_validation_plan: createPostIntegrationValidationPlan({
      required_commands: options.validationCommands,
      optional_commands: [],
      expected_outputs: ["Strict validation artifact."],
      sandbox_validation_id: `sandbox_validation_${options.runId}`,
      sandbox_strict_validation_status: "passed",
      additional_checks: ["Re-run after apply."]
    }),
    risk_level: "low",
    approval_required: true,
    status: "candidate_created",
    metadata_json: {
      scope_check_status: "passed",
      dry_apply_status: "dry_apply_passed",
      main_repo_integrity_ok: true
    }
  });
}

async function patchArtifact(workspace: string, id: string, changes: ReturnType<typeof change>[], changedFiles: string[]) {
  const patchProposal = createPatchProposal({
    run_id: `run_${id}`,
    preparation_plan_id: `preparation_${id}`,
    proposal_id: `proposal_${id}`,
    summary: "Patch proposal.",
    changed_files: changedFiles,
    file_changes: changes,
    risks: [],
    assumptions: [],
    validation_recommendations: [],
    review_notes: [],
    confidence: 0.9
  });
  return writeJsonFile(workspace, `.agent_memory/patches/patch_${id}.json`, patchProposal);
}

function change(proposalId: string, file: string, changeType: PatchProposalChangeType, withinScope: boolean, diff?: string) {
  return createPatchProposalFileChange({
    proposal_id: proposalId,
    path: file,
    change_type: changeType,
    proposed_diff: diff,
    rationale: "Test change.",
    risk: "low",
    within_allowed_scope: withinScope
  });
}
