import assert from "node:assert/strict";
import { exec as execCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRuntimeSession } from "@orchcode/protocol";
import { loadConfig } from "../src/config.js";
import type { LlmProvider, LlmRequest } from "../src/llm/LlmProvider.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { EventBus } from "../src/runtime/EventBus.js";
import { SessionManager } from "../src/runtime/SessionManager.js";
import { buildServer } from "../src/server.js";

const exec = promisify(execCallback);

type WorkspaceFixture = {
  workspace: string;
  storageDir: string;
  close: () => Promise<void>;
};

async function main() {
  process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS = "1";
  const results: Array<{ scenario: string; snapshot: Record<string, unknown> }> = [];

  const staticScenario = await runStaticWorkspaceScenario();
  results.push({ scenario: "static-workspace", snapshot: staticScenario });

  const packageScenario = await runPackageScriptScenario();
  results.push({ scenario: "package-script-workspace", snapshot: packageScenario });

  const malformedScenario = await runMalformedProviderScenario();
  results.push({ scenario: "malformed-provider", snapshot: malformedScenario });

  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

async function runStaticWorkspaceScenario() {
  const fixture = await createWorkspaceFixture("static");
  await writeFile(
    path.join(fixture.workspace, "index.html"),
    "<!doctype html><html><body><script type=\"module\" src=\"./main.js\"></script></body></html>\n",
    "utf8"
  );
  await writeFile(path.join(fixture.workspace, "main.js"), "console.log('hello static');\n", "utf8");
  await writeFile(path.join(fixture.workspace, "style.css"), "body { margin: 0; }\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      accessProfile: "full_access",
      userPrompt: "run this project"
    });
    const turn = await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);
    assert.ok(session);

    assert.equal(turn.status, "completed");
    assert.equal(session.status, "completed");
    assert.equal(session.lifecycleStage, "DONE");
    assert.equal(session.runMode, "run_to_green");
    assert.equal(session.projectIntake?.projectKind === "existing_project" || session.projectIntake?.projectKind === "mid_progress_project", true);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    assert.equal(session.patchProposals.length, 0);
    assert.equal(session.runToGreen?.status, "blocked");
    assert.equal(session.verificationResult?.status, "unavailable");
    assert.equal(session.reviewGate?.recommendation, "caution");
    assert.equal(session.runSummary?.status, "completed");
    assert.match(session.runToGreen?.blockerReason ?? "", /No grounded run command/i);
    assert.equal(session.verificationResult?.checks.find((check) => check.name === "Rust command execution")?.status, "not_run");
    assert.equal(session.nextAction?.kind, "preview_ready");
    assert.equal(session.orchestration?.agentRuns.find((agent) => agent.id === "agent_local_codex")?.status, "completed");

    return summarizeSession(session, turn.status);
  } finally {
    await app.close();
    await fixture.close();
  }
}

async function runPackageScriptScenario() {
  const fixture = await createWorkspaceFixture("package");
  await writeFile(
    path.join(fixture.workspace, "package.json"),
    JSON.stringify({
      name: "smoke-run-to-green",
      private: true,
      scripts: {
        test: "node -e \"console.log('ok')\""
      }
    }, null, 2),
    "utf8"
  );
  await writeFile(path.join(fixture.workspace, "index.js"), "console.log('package smoke');\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir: fixture.storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "demo_mock",
      accessProfile: "full_access",
      userPrompt: "run this project"
    });
    const turn = await runtime.runTurn(created.sessionId, "run this project");
    let session = runtime.getSession(created.sessionId);
    assert.ok(session);

    assert.equal(turn.status, "needs_approval");
    assert.equal(session.runMode, "run_to_green");
    assert.equal(session.commandRequests.length > 0, true);
    const request = session.commandRequests[0];
    assert.ok(request);
    assert.match(request.command, /npm test/i);

    const commandResult = await executeRealShellCommand(request.command, request.cwd);
    await runtime.reportCommandResult(created.sessionId, request.id, {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      status: commandResult.exitCode === 0 ? "executed" : "failed",
      exitCode: commandResult.exitCode,
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      message: commandResult.exitCode === 0 ? "Smoke command passed" : "Smoke command failed"
    });
    session = runtime.getSession(created.sessionId);
    assert.ok(session);

    assert.equal(session.status, "completed");
    assert.equal(session.lifecycleStage, "DONE");
    assert.equal(session.runToGreen?.status, "passed");
    assert.equal(session.verificationResult?.status, "passed");
    assert.equal(session.reviewGate?.runToGreen?.status, "passed");
    assert.equal(session.runSummary?.status, "completed");
    assert.equal(session.commandExecutions.at(-1)?.exitCode, 0);

    return summarizeSession(session, turn.status);
  } finally {
    await app.close();
    await fixture.close();
  }
}

