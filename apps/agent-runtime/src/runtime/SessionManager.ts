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
} from "@hivo/protocol";
import type { AppEvent } from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import type { AccessProfile, AccessProfileInput, DeclaredAccessPolicy, ResolvedAccessPolicy } from "@hivo/protocol";
import type { DurableRuntimeEvent } from "@hivo/protocol";
import { EventBus } from "./EventBus.js";
import { listDurableRuntimeEventsFromSqlite } from "./DurableRuntimeEvents.js";
import { replaySessionFromDurableEvents } from "./SessionReplay.js";
import { buildAgentRuntimeSwarmState } from "./SwarmSessionState.js";

type SessionTokenRecord = {
  tokenHash: string;
  expiresAt: string;
};

export type SessionTokenValidation =
  | { ok: true }
  | { ok: false; code: "unauthorized" | "token_expired"; message: string };

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

const MAX_PERSISTED_SESSIONS = 40;
const MAX_PERSISTED_MESSAGES = 40;
const MAX_PERSISTED_EVENTS = 160;
const MAX_PERSISTED_ITEMS = 80;
const MAX_PERSISTED_STRING_LENGTH = 4_000;
const MAX_PERSISTED_OBJECT_DEPTH = 4;
const MAX_PERSISTED_OBJECT_KEYS = 80;

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
    mode: AgentRuntimeMode | "demo_mock";
    executionMode?: AgentRuntimeSession["executionMode"];
    accessProfile?: AccessProfileInput;
    trustProfile?: import("@hivo/protocol").RunTrustProfile;
    providerConfig?: import("@hivo/protocol").SanitizedProviderConfig;
    activeProviderSource?: import("@hivo/protocol").ActiveProviderSource;
    responseLanguage?: "ar" | "en";
    debugMode?: boolean;
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
      mode: "real_provider",
      responseLanguage: input.responseLanguage,
      debugMode: input.debugMode,
      trustProfile,
      providerConfig: input.providerConfig,
      activeProviderSource: input.activeProviderSource,
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
      agentName: "Hivo",
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
      moduleExecutionSummaries: [],
      reasoningSummaries: [],
      progressEvents: [],
      agentWorkStatuses: [],
      orchestration:
        executionMode === "orchestrated_mode" || executionMode === "recursive_factory"
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
    return this.checkSessionToken(sessionId, token).ok;
  }

  checkSessionToken(sessionId: string, token: string | undefined): SessionTokenValidation {
    const record = this.sessionTokens.get(sessionId);
    if (!record) return { ok: true };
    if (!token || hashToken(token) !== record.tokenHash) {
      return { ok: false, code: "unauthorized", message: "Missing or invalid session token." };
    }
    const isValid = Date.parse(record.expiresAt) > Date.now();
    if (!isValid) {
      void this.markSessionExpired(sessionId, "Session token expired.");
      return { ok: false, code: "token_expired", message: "Session token expired." };
    }
    return { ok: true };
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  listSessions() {
    return [...this.sessions.values()];
  }

  publishFactoryEvent(event: Extract<AppEvent, {
    type:
      | "runtime.product_spec.proposed"
      | "runtime.product_spec.approved"
      | "runtime.technical_plan.proposed"
      | "runtime.technical_plan.approved"
      | "runtime.recursive_graph.proposed"
      | "runtime.recursive_graph.ready"
      | "runtime.recursive_graph.blocked"
      | "runtime.branch_orchestrator.planned"
      | "runtime.branch_scope.conflict_detected"
      | "runtime.branch_execution.ready"
      | "runtime.branch_execution.started"
      | "runtime.branch_execution.patch_proposed"
      | "runtime.branch_execution.reviewing"
      | "runtime.branch_execution.validation_pending"
      | "runtime.branch_execution.completed"
      | "runtime.branch_execution.blocked"
      | "runtime.branch_execution.failed"
      | "runtime.branch_result.recorded"
      | "runtime.semantic_conflict_resolution.updated"
      | "runtime.recursive_fan_in.updated"
      | "runtime.recursive_final_report.created"
  }>) {
    this.eventBus.publish(event);
  }

  publishKnowledgeEvent(event: Extract<AppEvent, {
    type:
      | "runtime.knowledge_tree.created"
      | "runtime.knowledge_tree.refreshed"
      | "runtime.knowledge_node.created"
      | "runtime.edit_route.proposed"
      | "runtime.edit_route.ready"
      | "runtime.edit_route.blocked"
      | "runtime.knowledge_branch_targets.created"
      | "runtime.knowledge_branch_execution.planned"
  }>) {
    this.eventBus.publish(event);
  }

  publishIntentContractEvent(event: Extract<AppEvent, { type: "runtime.intent_contract.compiled" }>) {
    this.eventBus.publish(event);
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
    if (message.role === "assistant" && !message.providerRequestRefs?.length) {
      throw new Error("assistant_message.provider_provenance_required");
    }
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
      const hadExecutionForRequest = Boolean(
        commandExecution.requestId
        && session.commandExecutions.some((candidate) => candidate.requestId === commandExecution.requestId)
      );
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
        request.status = commandRequestStatusFromExecution(commandExecution, request.status);
      }
      const taskState = asManagedTaskState(session.taskState);
      if (commandExecution.requestId) {
        if (isCommandExecutionTerminalForPendingRequest(commandExecution)) {
          taskState.pendingCommandIds = taskState.pendingCommandIds.filter((id) => id !== commandExecution.requestId);
        }
        if (isSuccessfulCommandExecution(commandExecution)) {
          if (!taskState.completedCommandIds.includes(commandExecution.requestId)) {
            taskState.completedCommandIds.push(commandExecution.requestId);
          }
          if (!taskState.commandState.completedIds.includes(commandExecution.requestId)) {
            taskState.commandState.completedIds.push(commandExecution.requestId);
          }
        } else if (isFailedCommandExecution(commandExecution)) {
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
      if (
        !hadExecutionForRequest
        && isCommandExecutionTerminalForPendingRequest(commandExecution)
      ) {
        pushTaskTransition(taskState, "command.started", `Command started: ${commandExecution.command}`);
      }
      pushTaskTransition(
        taskState,
        taskTransitionTypeFromCommandExecution(commandExecution),
        `Command ${commandExecution.status}: ${commandExecution.command}`
      );
    });
    this.eventBus.publish({
      type: runtimeEventTypeFromCommandExecution(commandExecution),
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
      } else if (status === "apply_started") {
        taskState.pendingPatchId = undefined;
        taskState.phase = "awaiting_patch_apply";
        taskState.patchState.authority = "rust";
        taskState.reconciliationStatus = "pending";
        taskState.reconciliationReason = "Rust patch apply has started and no terminal result is available yet.";
        pushTaskTransition(taskState, "patch.apply_started", `Patch apply started: ${proposal.title}`);
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
        type: runtimeEventTypeFromPatchStatus(status),
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
        summary.status === "completed" || summary.status === "failed" || summary.status === "blocked"
          ? summary.status
          : taskState.finalStatus;
      if (summary.status === "completed") {
        taskState.phase = "completed";
        pushTaskTransition(taskState, "session.completed", summary.summary);
      } else if (summary.status === "failed") {
        taskState.phase = "failed";
        pushTaskTransition(taskState, "session.failed", summary.summary);
      } else if (summary.status === "blocked") {
        taskState.phase = "verification_pending";
      } else if (summary.status === "pending") {
        taskState.phase = "verification_pending";
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

  async setVerificationResult(sessionId: string, verification: import("@hivo/protocol").VerificationResult) {
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
    session.swarmState = buildAgentRuntimeSwarmState(session);
    await this.persist();
    this.eventBus.publish({ type: "runtime.session.updated", session });
  }

  private async persist() {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const sessions = this.listSessions()
      .slice(-MAX_PERSISTED_SESSIONS)
      .map(createPersistedSessionSnapshot);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const state: PersistedState = {
      sessions,
      sessionTokens: [...this.sessionTokens.entries()]
        .filter(([sessionId]) => sessionIds.has(sessionId))
        .map(([sessionId, record]) => ({
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

function createPersistedSessionSnapshot(session: AgentRuntimeSession): AgentRuntimeSession {
  return sanitizePersistedValue({
    ...session,
    messages: session.messages.slice(-MAX_PERSISTED_MESSAGES).map((message) => ({
      ...message,
      content: truncatePersistedString(message.content, MAX_PERSISTED_STRING_LENGTH)
    })),
    runPhases: session.runPhases.slice(-MAX_PERSISTED_ITEMS),
    decisionLedger: session.decisionLedger.slice(-MAX_PERSISTED_ITEMS),
    tasks: session.tasks.slice(-MAX_PERSISTED_ITEMS),
    toolCalls: session.toolCalls.slice(-MAX_PERSISTED_ITEMS),
    toolIntents: session.toolIntents.slice(-MAX_PERSISTED_ITEMS),
    artifacts: session.artifacts.slice(-MAX_PERSISTED_ITEMS),
    patchProposals: session.patchProposals.slice(-MAX_PERSISTED_ITEMS),
    commandRequests: session.commandRequests.slice(-MAX_PERSISTED_ITEMS),
    commandExecutions: session.commandExecutions.slice(-MAX_PERSISTED_ITEMS),
    backgroundJobs: session.backgroundJobs.slice(-MAX_PERSISTED_ITEMS),
    moduleExecutionSummaries: session.moduleExecutionSummaries?.slice(-MAX_PERSISTED_ITEMS),
    reasoningSummaries: session.reasoningSummaries.slice(-MAX_PERSISTED_MESSAGES),
    progressEvents: session.progressEvents.slice(-MAX_PERSISTED_EVENTS),
    agentWorkStatuses: session.agentWorkStatuses.slice(-MAX_PERSISTED_ITEMS),
    swarmState: session.swarmState
      ? {
          ...session.swarmState,
          nodes: session.swarmState.nodes.slice(-MAX_PERSISTED_ITEMS),
          messages: session.swarmState.messages.slice(-MAX_PERSISTED_ITEMS)
        }
      : undefined,
    orchestration: session.orchestration
      ? {
          ...session.orchestration,
          agentRuns: session.orchestration.agentRuns.slice(-MAX_PERSISTED_ITEMS),
          workerOutputs: session.orchestration.workerOutputs.slice(-MAX_PERSISTED_ITEMS),
          securityReviews: session.orchestration.securityReviews.slice(-MAX_PERSISTED_ITEMS),
          reviewerSummaries: session.orchestration.reviewerSummaries.slice(-MAX_PERSISTED_ITEMS),
          orchestrationEvents: session.orchestration.orchestrationEvents.slice(-MAX_PERSISTED_EVENTS),
          approvalDecisions: session.orchestration.approvalDecisions.slice(-MAX_PERSISTED_ITEMS),
          selectedWorkerAgents: session.orchestration.selectedWorkerAgents.slice(-MAX_PERSISTED_ITEMS),
          workOrders: session.orchestration.workOrders.slice(-MAX_PERSISTED_ITEMS),
          qualityGateResults: session.orchestration.qualityGateResults.slice(-MAX_PERSISTED_ITEMS)
        }
      : undefined
  }, 0, new WeakSet()) as AgentRuntimeSession;
}

function sanitizePersistedValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncatePersistedString(value, MAX_PERSISTED_STRING_LENGTH);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[circular]";
  if (Array.isArray(value) && value.every(isPersistablePrimitive)) {
    return value.slice(-MAX_PERSISTED_ITEMS).map((item) =>
      typeof item === "string" ? truncatePersistedString(item, MAX_PERSISTED_STRING_LENGTH) : item
    );
  }
  if (depth >= MAX_PERSISTED_OBJECT_DEPTH) {
    if (Array.isArray(value)) return { __truncated: true, kind: "array", length: value.length };
    return { __truncated: true, kind: "object", keys: Object.keys(value).slice(0, 20) };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const trimmed = value.slice(-MAX_PERSISTED_ITEMS).map((item) => sanitizePersistedValue(item, depth + 1, seen));
    seen.delete(value);
    return value.length > trimmed.length
      ? [{ __truncated: true, omittedItems: value.length - trimmed.length }, ...trimmed]
      : trimmed;
  }
  const entries = Object.entries(value).slice(0, MAX_PERSISTED_OBJECT_KEYS);
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    result[key] = sanitizePersistedValue(entryValue, depth + 1, seen);
  }
  if (Object.keys(value).length > entries.length) {
    result.__truncatedKeys = Object.keys(value).length - entries.length;
  }
  seen.delete(value);
  return result;
}

function isPersistablePrimitive(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null;
}

function truncatePersistedString(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]` : value;
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
  type: import("@hivo/protocol").RuntimeTaskTransitionType,
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

function commandRequestStatusFromExecution(
  execution: CommandExecutionRecord,
  fallback: CommandRequest["status"]
): CommandRequest["status"] {
  if (isRunningCommandExecution(execution)) return "executing";
  if (isSuccessfulCommandExecution(execution)) return "executed";
  if (execution.status === "blocked") return "blocked";
  if (execution.status === "orphaned") return "orphaned";
  if (execution.status === "terminated") return "terminated";
  if (execution.status === "failed") return "failed";
  if (execution.status === "approval_required") return "requested";
  return fallback;
}

function isRunningCommandExecution(execution: CommandExecutionRecord) {
  return execution.status === "executing" || execution.status === "running";
}

function isSuccessfulCommandExecution(execution: CommandExecutionRecord) {
  return execution.status === "executed" || execution.status === "completed";
}

function isFailedCommandExecution(execution: CommandExecutionRecord) {
  return execution.status === "failed"
    || execution.status === "blocked"
    || execution.status === "orphaned"
    || execution.status === "terminated";
}

function isCommandExecutionTerminalForPendingRequest(execution: CommandExecutionRecord) {
  return !isRunningCommandExecution(execution) && execution.status !== "approval_required";
}

function taskTransitionTypeFromCommandExecution(
  execution: CommandExecutionRecord
): import("@hivo/protocol").RuntimeTaskTransitionType {
  if (isRunningCommandExecution(execution)) return "command.started";
  if (isFailedCommandExecution(execution) || execution.status === "approval_required") return "command.failed";
  return "command.completed";
}

function runtimeEventTypeFromCommandExecution(
  execution: CommandExecutionRecord
): Extract<AppEvent, { execution: CommandExecutionRecord }>["type"] {
  if (isRunningCommandExecution(execution)) return "runtime.command.started";
  if (execution.status === "failed" || execution.status === "orphaned" || execution.status === "terminated") {
    return "runtime.command.failed";
  }
  if (execution.status === "blocked" || execution.status === "approval_required") return "runtime.command.blocked";
  return "runtime.command.completed";
}

function runtimeEventTypeFromPatchStatus(
  status: PatchProposal["status"]
): Extract<AppEvent, { proposal: PatchProposal }>["type"] {
  if (status === "approved") return "runtime.patch.approved";
  if (status === "apply_started") return "runtime.patch.apply_started";
  if (status === "rejected") return "runtime.patch.rejected";
  if (status === "applied") return "runtime.patch.applied";
  return "runtime.patch.apply_failed";
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
  const legacyDemoSession = (session as { mode?: string }).mode === "demo_mock";
  if (legacyDemoSession) {
    session.status = "failed_provider";
    session.lifecycleStage = "FAILED";
    session.taskState ??= createInitialTaskState(new Date().toISOString());
    session.taskState.restoreState = {
      source: "snapshot_restored",
      disposition: "non_restorable",
      warnings: ["Legacy demo_mock sessions cannot be resumed after the provider-required migration."],
      reason: "legacy_demo_mock_session_non_restorable",
      restoredAt: new Date().toISOString()
    };
  }
  session.progressEvents ??= [];
  session.agentWorkStatuses ??= [];
  session.swarmState = buildAgentRuntimeSwarmState(session, session.swarmState?.messages ?? []);
  session.toolIntents ??= [];
  session.artifacts ??= [];
  session.backgroundJobs ??= [];
  session.moduleExecutionSummaries ??= [];
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
      session.status === "completed" || session.status === "failed" || session.status === "blocked"
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
  if (legacyDemoSession) {
    taskState.restoreState = {
      source: "snapshot_restored",
      disposition: "non_restorable",
      warnings: ["Legacy demo_mock sessions cannot be resumed after the provider-required migration."],
      reason: "legacy_demo_mock_session_non_restorable",
      restoredAt: taskState.restoredAt,
      eventCount: options?.eventCount,
      lastEventSequence: options?.lastEventSequence
    };
    return session;
  }
  if (session.status === "created") {
    session.status = "restored";
  }
  if (taskState.phase === "created") {
    taskState.phase = "restored";
  }
  if (session.runToGreen?.status === "running") {
    session.runToGreen.status = "blocked";
    session.runToGreen.finalStatus = "blocked";
    session.runToGreen.blockerReason = "Run-to-green restored during an in-flight attempt; manual inspection is required before treating it as green.";
    session.runToGreen.updatedAt = new Date().toISOString();
    const activeAttempt = session.runToGreen.attempts.find((attempt) => attempt.attemptNumber === session.runToGreen?.currentAttempt);
    if (activeAttempt && !activeAttempt.completedAt) {
      activeAttempt.stopReason = session.runToGreen.blockerReason;
    }
    taskState.restoreState = {
      ...taskState.restoreState,
      disposition: "reconciliation_required",
      warnings: uniqueStrings([
        ...taskState.restoreState.warnings,
        "Run-to-green was in progress during restore, so the session requires manual reconciliation."
      ]),
      reason: session.runToGreen.blockerReason
    };
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeAccessProfile(profile: AccessProfileInput | undefined): AccessProfile {
  if (!profile || profile === "default_permissions" || profile === "auto_review" || profile === "bounded_autonomy" || profile === "full_access" || profile === "custom_config") {
    return profile ?? "default_permissions";
  }
  return "default_permissions";
}

function inferTrustProfile(accessProfile: AccessProfile): import("@hivo/protocol").RunTrustProfile {
  return accessProfile === "auto_review" || accessProfile === "bounded_autonomy" || accessProfile === "full_access" ? "trusted_internal" : "strict_gated";
}

function buildDeclaredAccessPolicy(
  accessProfile: AccessProfile,
  trustProfile: import("@hivo/protocol").RunTrustProfile
): DeclaredAccessPolicy {
  if (accessProfile === "full_access") {
    return {
      accessProfile,
      trustProfile,
      requestedAuthority: "backend_enforced",
      requestedCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "execute_medium_command",
        "execute_dangerous_command",
        "use_network"
      ],
      note: "Full Access is a trusted local profile that auto-applies validated workspace patches and auto-runs requested commands while preserving provenance."
    };
  }

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
    "Patch application is performed by Rust authority.",
    "Session restore requires a valid session token and persisted runtime snapshot.",
    "Command policy remains heuristic and is recorded as provenance."
  ];

  if (declared.accessProfile === "full_access") {
    return {
      declared,
      enforcedAuthority: "backend_enforced",
      effectiveCapabilities: [
        "read_workspace",
        "write_workspace",
        "propose_patch",
        "apply_patch",
        "request_command",
        "execute_safe_command",
        "execute_medium_command",
        "execute_dangerous_command",
        "use_network",
        "restore_session"
      ],
      blockedCapabilities: [],
      requiresApprovalFor: ["session_restore"],
      backendRestrictions: baseRestrictions,
      resolvedBy: "runtime",
      resolvedAt
    };
  }

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
