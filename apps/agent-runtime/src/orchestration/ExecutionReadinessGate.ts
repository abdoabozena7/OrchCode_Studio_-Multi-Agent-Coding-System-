import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ProposedTaskGraph, ProposedTaskGraphNode } from "./ProposedTaskGraphModels.js";
import { renderRolePrompt } from "./PromptSystem.js";
import { evaluatePromptQuality, isPromptQualityBlocking } from "./PromptQualityGate.js";
import { executionApprovalPolicyFromConfig, humanApprovalRequirementForNode } from "./ExecutionApprovalPolicy.js";
import { ExecutionApprovalManager } from "./ExecutionApprovalManager.js";
import {
  createExecutionPromotionBlocker,
  createExecutionReadinessBatch,
  createExecutionReadinessDecision,
  createExecutionReadinessFinding,
  createExecutionReadinessRequest,
  createExecutionReadinessRequirement,
  createExecutionReadinessSummary,
  type ExecutionApprovalPolicy,
  type ExecutionReadinessBatch,
  type ExecutionReadinessDecision,
  type ExecutionReadinessFinding,
  type ExecutionReadinessRequirement,
  type ExecutionReadinessStatus,
  type HumanApprovalRequirement
} from "./ExecutionReadinessModels.js";

export type ExecutionReadinessGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type ExecutionReadinessEvaluationContext = {
  graph?: ProposedTaskGraph;
  cycleNodeIds?: string[];
};

