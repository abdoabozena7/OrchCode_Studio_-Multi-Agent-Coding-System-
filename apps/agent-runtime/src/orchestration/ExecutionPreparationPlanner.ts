import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { readJson, resolveMemoryPaths } from "../memory/ProjectMemory.js";
import type { CommandInventory } from "../memory/types.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { ContextPackBuilder } from "./ContextPackBuilder.js";
import { DurableLockManager } from "./DurableLockManager.js";
import type { FactoryLockScope } from "./FactoryLockModels.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { IntegrationManager } from "./IntegrationManager.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { AgentRoleName, ContextPack, Task } from "./OrchestrationModels.js";
import { ORCHESTRATION_SCHEMA_VERSION } from "./OrchestrationModels.js";
import type {
  ApprovalScope,
  ExecutionPromotionRequest,
  HumanApprovalRecord,
  PromotionQueueItem
} from "./ExecutionApprovalModels.js";
import { createApprovalScope, createPromotionQueueItem } from "./ExecutionApprovalModels.js";
import type { ExecutionReadinessDecision } from "./ExecutionReadinessModels.js";
import { renderRolePrompt } from "./PromptSystem.js";
import { evaluatePromptQuality, isPromptQualityBlocking } from "./PromptQualityGate.js";
import {
  createExecutionIntegrationPreview,
  createExecutionPreparationBatch,
  createExecutionPreparationBlocker,
  createExecutionPreparationPlan,
  createExecutionPreparationRequest,
  createExecutionPreparationResult,
  createExecutionPreparationSummary,
  createExecutionPreparationWarning,
  createExecutionReviewPolicy,
  createExecutionRollbackPreview,
  createExecutionValidationPlan,
  createWriterSlot,
  type ExecutionIntegrationPreview,
  type ExecutionPreparationBatch,
  type ExecutionPreparationBlocker,
  type ExecutionPreparationPlan,
  type ExecutionPreparationRequest,
  type ExecutionPreparationResult,
  type ExecutionPreparationSummary,
  type ExecutionPreparationWarning,
  type ExecutionReviewPolicy,
  type ExecutionRollbackPreview,
  type ExecutionValidationPlan
} from "./ExecutionPreparationModels.js";
import {
  evaluatePreparationInputPolicy,
  executionPreparationPolicyFromConfig,
  isWriteClassified,
  statusForBlockers,
  type ExecutionPreparationPolicy
} from "./ExecutionPreparationPolicy.js";
import type { ProposedTaskGraphNode } from "./ProposedTaskGraphModels.js";
import type { ReadOrWriteClassification } from "./TeamTaskAdoptionModels.js";

export type ExecutionPreparationPlannerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  lockManager?: DurableLockManager;
  contextBuilder?: Pick<ContextPackBuilder, "build">;
  integrationManager?: Pick<IntegrationManager, "previewExecutionPreparation">;
};

export type ExecutionPreparationPlanInput = {
  queueItem: PromotionQueueItem;
  request: ExecutionPromotionRequest;
  approval?: HumanApprovalRecord;
  readinessDecision: ExecutionReadinessDecision;
  proposedNode?: ProposedTaskGraphNode;
  policy?: ExecutionPreparationPolicy;
};

type LoadedInput = ExecutionPreparationPlanInput & {
  readinessDecisionExists: boolean;
  proposedNodeExists: boolean;
};

export class ExecutionPreparationPlanner {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly lockManager: DurableLockManager;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly contextBuilder: Pick<ContextPackBuilder, "build">;
  private readonly integrationManager: Pick<IntegrationManager, "previewExecutionPreparation">;

  constructor(private readonly options: ExecutionPreparationPlannerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ExecutionPreparationPlanner" });
    this.lockManager = options.lockManager ?? new DurableLockManager({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, ttlMs: options.config.lock_ttl_ms, ownerComponent: "ExecutionPreparationPlanner" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.contextBuilder = options.contextBuilder ?? new ContextPackBuilder(this.workspacePath, { memoryDir: this.memoryDir, maxChars: options.config.max_context_size, maxFiles: options.config.max_context_size > 12_000 ? 10 : 6 });
    this.integrationManager = options.integrationManager ?? new IntegrationManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: this.traceWriter,
      lockManager: this.lockManager,
      applyMode: "prepare_only",
      config: options.config
    });
  }

