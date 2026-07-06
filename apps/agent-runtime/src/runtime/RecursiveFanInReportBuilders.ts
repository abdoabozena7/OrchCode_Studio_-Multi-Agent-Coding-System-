import type {
  AgentRuntimeSession,
  BranchOrchestratorRecord,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveBranchResultRecord,
  RecursiveFinalReport,
  RecursiveIntegrationNodeLevel,
  RecursiveIntegrationNodeSummary,
  RecursiveIntegrationSummary,
  RecursivePatchProvenance,
  RecursiveValidationRecord,
  RecursiveValidationStrategy,
  SemanticConflictDecision
} from "@hivo/protocol";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveInsideWorkspace } from "../tools/security.js";
import { evaluateRecursiveBranchValidation } from "./RecursiveBranchValidationService.js";
import { buildNestedRollup } from "./RecursiveNestedRollup.js";

export function buildRecursiveBranchResults(session: AgentRuntimeSession): RecursiveBranchResultRecord[] {
  const factory = session.recursiveFactory;
  if (!factory?.branchExecutions?.length) return [];
  const now = new Date().toISOString();
  return factory.branchExecutions
    .filter((branch) =>
      branch.proposedPatchId
      || branch.patchApplied
      || branch.status === "blocked"
      || branch.status === "blocked_conflict"
      || branch.status === "blocked_failed_dependency"
      || branch.status === "failed"
      || branch.status === "completed"
      || branch.status === "skipped"
    )
    .map((branch) => {
      const branchPatchIds = uniqueRuntimeStrings([
        ...(branch.proposedPatchId ? [branch.proposedPatchId] : []),
        ...(branch.nestedSubtasks ?? []).flatMap((subtask) => subtask.proposedPatchId ? [subtask.proposedPatchId] : [])
      ]);
      const patches = session.patchProposals.filter((patch) => branchPatchIds.includes(patch.id));
      const planned = factory.branchOrchestrators?.find((candidate) => candidate.branchId === branch.branchId);
      const filesChanged = uniqueRuntimeStrings(patches.flatMap((patch) => patch.filesChanged.map((file) => file.path)));
      const patchIds = patches.map((patch) => patch.id);
      const nestedRollup = branch.nestedSubtasks?.length ? buildNestedRollup(branch, session.patchProposals) : branch.nestedRollup;
      const appliedState = branchAppliedState(branch, patches);
      const risksAndLimitations = uniqueRuntimeStrings([
        ...(planned?.risks ?? []),
        branch.blockedReason,
        branch.conflictReason,
        ...(nestedRollup?.limitations ?? []),
        branch.validationStatus === "verified_passed" ? undefined : `Validation truth is ${branch.validationStatus}.`
      ].filter(Boolean) as string[]);
      return {
        id: `branch_result_${session.id}_${branch.branchId}`,
        sessionId: session.id,
        branchId: branch.branchId,
        objective: branch.executionContext.branchObjective,
        patchIds,
        appliedState,
        reviewResult: branch.reviewStatus,
        validationState: branch.validationStatus,
        filesChanged,
        nestedRollup,
        risksAndLimitations,
        evidenceSummary: [
          `Branch status: ${branch.status}.`,
          `Review: ${branch.reviewStatus}.`,
          `Patch truth: ${patches.map((patch) => `${patch.id}=${patch.status}`).join(", ") || "no patch proposed"}.`,
          `Applied state: ${appliedState}.`,
          `Validation: ${branch.validationStatus}.`,
          ...(nestedRollup ? [`Nested subtasks: completed=${nestedRollup.completedSubtasks.length}, failed=${nestedRollup.failedSubtasks.length}, blocked=${nestedRollup.blockedSubtasks.length}.`] : [])
        ],
        createdAt: branch.createdAt,
        updatedAt: now
      };
    });
}

