import { randomUUID } from "node:crypto";
import type {
  AgentRun,
  AgentRuntimeSession,
  CommandExecutionRecord,
  CommandRequest,
  DecisionRecord,
  DurableRuntimeEvent,
  EvidenceRef,
  PatchProposal,
  ReconciliationReport,
  ReviewGateSummary,
  RunPhase,
  RuntimeRestoreDisposition,
  RuntimeRestoreState,
  VerificationResult
} from "@hivo/protocol";

export type ReplayRestoreResult = {
  session?: AgentRuntimeSession;
  restoreState: RuntimeRestoreState;
};

export function replaySessionFromDurableEvents(events: DurableRuntimeEvent[]): ReplayRestoreResult {
  if (!events.length) {
    return {
      restoreState: {
        source: "event_replayed",
        disposition: "non_restorable",
        warnings: ["No durable runtime events were available for replay."],
        reason: "Durable runtime event history is empty.",
        eventCount: 0
      }
    };
  }

  const orderingIssue = validateEventOrdering(events);
  if (orderingIssue) {
    return {
      restoreState: {
        source: "event_replayed",
        disposition: "corrupt",
        warnings: [orderingIssue],
        reason: "Durable runtime event ordering is invalid.",
        eventCount: events.length,
        lastEventSequence: events.at(-1)?.sequence
      }
    };
  }

  const createdEvent = events.find((event) => event.type === "session.created");
  const baseSession = createdEvent ? buildBaseSession(createdEvent) : undefined;
  if (!baseSession) {
    return {
      restoreState: {
        source: "event_replayed",
        disposition: "non_restorable",
        warnings: [
          "Durable runtime events exist, but session.created did not include enough metadata to rebuild a session safely."
        ],
        reason: "Replay foundation is present, but this session still needs snapshot metadata fallback.",
        eventCount: events.length,
        lastEventSequence: events.at(-1)?.sequence
      }
    };
  }

  const warnings: string[] = [];
  let sawVerificationStarted = false;
  let sawVerificationCompleted = false;
  let sawReconciliationRequired = false;

  for (const event of events) {
    applyEventToSession(baseSession, event, warnings);
    if (event.type === "verification.started") sawVerificationStarted = true;
    if (event.type === "verification.completed") sawVerificationCompleted = true;
    if (event.type === "session.reconciliation_required") sawReconciliationRequired = true;
  }

  const disposition = deriveRestoreDisposition(baseSession, {
    warnings,
    sawVerificationStarted,
    sawVerificationCompleted,
    sawReconciliationRequired
  });

  const restoreState: RuntimeRestoreState = {
    source: "event_replayed",
    disposition,
    warnings,
    reason: buildRestoreReason(disposition, warnings),
    restoredAt: new Date().toISOString(),
    eventCount: events.length,
    lastEventSequence: events.at(-1)?.sequence
  };

  baseSession.taskState.restoreState = restoreState;
  synchronizeSessionForDisposition(baseSession, disposition);
  appendReplayRestoreTransition(baseSession, restoreState.reason ?? "Session restored from durable runtime events.");
  baseSession.updatedAt = events.at(-1)?.createdAt ?? baseSession.updatedAt;

  return {
    session: baseSession,
    restoreState
  };
}

function validateEventOrdering(events: DurableRuntimeEvent[]) {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.sequence <= events[index - 1]!.sequence) {
      return "Durable runtime events are not strictly ordered by increasing session sequence.";
    }
  }
  return undefined;
}

function buildBaseSession(event: DurableRuntimeEvent) {
  const snapshot = event.payload.session;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const session = structuredClone(snapshot) as AgentRuntimeSession;
  normalizeSession(session);
  session.taskState.restoreState = {
    source: "event_replayed",
    disposition: "resumable",
    warnings: [],
    reason: "Session restored from durable runtime events.",
    restoredAt: event.createdAt,
    eventCount: 1,
    lastEventSequence: event.sequence
  };
  return session;
}

