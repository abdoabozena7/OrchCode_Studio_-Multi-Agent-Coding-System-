import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ExecutionReadinessBatch, ExecutionReadinessDecision } from "./ExecutionReadinessModels.js";
import {
  createApprovalScope,
  createExecutionPromotionRequest,
  createHumanApprovalRecord,
  type ApprovalApproverType,
  type ApprovalScope,
  type ExecutionPromotionRequest,
  type HumanApprovalRecord,
  type PromotionQueueSummary
} from "./ExecutionApprovalModels.js";
import {
  approvalRequiredForDecision,
  executionPromotionPolicyFromConfig,
  evaluatePromotionRequestPolicy,
  scopeFromDecisionMetadata,
  shouldCreatePromotionRequest,
  validateApprovalScope as validateApprovalScopePolicy
} from "./ExecutionPromotionPolicy.js";
import { ExecutionPromotionQueue } from "./ExecutionPromotionQueue.js";

export type ExecutionApprovalManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type HumanApprovalInput = {
  approver_type?: ApprovalApproverType;
  approver_id?: string;
  decision_reason: string;
  approved_scope?: ApprovalScope;
  expires_at?: string;
  metadata_json?: Record<string, unknown>;
};

export class ExecutionApprovalManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly queue: ExecutionPromotionQueue;

  constructor(private readonly options: ExecutionApprovalManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ExecutionApprovalManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.queue = new ExecutionPromotionQueue({ ...options, artifactStore: this.artifactStore, traceWriter: this.traceWriter });
  }

  async createPromotionRequestsFromReadinessBatch(batch: ExecutionReadinessBatch) {
    const requests: ExecutionPromotionRequest[] = [];
    const approvals: HumanApprovalRecord[] = [];
    for (const decision of batch.decisions) {
      const request = await this.createPromotionRequestFromReadinessDecision(decision);
      if (!request) continue;
      requests.push(request);
      if (request.approval_required) {
        await this.traceWriter.write({
          run_id: request.run_id,
          team_id: request.team_id,
          event_type: "human_approval_required",
          lifecycle_stage: "planning",
          severity: "warning",
          reason: request.approval_reason,
          artifact_refs: request.artifact_ref ? [request.artifact_ref] : [],
          summary: `Human approval required for promotion request ${request.promotion_request_id}.`,
          metadata_json: promotionTraceMetadata(request)
        });
      } else if (this.options.config.promotion_queue_mode === "queue_candidates" && request.read_or_write_classification === "read_only" && this.options.config.allow_read_only_queue_without_human_approval) {
        const approval = await this.recordSystemPolicyApproval(request, "Low-risk read-only promotion candidate allowed by policy.");
        approvals.push(approval);
        await this.queue.enqueueReadOnlyPromotionCandidate(request, approval);
      }
    }
    const summary = await this.writeSummary(batch.run_id);
    return { requests, approvals, summary };
  }

  async createPromotionRequestFromReadinessDecision(decision: ExecutionReadinessDecision): Promise<ExecutionPromotionRequest | undefined> {
    const policy = executionPromotionPolicyFromConfig(this.options.config);
    if (!shouldCreatePromotionRequest(decision, policy)) return undefined;
    const approvalRequired = approvalRequiredForDecision(decision, policy);
    const scope = scopeFromDecisionMetadata(decision);
    const blocked = decision.readiness_status === "blocked" || decision.readiness_status === "rejected" || decision.readiness_status.startsWith("requires_") && decision.readiness_status !== "requires_human_approval";
    const request = createExecutionPromotionRequest({
      run_id: decision.run_id,
      proposed_node_id: decision.proposed_node_id,
      readiness_decision_id: decision.decision_id,
      team_id: decision.team_id,
      adopted_task_id: decision.adopted_task_id,
      task_type: decision.task_type,
      read_or_write_classification: decision.read_or_write_classification,
      proposed_role: decision.proposed_role,
      requested_promotion_type: decision.read_or_write_classification === "read_only" ? "read_only_candidate" : "future_write_candidate",
      readiness_status: decision.readiness_status,
      risk_level: decision.risk_level,
      approval_required: approvalRequired,
      approval_reason: decision.human_approval_reason ?? (approvalRequired ? "human_approval_required_by_policy" : undefined),
      requested_scope: scope,
      required_locks: decision.required_locks,
      required_context_refs: decision.required_context_refs,
      required_prompt_template_ref: decision.required_prompt_template_ref,
      required_validation_strategy: decision.required_validation_strategy,
      required_success_criteria: decision.required_success_criteria,
      required_review_policy: decision.required_review_policy,
      status: blocked ? "blocked" : approvalRequired ? "awaiting_human_approval" : "requested",
      metadata_json: {
        non_executing_request: true,
        no_executor_task_created: true,
        no_scheduler_enqueue: true,
        readiness_approval_status: decision.approval_status,
        readiness_artifact_ref: decision.artifact_ref,
        blocker_count: decision.blockers.length,
        warning_count: decision.warnings.length
      }
    });
    const policyResult = evaluatePromotionRequestPolicy(request, policy);
    if (!policyResult.allowed && request.status !== "awaiting_human_approval") request.status = "blocked";
    const ref = await this.artifactStore.saveExecutionPromotionRequest(request);
    request.artifact_ref = ref;
    const trace = await this.traceWriter.write({
      run_id: request.run_id,
      team_id: request.team_id,
      event_type: request.status === "blocked" ? "execution_promotion_request_blocked" : "execution_promotion_request_created",
      lifecycle_stage: "planning",
      severity: request.status === "blocked" ? "warning" : "info",
      reason: request.status === "blocked" ? policyResult.blockers[0] ?? request.approval_reason : request.approval_reason,
      artifact_refs: [ref],
      summary: `Execution promotion request ${request.promotion_request_id} ${request.status}.`,
      metadata_json: {
        ...promotionTraceMetadata(request),
        blockers: policyResult.blockers,
        warnings: policyResult.warnings
      }
    });
    request.trace_event_id = trace.trace_event_id;
    await this.metadata.recordExecutionPromotionRequestSaved(request);
    return request;
  }

  async listPromotionRequestsForRun(runId: string): Promise<Array<Record<string, unknown>>> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all("SELECT * FROM factory_execution_promotion_requests WHERE run_id = ? ORDER BY created_at", runId);
    } finally {
      store.close();
    }
  }

  evaluateApprovalRequirement(request: ExecutionPromotionRequest) {
    return evaluatePromotionRequestPolicy(request, executionPromotionPolicyFromConfig(this.options.config));
  }

  async recordHumanApproval(requestId: string, approvalInput: HumanApprovalInput): Promise<HumanApprovalRecord> {
    const request = await this.loadPromotionRequest(requestId);
    if (!request) throw new Error(`Promotion request not found: ${requestId}`);
    const approverType = approvalInput.approver_type ?? "human";
      if (approverType === "test_fixture" && !this.options.config.allow_test_fixture_approvals) {
      throw new Error("Test fixture approvals are disabled by orchestration config.");
    }
    const scope = approvalInput.approved_scope ?? request.requested_scope;
    const provisional = createHumanApprovalRecord({
      promotion_request_id: request.promotion_request_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      approver_type: approverType,
      approver_id: approvalInput.approver_id,
      decision: "approved",
      decision_reason: approvalInput.decision_reason,
      approved_scope: scope,
      constraints: [],
      expires_at: approvalInput.expires_at ?? expiresAt(this.options.config.approval_default_ttl_hours ?? 168),
      metadata_json: approvalInput.metadata_json ?? {}
    });
    const validation = this.validateApprovalScope(request, provisional);
    provisional.constraints = validation.constraints;
    provisional.approval_status = validation.valid ? "approved" : "invalid";
    provisional.metadata_json = { ...provisional.metadata_json, scope_valid: validation.valid, scope_rejection_reasons: validation.reasons };
    const ref = await this.artifactStore.saveHumanApprovalRecord(provisional);
    provisional.artifact_ref = ref;
    const trace = await this.traceWriter.write({
      run_id: request.run_id,
      team_id: request.team_id,
      event_type: validation.valid ? "human_approval_recorded" : "human_approval_scope_rejected",
      lifecycle_stage: "planning",
      severity: validation.valid ? "info" : "warning",
      reason: validation.reasons[0] ?? approvalInput.decision_reason,
      artifact_refs: [ref],
      summary: `Human approval ${provisional.approval_id} ${provisional.approval_status}.`,
      metadata_json: {
        ...promotionTraceMetadata(request),
        approval_id: provisional.approval_id,
        approval_status: provisional.approval_status,
        approval_reason: approvalInput.decision_reason,
        blockers: validation.reasons
      }
    });
    provisional.trace_event_id = trace.trace_event_id;
    await this.metadata.recordHumanApprovalRecordSaved(provisional);
    await this.traceWriter.write({
      run_id: request.run_id,
      team_id: request.team_id,
      event_type: validation.valid ? "human_approval_scope_validated" : "human_approval_scope_rejected",
      lifecycle_stage: "planning",
      severity: validation.valid ? "info" : "warning",
      reason: validation.reasons[0],
      artifact_refs: [ref],
      summary: `Human approval scope ${validation.valid ? "validated" : "rejected"} for ${request.promotion_request_id}.`,
      metadata_json: { ...promotionTraceMetadata(request), approval_id: provisional.approval_id, approval_status: provisional.approval_status }
    });
    if (validation.valid && this.options.config.promotion_queue_mode === "queue_candidates") await this.queue.enqueueApprovedPromotion(request, provisional);
    return provisional;
  }

  async denyApproval(requestId: string, reason: string): Promise<HumanApprovalRecord> {
    const request = await this.loadPromotionRequest(requestId);
    if (!request) throw new Error(`Promotion request not found: ${requestId}`);
    const approval = createHumanApprovalRecord({
      promotion_request_id: request.promotion_request_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      approver_type: "human",
      decision: "denied",
      decision_reason: reason,
      approved_scope: request.requested_scope,
      constraints: [],
      metadata_json: { queue_blocked: true }
    });
    return this.persistTerminalApproval(request, approval, "human_approval_denied");
  }

  async revokeApproval(approvalId: string, reason: string): Promise<void> {
    const existing = await this.loadApprovalRecord(approvalId);
    if (!existing) {
      await this.traceWriter.write({
        run_id: "unknown",
        event_type: "human_approval_revoked",
        lifecycle_stage: "planning",
        reason,
        summary: `Human approval ${approvalId} revocation recorded without an existing approval row.`,
        metadata_json: { approval_id: approvalId, reason, queue_non_executing: true, existing_record_found: false }
      });
      return;
    }
    const request = await this.loadPromotionRequest(existing.promotion_request_id);
    const approval = { ...existing, decision: "revoked" as const, approval_status: "revoked" as const, decision_reason: reason, created_at: new Date().toISOString() };
    if (request) await this.persistTerminalApproval(request, approval, "human_approval_revoked");
    else {
      const ref = await this.artifactStore.saveHumanApprovalRecord(approval);
      approval.artifact_ref = ref;
      await this.metadata.recordHumanApprovalRecordSaved(approval);
    }
  }

  async expireApprovals(now: Date = new Date()): Promise<number> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const rows = store.all<{ approval_id: string; promotion_request_id: string; run_id: string; proposed_node_id: string; expires_at?: string }>(
        "SELECT approval_id, promotion_request_id, run_id, proposed_node_id, expires_at FROM factory_human_approval_records WHERE approval_status = 'approved' AND expires_at IS NOT NULL"
      );
      let count = 0;
      for (const row of rows) {
        if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
          const approval = await this.loadApprovalRecord(row.approval_id);
          const request = await this.loadPromotionRequest(row.promotion_request_id);
          if (approval && request) await this.persistTerminalApproval(request, { ...approval, decision: "expired", approval_status: "expired", decision_reason: "approval_ttl_elapsed", created_at: now.toISOString() }, "human_approval_expired");
          else {
            await this.traceWriter.write({
              run_id: row.run_id,
              event_type: "human_approval_expired",
              lifecycle_stage: "planning",
              reason: "approval_ttl_elapsed",
              summary: `Human approval ${row.approval_id} expired.`,
              metadata_json: {
                run_id: row.run_id,
                proposed_node_id: row.proposed_node_id,
                promotion_request_id: row.promotion_request_id,
                approval_id: row.approval_id,
                approval_status: "expired"
              }
            });
          }
          count += 1;
        }
      }
      return count;
    } finally {
      store.close();
    }
  }

  validateApprovalScope(request: ExecutionPromotionRequest, approval: HumanApprovalRecord) {
    return validateApprovalScopePolicy(request, approval);
  }

  async summarizeApprovals(runId: string): Promise<PromotionQueueSummary> {
    return this.writeSummary(runId);
  }

  private async recordSystemPolicyApproval(request: ExecutionPromotionRequest, reason: string) {
    const approval = createHumanApprovalRecord({
      promotion_request_id: request.promotion_request_id,
      run_id: request.run_id,
      proposed_node_id: request.proposed_node_id,
      approver_type: "system_policy",
      decision: "approved",
      decision_reason: reason,
      approved_scope: request.requested_scope,
      constraints: [],
      expires_at: expiresAt(this.options.config.approval_default_ttl_hours ?? 168),
      metadata_json: { auto_read_only_policy_record: true }
    });
    const validation = this.validateApprovalScope(request, approval);
    approval.constraints = validation.constraints;
    approval.approval_status = validation.valid ? "approved" : "invalid";
    const ref = await this.artifactStore.saveHumanApprovalRecord(approval);
    approval.artifact_ref = ref;
    const trace = await this.traceWriter.write({
      run_id: request.run_id,
      team_id: request.team_id,
      event_type: validation.valid ? "human_approval_recorded" : "human_approval_scope_rejected",
      lifecycle_stage: "planning",
      severity: validation.valid ? "info" : "warning",
      reason,
      artifact_refs: [ref],
      summary: `System-policy approval record ${approval.approval_id} ${approval.approval_status}.`,
      metadata_json: { ...promotionTraceMetadata(request), approval_id: approval.approval_id, approval_status: approval.approval_status }
    });
    approval.trace_event_id = trace.trace_event_id;
    await this.metadata.recordHumanApprovalRecordSaved(approval);
    return approval;
  }

  private async persistTerminalApproval(request: ExecutionPromotionRequest, approval: HumanApprovalRecord, eventType: "human_approval_denied" | "human_approval_revoked" | "human_approval_expired") {
    const ref = await this.artifactStore.saveHumanApprovalRecord(approval);
    approval.artifact_ref = ref;
    const trace = await this.traceWriter.write({
      run_id: request.run_id,
      team_id: request.team_id,
      event_type: eventType,
      lifecycle_stage: "planning",
      severity: "warning",
      reason: approval.decision_reason,
      artifact_refs: [ref],
      summary: `Human approval ${approval.approval_id} ${approval.decision}.`,
      metadata_json: { ...promotionTraceMetadata(request), approval_id: approval.approval_id, approval_status: approval.approval_status }
    });
    approval.trace_event_id = trace.trace_event_id;
    await this.metadata.recordHumanApprovalRecordSaved(approval);
    await this.queue.blockPromotionRequest(request, `approval_${approval.decision}`);
    return approval;
  }

  private async writeSummary(runId: string) {
    const summary = await this.queue.summarizePromotionQueue(runId);
    const ref = await this.artifactStore.savePromotionQueueSummary(summary);
    summary.promotion_queue_summary_ref = ref;
    summary.approval_summary_ref = ref;
    await this.traceWriter.write({
      run_id: runId,
      event_type: "promotion_queue_summary_created",
      lifecycle_stage: "planning",
      artifact_refs: [ref],
      summary: "Promotion queue summary created.",
      metadata_json: {
        run_id: runId,
        promotion_requests_created: summary.promotion_requests_created,
        approvals_required: summary.approvals_required,
        queue_items_created: summary.queue_items_created,
        approval_summary_ref: ref,
        promotion_queue_summary_ref: ref
      }
    });
    return summary;
  }

  private async loadPromotionRequest(requestId: string): Promise<ExecutionPromotionRequest | undefined> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>("SELECT * FROM factory_execution_promotion_requests WHERE promotion_request_id = ?", requestId);
      if (!row) return undefined;
      return createExecutionPromotionRequest({
        promotion_request_id: String(row.promotion_request_id),
        run_id: String(row.run_id),
        proposed_node_id: String(row.proposed_node_id),
        readiness_decision_id: String(row.readiness_decision_id),
        team_id: typeof row.team_id === "string" ? row.team_id : undefined,
        adopted_task_id: typeof row.adopted_task_id === "string" ? row.adopted_task_id : undefined,
        task_type: String(row.task_type),
        read_or_write_classification: row.read_or_write_classification as ExecutionPromotionRequest["read_or_write_classification"],
        proposed_role: String(row.proposed_role),
        requested_promotion_type: row.requested_promotion_type as ExecutionPromotionRequest["requested_promotion_type"],
        readiness_status: row.readiness_status as ExecutionPromotionRequest["readiness_status"],
        risk_level: row.risk_level as ExecutionPromotionRequest["risk_level"],
        approval_required: Number(row.approval_required) === 1,
        approval_reason: typeof row.approval_reason === "string" ? row.approval_reason : undefined,
        requested_scope: parseScope(row.requested_scope_json),
        required_locks: parseStringArray(row.required_locks_json),
        required_context_refs: parseStringArray(row.required_context_refs_json),
        required_prompt_template_ref: typeof row.required_prompt_template_ref === "string" ? row.required_prompt_template_ref : undefined,
        required_validation_strategy: parseStringArray(row.required_validation_strategy_json),
        required_success_criteria: parseStringArray(row.required_success_criteria_json),
        required_review_policy: parseStringArray(row.required_review_policy_json),
        status: row.status as ExecutionPromotionRequest["status"],
        artifact_ref: typeof row.artifact_ref === "string" ? row.artifact_ref : undefined,
        trace_event_id: typeof row.trace_event_id === "string" ? row.trace_event_id : undefined,
        metadata_json: parseRecord(row.metadata_json),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at)
      });
    } finally {
      store.close();
    }
  }

  private async loadApprovalRecord(approvalId: string): Promise<HumanApprovalRecord | undefined> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>("SELECT * FROM factory_human_approval_records WHERE approval_id = ?", approvalId);
      if (!row) return undefined;
      return createHumanApprovalRecord({
        approval_id: String(row.approval_id),
        promotion_request_id: String(row.promotion_request_id),
        run_id: String(row.run_id),
        proposed_node_id: String(row.proposed_node_id),
        approver_type: row.approver_type as HumanApprovalRecord["approver_type"],
        approver_id: typeof row.approver_id === "string" ? row.approver_id : undefined,
        decision: row.decision as HumanApprovalRecord["decision"],
        approval_status: row.approval_status as HumanApprovalRecord["approval_status"],
        decision_reason: String(row.decision_reason),
        approved_scope: parseScope(row.approved_scope_json),
        constraints: parseConstraints(row.constraints_json),
        expires_at: typeof row.expires_at === "string" ? row.expires_at : undefined,
        artifact_ref: typeof row.artifact_ref === "string" ? row.artifact_ref : undefined,
        trace_event_id: typeof row.trace_event_id === "string" ? row.trace_event_id : undefined,
        metadata_json: parseRecord(row.metadata_json),
        created_at: String(row.created_at)
      });
    } finally {
      store.close();
    }
  }
}

