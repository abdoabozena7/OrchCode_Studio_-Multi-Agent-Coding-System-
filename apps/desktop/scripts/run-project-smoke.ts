import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentRuntimeSession, ProviderTruthTelemetry, SanitizedProviderConfig } from "@hivo/protocol";
import { buildPrimaryActivityItems, describeCurrentStep } from "../src/app/activityStream.ts";
import { loadConfig } from "../../agent-runtime/src/config.js";
import { buildServer } from "../../agent-runtime/src/server.js";

type SessionResponse = {
  sessionId: string;
  status: string;
};

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.workspace) {
    await runRealWorkspaceSmoke(args);
    return;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
  const storageDir = path.join(os.tmpdir(), `hivo-desktop-smoke-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const runtimePort = 45317 + Math.floor(Math.random() * 200);
  const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
  const { app } = await buildServer({
    ...loadConfig(),
    host: "127.0.0.1",
    port: runtimePort,
    storageDir
  });

  await app.listen({ host: "127.0.0.1", port: runtimePort });
  process.env.HIVO_AGENT_RUNTIME_URL = runtimeUrl;

  try {
    const packageScenario = await runPackageScriptScenario(runtimeUrl, root);
    const staticScenario = await runStaticPreviewScenario(runtimeUrl);
    const inspectProgressScenario = await runInspectProgressScenario(runtimeUrl);
    const gitOutsideRepoScenario = await runGitStatusOutsideRepoScenario(root);
    const gitInsideRepoScenario = await runGitStatusInsideRepoScenario(root);
    const riskyCommandScenario = await runRiskyCommandScenario(root);
    console.log(JSON.stringify({ ok: true, packageScenario, staticScenario, inspectProgressScenario, gitOutsideRepoScenario, gitInsideRepoScenario, riskyCommandScenario }, null, 2));
  } finally {
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  }
}

async function runPackageScriptScenario(runtimeUrl: string, rustProjectDir: string) {
  const workspace = await createWorkspace("package");
  try {
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "desktop-smoke-run-project",
          private: true,
          scripts: {
            test: "node -e \"console.log('ok')\""
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(workspace, "index.js"), "console.log('smoke');\n", "utf8");

    const created = await createRuntimeSession(runtimeUrl, workspace);
    await runTurn(runtimeUrl, created.sessionId, "run this project");
    let session = await getSession(runtimeUrl, created.sessionId);
    assert.equal(session.runSummary?.status, "pending");
    assert.equal(session.commandRequests.length > 0, true);
    assert.equal(session.progressEvents.length > 0, true);

    const preExecutionProgress = session.progressEvents.at(-1);
    assert.ok(preExecutionProgress);
    const preExecutionCurrentStep = describeCurrentStep(session, "connected");
    const preExecutionItems = buildPrimaryActivityItems(session);
    assert.equal(preExecutionCurrentStep.summary, preExecutionProgress.summary);
    assert.equal(preExecutionItems.some((item) => item.id === preExecutionProgress.id), true);

    const request = session.commandRequests[0];
    assert.ok(request);
    assert.match(request.command, /npm test/i);
    assert.equal(request.risk, "safe");

    const bridgeResult = await runRuntimeRustBridge({
      rustProjectDir,
      runtimeUrl,
      workspace,
      sessionId: created.sessionId,
      requestId: request.id,
      command: request.command,
      cwd: request.cwd
    });
    assert.equal(bridgeResult.commandResult.status, "executed");

    session = await getSession(runtimeUrl, created.sessionId);
    assert.equal(session.commandExecutions.at(-1)?.exitCode, 0);
    assert.equal(session.verificationResult?.status, "passed");
    assert.equal(session.runSummary?.status, "completed");
    assert.equal(session.status, "completed");

    const currentStep = describeCurrentStep(session, "connected");
    const items = buildPrimaryActivityItems(session);
    const latestProgress = session.progressEvents.at(-1);

    assert.equal(currentStep.title, "Run complete");
    assert.ok(latestProgress);
    assert.equal(items.some((item) => item.id === latestProgress.id), true);
    assert.equal(items.some((item) => item.summary === latestProgress.summary), true);

    return {
      sessionStatus: session.status,
      runSummaryStatus: session.runSummary?.status,
      command: request.command,
      currentStep,
      activityTitles: items.map((item) => item.title)
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runGitStatusOutsideRepoScenario(rustProjectDir: string) {
  const workspace = await createWorkspace("git-outside");
  try {
    const result = await runStandaloneRustCommand({
      rustProjectDir,
      workspace,
      cwd: workspace,
      command: "git status",
      approvalGranted: true
    });
    assert.equal(result.commandResult.risk, "safe");
    assert.equal(result.commandResult.status, "failed");
    assert.equal(result.commandResult.exitCode, 128);
    assert.equal(result.commandResult.diagnosis?.category, "not_git_repository");
    assert.equal(result.commandResult.diagnosis?.summary, "This workspace is not a Git repository.");
    return result.commandResult;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runGitStatusInsideRepoScenario(rustProjectDir: string) {
  const workspace = await createWorkspace("git-inside");
  try {
    const initialized = await tryRunLocalCommand("git", ["init"], workspace);
    if (!initialized.ok) {
      return {
        skipped: true,
        reason: initialized.stderr || initialized.stdout || "git init was unavailable in this environment."
      };
    }
    const result = await runStandaloneRustCommand({
      rustProjectDir,
      workspace,
      cwd: workspace,
      command: "git status",
      approvalGranted: true
    });
    assert.equal(result.commandResult.risk, "safe");
    assert.equal(result.commandResult.status, "executed");
    assert.equal(result.commandResult.exitCode, 0);
    return result.commandResult;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runRiskyCommandScenario(rustProjectDir: string) {
  const workspace = await createWorkspace("risky");
  try {
    const result = await runStandaloneRustCommand({
      rustProjectDir,
      workspace,
      cwd: workspace,
      command: "git push origin main",
      approvalGranted: false
    });
    assert.equal(result.commandResult.status, "blocked");
    assert.equal(result.commandResult.diagnosis?.category, "policy_blocked");
    return result.commandResult;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runInspectProgressScenario(runtimeUrl: string) {
  const workspace = await createWorkspace("inspect-progress");
  try {
    await writeFile(path.join(workspace, "README.md"), "# Smoke project\n\nSmall project for inspect progress.\n", "utf8");
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }, null, 2), "utf8");

    const prompt = "اشرح المشروع ببساطة";
    const created = await createRuntimeSession(runtimeUrl, workspace, prompt);
    await runTurn(runtimeUrl, created.sessionId, prompt);
    const session = await getSession(runtimeUrl, created.sessionId);
    const items = buildPrimaryActivityItems(session);
    const questionMode = items.find((item) => item.title === "تحديد نوع السؤال");
    const questionModeIndex = session.progressEvents.findIndex((event: { taskTitle?: string }) => event.taskTitle === "تحديد نوع السؤال");
    const runningQuestionSession = {
      ...session,
      status: "running" as const,
      progressEvents: session.progressEvents.slice(0, questionModeIndex + 1)
    };
    const currentQuestionStep = describeCurrentStep(runningQuestionSession, "connected");

    assert.equal(session.runMode, "inspect_only");
    assert.equal(items.length, session.progressEvents.length);
    assert.ok(questionMode);
    assert.equal(questionMode?.rationaleLabel, "ليه الخطوة دي");
    assert.equal(questionMode?.nextLabel, "التالي");
    assert.equal(questionMode?.nextStepTitle, "تقرير الأدلة");
    assert.equal(currentQuestionStep.title, "تحديد نوع السؤال");
    assert.equal(currentQuestionStep.nextStepTitle, "تقرير الأدلة");
    assert.equal(items.some((item) => /Syncing runtime progress/i.test(item.summary)), false);

    return {
      progressEventCount: session.progressEvents.length,
      currentQuestionStep,
      allActivityTitles: items.map((item) => item.title)
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runStaticPreviewScenario(runtimeUrl: string) {
  const workspace = await createWorkspace("static");
  try {
    await writeFile(
      path.join(workspace, "index.html"),
      '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n',
      "utf8"
    );
    await writeFile(path.join(workspace, "main.js"), "console.log('static');\n", "utf8");
    await writeFile(path.join(workspace, "style.css"), "body { margin: 0; }\n", "utf8");

    const created = await createRuntimeSession(runtimeUrl, workspace);
    await runTurn(runtimeUrl, created.sessionId, "run this project");
    const session = await getSession(runtimeUrl, created.sessionId);
    const currentStep = describeCurrentStep(session, "connected");

    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    assert.equal(session.status, "completed");
    assert.equal(session.nextAction?.kind, "preview_ready");
    assert.ok(session.previewRecommendation?.target);
    assert.equal(session.verificationResult?.status, "unavailable");
    assert.equal(currentStep.title, "Preview available");
    assert.match(currentStep.summary, /No grounded run command/i);

    return {
      sessionStatus: session.status,
      currentStep,
      previewTarget: session.previewRecommendation?.target
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

type SmokeFailureCode =
  | "runtime_unavailable"
  | "sse_disconnected"
  | "token_expired"
  | "unauthorized"
  | "workspace_open_failed"
  | "provider_missing"
  | "provider_api_key_missing"
  | "provider_validation_failed"
  | "provider_failed"
  | "provider_mock_forbidden"
  | "session_reconciliation_failed"
  | "session_stuck"
  | "answer_quality_failed"
  | "answer_grounding_failed";

type RealWorkspaceSmokeArgs = {
  workspace?: string;
  runtimeUrl?: string;
  provider?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKeyEnv?: string;
  includeOrchestratedSwarm?: boolean;
  includeProviderMatrix?: boolean;
};

type ProjectSnapshot = {
  workspacePath: string;
  files: string[];
  sourceFiles: string[];
  manifestFiles: string[];
  entrypointFiles: string[];
  testFiles: string[];
  packageManagers: string[];
  scripts: string[];
  directories: string[];
  primaryFile: string;
};

type RealWorkspaceSmokeReport = {
  "runtime health": "unknown" | "ok" | "failed";
  "workspace opened": boolean;
  "session created": boolean;
  "session updates": {
    status: "unknown" | "ok" | "failed";
    sseUpdateCount: number;
    canonicalFetchCount: number;
    lastCanonicalStatus: AgentRuntimeSession["status"] | null;
    lastError: string | null;
  };
  "work accounting": {
    scannedFiles: number | null;
    sampledFiles: number | null;
    evidenceFilesUsed: number | null;
    generatedEvidenceExcluded: number | null;
    progressEventCount: number | null;
    artifactCount: number | null;
  };
  "provider truth": {
    activeProviderSource: ProviderTruthTelemetry["activeProviderSource"] | null;
    mockProviderUsed: boolean | null;
    fallbackUsed: boolean | null;
    requestCount: number | null;
    promptChars: number | null;
    responseChars: number | null;
    contextChars: number | null;
    lastError: string | null;
    raw?: ProviderTruthTelemetry;
  };
  "orchestrated swarm": {
    status: "not_run" | "ok" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    resolvedExecutionMode: AgentRuntimeSession["resolvedExecutionMode"] | null;
    logicalAgents: number | null;
    agentRuns: number | null;
    workerOutputs: number | null;
    providerRequests: number | null;
    providerFailures: number | null;
    providerTimeouts: number | null;
    promptChars: number | null;
    mockProviderUsed: boolean | null;
    fallbackUsed: boolean | null;
    finalMessagePrefix?: string;
    failureCode?: SmokeFailureCode;
    failureReason?: string;
  };
  "provider prompt matrix": {
    status: "not_run" | "ok" | "failed";
    prompts: Array<{
      label: string;
      sessionStatus: AgentRuntimeSession["status"] | null;
      resolvedExecutionMode: AgentRuntimeSession["resolvedExecutionMode"] | null;
      agentName: string | null;
      workerOutputs: number | null;
      providerRequests: number | null;
      providerFailures: number | null;
      providerTimeouts: number | null;
      promptChars: number | null;
      contextChars: number | null;
      mockProviderUsed: boolean | null;
      fallbackUsed: boolean | null;
      finalMessagePrefix?: string;
      failureReason?: string;
    }>;
    failureCode?: SmokeFailureCode;
    failureReason?: string;
  };
  "generated questions": string[];
  "assistant answers": Array<{
    question: string;
    answer: string;
    quality: "passed" | "failed";
    evidenceFiles: string[];
    failureReason?: string;
  }>;
  "answer quality result": "unknown" | "passed" | "failed";
  "final result": "passed" | "failed";
  failureCode?: SmokeFailureCode;
  failureReason?: string;
  runtimeUrl: string;
  workspacePath: string;
  rustWorkspaceAuthority?: unknown;
};

class SmokeFailure extends Error {
  constructor(
    public readonly code: SmokeFailureCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

async function runRealWorkspaceSmoke(args: RealWorkspaceSmokeArgs) {
  const workspacePath = args.workspace;
  if (!workspacePath) {
    throw new SmokeFailure("workspace_open_failed", "--workspace is required for real workspace smoke.");
  }
  const runtimeUrl = args.runtimeUrl ?? "http://127.0.0.1:4317";
  const report = createRealWorkspaceSmokeReport(runtimeUrl, workspacePath);
  let runtimeHandle: { close: () => void } | undefined;

  try {
    runtimeHandle = await ensureRuntimeHealth(runtimeUrl);
    const health = await getRuntimeHealth(runtimeUrl);
    report["runtime health"] = "ok";
    assert.equal(health.status, "ok");

    const rustProjectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
    report.rustWorkspaceAuthority = await openWorkspaceWithRustAuthority(rustProjectDir, workspacePath);
    report["workspace opened"] = true;

    const snapshot = await inspectWorkspaceForQuestions(workspacePath);
    const questions = generateProjectQuestions(snapshot);
    report["generated questions"] = questions;

    const providerResolution = await resolveRealProviderConfig(args);
    if (!providerResolution) {
      throw new SmokeFailure(
        "provider_missing",
        "No real provider was detected. Set OLLAMA_MODEL/HIVO_OLLAMA_MODEL with a reachable Ollama server, set OPENAI_API_KEY plus optional OPENAI_MODEL, or pass --provider, --provider-base-url, --provider-model, and --provider-api-key-env."
      );
    }

    const sessionToken = randomUUID();
    const created = await createRuntimeSession(runtimeUrl, workspacePath, questions[0] ?? "What is this project?", {
      mode: "real_provider",
      requireRealProvider: true,
      providerConfig: providerResolution.config,
      activeProviderSource: providerResolution.source,
      sessionToken,
      sessionTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      executionMode: "simple_mode",
      accessProfile: "full_access"
    });
    report["session created"] = true;

    const sse = subscribeSessionUpdates(runtimeUrl, created.sessionId, sessionToken);
    try {
      let session = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
      let assistantCount = session.messages.filter((message) => message.role === "assistant").length;

      for (const question of questions) {
        const updatesBefore = sse.updateCount;
        const assistantCountBefore = assistantCount;
        const updatedAtBefore = session.updatedAt;
        await runTurn(runtimeUrl, created.sessionId, question, sessionToken);
        try {
          await sse.waitForUpdateAfter(updatesBefore, 10_000);
        } catch (error) {
          const canonical = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
          report["session updates"].canonicalFetchCount += 1;
          report["session updates"].sseUpdateCount = sse.updateCount;
          report["session updates"].lastCanonicalStatus = canonical.status;
          report["session updates"].lastError = error instanceof Error ? error.message : String(error);
          const canonicalProgressed =
            canonical.messages.filter((message) => message.role === "assistant").length > assistantCountBefore
            || canonical.updatedAt !== updatedAtBefore
            || canonical.status !== "running";
          if (canonicalProgressed) {
            throw new SmokeFailure("session_reconciliation_failed", "Canonical session progressed but the expected SSE update was missing.", {
              question,
              updatesBefore,
              updatesAfter: sse.updateCount,
              updatedAtBefore,
              updatedAtAfter: canonical.updatedAt,
              statusAfter: canonical.status,
              originalError: error instanceof Error ? error.message : String(error)
            });
          }
          throw new SmokeFailure("session_stuck", "Neither SSE nor canonical session state progressed after a turn.", {
            question,
            updatesBefore,
            updatesAfter: sse.updateCount,
            updatedAtBefore,
            updatedAtAfter: canonical.updatedAt,
            statusAfter: canonical.status
          });
        }
        session = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
        report["session updates"].canonicalFetchCount += 1;
        report["session updates"].sseUpdateCount = sse.updateCount;
        report["session updates"].lastCanonicalStatus = session.status;
        updateWorkAccounting(report, session);
        const assistantMessages = session.messages.filter((message) => message.role === "assistant");
        const newAnswer = assistantMessages.slice(assistantCount).at(-1)?.content ?? assistantMessages.at(-1)?.content ?? "";
        assistantCount = assistantMessages.length;
        const quality = evaluateAnswerQuality(newAnswer, snapshot, question);
        report["assistant answers"].push({
          question,
          answer: newAnswer,
          quality: quality.ok ? "passed" : "failed",
          evidenceFiles: quality.evidenceFiles,
          failureReason: quality.ok ? undefined : quality.reason
        });
        updateProviderTruth(report, session);
        if (!quality.ok) {
          assertRealProviderTelemetry(session.providerTelemetry, { allowLocalAnswerFallback: true });
          throw new SmokeFailure("answer_quality_failed", quality.reason, { question, answer: newAnswer });
        }
        assertRealProviderTelemetry(session.providerTelemetry);
      }
    } finally {
      sse.close();
    }

    report["session updates"].status = "ok";
    if (args.includeOrchestratedSwarm) {
      report["orchestrated swarm"] = await runOrchestratedSwarmSmoke(runtimeUrl, workspacePath, providerResolution);
      if (report["orchestrated swarm"].status !== "ok") {
        throw new SmokeFailure(
          report["orchestrated swarm"].failureCode ?? "provider_failed",
          report["orchestrated swarm"].failureReason ?? "Provider-backed orchestrated swarm did not complete successfully.",
          report["orchestrated swarm"]
        );
      }
    }
    if (args.includeProviderMatrix) {
      report["provider prompt matrix"] = await runProviderPromptMatrixSmoke(runtimeUrl, workspacePath, providerResolution, snapshot);
      if (report["provider prompt matrix"].status !== "ok") {
        throw new SmokeFailure(
          report["provider prompt matrix"].failureCode ?? "provider_failed",
          report["provider prompt matrix"].failureReason ?? "Provider-backed prompt matrix did not complete successfully.",
          report["provider prompt matrix"]
        );
      }
    }
    report["answer quality result"] = "passed";
    report["final result"] = "passed";
    console.log("session updates ok");
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const failure = normalizeSmokeFailure(error);
    report.failureCode = failure.code;
    report.failureReason = failure.message;
    if (failure.code === "runtime_unavailable") report["runtime health"] = "failed";
    if (failure.code === "session_reconciliation_failed" || failure.code === "session_stuck" || failure.code === "sse_disconnected" || failure.code === "token_expired" || failure.code === "unauthorized") {
      report["session updates"].status = "failed";
      report["session updates"].lastError = failure.message;
    }
    if (failure.code === "answer_quality_failed" || failure.code === "answer_grounding_failed") report["answer quality result"] = "failed";
    console.log(JSON.stringify(report, null, 2));
    throw failure;
  } finally {
    runtimeHandle?.close();
  }
}

export function createRealWorkspaceSmokeReport(runtimeUrl: string, workspacePath: string): RealWorkspaceSmokeReport {
  return {
    "runtime health": "unknown",
    "workspace opened": false,
    "session created": false,
    "session updates": {
      status: "unknown",
      sseUpdateCount: 0,
      canonicalFetchCount: 0,
      lastCanonicalStatus: null,
      lastError: null
    },
    "work accounting": {
      scannedFiles: null,
      sampledFiles: null,
      evidenceFilesUsed: null,
      generatedEvidenceExcluded: null,
      progressEventCount: null,
      artifactCount: null
    },
    "provider truth": {
      activeProviderSource: null,
      mockProviderUsed: null,
      fallbackUsed: null,
      requestCount: null,
      promptChars: null,
      responseChars: null,
      contextChars: null,
      lastError: null
    },
    "orchestrated swarm": {
      status: "not_run",
      sessionStatus: null,
      resolvedExecutionMode: null,
      logicalAgents: null,
      agentRuns: null,
      workerOutputs: null,
      providerRequests: null,
      providerFailures: null,
      providerTimeouts: null,
      promptChars: null,
      mockProviderUsed: null,
      fallbackUsed: null
    },
    "provider prompt matrix": {
      status: "not_run",
      prompts: []
    },
    "generated questions": [],
    "assistant answers": [],
    "answer quality result": "unknown",
    "final result": "failed",
    runtimeUrl,
    workspacePath
  };
}

function parseCliArgs(argv: string[]): RealWorkspaceSmokeArgs {
  const args: RealWorkspaceSmokeArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      args.workspace = argv[index + 1];
      index += 1;
    } else if (arg === "--runtime-url") {
      args.runtimeUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--provider") {
      args.provider = argv[index + 1];
      index += 1;
    } else if (arg === "--provider-base-url") {
      args.providerBaseUrl = argv[index + 1];
      index += 1;
    } else if (arg === "--provider-model") {
      args.providerModel = argv[index + 1];
      index += 1;
    } else if (arg === "--provider-api-key-env") {
      args.providerApiKeyEnv = argv[index + 1];
      index += 1;
    } else if (arg === "--include-orchestrated-swarm") {
      args.includeOrchestratedSwarm = true;
    } else if (arg === "--include-provider-matrix") {
      args.includeProviderMatrix = true;
    }
  }
  return args;
}

async function getRuntimeHealth(runtimeUrl: string) {
  try {
    const response = await fetch(`${runtimeUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json() as Promise<{ status: string; mode?: string }>;
  } catch (error) {
    throw new SmokeFailure("runtime_unavailable", `agent-runtime is unavailable at ${runtimeUrl}: ${String(error)}`);
  }
}

async function ensureRuntimeHealth(runtimeUrl: string) {
  try {
    await getRuntimeHealth(runtimeUrl);
    return { close: () => undefined };
  } catch {
    // Try to start the local runtime below; if it does not become healthy, report runtime_unavailable.
  }

  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch (error) {
    throw new SmokeFailure("runtime_unavailable", `Invalid runtime URL ${runtimeUrl}: ${String(error)}`);
  }
  const port = Number(parsed.port || "4317");
  if (!Number.isFinite(port) || port <= 0) {
    throw new SmokeFailure("runtime_unavailable", `Invalid runtime port in ${runtimeUrl}.`);
  }
  try {
    const storageDir = path.join(os.tmpdir(), `hivo-real-workspace-smoke-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const { app } = await buildServer({
      ...loadConfig(),
      host: parsed.hostname,
      port,
      storageDir
    });
    await app.listen({ host: parsed.hostname, port });
    await getRuntimeHealth(runtimeUrl);
    return {
      close: () => {
        void app.close();
        void rm(storageDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    throw new SmokeFailure("runtime_unavailable", `Failed to start agent-runtime on ${runtimeUrl}: ${String(error)}`);
  }
}

async function openWorkspaceWithRustAuthority(rustProjectDir: string, workspace: string) {
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(
      "cargo",
      ["run", "--quiet", "--bin", "runtime_bridge_smoke", "--", "--workspace", workspace, "--open-workspace", "true"],
      {
        cwd: rustProjectDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(new SmokeFailure("workspace_open_failed", String(error))));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new SmokeFailure("workspace_open_failed", stderr || stdout || `Rust workspace authority failed with exit code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { workspaceOpened?: boolean };
        if (!parsed.workspaceOpened) {
          reject(new SmokeFailure("workspace_open_failed", "Rust workspace authority did not report workspaceOpened=true.", parsed));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(new SmokeFailure("workspace_open_failed", `Failed to decode Rust workspace authority output: ${String(error)}`, stdout));
      }
    });
  });
}