export class ExecutionReadinessGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly options: ExecutionReadinessGateOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ExecutionReadinessGate" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async evaluateProposedGraph(graph: ProposedTaskGraph, options: { selectedNodeIds?: string[] } = {}): Promise<ExecutionReadinessBatch> {
    const policy = executionApprovalPolicyFromConfig(this.options.config);
    const selected = options.selectedNodeIds?.length
      ? graph.nodes.filter((node) => options.selectedNodeIds?.includes(node.proposed_node_id))
      : graph.nodes;
    const nodes = selected.slice(0, policy.max_nodes_evaluated_per_run);
    const request = createExecutionReadinessRequest({
      run_id: graph.run_id,
      graph_id: graph.graph_id,
      proposed_node_ids: nodes.map((node) => node.proposed_node_id),
      policy,
      requested_by: "ExecutionReadinessGate",
      metadata_json: { non_executing_gate: true, graph_status: graph.status }
    });
    await this.traceWriter.write({
      run_id: graph.run_id,
      event_type: "execution_readiness_started",
      lifecycle_stage: "planning",
      summary: `Execution readiness evaluation started for ${nodes.length} proposed node(s).`,
      metadata_json: {
        run_id: graph.run_id,
        graph_id: graph.graph_id,
        mode: policy.mode,
        selected_node_count: nodes.length
      }
    });

    if (!this.options.config.execution_readiness_gate_enabled || policy.mode === "off") {
      const summary = createExecutionReadinessSummary({
        run_id: graph.run_id,
        graph_id: graph.graph_id,
        nodes_evaluated: 0,
        ready_read_only_count: 0,
        future_write_candidate_count: 0,
        requires_human_approval_count: 0,
        blocked_count: 0,
        rejected_count: 0,
        requires_context_count: 0,
        requires_validation_count: 0,
        requires_locks_count: 0,
        metadata_json: { skipped: true, reason: "execution_readiness_disabled" }
      });
      return createExecutionReadinessBatch({
        run_id: graph.run_id,
        graph_id: graph.graph_id,
        request,
        decisions: [],
        approval_requirements: [],
        summary,
        metadata_json: { skipped: true, reason: "execution_readiness_disabled" }
      });
    }

    const cycleNodeIds = uniqueStrings(graph.validation?.cycles.flat() ?? []);
    const decisions: ExecutionReadinessDecision[] = [];
    const approvals: HumanApprovalRequirement[] = [];
    for (const node of nodes) {
      const decision = await this.evaluateProposedNode(node, { graph, cycleNodeIds });
      const decisionRef = await this.artifactStore.saveExecutionReadinessDecision(decision);
      decision.artifact_ref = decisionRef;
      for (const approval of decision.required_human_approval ? [decision.required_human_approval] : []) {
        const approvalRef = await this.artifactStore.saveExecutionApprovalRequirement(approval);
        approval.artifact_ref = approvalRef;
        approvals.push(approval);
        await this.metadata.recordExecutionApprovalRequirementSaved(approval);
      }
      const trace = await this.traceWriter.write({
        run_id: decision.run_id,
        team_id: decision.team_id,
        event_type: "execution_readiness_node_evaluated",
        lifecycle_stage: "planning",
        severity: decision.failed_requirements.length || decision.blockers.length ? "warning" : "info",
        summary: `Execution readiness evaluated for ${decision.proposed_node_id}: ${decision.readiness_status}.`,
        artifact_refs: [decisionRef],
        metadata_json: {
          run_id: decision.run_id,
          proposed_node_id: decision.proposed_node_id,
          team_id: decision.team_id,
          readiness_status: decision.readiness_status,
          approval_status: decision.approval_status,
          blocker_count: decision.blockers.length,
          warning_count: decision.warnings.length,
          risk_level: decision.risk_level
        }
      });
      decision.trace_event_id = trace.trace_event_id;
      await this.metadata.recordExecutionReadinessDecisionSaved(decision);
      for (const requirement of decision.requirements_checked) {
        await this.metadata.recordExecutionReadinessRequirementSaved(decision.decision_id, requirement, decision);
      }
      decisions.push(decision);
    }

    const summary = this.summarizeReadinessBatch(decisions, graph.graph_id);
    const batch = createExecutionReadinessBatch({
      run_id: graph.run_id,
      graph_id: graph.graph_id,
      request,
      decisions,
      approval_requirements: approvals,
      summary,
      metadata_json: { no_executor_tasks_created: true, no_scheduler_enqueue: true }
    });
    if (this.options.config.enable_execution_promotion_queue && this.options.config.promotion_queue_mode !== "off") {
      const promotion = await new ExecutionApprovalManager({
        workspacePath: this.workspacePath,
        memoryDir: this.memoryDir,
        config: this.options.config,
        artifactStore: this.artifactStore,
        traceWriter: this.traceWriter
      }).createPromotionRequestsFromReadinessBatch(batch);
      batch.metadata_json = {
        ...batch.metadata_json,
        promotion_request_refs: promotion.requests.map((request) => request.promotion_request_id),
        human_approval_record_refs: promotion.approvals.map((approval) => approval.approval_id),
        promotion_queue_summary_ref: promotion.summary.promotion_queue_summary_ref
      };
    }
    const refs = await this.artifactStore.saveExecutionReadinessBatch(batch);
    batch.artifact_ref = refs.batchRef;
    batch.summary_ref = refs.summaryRef;
    batch.summary.readiness_summary_ref = refs.summaryRef;
    const trace = await this.traceWriter.write({
      run_id: graph.run_id,
      event_type: "execution_readiness_batch_completed",
      lifecycle_stage: "planning",
      summary: `Execution readiness batch completed for ${decisions.length} proposed node(s).`,
      artifact_refs: [refs.batchRef, refs.summaryRef],
      metadata_json: {
        run_id: graph.run_id,
        graph_id: graph.graph_id,
        nodes_evaluated: decisions.length,
        ready_read_only_count: summary.ready_read_only_count,
        future_write_candidate_count: summary.future_write_candidate_count,
        requires_human_approval_count: summary.requires_human_approval_count,
        blocked_count: summary.blocked_count
      }
    });
    batch.trace_event_id = trace.trace_event_id;
    await this.traceWriter.write({
      run_id: graph.run_id,
      event_type: "execution_readiness_summary_created",
      lifecycle_stage: "planning",
      summary: "Execution readiness summary created.",
      artifact_refs: [refs.summaryRef],
      metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, summary_id: summary.summary_id }
    });
    await this.metadata.recordExecutionReadinessBatchSaved(batch);
    return batch;
  }

  async evaluateProposedNode(node: ProposedTaskGraphNode, context: ExecutionReadinessEvaluationContext = {}): Promise<ExecutionReadinessDecision> {
    const requirements = [
      this.checkIdentityReadiness(node),
      this.checkGraphStatusReadiness(node, context),
      this.checkContextReadiness(node),
      await this.checkPromptReadiness(node),
      this.checkValidationReadiness(node),
      this.checkSuccessCriteriaReadiness(node),
      this.checkLockReadiness(node),
      this.checkReviewPolicyReadiness(node),
      this.checkIntegrationReadiness(node)
    ];
    const policy = executionApprovalPolicyFromConfig(this.options.config);
    const humanApproval = this.checkHumanApprovalRequirement(node, policy);
    requirements.push(this.humanApprovalRequirementCheck(node, humanApproval));
    const findings = requirements.flatMap((requirement) => requirement.findings);
    const blockers = blockersForRequirements(requirements);
    const warnings = findings.filter((finding) => finding.severity === "warning");
    const readinessStatus = readinessStatusFor(node, requirements, blockers, humanApproval, policy);
    const approvalStatus = approvalStatusFor(readinessStatus, humanApproval);
    const decision = createExecutionReadinessDecision({
      run_id: node.run_id,
      proposed_node_id: node.proposed_node_id,
      team_id: node.team_id,
      adopted_task_id: node.adopted_task_id,
      task_type: node.task_type,
      read_or_write_classification: node.read_or_write_classification,
      proposed_role: node.proposed_role,
      readiness_status: readinessStatus,
      approval_status: approvalStatus,
      requirements_checked: requirements,
      passed_requirements: requirements.filter((requirement) => requirement.status === "passed" || requirement.status === "not_required").map((requirement) => requirement.requirement_type),
      failed_requirements: requirements.filter((requirement) => requirement.status === "failed").map((requirement) => requirement.requirement_type),
      blockers,
      warnings,
      required_human_approval: humanApproval,
      human_approval_reason: humanApproval?.reason,
      required_locks: this.deriveRequiredLocks(node),
      required_context_refs: node.context_pack_ref ? [node.context_pack_ref] : [],
      required_prompt_template_ref: node.prompt_template_ref,
      required_validation_strategy: validationRefs(node),
      required_success_criteria: node.success_criteria,
      required_review_policy: node.read_or_write_classification === "read_only" ? [] : ["review_required_before_integration"],
      risk_level: this.classifyExecutionRisk(node),
      confidence: confidenceFor(requirements, warnings),
      metadata_json: {
        no_executor_task_created: true,
        no_scheduler_enqueue: true,
        allowed_files: node.allowed_files,
        forbidden_files: node.forbidden_files,
        read_only_files: node.read_only_files,
        module_locks: node.module_locks,
        semantic_locks: node.semantic_locks,
        source_node_status: node.status,
        graph_non_executable_reason: node.non_executable_reason
      }
    });
    await this.emitRequirementEvents(decision);
    if (humanApproval) {
      await this.traceWriter.write({
        run_id: node.run_id,
        team_id: node.team_id,
        event_type: "execution_readiness_human_approval_required",
        lifecycle_stage: "planning",
        severity: "warning",
        reason: humanApproval.reason,
        summary: `Human approval required for ${node.proposed_node_id}.`,
        metadata_json: {
          run_id: node.run_id,
          proposed_node_id: node.proposed_node_id,
          team_id: node.team_id,
          readiness_status: decision.readiness_status,
          approval_status: decision.approval_status,
          human_approval_reason: humanApproval.reason,
          risk_level: node.risk_level
        }
      });
    }
    const type = decision.readiness_status === "ready_read_only"
      ? "execution_readiness_read_only_ready"
      : decision.readiness_status === "future_write_candidate" || decision.readiness_status === "approved_for_future_promotion"
        ? "execution_readiness_future_write_candidate"
        : decision.blockers.length
          ? "execution_readiness_blocked"
          : undefined;
    if (type) {
      await this.traceWriter.write({
        run_id: node.run_id,
        team_id: node.team_id,
        event_type: type,
        lifecycle_stage: "planning",
        severity: type === "execution_readiness_blocked" ? "warning" : "info",
        reason: decision.blockers[0]?.reason,
        summary: `Execution readiness status for ${node.proposed_node_id}: ${decision.readiness_status}.`,
        metadata_json: {
          run_id: node.run_id,
          proposed_node_id: node.proposed_node_id,
          readiness_status: decision.readiness_status,
          approval_status: decision.approval_status,
          risk_level: decision.risk_level
        }
      });
    }
    return decision;
  }

  checkContextReadiness(node: ProposedTaskGraphNode) {
    const refs = node.context_pack_ref ? [node.context_pack_ref] : [];
    const contextFinding = refs.length
      ? finding("context_available", "passed", "Context pack ref is available.", refs)
      : (node.read_only_files.length || node.evidence_refs.length)
          ? finding("context_buildable", "warning", "Context is buildable from proposed node file/evidence refs, but no context pack ref is attached.", [...node.read_only_files, ...node.evidence_refs])
          : finding("context_missing", "blocking", "Context is missing and not obviously buildable.", [node.proposed_node_id]);
    return requirement("context", contextFinding.severity === "blocking" ? "failed" : contextFinding.severity === "warning" ? "warning" : "passed", contextFinding.message, contextFinding.refs, [contextFinding]);
  }

  async checkPromptReadiness(node: ProposedTaskGraphNode) {
    if (!node.prompt_template_ref) {
      return requirement("prompt", "failed", "Prompt template ref is missing.", [], [finding("prompt_missing", "blocking", "Prompt template/profile is missing.", [node.proposed_node_id])]);
    }
    const rendered = renderRolePrompt({
      run_id: node.run_id,
      task_id: node.proposed_node_id,
      agent_role: node.proposed_role,
      task_title: node.title,
      task_objective: node.objective,
      context_pack_ref: node.context_pack_ref ?? `context_preview:${node.proposed_node_id}`,
      allowed_files: node.allowed_files,
      forbidden_files: node.forbidden_files,
      relevant_files: node.read_only_files,
      validation_requirements: validationRefs(node),
      expected_output_schema: "ParsedAgentOutput",
      output_schema_name: "ParsedAgentOutput",
      source_component: "ExecutionReadinessGate",
      metadata_json: {
        proposed_node_id: node.proposed_node_id,
        team_id: node.team_id,
        dry_run: true
      }
    });
    if (!rendered.ok) {
      return requirement("prompt", "failed", rendered.error.message, [node.prompt_template_ref], [finding("prompt_missing", "blocking", rendered.error.message, [node.prompt_template_ref])]);
    }
    const quality = evaluatePromptQuality(rendered.rendered, {
      promptArtifactRef: `dry_run_prompt_check:${rendered.rendered.prompt_id}`,
      contextPackRef: rendered.rendered.context_pack_ref,
      allowedFiles: node.allowed_files,
      forbiddenFiles: node.forbidden_files,
      validationRequirements: validationRefs(node),
      successCriteria: node.success_criteria,
      stopConditions: node.stop_conditions,
      expectedOutputSchema: "ParsedAgentOutput"
    });
    const dryRunRef = await this.artifactStore.saveExecutionDryRunPromptCheck(node.run_id, node.proposed_node_id, {
      proposed_node_id: node.proposed_node_id,
      prompt_id: rendered.rendered.prompt_id,
      template_id: rendered.rendered.template_id,
      template_version: rendered.rendered.template_version,
      rendered_prompt_hash: rendered.rendered.rendered_prompt_hash,
      output_schema_name: rendered.rendered.output_schema_name,
      prompt_quality_status: quality.status,
      prompt_quality_blocking: quality.blocking,
      quality_findings: quality.findings.map((entry) => ({ check_id: entry.check_id, severity: entry.severity, message: entry.message })),
      text_stored: false
    });
    await this.traceWriter.write({
      run_id: node.run_id,
      team_id: node.team_id,
      event_type: "execution_readiness_dry_run_prompt_checked",
      lifecycle_stage: "planning",
      severity: isPromptQualityBlocking(quality) ? "warning" : "info",
      summary: `Dry-run prompt checked for ${node.proposed_node_id}: ${quality.status}.`,
      artifact_refs: [dryRunRef],
      metadata_json: {
        run_id: node.run_id,
        proposed_node_id: node.proposed_node_id,
        prompt_quality_status: quality.status,
        prompt_template_ref: node.prompt_template_ref
      }
    });
    const qualityFinding = isPromptQualityBlocking(quality)
      ? finding("prompt_quality_blocked", "blocking", `Prompt quality gate returned ${quality.status}.`, [dryRunRef])
      : finding("prompt_quality_passed", quality.status === "warning" ? "warning" : "passed", `Prompt quality gate returned ${quality.status}.`, [dryRunRef]);
    return requirement("prompt", qualityFinding.severity === "blocking" ? "failed" : qualityFinding.severity === "warning" ? "warning" : "passed", qualityFinding.message, [node.prompt_template_ref, dryRunRef], [
      finding("prompt_template_available", "passed", "Prompt template/profile is available.", [node.prompt_template_ref]),
      qualityFinding
    ], dryRunRef);
  }

  checkValidationReadiness(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification === "read_only") return requirement("validation", "not_required", "Validation strategy is not required for read-only readiness.", [], []);
    const refs = validationRefs(node);
    if (!refs.length) return requirement("validation", "failed", "Write candidate is missing validation strategy.", [], [finding("validation_strategy_missing", "blocking", "Validation strategy is missing.", [node.proposed_node_id])]);
    const severity = refs.some((ref) => /test|build|lint|diff --check|typecheck/i.test(ref)) ? "passed" : "warning";
    return requirement("validation", severity === "warning" ? "warning" : "passed", severity === "warning" ? "Validation strategy exists but may be insufficient." : "Validation strategy is present.", refs, [
      finding(severity === "warning" ? "validation_strategy_insufficient" : "validation_strategy_present", severity, severity === "warning" ? "Validation strategy exists but coverage is not clearly sufficient." : "Validation strategy is present.", refs)
    ]);
  }

  checkSuccessCriteriaReadiness(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification === "read_only" && node.success_criteria.length === 0) {
      return requirement("success_criteria", "warning", "Read-only node has no explicit success criteria.", [], [finding("success_criteria_missing", "warning", "Read-only node has no explicit success criteria.", [node.proposed_node_id])]);
    }
    if (!node.success_criteria.length) return requirement("success_criteria", "failed", "Success criteria are missing.", [], [finding("success_criteria_missing", "blocking", "Success criteria are missing.", [node.proposed_node_id])]);
    const findings = [finding("success_criteria_present", "passed", "Success criteria are present.", node.success_criteria)];
    if (node.read_or_write_classification !== "read_only" && !node.stop_conditions.length) {
      findings.push(finding("stop_conditions_missing", "blocking", "Write candidate is missing stop conditions.", [node.proposed_node_id]));
      return requirement("stop_conditions", "failed", "Stop conditions are missing.", [], findings);
    }
    if (node.read_or_write_classification !== "read_only") findings.push(finding("stop_conditions_present", "passed", "Stop conditions are present.", node.stop_conditions));
    return requirement("success_criteria", "passed", "Success criteria are present.", node.success_criteria, findings);
  }

  checkLockReadiness(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification === "read_only") return requirement("locks", "not_required", "Write locks are not required for read-only readiness.", [], []);
    if (!node.allowed_files.length) return requirement("locks", "failed", "Write candidate has no allowed file scope for lock derivation.", [], [finding("locks_missing", "blocking", "Allowed file scope is missing, so required durable locks cannot be derived.", [node.proposed_node_id])]);
    const locks = this.deriveRequiredLocks(node);
    if (!locks.length) return requirement("locks", "failed", "Durable lock requirements are not derivable.", [], [finding("locks_missing", "blocking", "Required durable lock refs are missing.", [node.proposed_node_id])]);
    return requirement("locks", "passed", "Durable lock requirements are derivable without acquiring locks.", locks, [finding("locks_derived", "passed", "Required locks derived in analysis-only mode.", locks)]);
  }

  checkReviewPolicyReadiness(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification === "read_only") return requirement("review_policy", "not_required", "Review policy is not required for read-only readiness.", [], []);
    const refs = ["review_required_before_integration", "prompt_quality_gate_required", "integration_manager_required"];
    return requirement("review_policy", "passed", "Review policy is present for future write promotion.", refs, [finding("review_policy_present", "passed", "Review policy is present.", refs)]);
  }

  checkHumanApprovalRequirement(node: ProposedTaskGraphNode, policy: ExecutionApprovalPolicy) {
    return humanApprovalRequirementForNode(node, policy);
  }

  classifyExecutionRisk(node: ProposedTaskGraphNode) {
    return node.risk_level;
  }

  summarizeReadinessBatch(decisions: ExecutionReadinessDecision[], graphId?: string) {
    const runId = decisions[0]?.run_id ?? "";
    return createExecutionReadinessSummary({
      run_id: runId,
      graph_id: graphId,
      nodes_evaluated: decisions.length,
      ready_read_only_count: decisions.filter((decision) => decision.readiness_status === "ready_read_only").length,
      future_write_candidate_count: decisions.filter((decision) => decision.readiness_status === "future_write_candidate" || decision.readiness_status === "approved_for_future_promotion").length,
      requires_human_approval_count: decisions.filter((decision) => decision.required_human_approval?.required).length,
      blocked_count: decisions.filter((decision) => decision.readiness_status === "blocked" || decision.blockers.some((blocker) => blocker.severity === "blocking")).length,
      rejected_count: decisions.filter((decision) => decision.readiness_status === "rejected").length,
      requires_context_count: decisions.filter((decision) => decision.readiness_status === "requires_context").length,
      requires_validation_count: decisions.filter((decision) => decision.readiness_status === "requires_validation_strategy").length,
      requires_locks_count: decisions.filter((decision) => decision.readiness_status === "requires_locks").length,
      metadata_json: { no_execution: true }
    });
  }

  private checkIdentityReadiness(node: ProposedTaskGraphNode) {
    const findings = [
      finding("run_id_present", node.run_id ? "passed" : "blocking", node.run_id ? "Run id is present." : "Run id is missing.", [node.run_id]),
      finding("objective_present", node.objective ? "passed" : "blocking", node.objective ? "Objective is present." : "Objective is missing.", [node.proposed_node_id]),
      finding("role_present", node.proposed_role ? "passed" : "blocking", node.proposed_role ? "Proposed role is present." : "Proposed role is missing.", [String(node.proposed_role)]),
      finding("task_type_present", node.task_type ? "passed" : "blocking", node.task_type ? "Task type is present." : "Task type is missing.", [node.task_type]),
      finding("team_scope_present", node.adopted_task_id || node.sub_plan_id ? node.team_id ? "passed" : "blocking" : "info", node.team_id ? "Team scope metadata is present." : "Team scope metadata is not required or missing.", [node.team_id ?? node.proposed_node_id])
    ];
    return requirement("identity", findings.some((entry) => entry.severity === "blocking") ? "failed" : "passed", "Identity metadata checked.", findings.flatMap((entry) => entry.refs), findings);
  }

  private checkGraphStatusReadiness(node: ProposedTaskGraphNode, context: ExecutionReadinessEvaluationContext) {
    const findings: ExecutionReadinessFinding[] = [];
    const disallowed = ["rejected", "duplicate", "superseded"].includes(node.status);
    findings.push(finding("node_status_allowed", disallowed ? "blocking" : "passed", disallowed ? `Node status ${node.status} cannot be promoted.` : "Node status is eligible for readiness evaluation.", [node.status]));
    if (context.cycleNodeIds?.includes(node.proposed_node_id)) {
      findings.push(finding("cycle_blocker", "blocking", "Node is part of an unresolved proposed graph cycle.", [node.proposed_node_id]));
    }
    const conflict = node.forbidden_files.filter((file) => node.allowed_files.includes(file) || node.read_only_files.includes(file));
    if (conflict.length) findings.push(finding("forbidden_file_conflict", "blocking", `Forbidden file conflict: ${conflict.join(", ")}.`, conflict));
    if (node.read_or_write_classification === "read_only" && (node.allowed_files.length || /executor|integrator|write|edit|modify/i.test(`${node.proposed_role} ${node.title} ${node.objective}`))) {
      findings.push(finding("read_only_write_intent", "blocking", "Read-only node contains write intent or allowed write files.", [node.proposed_node_id]));
    }
    return requirement("graph_status", findings.some((entry) => entry.severity === "blocking") ? "failed" : "passed", "Proposed graph status checked.", findings.flatMap((entry) => entry.refs), findings);
  }

  private checkIntegrationReadiness(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification === "read_only") return requirement("integration", "not_required", "IntegrationManager path is not required for read-only readiness.", [], []);
    return requirement("integration", "passed", "Future write promotion must route through IntegrationManager.", ["IntegrationManager"], [finding("integration_path_available", "passed", "IntegrationManager path is available as a future requirement.", ["IntegrationManager"])]);
  }

  private humanApprovalRequirementCheck(node: ProposedTaskGraphNode, approval: HumanApprovalRequirement | undefined) {
    if (!approval) return requirement("human_approval", "not_required", "Human approval is not required by policy for this readiness decision.", [], []);
    return requirement("human_approval", "warning", approval.reason, approval.triggers, [finding("human_approval_required", "warning", approval.reason, approval.triggers)]);
  }

  private deriveRequiredLocks(node: ProposedTaskGraphNode) {
    const derived = node.allowed_files.map((file) => `module:${file.split(/[\\/]/)[0]}`).filter((entry) => entry !== "module:");
    return uniqueStrings([...node.module_locks, ...node.semantic_locks, ...derived]);
  }

  private async emitRequirementEvents(decision: ExecutionReadinessDecision) {
    for (const requirement of decision.requirements_checked) {
      const failed = requirement.status === "failed";
      await this.traceWriter.write({
        run_id: decision.run_id,
        team_id: decision.team_id,
        event_type: failed ? "execution_readiness_requirement_failed" : "execution_readiness_requirement_passed",
        lifecycle_stage: "planning",
        severity: failed ? "warning" : "info",
        reason: failed ? requirement.summary : undefined,
        summary: `Execution readiness requirement ${requirement.requirement_type} ${failed ? "failed" : "passed"} for ${decision.proposed_node_id}.`,
        artifact_refs: requirement.artifact_ref ? [requirement.artifact_ref] : [],
        metadata_json: {
          run_id: decision.run_id,
          proposed_node_id: decision.proposed_node_id,
          team_id: decision.team_id,
          readiness_status: decision.readiness_status,
          approval_status: decision.approval_status,
          requirement_name: requirement.requirement_type,
          requirement_status: requirement.status,
          risk_level: decision.risk_level
        }
      });
    }
    const contextReq = decision.requirements_checked.find((entry) => entry.requirement_type === "context");
    if (contextReq) {
      const previewRef = await this.artifactStore.saveExecutionContextPreview(decision.run_id, decision.proposed_node_id, {
        proposed_node_id: decision.proposed_node_id,
        context_available: contextReq.findings.some((entry) => entry.code === "context_available"),
        context_buildable: contextReq.findings.some((entry) => entry.code === "context_buildable"),
        context_missing: contextReq.findings.some((entry) => entry.code === "context_missing"),
        refs: contextReq.refs,
        snippets_stored: false
      });
      contextReq.artifact_ref = previewRef;
      await this.traceWriter.write({
        run_id: decision.run_id,
        team_id: decision.team_id,
        event_type: "execution_readiness_context_checked",
        lifecycle_stage: "planning",
        severity: contextReq.status === "failed" ? "warning" : "info",
        summary: `Execution readiness context checked for ${decision.proposed_node_id}.`,
        artifact_refs: [previewRef],
        metadata_json: { run_id: decision.run_id, proposed_node_id: decision.proposed_node_id, requirement_status: contextReq.status }
      });
    }
    if (decision.required_locks.length) {
      await this.traceWriter.write({
        run_id: decision.run_id,
        team_id: decision.team_id,
        event_type: "execution_readiness_locks_derived",
        lifecycle_stage: "planning",
        summary: `Execution readiness derived ${decision.required_locks.length} lock ref(s).`,
        metadata_json: {
          run_id: decision.run_id,
          proposed_node_id: decision.proposed_node_id,
          lock_refs: decision.required_locks,
          analysis_only: true
        }
      });
    }
  }
}

