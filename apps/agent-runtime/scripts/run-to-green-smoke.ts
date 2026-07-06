import assert from "node:assert/strict";
import { exec as execCallback } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRuntimeSession, SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../src/config.js";
import type { LlmProvider, LlmRequest } from "../src/llm/LlmProvider.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { EventBus } from "../src/runtime/EventBus.js";
import { SessionManager } from "../src/runtime/SessionManager.js";

const exec = promisify(execCallback);

type WorkspaceFixture = {
  workspace: string;
  storageDir: string;
  close: () => Promise<void>;
};

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

async function main() {
  process.env.HIVO_DISABLE_BACKGROUND_COMMANDS = "1";
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

  const provider = new SmokeRunProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
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

  const provider = new SmokeRunProvider();
  const runtime = await createRuntimeWithProvider(fixture.storageDir, provider);
  try {
    const created = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
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
    assert.equal(session.verificationResult?.status, "pending");
    assert.equal(session.reviewGate?.runToGreen?.status, "running");
    assert.equal(session.runSummary?.status, "pending");
    assert.equal(session.commandExecutions.at(-1)?.exitCode, 0);

    return summarizeSession(session, turn.status);
  } finally {
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
    const invalidPlanCreated = await runtime.createSession({
      workspacePath: fixture.workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "add a small note"
    });
    const invalidPlanTurn = await runtime.runTurn(invalidPlanCreated.sessionId, "add a small note");
    const invalidPlanSession = runtime.getSession(invalidPlanCreated.sessionId);
    assert.ok(invalidPlanSession);
    const invalidPlanSummaries = invalidPlanSession.reasoningSummaries.join("\n");
    const invalidPlanMessages = invalidPlanSession.messages.map((entry) => entry.content).join("\n");
    assert.equal(invalidPlanTurn.status, "failed");
    assert.equal(invalidPlanSession.status, "failed");
    assert.equal(invalidPlanSession.patchProposals.length, 0);
    assert.doesNotMatch(invalidPlanSummaries, /deterministic fallback plan/i);
    assert.doesNotMatch(invalidPlanMessages, /deterministic fallback plan/i);
    assert.match(invalidPlanSession.runSummary?.summary ?? "", /provider_implementation_plan_invalid_after_repairs/i);

    return {
      turnStatus: invalidPlanTurn.status,
      structuredCallsAfterInvalidPlan: provider.structuredCalls,
      invalidPlanStatus: invalidPlanSession.status,
      deterministicFallbackRecorded: /deterministic fallback plan/i.test(`${invalidPlanSummaries}\n${invalidPlanMessages}`)
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
  const workspace = path.join(os.tmpdir(), `hivo-smoke-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = path.join(os.tmpdir(), `hivo-smoke-${label}-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.structuredCalls += 1;
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    if (schemaName === "turn-understanding") {
      return turnUnderstandingForPrompt(input.userPrompt) as T;
    }
    if (schemaName === "initial-reasoning-decision") {
      return {
        understanding: turnUnderstandingForPrompt(input.userPrompt),
        step: reasoningStepForPrompt(input.userPrompt)
      } as T;
    }
    if (schemaName === "intent-contract") {
      return intentContractForRequest(input) as T;
    }
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

class SmokeRunProvider implements LlmProvider {
  structuredCalls = 0;
  runPlanCalls = 0;

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.structuredCalls += 1;
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "conversation-intent-decision") {
      return intentDecisionForPrompt(input.userPrompt) as T;
    }
    if (schemaName === "turn-understanding") {
      return turnUnderstandingForPrompt(input.userPrompt) as T;
    }
    if (schemaName === "initial-reasoning-decision") {
      return {
        understanding: turnUnderstandingForPrompt(input.userPrompt),
        step: reasoningStepForPrompt(input.userPrompt)
      } as T;
    }
    if (schemaName === "intent-contract") {
      return intentContractForRequest(input) as T;
    }
    if (schemaName === "run-plan") {
      this.runPlanCalls += 1;
      return {
        summary: "Prepare the local project run.",
        reasoningSummary: "The provider classified this as a run request, so the runtime should initialize run-to-green.",
        mode: "edit_project",
        tasks: [{
          id: "task_run_to_green",
          title: "Select run command",
          objective: "Find a grounded project command or safe preview.",
          roleTitle: "Run Coordinator",
          targetFiles: [],
          verification: "Rust command execution remains approval-gated."
        }],
        acceptanceCriteria: ["Run-to-green state is initialized."],
        risks: ["No grounded command may exist for static workspaces."],
        suggestedCommands: []
      } as T;
    }
    throw new Error(`Unexpected schema ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}

function intentContractForRequest(input: LlmRequest) {
  const original = typeof input.context === "object" && input.context && "original_user_request" in input.context
    ? String((input.context as { original_user_request?: unknown }).original_user_request ?? input.userPrompt)
    : input.userPrompt;
  return intentContractForPrompt(original);
}

function intentContractForPrompt(prompt: string) {
  return {
    original_user_request: prompt,
    precise_rewrite: prompt,
    assumptions: ["The workspace is writable.", "Node.js and npm are available."],
    missing_questions: [],
    tradeoffs: [{
      name: "speed_vs_verification",
      options: ["inspect first", "run immediately"],
      preferred: "inspect first",
      rationale: "The request asks for a grounded project run."
    }],
    priorities: {
      speed: { score: 70, rationale: "The user wants to run the project." },
      quality: { score: 75, rationale: "Use grounded project commands." },
      realism: { score: 60, rationale: "Existing workspace facts should drive the run." },
      fun: { score: 20, rationale: "This is operational runtime work." },
      security: { score: 85, rationale: "Commands stay approval-gated." },
      cost: { score: 80, rationale: "Use a narrow provider plan." }
    },
    definition_of_done: ["Run-to-green state is initialized.", "Any command request is grounded in workspace files."],
    non_goals: ["Do not deploy the project."],
    conflict_rules: ["Safety and approval gates override speed."]
  };
}

function turnUnderstandingForPrompt(prompt: string) {
  const message = prompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i)?.[1]?.trim() ?? prompt;
  return {
    originalRequest: message,
    cleanedRequest: message,
    language: "english",
    intentKind: "run_request",
    route: "simple_run",
    needsWorkspace: true,
    goal: message,
    ambiguities: [],
    requiredEvidence: ["workspace files", "package scripts"],
    risk: "low",
    confidence: "high",
    rationale: "The request asks to run a local project."
  };
}

function reasoningStepForPrompt(_prompt: string) {
  return {
    id: "step_run_to_green",
    kind: "tool_batch",
    rationale: "Inspect the workspace, then continue with the bounded run-to-green flow.",
    toolRequests: [{
      id: "tool_analyze_project",
      kind: "analyze_project",
      reason: "Confirm whether the workspace already has a runnable project."
    }],
    missingFacts: [],
    successCriteria: ["Run-to-green state is initialized without fallback output."]
  };
}

function intentDecisionForPrompt(prompt: string) {
  const message = prompt.match(/Classify this single user message before retrieval:\n([\s\S]*?)\n\nReturn JSON/i)?.[1]?.trim() ?? prompt;
  return {
    kind: "run_request",
    language: "english",
    needsWorkspace: true,
    confidence: "high",
    rationale: "The provider classified this as a run request.",
    workspaceMessage: message
  };
}

await main();