function normalizeSession(session: AgentRuntimeSession) {
  session.runPhases ??= [];
  session.decisionLedger ??= [];
  session.messages ??= [];
  session.tasks ??= [];
  session.toolCalls ??= [];
  session.toolIntents ??= [];
  session.artifacts ??= [];
  session.patchProposals ??= [];
  session.commandRequests ??= [];
  session.commandExecutions ??= [];
  session.backgroundJobs ??= [];
  session.reasoningSummaries ??= [];
  session.progressEvents ??= [];
  session.agentWorkStatuses ??= [];
  session.taskState ??= {
    version: 1,
    phase: "created",
    pendingCommandIds: [],
    completedCommandIds: [],
    failedCommandIds: [],
    transitions: []
  };
  session.taskState.pendingCommandIds ??= [];
  session.taskState.completedCommandIds ??= [];
  session.taskState.failedCommandIds ??= [];
  session.taskState.transitions ??= [];
  if (session.orchestration) {
    session.orchestration.agentRuns ??= [];
    session.orchestration.workerOutputs ??= [];
    session.orchestration.securityReviews ??= [];
    session.orchestration.reviewerSummaries ??= [];
    session.orchestration.orchestrationEvents ??= [];
    session.orchestration.approvalDecisions ??= [];
    session.orchestration.lockedFiles ??= {};
    session.orchestration.selectedWorkerAgents ??= [];
    session.orchestration.mandatoryGateAgents ??= [];
    session.orchestration.workOrders ??= [];
    session.orchestration.qualityGateResults ??= [];
  }
}

