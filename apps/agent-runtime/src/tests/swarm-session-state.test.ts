import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRun,
  AgentRuntimeSession,
  BranchOrchestratorRecord,
  RecursiveBranchExecutionRecord,
  SanitizedProviderConfig
} from "@hivo/protocol";
import { defaultSafetySettings } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { buildAgentRuntimeSwarmState } from "../runtime/SwarmSessionState.js";
import { buildServer } from "../server.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("swarm state is built from orchestrated runtime agents and work statuses", async () => {
  const fixture = await createRuntimeFixture("orchestrated");
  try {
    const updated = await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "running";
      draft.delegationDecision = {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: 3,
        selectedAgentRoles: ["FrontendAgent", "ApiAgent", "Security Specialist"],
        agentRoleReasons: [],
        estimatedComplexity: "medium",
        rationale: "Test staffing uses real orchestration session records."
      };
      draft.orchestration ??= emptyOrchestration(draft);
      draft.orchestration.agentRuns = [
        agentRun(draft, {
          id: "agent_frontend",
          role: "FrontendAgent",
          status: "running",
          artifactJson: {
            swarmRunId: "swarm_provider_real",
            currentWorkItemId: "work_ui",
            workerMode: "provider_read_only"
          },
          changedFiles: ["apps/desktop/src/app/App.tsx"]
        }),
        agentRun(draft, {
          id: "agent_security",
          role: "Security Specialist",
          status: "completed",
          currentTask: "work_security",
          lastEvent: "Reviewed scoped endpoint risks.",
          completedAt: "2026-06-22T10:10:00.000Z"
        })
      ];
      draft.agentWorkStatuses = [{
        agentName: "Runtime Tester",
        role: "Tester Specialist",
        taskTitle: "work_runtime_test",
        objective: "Validate swarm scoped steer behavior.",
        status: "queued",
        targetFiles: ["apps/agent-runtime/src/runtime/AgentRuntime.ts"],
        summary: "Waiting for runtime endpoint tests.",
        updatedAt: "2026-06-22T10:11:00.000Z"
      }];
    });

    const state = updated.swarmState ?? buildAgentRuntimeSwarmState(updated);
    assert.equal(state.sessionId, fixture.session.id);
    assert.equal(state.swarmRunId, "swarm_provider_real");
    assert.equal(state.source, "mixed");
    assert.equal(state.effectiveTotalLogicalAgents, 3);
    assert.ok(state.nodes.some((node) => node.id === state.rootId && node.kind === "root"));
    assert.ok(state.nodes.some((node) => node.kind === "group" && node.parentId === state.rootId && node.name.includes("Frontend")));
    assert.ok(state.nodes.some((node) => node.id === "agent_frontend" && node.workItemRefs.includes("work_ui")));
    assert.equal(state.nodes.find((node) => node.id === "agent_frontend")?.parentId?.startsWith(`group:${fixture.session.id}:role_`), true);
    assert.ok(state.nodes.some((node) => node.kind === "work_item" && node.workItemRefs.includes("work_ui") && node.parentId === "agent_frontend"));
    assert.ok(state.nodes.some((node) => node.id === "agent_security" && node.kind === "specialist"));
    assert.ok(state.nodes.some((node) => node.id === "work-status:Runtime Tester:Tester Specialist"));
    assert.equal(state.activeAgentCount, 2);
    assert.equal(state.staffingPlan?.roleCounts.FrontendAgent, 1);
    assert.equal(state.staffingPlan?.roleCounts["Security Specialist"], 1);
    assert.equal(state.staffingPlan?.roleCounts["Tester Specialist"], 1);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("swarm state includes recursive branch coordinators and nested dynamic subtasks", async () => {
  const fixture = await createRuntimeFixture("recursive");
  try {
    const updated = await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.executionMode = "recursive_factory";
      draft.recursiveFactory = {
        phase: "branch_execution_running",
        executionStarted: true,
        updatedAt: "2026-06-22T10:12:00.000Z",
        branchOrchestrators: [branchOrchestrator(draft)],
        branchExecutions: [branchExecution(draft)]
      };
    });

    const state = updated.swarmState ?? buildAgentRuntimeSwarmState(updated);
    const branch = state.nodes.find((node) => node.id === "recursive-branch:branch_ui");
    const subtask = state.nodes.find((node) => node.id === "recursive-subtask:branch_ui_a11y");

    assert.equal(state.source, "recursive_factory");
    assert.equal(branch?.kind, "coordinator");
    assert.equal(branch?.status, "running");
    assert.equal(subtask?.parentId, "recursive-branch:branch_ui");
    assert.equal(subtask?.kind, "worker");
    assert.equal(subtask?.status, "queued");
    assert.deepEqual(subtask?.targetFiles, ["apps/desktop/src/app/SwarmDock.tsx"]);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("swarm state keeps 300 logical agents usable without synthetic expansion", async () => {
  const fixture = await createRuntimeFixture("large");
  try {
    const updated = await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.delegationDecision = {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: 300,
        selectedAgentRoles: ["ScoutAgent x300"],
        agentRoleReasons: [],
        estimatedComplexity: "high",
        rationale: "Large provider-backed read-only audit."
      };
      draft.orchestration ??= emptyOrchestration(draft);
      draft.orchestration.agentRuns = Array.from({ length: 300 }, (_, index) => agentRun(draft, {
        id: `agent_${String(index + 1).padStart(3, "0")}`,
        role: "ScoutAgent",
        status: index % 3 === 0 ? "running" : index % 3 === 1 ? "completed" : "idle",
        currentTask: `work_${index + 1}`,
        artifactJson: {
          swarmRunId: "swarm_large_300",
          currentWorkItemId: `work_${index + 1}`,
          workerMode: "provider_read_only"
        }
      }));
    });

    const state = updated.swarmState ?? buildAgentRuntimeSwarmState(updated);
    assert.equal(state.maxSupportedLogicalAgents, 300);
    assert.equal(state.effectiveTotalLogicalAgents, 300);
    assert.equal(state.nodes.filter((node) => node.kind === "worker" || node.kind === "specialist" || node.kind === "coordinator").length, 300);
    assert.equal(state.nodes.filter((node) => node.kind === "work_item").length, 300);
    assert.equal(state.nodes.filter((node) => node.parentId === state.rootId && node.kind === "group").length, 1);
    assert.equal(state.nodes.filter((node) => node.parentId === state.rootId && node.id.startsWith("agent_")).length, 0);
    assert.equal(state.activeAgentCount, 100);
    assert.equal(state.staffingPlan?.roleCounts.ScoutAgent, 300);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("swarm state projects run gates and mixed specialists as layered children", async () => {
  const fixture = await createRuntimeFixture("gates");
  try {
    const updated = await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.status = "completed";
      draft.delegationDecision = {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: 4,
        selectedAgentRoles: ["ReviewerAgent x1", "TesterAgent x1", "Performance Specialist x1", "IntegratorAgent x1"],
        agentRoleReasons: [],
        estimatedComplexity: "medium",
        rationale: "Mixed review, test, specialist, and integration staffing."
      };
      draft.orchestration ??= emptyOrchestration(draft);
      draft.orchestration.agentRuns = [
        agentRun(draft, { id: "agent_review", role: "ReviewerAgent", status: "completed", currentTask: "work_review" }),
        agentRun(draft, { id: "agent_test", role: "TesterAgent", status: "completed", currentTask: "work_test" }),
        agentRun(draft, { id: "agent_perf", role: "Performance Specialist", status: "completed", currentTask: "work_perf" }),
        agentRun(draft, { id: "agent_integrator", role: "IntegratorAgent", status: "completed", currentTask: "work_integrate" })
      ];
      draft.runSummary = {
        status: "completed",
        summary: "Mixed swarm completed.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [
          { name: "ReviewerGate", status: "passed", notes: ["review passed"] },
          { name: "TestGate", status: "passed", notes: ["tests passed"] },
          { name: "ConflictGate", status: "blocked", notes: ["conflict review required"] }
        ],
        createdAt: "2026-06-22T10:20:00.000Z"
      };
    });

    const state = updated.swarmState ?? buildAgentRuntimeSwarmState(updated);
    const rootGroups = state.nodes.filter((node) => node.parentId === state.rootId && node.kind === "group");
    assert.ok(rootGroups.some((node) => node.name === "Runtime gates"));
    assert.ok(state.nodes.some((node) => node.kind === "gate" && node.name === "ConflictGate" && node.status === "blocked"));
    assert.ok(state.nodes.some((node) => node.id === "agent_perf" && node.kind === "specialist"));
    assert.equal(state.effectiveTotalLogicalAgents, 4);
    assert.equal(state.nodes.filter((node) => node.kind === "work_item").length, 4);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("scoped steer records active-agent messages and answers terminal agents through provider context", async () => {
  const fixture = await createRuntimeFixture("scoped");
  const provider = new ScopedProvider();
  try {
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir: fixture.storageDir }, fixture.manager, {
      providerFactory: () => provider
    });
    await fixture.manager.updateSession(fixture.session.id, (draft) => {
      draft.providerConfig = validProviderConfig;
      draft.activeProviderSource = "session_override";
      draft.orchestration ??= emptyOrchestration(draft);
      draft.orchestration.agentRuns = [
        agentRun(draft, {
          id: "agent_running",
          role: "FrontendAgent",
          status: "running",
          currentTask: "work_running"
        }),
        agentRun(draft, {
          id: "agent_done",
          role: "ReviewerAgent",
          status: "completed",
          currentTask: "work_review",
          completedAt: "2026-06-22T10:15:00.000Z",
          lastEvent: "Review completed from recorded evidence."
        })
      ];
    });

    const recorded = await runtime.sendAgentScopedMessage(fixture.session.id, "agent_running", "please focus on keyboard navigation");
    assert.equal(recorded.status, "recorded");
    assert.equal(provider.textCalls.length, 0);
    assert.ok(recorded.session.swarmState?.messages.some((message) => message.agentId === "agent_running" && message.content.includes("keyboard")));
    assert.ok(recorded.session.orchestration?.agentRuns.find((agent) => agent.id === "agent_running")?.workJournal?.some((entry) => entry.title === "Scoped steer received"));

    const answered = await runtime.sendAgentScopedMessage(fixture.session.id, "agent_done", "what did you review?");
    assert.equal(answered.status, "answered");
    assert.equal(provider.textCalls.length, 1);
    assert.match(answered.response?.content ?? "", /PROVIDER_SCOPED_ANSWER/);
    assert.ok(answered.session.swarmState?.messages.some((message) => message.agentId === "agent_done" && message.role === "agent"));
    assert.ok(provider.textCalls[0]?.contextText.includes("Review completed from recorded evidence"));

    await assert.rejects(
      () => runtime.sendAgentScopedMessage(fixture.session.id, "agent_missing", "hello"),
      /agent_not_found/
    );

    const syntheticState = fixture.manager.getSession(fixture.session.id)?.swarmState;
    const groupId = syntheticState?.nodes.find((node) => node.kind === "group")?.id ?? "";
    const workItemId = syntheticState?.nodes.find((node) => node.kind === "work_item")?.id ?? "";
    assert.ok(groupId);
    assert.ok(workItemId);
    await assert.rejects(
      () => runtime.sendAgentScopedMessage(fixture.session.id, groupId, "hello group"),
      /agent_not_messageable/
    );
    await assert.rejects(
      () => runtime.sendAgentScopedMessage(fixture.session.id, workItemId, "hello work item"),
      /agent_not_messageable/
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

test("scoped steer endpoint enforces auth and rejects unknown agents", async () => {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), "hivo-swarm-endpoint-"));
  const server = await buildServer({ ...loadConfig(), storageDir });
  try {
    const token = "token-endpoint-test";
    const created = await server.runtime.createSession({
      workspacePath: storageDir,
      mode: "real_provider",
      executionMode: "orchestrated_mode",
      providerConfig: validProviderConfig,
      activeProviderSource: "session_override",
      userPrompt: "Endpoint auth fixture",
      sessionToken: token
    });
    await server.sessionManager.updateSession(created.sessionId, (draft) => {
      draft.orchestration ??= emptyOrchestration(draft);
      draft.orchestration.agentRuns = [agentRun(draft, {
        id: "agent_endpoint",
        role: "EndpointAgent",
        status: "running",
        currentTask: "work_endpoint"
      })];
    });

    const unauthorized = await server.app.inject({
      method: "POST",
      url: `/sessions/${created.sessionId}/agents/agent_endpoint/messages`,
      payload: { message: "hello" }
    });
    assert.equal(unauthorized.statusCode, 401);

    const unknown = await server.app.inject({
      method: "POST",
      url: `/sessions/${created.sessionId}/agents/agent_missing/messages`,
      headers: { "x-hivo-session-token": token },
      payload: { message: "hello" }
    });
    assert.equal(unknown.statusCode, 404);

    const accepted = await server.app.inject({
      method: "POST",
      url: `/sessions/${created.sessionId}/agents/agent_endpoint/messages`,
      headers: { "x-hivo-session-token": token },
      payload: { message: "use recorded endpoint context" }
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal((accepted.json() as { status: string }).status, "recorded");
  } finally {
    await server.app.close();
    await rm(storageDir, { recursive: true, force: true });
  }
});

type RuntimeFixture = {
  manager: SessionManager;
  session: AgentRuntimeSession;
  storageDir: string;
};

async function createRuntimeFixture(name: string): Promise<RuntimeFixture> {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), `hivo-swarm-${name}-`));
  const manager = new SessionManager(storageDir, new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: storageDir,
    mode: "real_provider",
    executionMode: "orchestrated_mode",
    providerConfig: validProviderConfig,
    activeProviderSource: "session_override",
    userPrompt: "Inspect real swarm runtime state"
  });
  return { manager, session, storageDir };
}

