import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectMap } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "../src/llm/LlmProvider.js";
import { EventBus } from "../src/runtime/EventBus.js";
import { RunEngine } from "../src/runtime/RunEngine.js";
import { SessionManager } from "../src/runtime/SessionManager.js";

async function main() {
  const fallbackScenario = await runSingleFilePygameFallbackScenario();
  const confirmScenario = await runThreeAgentConfirmScenario();
  console.log(JSON.stringify({ ok: true, fallbackScenario, confirmScenario }, null, 2));
}

async function runSingleFilePygameFallbackScenario() {
  const fixture = await createFixture("pygame-fallback");
  try {
    const provider = new InvalidPatchIntentProvider();
    const sessionManager = new SessionManager(fixture.storageDir, new EventBus());
    await sessionManager.load();
    const session = await sessionManager.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      accessProfile: "full_access",
      userPrompt: "make a one python code for a 3d snake game with pygame"
    });

    const updated = await new RunEngine(provider, sessionManager).runTurn(session.id, session.userPrompt ?? "", {
      resolvedMode: "simple_mode",
      projectMap: createPythonProjectMap([])
    });
    const stored = sessionManager.getSession(updated.id)!;
    assert.equal(stored.status, "needs_approval");
    assert.equal(stored.patchProposals.length > 0, true);
    assert.equal(stored.commandRequests[0]?.command, "python main.py");
    assert.match(stored.patchProposals[0]?.unifiedDiff ?? "", /import pygame/);
    assert.equal(
      stored.reasoningSummaries.includes("Provider patch output was invalid; using deterministic implementation fallback."),
      true
    );

    return {
      status: stored.status,
      nextAction: stored.nextAction?.kind ?? null,
      patchPath: stored.patchProposals[0]?.filesChanged[0]?.path ?? null,
      command: stored.commandRequests[0]?.command ?? null
    };
  } finally {
    await fixture.close();
  }
}

async function runThreeAgentConfirmScenario() {
  const fixture = await createFixture("pygame-confirm");
  try {
    const provider = new InvalidPatchIntentProvider();
    const sessionManager = new SessionManager(fixture.storageDir, new EventBus());
    await sessionManager.load();
    const prompt = "use 3 agents to make a one python code for a 3d snake game with py game";
    const session = await sessionManager.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      accessProfile: "full_access",
      userPrompt: prompt
    });

    const updated = await new RunEngine(provider, sessionManager).runTurn(session.id, prompt, {
      resolvedMode: "orchestrated_mode",
      projectMap: createPythonProjectMap([])
    });
    const stored = sessionManager.getSession(updated.id)!;
    assert.equal(stored.status, "needs_approval");
    assert.equal(stored.nextAction?.kind, "confirm_plan");
    assert.match(stored.nextAction?.message ?? "", /single Python file/i);
    assert.equal(stored.patchProposals.length, 0);

    return {
      status: stored.status,
      nextAction: stored.nextAction?.kind ?? null,
      message: stored.nextAction?.message ?? null
    };
  } finally {
    await fixture.close();
  }
}

type Fixture = {
  workspace: string;
  storageDir: string;
  close: () => Promise<void>;
};

async function createFixture(label: string): Promise<Fixture> {
  const workspace = path.join(os.tmpdir(), `orchcode-${label}-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-${label}-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  return {
    workspace,
    storageDir,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

function createPythonProjectMap(importantFiles: string[]): ProjectMap {
  return {
    stack: ["Python"],
    packageManagers: [],
    testCommands: ["python main.py"],
    entryPoints: importantFiles,
    importantFiles
  };
}

class InvalidPatchIntentProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "Create a one-file Pygame implementation.",
        reasoningSummary: "Single-file Python game requested.",
        mode: "edit_project",
        tasks: [
          {
            title: "Create a single-file Python game",
            objective: "Build the requested snake game in one file.",
            roleTitle: "Implementation Worker",
            targetFiles: ["main.py"]
          }
        ],
        acceptanceCriteria: ["Result stays in one Python file.", "The game loop is runnable."],
        risks: []
      } as T;
    }
    if (schemaName === "run-patch-intent") {
      return {
        title: "Invalid patch intent",
        summary: "Broken schema on purpose.",
        intents: [{ path: "main.py", reason: "broken" }]
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
