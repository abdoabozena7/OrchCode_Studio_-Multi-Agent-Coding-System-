import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { EventBus } from "../runtime/EventBus.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { RunEngine } from "../runtime/RunEngine.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

test("run this project initializes run_to_green before provider task planning", async () => {
  const fixture = await createStaticFixture();
  const provider = new CountingProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "run this project"
    });
    await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runIntent, "run_to_green");
    assert.equal(session?.runMode, "run_to_green");
    assert.equal(provider.structuredCalls, 1);
    assert.equal(session?.runToGreen?.status, "blocked");
    assert.equal(session?.status, "completed");
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

test("run_to_green completes safely when no known command can be selected", async () => {
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
    assert.equal(session?.reviewGate?.recommendation, "caution");
    assert.equal(session?.verificationResult?.status, "unavailable");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Rust command execution")?.status, "not_run");
    assert.equal(session?.status, "completed");
    assert.equal(session?.lifecycleStage, "DONE");
    assert.equal(session?.runSummary?.status, "completed");
  } finally {
    await app.close();
    await fixture.close();
  }
});

test("malformed provider task JSON stops implementation instead of inventing a deterministic plan", async () => {
  const fixture = await createEmptyFixture();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, new InvalidPlanProvider());
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "add a small note"
    });
    const turn = await runtime.runTurn(created.sessionId, "add a small note");
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "failed");
    assert.equal(session?.status, "failed");
    assert.equal(session?.tasks.length, 0);
    assert.match(session?.messages.at(-1)?.content ?? "", /no deterministic implementation plan was invented|stopped here instead of creating a canned plan/i);
    assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 0, true);
    assert.ok(session?.runSummary?.gates.some((gate) => gate.name === "Planning provider request" && gate.status === "failed"));
  } finally {
    await fixture.close();
  }
});

test("read-only planning questions bypass implementation planner fallback", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const provider = new ReadOnlyQuestionProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const prompt = "explain this project architecture and make a read-only plan for understanding it";
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      executionMode: "simple_mode",
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);
    const answer = session?.messages.at(-1)?.content ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(provider.runPlanCalls, 0);
    assert.doesNotMatch(answer, /no deterministic implementation plan was invented|safe implementation plan|canned plan/i);
    assert.match(answer, /Workspace used for this answer|PROVIDER_READ_ONLY_EXPLAIN/i);
  } finally {
    await fixture.close();
  }
});

test("planner gate reports not attempted instead of provider failure when no request is recorded", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const sessionManager = new SessionManager(fixture.storageDir, new EventBus());
  await sessionManager.load();
  try {
    const session = await sessionManager.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "add a small note"
    });
    const result = await new RunEngine(new InvalidPlanProvider(), sessionManager).runTurn(session.id, "add a small note", {
      resolvedMode: "simple_mode",
      projectMap: {
        stack: ["TypeScript"],
        packageManagers: ["npm"],
        testCommands: ["npm test"],
        entryPoints: ["src/main.ts"],
        importantFiles: ["src/main.ts", "package.json"]
      }
    });
    const answer = result.messages.at(-1)?.content ?? "";

    assert.equal(result.status, "failed");
    assert.equal(result.providerTelemetry, undefined);
    assert.match(answer, /No planning provider request was recorded/i);
    assert.doesNotMatch(answer, /provider planner failed/i);
    assert.ok(result.runSummary?.gates.some((gate) => gate.name === "Planning provider request" && gate.status === "blocked"));
  } finally {
    await fixture.close();
  }
});

test("operator-supplied implementation plan skips provider run-plan and reaches review", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const provider = new OperatorPlanPatchProvider("valid");
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const prompt = operatorPlanPrompt();
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session?.status, "needs_approval");
    assert.equal(provider.runPlanCalls, 0);
    assert.equal(provider.patchIntentCalls, 1);
    assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 0, true);
    assert.equal(session?.plan?.summary, "Use the explicit operator plan to add a small exported marker.");
    assert.ok(session?.reasoningSummaries.includes("Plan source: operator_supplied"));
    assert.ok(session?.runSummary?.gates.some((gate) =>
      gate.name === "Planning provider request" &&
      gate.status === "passed" &&
      /operator-supplied implementation plan/i.test(gate.notes.join(" "))
    ));
    assert.equal(session?.patchProposals.length, 1);
  } finally {
    await fixture.close();
  }
});

test("operator-supplied implementation plan accepts concise directive and plan title", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const provider = new OperatorPlanPatchProvider("valid");
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const prompt = conciseOperatorPlanPrompt();
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.status, "needs_approval");
    assert.equal(provider.runPlanCalls, 0);
    assert.equal(provider.patchIntentCalls, 1);
    assert.ok(session?.runSummary?.gates.some((gate) =>
      gate.name === "Planning provider request" &&
      /operator-supplied implementation plan/i.test(gate.notes.join(" "))
    ));
  } finally {
    await fixture.close();
  }
});