async function cleanupFixture(fixture: RuntimeFixture) {
  await rm(fixture.storageDir, { recursive: true, force: true });
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
    artifactJson: input.artifactJson,
    objective: input.objective ?? `Work on ${session.userPrompt}`,
    ownedPaths: input.ownedPaths ?? [],
    changedFiles: input.changedFiles ?? [],
    currentTask: input.currentTask,
    status: input.status,
    lastEvent: input.lastEvent,
    workJournal: input.workJournal,
    startedAt: input.startedAt ?? "2026-06-22T10:00:00.000Z",
    completedAt: input.completedAt
  };
}

function branchOrchestrator(session: AgentRuntimeSession): BranchOrchestratorRecord {
  return {
    branchId: "branch_ui",
    sessionId: session.id,
    graphId: "graph_1",
    title: "Swarm dock UI branch",
    objective: "Implement the real-agent swarm dock.",
    ownerRole: "UI Branch Coordinator",
    inputContextRequirements: ["Runtime session protocol"],
    fileScopes: ["apps/desktop/src/app/SwarmDock.tsx"],
    semanticScopes: ["desktop swarm UI"],
    lockScopes: ["apps/desktop/src/app"],
    dependencies: [],
    expectedOutputs: ["Dock graph", "Inspector"],
    reviewerRequirements: ["No mock agents"],
    testerRequirements: ["Browser and desktop smoke"],
    status: "running",
    risks: ["Large swarm rendering"],
    validationStrategy: ["npm run build -w @hivo/desktop"],
    expectedIntegrationPoints: ["App toolbar"],
    createdAt: "2026-06-22T10:12:00.000Z",
    updatedAt: "2026-06-22T10:12:10.000Z"
  };
}