function readinessStatusFor(
  node: ProposedTaskGraphNode,
  requirements: ExecutionReadinessRequirement[],
  blockers: ReturnType<typeof blockersForRequirements>,
  approval: HumanApprovalRequirement | undefined,
  policy: ExecutionApprovalPolicy
): ExecutionReadinessStatus {
  if (node.status === "rejected" || node.status === "duplicate" || node.status === "superseded") return "rejected";
  const failedTypes = new Set(requirements.filter((requirement) => requirement.status === "failed").map((requirement) => requirement.requirement_type));
  if (failedTypes.has("context")) return "requires_context";
  if (failedTypes.has("prompt")) return "requires_prompt";
  if (failedTypes.has("validation")) return "requires_validation_strategy";
  if (failedTypes.has("success_criteria") || failedTypes.has("stop_conditions")) return "requires_success_criteria";
  if (failedTypes.has("locks")) return "requires_locks";
  if (failedTypes.has("review_policy")) return "requires_review_policy";
  if (blockers.length) return blockers.some((blocker) => blocker.blocker_type === "forbidden_file_conflict") ? "rejected" : "blocked";
  if (node.read_or_write_classification === "read_only") {
    if (policy.allow_read_only_promotion_candidates) return "ready_read_only";
    return "not_ready";
  }
  if (policy.allow_write_future_candidates) return "future_write_candidate";
  if (approval?.required) return "requires_human_approval";
  return "not_ready";
}

