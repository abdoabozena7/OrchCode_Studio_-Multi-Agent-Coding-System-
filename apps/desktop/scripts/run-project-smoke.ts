import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrimaryActivityItems, describeCurrentStep } from "../src/app/activityStream.ts";
import { loadConfig } from "../../agent-runtime/src/config.js";
import { buildServer } from "../../agent-runtime/src/server.js";

type SessionResponse = {
  sessionId: string;
  status: string;
};

async function main() {
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
    const gitOutsideRepoScenario = await runGitStatusOutsideRepoScenario(root);
    const gitInsideRepoScenario = await runGitStatusInsideRepoScenario(root);
    const riskyCommandScenario = await runRiskyCommandScenario(root);
    console.log(JSON.stringify({ ok: true, packageScenario, staticScenario, gitOutsideRepoScenario, gitInsideRepoScenario, riskyCommandScenario }, null, 2));
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
    const titles = items.map((item) => item.title);
    const requestedIndex = titles.findIndex((title) => title === "Command Requested");
    const startedIndex = titles.findIndex((title) => title === "Command Started");
    const completedIndex = titles.findIndex((title) => title === "Command Completed");
    const verificationIndex = titles.findIndex((title) => title === "Verification Passed");

    assert.equal(currentStep.title, "Run complete");
    assert.equal(requestedIndex >= 0, true);
    assert.equal(startedIndex > requestedIndex, true);
    assert.equal(completedIndex > startedIndex, true);
    assert.equal(verificationIndex > completedIndex, true);

    return {
      sessionStatus: session.status,
      runSummaryStatus: session.runSummary?.status,
      command: request.command,
      currentStep,
      activityTitles: titles
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

async function createWorkspace(label: string) {
  const workspace = path.join(os.tmpdir(), `hivo-desktop-smoke-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function createRuntimeSession(runtimeUrl: string, workspacePath: string): Promise<SessionResponse> {
  const response = await fetch(`${runtimeUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspacePath,
      mode: "demo_mock",
      accessProfile: "full_access",
      userPrompt: "run this project"
    })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<SessionResponse>;
}

async function runTurn(runtimeUrl: string, sessionId: string, message: string) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message })
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function getSession(runtimeUrl: string, sessionId: string) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}`);
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

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
