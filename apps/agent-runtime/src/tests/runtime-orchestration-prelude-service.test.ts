import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, ProjectMap } from "@hivo/protocol";
import { EventBus } from "../runtime/EventBus.js";
import type { ConversationUnderstanding } from "../runtime/ConversationUnderstanding.js";
import {
  resolveRuntimeMode,
  RuntimeOrchestrationPreludeService
} from "../runtime/RuntimeOrchestrationPreludeService.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("runtime orchestration prelude builds project map, intake, and mode resolution", async () => {
  const fixture = await createFixture("prelude-build", "auto_mode");
  try {
    const prelude = new RuntimeOrchestrationPreludeService().build({
      session: fixture.session,
      prompt: "Plan first and build a small TypeScript feature",
      swarmMode: "recursive_tree"
    });

    assert.equal(prelude.projectMap.packageManagers.includes("npm"), true);
    assert.equal(prelude.projectMap.importantFiles.includes("package.json"), true);
    assert.equal(prelude.intake.workspaceRoot, fixture.workspace);
    assert.equal(prelude.intake.knownEntryPoints.includes("src/main.ts"), true);
    assert.equal(prelude.thinkFirst, true);
    assert.equal(prelude.swarmMode, "recursive_tree");
    assert.equal(prelude.modeResolution.directive.thinkFirstRequested, true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("runtime mode resolution upgrades high complexity simple route to orchestrated", () => {
  const mode = resolveRuntimeMode({
    sessionMode: "auto_mode",
    prompt: "Build a 3D Three.js game with animation, physics, canvas, and tests",
    projectMap: projectMap(),
    conversationUnderstanding: conversationUnderstanding("simple_run")
  });

  assert.equal(mode.mode, "orchestrated_mode");
  assert.equal(mode.complexity, "high");
});

test("runtime mode resolution preserves explicit session mode", () => {
  const mode = resolveRuntimeMode({
    sessionMode: "simple_mode",
    prompt: "use 5 agents to build a 3D game",
    projectMap: projectMap(),
    conversationUnderstanding: conversationUnderstanding("orchestrated_run")
  });

  assert.equal(mode.mode, "simple_mode");
  assert.equal(mode.directive.explicitMode, "orchestrated_mode");
});

async function createFixture(name: string, executionMode: AgentRuntimeSession["executionMode"]) {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-prelude-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const value = 1;\n", "utf8");
  const manager = new SessionManager(path.join(workspace, ".runtime-test"), new EventBus(), {
    runtimeEventLoader: async () => []
  });
  await manager.load();
  const session = await manager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    executionMode,
    userPrompt: "Build a small feature"
  });
  return { workspace, manager, session };
}

function projectMap(): ProjectMap {
  return {
    stack: ["typescript", "webgl", "game"],
    packageManagers: ["npm"],
    testCommands: ["npm test"],
    entryPoints: ["src/main.ts"],
    importantFiles: ["package.json", "src/main.ts"]
  };
}

function conversationUnderstanding(route: ConversationUnderstanding["routeDecision"]["route"]): ConversationUnderstanding {
  return {
    originalMessage: "Build a 3D game",
    workspaceMessage: "Build a 3D game",
    preparedPrompt: {
      originalMessage: "Build a 3D game",
      workspaceMessage: "Build a 3D game",
      droppedPreamble: ""
    },
    intentDecision: {
      kind: "workspace_action",
      language: "english",
      needsWorkspace: true,
      confidence: "high",
      rationale: "Fixture route."
    },
    routeDecision: {
      route,
      confidence: "high",
      language: "english",
      normalizedPrompt: "build a 3d game",
      workspacePrompt: "build a 3d game",
      rationale: "Fixture route."
    }
  };
}