export async function inspectWorkspaceForQuestions(workspacePath: string): Promise<ProjectSnapshot> {
  const rootStat = await stat(workspacePath).catch((error) => {
    throw new SmokeFailure("workspace_open_failed", `Workspace path is not accessible: ${String(error)}`);
  });
  if (!rootStat.isDirectory()) {
    throw new SmokeFailure("workspace_open_failed", "Workspace path must be a directory.");
  }

  const files = await listProjectFiles(workspacePath);
  if (!files.length) {
    throw new SmokeFailure("workspace_open_failed", "Workspace contains no readable files for a real project smoke.");
  }

  const manifestFiles = files.filter((file) => isManifestFile(file));
  const sourceFiles = files.filter((file) => isSourceFile(file));
  const testFiles = files.filter((file) => isTestFile(file));
  const entrypointFiles = files.filter((file) => isEntrypointFile(file)).slice(0, 12);
  const packageJson = await readJsonIfExists(path.join(workspacePath, "package.json"));
  const scripts = packageJson && typeof packageJson === "object" && "scripts" in packageJson
    ? Object.keys((packageJson as { scripts?: Record<string, unknown> }).scripts ?? {})
    : [];
  const packageManagers = detectPackageManagers(files);
  const directories = [...new Set(files.map((file) => file.split("/").slice(0, -1).join("/")).filter(Boolean))]
    .filter((directory) => !shouldSkipProjectPath(directory))
    .slice(0, 20);
  const primaryFile = sourceFiles[0] ?? manifestFiles[0] ?? files[0];

  return {
    workspacePath,
    files,
    sourceFiles,
    manifestFiles,
    entrypointFiles,
    testFiles,
    packageManagers,
    scripts,
    directories,
    primaryFile
  };
}