export function buildRecursiveBranchValidationRecords(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]): RecursiveValidationRecord[] {
  const now = new Date().toISOString();
  return branchResults.map((result) => {
    const evaluation = evaluateRecursiveBranchValidation(session, result.branchId);
    const status = validationRecordStatus(result.validationState);
    return {
      id: `recursive_validation_branch_${session.id}_${result.branchId}`,
      sessionId: session.id,
      level: "branch_validation",
      branchId: result.branchId,
      truthStatus: result.validationState,
      status,
      summary: status === "passed"
        ? `Branch ${result.branchId} validation passed: ${evaluation.summary}`
        : status === "failed"
          ? `Branch ${result.branchId} validation failed: ${evaluation.summary}`
          : `Branch ${result.branchId} validation is ${result.validationState}; ${evaluation.summary}`,
      blockingReasons: status === "passed" ? [] : result.risksAndLimitations,
      evidenceRefs: [
        ...result.patchIds.map((patchId) => `patch:${patchId}`),
        ...result.filesChanged.map((file) => `file:${file}`),
        ...evaluation.evidence.map((entry) => entry.executionId ? `command_execution:${entry.executionId}` : entry.kind === "patch_effect" ? "patch_effect:evidence" : "validation:evidence")
      ],
      discoveredCommands: evaluation.discoveredCommands,
      selectedStrategy: evaluation.strategy,
      evidence: evaluation.evidence,
      createdAt: result.createdAt,
      updatedAt: now
    };
  });
}

