import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventBus } from "../runtime/EventBus.js";
import { RunEngine } from "../runtime/RunEngine.js";
import { SessionManager } from "../runtime/SessionManager.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("runtime session state is restored from durable snapshots across restarts", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-persist-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-persist-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "persist me\n", "utf8");

  const first = await buildServer({ ...loadConfig(), storageDir });
  const created = await first.runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "explain this repo"
  });
  await first.runtime.runTurn(created.sessionId, "explain this repo");
  const original = first.runtime.getSession(created.sessionId);
  await first.app.close();

  const second = await buildServer({ ...loadConfig(), storageDir });
  const restored = second.runtime.getSession(created.sessionId);

  assert.ok(original);
  assert.ok(restored);
  assert.equal((restored?.taskState as { restoreStatus?: string }).restoreStatus, "restored");
  assert.equal(restored?.taskState.restoreState?.source, "snapshot_restored");
  assert.equal(restored?.taskState.restoreState?.disposition, "terminal");
  assert.equal(restored?.taskState.transitions.some((entry) => entry.type === "session.restored"), true);

  await second.app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("session manager validates hashed session tokens without storing the raw token", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-token-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-token-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "token me\n", "utf8");

  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const session = await sessionManager.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "explain this repo",
    sessionToken: "plain-token",
    sessionTokenExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });

  assert.equal(sessionManager.validateSessionToken(session.id, "plain-token"), true);
  assert.equal(sessionManager.validateSessionToken(session.id, "wrong-token"), false);

  const tokenRecord = (sessionManager as unknown as { sessionTokens: Map<string, { tokenHash: string; expiresAt: string }> }).sessionTokens.get(session.id);
  assert.ok(tokenRecord);
  assert.notEqual(tokenRecord?.tokenHash, "plain-token");

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("run engine includes concrete file excerpts in provider prompts", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-grounding-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-grounding-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");
  await writeFile(path.join(workspace, "src", "App.tsx"), "export const marker = 42;\nexport function App(){ return null; }\n", "utf8");

  const provider = new RecordingProvider();
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const session = await sessionManager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: "fix App.tsx"
  });

  await new RunEngine(provider, sessionManager).runTurn(session.id, "fix App.tsx", {
    resolvedMode: "simple_mode",
    projectMap: {
      stack: ["TypeScript"],
      packageManagers: ["npm"],
      testCommands: ["npm test"],
      entryPoints: ["src/App.tsx"],
      importantFiles: ["package.json", "src/App.tsx"]
    }
  });

  assert.equal(provider.prompts.length >= 2, true);
  assert.equal(provider.prompts.some((prompt) => prompt.includes("src/App.tsx")), true);
  assert.equal(provider.prompts.some((prompt) => prompt.includes("export const marker = 42")), true);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

class RecordingProvider implements LlmProvider {
  readonly prompts: string[] = [];

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.prompts.push(input.userPrompt);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "Grounded plan",
        reasoningSummary: "Uses file evidence.",
        mode: "edit_project",
        tasks: [{ title: "Edit App", objective: "Fix App.tsx", roleTitle: "Implementation Worker", targetFiles: ["src/App.tsx"] }],
        acceptanceCriteria: ["Diff is reviewable"],
        risks: []
      } as T;
    }
    if (schemaName === "run-patch-intent") {
      return {
        title: "Grounded patch",
        summary: "Patch based on file contents",
        intents: [
          {
            path: "src/App.tsx",
            operation: "replace_range",
            preimageText: "export const marker = 42;",
            replacementText: "export const marker = 43;",
            reason: "Updates App",
            risk: "low"
          }
        ],
        suggestedCommands: [{ command: "npm test", reason: "Verify the change." }]
      } as T;
    }
    throw new Error(`Unexpected schema: ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}