function applyEventToSession(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const payload = event.payload;
  if (payload.__payloadMalformed === true) {
    warnings.push(`Malformed durable payload for ${event.type} at sequence ${event.sequence}.`);
    return;
  }

  switch (event.type) {
    case "session.restored":
      session.status = "restored";
      session.taskState.phase = "restored";
      break;
    case "intent_contract.compiled": {
      const intentContract = payload.intentContract;
      if (isObject(intentContract) && typeof intentContract.contract_id === "string") {
        const typedContract = intentContract as import("@hivo/protocol").IntentContract;
        session.intentContract = typedContract;
        session.intent_contract_ref = typedContract.artifact_ref;
        session.intent_contract_status = typedContract.status;
        session.reasoningSummaries.push(`Restored intent contract ${typedContract.contract_id} with status ${typedContract.status}.`);
      } else {
        warnings.push(`intent_contract.compiled at sequence ${event.sequence} did not include a canonical IntentContract.`);
      }
      break;
    }
    case "session.expired":
      session.status = "expired";
      session.lifecycleStage = "BLOCKED";
      session.taskState.phase = "expired";
      break;
    case "product_spec.proposed":
    case "product_spec.approved": {
      const productSpec = payload.productSpec;
      if (isObject(productSpec) && typeof productSpec.id === "string") {
        session.recursiveFactory ??= { phase: "product_spec_approval", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.productSpec = productSpec as import("@hivo/protocol").ProductSpecification;
        session.recursiveFactory.phase = event.type === "product_spec.approved" ? "technical_plan_approval" : "product_spec_approval";
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = "needs_approval";
        session.lifecycleStage = "PLAN";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical Product Specification.`);
      }
      break;
    }
    case "technical_plan.proposed":
    case "technical_plan.approved": {
      const technicalPlan = payload.technicalPlan;
      if (isObject(technicalPlan) && typeof technicalPlan.id === "string") {
        session.recursiveFactory ??= { phase: "technical_plan_approval", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.technicalPlan = technicalPlan as import("@hivo/protocol").TechnicalPlan;
        session.recursiveFactory.phase = event.type === "technical_plan.approved" ? "approved_to_execute" : "technical_plan_approval";
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = event.type === "technical_plan.approved" ? "completed" : "needs_approval";
        session.lifecycleStage = event.type === "technical_plan.approved" ? "DONE" : "PLAN";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical Technical Plan.`);
      }
      break;
    }
    case "recursive_graph.proposed":
    case "recursive_graph.ready":
    case "recursive_graph.blocked": {
      const graph = payload.graph;
      if (isObject(graph) && typeof graph.id === "string") {
        const typedGraph = graph as import("@hivo/protocol").HierarchicalRecursiveGraph;
        session.recursiveFactory ??= { phase: "recursive_graph_ready", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.recursiveGraph = typedGraph;
        session.recursiveFactory.branchOrchestrators = typedGraph.branches;
        session.recursiveFactory.branchScopeConflicts = typedGraph.conflicts;
        session.recursiveFactory.graphReadiness = typedGraph.readiness;
        session.recursiveFactory.phase = typedGraph.status === "blocked" ? "recursive_graph_blocked" : "recursive_graph_ready";
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = typedGraph.status === "blocked" ? "blocked" : "completed";
        session.lifecycleStage = typedGraph.status === "blocked" ? "BLOCKED" : "DONE";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical recursive graph.`);
      }
      break;
    }
    case "branch_orchestrator.planned": {
      const branch = payload.branch;
      if (isObject(branch) && typeof branch.branchId === "string") {
        session.recursiveFactory ??= { phase: "recursive_graph_ready", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.branchOrchestrators ??= [];
        upsertBranchById(session.recursiveFactory.branchOrchestrators, branch as import("@hivo/protocol").BranchOrchestratorRecord);
      } else {
        warnings.push(`branch_orchestrator.planned at sequence ${event.sequence} did not include a canonical branch.`);
      }
      break;
    }
    case "branch_scope.conflict_detected": {
      const conflict = payload.conflict;
      if (isObject(conflict) && typeof conflict.id === "string") {
        session.recursiveFactory ??= { phase: "recursive_graph_blocked", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.branchScopeConflicts ??= [];
        upsertById(session.recursiveFactory.branchScopeConflicts, conflict as import("@hivo/protocol").BranchScopeConflict);
      } else {
        warnings.push(`branch_scope.conflict_detected at sequence ${event.sequence} did not include a canonical conflict.`);
      }
      break;
    }
    case "branch_execution.ready":
    case "branch_execution.started":
    case "branch_execution.patch_proposed":
    case "branch_execution.reviewing":
    case "branch_execution.validation_pending":
    case "branch_execution.completed":
    case "branch_execution.blocked":
    case "branch_execution.failed": {
      const branchExecution = payload.branchExecution;
      if (isObject(branchExecution) && typeof branchExecution.branchId === "string") {
        const typedBranch = branchExecution as import("@hivo/protocol").RecursiveBranchExecutionRecord;
        session.recursiveFactory ??= { phase: "branch_execution_running", executionStarted: true, updatedAt: event.createdAt };
        session.recursiveFactory.branchExecutions ??= [];
        upsertBranchExecutionById(session.recursiveFactory.branchExecutions, typedBranch);
        session.recursiveFactory.executionStarted = true;
        session.recursiveFactory.activeBranchId = typedBranch.active ? typedBranch.branchId : session.recursiveFactory.activeBranchId;
        session.recursiveFactory.phase =
          typedBranch.status === "completed"
            ? "branch_execution_completed"
            : typedBranch.status === "blocked" || typedBranch.status === "failed"
              ? "branch_execution_blocked"
              : "branch_execution_running";
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = typedBranch.status === "completed" ? "completed" : typedBranch.status === "failed" ? "failed" : typedBranch.status === "blocked" ? "blocked" : "needs_approval";
        session.lifecycleStage = typedBranch.status === "completed" ? "DONE" : typedBranch.status === "failed" ? "FAILED" : typedBranch.status === "blocked" ? "BLOCKED" : "APPROVAL";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical branch execution.`);
      }
      break;
    }
    case "branch_result.recorded": {
      const branchResult = payload.branchResult;
      if (isObject(branchResult) && typeof branchResult.id === "string") {
        session.recursiveFactory ??= { phase: "branch_execution_running", executionStarted: true, updatedAt: event.createdAt };
        session.recursiveFactory.branchResults ??= [];
        upsertById(session.recursiveFactory.branchResults, branchResult as import("@hivo/protocol").RecursiveBranchResultRecord);
        session.recursiveFactory.updatedAt = event.createdAt;
      } else {
        warnings.push(`branch_result.recorded at sequence ${event.sequence} did not include a canonical branch result.`);
      }
      break;
    }
    case "semantic_conflict_resolution.updated": {
      const batch = payload.batch;
      if (isObject(batch) && typeof batch.batch_id === "string") {
        session.recursiveFactory ??= { phase: "branch_execution_running", executionStarted: true, updatedAt: event.createdAt };
        session.recursiveFactory.semanticConflictBatches ??= [];
        session.recursiveFactory.semanticConflictDecisions ??= [];
        upsertById(session.recursiveFactory.semanticConflictBatches, batch as import("@hivo/protocol").SemanticConflictResolutionBatch);
        const decisions = Array.isArray((batch as { decisions?: unknown }).decisions)
          ? (batch as { decisions: unknown[] }).decisions
          : [];
        for (const decision of decisions) {
          if (isObject(decision) && typeof decision.decision_id === "string") {
            upsertById(session.recursiveFactory.semanticConflictDecisions, decision as import("@hivo/protocol").SemanticConflictDecision);
          }
        }
        session.recursiveFactory.updatedAt = event.createdAt;
      } else {
        warnings.push(`semantic_conflict_resolution.updated at sequence ${event.sequence} did not include a canonical batch.`);
      }
      break;
    }
    case "recursive_fan_in.updated": {
      const integrationSummary = payload.integrationSummary;
      if (isObject(integrationSummary) && typeof integrationSummary.id === "string") {
        session.recursiveFactory ??= { phase: "branch_execution_running", executionStarted: true, updatedAt: event.createdAt };
        session.recursiveFactory.integrationSummary = integrationSummary as import("@hivo/protocol").RecursiveIntegrationSummary;
        session.recursiveFactory.validationHierarchy ??= [];
        upsertById(session.recursiveFactory.validationHierarchy, session.recursiveFactory.integrationSummary.validation);
        session.recursiveFactory.updatedAt = event.createdAt;
      } else {
        warnings.push(`recursive_fan_in.updated at sequence ${event.sequence} did not include a canonical integration summary.`);
      }
      break;
    }
    case "recursive_final_report.created": {
      const finalReport = payload.finalReport;
      if (isObject(finalReport) && typeof finalReport.id === "string") {
        session.recursiveFactory ??= { phase: "branch_execution_running", executionStarted: true, updatedAt: event.createdAt };
        const typedReport = finalReport as import("@hivo/protocol").RecursiveFinalReport;
        session.recursiveFactory.finalReport = typedReport;
        session.recursiveFactory.branchResults = typedReport.branchOutcomes;
        session.recursiveFactory.validationHierarchy = typedReport.validationHierarchy;
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = typedReport.finalStatus === "passed" ? "completed" : typedReport.finalStatus === "failed" ? "failed" : "needs_approval";
        session.lifecycleStage = typedReport.finalStatus === "passed" ? "DONE" : typedReport.finalStatus === "failed" ? "FAILED" : "POST_VERIFY";
      } else {
        warnings.push(`recursive_final_report.created at sequence ${event.sequence} did not include a canonical final report.`);
      }
      break;
    }
    case "knowledge_tree.created":
    case "knowledge_tree.refreshed": {
      const tree = payload.tree;
      if (isObject(tree) && typeof tree.id === "string") {
        session.projectKnowledgeTree = tree as import("@hivo/protocol").ProjectKnowledgeTree;
        session.status = "completed";
        session.lifecycleStage = "PLAN";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical Project Knowledge Tree.`);
      }
      break;
    }
    case "edit_route.proposed":
    case "edit_route.ready":
    case "edit_route.blocked": {
      const routedEdit = payload.routedEdit;
      if (isObject(routedEdit) && typeof routedEdit.id === "string") {
        session.latestKnowledgeRoute = routedEdit as import("@hivo/protocol").KnowledgeRoutedEdit;
        session.latestKnowledgeBranchTargets = session.latestKnowledgeRoute.knowledgeBranchTargets;
        session.status = event.type === "edit_route.blocked" ? "blocked" : "completed";
        session.lifecycleStage = "PLAN";
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical knowledge edit route.`);
      }
      break;
    }
    case "knowledge_branch_targets.created": {
      const targets = payload.targets;
      if (Array.isArray(targets)) {
        session.latestKnowledgeBranchTargets = targets as import("@hivo/protocol").KnowledgeBranchTarget[];
        if (session.latestKnowledgeRoute) {
          session.latestKnowledgeRoute.knowledgeBranchTargets = session.latestKnowledgeBranchTargets;
          session.latestKnowledgeRoute.plan.knowledgeBranchTargets = session.latestKnowledgeBranchTargets;
          session.latestKnowledgeRoute.plan.suggestedBranchTargets = session.latestKnowledgeBranchTargets;
        }
        session.status = "completed";
        session.lifecycleStage = "PLAN";
      } else {
        warnings.push(`knowledge_branch_targets.created at sequence ${event.sequence} did not include canonical branch targets.`);
      }
      break;
    }
    case "knowledge_branch_execution.planned": {
      const branchExecution = payload.branchExecution;
      if (isObject(branchExecution) && typeof branchExecution.branchId === "string") {
        session.recursiveFactory ??= { phase: "recursive_graph_ready", executionStarted: false, updatedAt: event.createdAt };
        session.recursiveFactory.branchExecutions ??= [];
        upsertBranchExecutionById(session.recursiveFactory.branchExecutions, branchExecution as import("@hivo/protocol").RecursiveBranchExecutionRecord);
        session.recursiveFactory.executionStarted = false;
        session.recursiveFactory.updatedAt = event.createdAt;
        session.status = "completed";
        session.lifecycleStage = "PLAN";
      } else {
        warnings.push(`knowledge_branch_execution.planned at sequence ${event.sequence} did not include a canonical branch execution.`);
      }
      break;
    }
    case "run.phase_changed": {
      const phase = payload.phase;
      if (isObject(phase) && typeof phase.id === "string") {
        upsertById(session.runPhases, phase as RunPhase);
      } else {
        warnings.push(`run.phase_changed at sequence ${event.sequence} did not include a canonical phase payload.`);
      }
      break;
    }
    case "agent.created":
    case "agent.updated": {
      const agent = payload.agent ?? payload.agentRun;
      if (isObject(agent) && typeof agent.id === "string") {
        session.orchestration ??= createEmptyOrchestration();
        upsertById(session.orchestration.agentRuns, agent as AgentRun);
      } else {
        warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical agent payload.`);
      }
      break;
    }
    case "decision.recorded": {
      const record = payload.decision ?? payload.record;
      if (isObject(record) && typeof record.id === "string") {
        upsertById(session.decisionLedger, record as DecisionRecord);
      } else {
        warnings.push(`decision.recorded at sequence ${event.sequence} did not include a canonical decision payload.`);
      }
      break;
    }
    case "evidence.recorded": {
      const evidence = payload.evidenceRef ?? payload.evidence;
      if (isObject(evidence) && typeof evidence.type === "string") {
        attachEvidenceRef(session, evidence as EvidenceRef, warnings, event.sequence);
      } else {
        warnings.push(`evidence.recorded at sequence ${event.sequence} did not include a canonical evidence payload.`);
      }
      break;
    }
    case "patch.proposed": {
      const proposal = payload.proposal ?? payload.patch;
      if (isObject(proposal) && typeof proposal.id === "string") {
        upsertById(session.patchProposals, proposal as PatchProposal);
        session.taskState.pendingPatchId = String(proposal.id);
        session.taskState.activePatchId = String(proposal.id);
      } else {
        warnings.push(`patch.proposed at sequence ${event.sequence} did not include a canonical patch payload.`);
      }
      break;
    }
    case "patch.approved":
    case "patch.rejected":
    case "patch.applied":
    case "patch.apply_failed":
    case "patch.apply_started":
      applyPatchLifecycleEvent(session, event, warnings);
      break;
    case "patch.reconciled": {
      const report = payload.reconciliation ?? payload.report;
      if (isObject(report) && typeof report.status === "string") {
        session.reconciliationReport = report as ReconciliationReport;
      } else {
        warnings.push(`patch.reconciled at sequence ${event.sequence} did not include a canonical reconciliation payload.`);
      }
      break;
    }
    case "command.requested":
    case "command.approved":
    case "command.denied":
      applyCommandRequestEvent(session, event, warnings);
      break;
    case "command.started":
    case "command.completed":
    case "command.failed":
      applyCommandExecutionEvent(session, event, warnings);
      break;
    case "verification.started":
    case "verification.completed":
      applyVerificationEvent(session, event, warnings);
      break;
    case "verification.check_completed":
      applyVerificationCheckEvent(session, event, warnings);
      break;
    case "review_gate.updated": {
      const reviewGate = payload.reviewGate ?? payload.summary;
      if (isObject(reviewGate) && typeof reviewGate.summary === "string") {
        session.reviewGate = reviewGate as ReviewGateSummary;
      } else {
        warnings.push(`review_gate.updated at sequence ${event.sequence} did not include a canonical review gate payload.`);
      }
      break;
    }
    case "session.reconciliation_required":
      if (typeof payload.reason === "string") {
        warnings.push(payload.reason);
      } else {
        warnings.push("Durable history marked this session as needing reconciliation before it can be trusted.");
      }
      break;
    default:
      break;
  }
}

function applyPatchLifecycleEvent(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const payload = event.payload;
  const proposal = payload.proposal ?? payload.patch;
  const patchId = readString(payload.patchId) ?? (isObject(proposal) ? readString((proposal as Record<string, unknown>).id) : undefined);
  if (!patchId) {
    warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical patch identifier.`);
    return;
  }
  const patch = ensurePatchProposal(session, patchId, proposal, warnings, event.sequence);
  if (!patch) return;

  switch (event.type) {
    case "patch.approved":
      patch.status = "approved";
      session.taskState.pendingPatchId = undefined;
      session.taskState.activePatchId = patchId;
      break;
    case "patch.rejected":
      patch.status = "rejected";
      session.taskState.pendingPatchId = undefined;
      session.taskState.activePatchId = patchId;
      break;
    case "patch.apply_started":
      patch.status = "apply_started";
      session.taskState.activePatchId = patchId;
      break;
    case "patch.applied":
      patch.status = "applied";
      patch.appliedAt ??= event.createdAt;
      session.taskState.pendingPatchId = undefined;
      session.taskState.activePatchId = patchId;
      break;
    case "patch.apply_failed":
      patch.status = "apply_failed";
      session.taskState.pendingPatchId = undefined;
      session.taskState.activePatchId = patchId;
      break;
    default:
      break;
  }
}

