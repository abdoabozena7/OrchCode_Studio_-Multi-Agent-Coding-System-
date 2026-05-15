import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { EventBus } from "../runtime/EventBus.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("run this project initializes run_to_green before provider task planning", async () => {
  const fixture = await createStaticFixture();
  const provider = new CountingProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      userPrompt: "run this project"
    });
    await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runIntent, "run_to_green");
    assert.equal(session?.runMode, "run_to_green");
    assert.equal(provider.structuredCalls, 0);
    assert.equal(session?.runToGreen?.status, "blocked");
    assert.equal(session?.status, "blocked");
    assert.equal(session?.verificationResult?.status, "unavailable");
  } finally {
    await fixture.close();
  }
});

test("run_to_green selects explicit command first", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run", dev: "vite" } });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run with `npm test`"
    });
    await runtime.runTurn(created.sessionId, "make it run with `npm test`");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.selectedCommands[0]?.command, "npm test");
    assert.equal(session?.commandRequests[0]?.command, "npm test");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("run_to_green falls back to module verification commands", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run", dev: "vite" }, withSource: true });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.selectedCommands[0]?.command, "npm test");
    assert.equal(session?.commandRequests[0]?.command, "npm test");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("run_to_green blocks when no known command can be selected", async () => {
  const fixture = await createStaticFixture();
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "run this project"
    });
    await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "blocked");
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.runToGreen?.finalStatus, "blocked");
    assert.match(session?.runToGreen?.blockerReason ?? "", /No grounded run command/i);
    assert.equal(session?.reviewGate?.runToGreen?.status, "blocked");
    assert.equal(session?.reviewGate?.recommendation, "do_not_apply");
    assert.equal(session?.verificationResult?.status, "unavailable");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Rust command execution")?.status, "not_run");
    assert.equal(session?.runSummary?.status, "blocked");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("malformed provider task JSON uses deterministic fallback and does not crash", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const runtime = await createRuntimeWithProvider(fixture.storageDir, new InvalidPlanProvider());
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      userPrompt: "add a small note"
    });
    const turn = await runtime.runTurn(created.sessionId, "add a small note");
    const session = runtime.getSession(created.sessionId);

    assert.notEqual(turn.status, "failed");
    assert.equal(session?.tasks.length, 3);
    assert.equal(session?.tasks[0]?.title, "Build context pack");
    assert.equal(session?.tasks[0]?.agentRole, "Project Mapper");
    assert.ok(session?.reasoningSummaries.includes("Model returned malformed structured output; deterministic fallback plan was used."));
  } finally {
    await fixture.close();
  }
});

test("successful first run marks run_to_green as passed", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const request = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "executed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      message: "Command passed"
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "passed");
    assert.equal(session?.runToGreen?.finalStatus, "green");
    assert.equal(session?.status, "completed");
    assert.equal(session?.reviewGate?.runToGreen?.status, "passed");
    assert.equal(session?.verificationResult?.status, "passed");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("failed run records conservative diagnosis", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-run2g-bare-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run2g-bare-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# bare\n", "utf8");
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "make it run with `vite`"
    });
    await runtime.runTurn(created.sessionId, "make it run with `vite`");
    const request = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "failed",
      exitCode: 127,
      stdout: "",
      stderr: "vite: command not found",
      message: "Command failed"
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.category, "command_not_found");
    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.confidence, "high");
    assert.equal(session?.runToGreen?.status, "blocked");
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("unknown error stays unknown and low confidence", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" } });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const request = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "kaboom mystery failure",
      message: "Command failed"
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.category, "unknown");
    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.confidence, "low");
    assert.equal(session?.runToGreen?.status, "blocked");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("small in-scope repair can trigger rerun and pass", async () => {
  const fixture = await createPackageFixture({
    scripts: { test: "vitest run" },
    withSource: true,
    sourceContent: 'import { value } from "./missing";\nexport const main = value;\n'
  });
  const runtime = await createRuntimeWithProvider(fixture.storageDir, new RepairProvider({
    path: "src/main.ts",
    preimage: 'import { value } from "./missing";',
    replacement: "const value = 1;"
  }));
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const firstRequest = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(firstRequest);

    await runtime.reportCommandResult(created.sessionId, firstRequest.id, {
      command: firstRequest.command,
      cwd: firstRequest.cwd,
      risk: firstRequest.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find module './missing' in src/main.ts",
      message: "Import failed"
    });
    let session = runtime.getSession(created.sessionId);
    assert.equal(session?.patchProposals.length, 1);
    assert.equal(session?.latestScopeValidation?.verdict, "needs_review");

    const patchId = session?.patchProposals[0]?.id;
    assert.ok(patchId);
    await runtime.approvePatch(created.sessionId, patchId);
    await runtime.reportPatchApplyResult(created.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: true,
          isGitRepo: true,
          changedFiles: ["src/main.ts"],
          diffText: session?.patchProposals[0]?.unifiedDiff ?? "",
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    session = runtime.getSession(created.sessionId);
    assert.equal(session?.commandRequests.length, 2);

    const secondRequest = session?.commandRequests[1];
    assert.ok(secondRequest);
    await runtime.reportCommandResult(created.sessionId, secondRequest.id, {
      command: secondRequest.command,
      cwd: secondRequest.cwd,
      risk: secondRequest.risk,
      status: "executed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      message: "Command passed"
    });
    session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "passed");
    assert.equal(session?.runToGreen?.attempts.length, 2);
    assert.equal(session?.runToGreen?.attempts[0]?.changedFiles.includes("src/main.ts"), true);
    assert.equal(session?.moduleExecutionSummaries?.at(-1)?.runToGreenStatus, "passed");
  } finally {
    await fixture.close();
  }
});