async function runMalformedProviderScenario() {
  const fixture = await createWorkspaceFixture("malformed-provider");
  await writeFile(
    path.join(fixture.workspace, "index.html"),
    "<!doctype html><html><body><script type=\"module\" src=\"./main.js\"></script></body></html>\n",
    "utf8"
  );
  await writeFile(path.join(fixture.workspace, "main.js"), "console.log('provider smoke');\n", "utf8");

  const provider = new InvalidPlanProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      accessProfile: "full_access",
      userPrompt: "run this project"
    });
    const turn = await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);
    assert.ok(session);

    assert.equal(turn.status, "completed");
    assert.equal(session.status, "completed");
    assert.equal(session.runMode, "run_to_green");
    assert.equal(provider.structuredCalls, 0);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.patchProposals.length, 0);
    assert.equal(session.runSummary?.status, "completed");
    assert.equal(session.reasoningSummaries.some((entry) => /invalid_json|schema_validation_failed/i.test(entry)), false);
    assert.equal(session.messages.some((entry) => /invalid_json|schema_validation_failed/i.test(entry.content)), false);
    const runToGreenStructuredCalls = provider.structuredCalls;
    assert.equal(runToGreenStructuredCalls, 0);

    const fallbackCreated = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      accessProfile: "full_access",
      userPrompt: "add a small note"
    });
    await runtime.runTurn(fallbackCreated.sessionId, "add a small note");
    const fallbackSession = runtime.getSession(fallbackCreated.sessionId);
    assert.ok(fallbackSession);
    assert.equal(
      fallbackSession.reasoningSummaries.includes("Model returned malformed structured output; deterministic fallback plan was used."),
      true
    );

    return {
      ...summarizeSession(session, turn.status),
      runToGreenStructuredCalls,
      structuredCallsAfterFallbackSanityCheck: provider.structuredCalls,
      fallbackWarningRecorded: fallbackSession.reasoningSummaries.includes(
        "Model returned malformed structured output; deterministic fallback plan was used."
      )
    };
  } finally {
    await fixture.close();
  }
}

function summarizeSession(session: AgentRuntimeSession, turnStatus: string) {
  return {
    turnStatus,
    sessionStatus: session.status,
    lifecycleStage: session.lifecycleStage,
    runMode: session.runMode,
    runIntent: session.runIntent,
    projectKind: session.projectIntake?.projectKind,
    verificationStatus: session.verificationResult?.status,
    verificationChecks: session.verificationResult?.checks.map((check) => ({
      name: check.name,
      status: check.status
    })),
    reviewRecommendation: session.reviewGate?.recommendation,
    reviewSummary: session.reviewGate?.summary,
    runSummaryStatus: session.runSummary?.status,
    runSummary: session.runSummary?.summary,
    blockerReason: session.runToGreen?.blockerReason,
    commandRequests: session.commandRequests.map((request) => ({
      command: request.command,
      status: request.status
    })),
    commandExecutions: session.commandExecutions.map((execution) => ({
      command: execution.command,
      status: execution.status,
      exitCode: execution.exitCode
    })),
    agentStatuses: session.orchestration?.agentRuns.map((agent) => ({
      name: agent.agentName,
      status: agent.status,
      lifecycleStage: agent.lifecycleStage
    }))
  };
}

async function executeRealShellCommand(command: string, cwd: string) {
  const shellCommand = process.platform === "win32"
    ? `cmd.exe /d /s /c "${command}"`
    : command;
  try {
    const { stdout, stderr } = await exec(shellCommand, { cwd });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error)
    };
  }
}

async function createWorkspaceFixture(label: string): Promise<WorkspaceFixture> {
  const workspace = path.join(os.tmpdir(), `orchcode-smoke-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-smoke-${label}-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return {
    workspace,
    storageDir,
    close: async () => {
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

class InvalidPlanProvider implements LlmProvider {
  structuredCalls = 0;

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    this.structuredCalls += 1;
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "broken",
        reasoningSummary: "broken",
        mode: "edit_project",
        tasks: [{ malformed: true }]
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}

await main();
