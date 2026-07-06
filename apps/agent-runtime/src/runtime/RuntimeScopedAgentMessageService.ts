import type {
  AgentRuntimeSession,
  AgentRuntimeSwarmMessage,
  AgentRuntimeSwarmNode,
  AgentScopedMessageResponse
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { resolveModelCertification } from "../evals/ReasoningCertificationRegistry.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import {
  createProviderTelemetryRecorder,
  TelemetryLlmProvider
} from "../llm/ProviderTelemetry.js";
import { appendAgentJournalEntry } from "./AgentTelemetry.js";
import { invokeReasoningProviderText } from "./ReasoningKernel.js";
import { SessionManager } from "./SessionManager.js";
import { buildAgentRuntimeSwarmState } from "./SwarmSessionState.js";

export type ScopedAgentProviderFactory = (session: AgentRuntimeSession) => LlmProvider;

export class RuntimeScopedAgentMessageService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly getProvider: ScopedAgentProviderFactory
  ) {}

  async send(sessionId: string, agentId: string, message: string): Promise<AgentScopedMessageResponse> {
    const content = message.trim();
    if (!content) throw new Error("agent_message_empty");
    const session = this.requireSession(sessionId);
    const swarmState = session.swarmState ?? buildAgentRuntimeSwarmState(session);
    const node = swarmState.nodes.find((candidate) => candidate.id === agentId);
    if (!node) throw new Error("agent_not_found");
    if (!isMessageableSwarmNode(node)) throw new Error("agent_not_messageable");

    const userMessage: AgentRuntimeSwarmMessage = {
      id: `agent_msg_${randomUUID()}`,
      agentId,
      role: "user",
      content,
      status: "recorded",
      createdAt: new Date().toISOString()
    };
    await this.record(sessionId, userMessage, {
      journalTitle: "Scoped steer received",
      journalStatus: node.status === "running" || node.status === "queued" ? "queued" : "completed"
    });

    if (node.status === "running" || node.status === "queued" || node.status === "idle") {
      return {
        sessionId,
        agentId,
        status: "recorded",
        message: userMessage,
        session: this.requireSession(sessionId)
      };
    }

    const afterRecord = this.requireSession(sessionId);
    const modelCertification = resolveModelCertification(afterRecord.workspacePath, afterRecord.providerConfig);
    const providerTelemetry = createProviderTelemetryRecorder({
      mode: afterRecord.mode,
      providerConfig: afterRecord.providerConfig,
      activeProviderSource: afterRecord.activeProviderSource,
      modelCertification
    });
    const provider = new TelemetryLlmProvider(this.getProvider(afterRecord), providerTelemetry);
    const answer = await invokeReasoningProviderText(provider, {
      purpose: "compose",
      maxOutputTokens: 700,
      maxContextChars: 32_000,
      systemPrompt: [
        "You are answering as a real Hivo runtime agent from persisted agent context.",
        "Answer only from the supplied agent/session records.",
        "If the records do not contain enough information, say that the agent does not have that information recorded.",
        "Do not invent work, files, commands, or outcomes."
      ].join("\n"),
      userPrompt: content,
      context: {
        agent: node,
        recent_agent_messages: afterRecord.swarmState?.messages.filter((entry) => entry.agentId === agentId).slice(-12) ?? [],
        session: {
          id: afterRecord.id,
          status: afterRecord.status,
          lifecycleStage: afterRecord.lifecycleStage,
          runSummary: afterRecord.runSummary,
          verificationResult: afterRecord.verificationResult,
          tasks: afterRecord.tasks.filter((task) => node.workItemRefs.includes(task.id)),
          workerOutputs: afterRecord.orchestration?.workerOutputs.filter((output) => node.workItemRefs.includes(output.taskId) || output.agentName === node.name)
        }
      }
    });
    const responseMessage: AgentRuntimeSwarmMessage = {
      id: `agent_msg_${randomUUID()}`,
      agentId,
      role: "agent",
      content: answer.trim(),
      status: "answered",
      providerRequestRefs: providerTelemetry.snapshot().providerRequestRefs,
      createdAt: new Date().toISOString()
    };
    await this.record(sessionId, responseMessage, {
      journalTitle: "Scoped read-only answer recorded",
      journalStatus: "completed",
      providerTelemetry: providerTelemetry.snapshot()
    });
    return {
      sessionId,
      agentId,
      status: "answered",
      message: userMessage,
      response: responseMessage,
      session: this.requireSession(sessionId)
    };
  }

  private async record(
    sessionId: string,
    message: AgentRuntimeSwarmMessage,
    options: {
      journalTitle: string;
      journalStatus: import("@hivo/protocol").AgentWorkJournalStatus;
      providerTelemetry?: AgentRuntimeSession["providerTelemetry"];
    }
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const previousMessages = draft.swarmState?.messages ?? [];
      draft.swarmState = buildAgentRuntimeSwarmState(draft, [...previousMessages, message]);
      if (options.providerTelemetry) {
        draft.providerTelemetry = options.providerTelemetry;
      }
      const agent = draft.orchestration?.agentRuns.find((candidate) => candidate.id === message.agentId);
      if (agent) {
        appendAgentJournalEntry(agent, {
          kind: message.role === "user" ? "decision" : "completed",
          title: options.journalTitle,
          summary: message.content,
          status: options.journalStatus
        });
      }
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function isMessageableSwarmNode(node: AgentRuntimeSwarmNode) {
  return node.kind === "worker" || node.kind === "specialist" || node.kind === "coordinator" || node.kind === "aggregator";
}