function promotionTraceMetadata(request: ExecutionPromotionRequest) {
  return {
    run_id: request.run_id,
    proposed_node_id: request.proposed_node_id,
    readiness_decision_id: request.readiness_decision_id,
    promotion_request_id: request.promotion_request_id,
    approval_status: request.approval_required ? "pending" : "not_required",
    risk_level: request.risk_level,
    approval_reason: request.approval_reason,
    blocker_count: request.status === "blocked" ? 1 : 0,
    artifact_ref: request.artifact_ref,
    no_execution: true
  };
}

function expiresAt(ttlHours: number) {
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
}

function parseStringArray(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseScope(value: unknown) {
  const parsed = parseRecord(value);
  return createApprovalScope({
    allowed_files: Array.isArray(parsed.allowed_files) ? parsed.allowed_files.filter((entry): entry is string => typeof entry === "string") : [],
    forbidden_files: Array.isArray(parsed.forbidden_files) ? parsed.forbidden_files.filter((entry): entry is string => typeof entry === "string") : [],
    read_only_files: Array.isArray(parsed.read_only_files) ? parsed.read_only_files.filter((entry): entry is string => typeof entry === "string") : [],
    required_locks: Array.isArray(parsed.required_locks) ? parsed.required_locks.filter((entry): entry is string => typeof entry === "string") : [],
    required_context_refs: Array.isArray(parsed.required_context_refs) ? parsed.required_context_refs.filter((entry): entry is string => typeof entry === "string") : [],
    required_prompt_template_ref: typeof parsed.required_prompt_template_ref === "string" ? parsed.required_prompt_template_ref : undefined,
    required_validation_strategy: Array.isArray(parsed.required_validation_strategy) ? parsed.required_validation_strategy.filter((entry): entry is string => typeof entry === "string") : [],
    required_success_criteria: Array.isArray(parsed.required_success_criteria) ? parsed.required_success_criteria.filter((entry): entry is string => typeof entry === "string") : [],
    required_review_policy: Array.isArray(parsed.required_review_policy) ? parsed.required_review_policy.filter((entry): entry is string => typeof entry === "string") : [],
    metadata_json: parseRecord(parsed.metadata_json)
  });
}

function parseConstraints(value: unknown) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is HumanApprovalRecord["constraints"][number] => Boolean(entry && typeof entry === "object")) : [];
  } catch {
    return [];
  }
}