export async function listProjectFiles(workspacePath: string) {
  const files: string[] = [];
  async function walk(current: string, depth: number) {
    if (depth > 5 || files.length >= 800) return;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelativePath(path.relative(workspacePath, absolute));
      if (!relative || shouldSkipProjectPath(relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        files.push(relative);
      }
      if (files.length >= 800) return;
    }
  }
  await walk(workspacePath, 0);
  return files.sort();
}

export function generateProjectQuestions(snapshot: ProjectSnapshot) {
  const manifestHint = snapshot.manifestFiles.slice(0, 4).join(", ") || snapshot.files.slice(0, 4).join(", ");
  const entryHint = snapshot.entrypointFiles.slice(0, 6).join(", ") || snapshot.sourceFiles.slice(0, 6).join(", ");
  const sourceHint = snapshot.sourceFiles.slice(0, 8).join(", ") || entryHint || manifestHint;
  const flowHint = [
    ...snapshot.entrypointFiles,
    ...snapshot.sourceFiles.filter((file) => /(^|\/)(routes?|main|app|server)\.(tsx?|jsx?|py|rs|go)$/i.test(file)
      || /(^|\/)(services?|api|controllers?)\//i.test(file))
  ].filter((file, index, files) => files.indexOf(file) === index).slice(0, 8).join(", ") || sourceHint;
  return [
    `What are the main entrypoint files in this project? Use the detected candidates ${entryHint}.`,
    `How do these detected source files connect the project flow? Use only project files such as ${flowHint}.`
  ];
}

type SmokeProviderResolution = {
  config: SanitizedProviderConfig;
  source: ProviderTruthTelemetry["activeProviderSource"];
};

async function resolveRealProviderConfig(args: RealWorkspaceSmokeArgs): Promise<SmokeProviderResolution | undefined> {
  if (args.provider) {
    const provider = normalizeProviderType(args.provider);
    if (!provider) {
      throw new SmokeFailure("provider_validation_failed", `Unsupported provider ${args.provider}. Use ollama or openai-compatible.`);
    }
    if (!args.providerBaseUrl?.trim() || !args.providerModel?.trim()) {
      throw new SmokeFailure("provider_validation_failed", "--provider-base-url and --provider-model are required with --provider.");
    }
    if (provider === "openai_compatible") {
      const apiKeyEnv = args.providerApiKeyEnv?.trim() || "OPENAI_API_KEY";
      if (!process.env[apiKeyEnv]?.trim()) {
        throw new SmokeFailure("provider_api_key_missing", `Provider API key environment variable ${apiKeyEnv} is not configured.`);
      }
      return {
        config: {
          providerType: "openai_compatible",
          providerName: "OpenAI-compatible",
          baseUrl: args.providerBaseUrl,
          selectedModel: args.providerModel,
          apiKeyEnv,
          apiKeyConfigured: true,
          isValid: true
        },
        source: "explicit_cli"
      };
    }
    await validateOllamaProvider(args.providerBaseUrl, args.providerModel);
    return {
      config: {
        providerType: "ollama",
        providerName: "Ollama",
        baseUrl: args.providerBaseUrl,
        selectedModel: args.providerModel,
        isValid: true
      },
      source: "explicit_cli"
    };
  }

  const ollamaModel = process.env.OLLAMA_MODEL ?? process.env.HIVO_OLLAMA_MODEL;
  if (ollamaModel) {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
    await validateOllamaProvider(baseUrl, ollamaModel);
    return {
      config: {
        providerType: "ollama",
        providerName: "Ollama",
        baseUrl,
        selectedModel: ollamaModel,
        isValid: true
      },
      source: "env_ollama"
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      config: {
        providerType: "openai_compatible",
        providerName: process.env.OPENAI_PROVIDER_NAME ?? "OpenAI-compatible",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com",
        selectedModel: process.env.OPENAI_MODEL ?? process.env.HIVO_OPENAI_MODEL ?? "gpt-4o-mini",
        apiKeyEnv: "OPENAI_API_KEY",
        apiKeyConfigured: true,
        isValid: true
      },
      source: "env_openai_compatible"
    };
  }

  return undefined;
}

function normalizeProviderType(value: string) {
  const normalized = value.trim().toLowerCase().replaceAll("-", "_");
  if (normalized === "ollama") return "ollama";
  if (normalized === "openai_compatible" || normalized === "openai") return "openai_compatible";
  return undefined;
}

async function validateOllamaProvider(baseUrl: string, model: string) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) {
      throw new SmokeFailure("provider_validation_failed", `Ollama validation failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as { models?: Array<{ name?: string }> };
    if (Array.isArray(body.models) && body.models.length > 0 && !body.models.some((entry) => entry.name === model)) {
      throw new SmokeFailure("provider_validation_failed", `Ollama model ${model} was not found in /api/tags.`);
    }
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    throw new SmokeFailure("provider_validation_failed", `Ollama validation failed: ${String(error)}`);
  }
}

function subscribeSessionUpdates(runtimeUrl: string, sessionId: string, sessionToken: string) {
  const controller = new AbortController();
  const state = {
    updateCount: 0,
    error: undefined as Error | undefined,
    errorCode: undefined as SmokeFailureCode | undefined
  };
  void (async () => {
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/$/, "")}/sessions/${sessionId}/events?token=${encodeURIComponent(sessionToken)}`, {
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        const parsedCode = parseProviderErrorCode(text);
        state.errorCode =
          response.status === 401 && (parsedCode === "token_expired" || parsedCode === "unauthorized")
            ? parsedCode
            : "sse_disconnected";
        throw new Error(`SSE failed with HTTP ${response.status}: ${text}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const chunks = buffer.split(/\n\n/);
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const eventName = chunk.split(/\n/).find((line) => line.startsWith("event:"))?.slice("event:".length).trim();
          if (eventName === "runtime.session.updated") state.updateCount += 1;
        }
      }
      if (!controller.signal.aborted) {
        state.errorCode = "sse_disconnected";
        state.error = new Error("SSE disconnected before the smoke closed the stream.");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.errorCode ??= "sse_disconnected";
        state.error = error instanceof Error ? error : new Error(String(error));
      }
    }
  })();

  return {
    get updateCount() {
      return state.updateCount;
    },
    close: () => controller.abort(),
    waitForUpdateAfter: async (previous: number, timeoutMs: number) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (state.error) {
          throw new SmokeFailure(state.errorCode ?? "sse_disconnected", state.error.message);
        }
        if (state.updateCount > previous) return;
        await delay(50);
      }
      throw new SmokeFailure("session_reconciliation_failed", `No runtime.session.updated SSE event arrived within ${timeoutMs}ms.`);
    }
  };
}

function evaluateAnswerQuality(answer: string, snapshot: ProjectSnapshot, question: string) {
  const trimmed = answer.trim();
  if (!trimmed) {
    return { ok: false, evidenceFiles: [] as string[], reason: "Assistant answer was empty." };
  }
  if (/\b(i don'?t know|cannot access|can'?t access|do not have access|please provide|provide the code|mock provider|mockprovider|demo mock|generic response)\b/i.test(trimmed)) {
    return { ok: false, evidenceFiles: [] as string[], reason: "Assistant answer contained generic, inaccessible, or mock-like language." };
  }
  if (/provider_answer_failed_local_validation|local synthesis was not used|will not synthesize a local answer|provider output was unavailable or failed validation/i.test(trimmed)) {
    return { ok: false, evidenceFiles: [] as string[], reason: "Assistant answer was a provider-validation refusal, not a grounded project answer." };
  }
  const normalizedAnswer = trimmed.replaceAll("\\", "/");
  const evidenceFiles = snapshot.files.filter((file) => {
    const absolute = normalizeRelativePath(path.join(snapshot.workspacePath, file));
    return normalizedAnswer.includes(file) || normalizedAnswer.includes(absolute);
  });
  if (!evidenceFiles.length) {
    return { ok: false, evidenceFiles, reason: "Assistant answer did not cite any real file path from the opened workspace." };
  }
  const questionFiles = requiresQuestionNamedFiles(question) ? extractMentionedProjectFiles(question, snapshot.files) : [];
  if (questionFiles.length && !questionFiles.some((file) => evidenceFiles.includes(file))) {
    return {
      ok: false,
      evidenceFiles: evidenceFiles.slice(0, 12),
      reason: `Assistant answer did not use the project file(s) named in the question: ${questionFiles.slice(0, 6).join(", ")}.`
    };
  }
  if (isDependencyOrConfigurationQuestion(question)) {
    const availableDependencyFiles = snapshot.files.filter((file) => isDependencyOrConfigurationEvidenceFile(file));
    const citedDependencyFiles = evidenceFiles.filter((file) => isDependencyOrConfigurationEvidenceFile(file));
    if (availableDependencyFiles.length && !citedDependencyFiles.length) {
      return {
        ok: false,
        evidenceFiles: evidenceFiles.slice(0, 12),
        reason: `Dependency/configuration answer did not cite available dependency or configuration evidence. Available: ${availableDependencyFiles.slice(0, 8).join(", ")}.`
      };
    }
  }
  return { ok: true, evidenceFiles: evidenceFiles.slice(0, 12), reason: undefined };
}

function extractMentionedProjectFiles(question: string, files: string[]) {
  const normalizedQuestion = question.replaceAll("\\", "/");
  return files.filter((file) => normalizedQuestion.includes(file));
}

function requiresQuestionNamedFiles(question: string) {
  return /\b(use the detected candidates|answer only from)\b/i.test(question);
}

function isDependencyOrConfigurationQuestion(question: string) {
  return /\b(dependenc(?:y|ies)|configuration|config|runtime|package manager|script|requirements?|manifest)\b/i.test(question);
}

function isDependencyOrConfigurationEvidenceFile(file: string) {
  return /(^|\/)(README\.md|requirements(?:-[\w.-]+)?\.txt|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|poetry\.lock|Pipfile|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|deno\.jsonc?|vite\.config\.[cm]?[jt]s|tsconfig\.json|backend\/main\.py|frontend\/app\.js)$/i.test(file)
    || /(^|\/)(config|settings|scripts?)[\w./-]*\.(?:json|toml|ya?ml|js|ts|py|sh|ps1)$/i.test(file);
}

function assertRealProviderTelemetry(
  telemetry: ProviderTruthTelemetry | undefined,
  options: { allowLocalAnswerFallback?: boolean } = {}
) {
  if (!telemetry) {
    throw new SmokeFailure("provider_missing", "Provider telemetry was missing from the runtime session.");
  }
  if (telemetry.mockProviderUsed || telemetry.providerMode === "demo_mock") {
    throw new SmokeFailure("provider_mock_forbidden", "Runtime used MockProvider/demo mode during a real-provider smoke.", telemetry);
  }
  if (telemetry.providerFailureCount > 0 || telemetry.providerTimeoutCount > 0) {
    throw new SmokeFailure("provider_failed", "A real provider request failed or timed out.", telemetry);
  }
  if (telemetry.fallbackUsed) {
    if (options.allowLocalAnswerFallback && telemetry.providerRequestCount >= 1 && telemetry.providerResponseCount >= 1) {
      return;
    }
    const reason = telemetry.lastError
      ?? [...telemetry.perPromptProviderLatencyMs].reverse().find((entry) => entry.errorSummary)?.errorSummary
      ?? "Runtime fell back after local answer validation or synthesis.";
    if (telemetry.providerRequestCount >= 1 && telemetry.providerResponseCount >= 1) {
      const groundingFailure = /ground|evidence|citation|local validation|provider_answer_failed_local_validation/i.test(reason);
      throw new SmokeFailure(
        groundingFailure ? "answer_grounding_failed" : "answer_quality_failed",
        `Provider returned a response, but the final answer failed local quality/grounding validation: ${reason}`,
        telemetry
      );
    }
    throw new SmokeFailure("provider_failed", `Runtime fell back before a usable provider response was recorded: ${reason}`, telemetry);
  }
  if (telemetry.providerRequestCount < 1 || !telemetry.realProviderUsed) {
    throw new SmokeFailure("provider_failed", "Runtime did not record any real provider requests.", telemetry);
  }
}

async function runOrchestratedSwarmSmoke(
  runtimeUrl: string,
  workspacePath: string,
  providerResolution: SmokeProviderResolution
): Promise<RealWorkspaceSmokeReport["orchestrated swarm"]> {
  const sessionToken = randomUUID();
  const prompt = "Read-only inspect with multiple agents: explain how backend/main.py, backend/services/action_executor.py, backend/services/orchestrator.py, and tests/test_api_smoke.py connect. Do not change files.";
  const base: RealWorkspaceSmokeReport["orchestrated swarm"] = {
    status: "failed",
    sessionStatus: null,
    resolvedExecutionMode: null,
    logicalAgents: null,
    agentRuns: null,
    workerOutputs: null,
    providerRequests: null,
    providerFailures: null,
    providerTimeouts: null,
    promptChars: null,
    mockProviderUsed: null,
    fallbackUsed: null
  };
  try {
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "real_provider",
      requireRealProvider: true,
      providerConfig: providerResolution.config,
      activeProviderSource: providerResolution.source,
      sessionToken,
      sessionTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      executionMode: "orchestrated_mode",
      accessProfile: "full_access"
    });
    const sse = subscribeSessionUpdates(runtimeUrl, created.sessionId, sessionToken);
    try {
      const updatesBefore = sse.updateCount;
      await runTurn(runtimeUrl, created.sessionId, prompt, sessionToken);
      await sse.waitForUpdateAfter(updatesBefore, 20_000);
    } finally {
      sse.close();
    }

    const session = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
    const telemetry = session.providerTelemetry;
    const swarmReport: RealWorkspaceSmokeReport["orchestrated swarm"] = {
      status: "ok",
      sessionStatus: session.status,
      resolvedExecutionMode: session.resolvedExecutionMode ?? null,
      logicalAgents: session.delegationDecision?.selectedAgentCount ?? null,
      agentRuns: session.orchestration?.agentRuns.length ?? null,
      workerOutputs: session.orchestration?.workerOutputs.length ?? null,
      providerRequests: telemetry?.providerRequestCount ?? null,
      providerFailures: telemetry?.providerFailureCount ?? null,
      providerTimeouts: telemetry?.providerTimeoutCount ?? null,
      promptChars: telemetry?.totalProviderPromptChars ?? null,
      mockProviderUsed: telemetry?.mockProviderUsed ?? null,
      fallbackUsed: telemetry?.fallbackUsed ?? null,
      finalMessagePrefix: session.messages.filter((message) => message.role === "assistant").at(-1)?.content.slice(0, 160)
    };
    const failures: string[] = [];
    if (session.status !== "completed") failures.push(`session status was ${session.status}`);
    if (session.resolvedExecutionMode !== "orchestrated_mode") failures.push(`resolvedExecutionMode was ${session.resolvedExecutionMode ?? "missing"}`);
    if ((swarmReport.logicalAgents ?? 0) <= 1) failures.push(`logical agent count was ${swarmReport.logicalAgents ?? "missing"}`);
    if ((swarmReport.agentRuns ?? 0) <= 1) failures.push(`agent run count was ${swarmReport.agentRuns ?? "missing"}`);
    if ((swarmReport.workerOutputs ?? 0) <= 1) failures.push(`worker output count was ${swarmReport.workerOutputs ?? "missing"}`);
    if ((telemetry?.providerRequestCount ?? 0) <= 1) failures.push(`provider request count was ${telemetry?.providerRequestCount ?? "missing"}`);
    if (telemetry?.mockProviderUsed) failures.push("mockProviderUsed was true");
    if (telemetry?.fallbackUsed) failures.push("fallbackUsed was true");
    if (failures.length) {
      return {
        ...swarmReport,
        status: "failed",
        failureCode: "provider_failed",
        failureReason: failures.join("; ")
      };
    }
    return swarmReport;
  } catch (error) {
    return {
      ...base,
      failureCode: error instanceof SmokeFailure ? error.code : undefined,
      failureReason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runProviderPromptMatrixSmoke(
  runtimeUrl: string,
  workspacePath: string,
  providerResolution: SmokeProviderResolution,
  snapshot: ProjectSnapshot
): Promise<RealWorkspaceSmokeReport["provider prompt matrix"]> {
  const prompts = generateProviderMatrixPrompts(snapshot);
  const results: RealWorkspaceSmokeReport["provider prompt matrix"]["prompts"] = [];
  for (const prompt of prompts) {
    const sessionToken = randomUUID();
    try {
      const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt.message, {
        mode: "real_provider",
        requireRealProvider: true,
        providerConfig: providerResolution.config,
        activeProviderSource: providerResolution.source,
        sessionToken,
        sessionTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        executionMode: "auto_mode",
        accessProfile: "full_access"
      });
      await runTurn(runtimeUrl, created.sessionId, prompt.message, sessionToken);
      const session = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
      const telemetry = session.providerTelemetry;
      const entry: RealWorkspaceSmokeReport["provider prompt matrix"]["prompts"][number] = {
        label: prompt.label,
        sessionStatus: session.status,
        resolvedExecutionMode: session.resolvedExecutionMode ?? null,
        agentName: session.agentName ?? null,
        workerOutputs: session.orchestration?.workerOutputs.length ?? null,
        providerRequests: telemetry?.providerRequestCount ?? null,
        providerFailures: telemetry?.providerFailureCount ?? null,
        providerTimeouts: telemetry?.providerTimeoutCount ?? null,
        promptChars: telemetry?.totalProviderPromptChars ?? null,
        contextChars: telemetry?.totalProviderContextChars ?? null,
        mockProviderUsed: telemetry?.mockProviderUsed ?? null,
        fallbackUsed: telemetry?.fallbackUsed ?? null,
        finalMessagePrefix: session.messages.filter((message) => message.role === "assistant").at(-1)?.content.slice(0, 180)
      };
      const failures = validateProviderMatrixEntry(entry);
      if (failures.length) entry.failureReason = failures.join("; ");
      results.push(entry);
    } catch (error) {
      results.push({
        label: prompt.label,
        sessionStatus: null,
        resolvedExecutionMode: null,
        agentName: null,
        workerOutputs: null,
        providerRequests: null,
        providerFailures: null,
        providerTimeouts: null,
        promptChars: null,
        contextChars: null,
        mockProviderUsed: null,
        fallbackUsed: null,
        failureReason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const failures = results.filter((entry) => entry.failureReason);
  if (failures.length) {
    return {
      status: "failed",
      prompts: results,
      failureCode: failures.some((entry) => entry.mockProviderUsed || entry.fallbackUsed) ? "provider_failed" : "answer_quality_failed",
      failureReason: failures.map((entry) => `${entry.label}: ${entry.failureReason}`).join(" | ")
    };
  }
  return {
    status: "ok",
    prompts: results
  };
}

function generateProviderMatrixPrompts(snapshot: ProjectSnapshot) {
  const sourceHint = snapshot.sourceFiles.slice(0, 8).join(", ") || snapshot.entrypointFiles.slice(0, 6).join(", ") || snapshot.primaryFile;
  return [
    {
      label: "orchestrator_human_review",
      message: "When does the orchestrator do direct dispatch, and when does it route to human review even if agents suggest an action? Answer from current project files only."
    },
    {
      label: "artifact_inventory",
      message: "Which project files produce durable artifacts such as models, data, and logs? What is the difference between training artifacts and runtime logs? Answer from current project files only."
    },
    {
      label: "source_flow",
      message: `Explain how these project source files connect the runtime flow: ${sourceHint}. Answer from current project files only.`
    }
  ];
}

function validateProviderMatrixEntry(entry: RealWorkspaceSmokeReport["provider prompt matrix"]["prompts"][number]) {
  const failures: string[] = [];
  if (entry.sessionStatus !== "completed") failures.push(`session status was ${entry.sessionStatus ?? "missing"}`);
  if (entry.resolvedExecutionMode !== "orchestrated_mode") failures.push(`resolvedExecutionMode was ${entry.resolvedExecutionMode ?? "missing"}`);
  if (entry.agentName !== "Provider-Backed Swarm") failures.push(`agentName was ${entry.agentName ?? "missing"}`);
  if ((entry.workerOutputs ?? 0) <= 1) failures.push(`workerOutputs was ${entry.workerOutputs ?? "missing"}`);
  if ((entry.providerRequests ?? 0) <= 1) failures.push(`providerRequests was ${entry.providerRequests ?? "missing"}`);
  const providerFailures = (entry.providerFailures ?? 0) + (entry.providerTimeouts ?? 0);
  const providerRequests = entry.providerRequests ?? 0;
  const workerOutputs = entry.workerOutputs ?? 0;
  if (providerRequests > 0 && providerFailures >= providerRequests) {
    failures.push(`all provider calls failed (${providerFailures}/${providerRequests})`);
  }
  if (providerFailures > 0 && workerOutputs < 8) {
    failures.push(`provider failures reduced worker evidence too far (${providerFailures} failures, ${workerOutputs} worker outputs)`);
  }
  if ((entry.promptChars ?? 0) < 50_000) failures.push(`promptChars was ${entry.promptChars ?? "missing"}`);
  if ((entry.contextChars ?? 0) < 20_000) failures.push(`contextChars was ${entry.contextChars ?? "missing"}`);
  if (entry.mockProviderUsed) failures.push("mockProviderUsed was true");
  if (entry.fallbackUsed) failures.push("fallbackUsed was true");
  if (!entry.finalMessagePrefix?.trim()) failures.push("final assistant message was empty");
  if (/provider output was unavailable|local synthesis was not used|provider_validation_notice|mockprovider/i.test(entry.finalMessagePrefix ?? "")) {
    failures.push("final assistant message looked like a validation refusal or mock output");
  }
  return failures;
}

function updateProviderTruth(report: RealWorkspaceSmokeReport, session: AgentRuntimeSession) {
  report["provider truth"] = createProviderTruthSmokeOutput(session);
}

function updateWorkAccounting(report: RealWorkspaceSmokeReport, session: AgentRuntimeSession) {
  report["work accounting"] = {
    scannedFiles: session.explainReport?.contextPack.inventory.scannedFiles ?? null,
    sampledFiles: session.explainReport?.contextPack.readBudget.sampledFiles ?? null,
    evidenceFilesUsed: session.evidenceReport?.finalEvidenceFilesActuallyUsed.length ?? null,
    generatedEvidenceExcluded: session.evidenceReport?.generatedEvidenceExcludedCount ?? null,
    progressEventCount: session.progressEvents.length,
    artifactCount: session.artifacts.length
  };
}

export function createProviderTruthSmokeOutput(session: Pick<AgentRuntimeSession, "providerTelemetry" | "runSummary" | "reasoningSummaries">): RealWorkspaceSmokeReport["provider truth"] {
  const telemetry = session.providerTelemetry;
  const lastLatency = telemetry?.perPromptProviderLatencyMs.filter((item) => item.errorSummary).at(-1);
  return {
    activeProviderSource: telemetry?.activeProviderSource ?? null,
    mockProviderUsed: telemetry?.mockProviderUsed ?? null,
    fallbackUsed: telemetry?.fallbackUsed ?? null,
    requestCount: telemetry?.providerRequestCount ?? null,
    promptChars: telemetry?.totalProviderPromptChars ?? null,
    responseChars: telemetry?.totalProviderResponseChars ?? null,
    contextChars: telemetry?.totalProviderContextChars ?? null,
    lastError: telemetry?.lastError ?? lastLatency?.errorSummary ?? getLastSessionError(session),
    raw: telemetry
  };
}

function getLastSessionError(session: Pick<AgentRuntimeSession, "runSummary" | "reasoningSummaries">) {
  const gateError = session.runSummary?.gates.flatMap((gate) => gate.notes).find((note) => /error|requires|failed|not configured/i.test(note));
  const reasoningError = [...session.reasoningSummaries].reverse().find((entry) => /error|requires|failed|not configured/i.test(entry));
  return gateError ?? reasoningError ?? null;
}

function normalizeSmokeFailure(error: unknown): SmokeFailure {
  if (error instanceof SmokeFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  const parsedCode = parseProviderErrorCode(message);
  if (parsedCode) {
    return new SmokeFailure(parsedCode, message);
  }
  if (/api key environment variable|OPENAI_API_KEY|api key/i.test(message)) {
    return new SmokeFailure("provider_api_key_missing", message);
  }
  if (/MockProvider|provider_mock_forbidden/i.test(message)) {
    return new SmokeFailure("provider_mock_forbidden", message);
  }
  if (/timeout|request failed|providerFailure|provider_request_failed|provider_failed/i.test(message)) {
    return new SmokeFailure("provider_failed", message);
  }
  if (/provider_answer_failed_local_validation|local answer validation|local validation|grounding|citation|evidence|answer_grounding_failed/i.test(message)) {
    return new SmokeFailure("answer_grounding_failed", message);
  }
  if (/answer_quality_failed|boilerplate|generic|too short|cannot access/i.test(message)) {
    return new SmokeFailure("answer_quality_failed", message);
  }
  if (/unsupported provider|provider_validation_failed|Ollama validation failed|model .* was not found/i.test(message)) {
    return new SmokeFailure("provider_validation_failed", message);
  }
  if (/real_provider requires|provider|model/i.test(message)) {
    return new SmokeFailure("provider_missing", message);
  }
  return new SmokeFailure("answer_quality_failed", message);
}

function parseProviderErrorCode(message: string): SmokeFailureCode | undefined {
  try {
    const parsed = JSON.parse(message) as { code?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return isProviderFailureCode(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function isProviderFailureCode(value: string | undefined): value is SmokeFailureCode {
  return value === "runtime_unavailable"
    || value === "sse_disconnected"
    || value === "token_expired"
    || value === "unauthorized"
    || value === "provider_missing"
    || value === "provider_api_key_missing"
    || value === "provider_validation_failed"
    || value === "provider_failed"
    || value === "provider_mock_forbidden"
    || value === "session_reconciliation_failed"
    || value === "session_stuck"
    || value === "answer_quality_failed"
    || value === "answer_grounding_failed";
}

function detectPackageManagers(files: string[]) {
  const managers: string[] = [];
  if (files.includes("package-lock.json")) managers.push("npm");
  if (files.includes("pnpm-lock.yaml")) managers.push("pnpm");
  if (files.includes("yarn.lock")) managers.push("yarn");
  if (files.includes("bun.lockb") || files.includes("bun.lock")) managers.push("bun");
  if (files.includes("pyproject.toml")) managers.push("python/pyproject");
  if (files.includes("Cargo.toml")) managers.push("cargo");
  if (files.includes("go.mod")) managers.push("go");
  return managers;
}

function isManifestFile(file: string) {
  return /(^|\/)(package\.json|vite\.config\.[cm]?[jt]s|tsconfig\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|README\.md)$/i.test(file);
}

function isSourceFile(file: string) {
  return /\.(tsx?|jsx?|py|rs|go|java|kt|cs|cpp|c|h|vue|svelte)$/i.test(file) && !isTestFile(file);
}

function isTestFile(file: string) {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|test_.*\.py$/i.test(file);
}

function isEntrypointFile(file: string) {
  return /(^|\/)(main|index|app|server|route|routes|lib)\.(tsx?|jsx?|py|rs|go)$|(^|\/)src\/main\./i.test(file);
}

function shouldSkipProjectPath(relativePath: string) {
  return relativePath.split("/").some((part) =>
    [
      ".cache",
      ".agent_memory",
      ".git",
      ".hivo-agent-runtime",
      ".mypy_cache",
      ".next",
      ".nox",
      ".nuxt",
      ".orchcode-agent-runtime",
      ".pytest_cache",
      ".ruff_cache",
      ".svelte-kit",
      ".tmp-run",
      ".tox",
      ".venv",
      ".vite",
      "build",
      "coverage",
      "dist",
      "env",
      "ENV",
      "htmlcov",
      "node_modules",
      "out",
      "output",
      "outputs",
      "playwright-report",
      "screenshots",
      "site-packages",
      "target",
      "test-results",
      "venv",
      "__pycache__"
    ].includes(part)
  );
}

async function readJsonIfExists(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/");
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createWorkspace(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-desktop-smoke-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function createRuntimeSession(
  runtimeUrl: string,
  workspacePath: string,
  userPrompt = "run this project",
  options: {
    mode?: "demo_mock" | "real_provider";
    requireRealProvider?: boolean;
    providerConfig?: SanitizedProviderConfig;
    activeProviderSource?: ProviderTruthTelemetry["activeProviderSource"];
    sessionToken?: string;
    sessionTokenExpiresAt?: string;
    executionMode?: "auto_mode" | "simple_mode" | "orchestrated_mode";
    accessProfile?: "default_permissions" | "auto_review" | "bounded_autonomy" | "full_access" | "custom_config";
  } = {}
): Promise<SessionResponse> {
  const response = await fetch(`${runtimeUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      mode: options.mode ?? "demo_mock",
      requireRealProvider: options.requireRealProvider,
      providerConfig: options.providerConfig,
      activeProviderSource: options.activeProviderSource,
      sessionToken: options.sessionToken,
      sessionTokenExpiresAt: options.sessionTokenExpiresAt,
      executionMode: options.executionMode,
      accessProfile: options.accessProfile ?? "full_access",
      userPrompt
    })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<SessionResponse>;
}

async function runTurn(runtimeUrl: string, sessionId: string, message: string, sessionToken?: string) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/turn`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { "x-hivo-session-token": sessionToken } : {})
    },
    body: JSON.stringify({ message })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function getSession(runtimeUrl: string, sessionId: string, sessionToken?: string) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}`, {
    headers: sessionToken ? { "x-hivo-session-token": sessionToken } : undefined
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function runRuntimeRustBridge(input: {
  rustProjectDir: string;
  runtimeUrl: string;
  workspace: string;
  sessionId: string;
  requestId: string;
  command: string;
  cwd: string;
}) {
  return new Promise<{ commandResult: { status: string } }>((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--bin",
        "runtime_bridge_smoke",
        "--",
        "--runtime-url",
        input.runtimeUrl,
        "--workspace",
        input.workspace,
        "--cwd",
        input.cwd,
        "--session-id",
        input.sessionId,
        "--request-id",
        input.requestId,
        "--command",
        input.command
      ],
      {
        cwd: input.rustProjectDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Rust bridge smoke failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { commandResult: { status: string } });
      } catch (error) {
        reject(new Error(`Failed to decode Rust bridge output: ${String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function runStandaloneRustCommand(input: {
  rustProjectDir: string;
  workspace: string;
  cwd: string;
  command: string;
  approvalGranted: boolean;
}) {
  return new Promise<{ commandResult: { risk: string; status: string; exitCode?: number; diagnosis?: { category?: string; summary?: string } } }>((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--bin",
        "runtime_bridge_smoke",
        "--",
        "--workspace",
        input.workspace,
        "--cwd",
        input.cwd,
        "--command",
        input.command,
        "--approval-granted",
        input.approvalGranted ? "true" : "false"
      ],
      {
        cwd: input.rustProjectDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Standalone Rust command smoke failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as { commandResult: { risk: string; status: string; exitCode?: number; diagnosis?: { category?: string; summary?: string } } });
      } catch (error) {
        reject(new Error(`Failed to decode standalone Rust output: ${String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function tryRunLocalCommand(command: string, args: string[], cwd: string) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ ok: false, stdout, stderr }));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

if (isDirectRun()) {
  void main().catch((error) => {
    if (error instanceof SmokeFailure) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