test("out-of-scope repair is blocked instead of proposed", async () => {
  const fixture = await createPackageFixture({
    scripts: { test: "vitest run" },
    withSource: true,
    sourceContent: 'import { value } from "./missing";\nexport const main = value;\n'
  });
  const runtime = await createRuntimeWithProvider(fixture.storageDir, new RepairProvider({
    path: "notes/parallel.md",
    replacement: "# parallel\n",
    operation: "create_file"
  }));
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const firstRequest = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(firstRequest);

    await runtime.reportCommandResult(created.sessionId, firstRequest.id, {
      command: firstRequest.command,
      cwd: firstRequest.cwd,
      risk: firstRequest.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find module './missing' in src/main.ts",
      message: "Import failed"
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "blocked");
    assert.equal(session?.latestScopeValidation?.verdict, "blocked");
    assert.equal(session?.patchProposals.length, 0);
  } finally {
    await fixture.close();
  }
});

test("background running command does not count as green", async () => {
  const fixture = await createPackageFixture({ scripts: { dev: "vite" }, withSource: true });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "run this project"
    });
    await runtime.runTurn(created.sessionId, "run this project");
    const request = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "running",
      stdout: "",
      stderr: "",
      message: "Server started in background",
      backgroundJob: {
        jobId: "job_1",
        sessionId: created.sessionId,
        command: request.command,
        cwd: request.cwd,
        startedAt: new Date().toISOString(),
        lastKnownAt: new Date().toISOString(),
        status: "running",
        detectionSource: "heuristic"
      }
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "blocked");
    assert.notEqual(session?.runToGreen?.finalStatus, "green");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("run_to_green stops at max attempts", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const server = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await server.runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await server.runtime.runTurn(created.sessionId, "make it run");
    await server.sessionManager.updateSession(created.sessionId, (draft) => {
      if (draft.runToGreen) {
        draft.runToGreen.maxAttempts = 1;
      }
    });
    const request = server.runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await server.runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "kaboom",
      message: "Command failed"
    });
    const session = server.runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "max_attempts_reached");
    assert.equal(session?.runToGreen?.finalStatus, "not_green");
  } finally {
    await server.app.close();
    await fixture.close();
  }
});