  async prepareApprovedQueueItem(queueItem: PromotionQueueItem): Promise<ExecutionPreparationResult> {
    const started = await this.traceWriter.write({
      run_id: queueItem.run_id,
      event_type: "execution_preparation_started",
      lifecycle_stage: "planning",
      summary: `Execution preparation started for queue item ${queueItem.queue_item_id}.`,
      metadata_json: { queue_item_id: queueItem.queue_item_id, no_execution: true }
    });
    await this.traceWriter.write({
      run_id: queueItem.run_id,
      event_type: "execution_preparation_queue_item_loaded",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: `Promotion queue item loaded: ${queueItem.queue_status}.`,
      artifact_refs: [queueItem.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { queue_item_id: queueItem.queue_item_id, queue_status: queueItem.queue_status }
    });
    const loaded = await this.loadInputForQueueItem(queueItem);
    if (!loaded.request || !loaded.readinessDecision) {
      const planId = `execution_preparation_plan_${randomUUID()}`;
      const blockers = [
        ...(!loaded.request ? [blocker(planId, "missing_promotion_request", "Promotion request is missing.", [queueItem.promotion_request_id])] : []),
        ...(!loaded.readinessDecision ? [blocker(planId, "missing_readiness_decision", "Readiness decision is missing.", [queueItem.proposed_node_id])] : [])
      ];
      return this.persistBlockedSkeleton(queueItem, loaded.request, blockers, started.trace_event_id);
    }
    const result = await this.buildExecutionPreparationPlan({
      queueItem,
      request: loaded.request,
      approval: loaded.approval,
      readinessDecision: loaded.readinessDecision,
      proposedNode: loaded.proposedNode,
      policy: executionPreparationPolicyFromConfig(this.options.config)
    }, loaded);
    return result;
  }

  async preparePromotionRequest(request: ExecutionPromotionRequest): Promise<ExecutionPreparationResult> {
    const queueItem = await this.loadQueueItemForRequest(request);
    if (queueItem) return this.prepareApprovedQueueItem(queueItem);
    const synthetic = createPromotionQueueItem({
      promotion_request_id: request.promotion_request_id,
      approval_id: undefined,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      queue_status: request.read_or_write_classification === "read_only" ? "queued" : "waiting_for_approval",
      promotion_type: request.requested_promotion_type,
      priority: 0,
      blockers: [],
      constraints: [],
      metadata_json: { synthetic_for_preparation: true, no_execution: true }
    });
    return this.prepareApprovedQueueItem(synthetic);
  }

  async prepareRunPromotionQueue(runId: string): Promise<ExecutionPreparationBatch> {
    const policy = executionPreparationPolicyFromConfig(this.options.config);
    const items = (await this.listQueueItems(runId)).slice(0, policy.max_preparation_plans_per_run);
    const request = createExecutionPreparationRequest({
      run_id: runId,
      queue_item_ids: items.map((item) => item.queue_item_id),
      requested_by: "ExecutionPreparationPlanner",
      mode: policy.mode,
      metadata_json: { no_execution: true, max_preparation_plans_per_run: policy.max_preparation_plans_per_run }
    });
    const results: ExecutionPreparationResult[] = [];
    for (const item of items) results.push(await this.prepareApprovedQueueItem(item));
    const plans = results.flatMap((result) => result.plan ? [result.plan] : []);
    const summary = this.summarizePreparationBatch(plans);
    const batch = createExecutionPreparationBatch({
      run_id: runId,
      request,
      plans,
      summary,
      metadata_json: {
        no_execution_started: true,
        no_scheduler_enqueue: true,
        no_locks_acquired: true,
        no_provider_writer_invoked: true
      }
    });
    const refs = await this.artifactStore.saveExecutionPreparationBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.preparation_summary_ref = refs.summaryRef;
    const trace = await this.traceWriter.write({
      run_id: runId,
      event_type: "execution_preparation_batch_completed",
      lifecycle_stage: "planning",
      summary: `Execution preparation batch completed for ${plans.length} plan(s).`,
      artifact_refs: [refs.batchRef, refs.summaryRef],
      metadata_json: {
        preparation_plan_count: summary.preparation_plan_count,
        prepared_count: summary.prepared_count,
        blocked_count: summary.blocked_count,
        no_execution: true
      }
    });
    batch.trace_event_id = trace.trace_event_id;
    await this.traceWriter.write({
      run_id: runId,
      event_type: "execution_preparation_summary_created",
      lifecycle_stage: "planning",
      causal_parent_event_id: trace.trace_event_id,
      summary: "Execution preparation summary created.",
      artifact_refs: [refs.summaryRef],
      metadata_json: { summary_id: summary.summary_id }
    });
    await this.metadata.recordExecutionPreparationBatchSaved(batch);
    return batch;
  }

  async buildExecutionPreparationPlan(input: ExecutionPreparationPlanInput, loaded: Partial<Pick<LoadedInput, "readinessDecisionExists" | "proposedNodeExists">> = {}): Promise<ExecutionPreparationResult> {
    const policy = input.policy ?? executionPreparationPolicyFromConfig(this.options.config);
    const planId = `execution_preparation_plan_${randomUUID()}`;
    const policyResult = evaluatePreparationInputPolicy({
      planId,
      queueItem: input.queueItem,
      request: input.request,
      approval: input.approval,
      readinessDecisionExists: loaded.readinessDecisionExists ?? true,
      proposedNodeExists: loaded.proposedNodeExists ?? Boolean(input.proposedNode),
      policy
    });
    const scope = input.approval?.approved_scope ?? input.request.requested_scope;
    const writeClassified = isWriteClassified(input.request.read_or_write_classification);
    const writerRole = writeClassified ? executorLikeRole(input.request.proposed_role) : input.request.proposed_role;
    const writerSlot = createWriterSlot({
      writer_slot_id: `writer_slot_${safeId(input.queueItem.queue_item_id)}`,
      run_id: input.request.run_id,
      queue_item_id: input.queueItem.queue_item_id,
      proposed_node_id: input.request.proposed_node_id,
      writer_role: writerRole,
      write_capable: writeClassified,
      metadata_json: {
        one_writer_policy: true,
        no_invocation: true,
        source_role: input.request.proposed_role
      }
    });
    const task = taskFromPreparation(input, scope, writerRole);
    const blockers = [...policyResult.blockers];
    const warnings: ExecutionPreparationWarning[] = [];

    const context = policyResult.allowed
      ? await this.prepareContext(input, task, blockers, warnings, policy, planId)
      : undefined;
    const locks = await this.prepareLocks(input, task, context?.pack, blockers, warnings, planId);
    const validationPlan = await this.createValidationPlan(input, blockers, planId);
    const reviewPolicy = await this.createReviewPolicy(input, blockers, planId);
    const integrationPreview = await this.createIntegrationPreview(input, validationPlan, reviewPolicy, blockers, planId);
    const rollbackPreview = this.createRollbackPreview(input);
    const prompt = policyResult.allowed && context?.ref
      ? await this.preparePrompt(input, task, context.pack, context.ref, blockers, warnings, policy, planId, writerRole)
      : undefined;

    if (writeClassified && validationPlan.status === "missing") {
      blockers.push(blocker(planId, "missing_validation", "Write preparation requires a validation plan.", input.request.required_validation_strategy));
    }
    if (writeClassified && !locks.file.length && !locks.module.length && !locks.semantic.length) {
      blockers.push(blocker(planId, "missing_locks", "Write preparation requires derivable lock scopes.", [input.request.proposed_node_id]));
    }
    if (writeClassified && reviewPolicy.status === "missing") {
      blockers.push(blocker(planId, "missing_review_policy", "Write preparation requires review policy.", [input.request.proposed_node_id]));
    }
    if (writeClassified && integrationPreview.status === "missing") {
      blockers.push(blocker(planId, "missing_integration_path", "Write preparation requires IntegrationManager preview path.", [input.request.proposed_node_id]));
    }
    if (!prompt?.promptId && policyResult.allowed && context?.ref) {
      blockers.push(blocker(planId, "missing_prompt", "Prepared writer prompt could not be rendered.", [input.request.required_prompt_template_ref ?? input.request.proposed_node_id]));
    }

    const status = statusForBlockers(blockers);
    const plan = createExecutionPreparationPlan({
      preparation_plan_id: planId,
      run_id: input.request.run_id,
      queue_item_id: input.queueItem.queue_item_id,
      promotion_request_id: input.request.promotion_request_id,
      approval_id: input.approval?.approval_id ?? input.queueItem.approval_id,
      proposed_node_id: input.request.proposed_node_id,
      team_id: input.request.team_id,
      adopted_task_id: input.request.adopted_task_id,
      status,
      intended_writer_slot: writerSlot,
      writer_role: writerRole,
      task_type: input.request.task_type,
      read_or_write_classification: input.request.read_or_write_classification,
      objective: task.objective,
      allowed_files: scope.allowed_files,
      forbidden_files: scope.forbidden_files,
      read_only_files: scope.read_only_files,
      required_file_locks: locks.file,
      required_module_locks: locks.module,
      required_semantic_locks: locks.semantic,
      context_pack_ref: context?.ref,
      context_freshness_summary: context?.freshnessSummary ?? { status: "missing" },
      prompt_id: prompt?.promptId,
      prompt_template_ref: prompt?.promptTemplateRef ?? input.request.required_prompt_template_ref,
      prompt_quality_result_ref: prompt?.promptQualityResultRef,
      prompt_writer_output_ref: prompt?.promptWriterOutputRef,
      validation_plan: validationPlan,
      review_policy: reviewPolicy,
      integration_preview: integrationPreview,
      rollback_preview: rollbackPreview,
      risk_level: input.request.risk_level,
      human_approval_ref: input.approval?.artifact_ref ?? input.approval?.approval_id,
      readiness_decision_ref: input.readinessDecision.artifact_ref ?? input.readinessDecision.decision_id,
      blockers,
      warnings,
      metadata_json: {
        no_execution_started: true,
        no_scheduler_enqueue: true,
        no_locks_acquired: true,
        no_validation_commands_run: true,
        no_provider_writer_invoked: true,
        no_patches_created: true,
        no_patches_applied: true,
        max_active_writers: 1,
        source_queue_status: input.queueItem.queue_status,
        readiness_status: input.request.readiness_status
      }
    });
    const persisted = await this.persistPlan(plan);
    await this.traceWriter.write({
      run_id: plan.run_id,
      team_id: plan.team_id,
      event_type: status === "prepared" ? "execution_preparation_completed" : "execution_preparation_blocked",
      lifecycle_stage: status === "prepared" ? "planning" : "blocked",
      severity: status === "prepared" ? "info" : "warning",
      reason: plan.blockers[0]?.reason,
      summary: `Execution preparation ${status} for ${plan.proposed_node_id}.`,
      artifact_refs: [persisted.artifact_ref, persisted.lock_plan_ref, persisted.validation_plan_ref, persisted.review_policy_ref, persisted.integration_preview_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        preparation_plan_id: plan.preparation_plan_id,
        queue_item_id: plan.queue_item_id,
        status,
        blocker_count: plan.blockers.length,
        warning_count: plan.warnings.length,
        no_execution: true
      }
    }).then((trace) => {
      plan.trace_event_id = trace.trace_event_id;
    });
    await this.metadata.recordExecutionPreparationPlanSaved(plan);
    return createExecutionPreparationResult({
      run_id: plan.run_id,
      queue_item_id: plan.queue_item_id,
      status: plan.status,
      plan,
      blockers: plan.blockers,
      warnings: plan.warnings,
      artifact_refs: [plan.artifact_ref, plan.lock_plan_ref, plan.validation_plan_ref, plan.review_policy_ref, plan.integration_preview_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_execution: true }
    });
  }

  validateExecutionPreparationPlan(plan: ExecutionPreparationPlan): ExecutionPreparationResult {
    const blockers = [...plan.blockers];
    if (isWriteClassified(plan.read_or_write_classification)) {
      if (!plan.intended_writer_slot || plan.intended_writer_slot.max_active_writers !== 1) {
        blockers.push(blocker(plan.preparation_plan_id, "unsafe_scope", "Write plan must have exactly one intended writer slot.", [plan.preparation_plan_id]));
      }
      if (!/executor|integrator|repair/i.test(plan.writer_role)) {
        blockers.push(blocker(plan.preparation_plan_id, "unsafe_scope", "Write plan writer role must be executor-like but not invoked.", [String(plan.writer_role)]));
      }
      if (!plan.validation_plan.required_commands.length && !plan.validation_plan.required_checks.length) {
        blockers.push(blocker(plan.preparation_plan_id, "missing_validation", "Write plan has no validation requirements.", [plan.validation_plan.validation_plan_id]));
      }
    }
    return createExecutionPreparationResult({
      run_id: plan.run_id,
      queue_item_id: plan.queue_item_id,
      status: statusForBlockers(blockers),
      plan: { ...plan, status: statusForBlockers(blockers), blockers },
      blockers,
      warnings: plan.warnings,
      artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { validation_only: true, no_execution: true }
    });
  }

  summarizePreparationBatch(plans: ExecutionPreparationPlan[]): ExecutionPreparationSummary {
    const runId = plans[0]?.run_id ?? "";
    return createExecutionPreparationSummary({
      run_id: runId,
      execution_preparation_used: plans.length > 0,
      preparation_plan_count: plans.length,
      prepared_count: plans.filter((plan) => plan.status === "prepared").length,
      blocked_count: plans.filter((plan) => plan.status !== "prepared" && plan.status !== "not_required").length,
      missing_approval_count: plans.filter((plan) => plan.status === "missing_approval").length,
      missing_context_count: plans.filter((plan) => plan.status === "missing_context").length,
      missing_prompt_count: plans.filter((plan) => plan.status === "missing_prompt").length,
      missing_validation_count: plans.filter((plan) => plan.status === "missing_validation").length,
      missing_locks_count: plans.filter((plan) => plan.status === "missing_locks").length,
      stale_context_count: plans.filter((plan) => plan.status === "stale_context" || plan.warnings.some((warning) => warning.warning_type === "stale_context")).length,
      cancelled_count: plans.filter((plan) => plan.status === "cancelled").length,
      metadata_json: {
        no_execution_started: true,
        no_scheduler_enqueue: true
      }
    });
  }

  async listPreparationPlansForRun(runId: string): Promise<Array<Record<string, unknown>>> {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all("SELECT * FROM factory_execution_preparation_plans WHERE run_id = ? ORDER BY created_at", runId);
    } finally {
      store.close();
    }
  }

