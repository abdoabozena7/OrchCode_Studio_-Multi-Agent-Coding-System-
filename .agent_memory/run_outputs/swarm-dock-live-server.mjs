import path from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultSafetySettings } from "@hivo/protocol";
import { loadConfig } from "../../apps/agent-runtime/src/config.ts";
import { buildServer } from "../../apps/agent-runtime/src/server.ts";

const workspacePath = path.resolve(".");
const storageDir = path.join(workspacePath, ".agent_memory", "run_outputs", "swarm-dock-live-storage");
await mkdir(storageDir, { recursive: true });

const sessionToken = process.env.HIVO_SWARM_SMOKE_TOKEN ?? "swarm-smoke-ui-token";
const config = {
  ...loadConfig(),
  host: "127.0.0.1",
  port: Number(process.env.HIVO_AGENT_PORT ?? "4317"),
  storageDir
};

const { app, sessionManager } = await buildServer(config);
const session = await sessionManager.createSession({
  workspacePath,
  mode: "real_provider",
  executionMode: "orchestrated_mode",
  accessProfile: "full_access",
  providerConfig: {
    providerType: "ollama",
    providerName: "Ollama",
    baseUrl: "http://127.0.0.1:11434",
    selectedModel: "swarm-smoke-provider",
    isValid: true
  },
  activeProviderSource: "session_override",
  userPrompt: "Swarm dock smoke 300 agents",
  sessionToken,
  sessionTokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
});

async function seedSession(sessionId) {
  await sessionManager.updateSession(sessionId, (draft) => {
  draft.status = "running";
  draft.lifecycleStage = "EXECUTION";
  draft.delegationDecision = {
    resolvedMode: "orchestrated_mode",
    selectedAgentCount: 300,
    selectedAgentRoles: ["ScoutAgent x180", "VerifierAgent x60", "SpecialistAgent x60"],
    agentRoleReasons: [],
    estimatedComplexity: "high",
    rationale: "Live UI smoke for a 300-agent provider-backed audit state."
  };
  draft.orchestration = {
    agentRuns: Array.from({ length: 300 }, (_, index) => {
      const number = index + 1;
      const role =
        index % 10 === 0 ? "Security Specialist" :
        index % 5 === 0 ? "VerifierAgent" :
        "ScoutAgent";
      const status =
        index % 11 === 0 ? "blocked" :
        index % 7 === 0 ? "failed" :
        index % 3 === 0 ? "running" :
        index % 3 === 1 ? "completed" :
        "idle";
      return {
        id: `agent_${String(number).padStart(3, "0")}`,
        sessionId: draft.id,
        agentName: role,
        displayName: `${role} ${number}`,
        role,
        roleTitle: role,
        lifecycleStage: status === "completed" ? "COMPLETED" : "EXECUTION_DRAFT",
        objective: `Inspect runtime-backed swarm work item ${number}.`,
        ownedPaths: index % 4 === 0 ? ["apps/desktop/src/app/SwarmDock.tsx"] : ["apps/agent-runtime/src/runtime/SwarmSessionState.ts"],
        changedFiles: index % 9 === 0 ? ["apps/desktop/src/app/styles.css"] : [],
        currentTask: `work_${String(number).padStart(3, "0")}`,
        status,
        lastEvent: `${role} ${number} reported ${status} from runtime smoke state.`,
        artifactJson: {
          swarmRunId: "swarm_live_smoke_300",
          agentInstanceId: `instance_${String(number).padStart(3, "0")}`,
          currentWorkItemId: `work_${String(number).padStart(3, "0")}`,
          artifactRefs: [`artifact_${String(number).padStart(3, "0")}`],
          workerMode: "provider_read_only"
        },
        workJournal: [{
          title: "Runtime smoke journal",
          detail: `Live journal entry for ${role} ${number}.`,
          createdAt: new Date(Date.now() - number * 1000).toISOString()
        }],
        startedAt: new Date(Date.now() - number * 30_000).toISOString(),
        completedAt: status === "completed" ? new Date(Date.now() - number * 1000).toISOString() : undefined
      };
    }),
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: defaultSafetySettings,
    lockedFiles: {},
    selectedWorkerAgents: ["ScoutAgent", "VerifierAgent", "Security Specialist"],
    mandatoryGateAgents: [],
    workOrders: Array.from({ length: 12 }, (_, index) => ({
      id: `work_order_${index + 1}`,
      title: `Swarm work order ${index + 1}`,
      objective: "Verify dock rendering, filtering, selection, and scoped steer with real runtime state.",
      assignedAgentRole: index % 3 === 0 ? "Security Specialist" : index % 3 === 1 ? "VerifierAgent" : "ScoutAgent",
      targetFiles: ["apps/desktop/src/app/SwarmDock.tsx"],
      status: index % 2 === 0 ? "running" : "queued"
    })),
    qualityGateResults: [],
    retryCount: 0
  };
  draft.agentWorkStatuses = [{
    agentName: "Runtime Scheduler",
    role: "Coordinator",
    taskTitle: "live_300_agent_smoke",
    objective: "Maintain the seeded 300-agent state for UI verification.",
    status: "running",
    targetFiles: ["apps/desktop/src/app/SwarmDock.tsx"],
    summary: "Smoke session is served by the runtime API.",
    updatedAt: new Date().toISOString()
  }];
  draft.artifacts = Array.from({ length: 8 }, (_, index) => ({
    id: `artifact_${String(index + 1).padStart(3, "0")}`,
    title: `Swarm artifact ${index + 1}`,
    kind: "text",
    content: `Runtime smoke artifact ${index + 1}`,
    createdAt: new Date().toISOString()
  }));
  });
  return sessionManager.getSession(sessionId);
}

await seedSession(session.id);

app.post("/__smoke/seed/:id", async (request, reply) => {
  const { id } = request.params;
  if (!sessionManager.getSession(id)) {
    return reply.status(404).send({ error: "Session not found" });
  }
  return seedSession(id);
});

await app.listen({ host: config.host, port: config.port });
console.log(JSON.stringify({
  status: "listening",
  url: `http://${config.host}:${config.port}`,
  sessionId: session.id,
  sessionToken,
  storageDir
}));