function applyCommandRequestEvent(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const payload = event.payload;
  const requestPayload = payload.commandRequest ?? payload.request;
  if (!(isObject(requestPayload) && typeof requestPayload.id === "string")) {
    warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical command request payload.`);
    return;
  }
  const request = requestPayload as CommandRequest;
  upsertById(session.commandRequests, request);
  if (event.type === "command.requested" && !session.taskState.pendingCommandIds.includes(request.id)) {
    session.taskState.pendingCommandIds.push(request.id);
  }
  if (event.type === "command.denied") {
    request.status = "denied";
    session.taskState.pendingCommandIds = session.taskState.pendingCommandIds.filter((id) => id !== request.id);
    if (!session.taskState.failedCommandIds.includes(request.id)) {
      session.taskState.failedCommandIds.push(request.id);
    }
  }
}

function applyCommandExecutionEvent(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const execution = readExecutionPayload(event.payload);
  if (!execution) {
    warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical command execution payload.`);
    return;
  }
  upsertById(session.commandExecutions, execution);
  if (execution.backgroundJob) {
    upsertBackgroundJob(session.backgroundJobs, execution.backgroundJob);
  }
  if (execution.requestId) {
    const request = session.commandRequests.find((candidate) => candidate.id === execution.requestId);
    if (request) {
      request.status =
        event.type === "command.started"
          ? "executing"
          : event.type === "command.completed"
            ? "executed"
            : "failed";
    }
    if (event.type === "command.started") {
      if (!session.taskState.pendingCommandIds.includes(execution.requestId)) {
        session.taskState.pendingCommandIds.push(execution.requestId);
      }
    } else {
      session.taskState.pendingCommandIds = session.taskState.pendingCommandIds.filter((id) => id !== execution.requestId);
      if (event.type === "command.completed") {
        if (!session.taskState.completedCommandIds.includes(execution.requestId)) {
          session.taskState.completedCommandIds.push(execution.requestId);
        }
      } else if (!session.taskState.failedCommandIds.includes(execution.requestId)) {
        session.taskState.failedCommandIds.push(execution.requestId);
      }
    }
  }
}

