import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AgentRuntimeSession,
  AgentRuntimeMode,
  CommandExecutionRecord,
  CommandRequest,
  OrchestrationEvent,
  PatchProposal,
  RuntimeMessage,
  SafetySettings,
  Task,
  ToolCall
} from "@orchcode/protocol";
import { accessProfileDefaults } from "@orchcode/protocol";
import type { AccessProfile } from "@orchcode/protocol";
import { EventBus } from "./EventBus.js";

type PersistedState = {
  sessions: AgentRuntimeSession[];
};

export class SessionManager {
  private readonly sessions = new Map<string, AgentRuntimeSession>();
  private readonly statePath: string;

  constructor(
    storageDir: string,
    private readonly eventBus: EventBus
  ) {
    this.statePath = path.join(storageDir, "sessions.json");
  }

  async load() {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const session of parsed.sessions ?? []) {
        this.sessions.set(session.id, session);
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
    accessProfile?: AccessProfile;
    thinkFirst?: boolean;
    userPrompt: string;
    safetySettings?: Partial<SafetySettings>;
  }): Promise<AgentRuntimeSession> {
    const now = new Date().toISOString();
    const executionMode = input.executionMode ?? "auto_mode";
    const accessProfile = input.accessProfile ?? "default_permissions";
    const safetySettings = {
      ...accessProfileDefaults(accessProfile),
      ...(input.safetySettings ?? {})
    };
    const session: AgentRuntimeSession = {
      id: randomId("session"),
      workspacePath: input.workspacePath,
      mode: input.mode,
      executionMode,
      accessProfile,
      thinkFirst: input.thinkFirst ?? false,
      userPrompt: input.userPrompt,
      agentName: "OrchCode",
      status: "created",
      lifecycleStage: "INTAKE",
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
      patchProposals: [],
      commandRequests: [],
      commandExecutions: [],
      reasoningSummaries: [],
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
              lockedFiles: {}
            }
          : undefined,
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(session.id, session);
    await this.saveAndPublish(session);
    return session;
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

  async addPatchProposal(sessionId: string, proposal: PatchProposal) {
    await this.updateSession(sessionId, (session) => {
      session.patchProposals.push(proposal);
    });
    this.eventBus.publish({ type: "runtime.patch.proposed", sessionId, proposal });
  }

  async addCommandRequest(sessionId: string, commandRequest: CommandRequest) {
    await this.updateSession(sessionId, (session) => {
      session.commandRequests.push(commandRequest);
    });
    this.eventBus.publish({
      type: "runtime.command.requested",
      sessionId,
      commandRequest
    });
  }

  async addCommandExecution(sessionId: string, commandExecution: CommandExecutionRecord) {
    await this.updateSession(sessionId, (session) => {
      session.commandExecutions.push(commandExecution);
      const request = session.commandRequests.find((candidate) => candidate.id === commandExecution.requestId);
      if (request) {
        request.status =
          commandExecution.status === "executed"
            ? "executed"
            : commandExecution.status === "blocked"
              ? "blocked"
              : request.status;
      }
    });
    this.eventBus.publish({
      type: "runtime.command.requested",
      sessionId,
      commandRequest: {
        id: commandExecution.requestId ?? commandExecution.id,
        sessionId,
        command: commandExecution.command,
        cwd: commandExecution.cwd,
        risk: commandExecution.risk,
        reason: commandExecution.message ?? "Command execution recorded",
        status: commandExecution.status === "executed" ? "executed" : commandExecution.status === "blocked" ? "blocked" : "requested",
        createdAt: commandExecution.createdAt
      }
    });
  }

  async replaceTasks(sessionId: string, tasks: Task[]) {
    await this.updateSession(sessionId, (session) => {
      session.tasks = tasks;
    });
  }

  async setPatchStatus(sessionId: string, patchId: string, status: PatchProposal["status"]) {
    return this.updateSession(sessionId, (session) => {
      const proposal = session.patchProposals.find((candidate) => candidate.id === patchId);
      if (!proposal) {
        throw new Error("Patch proposal not found");
      }
      proposal.status = status;
    });
  }

  async addOrchestrationEvent(sessionId: string, event: OrchestrationEvent) {
    await this.updateSession(sessionId, (session) => {
      if (!session.orchestration) return;
      session.orchestration.orchestrationEvents.push(event);
    });
    this.eventBus.publish({ type: "runtime.orchestration.event", sessionId, event });
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
    const state: PersistedState = { sessions: this.listSessions() };
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

export function randomId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}