  private async loadInputForQueueItem(queueItem: PromotionQueueItem): Promise<Partial<LoadedInput>> {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return { queueItem };
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const requestRow = store.get<Record<string, unknown>>("SELECT * FROM factory_execution_promotion_requests WHERE promotion_request_id = ?", queueItem.promotion_request_id);
      const approvalRow = queueItem.approval_id ? store.get<Record<string, unknown>>("SELECT * FROM factory_human_approval_records WHERE approval_id = ?", queueItem.approval_id) : undefined;
      const decisionRow = requestRow ? store.get<Record<string, unknown>>("SELECT * FROM factory_execution_readiness_decisions WHERE decision_id = ?", String(requestRow.readiness_decision_id)) : undefined;
      const nodeRow = store.get<Record<string, unknown>>("SELECT * FROM factory_proposed_task_nodes WHERE proposed_node_id = ?", queueItem.proposed_node_id);
      return {
        queueItem,
        request: requestRow ? promotionRequestFromRow(requestRow) : undefined,
        approval: approvalRow ? approvalFromRow(approvalRow) : undefined,
        readinessDecision: decisionRow ? readinessDecisionFromRow(decisionRow) : undefined,
        proposedNode: nodeRow ? proposedNodeFromRow(nodeRow) : undefined,
        readinessDecisionExists: Boolean(decisionRow),
        proposedNodeExists: Boolean(nodeRow)
      };
    } finally {
      store.close();
    }
  }

  private async loadQueueItemForRequest(request: ExecutionPromotionRequest) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>(
        "SELECT * FROM factory_promotion_queue_items WHERE promotion_request_id = ? ORDER BY created_at DESC LIMIT 1",
        request.promotion_request_id
      );
      return row ? queueItemFromRow(row) : undefined;
    } finally {
      store.close();
    }
  }

  private async listQueueItems(runId: string) {
    if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all<Record<string, unknown>>(
        "SELECT * FROM factory_promotion_queue_items WHERE run_id = ? ORDER BY priority DESC, created_at",
        runId
      ).map(queueItemFromRow);
    } finally {
      store.close();
    }
  }

  private async prepareContext(
    input: ExecutionPreparationPlanInput,
    task: Task,
    blockers: ExecutionPreparationBlocker[],
    warnings: ExecutionPreparationWarning[],
    policy: ExecutionPreparationPolicy,
    planId: string
  ): Promise<{ ref: string; pack: ContextPack; freshnessSummary: Record<string, unknown> } | undefined> {
    try {
      const pack = await this.contextBuilder.build(input.request.run_id, task, { team_id: input.request.team_id });
      const ref = await this.artifactStore.saveContextPack(pack);
      const freshnessSummary = {
        status: pack.freshness_warnings?.length ? "warning" : "current",
        warning_count: pack.warnings.length + (pack.freshness_warnings?.length ?? 0),
        stale_or_unknown_count: pack.retrieval_summary?.stale_or_unknown_count ?? 0,
        low_confidence_count: pack.retrieval_summary?.low_confidence_count ?? 0,
        approximate_size: pack.approximate_size,
        team_context_used: Boolean(pack.team_context),
        full_repo_dump: false
      };
      if ((pack.retrieval_summary?.stale_or_unknown_count ?? 0) > 0 || pack.freshness_warnings?.length) {
        const warning = createExecutionPreparationWarning({
          preparation_plan_id: planId,
          warning_type: "stale_context",
          severity: "warning",
          message: "Context pack includes stale or unknown freshness items.",
          refs: [ref]
        });
        warnings.push(warning);
        if (policy.block_on_stale_context) {
          blockers.push(blocker(planId, "stale_context", "Stale context blocks execution preparation by policy.", [ref]));
        }
      }
      await this.traceWriter.write({
        run_id: input.request.run_id,
        team_id: input.request.team_id,
        event_type: "execution_preparation_context_prepared",
        lifecycle_stage: "planning",
        severity: blockers.some((entry) => entry.blocker_type === "stale_context") ? "warning" : "info",
        summary: `Execution preparation context prepared for ${input.request.proposed_node_id}.`,
        artifact_refs: [ref],
        metadata_json: freshnessSummary
      });
      return { ref, pack, freshnessSummary };
    } catch (error) {
      blockers.push(blocker(planId, "missing_context", error instanceof Error ? error.message : String(error), [input.request.proposed_node_id]));
      return undefined;
    }
  }

  private async preparePrompt(
    input: ExecutionPreparationPlanInput,
    task: Task,
    contextPack: ContextPack | undefined,
    contextPackRef: string,
    blockers: ExecutionPreparationBlocker[],
    warnings: ExecutionPreparationWarning[],
    policy: ExecutionPreparationPolicy,
    planId: string,
    writerRole: AgentRoleName | string
  ) {
    const adoptedPromptWriterRef = typeof input.request.metadata_json.prompt_writer_output_ref === "string" && input.request.metadata_json.prompt_writer_adoption === "gated_adopt"
      ? input.request.metadata_json.prompt_writer_output_ref
      : undefined;
    const render = renderRolePrompt({
      run_id: input.request.run_id,
      task_id: input.request.proposed_node_id,
      agent_role: writerRole,
      task_title: task.title,
      task_objective: task.objective,
      context_pack_ref: contextPackRef,
      allowed_files: task.allowed_files_to_edit,
      forbidden_files: task.forbidden_files,
      relevant_files: task.relevant_files,
      validation_requirements: task.validation_commands,
      expected_output_schema: task.expected_output_schema,
      output_schema_name: task.expected_output_schema,
      source_component: "ExecutionPreparationPlanner",
      metadata_json: {
        preparation_only: true,
        no_invocation: true,
        queue_item_id: input.queueItem.queue_item_id,
        team_id: input.request.team_id,
        approval_id: input.approval?.approval_id,
        readiness_decision_id: input.request.readiness_decision_id,
        prompt_writer_output_ref: adoptedPromptWriterRef
      }
    });
    if (!render.ok) {
      blockers.push(blocker(planId, "missing_prompt", render.error.message, [input.request.required_prompt_template_ref ?? input.request.proposed_node_id]));
      return undefined;
    }
    const metadata = await this.artifactStore.savePromptArtifact(render.rendered);
    await this.traceWriter.write({
      run_id: input.request.run_id,
      team_id: input.request.team_id,
      event_type: "execution_preparation_prompt_prepared",
      lifecycle_stage: "planning",
      summary: `Execution preparation prompt prepared for ${input.request.proposed_node_id}.`,
      artifact_refs: [metadata.artifact_ref, contextPackRef],
      metadata_json: {
        prompt_id: render.rendered.prompt_id,
        template_id: render.rendered.template_id,
        no_invocation: true,
        prompt_writer_output_ref: adoptedPromptWriterRef
      }
    });
    const quality = evaluatePromptQuality(render.rendered, {
      contextPack,
      contextPackRef,
      promptMetadata: metadata,
      promptArtifactRef: metadata.artifact_ref,
      allowedFiles: task.allowed_files_to_edit,
      forbiddenFiles: task.forbidden_files,
      validationRequirements: task.validation_commands,
      successCriteria: input.request.required_success_criteria,
      stopConditions: ["Stop if scope, locks, approval, validation, review, or IntegrationManager requirements are missing."],
      expectedOutputSchema: task.expected_output_schema
    });
    const qualityRef = await this.artifactStore.savePromptQualityResult(quality);
    const promptWarning = quality.status === "warning";
    if (promptWarning) {
      warnings.push(createExecutionPreparationWarning({
        preparation_plan_id: planId,
        warning_type: "prompt_quality_warning",
        severity: "warning",
        message: "Prompt quality gate returned warning.",
        refs: [qualityRef]
      }));
    }
    if (isPromptQualityBlocking(quality) || (promptWarning && isWriteClassified(input.request.read_or_write_classification) && policy.block_on_prompt_quality_warning_for_write)) {
      blockers.push(blocker(planId, "prompt_quality_blocked", `Prompt quality gate returned ${quality.status}.`, [qualityRef]));
      await this.traceWriter.write({
        run_id: input.request.run_id,
        team_id: input.request.team_id,
        event_type: "execution_preparation_prompt_quality_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: `Execution preparation prompt quality blocked: ${quality.status}.`,
        artifact_refs: [qualityRef],
        metadata_json: { prompt_id: render.rendered.prompt_id, status: quality.status }
      });
    } else {
      await this.traceWriter.write({
        run_id: input.request.run_id,
        team_id: input.request.team_id,
        event_type: "execution_preparation_prompt_quality_passed",
        lifecycle_stage: "planning",
        severity: promptWarning ? "warning" : "info",
        summary: `Execution preparation prompt quality ${quality.status}.`,
        artifact_refs: [qualityRef],
        metadata_json: { prompt_id: render.rendered.prompt_id, status: quality.status }
      });
    }
    return {
      promptId: render.rendered.prompt_id,
      promptTemplateRef: `${render.rendered.template_id}@${render.rendered.template_version}`,
      promptQualityResultRef: qualityRef,
      promptWriterOutputRef: adoptedPromptWriterRef
    };
  }

  private async prepareLocks(
    input: ExecutionPreparationPlanInput,
    task: Task,
    contextPack: ContextPack | undefined,
    blockers: ExecutionPreparationBlocker[],
    warnings: ExecutionPreparationWarning[],
    planId: string
  ) {
    const writeClassified = isWriteClassified(input.request.read_or_write_classification);
    const fileScopes = writeClassified ? task.allowed_files_to_edit.map((file) => this.lockManager.normalizeLockScope(file, "write")) : [];
    const moduleScopes = writeClassified ? this.lockManager.deriveModuleLocksForTask(task, contextPack, "write") : [];
    const semanticScopes = writeClassified ? this.lockManager.deriveSemanticLocksForTask(task, contextPack, "write") : [];
    const requested = [...fileScopes, ...moduleScopes, ...semanticScopes];
    const conflicts = requested.length ? await this.lockManager.findConflicts(requested) : [];
    const existingPrepConflicts = await this.findExistingPreparationConflicts(input.request.run_id, requested);
    if (conflicts.some((conflict) => conflict.blocking) || existingPrepConflicts.length) {
      warnings.push(createExecutionPreparationWarning({
        preparation_plan_id: planId,
        warning_type: "existing_preparation_conflict",
        severity: "warning",
        message: "Potential lock conflict detected in analysis-only mode.",
        refs: [...conflicts.map((conflict) => conflict.existing_lock.lock_id), ...existingPrepConflicts]
      }));
      if (conflicts.some((conflict) => conflict.blocking)) {
        blockers.push(blocker(planId, "lock_conflict", "Potential durable lock conflict detected; locks were not acquired.", conflicts.map((conflict) => conflict.existing_lock.lock_id)));
      }
    }
    await this.traceWriter.write({
      run_id: input.request.run_id,
      team_id: input.request.team_id,
      event_type: "execution_preparation_locks_derived",
      lifecycle_stage: "planning",
      severity: conflicts.length || existingPrepConflicts.length ? "warning" : "info",
      summary: `Execution preparation derived ${requested.length} lock scope(s).`,
      metadata_json: {
        file_locks: fileScopes.map((scope) => scope.normalized_scope_key),
        module_locks: moduleScopes.map((scope) => scope.normalized_scope_key),
        semantic_locks: semanticScopes.map((scope) => scope.normalized_scope_key),
        conflict_count: conflicts.length + existingPrepConflicts.length,
        acquired: false
      }
    });
    return {
      file: fileScopes.map((scope) => scope.normalized_scope_key),
      module: moduleScopes.map((scope) => scope.normalized_scope_key),
      semantic: semanticScopes.map((scope) => scope.normalized_scope_key),
      conflicts
    };
  }

  private async createValidationPlan(input: ExecutionPreparationPlanInput, blockers: ExecutionPreparationBlocker[], planId: string): Promise<ExecutionValidationPlan> {
    const inventory = await this.loadCommandInventory();
    const commands = uniqueStrings(input.request.required_validation_strategy.filter((entry) => looksLikeCommand(entry)));
    const checks = uniqueStrings(input.request.required_validation_strategy.filter((entry) => !looksLikeCommand(entry)));
    const writeClassified = isWriteClassified(input.request.read_or_write_classification);
    const plan = createExecutionValidationPlan({
      status: !commands.length && !checks.length ? writeClassified ? "missing" : "not_required" : "planned",
      required_commands: commands,
      required_checks: checks,
      command_inventory_refs: inventory ? ["command_inventory.json"] : [],
      strict_validation_required: writeClassified,
      metadata_json: {
        command_inventory_available: Boolean(inventory),
        command_inventory_matches: inventory ? commands.filter((command) => inventory.commands.some((entry) => entry.command === command)) : [],
        no_validation_commands_run: true
      }
    });
    if (writeClassified && plan.status === "missing") {
      blockers.push(blocker(planId, "missing_validation", "Write preparation has no validation strategy.", [input.request.proposed_node_id]));
    }
    await this.traceWriter.write({
      run_id: input.request.run_id,
      team_id: input.request.team_id,
      event_type: "execution_preparation_validation_plan_created",
      lifecycle_stage: "planning",
      severity: plan.status === "missing" ? "warning" : "info",
      summary: `Execution preparation validation plan ${plan.status}.`,
      metadata_json: {
        validation_plan_id: plan.validation_plan_id,
        required_command_count: plan.required_commands.length,
        required_check_count: plan.required_checks.length,
        no_commands_run: true
      }
    });
    return plan;
  }

  private async createReviewPolicy(input: ExecutionPreparationPlanInput, blockers: ExecutionPreparationBlocker[], planId: string): Promise<ExecutionReviewPolicy> {
    const writeClassified = isWriteClassified(input.request.read_or_write_classification);
    const specialist = writeClassified ? specialistReviews(input.request.risk_level, [...input.request.requested_scope.allowed_files, ...input.request.requested_scope.read_only_files]) : [];
    const required = writeClassified ? uniqueStrings(["basic_review", ...input.request.required_review_policy]) : [];
    const policy = createExecutionReviewPolicy({
      status: writeClassified && !required.length ? "missing" : writeClassified ? "planned" : "not_required",
      required_reviews: required,
      specialist_reviews: specialist,
      validation_review_required: writeClassified && input.request.required_validation_strategy.length > 0,
      integration_review_required: writeClassified,
      metadata_json: { risk_level: input.request.risk_level }
    });
    if (writeClassified && policy.status === "missing") {
      blockers.push(blocker(planId, "missing_review_policy", "Review policy is missing.", [input.request.proposed_node_id]));
    }
    await this.traceWriter.write({
      run_id: input.request.run_id,
      team_id: input.request.team_id,
      event_type: "execution_preparation_review_policy_created",
      lifecycle_stage: "planning",
      severity: policy.status === "missing" ? "warning" : "info",
      summary: `Execution preparation review policy ${policy.status}.`,
      metadata_json: {
        review_policy_id: policy.review_policy_id,
        required_reviews: policy.required_reviews,
        specialist_reviews: policy.specialist_reviews
      }
    });
    return policy;
  }

  private async createIntegrationPreview(
    input: ExecutionPreparationPlanInput,
    validationPlan: ExecutionValidationPlan,
    reviewPolicy: ExecutionReviewPolicy,
    blockers: ExecutionPreparationBlocker[],
    planId: string
  ): Promise<ExecutionIntegrationPreview> {
    const preview = await this.integrationManager.previewExecutionPreparation({
      runId: input.request.run_id,
      taskId: input.request.proposed_node_id,
      changedFiles: input.request.requested_scope.allowed_files,
      validationCommands: validationPlan.required_commands,
      requiredReviews: reviewPolicy.required_reviews,
      writeClassified: isWriteClassified(input.request.read_or_write_classification)
    });
    if (preview.status === "missing" && isWriteClassified(input.request.read_or_write_classification)) {
      blockers.push(blocker(planId, "missing_integration_path", "Integration preview path is missing.", [input.request.proposed_node_id]));
    }
    await this.traceWriter.write({
      run_id: input.request.run_id,
      team_id: input.request.team_id,
      event_type: "execution_preparation_integration_preview_created",
      lifecycle_stage: "planning",
      severity: preview.status === "missing" ? "warning" : "info",
      summary: `Execution preparation integration preview ${preview.status}.`,
      metadata_json: {
        integration_preview_id: preview.integration_preview_id,
        no_candidate_created: preview.no_candidate_created,
        no_apply_called: preview.no_apply_called
      }
    });
    return preview;
  }

  private createRollbackPreview(input: ExecutionPreparationPlanInput): ExecutionRollbackPreview {
    return createExecutionRollbackPreview({
      status: isWriteClassified(input.request.read_or_write_classification) ? "manual_limited" : "not_required",
      rollback_available: false,
      limitations: isWriteClassified(input.request.read_or_write_classification)
        ? ["Rollback is preview-only and manual/limited until a future one-writer executor creates an integration candidate."]
        : [],
      refs: [],
      metadata_json: { no_apply_called: true }
    });
  }

  private async persistPlan(plan: ExecutionPreparationPlan) {
    const refs = await this.artifactStore.saveExecutionPreparationPlan(plan);
    plan.artifact_ref = refs.planRef;
    plan.lock_plan_ref = refs.lockPlanRef;
    plan.validation_plan_ref = refs.validationPlanRef;
    plan.review_policy_ref = refs.reviewPolicyRef;
    plan.integration_preview_ref = refs.integrationPreviewRef;
    plan.rollback_preview_ref = refs.rollbackPreviewRef;
    for (const blockerEntry of plan.blockers) blockerEntry.preparation_plan_id = plan.preparation_plan_id;
    for (const warningEntry of plan.warnings) warningEntry.preparation_plan_id = plan.preparation_plan_id;
    return plan;
  }

  private async persistBlockedSkeleton(queueItem: PromotionQueueItem, request: ExecutionPromotionRequest | undefined, blockers: ExecutionPreparationBlocker[], parentTraceId: string) {
    const planId = blockers[0]?.preparation_plan_id ?? `execution_preparation_plan_${randomUUID()}`;
    const scope = request?.requested_scope ?? createApprovalScope();
    const validationPlan = createExecutionValidationPlan({ status: "missing", required_commands: [], required_checks: [], command_inventory_refs: [], strict_validation_required: true });
    const reviewPolicy = createExecutionReviewPolicy({ status: "missing", required_reviews: [], specialist_reviews: [], validation_review_required: false, integration_review_required: false });
    const integrationPreview = createExecutionIntegrationPreview({ status: "missing", integration_manager_required: true, expected_candidate_requirements: [], required_post_integration_validation: [], changed_files_preview: [], limitations: ["Required input was missing."] });
    const plan = createExecutionPreparationPlan({
      preparation_plan_id: planId,
      run_id: queueItem.run_id,
      queue_item_id: queueItem.queue_item_id,
      promotion_request_id: queueItem.promotion_request_id,
      approval_id: queueItem.approval_id,
      proposed_node_id: queueItem.proposed_node_id,
      status: statusForBlockers(blockers),
      intended_writer_slot: createWriterSlot({ run_id: queueItem.run_id, queue_item_id: queueItem.queue_item_id, proposed_node_id: queueItem.proposed_node_id, writer_role: "ExecutorAgent", write_capable: true }),
      writer_role: "ExecutorAgent",
      task_type: request?.task_type ?? "unknown",
      read_or_write_classification: request?.read_or_write_classification ?? "unknown",
      objective: request?.metadata_json.objective ? String(request.metadata_json.objective) : queueItem.proposed_node_id,
      allowed_files: scope.allowed_files,
      forbidden_files: scope.forbidden_files,
      read_only_files: scope.read_only_files,
      required_file_locks: [],
      required_module_locks: [],
      required_semantic_locks: [],
      context_freshness_summary: { status: "missing" },
      validation_plan: validationPlan,
      review_policy: reviewPolicy,
      integration_preview: integrationPreview,
      rollback_preview: createExecutionRollbackPreview({ status: "missing", rollback_available: false, limitations: ["Required input was missing."], refs: [] }),
      risk_level: request?.risk_level ?? "medium",
      readiness_decision_ref: request?.readiness_decision_id,
      blockers,
      warnings: [],
      metadata_json: { no_execution: true, blocked_skeleton: true }
    });
    await this.persistPlan(plan);
    await this.traceWriter.write({
      run_id: queueItem.run_id,
      event_type: "execution_preparation_blocked",
      lifecycle_stage: "blocked",
      severity: "warning",
      causal_parent_event_id: parentTraceId,
      summary: `Execution preparation blocked for ${queueItem.queue_item_id}.`,
      reason: blockers[0]?.reason,
      artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { preparation_plan_id: plan.preparation_plan_id, blocker_count: blockers.length }
    });
    await this.metadata.recordExecutionPreparationPlanSaved(plan);
    return createExecutionPreparationResult({
      run_id: queueItem.run_id,
      queue_item_id: queueItem.queue_item_id,
      status: plan.status,
      plan,
      blockers,
      warnings: [],
      artifact_refs: [plan.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { no_execution: true }
    });
  }

  private async findExistingPreparationConflicts(runId: string, requestedScopes: FactoryLockScope[]) {
    if (!requestedScopes.length || !existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return [];
    const requested = new Set(requestedScopes.map((scope) => scope.normalized_scope_key));
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all<Record<string, unknown>>(
        "SELECT preparation_plan_id, required_file_locks_json, required_module_locks_json, required_semantic_locks_json FROM factory_execution_preparation_plans WHERE run_id = ? AND status = 'prepared'",
        runId
      ).filter((row) => [
        ...parseStringArray(row.required_file_locks_json),
        ...parseStringArray(row.required_module_locks_json),
        ...parseStringArray(row.required_semantic_locks_json)
      ].some((scope) => requested.has(scope))).map((row) => String(row.preparation_plan_id));
    } finally {
      store.close();
    }
  }

  private async loadCommandInventory(): Promise<CommandInventory | undefined> {
    const paths = resolveMemoryPaths(this.workspacePath, this.memoryDir);
    if (!existsSync(paths.commandInventory)) return undefined;
    try {
      return await readJson<CommandInventory>(paths.commandInventory);
    } catch {
      return undefined;
    }
  }
}