function applyVerificationEvent(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const verification = event.payload.verification;
  if (!(isObject(verification) && Array.isArray((verification as VerificationResult).checks))) {
    warnings.push(`${event.type} at sequence ${event.sequence} did not include a canonical verification payload.`);
    return;
  }
  session.verificationResult = verification as VerificationResult;
}

function applyVerificationCheckEvent(session: AgentRuntimeSession, event: DurableRuntimeEvent, warnings: string[]) {
  const check = event.payload.check;
  if (!(isObject(check) && typeof check.name === "string")) {
    warnings.push(`verification.check_completed at sequence ${event.sequence} did not include a canonical check payload.`);
    return;
  }
  session.verificationResult ??= {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    status: "pending",
    checks: [],
    summary: "Verification replay is in progress.",
    createdAt: event.createdAt
  };
  const checks = session.verificationResult.checks;
  const index = checks.findIndex((candidate) => candidate.id === check.id || candidate.name === check.name);
  if (index >= 0) {
    checks[index] = { ...checks[index], ...(check as VerificationResult["checks"][number]) };
  } else {
    checks.push(check as VerificationResult["checks"][number]);
  }
}

function attachEvidenceRef(
  session: AgentRuntimeSession,
  evidence: EvidenceRef,
  warnings: string[],
  sequence: number
) {
  if (evidence.linkedDecisionId) {
    const decision = session.decisionLedger.find((record) => record.id === evidence.linkedDecisionId);
    if (decision) {
      decision.evidenceRefs = [...decision.evidenceRefs, evidence];
      return;
    }
  }
  warnings.push(`evidence.recorded at sequence ${sequence} could not be attached to a decision and remains standalone.`);
}

