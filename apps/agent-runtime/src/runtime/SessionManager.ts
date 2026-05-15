import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentWorkStatus,
  AgentRuntimeSession,
  RuntimeTaskState,
  AgentRuntimeMode,
  RuntimeRestoreState,
  Artifact,
  CommandExecutionRecord,
  CommandRequest,
  OrchestrationEvent,
  PatchProposal,
  RunSummary,
  RuntimeMessage,
  RuntimeProgressEvent,
  SafetySettings,
  Task,
  ToolIntent,
  ToolCall
} from "@orchcode/protocol";
import { accessProfileDefaults } from "@orchcode/protocol";
import type { AccessProfile, AccessProfileInput, DeclaredAccessPolicy, ResolvedAccessPolicy } from "@orchcode/protocol";
import type { DurableRuntimeEvent } from "@orchcode/protocol";
import { EventBus } from "./EventBus.js";
import { listDurableRuntimeEventsFromSqlite } from "./DurableRuntimeEvents.js";
import { replaySessionFromDurableEvents } from "./SessionReplay.js";

type SessionTokenRecord = {
  tokenHash: string;
  expiresAt: string;
};

type PersistedState = {
  sessions: AgentRuntimeSession[];
  sessionTokens: Array<{
    sessionId: string;
    tokenHash: string;
    expiresAt: string;
  }>;
};

type ManagedTaskState = RuntimeTaskState & {
  restoreStatus: "fresh" | "restored" | "expired";
  restoreReason?: string;
  restoredAt?: string;
  expiredAt?: string;
  reconciliationStatus: "not_required" | "pending" | "reconciling" | "reconciled";
  reconciliationReason?: string;
  reconciledAt?: string;
  patchState: {
    patchId?: string;
    status?: PatchProposal["status"];
    proposedAt?: string;
    approvedAt?: string;
    completedAt?: string;
    authority?: "runtime" | "user" | "rust";
  };
  commandState: {
    requestedIds: string[];
    completedIds: string[];
    failedIds: string[];
    lastRequestId?: string;
    lastCompletedAt?: string;
    authority?: "runtime" | "rust";
  };
};

type SessionManagerOptions = {
  runtimeEventLoader?: (sessionId: string) => Promise<DurableRuntimeEvent[]>;
};

export class SessionManager {
  private readonly sessions = new Map<string, AgentRuntimeSession>();
  private readonly sessionTokens = new Map<string, SessionTokenRecord>();
  private readonly statePath: string;
  private readonly runtimeEventLoader: (sessionId: string) => Promise<DurableRuntimeEvent[]>;

  constructor(
    private readonly storageDir: string,
    private readonly eventBus: EventBus,
    options: SessionManagerOptions = {}
  ) {
    this.statePath = path.join(storageDir, "sessions.json");
    this.runtimeEventLoader = options.runtimeEventLoader ?? listDurableRuntimeEventsFromSqlite;
  }

