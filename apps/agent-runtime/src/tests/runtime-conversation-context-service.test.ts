import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession } from "@hivo/protocol";
import { RuntimeConversationContextService } from "../runtime/RuntimeConversationContextService.js";

test("RuntimeConversationContextService builds bounded same-session context without duplicating current user message", () => {
  const session = runtimeSession();
  const context = new RuntimeConversationContextService().buildSameSession(session, "current request");

  assert.equal(context.source, "same_session_messages");
  assert.equal(context.sessionId, session.id);
  assert.equal(context.currentMessage, "current request");
  assert.equal(context.messages.some((message) => message.content === "current request"), false);
  assert.equal(context.messages.some((message) => message.content.includes("[Scoped agent message for Reviewer (reviewer)]")), true);
  assert.equal(context.totalIncludedChars <= context.maxChars, true);
});

function runtimeSession(): AgentRuntimeSession {
  const now = new Date().toISOString();
  return {
    id: "session-conversation-context",
    workspacePath: "D:/workspace",
    mode: "real_provider",
    status: "running",
    lifecycleStage: "INTAKE",
    messages: [
      { id: "m1", role: "user", content: "first question", createdAt: now },
      { id: "m2", role: "assistant", content: "provider answer", providerRequestRefs: ["provider_request_1"], createdAt: now },
      { id: "m3", role: "user", content: "current request", createdAt: now }
    ],
    swarmState: {
      nodes: [{
        id: "agent-reviewer",
        name: "Reviewer",
        role: "reviewer",
        status: "completed",
        description: "reviews work",
        createdAt: now,
        updatedAt: now
      }],
      messages: [{
        id: "swarm-message-1",
        agentId: "agent-reviewer",
        role: "agent",
        content: "scoped review note",
        providerRequestRefs: ["provider_request_2"],
        createdAt: now
      }]
    },
    providerConfig: {
      providerType: "openai_compatible",
      baseUrl: "https://example.test",
      selectedModel: "test-model"
    },
    progressEvents: [],
    runSummaries: [],
    reasoningSummaries: [],
    patchProposals: [],
    commandRequests: [],
    commandResults: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now
  } as unknown as AgentRuntimeSession;
}