test("repeated same diagnosis stops the bounded loop", async () => {
  const fixture = await createPackageFixture({
    scripts: { test: "vitest run" },
    withSource: true,
    sourceContent: 'import { value } from "./missing";\nexport const main = value;\n'
  });
  const runtime = await createRuntimeWithProvider(fixture.storageDir, new RepairProvider({
    path: "src/main.ts",
    preimage: 'import { value } from "./missing";',
    replacement: "const value = 1;"
  }));
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    const firstRequest = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(firstRequest);

    await runtime.reportCommandResult(created.sessionId, firstRequest.id, {
      command: firstRequest.command,
      cwd: firstRequest.cwd,
      risk: firstRequest.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find module './missing' in src/main.ts",
      message: "Import failed"
    });
    const patchId = runtime.getSession(created.sessionId)?.patchProposals[0]?.id;
    assert.ok(patchId);
    await runtime.approvePatch(created.sessionId, patchId);
    await runtime.reportPatchApplyResult(created.sessionId, patchId, {
      status: "applied",
      message: "Patch applied by Rust authority",
      reconciliationSnapshot: {
        after: {
          available: true,
          isGitRepo: true,
          changedFiles: ["src/main.ts"],
          diffText: runtime.getSession(created.sessionId)?.patchProposals[0]?.unifiedDiff ?? "",
          dirty: true,
          checkedAt: new Date().toISOString()
        }
      }
    });
    const secondRequest = runtime.getSession(created.sessionId)?.commandRequests[1];
    assert.ok(secondRequest);

    await runtime.reportCommandResult(created.sessionId, secondRequest.id, {
      command: secondRequest.command,
      cwd: secondRequest.cwd,
      risk: secondRequest.risk,
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "Cannot find module './missing' in src/main.ts",
      message: "Import failed again"
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.status, "blocked");
    assert.match(session?.runToGreen?.blockerReason ?? "", /same diagnosis repeated/i);
  } finally {
    await fixture.close();
  }
});

test("restored in-flight run_to_green becomes reconciliation-required and blocked", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      userPrompt: "make it run"
    });
    await runtime.runTurn(created.sessionId, "make it run");
    await app.close();

    const restoredManager = new SessionManager(fixture.storageDir, new EventBus());
    await restoredManager.load();
    const restored = restoredManager.getSession(created.sessionId);

    assert.equal(restored?.runToGreen?.status, "blocked");
    assert.equal(restored?.taskState.restoreState?.disposition, "reconciliation_required");
  } finally {
    await fixture.close();
  }
});

type PackageFixtureOptions = {
  scripts: Record<string, string>;
  withSource?: boolean;
  sourceContent?: string;
};

async function createPackageFixture(options: PackageFixtureOptions) {
  const workspace = path.join(os.tmpdir(), `orchcode-run2g-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run2g-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  if (options.withSource) {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "main.ts"), options.sourceContent ?? "export const main = true;\n", "utf8");
  }
  await writeFile(path.join(workspace, "README.md"), "# fixture\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture", scripts: options.scripts }, null, 2), "utf8");
  return {
    workspace,
    storageDir,
    async close() {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

async function createStaticFixture() {
  const workspace = path.join(os.tmpdir(), `orchcode-run2g-static-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run2g-static-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "index.html"), '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n', "utf8");
  await writeFile(path.join(workspace, "main.js"), 'console.log("hello");\n', "utf8");
  await writeFile(path.join(workspace, "styles.css"), "body { margin: 0; }\n", "utf8");
  return {
    workspace,
    storageDir,
    async close() {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}

async function createRuntimeWithProvider(storageDir: string, provider: LlmProvider) {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  return new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => provider
  });
}

class RepairProvider implements LlmProvider {
  constructor(
    private readonly config: {
      path: string;
      replacement: string;
      preimage?: string;
      operation?: "create_file" | "replace_range";
    }
  ) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "Repair plan",
        reasoningSummary: "Repair the existing module conservatively.",
        mode: "edit_project",
        tasks: [{
          id: "task_1",
          title: "Repair main module",
          objective: "Repair the failing module",
          roleTitle: "Implementation Worker",
          targetFiles: ["src/main.ts"],
          verification: "npm test"
        }],
        acceptanceCriteria: ["The scoped command passes."],
        risks: ["Keep edits scoped."],
        suggestedCommands: [{ command: "npm test", reason: "Verify the repair." }]
      } as T;
    }
    if (schemaName === "run-patch-intent") {
      return {
        title: "Repair failing import",
        summary: "Applies a small scoped repair.",
        intents: [{
          path: this.config.path,
          operation: this.config.operation ?? "replace_range",
          preimageText: this.config.preimage,
          replacementText: this.config.replacement,
          reason: "Repair the proven failing import.",
          risk: "low"
        }]
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName} for prompt ${input.userPrompt}`);
  }

  async generateText(): Promise<string> {
    return "repair";
  }
}

class CountingProvider implements LlmProvider {
  structuredCalls = 0;

  async generateStructured<T>(): Promise<T> {
    this.structuredCalls += 1;
    throw new Error("provider should not be called");
  }

  async generateText(): Promise<string> {
    return "";
  }
}

class InvalidPlanProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "broken",
        reasoningSummary: "broken",
        mode: "edit_project",
        tasks: [{ bad: true }]
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}