  async load() {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const session of parsed.sessions ?? []) {
        const hydrated = await this.restorePersistedSession(session);
        this.sessions.set(hydrated.id, hydrated);
        this.eventBus.publish({ type: "runtime.session.restored", sessionId: hydrated.id, session: hydrated });
      }
      for (const token of parsed.sessionTokens ?? []) {
        this.sessionTokens.set(token.sessionId, {
          tokenHash: token.tokenHash,
          expiresAt: token.expiresAt
        });
      }
    } catch {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      await this.persist();
    }
  }

  async createSession(input: {
    workspacePath: string;
    mode: AgentRuntimeMode;
    executionMode?: AgentRuntimeSession["executionMode"];
    accessProfile?: AccessProfileInput;
    trustProfile?: import("@orchcode/protocol").RunTrustProfile;
    providerConfig?: import("@orchcode/protocol").SanitizedProviderConfig;
    sessionToken?: string;
    sessionTokenExpiresAt?: string;
    thinkFirst?: boolean;
    userPrompt: string;
    safetySettings?: Partial<SafetySettings>;
  }): Promise<AgentRuntimeSession> {
    const now = new Date().toISOString();
    const executionMode = input.executionMode ?? "auto_mode";
    const accessProfile = normalizeAccessProfile(input.accessProfile);
    const trustProfile = input.trustProfile ?? inferTrustProfile(accessProfile);
    const declaredAccess = buildDeclaredAccessPolicy(accessProfile, trustProfile);
    const safetySettings = {
      ...accessProfileDefaults(accessProfile),
      ...(input.safetySettings ?? {})
    };
    const session: AgentRuntimeSession = {
      id: randomId("session"),
      workspacePath: input.workspacePath,
      mode: input.mode,
      trustProfile,
      providerConfig: input.providerConfig,
      executionMode,
      accessProfile,
      declaredAccess: {
        ...declaredAccess,
        trustProfile
      },
      resolvedAccess: buildResolvedAccessPolicy(declaredAccess, now),
      runPhases: [],
      decisionLedger: [],
      thinkFirst: input.thinkFirst ?? false,
      userPrompt: input.userPrompt,
      agentName: "OrchCode",
      status: "created",
      lifecycleStage: "INTAKE",
      taskState: createInitialTaskState(now),
      messages: [
        {
          id: randomId("msg"),
          role: "user",
          content: input.userPrompt,
          createdAt: now
        }
      ],
      tasks: [],
      toolCalls: [],
      toolIntents: [],
      artifacts: [],
      patchProposals: [],
      commandRequests: [],
      commandExecutions: [],
      backgroundJobs: [],
      reasoningSummaries: [],
      progressEvents: [],
      agentWorkStatuses: [],
      orchestration:
        executionMode === "orchestrated_mode"
          ? {
              agentRuns: [],
              workerOutputs: [],
              securityReviews: [],
              reviewerSummaries: [],
              orchestrationEvents: [],
              approvalDecisions: [],
              safetySettings,
              lockedFiles: {},
              selectedWorkerAgents: [],
              mandatoryGateAgents: ["Product Orchestrator", "Business Orchestrator", "Engineering Orchestrator", "SecurityAgent", "ReviewerAgent"],
              workOrders: [],
              qualityGateResults: [],
              retryCount: 0
            }
          : undefined,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    if (input.sessionToken) {
      this.sessionTokens.set(session.id, {
        tokenHash: hashToken(input.sessionToken),
        expiresAt: input.sessionTokenExpiresAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
      });
    }
    await this.saveAndPublish(session);
    this.eventBus.publish({ type: "runtime.session.created", sessionId: session.id, session });
    return session;
  }

  validateSessionToken(sessionId: string, token: string | undefined) {
    const record = this.sessionTokens.get(sessionId);
    if (!record) return true;
    if (!token || hashToken(token) !== record.tokenHash) return false;
    const isValid = Date.parse(record.expiresAt) > Date.now();
    if (!isValid) {
      void this.markSessionExpired(sessionId, "Session token expired.");
    }
    return isValid;
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  listSessions() {
    return [...this.sessions.values()];
  }

  async updateSession(
    sessionId: string,
    updater: (session: AgentRuntimeSession) => void
  ): Promise<AgentRuntimeSession> {
    const session = this.requireSession(sessionId);
    updater(session);
    session.updatedAt = new Date().toISOString();
    await this.saveAndPublish(session);
    return session;
  }

  async addMessage(sessionId: string, message: Omit<RuntimeMessage, "id" | "createdAt">) {
    await this.updateSession(sessionId, (session) => {
      session.messages.push({
        id: randomId("msg"),
        createdAt: new Date().toISOString(),
        ...message
      });
    });
  }

  async addToolCall(sessionId: string, toolCall: ToolCall) {
    await this.updateSession(sessionId, (session) => {
      session.toolCalls.push(toolCall);
    });
    this.eventBus.publish({ type: "runtime.tool_call.updated", sessionId, toolCall });
  }

  async addToolIntent(sessionId: string, intent: ToolIntent) {
    await this.updateSession(sessionId, (session) => {
      const index = session.toolIntents.findIndex((candidate) => candidate.id === intent.id);
      if (index >= 0) {
        session.toolIntents[index] = intent;
      } else {
        session.toolIntents.push(intent);
      }
    });
    this.eventBus.publish({ type: "runtime.tool_intent.updated", sessionId, intent });
  }

  async addArtifact(sessionId: string, artifact: Artifact) {
    await this.updateSession(sessionId, (session) => {
      session.artifacts.push(artifact);
    });
    this.eventBus.publish({ type: "runtime.artifact.created", sessionId, artifact });
  }

  async addPatchProposal(sessionId: string, proposal: PatchProposal) {
    await this.updateSession(sessionId, (session) => {
      upsertById(session.patchProposals, proposal);
      const taskState = asManagedTaskState(session.taskState);
      taskState.pendingPatchId = proposal.id;
      taskState.activePatchId = proposal.id;
      taskState.phase = "awaiting_patch_approval";
      taskState.reconciliationStatus = "pending";
      taskState.reconciliationReason = "Patch proposal is waiting for explicit review and downstream authority actions.";
      taskState.patchState = {
        patchId: proposal.id,
        status: proposal.status,
        proposedAt: proposal.createdAt,
        authority: "runtime"
      };
      pushTaskTransition(taskState, "patch.proposed", `Patch proposed: ${proposal.title}`);
    });
    this.eventBus.publish({ type: "runtime.patch.proposed", sessionId, proposal });
  }

  async addCommandRequest(sessionId: string, commandRequest: CommandRequest) {
    await this.updateSession(sessionId, (session) => {
      upsertById(session.commandRequests, commandRequest);
      const taskState = asManagedTaskState(session.taskState);
      if (!taskState.pendingCommandIds.includes(commandRequest.id)) {
        taskState.pendingCommandIds.push(commandRequest.id);
      }
      if (!taskState.commandState.requestedIds.includes(commandRequest.id)) {
        taskState.commandState.requestedIds.push(commandRequest.id);
      }
      taskState.commandState.lastRequestId = commandRequest.id;
      taskState.commandState.authority = "runtime";
      taskState.reconciliationStatus = "pending";
      taskState.reconciliationReason = "Waiting for command execution authority to report a terminal result.";
      pushTaskTransition(taskState, "command.requested", `Command requested: ${commandRequest.command}`);
    });
    this.eventBus.publish({
      type: "runtime.command.requested",
      sessionId,
      commandRequest
    });
  }

  async addCommandExecution(sessionId: string, commandExecution: CommandExecutionRecord) {
    await this.updateSession(sessionId, (session) => {
      const existingIndex = session.commandExecutions.findIndex(
        (candidate) =>
          candidate.id === commandExecution.id ||
          (candidate.requestId && candidate.requestId === commandExecution.requestId)
      );
      if (existingIndex >= 0) {
        session.commandExecutions[existingIndex] = commandExecution;
      } else {
      session.commandExecutions.push(commandExecution);
      }
      session.backgroundJobs ??= [];
      if (commandExecution.backgroundJob) {
        const existingJobIndex = session.backgroundJobs.findIndex((candidate) => candidate.jobId === commandExecution.backgroundJob?.jobId);
        if (existingJobIndex >= 0) {
          session.backgroundJobs[existingJobIndex] = commandExecution.backgroundJob;
        } else {
          session.backgroundJobs.push(commandExecution.backgroundJob);
        }
      }
      const request = session.commandRequests.find((candidate) => candidate.id === commandExecution.requestId);
      if (request) {
        request.status =
          commandExecution.status === "executing"
            || commandExecution.status === "running"
            ? "executing"
            : commandExecution.status === "executed"
              || commandExecution.status === "completed"
              ? "executed"
              : commandExecution.status === "blocked"
                ? "blocked"
                : commandExecution.status === "orphaned"
                  ? "orphaned"
                  : commandExecution.status === "terminated"
                    ? "terminated"
                    : commandExecution.status === "failed"
                      ? "failed"
                      : commandExecution.status === "approval_required"
                        ? "approved"
                        : request.status;
      }
      const taskState = asManagedTaskState(session.taskState);
      if (commandExecution.requestId) {
        if (commandExecution.status !== "executing" && commandExecution.status !== "running" && commandExecution.status !== "approval_required") {
          taskState.pendingCommandIds = taskState.pendingCommandIds.filter((id) => id !== commandExecution.requestId);
        }
        if (commandExecution.status === "executed" || commandExecution.status === "completed") {
          if (!taskState.completedCommandIds.includes(commandExecution.requestId)) {
            taskState.completedCommandIds.push(commandExecution.requestId);
          }
          if (!taskState.commandState.completedIds.includes(commandExecution.requestId)) {
            taskState.commandState.completedIds.push(commandExecution.requestId);
          }
        } else if (commandExecution.status === "failed" || commandExecution.status === "blocked" || commandExecution.status === "orphaned" || commandExecution.status === "terminated") {
          if (!taskState.failedCommandIds.includes(commandExecution.requestId)) {
            taskState.failedCommandIds.push(commandExecution.requestId);
          }
          if (!taskState.commandState.failedIds.includes(commandExecution.requestId)) {
            taskState.commandState.failedIds.push(commandExecution.requestId);
          }
        }
      }
      taskState.commandState.lastCompletedAt = commandExecution.createdAt;
      taskState.commandState.authority = "rust";
      taskState.lastCommandProvenance = commandExecution.provenance;
      taskState.reconciliationStatus =
        taskState.pendingCommandIds.length === 0 &&
        taskState.pendingPatchId === undefined &&
        !(session.backgroundJobs ?? []).some((job) => job.status === "running")
          ? "reconciled"
          : "pending";
      taskState.reconciliationReason =
        taskState.reconciliationStatus === "reconciled"
          ? "Runtime state has a terminal command result for every pending authority action."
          : (session.backgroundJobs ?? []).some((job) => job.status === "running")
            ? "A background command is still running with limited tracking."
            : "Runtime is still waiting for additional authority-backed actions to complete.";
      taskState.reconciledAt = taskState.reconciliationStatus === "reconciled" ? commandExecution.createdAt : taskState.reconciledAt;
      pushTaskTransition(
        taskState,
        commandExecution.status === "executing" || commandExecution.status === "running"
          ? "command.started"
          : commandExecution.status === "failed" || commandExecution.status === "blocked" || commandExecution.status === "orphaned" || commandExecution.status === "terminated"
            ? "command.failed"
            : "command.completed",
        `Command ${commandExecution.status}: ${commandExecution.command}`
      );
    });
    this.eventBus.publish({
      type:
        commandExecution.status === "executing" || commandExecution.status === "running"
          ? "runtime.command.started"
          : commandExecution.status === "failed"
          || commandExecution.status === "orphaned"
          || commandExecution.status === "terminated"
          ? "runtime.command.failed"
          : commandExecution.status === "blocked"
            ? "runtime.command.blocked"
            : "runtime.command.completed",
      sessionId,
      execution: commandExecution
    });
  }

  async replaceTasks(sessionId: string, tasks: Task[]) {
    await this.updateSession(sessionId, (session) => {
      session.tasks = tasks;
      if (tasks.length) {
        session.taskState.phase = "planning";
        pushTaskTransition(session.taskState, "plan.updated", `Plan updated with ${tasks.length} task(s)`);
      }
    });
  }

  async setPatchStatus(sessionId: string, patchId: string, status: PatchProposal["status"]) {
    const session = await this.updateSession(sessionId, (session) => {
      const proposal = session.patchProposals.find((candidate) => candidate.id === patchId);
      if (!proposal) {
        throw new Error("Patch proposal not found");
      }
      proposal.status = status;
      proposal.lastStatusAt = new Date().toISOString();
      const taskState = asManagedTaskState(session.taskState);
      taskState.activePatchId = patchId;
      taskState.patchState.patchId = patchId;
      taskState.patchState.status = status;
      if (status === "approved") {
        taskState.pendingPatchId = undefined;
        taskState.phase = "awaiting_patch_apply";
        taskState.patchState.approvedAt = new Date().toISOString();
        taskState.patchState.authority = "user";
        taskState.reconciliationStatus = "pending";
        taskState.reconciliationReason = "Waiting for Rust patch apply authority to report a result.";
        pushTaskTransition(taskState, "patch.approved", `Patch approved: ${proposal.title}`);
      } else if (status === "rejected") {
        taskState.pendingPatchId = undefined;
        taskState.reconciliationStatus = "reconciled";
        taskState.reconciliationReason = "Patch review ended with rejection and no downstream authority action.";
        taskState.reconciledAt = new Date().toISOString();
        pushTaskTransition(taskState, "patch.rejected", `Patch rejected: ${proposal.title}`);
      } else if (status === "applied") {
        taskState.pendingPatchId = undefined;
        taskState.phase = taskState.pendingCommandIds.length ? "awaiting_command_execution" : "patch_applied";
        proposal.appliedAt = new Date().toISOString();
        taskState.patchState.completedAt = new Date().toISOString();
        taskState.patchState.authority = "rust";
        taskState.reconciliationStatus = taskState.pendingCommandIds.length ? "pending" : "reconciled";
        taskState.reconciliationReason = taskState.pendingCommandIds.length
          ? "Patch apply was reported; command verification is still pending."
          : "Patch apply was reported and no further authority actions remain.";
        taskState.reconciledAt = taskState.pendingCommandIds.length ? taskState.reconciledAt : new Date().toISOString();
        pushTaskTransition(taskState, "patch.applied", `Patch applied: ${proposal.title}`);
      } else if (status === "apply_failed") {
        taskState.phase = "patch_apply_failed";
        taskState.patchState.completedAt = new Date().toISOString();
        taskState.patchState.authority = "rust";
        taskState.reconciliationStatus = "reconciled";
        taskState.reconciliationReason = "Rust patch authority reported a terminal apply failure.";
        taskState.reconciledAt = new Date().toISOString();
        pushTaskTransition(taskState, "patch.apply_failed", `Patch apply failed: ${proposal.title}`);
      }
    });
    const proposal = session.patchProposals.find((candidate) => candidate.id === patchId);
    if (proposal) {
      this.eventBus.publish({
        type:
          status === "approved"
            ? "runtime.patch.approved"
            : status === "rejected"
              ? "runtime.patch.rejected"
              : status === "applied"
                ? "runtime.patch.applied"
                : "runtime.patch.apply_failed",
        sessionId,
        proposal
      });
    }
    return session;
  }

  async addOrchestrationEvent(sessionId: string, event: OrchestrationEvent) {
    await this.updateSession(sessionId, (session) => {
      if (!session.orchestration) return;
      session.orchestration.orchestrationEvents.push(event);
    });
    this.eventBus.publish({ type: "runtime.orchestration.event", sessionId, event });
  }

  async addProgressEvent(sessionId: string, progress: RuntimeProgressEvent) {
    await this.updateSession(sessionId, (session) => {
      session.progressEvents.push(progress);
    });
    this.eventBus.publish({ type: "runtime.progress.updated", sessionId, progress });
  }

  async updateAgentWorkStatus(sessionId: string, status: AgentWorkStatus) {
    await this.updateSession(sessionId, (session) => {
      const index = session.agentWorkStatuses.findIndex((candidate) => candidate.agentName === status.agentName);
      if (index >= 0) {
        session.agentWorkStatuses[index] = {
          ...session.agentWorkStatuses[index],
          ...status,
          targetFiles: status.targetFiles
        };
      } else {
        session.agentWorkStatuses.push(status);
      }
    });
  }

  async setRunSummary(sessionId: string, summary: RunSummary) {
    await this.updateSession(sessionId, (session) => {
      session.runSummary = summary;
      const taskState = asManagedTaskState(session.taskState);
      taskState.finalStatus =
        summary.status === "blocked" ? "needs_approval" : summary.status;
      if (summary.status === "completed") {
        taskState.phase = "completed";
        pushTaskTransition(taskState, "session.completed", summary.summary);
      } else if (summary.status === "failed") {
        taskState.phase = "failed";
        pushTaskTransition(taskState, "session.failed", summary.summary);
      }
    });
    this.eventBus.publish({ type: "runtime.run.completed", sessionId, summary });
    const session = this.requireSession(sessionId);
    if (summary.status === "completed") {
      this.eventBus.publish({ type: "runtime.session.completed", sessionId, session });
    } else if (summary.status === "failed") {
      this.eventBus.publish({ type: "runtime.session.failed", sessionId, session });
    }
  }

  async setVerificationResult(sessionId: string, verification: import("@orchcode/protocol").VerificationResult) {
    await this.updateSession(sessionId, (session) => {
      session.verificationResult = verification;
      const taskState = asManagedTaskState(session.taskState);
      taskState.lastVerificationStatus = verification.status;
      taskState.phase =
        verification.status === "failed"
          ? "verification_failed"
          : verification.status === "passed"
            ? "verification_passed"
            : "verification_pending";
      pushTaskTransition(taskState, `verification.${verification.status}`, verification.summary);
    });
    this.eventBus.publish({ type: `runtime.verification.${verification.status}`, sessionId, verification });
  }

  async markSessionRestored(sessionId: string, detail = "Session state was restored into runtime memory.") {
    await this.updateSession(sessionId, (session) => {
      const taskState = asManagedTaskState(session.taskState);
      taskState.restoreStatus = "restored";
      taskState.restoredAt = new Date().toISOString();
      taskState.restoreReason = detail;
      taskState.restoreState = {
        source: "snapshot_restored",
        disposition: session.status === "completed" || session.status === "failed" ? "terminal" : "resumable",
        warnings: ["Session restore remains snapshot-based until durable event replay fully owns restore.", detail],
        reason: detail,
        restoredAt: taskState.restoredAt
      };
      taskState.phase = "restored";
      session.status = "restored";
      pushTaskTransition(taskState, "session.restored", detail);
    });
    const session = this.requireSession(sessionId);
    this.eventBus.publish({ type: "runtime.session.restored", sessionId, session });
  }

  async markSessionExpired(sessionId: string, detail = "Session expired.") {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const taskState = asManagedTaskState(session.taskState);
    if (taskState.restoreStatus === "expired") return;
    taskState.restoreStatus = "expired";
    taskState.expiredAt = new Date().toISOString();
    taskState.restoreReason = detail;
    taskState.restoreState = {
      source: taskState.restoreState?.source ?? "snapshot_restored",
      disposition: "expired",
      warnings: [detail],
      reason: detail,
      restoredAt: taskState.restoreState?.restoredAt ?? taskState.restoredAt
    };
    taskState.phase = "expired";
    taskState.reconciliationStatus = taskState.reconciliationStatus === "reconciled" ? "reconciled" : "pending";
    session.lifecycleStage = "BLOCKED";
    session.status = "expired";
    session.updatedAt = new Date().toISOString();
    pushTaskTransition(taskState, "session.expired", detail);
    await this.saveAndPublish(session);
    this.eventBus.publish({ type: "runtime.session.expired", sessionId, session });
  }

  async markSessionReconciled(sessionId: string, detail: string) {
    await this.updateSession(sessionId, (session) => {
      const taskState = asManagedTaskState(session.taskState);
      taskState.reconciliationStatus = "reconciled";
      taskState.reconciliationReason = detail;
      taskState.reconciledAt = new Date().toISOString();
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  private async saveAndPublish(session: AgentRuntimeSession) {
    await this.persist();
    this.eventBus.publish({ type: "runtime.session.updated", session });
  }

  private async persist() {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const state: PersistedState = {
      sessions: this.listSessions(),
      sessionTokens: [...this.sessionTokens.entries()].map(([sessionId, record]) => ({
        sessionId,
        tokenHash: record.tokenHash,
        expiresAt: record.expiresAt
      }))
    };
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private async restorePersistedSession(snapshot: AgentRuntimeSession) {
    const durableEvents = await this.loadDurableEvents(snapshot.id);
    if (durableEvents.length > 0) {
      const replayed = replaySessionFromDurableEvents(durableEvents);
      if (replayed.session) {
        return replayed.session;
      }
      return hydrateSession(snapshot, {
        warning: replayed.restoreState.reason ?? "Durable events were insufficient for authoritative replay. Snapshot fallback was used.",
        eventCount: replayed.restoreState.eventCount,
        lastEventSequence: replayed.restoreState.lastEventSequence
      });
    }
    return hydrateSession(snapshot);
  }

  private async loadDurableEvents(sessionId: string) {
    try {
      return await this.runtimeEventLoader(sessionId);
    } catch {
      return [];
    }
  }
}

export function randomId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function createInitialTaskState(now: string): RuntimeTaskState {
  const taskState: ManagedTaskState = {
    version: 1,
    phase: "created",
    restoreState: {
      source: "fresh",
      disposition: "resumable",
      warnings: [],
      reason: "Session is active in live runtime memory."
    },
    pendingCommandIds: [],
    completedCommandIds: [],
    failedCommandIds: [],
    restoreStatus: "fresh",
    reconciliationStatus: "not_required",
    patchState: {},
    commandState: {
      requestedIds: [],
      completedIds: [],
      failedIds: []
    },
    transitions: [
      {
        id: randomId("transition"),
        phase: "created",
        type: "session.created",
        detail: "Session created",
        createdAt: now
      }
    ]
  };
  return taskState;
}

function pushTaskTransition(
  taskState: RuntimeTaskState,
  type: import("@orchcode/protocol").RuntimeTaskTransitionType,
  detail: string
) {
  taskState.version += 1;
  taskState.transitions.push({
    id: randomId("transition"),
    phase: taskState.phase,
    type,
    detail,
    createdAt: new Date().toISOString()
  });
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function asManagedTaskState(taskState: RuntimeTaskState): ManagedTaskState {
  const managed = taskState as ManagedTaskState;
  managed.restoreStatus ??= "fresh";
  managed.restoreState ??= {
    source: managed.restoreStatus === "expired" ? "snapshot_restored" : "fresh",
    disposition: managed.restoreStatus === "expired" ? "expired" : "resumable",
    warnings: managed.restoreReason ? [managed.restoreReason] : [],
    reason: managed.restoreReason
  };
  managed.reconciliationStatus ??= "not_required";
  managed.patchState ??= {};
  managed.commandState ??= {
    requestedIds: [],
    completedIds: [],
    failedIds: []
  };
  return managed;
}

function hydrateSession(
  session: AgentRuntimeSession,
  options?: {
    warning?: string;
    eventCount?: number;
    lastEventSequence?: number;
  }
) {
  session.progressEvents ??= [];
  session.agentWorkStatuses ??= [];
  session.toolIntents ??= [];
  session.artifacts ??= [];
  session.backgroundJobs ??= [];
  session.runPhases ??= [];
  session.decisionLedger ??= [];
  session.declaredAccess ??= buildDeclaredAccessPolicy(session.accessProfile, session.trustProfile);
  session.resolvedAccess ??= buildResolvedAccessPolicy(session.declaredAccess, new Date().toISOString());
  const taskState = asManagedTaskState(session.taskState ?? createInitialTaskState(new Date().toISOString()));
  session.taskState = taskState;
  taskState.restoreStatus = "restored";
  taskState.restoredAt ??= new Date().toISOString();
  taskState.restoreState = {
    source: "snapshot_restored",
    disposition:
      session.status === "completed" || session.status === "failed"
        ? "terminal"
        : session.status === "expired"
          ? "expired"
          : "resumable",
    warnings: [
      "Session restored from sessions.json snapshot. This path is not event-replay authoritative yet.",
      ...(options?.warning ? [options.warning] : [])
    ],
    reason: options?.warning ?? "Session restored from durable runtime snapshot fallback.",
    restoredAt: taskState.restoredAt,
    eventCount: options?.eventCount,
    lastEventSequence: options?.lastEventSequence
  };
  if (session.status === "created") {
    session.status = "restored";
  }
  if (taskState.phase === "created") {
    taskState.phase = "restored";
  }
  pushTaskTransition(taskState, "session.restored", "Session restored from durable runtime snapshot");
  return session;
}

function upsertById<T extends { id: string }>(collection: T[], value: T) {
  const index = collection.findIndex((candidate) => candidate.id === value.id);
  if (index >= 0) {
    collection[index] = value;
    return;
  }
  collection.push(value);
}

function normalizeAccessProfile(profile: AccessProfileInput | undefined): AccessProfile {
  if (!profile || profile === "default_permissions" || profile === "auto_review" || profile === "bounded_autonomy" || profile === "custom_config") {
    return profile ?? "default_permissions";
  }
  return "bounded_autonomy";
}

function inferTrustProfile(accessProfile: AccessProfile): import("@orchcode/protocol").RunTrustProfile {
  return accessProfile === "auto_review" || accessProfile === "bounded_autonomy" ? "trusted_internal" : "strict_gated";
}

function buildDeclaredAccessPolicy(
  accessProfile: AccessProfile,
  trustProfile: import("@orchcode/protocol").RunTrustProfile
): DeclaredAccessPolicy {
  if (accessProfile === "bounded_autonomy") {
    return {
      accessProfile,
      trustProfile,
      requestedAuthority: "bounded_autonomy",
      requestedCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command"
      ],
      note: "Declared bounded autonomy still depends on Rust-side apply and command authority."
    };
  }

  if (accessProfile === "auto_review") {
    return {
      accessProfile,
      trustProfile,
      requestedAuthority: "review_required",
      requestedCapabilities: [
        "read_workspace",
        "propose_patch",
        "request_command",
        "execute_safe_command"
      ]
    };
  }

  if (accessProfile === "custom_config") {
    return {
      accessProfile,
      trustProfile,
      requestedAuthority: "human_gated",
      requestedCapabilities: ["read_workspace", "propose_patch", "request_command"],
      note: "Custom policy remains reserved until backend enforcement is implemented."
    };
  }

  return {
    accessProfile,
    trustProfile,
    requestedAuthority: "human_gated",
    requestedCapabilities: ["read_workspace", "propose_patch", "request_command"]
  };
}

function buildResolvedAccessPolicy(declared: DeclaredAccessPolicy, resolvedAt: string): ResolvedAccessPolicy {
  const baseRestrictions = [
    "Patch application is performed by Rust authority after explicit review.",
    "Session restore requires a valid session token and persisted runtime snapshot.",
    "Dangerous commands remain blocked by backend policy."
  ];

  if (declared.accessProfile === "bounded_autonomy") {
    return {
      declared,
      enforcedAuthority: "review_required",
      effectiveCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "restore_session"
      ],
      blockedCapabilities: ["execute_dangerous_command", "use_network"],
      requiresApprovalFor: ["patch_apply", "command_execution", "dangerous_command"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "runtime",
      resolvedAt
    };
  }

  if (declared.accessProfile === "auto_review") {
    return {
      declared,
      enforcedAuthority: "review_required",
      effectiveCapabilities: [
        "read_workspace",
        "propose_patch",
        "request_command",
        "execute_safe_command",
        "restore_session"
      ],
      blockedCapabilities: ["write_workspace", "apply_patch", "execute_dangerous_command", "use_network"],
      requiresApprovalFor: ["patch_proposal", "patch_apply", "command_execution", "dangerous_command"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "runtime",
      resolvedAt
    };
  }

  return {
    declared,
    enforcedAuthority: "human_gated",
    effectiveCapabilities: ["read_workspace", "propose_patch", "request_command", "restore_session"],
    blockedCapabilities: ["write_workspace", "apply_patch", "execute_safe_command", "execute_dangerous_command", "use_network"],
    requiresApprovalFor: ["patch_proposal", "patch_apply", "command_execution", "dangerous_command", "session_restore"],
    backendRestrictions: baseRestrictions,
    resolvedBy: "runtime",
    resolvedAt
  };
}
