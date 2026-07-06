import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession, ProjectMap } from "@hivo/protocol";
import {
  RuntimeOrchestrationDispatchService,
  type SimpleRuntimeDispatchOptions
} from "../runtime/RuntimeOrchestrationDispatchService.js";
import type { ConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import type { RuntimeModeResolution } from "../runtime/RuntimeOrchestrationPreludeService.js";

test("runtime orchestration dispatch keeps recursive tree for unrouted orchestrated mode", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls)
  });

  assert.equal(result.branch, "recursive_swarm");
  assert.deepEqual(calls, ["recursive_swarm"]);
  assert.equal(result.session.agentName, "recursive_swarm");
});

test("runtime orchestration dispatch routes provider-authored read-only swarm before recursive tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls),
    conversationUnderstanding: routeUnderstanding("swarm_readonly")
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch routes provider-authored orchestrated runs before recursive tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "recursive_tree", calls),
    conversationUnderstanding: routeUnderstanding("orchestrated_run")
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch routes provider-classified run requests to simple run-to-green", async () => {
  const calls: string[] = [];
  let observed: SimpleRuntimeDispatchOptions | undefined;
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("simple_mode", "recursive_tree", calls),
    conversationUnderstanding: runRequestUnderstanding,
    branches: {
      ...branches(calls),
      simple: async (options) => {
        calls.push("simple");
        observed = options;
        return session("simple");
      }
    }
  });

  assert.equal(result.branch, "simple");
  assert.deepEqual(calls, ["simple"]);
  assert.equal(observed?.conversationUnderstanding?.intentDecision.kind, "run_request");
});

test("runtime orchestration dispatch selects recursive factory when swarm is not recursive tree", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("recursive_factory", "pipeline", calls)
  });

  assert.equal(result.branch, "recursive_factory");
  assert.deepEqual(calls, ["recursive_factory"]);
});

test("runtime orchestration dispatch selects provider-backed swarm for ordinary orchestrated mode", async () => {
  const calls: string[] = [];
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("orchestrated_mode", "pipeline", calls)
  });

  assert.equal(result.branch, "provider_backed_swarm");
  assert.deepEqual(calls, ["provider_backed_swarm"]);
});

test("runtime orchestration dispatch forwards simple run options", async () => {
  const calls: string[] = [];
  let observed: SimpleRuntimeDispatchOptions | undefined;
  const result = await new RuntimeOrchestrationDispatchService().dispatch({
    ...input("simple_mode", "pipeline", calls),
    thinkFirst: true,
    branches: {
      ...branches(calls),
      simple: async (options) => {
        calls.push("simple");
        observed = options;
        return session("simple");
      }
    }
  });

  assert.equal(result.branch, "simple");
  assert.deepEqual(calls, ["simple"]);
  assert.equal(observed?.resolvedMode, "simple_mode");
  assert.equal(observed?.thinkFirst, true);
  assert.deepEqual(observed?.projectMap.importantFiles, ["package.json"]);
});

function input(
  mode: RuntimeModeResolution["mode"],
  swarmMode: "recursive_tree" | "pipeline",
  calls: string[]
) {
  return {
    sessionId: "session-dispatch",
    prompt: "Build a small feature",
    projectMap,
    modeResolution: modeResolution(mode),
    swarmMode,
    thinkFirst: false,
    branches: branches(calls)
  };
}

function branches(calls: string[]) {
  return {
    recursiveSwarm: async () => {
      calls.push("recursive_swarm");
      return session("recursive_swarm");
    },
    recursiveFactory: async () => {
      calls.push("recursive_factory");
      return session("recursive_factory");
    },
    providerBackedSwarm: async () => {
      calls.push("provider_backed_swarm");
      return session("provider_backed_swarm");
    },
    simple: async () => {
      calls.push("simple");
      return session("simple");
    }
  };
}

function modeResolution(mode: RuntimeModeResolution["mode"]): RuntimeModeResolution {
  return {
    mode,
    directive: {
      explicitMode: mode,
      thinkFirstRequested: false
    },
    complexity: "medium"
  };
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: [],
  importantFiles: ["package.json"]
};

const runRequestUnderstanding = {
  intentDecision: {
    kind: "run_request",
    language: "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: "The provider classified this as a run request."
  },
  routeDecision: {
    route: "simple_run",
    confidence: "high",
    language: "english",
    normalizedPrompt: "run this project",
    workspacePrompt: "run this project",
    rationale: "The provider classified this as a run request."
  }
} as ConversationUnderstanding;

function routeUnderstanding(route: "swarm_readonly" | "orchestrated_run") {
  return {
    intentDecision: {
      kind: route === "swarm_readonly" ? "workspace_question" : "workspace_action",
      language: "english",
      needsWorkspace: true,
      confidence: "high",
      rationale: "The provider selected a canonical orchestrated route."
    },
    routeDecision: {
      route,
      confidence: "high",
      language: "english",
      normalizedPrompt: "explain architecture",
      workspacePrompt: "explain architecture",
      rationale: "The provider selected a canonical orchestrated route."
    }
  } as ConversationUnderstanding;
}

function session(agentName: string): AgentRuntimeSession {
  return ({
    id: "session-dispatch",
    agentName,
    status: "completed"
  } as unknown) as AgentRuntimeSession;
}
