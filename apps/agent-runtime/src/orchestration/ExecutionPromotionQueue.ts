import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import {
  createApprovalConstraint,
  createPromotionQueueItem,
  createPromotionQueueSummary,
  type ExecutionPromotionRequest,
  type HumanApprovalRecord,
  type PromotionQueueItem,
  type PromotionQueueSummary
} from "./ExecutionApprovalModels.js";
import { executionPromotionPolicyFromConfig, evaluatePromotionRequestPolicy } from "./ExecutionPromotionPolicy.js";

export type ExecutionPromotionQueueOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export class ExecutionPromotionQueue {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly options: ExecutionPromotionQueueOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ExecutionPromotionQueue" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async enqueueApprovedPromotion(request: ExecutionPromotionRequest, approval: HumanApprovalRecord): Promise<PromotionQueueItem> {
    const policyResult = evaluatePromotionRequestPolicy(request, executionPromotionPolicyFromConfig(this.options.config));
    const valid = approval.approval_status === "approved" && approval.decision === "approved" && policyResult.allowed;
    const item = createPromotionQueueItem({
      promotion_request_id: request.promotion_request_id,
      approval_id: approval.approval_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      queue_status: valid ? "ready_for_future_execution_gate" : "blocked",
      promotion_type: request.requested_promotion_type,
      priority: priorityFor(request),
      blockers: valid ? [] : [...policyResult.blockers, approval.decision !== "approved" ? `approval_${approval.decision}` : ""].filter(Boolean),
      constraints: approval.constraints,
      metadata_json: {
        non_executing_queue: true,
        no_scheduler_enqueue: true,
        no_executor_task_created: true,
        no_locks_acquired: true
      }
    });
    return this.persistQueueItem(item, valid ? "promotion_queue_item_created" : "promotion_queue_item_blocked");
  }

  async enqueueReadOnlyPromotionCandidate(request: ExecutionPromotionRequest, approval?: HumanApprovalRecord): Promise<PromotionQueueItem> {
    const policy = executionPromotionPolicyFromConfig(this.options.config);
    const policyResult = evaluatePromotionRequestPolicy(request, policy);
    const allowed = request.read_or_write_classification === "read_only" && policy.allow_read_only_queue_without_human_approval && policy.mode === "queue_candidates" && policyResult.allowed;
    const item = createPromotionQueueItem({
      promotion_request_id: request.promotion_request_id,
      approval_id: approval?.approval_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      queue_status: allowed ? "queued" : request.approval_required ? "waiting_for_approval" : "blocked",
      promotion_type: request.requested_promotion_type,
      priority: priorityFor(request),
      blockers: allowed ? [] : policyResult.blockers.length ? policyResult.blockers : ["read_only_queue_not_allowed_by_policy"],
      constraints: approval?.constraints ?? [
        createApprovalConstraint({
          constraint_type: "provider_write_workers_disallowed",
          description: "Read-only queue candidate cannot enable provider-backed write workers.",
          refs: [request.proposed_node_id],
          status: "satisfied"
        })
      ],
      metadata_json: {
        non_executing_queue: true,
        no_scheduler_enqueue: true,
        no_executor_task_created: true,
        no_locks_acquired: true,
        approval_record_ref: approval?.approval_id
      }
    });
    return this.persistQueueItem(item, allowed ? "promotion_queue_item_created" : "promotion_queue_item_blocked");
  }

  async blockPromotionRequest(request: ExecutionPromotionRequest, reason: string): Promise<PromotionQueueItem> {
    const item = createPromotionQueueItem({
      promotion_request_id: request.promotion_request_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      queue_status: "blocked",
      promotion_type: request.requested_promotion_type,
      priority: priorityFor(request),
      blockers: [reason],
      constraints: [],
      metadata_json: { non_executing_queue: true, blocked_reason: reason }
    });
    return this.persistQueueItem(item, "promotion_queue_item_blocked");
  }

  async listPromotionQueue(runId: string): Promise<Array<Record<string, unknown>>> {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all("SELECT * FROM factory_promotion_queue_items WHERE run_id = ? ORDER BY created_at", runId);
    } finally {
      store.close();
      void databasePath;
    }
  }

  async summarizePromotionQueue(runId: string): Promise<PromotionQueueSummary> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const requests = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ?", runId)?.count ?? 0);
      const approvalsRequired = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND approval_required = 1", runId)?.count ?? 0);
      const approvalsGranted = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'approved'", runId)?.count ?? 0);
      const approvalsDenied = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'denied'", runId)?.count ?? 0);
      const approvalsExpired = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'expired'", runId)?.count ?? 0);
      const queueItems = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ?", runId)?.count ?? 0);
      const blocked = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND queue_status = 'blocked'", runId)?.count ?? 0);
      const readOnly = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND promotion_type = 'read_only_candidate'", runId)?.count ?? 0);
      const waitingWrite = Number(store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND read_or_write_classification <> 'read_only' AND status = 'awaiting_human_approval'", runId)?.count ?? 0);
      return createPromotionQueueSummary({
        run_id: runId,
        promotion_requests_created: requests,
        approvals_required: approvalsRequired,
        approvals_granted: approvalsGranted,
        approvals_denied: approvalsDenied,
        approvals_expired: approvalsExpired,
        queue_items_created: queueItems,
        queue_items_blocked: blocked,
        read_only_candidates: readOnly,
        write_candidates_waiting_approval: waitingWrite,
        metadata_json: { non_executing_summary: true }
      });
    } finally {
      store.close();
    }
  }

  validatePromotionQueueItem(item: PromotionQueueItem) {
    return {
      valid: item.queue_status !== "cancelled" && !item.metadata_json.executable,
      findings: [
        "non_executing_queue_item",
        item.metadata_json.no_scheduler_enqueue === true ? "scheduler_not_called" : "scheduler_guard_missing",
        item.metadata_json.no_locks_acquired === true ? "locks_not_acquired" : "lock_guard_missing"
      ]
    };
  }

  async cancelPromotionQueueItem(itemId: string, reason: string) {
    await this.traceWriter.write({
      run_id: "unknown",
      event_type: "promotion_queue_item_cancelled",
      lifecycle_stage: "planning",
      reason,
      summary: `Promotion queue item ${itemId} cancelled.`,
      metadata_json: { queue_item_id: itemId, reason, no_execution: true }
    });
  }

  private async persistQueueItem(item: PromotionQueueItem, eventType: "promotion_queue_item_created" | "promotion_queue_item_blocked") {
    const ref = await this.artifactStore.savePromotionQueueItem(item);
    item.artifact_ref = ref;
    const trace = await this.traceWriter.write({
      run_id: item.run_id,
      event_type: eventType,
      lifecycle_stage: "planning",
      severity: item.queue_status === "blocked" ? "warning" : "info",
      reason: item.blockers[0],
      artifact_refs: [ref],
      summary: `Promotion queue item ${item.queue_item_id} ${item.queue_status}.`,
      metadata_json: {
        run_id: item.run_id,
        proposed_node_id: item.proposed_node_id,
        promotion_request_id: item.promotion_request_id,
        approval_id: item.approval_id,
        queue_item_id: item.queue_item_id,
        queue_status: item.queue_status,
        blockers: item.blockers,
        artifact_ref: ref,
        no_execution: true
      }
    });
    item.trace_event_id = trace.trace_event_id;
    await this.metadata.recordPromotionQueueItemSaved(item);
    return item;
  }
}

function priorityFor(request: ExecutionPromotionRequest) {
  if (request.risk_level === "critical") return 10;
  if (request.risk_level === "high") return 8;
  if (request.read_or_write_classification === "read_only") return 3;
  return 5;
}