function branchExecution(session: AgentRuntimeSession): RecursiveBranchExecutionRecord {
  return {
    branchId: "branch_ui",
    sessionId: session.id,
    title: "Swarm dock UI branch",
    status: "running",
    active: true,
    executionContext: {
      branchObjective: "Render swarm state without synthetic expansion.",
      approvedProductSpecSummary: "Use real runtime agents.",
      approvedTechnicalPlanSummary: "Canvas edges and culled chips.",
      fileScopes: ["apps/desktop/src/app/SwarmDock.tsx"],
      semanticScopes: ["desktop swarm UI"],
      lockScopes: ["apps/desktop/src/app"],
      dependencies: [],
      evidenceContextPack: ["protocol:swarmState"]
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: true
    },
    nestedSubtasks: [{
      subtaskId: "branch_ui_a11y",
      sessionId: session.id,
      parentBranchId: "branch_ui",
      depth: 1,
      objective: "Verify keyboard navigation and filters.",
      fileScopes: ["apps/desktop/src/app/SwarmDock.tsx"],
      dependencies: [],
      expectedOutput: "Keyboard-accessible dock",
      reviewerRequirement: "Focusable nodes",
      validatorRequirement: "Typecheck",
      status: "ready",
      required: true,
      writeSubtask: false,
      patchApplied: false,
      validationStatus: "unverified",
      active: false,
      createdAt: "2026-06-22T10:12:12.000Z",
      updatedAt: "2026-06-22T10:12:14.000Z"
    }],
    reviewStatus: "pending",
    validationStatus: "unverified",
    validationPlan: ["npm run typecheck -w @hivo/desktop"],
    patchApplied: false,
    createdAt: "2026-06-22T10:12:11.000Z",
    updatedAt: "2026-06-22T10:12:15.000Z"
  };
}

class ScopedProvider implements LlmProvider {
  readonly textCalls: Array<{ userPrompt: string; contextText: string }> = [];

  async generateStructured<T>(): Promise<T> {
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls.push({
      userPrompt: input.userPrompt,
      contextText: JSON.stringify(input.context)
    });
    return "PROVIDER_SCOPED_ANSWER: reviewed stored agent context only.";
  }
}