function ensurePatchProposal(
  session: AgentRuntimeSession,
  patchId: string,
  candidate: unknown,
  warnings: string[],
  sequence: number
) {
  const existing = session.patchProposals.find((proposal) => proposal.id === patchId);
  if (existing) return existing;
  if (isObject(candidate) && typeof candidate.id === "string") {
    const proposal = candidate as PatchProposal;
    session.patchProposals.push(proposal);
    return proposal;
  }
  warnings.push(`Patch lifecycle event at sequence ${sequence} referenced ${patchId}, but no canonical proposal payload was available.`);
  return undefined;
}

function readExecutionPayload(payload: Record<string, unknown>) {
  const execution = payload.execution;
  if (isObject(execution) && typeof execution.id === "string") {
    return execution as CommandExecutionRecord;
  }
  const result = payload.result;
  const requestId = readString(payload.requestId);
  if (isObject(result) && typeof result.command === "string" && typeof result.status === "string") {
    return {
      id: `exec_${requestId ?? randomUUID()}`,
      sessionId: readString(payload.sessionId) ?? "unknown_session",
      requestId,
      autoRun: false,
      command: result.command as string,
      cwd: readString((result as Record<string, unknown>).cwd) ?? "",
      risk: ((result as Record<string, unknown>).risk as CommandExecutionRecord["risk"]) ?? "medium",
      status: result.status as CommandExecutionRecord["status"],
      exitCode: typeof (result as Record<string, unknown>).exitCode === "number" ? ((result as Record<string, unknown>).exitCode as number) : undefined,
      stdout: readString((result as Record<string, unknown>).stdout) ?? "",
      stderr: readString((result as Record<string, unknown>).stderr) ?? "",
      message: readString((result as Record<string, unknown>).message),
      provenance: isObject((result as Record<string, unknown>).provenance)
        ? ((result as Record<string, unknown>).provenance as CommandExecutionRecord["provenance"])
        : undefined,
      backgroundJob: isObject((result as Record<string, unknown>).backgroundJob)
        ? ((result as Record<string, unknown>).backgroundJob as CommandExecutionRecord["backgroundJob"])
        : undefined,
      createdAt: readString((result as Record<string, unknown>).createdAt) ?? new Date().toISOString()
    } satisfies CommandExecutionRecord;
  }
  return undefined;
}