function taskFromPreparation(input: ExecutionPreparationPlanInput, scope: ApprovalScope, writerRole: AgentRoleName | string): Task {
  const now = new Date().toISOString();
  const node = input.proposedNode;
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: input.request.proposed_node_id,
    run_id: input.request.run_id,
    title: node?.title ?? String(input.request.metadata_json.title ?? input.request.task_type),
    objective: node?.objective ?? String(input.request.metadata_json.objective ?? input.request.task_type),
    role_required: writerRole as AgentRoleName,
    status: "pending",
    dependencies: node?.dependencies ?? [],
    relevant_files: uniqueStrings([...scope.read_only_files, ...input.request.required_context_refs]),
    allowed_files_to_edit: scope.allowed_files,
    forbidden_files: scope.forbidden_files,
    input_context: undefined,
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: uniqueStrings(input.request.required_validation_strategy.filter(looksLikeCommand)),
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function blocker(planId: string, blocker_type: ExecutionPreparationBlocker["blocker_type"], reason: string, refs: string[] = []) {
  return createExecutionPreparationBlocker({
    preparation_plan_id: planId,
    blocker_type,
    severity: "blocking",
    reason,
    refs
  });
}

function executorLikeRole(role: string): AgentRoleName | string {
  return /executor|integrator|repair/i.test(role) ? role : "ExecutorAgent";
}

function specialistReviews(risk: string, files: string[]) {
  const reviews = new Set<string>();
  if (risk === "high" || risk === "critical") reviews.add("risk_specialist_review");
  if (files.some((file) => /security|auth|token|secret|permission/i.test(file))) reviews.add("security_review");
  if (files.some((file) => /api|protocol|schema|\.d\.ts$/i.test(file))) reviews.add("api_contract_review");
  if (files.some((file) => /schema|migration|\.sql$/i.test(file))) reviews.add("schema_review");
  if (files.some((file) => /package\.json|package-lock\.json|cargo\.toml|cargo\.lock/i.test(file))) reviews.add("dependency_review");
  if (files.some((file) => /config|tsconfig|vite|tauri/i.test(file))) reviews.add("config_review");
  return [...reviews].sort();
}

function looksLikeCommand(value: string) {
  return /\bnpm\b|\bpnpm\b|\byarn\b|\bnode\b|\btsc\b|\bcargo\b|\bgit diff --check\b|\btest\b|\bbuild\b|\blint\b|^npx\s/i.test(value);
}

function promotionRequestFromRow(row: Record<string, unknown>): ExecutionPromotionRequest {
  return {
    promotion_request_id: String(row.promotion_request_id),
    run_id: String(row.run_id),
    proposed_node_id: String(row.proposed_node_id),
    readiness_decision_id: String(row.readiness_decision_id),
    team_id: stringOrUndefined(row.team_id),
    adopted_task_id: stringOrUndefined(row.adopted_task_id),
    task_type: String(row.task_type),
    read_or_write_classification: String(row.read_or_write_classification) as ReadOrWriteClassification,
    proposed_role: String(row.proposed_role),
    requested_promotion_type: String(row.requested_promotion_type) as ExecutionPromotionRequest["requested_promotion_type"],
    readiness_status: String(row.readiness_status) as ExecutionPromotionRequest["readiness_status"],
    risk_level: String(row.risk_level) as ExecutionPromotionRequest["risk_level"],
    approval_required: Number(row.approval_required) === 1,
    approval_reason: stringOrUndefined(row.approval_reason),
    requested_scope: approvalScopeFromJson(row.requested_scope_json),
    required_locks: parseStringArray(row.required_locks_json),
    required_context_refs: parseStringArray(row.required_context_refs_json),
    required_prompt_template_ref: stringOrUndefined(row.required_prompt_template_ref),
    required_validation_strategy: parseStringArray(row.required_validation_strategy_json),
    required_success_criteria: parseStringArray(row.required_success_criteria_json),
    required_review_policy: parseStringArray(row.required_review_policy_json),
    status: String(row.status) as ExecutionPromotionRequest["status"],
    artifact_ref: stringOrUndefined(row.artifact_ref),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseRecord(row.metadata_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function approvalFromRow(row: Record<string, unknown>): HumanApprovalRecord {
  return {
    approval_id: String(row.approval_id),
    promotion_request_id: String(row.promotion_request_id),
    run_id: String(row.run_id),
    proposed_node_id: String(row.proposed_node_id),
    approver_type: String(row.approver_type) as HumanApprovalRecord["approver_type"],
    approver_id: stringOrUndefined(row.approver_id),
    decision: String(row.decision) as HumanApprovalRecord["decision"],
    approval_status: String(row.approval_status) as HumanApprovalRecord["approval_status"],
    decision_reason: String(row.decision_reason),
    approved_scope: approvalScopeFromJson(row.approved_scope_json),
    constraints: parseArray(row.constraints_json) as HumanApprovalRecord["constraints"],
    expires_at: stringOrUndefined(row.expires_at),
    artifact_ref: stringOrUndefined(row.artifact_ref),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseRecord(row.metadata_json),
    created_at: String(row.created_at)
  };
}

function readinessDecisionFromRow(row: Record<string, unknown>): ExecutionReadinessDecision {
  return {
    decision_id: String(row.decision_id),
    run_id: String(row.run_id),
    proposed_node_id: String(row.proposed_node_id),
    team_id: stringOrUndefined(row.team_id),
    adopted_task_id: stringOrUndefined(row.adopted_task_id),
    task_type: String(row.task_type),
    read_or_write_classification: String(row.read_or_write_classification) as ReadOrWriteClassification,
    proposed_role: String(row.proposed_role),
    readiness_status: String(row.readiness_status) as ExecutionReadinessDecision["readiness_status"],
    approval_status: String(row.approval_status) as ExecutionReadinessDecision["approval_status"],
    requirements_checked: [],
    passed_requirements: parseStringArray(row.passed_requirements_json),
    failed_requirements: parseStringArray(row.failed_requirements_json),
    blockers: [],
    warnings: [],
    required_locks: parseStringArray(row.required_locks_json),
    required_context_refs: parseStringArray(row.required_context_refs_json),
    required_prompt_template_ref: stringOrUndefined(row.required_prompt_template_ref),
    required_validation_strategy: parseStringArray(row.required_validation_strategy_json),
    required_success_criteria: parseStringArray(row.required_success_criteria_json),
    required_review_policy: parseStringArray(row.required_review_policy_json),
    risk_level: String(row.risk_level) as ExecutionReadinessDecision["risk_level"],
    confidence: Number(row.confidence ?? 0),
    artifact_ref: stringOrUndefined(row.artifact_ref),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseRecord(row.metadata_json),
    created_at: String(row.created_at)
  };
}

function proposedNodeFromRow(row: Record<string, unknown>): ProposedTaskGraphNode {
  return {
    proposed_node_id: String(row.proposed_node_id),
    run_id: String(row.run_id),
    team_id: stringOrUndefined(row.team_id),
    sub_plan_id: stringOrUndefined(row.sub_plan_id),
    adopted_task_id: stringOrUndefined(row.adopted_task_id),
    source_task_draft_id: stringOrUndefined(row.source_task_draft_id),
    parent_proposed_node_id: stringOrUndefined(row.parent_proposed_node_id),
    title: String(row.title),
    objective: String(row.objective),
    task_type: String(row.task_type),
    read_or_write_classification: String(row.read_or_write_classification) as ReadOrWriteClassification,
    proposed_role: String(row.proposed_role),
    status: String(row.status) as ProposedTaskGraphNode["status"],
    readiness_status: String(row.readiness_status) as ProposedTaskGraphNode["readiness_status"],
    adoption_status: String(row.adoption_status) as ProposedTaskGraphNode["adoption_status"],
    allowed_files: parseStringArray(row.allowed_files_json),
    forbidden_files: parseStringArray(row.forbidden_files_json),
    read_only_files: parseStringArray(row.read_only_files_json),
    module_locks: parseStringArray(row.module_locks_json),
    semantic_locks: parseStringArray(row.semantic_locks_json),
    dependencies: parseStringArray(row.dependencies_json),
    success_criteria: [],
    stop_conditions: [],
    evidence_refs: parseStringArray(row.evidence_refs_json),
    risk_level: String(row.risk_level) as ProposedTaskGraphNode["risk_level"],
    non_executable_reason: String(row.non_executable_reason),
    source_refs: [],
    artifact_ref: stringOrUndefined(row.artifact_ref),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseRecord(row.metadata_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function queueItemFromRow(row: Record<string, unknown>): PromotionQueueItem {
  return {
    queue_item_id: String(row.queue_item_id),
    promotion_request_id: String(row.promotion_request_id),
    approval_id: stringOrUndefined(row.approval_id),
    run_id: String(row.run_id),
    proposed_node_id: String(row.proposed_node_id),
    queue_status: String(row.queue_status) as PromotionQueueItem["queue_status"],
    promotion_type: String(row.promotion_type) as PromotionQueueItem["promotion_type"],
    priority: Number(row.priority ?? 0),
    blockers: parseStringArray(row.blockers_json),
    constraints: parseArray(row.constraints_json) as PromotionQueueItem["constraints"],
    artifact_ref: stringOrUndefined(row.artifact_ref),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseRecord(row.metadata_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function approvalScopeFromJson(value: unknown): ApprovalScope {
  const record = parseRecord(value);
  return createApprovalScope({
    allowed_files: stringArray(record.allowed_files),
    forbidden_files: stringArray(record.forbidden_files),
    read_only_files: stringArray(record.read_only_files),
    required_locks: stringArray(record.required_locks),
    required_context_refs: stringArray(record.required_context_refs),
    required_prompt_template_ref: stringOrUndefined(record.required_prompt_template_ref),
    required_validation_strategy: stringArray(record.required_validation_strategy),
    required_success_criteria: stringArray(record.required_success_criteria),
    required_review_policy: stringArray(record.required_review_policy),
    metadata_json: parseRecord(record.metadata_json)
  });
}

function parseStringArray(value: unknown) {
  return stringArray(parseArray(value));
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function safeId(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160);
}
