import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRun,
  AgentRuntimeSession,
  SanitizedProviderConfig
} from "@hivo/protocol";
import { defaultSafetySettings } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { RuntimeScopedAgentMessageService } from "../runtime/RuntimeScopedAgentMessageService.js";
import { SessionManager } from "../runtime/SessionManager.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("RuntimeScopedAgentMessageService records running-agent steer without provider call", async () => {
  const fixture = await scopedFixture();
  try {
    const result = await fixture.service.send(fixture.sessionId, "agent_running", "focus keyboard navigation");
    assert.equal(result.status, "recorded");
    assert.equal(fixture.provider.textCalls.length, 0);
    assert.equal(result.session.swarmState?.messages.some((message) => message.agentId === "agent_running" && message.content.includes("keyboard")), true);
    assert.equal(result.session.orchestration?.agentRuns.find((agent) => agent.id === "agent_running")?.workJournal?.some((entry) => entry.title === "Scoped steer received"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("RuntimeScopedAgentMessageService answers completed agents through provider context", async () => {
  const fixture = await scopedFixture();
  try {
    const result = await fixture.service.send(fixture.sessionId, "agent_done", "what did you review?");
    assert.equal(result.status, "answered");
    assert.equal(fixture.provider.textCalls.length, 1);
    assert.match(result.response?.content ?? "", /PROVIDER_SCOPED_ANSWER/);
    assert.equal(result.response?.providerRequestRefs?.length, 1);
    assert.equal(result.session.providerTelemetry?.finalResponseSource, "none");
    assert.equal(result.session.providerTelemetry?.providerRequestRefs.length, 1);
    assert.equal(result.session.swarmState?.messages.some((message) => message.agentId === "agent_done" && message.role === "agent"), true);
    assert.match(fixture.provider.textCalls[0]?.contextText ?? "", /Review completed from recorded evidence/);
  } finally {
    await fixture.cleanup();
  }
});

async function scopedFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-scoped-message-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-scoped-message-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    activeProviderSource: "session_override",
    userPrompt: "Review accessibility"
  });
  await manager.updateSession(session.id, (draft) => {
    draft.orchestration = emptyOrchestration(draft);
    draft.orchestration.agentRuns = [
      agentRun(draft, {
        id: "agent_running",
        role: "FrontendAgent",
        status: "running",
        currentTask: "Improve keyboard navigation."
      }),
      agentRun(draft, {
        id: "agent_done",
        role: "ReviewerAgent",
        status: "completed",
        currentTask: "Review completed from recorded evidence.",
        completedAt: "2026-06-30T00:00:00.000Z",
        lastEvent: "Review completed from recorded evidence."
      })
    ];
  });
  const provider = new ScopedMessageProvider();
  return {
    workspace,
    storageDir,
    manager,
    provider,
    sessionId: session.id,
    service: new RuntimeScopedAgentMessageService(manager, () => provider),
    cleanup: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function emptyOrchestration(session: AgentRuntimeSession): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: defaultSafetySettings,
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}

function agentRun(
  session: AgentRuntimeSession,
  input: Partial<AgentRun> & Pick<AgentRun, "id" | "role" | "status">
): AgentRun {
  return {
    id: input.id,
    sessionId: session.id,
    agentName: input.agentName ?? String(input.role),
    displayName: input.displayName ?? String(input.role),
    role: input.role,
    roleTitle: input.roleTitle ?? String(input.role),
    lifecycleStage: input.lifecycleStage ?? "EXECUTION_DRAFT",
    objective: input.objective ?? `Work on ${session.userPrompt}`,
    ownedPaths: input.ownedPaths ?? [],
    changedFiles: input.changedFiles ?? [],
    currentTask: input.currentTask,
    status: input.status,
    lastEvent: input.lastEvent,
    workJournal: input.workJournal,
    startedAt: input.startedAt ?? "2026-06-30T00:00:00.000Z",
    completedAt: input.completedAt
  };
}

class ScopedMessageProvider implements LlmProvider {
  readonly textCalls: Array<{ userPrompt: string; contextText: string }> = [];

  async generateStructured<T>(): Promise<T> {
    throw new Error("structured_not_used");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls.push({
      userPrompt: input.userPrompt,
      contextText: JSON.stringify(input.context)
    });
    return "PROVIDER_SCOPED_ANSWER";
  }
}