function deriveRestoreDisposition(
  session: AgentRuntimeSession,
  context: {
    warnings: string[];
    sawVerificationStarted: boolean;
    sawVerificationCompleted: boolean;
    sawReconciliationRequired: boolean;
  }
): RuntimeRestoreDisposition {
  if (context.warnings.some((warning) => /Malformed durable payload|did not include a canonical|not strictly ordered/i.test(warning))) {
    return "corrupt";
  }
  if (session.status === "expired" || session.taskState.phase === "expired") {
    return "expired";
  }

  const reconciliation = session.reconciliationReport;
  const hasApplyStartedTransition = session.taskState.transitions.some((transition) => transition.type === "patch.applied")
    || session.taskState.activePatchId !== undefined
    || session.patchProposals.some((proposal) => proposal.status === "approved" || proposal.status === "applied" || proposal.status === "apply_failed");
  const hasAppliedPatch = session.patchProposals.some((proposal) => proposal.status === "applied");
  const hasApplyFailure = session.patchProposals.some((proposal) => proposal.status === "apply_failed");
  const startedWithoutTerminalCommand = session.commandExecutions.some(
    (execution) => execution.status === "executing" || execution.status === "running" || execution.status === "orphaned"
  ) || session.commandRequests.some((request) => request.status === "executing" || request.status === "running" || request.status === "orphaned");
  const verificationPassed = session.verificationResult?.status === "passed";

  if (hasApplyFailure || session.status === "failed" || session.verificationResult?.status === "failed") {
    return "terminal";
  }
  if (
    context.sawReconciliationRequired ||
    (hasApplyStartedTransition && !hasAppliedPatch && !hasApplyFailure) ||
    (hasAppliedPatch && !reconciliation) ||
    reconciliation?.status === "pending" ||
    reconciliation?.status === "unavailable" ||
    reconciliation?.status === "diverged" ||
    reconciliation?.status === "failed" ||
    startedWithoutTerminalCommand ||
    (context.sawVerificationStarted && !context.sawVerificationCompleted)
  ) {
    return "reconciliation_required";
  }
  if (session.status === "completed" || session.status === "blocked" || (hasAppliedPatch && reconciliation?.status === "matched" && verificationPassed)) {
    return "terminal";
  }
  return "resumable";
}

