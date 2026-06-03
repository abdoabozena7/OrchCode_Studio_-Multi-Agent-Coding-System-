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
  | "workspace_open_failed"
  | "provider_missing"
  | "provider_api_key_missing"
  | "provider_validation_failed"
  | "provider_request_failed"
  | "provider_mock_forbidden"
  | "session_reconciliation_failed"
  | "answer_quality_failed";

type RealWorkspaceSmokeArgs = {
  workspace?: string;
  runtimeUrl?: string;
  provider?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKeyEnv?: string;
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
  "provider truth": {
    activeProviderSource: ProviderTruthTelemetry["activeProviderSource"] | null;
    mockProviderUsed: boolean | null;
    fallbackUsed: boolean | null;
    requestCount: number | null;
    lastError: string | null;
    raw?: ProviderTruthTelemetry;
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
  const report: RealWorkspaceSmokeReport = {
    "runtime health": "unknown",
    "workspace opened": false,
    "session created": false,
    "provider truth": {
      activeProviderSource: null,
      mockProviderUsed: null,
      fallbackUsed: null,
      requestCount: null,
      lastError: null
    },
    "generated questions": [],
    "assistant answers": [],
    "answer quality result": "unknown",
    "final result": "failed",
    runtimeUrl,
    workspacePath
  };
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
        await runTurn(runtimeUrl, created.sessionId, question, sessionToken);
        await sse.waitForUpdateAfter(updatesBefore, 10_000);
        session = await getSession(runtimeUrl, created.sessionId, sessionToken) as AgentRuntimeSession;
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
        assertRealProviderTelemetry(session.providerTelemetry);
        if (!quality.ok) {
          throw new SmokeFailure("answer_quality_failed", quality.reason, { question, answer: newAnswer });
        }
      }
    } finally {
      sse.close();
    }

    report["answer quality result"] = "passed";
    report["final result"] = "passed";
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const failure = normalizeSmokeFailure(error);
    report.failureCode = failure.code;
    report.failureReason = failure.message;
    if (failure.code === "runtime_unavailable") report["runtime health"] = "failed";
    if (failure.code === "answer_quality_failed") report["answer quality result"] = "failed";
    console.log(JSON.stringify(report, null, 2));
    throw failure;
  } finally {
    runtimeHandle?.close();
  }
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

async function inspectWorkspaceForQuestions(workspacePath: string): Promise<ProjectSnapshot> {
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

async function listProjectFiles(workspacePath: string) {
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

function generateProjectQuestions(snapshot: ProjectSnapshot) {
  const manifestHint = snapshot.manifestFiles.slice(0, 4).join(", ") || snapshot.files.slice(0, 4).join(", ");
  const entryHint = snapshot.entrypointFiles.slice(0, 6).join(", ") || snapshot.sourceFiles.slice(0, 6).join(", ");
  const commandHint = [...snapshot.manifestFiles.slice(0, 4), ...snapshot.packageManagers].filter(Boolean).join(", ") || manifestHint;
  const codeHint = [...snapshot.directories.slice(0, 5), ...snapshot.sourceFiles.slice(0, 5)].filter(Boolean).join(", ") || entryHint;
  const testHint = snapshot.testFiles.slice(0, 6).join(", ") || snapshot.manifestFiles.slice(0, 4).join(", ") || snapshot.files.slice(0, 4).join(", ");
  return [
    `What language, runtime, or project shape does this opened project show? Base the answer on real files such as ${manifestHint}.`,
    `What are the main entrypoint files in this project? Use the detected candidates ${entryHint}.`,
    `What dependency or configuration evidence is visible in ${commandHint}? Answer only from the opened project files.`
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
    error: undefined as Error | undefined
  };
  void (async () => {
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/$/, "")}/sessions/${sessionId}/events?token=${encodeURIComponent(sessionToken)}`, {
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`SSE failed with HTTP ${response.status}: ${await response.text()}`);
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
    } catch (error) {
      if (!controller.signal.aborted) {
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
          throw new SmokeFailure("session_reconciliation_failed", state.error.message);
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
  if (trimmed.length < 80) {
    return { ok: false, evidenceFiles: [] as string[], reason: "Assistant answer was empty or too short." };
  }
  if (/\b(i don'?t know|cannot access|can'?t access|please provide|provide the code|mock provider|mockprovider|demo mock|generic response)\b/i.test(trimmed)) {
    return { ok: false, evidenceFiles: [] as string[], reason: "Assistant answer contained generic, inaccessible, or mock-like language." };
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
  return { ok: true, evidenceFiles: evidenceFiles.slice(0, 12), reason: undefined };
}

function extractMentionedProjectFiles(question: string, files: string[]) {
  const normalizedQuestion = question.replaceAll("\\", "/");
  return files.filter((file) => normalizedQuestion.includes(file));
}

function requiresQuestionNamedFiles(question: string) {
  return /\b(use the detected candidates|answer only from)\b/i.test(question);
}

function assertRealProviderTelemetry(telemetry: ProviderTruthTelemetry | undefined) {
  if (!telemetry) {
    throw new SmokeFailure("provider_missing", "Provider telemetry was missing from the runtime session.");
  }
  if (telemetry.mockProviderUsed || telemetry.providerMode === "demo_mock") {
    throw new SmokeFailure("provider_mock_forbidden", "Runtime used MockProvider/demo mode during a real-provider smoke.", telemetry);
  }
  if (telemetry.providerFailureCount > 0 || telemetry.providerTimeoutCount > 0) {
    throw new SmokeFailure("provider_request_failed", "A real provider request failed or timed out.", telemetry);
  }
  if (telemetry.fallbackUsed) {
    throw new SmokeFailure("provider_validation_failed", "Runtime fell back after provider output validation or synthesis failed.", telemetry);
  }
  if (telemetry.providerRequestCount < 1 || !telemetry.realProviderUsed) {
    throw new SmokeFailure("provider_request_failed", "Runtime did not record any real provider requests.", telemetry);
  }
}

function updateProviderTruth(report: RealWorkspaceSmokeReport, session: AgentRuntimeSession) {
  report["provider truth"] = createProviderTruthSmokeOutput(session);
}

export function createProviderTruthSmokeOutput(session: Pick<AgentRuntimeSession, "providerTelemetry" | "runSummary" | "reasoningSummaries">): RealWorkspaceSmokeReport["provider truth"] {
  const telemetry = session.providerTelemetry;
  const lastLatency = telemetry?.perPromptProviderLatencyMs.filter((item) => item.errorSummary).at(-1);
  return {
    activeProviderSource: telemetry?.activeProviderSource ?? null,
    mockProviderUsed: telemetry?.mockProviderUsed ?? null,
    fallbackUsed: telemetry?.fallbackUsed ?? null,
    requestCount: telemetry?.providerRequestCount ?? null,
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
  if (/timeout|request failed|providerFailure|provider_request_failed/i.test(message)) {
    return new SmokeFailure("provider_request_failed", message);
  }
  if (/invalid|validation|unsupported provider|provider_validation_failed/i.test(message)) {
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
  return value === "provider_missing"
    || value === "provider_api_key_missing"
    || value === "provider_validation_failed"
    || value === "provider_request_failed"
    || value === "provider_mock_forbidden";
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
      ".git",
      ".mypy_cache",
      ".next",
      ".nox",
      ".nuxt",
      ".pytest_cache",
      ".ruff_cache",
      ".svelte-kit",
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
