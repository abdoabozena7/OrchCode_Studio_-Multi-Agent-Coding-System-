import type {
  AgentRuntimeSession,
  BranchOrchestratorRecord,
  RecursiveBranchExecutionRecord,
  RecursiveBranchExecutionStartRequest,
  SemanticConflictResolutionBatch
} from "@hivo/protocol";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { runRecursiveBranchesThroughCanonicalGraph } from "../orchestration/CanonicalRecursiveAdapter.js";
import { ProjectGoalSpecStore } from "../orchestration/GoalSteward.js";
import { SemanticConflictResolver } from "../orchestration/SemanticConflictResolver.js";
import { semanticBatchBlocks } from "../orchestration/SemanticConflictResolverModels.js";
import { resolveInsideWorkspace } from "../tools/security.js";
import type { RecursiveBranchSchedulerService } from "./RecursiveBranchSchedulerService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeRecursiveBranchExecutionServices = {
  getProvider: (session: AgentRuntimeSession) => LlmProvider;
};

export class RuntimeRecursiveBranchExecutionService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recursiveBranchSchedulerService: RecursiveBranchSchedulerService,
    private readonly services: RuntimeRecursiveBranchExecutionServices
  ) {}

  async start(sessionId: string, request: RecursiveBranchExecutionStartRequest) {
    if (request?.approved !== true) {
      throw new Error("Recursive branch execution requires explicit user approval.");
    }
    const current = this.requireSession(sessionId);
    const factory = current.recursiveFactory;
    if (!factory?.productSpec || factory.productSpec.status !== "approved") {
      throw new Error("Branch execution requires an approved Product Specification.");
    }
    if (!factory.technicalPlan || factory.technicalPlan.status !== "approved") {
      throw new Error("Branch execution requires an approved Technical Plan.");
    }
    if (!factory.recursiveGraph || factory.recursiveGraph.status !== "ready" || factory.graphReadiness?.status !== "ready") {
      throw new Error("Branch execution requires a ready recursive graph.");
    }
    const blockingConflict = (factory.branchScopeConflicts ?? factory.recursiveGraph.conflicts).find((conflict) => conflict.severity === "blocking");
    if (blockingConflict) {
      await this.block(sessionId, blockingConflict.reason);
      throw new Error(`Branch execution blocked: ${blockingConflict.code}: ${blockingConflict.reason}`);
    }
    if (factory.executionStarted) {
      throw new Error("Recursive branch execution has already started for this session.");
    }
    const semanticBatch = await this.reviewSemanticConflicts(current);
    if (semanticBatch && semanticBatchBlocks(semanticBatch)) {
      await this.blockForSemanticConflict(sessionId, semanticBatch);
      throw new Error(`Branch execution blocked by semantic conflict resolution: ${semanticBatch.status}`);
    }

    const now = new Date().toISOString();
    const branches = factory.branchOrchestrators?.length ? factory.branchOrchestrators : factory.recursiveGraph.branches;
    const branchTargets = normalizeBranchTargetPlans(current.workspacePath, request, branches);
    const initialExecutions = branches.map((branch) =>
      createBranchExecutionRecord({
        branch,
        session: current,
        branchTarget: branchTargets.get(branch.branchId),
        now,
        status: branch.dependencies.length ? "waiting_on_dependency" : "ready",
        active: false
      })
    );
    if (!initialExecutions.length) {
      await this.block(sessionId, "No branch orchestrator records were available for execution.");
      throw new Error("Branch execution blocked: missing_file_scope: No branch orchestrator records were available.");
    }
    await this.setBranchExecutions(sessionId, initialExecutions, undefined, "branch_execution_running");
    const canonical = await runRecursiveBranchesThroughCanonicalGraph({
      sessionId,
      branches: initialExecutions,
      executeBranches: async () => {
        await this.advance(sessionId);
        return this.requireSession(sessionId).recursiveFactory?.branchExecutions ?? [];
      }
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reasoningSummaries.push(`Canonical recursive graph finished with status ${canonical.graph.status}.`);
    });
    return this.requireSession(sessionId);
  }

  async advance(sessionId: string) {
    return this.recursiveBranchSchedulerService.advance(sessionId);
  }

  private async setBranchExecutions(
    sessionId: string,
    records: RecursiveBranchExecutionRecord[],
    activeBranchId: string | undefined,
    phase: NonNullable<AgentRuntimeSession["recursiveFactory"]>["phase"]
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (!draft.recursiveFactory) return;
      draft.recursiveFactory.branchExecutions = records;
      draft.recursiveFactory.activeBranchId = activeBranchId;
      draft.recursiveFactory.executionStarted = true;
      draft.recursiveFactory.phase = phase;
      draft.recursiveFactory.updatedAt = new Date().toISOString();
      for (const branch of draft.recursiveFactory.branchOrchestrators ?? []) {
        const execution = records.find((candidate) => candidate.branchId === branch.branchId);
        if (!execution) continue;
        branch.status = execution.status;
        branch.updatedAt = execution.updatedAt;
      }
      draft.status = phase === "branch_execution_blocked" ? "blocked" : "needs_approval";
      draft.lifecycleStage = phase === "branch_execution_blocked" ? "BLOCKED" : "APPROVAL";
    });
  }

  private async block(sessionId: string, reason: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveFactory ??= { phase: "branch_execution_blocked", executionStarted: false, updatedAt: new Date().toISOString() };
      draft.recursiveFactory.phase = "branch_execution_blocked";
      draft.recursiveFactory.updatedAt = new Date().toISOString();
      draft.status = "blocked";
      draft.lifecycleStage = "BLOCKED";
      draft.nextAction = undefined;
      draft.reasoningSummaries.push(`Recursive branch execution blocked: ${reason}`);
    });
  }

  private async reviewSemanticConflicts(session: AgentRuntimeSession) {
    const factory = session.recursiveFactory;
    const graph = factory?.recursiveGraph;
    const branches = factory?.branchOrchestrators?.length ? factory.branchOrchestrators : graph?.branches;
    if (!factory?.productSpec || !graph || !branches?.length) return undefined;
    const projectGoalSpec = await new ProjectGoalSpecStore({ workspacePath: session.workspacePath })
      .loadActiveProjectGoalSpec()
      .catch(() => undefined);
    const batch = await new SemanticConflictResolver({
      workspacePath: session.workspacePath,
      artifactStore: new OrchestrationArtifactStore(session.workspacePath),
      provider: this.services.getProvider(session),
      mode: "strict"
    }).resolve({
      runId: session.id,
      phase: "planning",
      rootIntent: factory.productSpec.userGoal,
      projectGoalSpec,
      sources: branches.map((branch) => ({
        source_id: branch.branchId,
        source_role: branch.ownerRole,
        summary: [
          branch.title,
          branch.objective,
          branch.semanticScopes.length ? `semantic_scopes=${branch.semanticScopes.join(", ")}` : undefined,
          branch.expectedIntegrationPoints.length ? `integration_points=${branch.expectedIntegrationPoints.join(", ")}` : undefined,
          branch.risks.length ? `risks=${branch.risks.join(", ")}` : undefined
        ].filter(Boolean).join("; "),
        refs: [branch.branchId, graph.id, ...branch.fileScopes, ...branch.semanticScopes],
        possible_conflicts: branch.risks.filter((risk) => /conflict|tradeoff|intent|goal|realism|fun|cost|reliability|speed|quality/i.test(risk)),
        metadata_json: {
          graph_id: graph.id,
          file_scopes: branch.fileScopes,
          lock_scopes: branch.lockScopes,
          dependencies: branch.dependencies
        }
      })),
      metadata_json: { source_component: "RuntimeRecursiveBranchExecutionService.reviewSemanticConflicts" }
    });
    if (!batch.decisions.length) return batch;
    await this.sessionManager.updateSession(session.id, (draft) => {
      draft.recursiveFactory ??= { phase: "recursive_graph_ready", executionStarted: false, updatedAt: new Date().toISOString() };
      draft.recursiveFactory.semanticConflictBatches ??= [];
      draft.recursiveFactory.semanticConflictDecisions ??= [];
      upsertById(draft.recursiveFactory.semanticConflictBatches, batch);
      for (const decision of batch.decisions) upsertById(draft.recursiveFactory.semanticConflictDecisions, decision);
      draft.recursiveFactory.updatedAt = new Date().toISOString();
    });
    this.sessionManager.publishFactoryEvent({ type: "runtime.semantic_conflict_resolution.updated", sessionId: session.id, batch });
    return batch;
  }

  private async blockForSemanticConflict(sessionId: string, batch: SemanticConflictResolutionBatch) {
    const decision = batch.decisions.find((entry) => entry.requires_user_approval || entry.status === "requires_user_approval")
      ?? batch.decisions.find((entry) => entry.severity === "blocking")
      ?? batch.decisions[0];
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveFactory ??= { phase: "branch_execution_blocked", executionStarted: false, updatedAt: new Date().toISOString() };
      draft.recursiveFactory.phase = "branch_execution_blocked";
      draft.recursiveFactory.semanticConflictBatches ??= [];
      draft.recursiveFactory.semanticConflictDecisions ??= [];
      upsertById(draft.recursiveFactory.semanticConflictBatches, batch);
      for (const item of batch.decisions) upsertById(draft.recursiveFactory.semanticConflictDecisions, item);
      draft.recursiveFactory.updatedAt = new Date().toISOString();
      draft.status = decision?.requires_user_approval ? "needs_approval" : "blocked";
      draft.lifecycleStage = decision?.requires_user_approval ? "APPROVAL" : "BLOCKED";
      draft.nextAction = decision?.requires_user_approval
        ? {
            kind: "resolve_semantic_conflict",
            message: "Resolve the semantic conflict before recursive branch execution can start.",
            decisionId: decision.decision_id,
            question: decision.question ?? decision.reason,
            options: decision.options,
            evidenceRefs: decision.evidence_refs
          }
        : undefined;
      draft.reasoningSummaries.push(`Recursive branch execution blocked by semantic conflict resolution: ${batch.status}.`);
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

type RecursiveBranchTargetPlan = {
  targetFile: string;
  replacementText: string;
  nestedPatches?: Array<{
    targetFile: string;
    replacementText: string;
    objective?: string;
  }>;
};

function createBranchExecutionRecord(input: {
  branch: BranchOrchestratorRecord;
  session: AgentRuntimeSession;
  branchTarget?: RecursiveBranchTargetPlan;
  now: string;
  status: RecursiveBranchExecutionRecord["status"];
  active: boolean;
}): RecursiveBranchExecutionRecord {
  const productSpec = input.session.recursiveFactory!.productSpec!;
  const technicalPlan = input.session.recursiveFactory!.technicalPlan!;
  const fileScopes = uniqueRuntimeStrings([
    ...(input.branchTarget?.targetFile ? [input.branchTarget.targetFile] : []),
    ...input.branch.fileScopes
  ]);
  const lockScopes = uniqueRuntimeStrings([
    ...(input.branchTarget?.targetFile ? [`file:${input.branchTarget.targetFile}`] : []),
    ...input.branch.lockScopes
  ]);
  return {
    branchId: input.branch.branchId,
    sessionId: input.session.id,
    title: input.branch.title,
    status: input.status,
    active: input.active,
    executionContext: {
      branchObjective: input.branch.objective,
      approvedProductSpecSummary: productSpec.userGoal,
      approvedTechnicalPlanSummary: technicalPlan.summary,
      fileScopes,
      semanticScopes: input.branch.semanticScopes,
      lockScopes,
      dependencies: input.branch.dependencies,
      evidenceContextPack: [
        `Product Spec ${productSpec.id} revision ${productSpec.revision} approved.`,
        `Technical Plan ${technicalPlan.id ?? "unknown"} revision ${technicalPlan.revision ?? 1} approved.`,
        ...input.branch.inputContextRequirements
      ]
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: fileScopes.length > 0,
      blockedReason: input.status === "waiting_on_dependency" && input.branch.dependencies.length ? "dependency_waiting" : undefined,
      sequencingReason: input.branch.dependencies.length
        ? `Waiting for dependencies: ${input.branch.dependencies.join(", ")}`
        : "Conservative scheduler selected one ready write branch."
    },
    plannedPatch: input.branchTarget,
    plannedNestedPatches: input.branchTarget?.nestedPatches,
    nestedDepth: 0,
    nestedEligible: false,
    reviewStatus: "not_started",
    validationStatus: "unverified",
    validationPlan: input.branch.validationStrategy.length ? input.branch.validationStrategy : technicalPlan.validationCommands ?? technicalPlan.testStrategy,
    patchApplied: false,
    createdAt: input.now,
    updatedAt: input.now
  };
}

function normalizeBranchTargetPlans(
  workspacePath: string,
  request: RecursiveBranchExecutionStartRequest,
  branches: BranchOrchestratorRecord[]
) {
  const targets = new Map<string, RecursiveBranchTargetPlan>();
  const explicitTargets = request.branchTargets ?? [];
  for (const target of explicitTargets) {
    const branch = target.branchId ? branches.find((candidate) => candidate.branchId === target.branchId) : undefined;
    if (!branch) continue;
    targets.set(branch.branchId, {
      targetFile: normalizeBranchTargetPath(workspacePath, target.targetFile),
      replacementText: target.replacementText,
      nestedPatches: target.nestedSubtasks?.map((nested) => ({
        targetFile: normalizeBranchTargetPath(workspacePath, nested.targetFile),
        replacementText: nested.replacementText,
        objective: nested.objective
      }))
    });
  }
  if (request.targetFile && branches[0] && !targets.has(branches[0].branchId)) {
    targets.set(branches[0].branchId, {
      targetFile: normalizeBranchTargetPath(workspacePath, request.targetFile),
      replacementText: request.replacementText ?? `Recursive branch execution marker for ${branches[0].branchId}\n`
    });
  }
  return targets;
}

function normalizeBranchTargetPath(workspacePath: string, requestedPath: string) {
  const resolved = resolveInsideWorkspace(workspacePath, requestedPath);
  return path.relative(resolveInsideWorkspace(workspacePath), resolved).replaceAll("\\", "/");
}

function upsertById<T extends { id?: string; batch_id?: string; decision_id?: string }>(collection: T[], value: T) {
  const key = value.id ?? value.batch_id ?? value.decision_id;
  const index = collection.findIndex((candidate) => (candidate.id ?? candidate.batch_id ?? candidate.decision_id) === key);
  if (index >= 0) collection[index] = value;
  else collection.push(value);
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