function approvalStatusFor(status: ExecutionReadinessStatus, approval: HumanApprovalRequirement | undefined) {
  if (status === "rejected") return "rejected";
  if (status === "blocked" || status.startsWith("requires_") && status !== "requires_human_approval") return "blocked";
  if (approval?.required || status === "requires_human_approval") return "human_approval_required";
  if (status === "ready_read_only") return "read_only_candidate";
  if (status === "future_write_candidate" || status === "approved_for_future_promotion") return "future_promotion_candidate";
  return "not_approved";
}

function blockersForRequirements(requirements: ExecutionReadinessRequirement[]) {
  const blockers = requirements.flatMap((requirement) => requirement.findings
    .filter((finding) => finding.severity === "blocking")
    .map((finding) => createExecutionPromotionBlocker({
      blocker_type: blockerTypeForFinding(finding.code),
      severity: "blocking",
      reason: finding.message,
      refs: finding.refs
    })));
  return blockers;
}

function blockerTypeForFinding(code: ExecutionReadinessFinding["code"]) {
  if (code === "context_missing") return "missing_context";
  if (code === "prompt_missing" || code === "prompt_quality_blocked") return "missing_prompt";
  if (code === "validation_strategy_missing" || code === "validation_strategy_insufficient") return "missing_validation";
  if (code === "success_criteria_missing") return "missing_success_criteria";
  if (code === "stop_conditions_missing") return "missing_stop_conditions";
  if (code === "locks_missing") return "missing_locks";
  if (code === "forbidden_file_conflict") return "forbidden_file_conflict";
  if (code === "cycle_blocker") return "cycle";
  if (code === "node_status_allowed") return "duplicate_or_rejected";
  if (code === "read_only_write_intent") return "unsafe_read_only_write_intent";
  if (code === "review_policy_missing") return "review_policy_missing";
  return "missing_context";
}

function requirement(
  requirement_type: ExecutionReadinessRequirement["requirement_type"],
  status: ExecutionReadinessRequirement["status"],
  summary: string,
  refs: string[],
  findings: ExecutionReadinessFinding[],
  artifact_ref?: string
) {
  return createExecutionReadinessRequirement({ requirement_type, status, summary, refs: uniqueStrings(refs), findings, artifact_ref });
}

function finding(code: ExecutionReadinessFinding["code"], severity: ExecutionReadinessFinding["severity"], message: string, refs: string[]) {
  return createExecutionReadinessFinding({ code, severity, message, refs: uniqueStrings(refs) });
}

function validationRefs(node: ProposedTaskGraphNode) {
  return uniqueStrings([
    ...(node.validation_strategy?.commands ?? []),
    ...(node.validation_strategy?.required_checks ?? []),
    ...(node.validation_strategy?.artifact_refs ?? [])
  ]);
}

function confidenceFor(requirements: ExecutionReadinessRequirement[], warnings: ExecutionReadinessFinding[]) {
  const failed = requirements.filter((requirement) => requirement.status === "failed").length;
  return Math.max(0.1, Math.min(1, 1 - failed * 0.2 - warnings.length * 0.05));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}