export function buildRecursiveIntegrationSummary(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  branchValidations: RecursiveValidationRecord[]
): RecursiveIntegrationSummary {
  const now = new Date().toISOString();
  const factory = session.recursiveFactory;
  const completedBranches = branchResults
    .filter((result) => branchValidations.find((validation) => validation.branchId === result.branchId)?.status === "passed")
    .map((result) => result.branchId);
  const failedBranches = branchResults
    .filter((result) => result.appliedState === "apply_failed" || result.validationState === "verified_failed")
    .map((result) => result.branchId);
  const blockedBranches = branchResults
    .filter((result) => {
      const branch = factory?.branchExecutions?.find((candidate) => candidate.branchId === result.branchId);
      return result.reviewResult === "blocked"
        || result.reviewResult === "needs_changes"
        || branch?.status === "blocked"
        || branch?.status === "blocked_conflict"
        || branch?.status === "blocked_failed_dependency"
        || branch?.status === "skipped";
    })
    .map((result) => result.branchId);
  const unverifiedBranches = branchResults
    .filter((result) => !completedBranches.includes(result.branchId) && !failedBranches.includes(result.branchId) && !blockedBranches.includes(result.branchId))
    .map((result) => result.branchId);
  const conflictsUnresolved = (factory?.branchScopeConflicts ?? [])
    .filter((conflict) => conflict.severity === "blocking")
    .map((conflict) => `${conflict.code}: ${conflict.reason}`);
  const conflictsResolved = (factory?.branchScopeConflicts ?? [])
    .filter((conflict) => conflict.severity !== "blocking")
    .map((conflict) => `${conflict.code}: ${conflict.reason}`);
  const status =
    failedBranches.length
      ? "failed"
      : blockedBranches.length || unverifiedBranches.length || conflictsUnresolved.length
        ? "unverified"
        : "passed";
  const truthStatus =
    status === "passed"
      ? "verified_passed"
      : status === "failed"
        ? worstRecursiveTruth(branchResults.map((result) => result.validationState), "verified_failed")
        : worstRecursiveTruth(branchResults.map((result) => result.validationState), "unverified");
  const validation: RecursiveValidationRecord = {
    id: `recursive_validation_integration_${session.id}`,
    sessionId: session.id,
    level: "integration_validation",
    truthStatus,
    status,
    summary:
      status === "passed"
        ? "All branch results are verified and no unresolved conflicts remain."
        : status === "failed"
          ? "One or more branch results failed, so integration validation cannot pass."
          : "Integration validation is unverified because at least one branch or conflict remains unresolved.",
    blockingReasons: uniqueRuntimeStrings([
      ...failedBranches.map((branchId) => `Failed branch: ${branchId}`),
      ...blockedBranches.map((branchId) => `Blocked branch: ${branchId}`),
      ...unverifiedBranches.map((branchId) => `Unverified branch: ${branchId}`),
      ...conflictsUnresolved
    ]),
    evidenceRefs: branchResults.flatMap((result) => result.patchIds.map((patchId) => `patch:${patchId}`)),
    discoveredCommands: branchValidations.flatMap((validation) => validation.discoveredCommands ?? []),
    selectedStrategy: selectIntegrationStrategy(branchValidations),
    evidence: branchValidations.flatMap((validation) => validation.evidence ?? []),
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
  const integrationHierarchy = buildRecursiveIntegrationHierarchy(
    session,
    branchResults,
    branchValidations,
    validation,
    conflictsResolved,
    conflictsUnresolved,
    now
  );
  return {
    id: `recursive_fan_in_${session.id}`,
    sessionId: session.id,
    completedBranches,
    blockedBranches,
    failedBranches,
    unverifiedBranches,
    conflictsResolved,
    conflictsUnresolved,
    integrationRisks: uniqueRuntimeStrings([
      ...branchResults.flatMap((result) => result.risksAndLimitations),
      ...validation.blockingReasons
    ]),
    remainingManualSteps: remainingRecursiveManualSteps(validation, branchResults),
    validation,
    integrationHierarchy,
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

export function buildRecursiveIntegrationHierarchy(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  branchValidations: RecursiveValidationRecord[],
  rootValidation: RecursiveValidationRecord,
  conflictsResolved: string[],
  conflictsUnresolved: string[],
  now: string
): RecursiveIntegrationNodeSummary[] {
  const branchById = new Map((session.recursiveFactory?.branchOrchestrators ?? []).map((branch) => [branch.branchId, branch]));
  const semanticDecisions = session.recursiveFactory?.semanticConflictDecisions ?? [];
  const localNodes = chunk(branchResults, 5).map((group, index) => integrationNode({
    session,
    level: "local_team",
    title: `Local Integration ${index + 1}`,
    branchIds: group.map((result) => result.branchId),
    branchResults: group,
    validations: branchValidations.filter((validation) => validation.branchId && group.some((result) => result.branchId === validation.branchId)),
    conflictsResolved,
    conflictsUnresolved,
    semanticDecisionIds: semanticDecisionsForBranches(semanticDecisions, group.map((result) => result.branchId)),
    now
  }));
  const areaNodes = groupedNodes(localNodes, (node) => areaKeyForBranches(node.branchIds, branchById)).map(([area, nodes]) => integrationNode({
    session,
    level: "area",
    title: `Area Integration: ${area}`,
    childNodeIds: nodes.map((node) => node.id),
    branchIds: uniqueRuntimeStrings(nodes.flatMap((node) => node.branchIds)),
    childNodes: nodes,
    validations: nodes.map((node) => node.validation),
    conflictsResolved,
    conflictsUnresolved,
    semanticDecisionIds: uniqueRuntimeStrings(nodes.flatMap((node) => node.unresolvedDecisions)),
    now
  }));
  const domainNodes = groupedNodes(areaNodes, (node) => domainForArea(node.title)).map(([domain, nodes]) => integrationNode({
    session,
    level: "domain",
    title: `Domain Integration: ${domain}`,
    childNodeIds: nodes.map((node) => node.id),
    branchIds: uniqueRuntimeStrings(nodes.flatMap((node) => node.branchIds)),
    childNodes: nodes,
    validations: nodes.map((node) => node.validation),
    conflictsResolved,
    conflictsUnresolved,
    semanticDecisionIds: uniqueRuntimeStrings(nodes.flatMap((node) => node.unresolvedDecisions)),
    now
  }));
  const rootNode = integrationNode({
    session,
    level: "root",
    title: "Root Integration",
    childNodeIds: domainNodes.map((node) => node.id),
    branchIds: branchResults.map((result) => result.branchId),
    childNodes: domainNodes,
    validations: [rootValidation],
    rootValidation,
    conflictsResolved,
    conflictsUnresolved,
    semanticDecisionIds: semanticDecisions
      .filter((decision) => decision.requires_user_approval || decision.status === "requires_user_approval" || decision.status === "blocked")
      .map((decision) => decision.decision_id),
    now
  });
  const withParents = [...localNodes, ...areaNodes, ...domainNodes, rootNode];
  const parentByChild = new Map<string, string>();
  for (const node of withParents) for (const child of node.childNodeIds) parentByChild.set(child, node.id);
  return withParents.map((node) => ({ ...node, parentNodeId: parentByChild.get(node.id) }));
}

export function buildRecursiveFinalReport(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  integrationSummary: RecursiveIntegrationSummary,
  branchValidations: RecursiveValidationRecord[]
): RecursiveFinalReport {
  const now = new Date().toISOString();
  const finalValidation = buildRecursiveFinalValidation(session, branchResults, integrationSummary, branchValidations, now);
  const validationHierarchy = [...branchValidations, integrationSummary.validation, finalValidation];
  const graph = session.recursiveFactory?.recursiveGraph;
  return {
    id: `recursive_final_report_${session.id}`,
    sessionId: session.id,
    productGoal: session.recursiveFactory?.productSpec?.userGoal ?? session.userPrompt,
    approvedTechnicalPlanSummary: session.recursiveFactory?.technicalPlan?.summary ?? "No approved Technical Plan summary recorded.",
    graphSummary: graph
      ? `${graph.rootGoal}; ${graph.branches.length} branch(es), ${graph.conflicts.length} conflict(s), graph ${graph.status}.`
      : "No recursive graph recorded.",
    branchOutcomes: branchResults,
    patchApplyTruth: branchResults.flatMap((result) =>
      result.patchIds.map((patchId) => {
        const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
        return {
          patchId,
          status: patch?.status ?? "proposed",
          filesChanged: patch?.filesChanged.map((file) => file.path) ?? result.filesChanged
        };
      })
    ),
    patchProvenance: buildRecursivePatchProvenance(session, branchResults),
    validationHierarchy,
    finalValidationState: finalValidation.truthStatus,
    finalStatus: finalValidation.status,
    validationDiscovery: {
      discoveredCommands: finalValidation.discoveredCommands ?? [],
      chosenStrategy: finalValidation.selectedStrategy ?? {
        kind: "missing",
        classification: "missing",
        scope: "none",
        reason: "No final validation strategy was recorded."
      },
      evidence: finalValidation.evidence ?? [],
      statusReason: finalValidation.summary
    },
    knownLimitations: uniqueRuntimeStrings([
      ...integrationSummary.integrationRisks,
      ...validationHierarchy.flatMap((validation) => validation.status === "passed" ? [] : validation.blockingReasons)
    ]),
    recommendedNextStep: recommendedRecursiveNextStep(finalValidation, integrationSummary),
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

function integrationNode(input: {
  session: AgentRuntimeSession;
  level: RecursiveIntegrationNodeLevel;
  title: string;
  childNodeIds?: string[];
  branchIds: string[];
  branchResults?: RecursiveBranchResultRecord[];
  childNodes?: RecursiveIntegrationNodeSummary[];
  validations: RecursiveValidationRecord[];
  rootValidation?: RecursiveValidationRecord;
  conflictsResolved: string[];
  conflictsUnresolved: string[];
  semanticDecisionIds: string[];
  now: string;
}): RecursiveIntegrationNodeSummary {
  const validation = input.rootValidation ?? integrationNodeValidation(input.session.id, input.level, input.title, input.branchIds, input.validations, input.now);
  const branchResults = input.branchResults ?? [];
  const childNodes = input.childNodes ?? [];
  const unresolved = uniqueRuntimeStrings([
    ...input.semanticDecisionIds,
    ...childNodes.flatMap((node) => node.unresolvedDecisions)
  ]);
  const branchConflictRefs = (input.session.recursiveFactory?.branchScopeConflicts ?? [])
    .filter((conflict) => conflict.branchIds.some((branchId) => input.branchIds.includes(branchId)))
    .map((conflict) => conflict.id);
  return {
    id: `recursive_integration_${input.level}_${input.session.id}_${slug(input.title)}`,
    sessionId: input.session.id,
    level: input.level,
    title: input.title,
    childNodeIds: uniqueRuntimeStrings(input.childNodeIds ?? []),
    branchIds: uniqueRuntimeStrings(input.branchIds),
    integratedResultRefs: uniqueRuntimeStrings([
      ...branchResults.map((result) => result.id),
      ...branchResults.flatMap((result) => result.patchIds.map((patchId) => `patch:${patchId}`)),
      ...childNodes.map((node) => node.id)
    ]),
    conflictReportRefs: uniqueRuntimeStrings([...branchConflictRefs, ...unresolved]),
    validation,
    intentAlignmentScore: intentAlignmentScore(validation, unresolved),
    unresolvedDecisions: unresolved,
    conflictsResolved: input.conflictsResolved.filter((conflict) => conflictMatchesBranches(conflict, input.branchIds)),
    conflictsUnresolved: input.conflictsUnresolved.filter((conflict) => conflictMatchesBranches(conflict, input.branchIds)),
    integrationRisks: uniqueRuntimeStrings([
      ...branchResults.flatMap((result) => result.risksAndLimitations),
      ...childNodes.flatMap((node) => node.integrationRisks),
      ...validation.blockingReasons
    ]),
    remainingManualSteps: uniqueRuntimeStrings([
      ...childNodes.flatMap((node) => node.remainingManualSteps),
      ...(validation.status === "passed" ? [] : validation.blockingReasons)
    ]),
    createdAt: branchResults[0]?.createdAt ?? input.now,
    updatedAt: input.now,
    metadata_json: {
      max_local_branch_group_size: input.level === "local_team" ? 5 : undefined,
      child_count: input.childNodeIds?.length ?? 0,
      validation_status: validation.status
    }
  };
}

function integrationNodeValidation(
  sessionId: string,
  level: RecursiveIntegrationNodeLevel,
  title: string,
  branchIds: string[],
  validations: RecursiveValidationRecord[],
  now: string
): RecursiveValidationRecord {
  const statuses = validations.map((validation) => validation.status);
  const status: RecursiveValidationRecord["status"] = statuses.includes("failed")
    ? "failed"
    : statuses.length && statuses.every((entry) => entry === "passed")
      ? "passed"
      : "unverified";
  const truthStatus = status === "passed"
    ? "verified_passed"
    : status === "failed"
      ? worstRecursiveTruth(validations.map((validation) => validation.truthStatus), "verified_failed")
      : worstRecursiveTruth(validations.map((validation) => validation.truthStatus), "unverified");
  return {
    id: `recursive_validation_${level}_${sessionId}_${slug(title)}`,
    sessionId,
    level: "integration_validation",
    truthStatus,
    status,
    summary: `${title} ${status} for ${branchIds.length} branch(es).`,
    blockingReasons: status === "passed" ? [] : uniqueRuntimeStrings(validations.flatMap((validation) => validation.blockingReasons)),
    evidenceRefs: uniqueRuntimeStrings(validations.flatMap((validation) => validation.evidenceRefs)),
    discoveredCommands: validations.flatMap((validation) => validation.discoveredCommands ?? []),
    selectedStrategy: selectIntegrationStrategy(validations),
    evidence: validations.flatMap((validation) => validation.evidence ?? []),
    createdAt: now,
    updatedAt: now
  };
}

function buildRecursiveFinalValidation(
  session: AgentRuntimeSession,
  branchResults: RecursiveBranchResultRecord[],
  integrationSummary: RecursiveIntegrationSummary,
  branchValidations: RecursiveValidationRecord[],
  now: string
): RecursiveValidationRecord {
  const failedBranch = branchValidations.some((validation) => validation.status === "failed");
  const unverifiedBranch = branchValidations.some((validation) => validation.status === "unverified");
  const repairRevalidationPassed = hasVerifiedRepairRevalidationPass(session, branchResults);
  const selectedStrategy = selectIntegrationStrategy([...branchValidations, integrationSummary.validation]);
  const evidence = [...branchValidations, integrationSummary.validation].flatMap((validation) => validation.evidence ?? []);
  const discoveredCommands = [...branchValidations, integrationSummary.validation].flatMap((validation) => validation.discoveredCommands ?? []);
  const status =
    repairRevalidationPassed
      ? "passed"
      : failedBranch || integrationSummary.validation.status === "failed"
      ? "failed"
      : unverifiedBranch || integrationSummary.validation.status === "unverified" || !branchResults.length
        ? "unverified"
        : "passed";
  const truthStatus =
    status === "passed"
      ? "verified_passed"
      : status === "failed"
        ? worstRecursiveTruth([...branchResults.map((result) => result.validationState), integrationSummary.validation.truthStatus], "verified_failed")
        : worstRecursiveTruth([...branchResults.map((result) => result.validationState), integrationSummary.validation.truthStatus], "unverified");
  return {
    id: `recursive_validation_final_${session.id}`,
    sessionId: session.id,
    level: "final_validation",
    truthStatus,
    status,
    summary:
      repairRevalidationPassed
        ? "Final recursive validation passed after Rust-applied repair and successful same-command revalidation."
        : status === "passed"
          ? "Final recursive validation passed from branch and integration evidence."
        : status === "failed"
          ? "Final recursive validation failed because at least one required branch or integration result failed."
          : "Final recursive validation is unverified; no green success is claimed.",
    blockingReasons: uniqueRuntimeStrings([
      ...(status === "passed" ? [] : branchValidations.flatMap((validation) => validation.status === "passed" ? [] : validation.blockingReasons)),
      ...(status === "passed" ? [] : integrationSummary.validation.blockingReasons),
      ...(status === "passed" || branchResults.length ? [] : ["No branch result records were available."])
    ]),
    evidenceRefs: [
      ...branchResults.flatMap((result) => result.patchIds.map((patchId) => `patch:${patchId}`)),
      ...evidence.map((entry) => entry.executionId ? `command_execution:${entry.executionId}` : entry.kind === "patch_effect" ? "patch_effect:evidence" : "validation:evidence"),
      `session:${session.id}`
    ],
    discoveredCommands,
    selectedStrategy,
    evidence,
    createdAt: branchResults[0]?.createdAt ?? now,
    updatedAt: now
  };
}

function hasVerifiedRepairRevalidationPass(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]) {
  const repair = session.recursiveFactory?.repair;
  if (!repair || repair.status !== "revalidated" || repair.repairPatchStatus !== "applied" || !repair.repairPatchId) return false;
  const revalidation = repair.validationAttempts.find((attempt) =>
    attempt.role === "repair_revalidation"
    && attempt.truthStatus === "verified_passed"
    && (attempt.status === "executed" || attempt.status === "completed" || attempt.status === "verified_passed")
    && (attempt.exitCode === undefined || attempt.exitCode === 0)
    && attempt.policyResult !== "blocked"
  );
  if (!revalidation) return false;
  if (!branchResults.length) return false;
  return branchResults.every((result) => result.patchIds.every((patchId) =>
    session.patchProposals.find((patch) => patch.id === patchId)?.status === "applied"
  ));
}

function selectIntegrationStrategy(validations: RecursiveValidationRecord[]): RecursiveValidationStrategy {
  const strategies = validations.map((validation) => validation.selectedStrategy).filter(Boolean) as RecursiveValidationStrategy[];
  return strategies.find((strategy) => strategy.kind === "command" && strategy.classification === "safe_auto")
    ?? strategies.find((strategy) => strategy.kind === "command")
    ?? strategies.find((strategy) => strategy.kind === "patch_effect")
    ?? {
      kind: "missing",
      classification: "missing",
      scope: "none",
      reason: "No branch validation strategy was available for integration."
    };
}

function branchAppliedState(branch: RecursiveBranchExecutionRecord, patches: PatchProposal[]): RecursiveBranchResultRecord["appliedState"] {
  if (patches.some((patch) => patch.status === "apply_failed") || branch.status === "failed" && branch.validationStatus === "not_run_runtime_error") return "apply_failed";
  if (!patches.length || patches.every((patch) => patch.status !== "applied")) return "not_applied";
  if (patches.every((patch) => patch.status === "applied") && branch.patchApplied) return "applied";
  return "partially_applied";
}

function validationRecordStatus(truthStatus: import("@hivo/protocol").ValidationTruthStatus): RecursiveValidationRecord["status"] {
  if (truthStatus === "verified_passed") return "passed";
  if (truthStatus === "verified_failed") return "failed";
  return "unverified";
}

function worstRecursiveTruth(values: import("@hivo/protocol").ValidationTruthStatus[], fallback: import("@hivo/protocol").ValidationTruthStatus): import("@hivo/protocol").ValidationTruthStatus {
  const ordered: import("@hivo/protocol").ValidationTruthStatus[] = [
    "verified_failed",
    "not_run_runtime_error",
    "not_run_blocked_by_policy",
    "not_run_needs_approval",
    "not_run_missing_command",
    "unverified",
    "verified_passed"
  ];
  return ordered.find((candidate) => values.includes(candidate)) ?? fallback;
}

function remainingRecursiveManualSteps(validation: RecursiveValidationRecord, branchResults: RecursiveBranchResultRecord[]) {
  if (validation.status === "passed") return [];
  const steps = [
    validation.truthStatus === "not_run_needs_approval" ? "Approve and run pending validation commands through Rust." : undefined,
    validation.truthStatus === "not_run_missing_command" ? "Record or add an explicit validation command before claiming success." : undefined,
    validation.truthStatus === "verified_failed" ? "Inspect failed validation evidence and repair the affected branch." : undefined,
    ...branchResults
      .filter((result) => result.validationState !== "verified_passed")
      .map((result) => `Resolve ${result.branchId}: validation is ${result.validationState}.`)
  ].filter(Boolean) as string[];
  return uniqueRuntimeStrings(steps.length ? steps : ["Review unverified recursive validation evidence before claiming success."]);
}

function recommendedRecursiveNextStep(finalValidation: RecursiveValidationRecord, integrationSummary: RecursiveIntegrationSummary) {
  if (finalValidation.status === "passed") return "Recursive execution is verified; review the final report and close the run.";
  if (finalValidation.status === "failed") return "Inspect failed branch or integration evidence, then request a repair branch.";
  return integrationSummary.remainingManualSteps[0] ?? "Run or report validation evidence through Rust before claiming final success.";
}

function buildRecursivePatchProvenance(session: AgentRuntimeSession, branchResults: RecursiveBranchResultRecord[]): RecursivePatchProvenance[] {
  const recursivePatchIds = new Set(branchResults.flatMap((result) => result.patchIds));
  return session.patchProposals
    .filter((patch) => recursivePatchIds.has(patch.id) && patch.status === "applied")
    .map((patch) => {
      const owner = findRecursivePatchOwner(session, patch.id);
      const diffHunks = parsePatchDiffHunks(patch.unifiedDiff);
      return {
        patchId: patch.id,
        branchId: owner?.branchId,
        subtaskId: owner?.subtaskId,
        filesChanged: patch.filesChanged.map((file) => normalizeWorkspaceRelativePath(file.path)),
        diffHunks,
        touchedSymbols: extractTouchedSymbols(diffHunks),
        fileHashes: patch.filesChanged.map((file) => {
          const filePath = normalizeWorkspaceRelativePath(file.path);
          const afterContent = patch.artifacts?.find((artifact) => normalizeWorkspaceRelativePath(artifact.path) === filePath)?.content
            ?? safeReadWorkspaceFile(session.workspacePath, filePath);
          const beforeContent = reconstructRemovedContentForFile(diffHunks, filePath);
          return {
            path: filePath,
            beforeHash: beforeContent ? sha256Text(beforeContent) : undefined,
            afterHash: afterContent !== undefined ? sha256Text(afterContent) : undefined
          };
        }),
        rustApplyResultId: findPatchApplyArtifactId(session, patch.id) ?? (patch.appliedAt || patch.lastStatusAt ? `patch_apply:${patch.id}:${patch.appliedAt ?? patch.lastStatusAt}` : undefined),
        validationAttemptId: findValidationAttemptAfterPatch(session, patch)
      };
    });
}

function findRecursivePatchOwner(session: AgentRuntimeSession, patchId: string) {
  for (const branch of session.recursiveFactory?.branchExecutions ?? []) {
    if (branch.proposedPatchId === patchId) return { branchId: branch.branchId };
    const subtask = branch.nestedSubtasks?.find((candidate) => candidate.proposedPatchId === patchId);
    if (subtask) return { branchId: branch.branchId, subtaskId: subtask.subtaskId };
  }
  return undefined;
}

function findPatchApplyArtifactId(session: AgentRuntimeSession, patchId: string) {
  return session.artifacts.find((artifact) =>
    artifact.title === "Patch applied"
    && typeof artifact.payload?.patchId === "string"
    && artifact.payload.patchId === patchId
  )?.id;
}

function findValidationAttemptAfterPatch(session: AgentRuntimeSession, patch: PatchProposal) {
  const appliedAt = Date.parse(patch.appliedAt ?? patch.lastStatusAt ?? patch.createdAt);
  return session.commandExecutions.find((execution) =>
    Number.isFinite(appliedAt)
      ? Date.parse(execution.createdAt) >= appliedAt
      : true
  )?.id;
}

function parsePatchDiffHunks(diff: string): RecursivePatchProvenance["diffHunks"] {
  const hunks: RecursivePatchProvenance["diffHunks"] = [];
  let currentFile = "";
  let current: RecursivePatchProvenance["diffHunks"][number] | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (fileMatch?.[1]) currentFile = normalizeWorkspaceRelativePath(fileMatch[1]);
    if (line.startsWith("@@")) {
      current = { filePath: currentFile, header: line, addedLines: [], removedLines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.addedLines.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) current.removedLines.push(line.slice(1));
  }
  return hunks;
}

function extractTouchedSymbols(hunks: RecursivePatchProvenance["diffHunks"]): RecursivePatchProvenance["touchedSymbols"] {
  const symbols: RecursivePatchProvenance["touchedSymbols"] = [];
  for (const hunk of hunks) {
    for (const line of [...hunk.addedLines, ...hunk.removedLines]) {
      const trimmed = line.trim();
      const candidates = [
        { match: trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/), kind: "function" as const },
        { match: trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/), kind: "class" as const },
        { match: trimmed.match(/^def\s+([A-Za-z_]\w*)/), kind: "function" as const },
        { match: trimmed.match(/^class\s+([A-Za-z_]\w*)/), kind: "class" as const },
        { match: trimmed.match(/^(?:pub\s+)?fn\s+([A-Za-z_]\w*)/), kind: "function" as const },
        { match: trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/), kind: "unknown" as const }
      ];
      for (const candidate of candidates) {
        const name = candidate.match?.[1];
        if (name) symbols.push({ filePath: hunk.filePath, name, kind: candidate.kind });
      }
    }
    const moduleName = moduleNameForPath(hunk.filePath);
    if (moduleName) symbols.push({ filePath: hunk.filePath, name: moduleName, kind: "module" });
  }
  return dedupeSymbols(symbols);
}

function reconstructRemovedContentForFile(hunks: RecursivePatchProvenance["diffHunks"], filePath: string) {
  const lines = hunks
    .filter((hunk) => normalizeWorkspaceRelativePath(hunk.filePath) === normalizeWorkspaceRelativePath(filePath))
    .flatMap((hunk) => hunk.removedLines);
  return lines.length ? `${lines.join("\n")}\n` : undefined;
}

function safeReadWorkspaceFile(workspacePath: string, filePath: string) {
  try {
    return readFileSync(resolveInsideWorkspace(workspacePath, filePath), "utf8");
  } catch {
    return undefined;
  }
}

function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function moduleNameForPath(filePath: string) {
  const withoutExtension = normalizeWorkspaceRelativePath(filePath).replace(/\.[^.]+$/, "");
  const parts = withoutExtension.split("/").filter(Boolean);
  if (!parts.length) return undefined;
  const filename = parts.at(-1);
  if (!filename) return undefined;
  return filename === "__init__" && parts.length > 1 ? parts.at(-2) : filename;
}

function dedupeSymbols(symbols: RecursivePatchProvenance["touchedSymbols"]) {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.filePath}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chunk<T>(values: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function groupedNodes<T>(values: T[], keyFor: (value: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function areaKeyForBranches(branchIds: string[], branchById: Map<string, BranchOrchestratorRecord>) {
  const branches = branchIds
    .map((branchId) => branchById.get(branchId))
    .filter((branch): branch is BranchOrchestratorRecord => Boolean(branch));
  const owners = uniqueRuntimeStrings(branches.map((branch) => branch.ownerRole)).sort();
  const semanticScopes = uniqueRuntimeStrings(branches.flatMap((branch) => branch.semanticScopes)).sort();
  if (owners.length === 1 && semanticScopes.length) return `${owners[0]} / ${friendlyScopeName(semanticScopes[0])}`;
  if (owners.length === 1) return owners[0];
  if (semanticScopes.length) return friendlyScopeName(semanticScopes[0]);
  return "project/general";
}

function domainForArea(areaTitle: string) {
  const text = areaTitle.toLowerCase();
  if (/\b(ui|ux|frontend|front-end|design|component|css|html|accessibility|a11y|screen|view)\b/.test(text)) return "UI";
  if (/\b(protocol|schema|model|contract|type|json|event|api surface)\b/.test(text)) return "protocol/schema";
  if (/\b(test|validation|verification|lint|typecheck|build|qa|replay|eval)\b/.test(text)) return "validation";
  if (/\b(runtime|backend|server|worker|orchestrat|agent|provider|llm|tauri|rust|command|memory|sqlite|index)\b/.test(text)) return "runtime/backend";
  return "project/general";
}

function semanticDecisionsForBranches(decisions: SemanticConflictDecision[], branchIds: string[]) {
  return decisions
    .filter((decision) => isUnresolvedSemanticDecision(decision))
    .filter((decision) => {
      const haystack = [
        decision.source_a,
        decision.source_b,
        ...decision.source_refs,
        ...decision.evidence_refs
      ].join("\n");
      return branchIds.some((branchId) => haystack.includes(branchId));
    })
    .map((decision) => decision.decision_id);
}

function isUnresolvedSemanticDecision(decision: SemanticConflictDecision) {
  return decision.requires_user_approval
    || decision.status === "requires_user_approval"
    || decision.status === "blocked"
    || decision.severity === "blocking";
}

function intentAlignmentScore(validation: RecursiveValidationRecord, unresolvedDecisionIds: string[]) {
  const validationScore = validation.status === "passed" ? 100 : validation.status === "unverified" ? 70 : 35;
  const unresolvedPenalty = Math.min(50, unresolvedDecisionIds.length * 20);
  return Math.max(0, validationScore - unresolvedPenalty);
}

function conflictMatchesBranches(conflict: string, branchIds: string[]) {
  if (!branchIds.length) return true;
  if (branchIds.some((branchId) => conflict.includes(branchId))) return true;
  return !/\b(?:branch|recursive_branch)[_-][a-z0-9_-]+\b/i.test(conflict);
}

function friendlyScopeName(scope: string) {
  return scope
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    || "project/general";
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80)
    || "node";
}

function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