test("operator-supplied plan still blocks when provider patch intent is malformed", async () => {
  const fixture = await createPackageFixture({ scripts: { test: "vitest run" }, withSource: true });
  const provider = new OperatorPlanPatchProvider("invalid_patch");
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const prompt = operatorPlanPrompt();
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);
    const answer = session?.messages.at(-1)?.content ?? "";

    assert.equal(turn.status, "failed");
    assert.equal(session?.status, "failed");
    assert.equal(provider.runPlanCalls, 0);
    assert.equal(provider.patchIntentCalls, 1);
    assert.equal((session?.providerTelemetry?.providerRequestCount ?? 0) > 0, true);
    assert.equal(session?.tasks.length, 3);
    assert.doesNotMatch(answer, /safe implementation plan|no deterministic implementation plan was invented|canned implementation plan/i);
    assert.match(answer, /could not produce a file change/i);
    assert.ok(session?.runSummary?.gates.some((gate) => gate.name === "Planning provider request" && gate.status === "passed"));
    assert.ok(session?.runSummary?.gates.some((gate) => gate.name === "Patch intent" && gate.status === "failed"));
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
  const workspace = path.join(os.tmpdir(), `hivo-run2g-bare-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run2g-bare-storage-${Date.now()}`);
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

test("git status outside a repository keeps the diagnosis informative", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-run2g-git-status-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run2g-git-status-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# no git\n", "utf8");
  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "make it run with `git status`"
    });
    await runtime.runTurn(created.sessionId, "make it run with `git status`");
    const request = runtime.getSession(created.sessionId)?.commandRequests[0];
    assert.ok(request);

    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: "failed",
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository (or any of the parent directories): .git",
      message: "This workspace is not a Git repository.",
      diagnosis: {
        category: "not_git_repository",
        severity: "informative",
        summary: "This workspace is not a Git repository.",
        nextStep: "Initialize Git or open a Git workspace if you need Git status."
      }
    });
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.category, "not_git_repository");
    assert.equal(session?.runToGreen?.attempts[0]?.diagnosis?.reason, "This workspace is not a Git repository.");
    assert.equal(session?.commandExecutions.at(-1)?.diagnosis?.category, "not_git_repository");
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
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
  const workspace = path.join(os.tmpdir(), `hivo-run2g-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run2g-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  const workspace = path.join(os.tmpdir(), `hivo-run2g-static-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run2g-static-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

async function createEmptyFixture() {
  const workspace = path.join(os.tmpdir(), `hivo-run2g-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run2g-empty-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
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
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
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

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.structuredCalls += 1;
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    throw new Error("provider should not be called after intent classification");
  }

  async generateText(): Promise<string> {
    return "";
  }
}

class InvalidPlanProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(_input.userPrompt) as T;
    }
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

class ReadOnlyQuestionProvider implements LlmProvider {
  runPlanCalls = 0;

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(_input.userPrompt) as T;
    }
    if (schemaName === "run-plan") {
      this.runPlanCalls += 1;
      throw new Error("run-plan should not be called for read-only questions");
    }
    if (schemaName === "project-explain") {
      return {
        answerMarkdown: "PROVIDER_READ_ONLY_EXPLAIN: src/main.ts is the source entry and package.json defines project scripts. [src/main.ts:1](hivo-file:src%2Fmain.ts:1) [package.json:1](hivo-file:package.json:1)",
        usedEvidenceRefs: ["src/main.ts:1", "package.json:1"],
        unsupportedOrUnclearParts: []
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "PROVIDER_READ_ONLY_EXPLAIN: src/main.ts is the source entry and package.json defines project scripts.";
  }
}

class OperatorPlanPatchProvider implements LlmProvider {
  runPlanCalls = 0;
  patchIntentCalls = 0;

  constructor(private readonly mode: "valid" | "invalid_patch") {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    if (schemaName === "run-plan") {
      this.runPlanCalls += 1;
      throw new Error("run-plan should be skipped for explicit operator-supplied plans");
    }
    if (schemaName === "run-patch-intent") {
      this.patchIntentCalls += 1;
      if (this.mode === "invalid_patch") {
        return {
          title: "Broken patch",
          summary: "Malformed patch intent.",
          intents: [{ path: "src/main.ts", operation: "insert_after" }]
        } as T;
      }
      return {
        title: "Add marker",
        summary: "Adds a small exported marker requested by the operator plan.",
        intents: [{
          path: "src/main.ts",
          operation: "insert_after",
          anchorText: "export const main = true;",
          replacementText: "\nexport const operatorPlanApplied = true;",
          reason: "Implement the explicit operator-supplied plan with a narrow source edit.",
          risk: "low"
        }],
        suggestedCommands: [{ command: "npm test", reason: "Verify the operator plan change." }]
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}

function operatorPlanPrompt() {
  return [
    "PLEASE IMPLEMENT THIS PLAN:",
    "# Operator-Supplied Implementation Plan",
    "",
    "## Summary",
    "- Use the explicit operator plan to add a small exported marker.",
    "",
    "## Key Changes",
    "- Update src/main.ts with one narrow exported marker.",
    "- Keep provider/schema gates active for patch generation.",
    "",
    "## Test Plan",
    "- Check the normal project test command.",
    "",
    "## Assumptions",
    "- Do not invent broader edits beyond the operator plan."
  ].join("\n");
}

function conciseOperatorPlanPrompt() {
  return [
    "IMPLEMENT THIS PLAN:",
    "# Operator-Supplied Implementation Plan",
    "- Update src/main.ts with one narrow exported marker.",
    "- Keep provider/schema gates active for patch generation.",
    "- Verify with the normal project test command."
  ].join("\n");
}

function intentDecisionForPrompt(prompt: string) {
  const message = prompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i)?.[1]?.trim() ?? prompt;
  const operatorPlan = /\b(?:please\s+)?implement\s+this\s+plan\b/i.test(message);
  const run = /\b(run|start|launch|open|preview|test|build)\b/i.test(message);
  const question = /\b(explain|understand|architecture|inspect|read-only|how|what|why|plan for understanding)\b/i.test(message);
  return {
    kind: operatorPlan ? "workspace_action" : run ? "run_request" : question ? "workspace_question" : "workspace_action",
    language: /[\u0600-\u06ff]/.test(message) ? "arabic" : "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: operatorPlan ? "The provider classified this as an explicit operator implementation plan." : run ? "The provider classified this as a run request." : question ? "The provider classified this as a workspace question." : "The provider classified this as a workspace action.",
    workspaceMessage: message
  };
}
