import type {
  AgentRuntimeSession,
  ProjectMap
} from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { bridgeEditIntents, collectIntentsFromTree } from "../orchestration/RecursiveEditIntentBridge.js";
import type { MemoryEvidencePack, RecursiveSwarmRunState } from "../orchestration/RecursiveSwarmModels.js";
import { RecursiveSwarmOrchestrator } from "../orchestration/RecursiveSwarmOrchestrator.js";
import type { RuntimeDirectTurnService } from "./RuntimeDirectTurnService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeRecursiveSwarmInput = {
  sessionId: string;
  message: string;
  provider: LlmProvider;
  providerTelemetry: ProviderTelemetryRecorder;
  projectMap: ProjectMap;
};

type RecursiveSwarmTerminalStatus = "completed" | "blocked" | "failed";

export class RuntimeRecursiveSwarmService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly directTurnService: RuntimeDirectTurnService
  ) {}

  async run(input: RuntimeRecursiveSwarmInput): Promise<AgentRuntimeSession> {
    const { sessionId, message, provider, providerTelemetry, projectMap } = input;
    const session = this.requireSession(sessionId);
    const buildPack = (taskPrompt: string, nodeId: string) =>
      buildMemoryEvidencePack(taskPrompt, nodeId, session, projectMap);

    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }

    await this.directTurnService.addProviderProgressEvent(sessionId, {
      stage: "planning",
      status: "running",
      title: "Recursive swarm started",
      summary: "Starting recursive tree decomposition and execution."
    });

    let liveProjectionQueue = Promise.resolve();
    let projectionQueuedAt = 0;
    let quietStatusChanges = 0;
    let orchestrator: RecursiveSwarmOrchestrator;
    const queueLiveProjection = (reason: string) => {
      const now = Date.now();
      if (now - projectionQueuedAt < 350 && reason === "node_status_changed") {
        quietStatusChanges++;
        if (quietStatusChanges < 20) return;
      }
      quietStatusChanges = 0;
      projectionQueuedAt = now;
      liveProjectionQueue = liveProjectionQueue
        .catch(() => {})
        .then(() => this.projectLiveRecursiveTree(sessionId, orchestrator, reason));
    };

    const addDurableProgress = (title: string, summary: string, status: "running" | "completed" | "blocked" | "failed" = "running") => {
      this.directTurnService.addProviderProgressEvent(sessionId, {
        stage: "planning",
        status,
        title,
        summary
      }).catch(() => {});
    };

    orchestrator = new RecursiveSwarmOrchestrator({
      buildPack,
      provider,
      workspacePath: session.workspacePath,
      options: {
        maxDepth: 10,
        maxAgents: 300,
        maxWriteExecutors: 6,
        enableGoalKeeper: true,
        enableParallelExecution: true,
        enableErrorRecovery: true
      },
      onNodeCreated: (node) => {
        queueLiveProjection("node_created");
      },
      onNodeStatusChanged: (node) => {
        queueLiveProjection("node_status_changed");
      },
      onDurableEvent: (event) => {
        queueLiveProjection(event.type);
        if (event.type === "intent_expanded") {
          addDurableProgress("Expanded recursive goal", `Preserved original prompt and extracted ${event.data.requirementCount ?? 0} requirement(s).`);
        } else if (event.type === "budget_planned") {
          addDurableProgress("Planned recursive staffing", `Soft budget ${event.data.softMaxAgents ?? "?"}/${event.data.hardMaxAgents ?? "?"}; max children ${event.data.maxChildrenPerParent ?? "?"}.`);
        } else if (event.type === "task_split") {
          addDurableProgress("Recursive split", `Parent created ${event.data.subTaskCount ?? 0} child task(s).`);
        } else if (event.type === "budget_gate") {
          addDurableProgress("Recursive budget gate", String(event.data.reason ?? "Budget gate applied."));
        } else if (event.type === "provider_backoff") {
          addDurableProgress("Provider backoff", String(event.data.reason ?? "Provider is rate limited or unreachable."), "blocked");
        } else if (event.type === "error") {
          addDurableProgress("Recursive node error", String(event.data.reason ?? "Recursive swarm error."), "failed");
        } else if (event.type === "collect_completed") {
          addDurableProgress("Collected recursive child results", `${event.data.childCount ?? 0} child result(s), ${event.data.errors ?? 0} unresolved error(s).`);
        }
      }
    });

    const result = await orchestrator.run(message, sessionId);
    await liveProjectionQueue.catch(() => {});
    const swarmState = orchestrator.toSwarmState();
    const state = result.runState;
    state.activityProjection = swarmState.activityProjection;
    const completedAt = new Date().toISOString();
    const terminalStatus = mapRecursiveSwarmStatus(state.tree.status);
    const failedNodes = swarmState.statusCounts.failed;
    const blockedNodes = swarmState.statusCounts.blocked;
    const { intents, generatedArtifacts, validationPlans } = collectIntentsFromTree(state.tree.nodes);
    const bridgeResult = bridgeEditIntents({
      sessionId,
      workspacePath: session.workspacePath,
      intents,
      generatedArtifacts,
      validationPlans,
      allowedPaths: [],
      forbiddenPaths: []
    });

    for (const proposal of bridgeResult.patchCandidates) {
      await this.sessionManager.addPatchProposal(sessionId, proposal);
    }
    for (const cmd of bridgeResult.validationCommandRequests) {
      await this.sessionManager.addCommandRequest(sessionId, cmd);
    }

    const sc = bridgeResult.summaryCounts;
    const qm = bridgeResult.qualityMetrics;
    const bridgeNotes = buildRecursiveBridgeNotes(bridgeResult);

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.recursiveSwarmRunState = buildRecursiveSwarmRunSnapshot(state, swarmState.nodes);
      draft.swarmState = {
        ...swarmState,
        activityProjection: state.activityProjection ?? swarmState.activityProjection
      };
      draft.status = terminalStatus;
      draft.lifecycleStage = terminalStatus === "completed"
        ? "DONE"
        : terminalStatus === "blocked"
          ? "BLOCKED"
          : "FAILED";
      draft.agentName = "Recursive Swarm";
      draft.runSummary = {
        status: terminalStatus,
        summary: `Recursive swarm completed: ${state.tree.totalNodes} nodes across ${state.tree.maxDepth + 1} depth levels, ${result.totalSplits} splits, ${result.totalExecutions} executions.${result.unresolvedErrors.length ? ` ${result.unresolvedErrors.length} unresolved error(s).` : ""} | ${sc.realDiff} real diff(s), ${sc.needsGeneration} need(s) generation, ${sc.blocked} blocked.`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: bridgeResult.patchCandidates.map((p) => p.id),
        commandResults: [],
        gates: [{
          name: "Recursive swarm execution",
          status: terminalStatus === "completed" ? "passed" : terminalStatus === "blocked" ? "blocked" : "failed",
          notes: [
            `totalNodes=${state.tree.totalNodes}`,
            `maxDepth=${state.tree.maxDepth}`,
            `totalSplits=${result.totalSplits}`,
            `totalExecutions=${result.totalExecutions}`,
            `failedNodes=${failedNodes}`,
            `blockedNodes=${blockedNodes}`,
            `unresolvedErrors=${result.unresolvedErrors.length}`,
            `finalOutputSource=${result.finalOutput.slice(0, 80)}`,
            ...bridgeNotes
          ]
        }],
        nextAction: sc.realDiff > 0
          ? `Recursive swarm completed with ${sc.realDiff} real patch proposal(s) awaiting approval.${sc.needsGeneration > 0 ? ` ${sc.needsGeneration} intent(s) need patch generation.` : ""}${sc.blocked > 0 ? ` ${sc.blocked} intent(s) blocked.` : ""}`
          : sc.needsGeneration > 0
            ? `Recursive swarm completed with no real patches; ${sc.needsGeneration} intent(s) need patch generation.`
            : terminalStatus === "completed"
              ? "Recursive swarm completed."
              : `Recursive swarm ${terminalStatus}. Review failed/blocked nodes.`,
        createdAt: completedAt
      };
    });

    const telemetrySnapshot = providerTelemetry.snapshot();
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: result.finalOutput,
      providerRequestRefs: telemetrySnapshot.providerRequestRefs
    });
    await this.directTurnService.addProviderProgressEvent(sessionId, {
      stage: "planning",
      status: terminalStatus,
      title: `Recursive swarm ${terminalStatus}`,
      summary: `Recursive swarm ${terminalStatus}: ${state.tree.totalNodes} nodes, ${result.totalSplits} splits, ${result.totalExecutions} executions.${result.unresolvedErrors.length ? ` ${result.unresolvedErrors.length} errors.` : ""}`
    });
    return this.sessionManager.getSession(sessionId) ?? session;
  }

  private async projectLiveRecursiveTree(
    sessionId: string,
    orchestrator: RecursiveSwarmOrchestrator,
    reason: string
  ): Promise<void> {
    const state = orchestrator.getRunState();
    const swarmState = orchestrator.toSwarmState();
    state.activityProjection = swarmState.activityProjection;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (draft.status === "completed" || draft.status === "failed" || draft.status === "blocked") return;
      draft.recursiveSwarmRunState = buildRecursiveSwarmRunSnapshot(state, swarmState.nodes);
      draft.swarmState = {
        ...swarmState,
        activityProjection: state.activityProjection ?? swarmState.activityProjection
      };
      draft.agentName = "Recursive Swarm";
      draft.status = "running";
      draft.lifecycleStage = "PLAN";
      draft.runSummary = {
        status: "pending",
        summary: `Recursive swarm running: ${state.tree.totalNodes} node(s), depth ${state.tree.maxDepth + 1}. Latest update: ${reason.replaceAll("_", " ")}.`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [],
        nextAction: "Recursive parent agents are still deciding child tasks, prompts, and execution order.",
        createdAt: new Date().toISOString()
      };
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function buildRecursiveSwarmRunSnapshot(
  state: RecursiveSwarmRunState,
  nodes: NonNullable<AgentRuntimeSession["recursiveSwarmRunState"]>["tree"]["nodes"]
): NonNullable<AgentRuntimeSession["recursiveSwarmRunState"]> {
  return {
    schemaVersion: state.schema_version,
    runId: state.runId,
    sessionId: state.sessionId,
    goalEnvelope: state.goalEnvelope,
    expandedGoalSpec: state.expandedGoalSpec,
    budget: state.budget,
    activityProjection: state.activityProjection,
    checkpoint: state.checkpoint,
    tree: {
      schemaVersion: state.tree.schema_version,
      runId: state.tree.runId,
      rootGoal: state.tree.rootGoal,
      rootId: state.tree.rootId,
      nodeCount: state.tree.totalNodes,
      depth: state.tree.maxDepth,
      status: state.tree.status,
      createdAt: state.tree.createdAt,
      updatedAt: state.tree.updatedAt,
      nodes
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

function mapRecursiveSwarmStatus(status: string): RecursiveSwarmTerminalStatus {
  if (status === "succeeded") return "completed";
  if (status === "blocked") return "blocked";
  return "failed";
}

function buildRecursiveBridgeNotes(bridgeResult: ReturnType<typeof bridgeEditIntents>) {
  const sc = bridgeResult.summaryCounts;
  const qm = bridgeResult.qualityMetrics;
  const bridgeNotes: string[] = [];
  if (sc.realDiff > 0) bridgeNotes.push(`realDiffs=${sc.realDiff}`);
  if (sc.needsGeneration > 0) bridgeNotes.push(`needsGeneration=${sc.needsGeneration}`);
  if (sc.blocked > 0) bridgeNotes.push(`blockedIntents=${sc.blocked}`);
  if (bridgeResult.validationCommandRequests.length > 0) {
    bridgeNotes.push(`valCommands=${bridgeResult.validationCommandRequests.length}`);
  }
  if (qm.readyOnFirstPass > 0 || qm.expandedSuccessfully > 0 || qm.expansionFailed > 0) {
    bridgeNotes.push(`qualityReady=${qm.readyOnFirstPass},expanded=${qm.expandedSuccessfully},expansionFail=${qm.expansionFailed}`);
  }
  if (qm.topMissingFields.length > 0) {
    bridgeNotes.push(`topMissingFields=${qm.topMissingFields.slice(0, 3).join(",")}`);
  }
  return bridgeNotes;
}

function buildMemoryEvidencePack(
  taskPrompt: string,
  nodeId: string,
  session: AgentRuntimeSession,
  projectMap: ProjectMap
): MemoryEvidencePack {
  const intake = session.projectIntake;
  const taskLower = taskPrompt.toLowerCase();
  const taskKeywords = taskLower.split(/\s+/).filter((word) => word.length > 3);

  if (intake && (intake.intakeStatus === "completed" || intake.intakeStatus === "partial")) {
    const relevantFiles = intake.importantFiles.filter((filePath) => {
      const fileLower = filePath.toLowerCase();
      return taskKeywords.some((keyword) => fileLower.includes(keyword));
    });
    const missingKeywords = taskKeywords.filter((keyword) =>
      !intake.importantFiles.some((filePath) => filePath.toLowerCase().includes(keyword))
    );

    const confidence = intake.confidence === "high"
      ? 0.9
      : intake.confidence === "medium"
        ? 0.65
        : intake.confidence === "low"
          ? 0.35
          : 0.2;
    const freshnessStatus: "fresh" | "stale" | "unknown" =
      confidence >= 0.65 ? "fresh" : confidence >= 0.35 ? "stale" : "unknown";
    const isPartial = intake.intakeStatus === "partial" || relevantFiles.length === 0;

    return {
      pack_id: `pack_${nodeId.slice(0, 8)}`,
      node_id: nodeId,
      task_slice: taskPrompt.slice(0, 200),
      context_source: isPartial ? "partial_context" : "memory_evidence",
      intent_contract_ref: session.intentContract?.contract_id,
      relevant_files: relevantFiles.slice(0, 15),
      file_ranges: {},
      symbols: intake.moduleSummary,
      commands: [...new Set([...intake.knownCommands, ...intake.testCommands])].slice(0, 10),
      allowed_paths: [],
      forbidden_paths: [],
      evidence_refs: [],
      unknowns: intake.unknowns.filter((unknown) => taskKeywords.some((keyword) => unknown.toLowerCase().includes(keyword))).slice(0, 5),
      warnings: [
        ...(missingKeywords.length > 0 ? [`No intake file matched keywords: ${missingKeywords.slice(0, 5).join(", ")}`] : []),
        ...intake.warnings.slice(0, 3)
      ],
      confidence,
      freshness_status: freshnessStatus
    };
  }

  const fallbackFiles = (projectMap.importantFiles ?? []).filter((filePath) => {
    const fileLower = filePath.toLowerCase();
    return taskKeywords.some((keyword) => fileLower.includes(keyword));
  });
  return {
    pack_id: `pack_${nodeId.slice(0, 8)}`,
    node_id: nodeId,
    task_slice: taskPrompt.slice(0, 200),
    context_source: "prompt_only_fallback",
    relevant_files: fallbackFiles.slice(0, 10),
    file_ranges: {},
    symbols: [],
    commands: (projectMap.testCommands ?? []).slice(0, 6),
    allowed_paths: [],
    forbidden_paths: [],
    evidence_refs: [],
    unknowns: [],
    warnings: ["No project intake available; answer from task prompt and general knowledge only."],
    confidence: 0.1,
    freshness_status: "unknown"
  };
}