function buildRestoreReason(disposition: RuntimeRestoreDisposition, warnings: string[]) {
  switch (disposition) {
    case "resumable":
      return "Session was rebuilt from durable runtime events and can resume conservatively.";
    case "terminal":
      return "Session was rebuilt from durable runtime events, but it is already terminal and should not resume active work.";
    case "expired":
      return "Session was rebuilt from durable runtime events and is expired.";
    case "corrupt":
      return warnings[0] ?? "Durable runtime events were malformed or incomplete.";
    case "reconciliation_required":
      return warnings[0] ?? "Durable runtime history indicates incomplete mutation, command, or verification state. Manual inspection is required.";
    case "orphaned":
      return "Session identifier exists without corresponding durable runtime truth.";
    case "non_restorable":
      return warnings[0] ?? "Durable runtime events were insufficient to restore this session safely.";
    default:
      return "Restore status is unknown.";
  }
}

function synchronizeSessionForDisposition(session: AgentRuntimeSession, disposition: RuntimeRestoreDisposition) {
  if (disposition === "reconciliation_required") {
    for (const job of session.backgroundJobs ?? []) {
      if (job.status === "running") {
        job.status = "orphaned";
        job.lastKnownAt = new Date().toISOString();
      }
    }
    for (const execution of session.commandExecutions) {
      if (execution.status === "running" || execution.status === "executing") {
        execution.status = execution.backgroundJob ? "orphaned" : execution.status;
        if (execution.requestId) {
          const request = session.commandRequests.find((candidate) => candidate.id === execution.requestId);
          if (request && execution.backgroundJob) {
            request.status = "orphaned";
          }
        }
      }
    }
  }
  if (disposition === "expired") {
    session.status = "expired";
    session.lifecycleStage = "BLOCKED";
    session.taskState.phase = "expired";
    return;
  }
  if (disposition === "corrupt" || disposition === "non_restorable") {
    session.status = "failed";
    session.lifecycleStage = "FAILED";
    session.taskState.phase = "failed";
    return;
  }
  if (disposition === "reconciliation_required") {
    session.status = "needs_approval";
    session.lifecycleStage = "BLOCKED";
    if (session.taskState.phase === "completed") {
      session.taskState.phase = "verification_pending";
    }
    return;
  }
  if (disposition === "terminal" && session.status !== "failed" && session.status !== "completed" && session.status !== "blocked") {
    session.status = session.verificationResult?.status === "failed" ? "failed" : "completed";
    session.lifecycleStage = session.status === "failed" ? "FAILED" : "DONE";
    session.taskState.phase = session.status === "failed" ? "failed" : "completed";
    return;
  }
  if (session.status === "created") {
    session.status = "restored";
  }
  if (session.taskState.phase === "created") {
    session.taskState.phase = "restored";
  }
}

function appendReplayRestoreTransition(session: AgentRuntimeSession, detail: string) {
  session.taskState.version += 1;
  session.taskState.transitions.push({
    id: `transition_${randomUUID()}`,
    phase: session.taskState.phase,
    type: "session.restored",
    detail,
    createdAt: new Date().toISOString()
  });
}

function createEmptyOrchestration(): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: {
      blockDangerousCommands: true,
      redactSecrets: true,
      allowNetworkCommands: false,
      autoApplyValidatedPatches: false,
      autoRunSafeCommands: false,
      autoRunMediumCommands: false,
      autoRunBackgroundCommands: false,
      autoRunNetworkCommands: false,
      requireApprovalForPatches: true,
      maxParallelAgents: 3
    },
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}

function upsertById<T extends { id?: string; batch_id?: string; decision_id?: string }>(collection: T[], value: T) {
  const key = value.id ?? value.batch_id ?? value.decision_id;
  const index = collection.findIndex((candidate) => (candidate.id ?? candidate.batch_id ?? candidate.decision_id) === key);
  if (index >= 0) {
    collection[index] = value;
    return;
  }
  collection.push(value);
}

function upsertBranchById(collection: import("@hivo/protocol").BranchOrchestratorRecord[], value: import("@hivo/protocol").BranchOrchestratorRecord) {
  const index = collection.findIndex((candidate) => candidate.branchId === value.branchId);
  if (index >= 0) {
    collection[index] = value;
    return;
  }
  collection.push(value);
}

function upsertBranchExecutionById(collection: import("@hivo/protocol").RecursiveBranchExecutionRecord[], value: import("@hivo/protocol").RecursiveBranchExecutionRecord) {
  const index = collection.findIndex((candidate) => candidate.branchId === value.branchId);
  if (index >= 0) {
    collection[index] = value;
    return;
  }
  collection.push(value);
}

function upsertBackgroundJob(collection: AgentRuntimeSession["backgroundJobs"], value: NonNullable<AgentRuntimeSession["backgroundJobs"]>[number]) {
  const index = collection.findIndex((candidate) => candidate.jobId === value.jobId);
  if (index >= 0) {
    collection[index] = value;
    return;
  }
  collection.push(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
