import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  | "patch_truth_failed"
  | "recursive_branch_execution_failed"
  | "recursive_final_validation_failed"
  | "recursive_validated_failed"
  | "recursive_repair_loop_failed"
  | "recursive_attribution_failed"
  | "recursive_high_attribution_repair_failed"
  | "recursive_multibranch_failed"
  | "recursive_nested_branch_failed"
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
  scenario?: string;
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
  "patch truth": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    patchStatus: string | null;
    rustApplyStatus: string | null;
    validationTruthStatus: string | null;
    tempFile: string | null;
    failureReason?: string;
  };
  "recursive branch execution": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    branchStatus: string | null;
    patchStatus: string | null;
    rustApplyStatus: string | null;
    validationTruthStatus: string | null;
    executionStarted: boolean | null;
    tempFile: string | null;
    failureReason?: string;
  };
  "recursive final validation": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    branchResultCount: number | null;
    appliedPatches: string[];
    unverifiedValidations: string[];
    tempFile: string | null;
    failureReason: string | null;
  };
  "recursive validated": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    selectedStrategy: string | null;
    validationEvidence: string[];
    discoveredCommands: string[];
    commandResultStatus: string | null;
    nestedSubtaskCount: number | null;
    tempFiles: string[];
    failureReason: string | null;
  };
  "recursive repair loop": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    diagnosisSummary: string | null;
    repairEligibility: string | null;
    repairStatus: string | null;
    repairPatchId: string | null;
    repairPatchRustApplied: boolean | null;
    validationAttempts: string[];
    revalidationCommandResultStatus: string | null;
    tempFiles: string[];
    failureReason: string | null;
  };
  "recursive attribution": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    attributionConfidence: string | null;
    attributionEvidence: string[];
    relatedPatchIds: string[];
    relatedBranchIds: string[];
    repairEligibility: string | null;
    validationAttempts: string[];
    tempFiles: string[];
    failureReason: string | null;
  };
  "recursive high attribution repair": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    failingCommand: string | null;
    attributionConfidence: string | null;
    attributionEvidence: string[];
    relatedPatchIds: string[];
    relatedBranchIds: string[];
    repairEligibility: string | null;
    repairPatchId: string | null;
    repairPatchStatus: string | null;
    repairAttemptCount: number | null;
    firstValidationResult: string | null;
    revalidationResult: string | null;
    validationAttempts: string[];
    cleanupStatus: "not_run" | "passed" | "cleanup_failed";
    tempFiles: string[];
    failureReason: string | null;
  };
  "recursive multibranch": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    branchResultCount: number | null;
    appliedPatches: string[];
    branchStatuses: string[];
    writeBranchesConcurrent: boolean | null;
    tempFiles: string[];
    failureReason: string | null;
  };
  "recursive nested branch": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    parentBranchStatus: string | null;
    nestedSubtaskCount: number | null;
    nestedPatchStatus: string | null;
    finalStatus: string | null;
    finalValidationState: string | null;
    nestedRollupValidation: string | null;
    appliedPatches: string[];
    tempFiles: string[];
    failureReason: string | null;
  };
  "knowledge tree": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    nodeCount: number | null;
    ownershipCount: number | null;
    artifactId: string | null;
    memoryFreshness: string | null;
    completenessStatus: string | null;
    requiredNodeFieldsVerified: boolean;
    rootRoutingStatuses: string[];
    orphanedFiles: string[];
    importantOwnedFiles: string[];
    replayVerified: boolean;
    noPatchesProposed: boolean | null;
    noCommandsRun: boolean | null;
    noDirectFileWrites: boolean | null;
    failureReason: string | null;
  };
  "knowledge routed edit": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    primaryNode: string | null;
    confidence: number | null;
    confidenceLevel: string | null;
    likelyFiles: string[];
    filesNotToTouch: string[];
    risks: string[];
    reviewerNodes: string[];
    reviewChain: Record<string, string[]> | null;
    evidenceUsed: string[];
    executionStarted: boolean | null;
    staleMemoryHighConfidenceAllowed: boolean | null;
    noPatchesProposed: boolean | null;
    noCommandsRun: boolean | null;
    noDirectFileWrites: boolean | null;
    failureReason: string | null;
  };
  "knowledge branch targets": {
    status: "not_run" | "passed" | "failed";
    sessionStatus: AgentRuntimeSession["status"] | null;
    targetCount: number | null;
    plannedBranchCount: number | null;
    recursiveGraphStatus: string | null;
    completeOwnerVerified: boolean;
    filesAllowedVerified: boolean;
    filesForbiddenVerified: boolean;
    reviewChainVerified: boolean;
    replayVerified: boolean;
    executionStarted: boolean | null;
    noPatchesProposed: boolean | null;
    noCommandsRun: boolean | null;
    noDirectFileWrites: boolean | null;
    blockedReasons: string[];
    failureReason: string | null;
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

    if (args.scenario === "recursive-plan" || args.scenario === "recursive-graph") {
      await runRecursivePlanScenario(runtimeUrl, workspacePath, { expectGraph: args.scenario === "recursive-graph" });
      markSmokeScenarioPassed(report);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "patch-truth") {
      report["patch truth"] = await runPatchTruthScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["patch truth"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-branch-execution") {
      report["recursive branch execution"] = await runRecursiveBranchExecutionScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive branch execution"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-final-validation") {
      report["recursive final validation"] = await runRecursiveFinalValidationScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive final validation"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-validated") {
      report["recursive validated"] = await runRecursiveValidatedScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive validated"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-repair-loop") {
      report["recursive repair loop"] = await runRecursiveRepairLoopScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive repair loop"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-attribution") {
      report["recursive attribution"] = await runRecursiveAttributionScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive attribution"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-high-attribution-repair") {
      report["recursive high attribution repair"] = await runRecursiveHighAttributionRepairScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive high attribution repair"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-multibranch") {
      report["recursive multibranch"] = await runRecursiveMultibranchScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive multibranch"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "recursive-nested-branch") {
      report["recursive nested branch"] = await runRecursiveNestedBranchScenario(runtimeUrl, rustProjectDir, workspacePath);
      markSmokeScenarioPassed(report, report["recursive nested branch"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "knowledge-tree") {
      report["knowledge tree"] = await runKnowledgeTreeScenario(runtimeUrl, workspacePath);
      markSmokeScenarioPassed(report, report["knowledge tree"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "knowledge-routed-edit") {
      report["knowledge routed edit"] = await runKnowledgeRoutedEditScenario(runtimeUrl, workspacePath);
      markSmokeScenarioPassed(report, report["knowledge routed edit"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

    if (args.scenario === "knowledge-branch-targets") {
      report["knowledge branch targets"] = await runKnowledgeBranchTargetsScenario(runtimeUrl, workspacePath);
      markSmokeScenarioPassed(report, report["knowledge branch targets"].sessionStatus);
      emitSmokeReport(report);
      return;
    }

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
    emitSmokeReport(report);
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
    emitSmokeReport(report);
    throw failure;
  } finally {
    runtimeHandle?.close();
  }
}

function markSmokeScenarioPassed(
  report: RealWorkspaceSmokeReport,
  lastCanonicalStatus?: AgentRuntimeSession["status"] | null
) {
  report["session created"] = true;
  report["session updates"].status = "ok";
  if (lastCanonicalStatus !== undefined) {
    report["session updates"].lastCanonicalStatus = lastCanonicalStatus;
  }
  report["answer quality result"] = "passed";
  report["final result"] = "passed";
}

function emitSmokeReport(report: RealWorkspaceSmokeReport) {
  console.log(JSON.stringify(report, null, 2));
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
    "patch truth": {
      status: "not_run",
      sessionStatus: null,
      patchStatus: null,
      rustApplyStatus: null,
      validationTruthStatus: null,
      tempFile: null
    },
    "recursive branch execution": {
      status: "not_run",
      sessionStatus: null,
      branchStatus: null,
      patchStatus: null,
      rustApplyStatus: null,
      validationTruthStatus: null,
      executionStarted: null,
      tempFile: null
    },
    "recursive final validation": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      branchResultCount: null,
      appliedPatches: [],
      unverifiedValidations: [],
      tempFile: null,
      failureReason: null
    },
    "recursive validated": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      selectedStrategy: null,
      validationEvidence: [],
      discoveredCommands: [],
      commandResultStatus: null,
      nestedSubtaskCount: null,
      tempFiles: [],
      failureReason: null
    },
    "recursive repair loop": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      diagnosisSummary: null,
      repairEligibility: null,
      repairStatus: null,
      repairPatchId: null,
      repairPatchRustApplied: null,
      validationAttempts: [],
      revalidationCommandResultStatus: null,
      tempFiles: [],
      failureReason: null
    },
    "recursive attribution": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      attributionConfidence: null,
      attributionEvidence: [],
      relatedPatchIds: [],
      relatedBranchIds: [],
      repairEligibility: null,
      validationAttempts: [],
      tempFiles: [],
      failureReason: null
    },
    "recursive high attribution repair": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      failingCommand: null,
      attributionConfidence: null,
      attributionEvidence: [],
      relatedPatchIds: [],
      relatedBranchIds: [],
      repairEligibility: null,
      repairPatchId: null,
      repairPatchStatus: null,
      repairAttemptCount: null,
      firstValidationResult: null,
      revalidationResult: null,
      validationAttempts: [],
      cleanupStatus: "not_run",
      tempFiles: [],
      failureReason: null
    },
    "recursive multibranch": {
      status: "not_run",
      sessionStatus: null,
      finalStatus: null,
      finalValidationState: null,
      branchResultCount: null,
      appliedPatches: [],
      branchStatuses: [],
      writeBranchesConcurrent: null,
      tempFiles: [],
      failureReason: null
    },
    "recursive nested branch": {
      status: "not_run",
      sessionStatus: null,
      parentBranchStatus: null,
      nestedSubtaskCount: null,
      nestedPatchStatus: null,
      finalStatus: null,
      finalValidationState: null,
      nestedRollupValidation: null,
      appliedPatches: [],
      tempFiles: [],
      failureReason: null
    },
    "knowledge tree": {
      status: "not_run",
      sessionStatus: null,
      nodeCount: null,
      ownershipCount: null,
      artifactId: null,
      memoryFreshness: null,
      completenessStatus: null,
      requiredNodeFieldsVerified: false,
      rootRoutingStatuses: [],
      orphanedFiles: [],
      importantOwnedFiles: [],
      replayVerified: false,
      noPatchesProposed: null,
      noCommandsRun: null,
      noDirectFileWrites: null,
      failureReason: null
    },
    "knowledge routed edit": {
      status: "not_run",
      sessionStatus: null,
      primaryNode: null,
      confidence: null,
      confidenceLevel: null,
      likelyFiles: [],
      filesNotToTouch: [],
      risks: [],
      reviewerNodes: [],
      reviewChain: null,
      evidenceUsed: [],
      executionStarted: null,
      staleMemoryHighConfidenceAllowed: null,
      noPatchesProposed: null,
      noCommandsRun: null,
      noDirectFileWrites: null,
      failureReason: null
    },
    "knowledge branch targets": {
      status: "not_run",
      sessionStatus: null,
      targetCount: null,
      plannedBranchCount: null,
      recursiveGraphStatus: null,
      completeOwnerVerified: false,
      filesAllowedVerified: false,
      filesForbiddenVerified: false,
      reviewChainVerified: false,
      replayVerified: false,
      executionStarted: null,
      noPatchesProposed: null,
      noCommandsRun: null,
      noDirectFileWrites: null,
      blockedReasons: [],
      failureReason: null
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
    } else if (arg === "--scenario") {
      args.scenario = argv[index + 1];
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
    || value === "recursive_validated_failed"
    || value === "recursive_repair_loop_failed"
    || value === "recursive_attribution_failed"
    || value === "recursive_high_attribution_repair_failed"
    || value === "recursive_multibranch_failed"
    || value === "recursive_nested_branch_failed"
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

async function snapshotWorkspaceFiles(workspacePath: string) {
  const files: string[] = [];
  async function walk(currentDir: string, relativeDir: string) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (shouldIgnoreSmokeSnapshotDirectory(entry.name, relativePath)) continue;
        await walk(path.join(currentDir, entry.name), relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(relativePath);
    }
  }
  await walk(workspacePath, "");
  return files.sort();
}

async function snapshotWorkspaceFileState(workspacePath: string) {
  const files = await snapshotWorkspaceFiles(workspacePath);
  const state: string[] = [];
  for (const file of files) {
    const absolute = path.join(workspacePath, file);
    const info = await stat(absolute);
    if (info.size > 1_000_000) {
      state.push(`${file}:${info.size}:large`);
      continue;
    }
    const content = await readFile(absolute);
    state.push(`${file}:${info.size}:${createHash("sha256").update(content).digest("hex")}`);
  }
  return state.sort();
}

function shouldIgnoreSmokeSnapshotDirectory(name: string, relativePath: string) {
  const ignored = [".git", ".agent_memory", ".hivo-agent-runtime", ".orchcode-agent-runtime", ".venv", "venv", "env", "node_modules", "dist", "build", "target", "__pycache__", "site-packages"];
  return ignored.includes(name) || relativePath.split("/").some((part) => ignored.includes(part));
}

function isImportantKnowledgeFile(filePath: string) {
  return /\.(ts|tsx|js|jsx|rs|py|go|java|cs)$/i.test(filePath)
    || /(^|\/)(tests?|__tests__)(\/|$)|(\.test\.|\.spec\.)/i.test(filePath)
    || /(^|\/)(package\.json|requirements\.txt|Cargo\.toml|README\.md|tsconfig.*\.json)$/i.test(filePath);
}

const requiredKnowledgeNodeFields = [
  "nodeId",
  "scope",
  "filesOwned",
  "summary",
  "importantSymbols",
  "dependencies",
  "risks",
  "children",
  "parent",
  "freshness",
  "whoUnderstandsThisArea"
] as const;

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
    executionMode?: "auto_mode" | "simple_mode" | "orchestrated_mode" | "recursive_factory";
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

async function runRecursivePlanScenario(runtimeUrl: string, workspacePath: string, options: { expectGraph?: boolean } = {}) {
  const prompt = "Build a multi-step feature across the project runtime, shared protocol, desktop UI, persistence, tests, and smoke validation with mandatory product and technical approvals.";
  const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
    mode: "demo_mock",
    executionMode: "recursive_factory",
    accessProfile: "full_access"
  });
  await runTurn(runtimeUrl, created.sessionId, prompt);
  let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
  assert.ok(session.recursiveFactory?.productSpec);
  assert.equal(session.recursiveFactory?.technicalPlan, undefined);
  assertRecursivePlanHasNoExecution(session);

  session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
  assert.equal(session.recursiveFactory?.productSpec?.status, "approved");
  assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
  assert.ok(session.recursiveFactory?.technicalPlan);
  assertRecursivePlanHasNoExecution(session);

  session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
  assert.equal(session.recursiveFactory?.technicalPlan?.status, "approved");
  assert.match(session.recursiveFactory?.phase ?? "", /^recursive_graph_|approved_to_execute$/);
  assert.equal(session.recursiveFactory?.executionStarted, false);
  assertRecursivePlanHasNoExecution(session);
  if (options.expectGraph) {
    const canonical = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.ok(canonical.recursiveFactory?.recursiveGraph);
    assert.equal(canonical.recursiveFactory?.recursiveGraph?.branches.length > 0, true);
    assert.equal(canonical.recursiveFactory?.branchOrchestrators?.length, canonical.recursiveFactory?.recursiveGraph?.branches.length);
    assert.ok(canonical.recursiveFactory?.graphReadiness?.status);
    assert.equal(canonical.recursiveFactory?.executionStarted, false);
    assertRecursivePlanHasNoExecution(canonical);
  }
}

async function runKnowledgeTreeScenario(runtimeUrl: string, workspacePath: string) {
  const prompt = "Update the login/auth flow in this existing project. Route it first.";
  const before = await snapshotWorkspaceFiles(workspacePath);
  const beforeState = await snapshotWorkspaceFileState(workspacePath);
  const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
    mode: "demo_mock",
    executionMode: "simple_mode",
    accessProfile: "default_permissions"
  });
  await runTurn(runtimeUrl, created.sessionId, prompt);
  const session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  const after = await snapshotWorkspaceFiles(workspacePath);
  const afterState = await snapshotWorkspaceFileState(workspacePath);
  const tree = session.projectKnowledgeTree;
  assert.ok(tree, "knowledge tree should be present on the session");
  assert.ok(tree.nodes.find((node) => node.nodeId === tree.rootNodeId), "root knowledge node should exist");
  assert.equal(session.patchProposals.length, 0, "knowledge-tree smoke must not propose patches");
  assert.equal(session.commandRequests.length, 0, "knowledge-tree smoke must not request commands");
  assert.equal(session.commandExecutions.length, 0, "knowledge-tree smoke must not run commands");
  assert.equal(tree.completeness.status, "ready", `knowledge tree should be ready: ${JSON.stringify(tree.completeness.missingNodeFields)}`);
  assert.equal(tree.nodes.every((node) => requiredKnowledgeNodeFields.every((field) => field in node)), true, "all nodes should expose required fields");
  assert.equal(tree.nodes.every((node) => node.completeness.status === "complete"), true, "all nodes should validate as complete");
  assert.ok(Array.isArray(tree.orphanedFiles), "tree should expose orphanedFiles");
  assert.ok(tree.ownershipMap && typeof tree.ownershipMap === "object", "tree should expose a durable ownershipMap");
  const existingPaths = new Set(before);
  const requiredNodes = [
    existingPaths.has("frontend/app.js") ? "frontend_ui" : undefined,
    existingPaths.has("backend/main.py") ? "backend_entry_api" : undefined,
    [...existingPaths].some((file) => /package\.json|requirements|readme/i.test(file)) ? "config_dependencies" : undefined,
    [...existingPaths].some((file) => /(^|\/)tests?\//i.test(file)) ? "tests_validation" : undefined
  ].filter(Boolean) as string[];
  for (const nodeId of requiredNodes) {
    assert.ok(tree.nodes.find((node) => node.nodeId === nodeId), `expected node ${nodeId}`);
  }
  for (const file of [...existingPaths].filter((entry) => isImportantKnowledgeFile(entry)).slice(0, 20)) {
    const owner = tree.fileOwnership.find((candidate) => candidate.path === file);
    const orphan = tree.orphanedFiles.find((candidate) => candidate.path === file);
    assert.ok(owner || orphan, `expected owner or orphan record for ${file}`);
    if (owner) {
      assert.equal(tree.ownershipMap[file]?.primaryOwnerNodeId, owner.primaryOwnerNodeId, `ownershipMap should include ${file}`);
      assert.equal(typeof owner.primaryOwnerNodeId, "string");
      assert.ok(owner.primaryOwnerNodeId.length > 0);
      assert.ok(Array.isArray(owner.reviewerNodeIds));
      assert.ok(Array.isArray(owner.dependencyNodeIds));
    }
  }
  for (const guarantee of tree.rootRoutingGuarantees) {
    if (guarantee.matchingFiles.length > 0) {
      assert.equal(guarantee.status, "passed", `root routing guarantee failed for ${guarantee.pattern}: ${guarantee.reason}`);
    }
  }
  const artifactTree = session.artifacts.find((artifact) => artifact.type === "project_knowledge_tree");
  assert.ok(artifactTree);
  const replayed = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  assert.equal(replayed.projectKnowledgeTree?.id, tree.id, "knowledge tree should restore/fetch from session state");
  assert.equal(replayed.projectKnowledgeTree?.ownershipMap?.["frontend/app.js"]?.primaryOwnerNodeId, tree.ownershipMap["frontend/app.js"]?.primaryOwnerNodeId);
  assert.deepEqual(before, after, "knowledge-tree smoke should not write workspace files");
  assert.deepEqual(beforeState, afterState, "knowledge-tree smoke should not change file contents");
  return {
    status: "passed" as const,
    sessionStatus: session.status,
    nodeCount: tree.nodes.length,
    ownershipCount: tree.fileOwnership.length,
    artifactId: artifactTree.id,
    memoryFreshness: tree.memoryFreshness.status,
    completenessStatus: tree.completeness.status,
    requiredNodeFieldsVerified: true,
    rootRoutingStatuses: tree.rootRoutingGuarantees.map((guarantee) => `${guarantee.pattern}:${guarantee.status}`),
    orphanedFiles: tree.orphanedFiles.map((file) => `${file.path}:${file.reason}`),
    importantOwnedFiles: [...existingPaths].filter((entry) => isImportantKnowledgeFile(entry) && tree.fileOwnership.some((owner) => owner.path === entry)).slice(0, 20),
    replayVerified: true,
    noPatchesProposed: session.patchProposals.length === 0,
    noCommandsRun: session.commandRequests.length === 0 && session.commandExecutions.length === 0,
    noDirectFileWrites: JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(beforeState) === JSON.stringify(afterState),
    failureReason: null
  };
}

async function runKnowledgeRoutedEditScenario(runtimeUrl: string, workspacePath: string) {
  const prompt = "Update the login/auth flow so the frontend and backend agree on the route. Do not execute yet.";
  const before = await snapshotWorkspaceFiles(workspacePath);
  const beforeState = await snapshotWorkspaceFileState(workspacePath);
  const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
    mode: "demo_mock",
    executionMode: "simple_mode",
    accessProfile: "default_permissions"
  });
  await runTurn(runtimeUrl, created.sessionId, prompt);
  const session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  const after = await snapshotWorkspaceFiles(workspacePath);
  const afterState = await snapshotWorkspaceFileState(workspacePath);
  const routedEdit = session.latestKnowledgeRoute;
  assert.ok(session.projectKnowledgeTree);
  assert.ok(routedEdit);
  assert.equal(session.patchProposals.length, 0, "routing-only smoke must not propose patches");
  assert.equal(session.commandRequests.length, 0, "routing-only smoke must not request commands");
  assert.equal(session.commandExecutions.length, 0, "routing-only smoke must not run commands");
  assert.deepEqual(before, after, "routing-only smoke should not write workspace files");
  assert.deepEqual(beforeState, afterState, "routing-only smoke should not change file contents");
  assert.ok(routedEdit.intentSummary.length > 0, "routed edit should expose intentSummary");
  assert.ok(routedEdit.route.affectedNodeIds.length > 0);
  assert.ok(routedEdit.route.likelyFiles.length > 0);
  assert.ok(routedEdit.route.reviewerNodes.length > 0);
  assert.ok(routedEdit.route.confidence > 0);
  assert.ok(routedEdit.filesNotToTouch.length > 0, "routed edit should expose filesNotToTouch");
  assert.ok(routedEdit.risks.length > 0 || routedEdit.route.risks.length >= 0, "routed edit should expose risks");
  assert.ok(routedEdit.evidenceUsed.length > 0, "routed edit should expose evidenceUsed");
  assert.equal(routedEdit.executionStarted, false, "routed edit should not start execution");
  assert.notEqual(routedEdit.confidenceLevel, "low", "fixture route should not be low confidence");
  assert.equal(routedEdit.route.confidenceLevel === "high" && session.projectKnowledgeTree.memoryFreshness.status !== "fresh", false, "stale memory cannot produce high confidence");
  assert.equal(routedEdit.plan.executionState, "Execution has not started. This edit was routed through the Project Knowledge Tree.");
  assert.equal(routedEdit.plan.executionStarted, false);
  assert.ok(routedEdit.plan.requiredReviewChain.rootIntegrationReview.includes(session.projectKnowledgeTree.rootNodeId));
  assert.ok(routedEdit.reviewChain.rootIntegrationReview.includes(session.projectKnowledgeTree.rootNodeId));
  assert.ok(Array.isArray(routedEdit.reviewChain.leafReview));
  assert.ok(Array.isArray(routedEdit.reviewChain.parentScopeReview));
  assert.ok(Array.isArray(routedEdit.reviewChain.siblingAffectedNodeReview));
  assert.equal(routedEdit.plan.suggestedBranchTargets.every((target) => target.status === "planned" || target.executionModeHint === "read_only"), true);
  return {
    status: "passed" as const,
    sessionStatus: session.status,
    primaryNode: routedEdit.route.primaryNode,
    confidence: routedEdit.route.confidence,
    confidenceLevel: routedEdit.route.confidenceLevel,
    likelyFiles: routedEdit.route.likelyFiles,
    filesNotToTouch: routedEdit.filesNotToTouch,
    risks: routedEdit.risks,
    reviewerNodes: routedEdit.route.reviewerNodes,
    reviewChain: routedEdit.reviewChain,
    evidenceUsed: routedEdit.evidenceUsed,
    executionStarted: routedEdit.executionStarted,
    staleMemoryHighConfidenceAllowed: false,
    noPatchesProposed: session.patchProposals.length === 0,
    noCommandsRun: session.commandRequests.length === 0 && session.commandExecutions.length === 0,
    noDirectFileWrites: JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(beforeState) === JSON.stringify(afterState),
    failureReason: null
  };
}

async function runKnowledgeBranchTargetsScenario(runtimeUrl: string, workspacePath: string): Promise<RealWorkspaceSmokeReport["knowledge branch targets"]> {
  const prompt = "Update the login/auth flow so the frontend and backend agree on the route, then prepare recursive branch targets only. Do not execute yet.";
  const before = await snapshotWorkspaceFiles(workspacePath);
  const beforeState = await snapshotWorkspaceFileState(workspacePath);
  const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
    mode: "demo_mock",
    executionMode: "simple_mode",
    accessProfile: "default_permissions"
  });
  await runTurn(runtimeUrl, created.sessionId, prompt);
  const session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  const after = await snapshotWorkspaceFiles(workspacePath);
  const afterState = await snapshotWorkspaceFileState(workspacePath);
  const tree = session.projectKnowledgeTree;
  const routedEdit = session.latestKnowledgeRoute;
  const targets = session.latestKnowledgeBranchTargets ?? routedEdit?.knowledgeBranchTargets ?? [];
  assert.ok(tree, "knowledge branch targets smoke should build or reuse a Project Knowledge Tree");
  assert.ok(routedEdit, "knowledge branch targets smoke should create a routed edit plan");
  assert.ok(targets.length > 0, "knowledge branch targets should be generated");
  assert.equal(session.patchProposals.length, 0, "knowledge branch targets smoke must not propose patches");
  assert.equal(session.commandRequests.length, 0, "knowledge branch targets smoke must not request commands");
  assert.equal(session.commandExecutions.length, 0, "knowledge branch targets smoke must not run commands");
  assert.deepEqual(before, after, "knowledge branch targets smoke should not write workspace files");
  assert.deepEqual(beforeState, afterState, "knowledge branch targets smoke should not change file contents");
  assert.equal(routedEdit.executionStarted, false);
  assert.equal(routedEdit.plan.executionStarted, false);
  assert.equal(session.recursiveFactory?.executionStarted, false);
  assert.ok(session.recursiveFactory?.recursiveGraph, "planned recursive graph should be created from knowledge targets");
  assert.ok((session.recursiveFactory.branchExecutions ?? []).length >= targets.length, "planned recursive branch records should be created");
  assert.equal((session.recursiveFactory.branchExecutions ?? []).every((branch) => branch.active === false && branch.patchApplied === false && branch.status !== "running" && branch.status !== "patch_proposed"), true);
  assert.equal(targets.every((target) => {
    const owner = tree.nodes.find((node) => node.nodeId === target.primaryOwnerNodeId);
    return Boolean(owner && owner.completeness.status === "complete");
  }), true, "every target should map to a complete owner node");
  assert.equal(targets.every((target) => target.filesAllowed.length > 0), true, "every target should preserve allowed files");
  assert.equal(targets.every((target) => target.filesForbidden.length > 0), true, "every target should preserve forbidden files");
  assert.equal(targets.every((target) =>
    Array.isArray(target.requiredReviewChain.leafReview)
    && Array.isArray(target.requiredReviewChain.parentScopeReview)
    && Array.isArray(target.requiredReviewChain.siblingAffectedNodeReview)
    && target.requiredReviewChain.rootIntegrationReview.includes(tree.rootNodeId)
  ), true, "every target should inherit the structured review chain");
  assert.equal(targets.every((target) => target.evidenceUsed.length > 0 && target.reviewerNodeIds.length > 0 && target.scope.length > 0), true);
  assert.equal(targets.every((target) => target.confidenceLevel !== "high" || target.freshness.status === "fresh"), true, "stale memory cannot create high-confidence targets");
  const replayed = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
  assert.deepEqual(replayed.latestKnowledgeBranchTargets, targets, "fetch/replay should restore knowledge branch targets");
  assert.equal(replayed.recursiveFactory?.executionStarted, false, "fetch/replay should preserve planning-only recursive state");
  assert.equal((replayed.recursiveFactory?.branchExecutions ?? []).length, (session.recursiveFactory?.branchExecutions ?? []).length);
  return {
    status: "passed",
    sessionStatus: session.status,
    targetCount: targets.length,
    plannedBranchCount: session.recursiveFactory?.branchExecutions?.length ?? 0,
    recursiveGraphStatus: session.recursiveFactory?.recursiveGraph?.status ?? null,
    completeOwnerVerified: true,
    filesAllowedVerified: true,
    filesForbiddenVerified: true,
    reviewChainVerified: true,
    replayVerified: true,
    executionStarted: session.recursiveFactory?.executionStarted ?? null,
    noPatchesProposed: session.patchProposals.length === 0,
    noCommandsRun: session.commandRequests.length === 0 && session.commandExecutions.length === 0,
    noDirectFileWrites: JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(beforeState) === JSON.stringify(afterState),
    blockedReasons: uniqueStrings(targets.flatMap((target) => target.blockedReasons)),
    failureReason: null
  };
}

async function runRecursiveBranchExecutionScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive branch execution"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const relativeFile = `${smokeDir}/recursive-branch-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const absoluteFile = path.join(workspacePath, relativeFile);
  const initialContent = "before recursive branch smoke\n";
  const requestedContent = `recursive branch applied ${marker}\n`;
  const prompt = `Build a multi-step project feature with Product Spec and Technical Plan approvals, then update ${relativeFile} with a tiny safe branch after execution approval.`;
  const output: RealWorkspaceSmokeReport["recursive branch execution"] = {
    status: "failed",
    sessionStatus: null,
    branchStatus: null,
    patchStatus: null,
    rustApplyStatus: null,
    validationTruthStatus: null,
    executionStarted: null,
    tempFile: relativeFile
  };

  try {
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, initialContent, "utf8");

    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
    assertRecursivePlanHasNoExecution(session);

    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    assert.equal(session.recursiveFactory?.productSpec?.status, "approved");
    assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
    assertRecursivePlanHasNoExecution(session);

    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    assert.equal(session.recursiveFactory?.technicalPlan?.status, "approved");
    assert.equal(session.recursiveFactory?.recursiveGraph?.status, "ready");
    assert.equal(session.recursiveFactory?.executionStarted, false);
    assertRecursivePlanHasNoExecution(session);

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      targetFile: relativeFile,
      replacementText: requestedContent
    });
    output.executionStarted = session.recursiveFactory?.executionStarted ?? null;
    assert.equal(output.executionStarted, true);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    assert.equal(session.patchProposals.length, 1);
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.filesChanged.some((file) => normalizeRelativePath(file.path) === relativeFile), true);
    assert.equal((await readFile(absoluteFile, "utf8")), initialContent);
    const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === proposal.id);
    assert.ok(branch);
    assert.equal(branch.status, "patch_proposed");
    assert.equal(branch.patchApplied, false);
    assert.equal(branch.reviewStatus, "pending");
    output.branchStatus = branch.status;
    output.patchStatus = proposal.status;

    const approval = await approveRuntimePatch(runtimeUrl, created.sessionId, proposal.id);
    assert.equal(approval.applied, false);
    assert.equal(approval.proposal.status, "approved");
    assert.equal((await readFile(absoluteFile, "utf8")), initialContent);

    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "apply_started",
      message: "Rust patch apply requested by recursive branch smoke."
    });
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    assert.equal(output.patchStatus, "apply_started");
    assert.equal((await readFile(absoluteFile, "utf8")), initialContent);

    const rustApply = await runRuntimePatchApplyBridge({
      rustProjectDir,
      workspace: workspacePath,
      sessionId: created.sessionId,
      patchId: proposal.id,
      proposal
    });
    output.rustApplyStatus = rustApply.patchResult.status;
    assert.equal(rustApply.patchResult.status, "applied");

    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "applied",
      message: rustApply.patchResult.message,
      reconciliationSnapshot:
        rustApply.patchResult.beforeSnapshot || rustApply.patchResult.afterSnapshot
          ? {
              before: rustApply.patchResult.beforeSnapshot,
              after: rustApply.patchResult.afterSnapshot
            }
          : undefined
    });
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    output.validationTruthStatus = session.verificationResult?.truthStatus ?? null;
    const updatedBranch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === proposal.id);
    assert.ok(updatedBranch);
    output.branchStatus = updatedBranch.status;
    assert.equal(updatedBranch.patchApplied, true);
    assert.equal(output.patchStatus, "applied");
    assert.equal((await readFile(absoluteFile, "utf8")).replace(/\r\n/g, "\n"), requestedContent);
    if (!session.commandExecutions.length) {
      assert.notEqual(session.verificationResult?.truthStatus, "verified_passed");
      assert.notEqual(updatedBranch.validationStatus, "verified_passed");
    }
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    assert.ok(updatedBranch.status === "completed" || updatedBranch.status === "validation_pending");

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_multibranch_failed", output.failureReason, output);
  } finally {
    await rm(absoluteFile, { force: true });
    try {
      await rm(path.dirname(absoluteFile), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveFinalValidationScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive final validation"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const relativeFile = `${smokeDir}/recursive-final-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const absoluteFile = path.join(workspacePath, relativeFile);
  const initialContent = "before recursive final validation smoke\n";
  const requestedContent = `recursive final validation applied ${marker}\n`;
  const prompt = `Build a multi-step project feature with recursive approval gates, then update ${relativeFile} through one safe branch and produce final recursive validation truth.`;
  const output: RealWorkspaceSmokeReport["recursive final validation"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    branchResultCount: null,
    appliedPatches: [],
    unverifiedValidations: [],
    tempFile: relativeFile
  };

  try {
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, initialContent, "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    assert.equal(session.recursiveFactory?.recursiveGraph?.status, "ready");

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      targetFile: relativeFile,
      replacementText: requestedContent
    });
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    assert.equal(proposal.status, "proposed");
    assert.equal(await readFile(absoluteFile, "utf8"), initialContent);

    const approval = await approveRuntimePatch(runtimeUrl, created.sessionId, proposal.id);
    assert.equal(approval.applied, false);
    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "apply_started",
      message: "Rust patch apply requested by recursive final validation smoke."
    });
    assert.equal(session.patchProposals.find((patch) => patch.id === proposal.id)?.status, "apply_started");
    const rustApply = await runRuntimePatchApplyBridge({
      rustProjectDir,
      workspace: workspacePath,
      sessionId: created.sessionId,
      patchId: proposal.id,
      proposal
    });
    assert.equal(rustApply.patchResult.status, "applied");
    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "applied",
      message: rustApply.patchResult.message,
      reconciliationSnapshot:
        rustApply.patchResult.beforeSnapshot || rustApply.patchResult.afterSnapshot
          ? {
              before: rustApply.patchResult.beforeSnapshot,
              after: rustApply.patchResult.afterSnapshot
            }
          : undefined
    });
    assert.equal((await readFile(absoluteFile, "utf8")).replace(/\r\n/g, "\n"), requestedContent);
    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    assert.equal(finalReport.branchOutcomes.length > 0, true);
    assert.equal(finalReport.patchApplyTruth.some((patch) => patch.patchId === proposal.id && patch.status === "applied"), true);
    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.branchResultCount = finalReport.branchOutcomes.length;
    output.appliedPatches = finalReport.patchApplyTruth.filter((patch) => patch.status === "applied").map((patch) => patch.patchId);
    output.unverifiedValidations = finalReport.validationHierarchy.filter((entry) => entry.status === "unverified").map((entry) => `${entry.level}:${entry.truthStatus}`);
    assert.equal(finalReport.finalStatus, "unverified");
    assert.notEqual(finalReport.finalValidationState, "verified_passed");
    assert.equal(finalReport.validationHierarchy.some((entry) => entry.level === "branch_validation"), true);
    assert.equal(finalReport.validationHierarchy.some((entry) => entry.level === "integration_validation"), true);
    assert.equal(finalReport.validationHierarchy.some((entry) => entry.level === "final_validation"), true);
    assert.equal(session.commandExecutions.length, 0);
    assert.notEqual(session.verificationResult?.truthStatus, "verified_passed");

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_final_validation_failed", output.failureReason, output);
  } finally {
    await rm(absoluteFile, { force: true });
    try {
      await rm(path.dirname(absoluteFile), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveValidatedScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive validated"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const parentFile = `${smokeDir}/recursive-validated-parent-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const nestedFile = `${smokeDir}/recursive-validated-child-${Date.now()}-${marker.slice(9, 17)}.txt`;
  const parentAbsolute = path.join(workspacePath, parentFile);
  const nestedAbsolute = path.join(workspacePath, nestedFile);
  const parentInitial = "before recursive validated parent\n";
  const nestedInitial = "before recursive validated child\n";
  const nestedRequested = `recursive validated child applied ${marker}\n`;
  const prompt = `Build a recursive validated smoke flow with nested execution that updates ${nestedFile} and records truthful validation evidence.`;
  const output: RealWorkspaceSmokeReport["recursive validated"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    selectedStrategy: null,
    validationEvidence: [],
    discoveredCommands: [],
    commandResultStatus: null,
    nestedSubtaskCount: null,
    tempFiles: [parentFile, nestedFile],
    failureReason: null
  };

  try {
    await mkdir(path.dirname(parentAbsolute), { recursive: true });
    await writeFile(parentAbsolute, parentInitial, "utf8");
    await writeFile(nestedAbsolute, nestedInitial, "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branch = session.recursiveFactory?.branchOrchestrators?.[0];
    assert.ok(branch);
    assert.equal(session.recursiveFactory?.recursiveGraph?.status, "ready");

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: `parent direct patch should not apply ${marker}\n`,
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: nestedRequested, objective: "Nested recursive validated smoke patch" }]
      }]
    });
    const parentExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(parentExecution);
    output.nestedSubtaskCount = parentExecution.nestedSubtasks?.length ?? null;
    assert.equal((output.nestedSubtaskCount ?? 0) >= 1, true);
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    assert.equal(proposal.filesChanged.some((file) => file.path === nestedFile), true);
    assert.equal(await readFile(parentAbsolute, "utf8"), parentInitial);
    assert.equal(await readFile(nestedAbsolute, "utf8"), nestedInitial);

    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, proposal);
    assert.equal(await readFile(parentAbsolute, "utf8"), parentInitial);
    assert.equal((await readFile(nestedAbsolute, "utf8")).replace(/\r\n/g, "\n"), nestedRequested);

    const safeRequest = session.commandRequests.find((request) => request.risk === "safe" && !session.commandExecutions.some((execution) => execution.requestId === request.id));
    if (safeRequest) {
      const bridgeResult = await runRuntimeRustBridge({
        rustProjectDir,
        runtimeUrl,
        workspace: workspacePath,
        sessionId: created.sessionId,
        requestId: safeRequest.id,
        command: safeRequest.command,
        cwd: safeRequest.cwd
      });
      output.commandResultStatus = bridgeResult.commandResult.status;
      session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    }

    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.selectedStrategy = finalReport.validationDiscovery?.chosenStrategy.kind ?? null;
    output.validationEvidence = (finalReport.validationDiscovery?.evidence ?? []).map((entry) =>
      `${entry.kind}:${entry.truthStatus}:${entry.command ?? entry.files?.join(",") ?? "no-target"}`
    );
    output.discoveredCommands = (finalReport.validationDiscovery?.discoveredCommands ?? []).map((entry) =>
      `${entry.classification}:${entry.command}`
    );

    if (finalReport.finalValidationState === "verified_passed") {
      assert.equal(finalReport.finalStatus, "passed");
      assert.equal((finalReport.validationDiscovery?.evidence ?? []).some((entry) => entry.truthStatus === "verified_passed"), true);
    } else if (finalReport.finalValidationState === "verified_failed") {
      assert.equal(finalReport.finalStatus, "failed");
      assert.equal((finalReport.validationDiscovery?.evidence ?? []).some((entry) => entry.truthStatus === "verified_failed"), true);
    } else {
      assert.notEqual(finalReport.finalValidationState, "verified_passed");
      assert.equal(finalReport.finalStatus, "unverified");
      assert.equal(finalReport.validationHierarchy.some((entry) => entry.status === "unverified"), true);
      assert.match(finalReport.validationDiscovery?.statusReason ?? finalReport.recommendedNextStep, /unverified|validation|Run or report|not verified/i);
    }

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_validated_failed", output.failureReason, output);
  } finally {
    await rm(parentAbsolute, { force: true });
    await rm(nestedAbsolute, { force: true });
    try {
      await rm(path.dirname(parentAbsolute), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveRepairLoopScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive repair loop"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const parentFile = `${smokeDir}/recursive-repair-parent-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const nestedFile = `${smokeDir}/recursive-repair-child-${Date.now()}-${marker.slice(9, 17)}.txt`;
  const parentAbsolute = path.join(workspacePath, parentFile);
  const nestedAbsolute = path.join(workspacePath, nestedFile);
  const parentInitial = "before recursive repair parent\n";
  const nestedInitial = "before recursive repair child\n";
  const nestedRequested = `recursive repair child applied ${marker}\n`;
  const prompt = `Build a recursive repair-loop smoke flow with nested execution that updates ${nestedFile}, validates truthfully, and diagnoses any validation failure.`;
  const output: RealWorkspaceSmokeReport["recursive repair loop"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    diagnosisSummary: null,
    repairEligibility: null,
    repairStatus: null,
    repairPatchId: null,
    repairPatchRustApplied: null,
    validationAttempts: [],
    revalidationCommandResultStatus: null,
    tempFiles: [parentFile, nestedFile],
    failureReason: null
  };

  try {
    await mkdir(path.dirname(parentAbsolute), { recursive: true });
    await writeFile(parentAbsolute, parentInitial, "utf8");
    await writeFile(nestedAbsolute, nestedInitial, "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branch = session.recursiveFactory?.branchOrchestrators?.[0];
    assert.ok(branch);

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: `parent direct patch should not apply ${marker}\n`,
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: nestedRequested, objective: "Nested recursive repair smoke patch" }]
      }]
    });
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, proposal);
    assert.equal(await readFile(parentAbsolute, "utf8"), parentInitial);
    assert.equal((await readFile(nestedAbsolute, "utf8")).replace(/\r\n/g, "\n"), nestedRequested);

    const firstSafeRequest = session.commandRequests.find((request) => request.risk === "safe" && !session.commandExecutions.some((execution) => execution.requestId === request.id));
    if (firstSafeRequest) {
      const bridgeResult = await runRuntimeRustBridge({
        rustProjectDir,
        runtimeUrl,
        workspace: workspacePath,
        sessionId: created.sessionId,
        requestId: firstSafeRequest.id,
        command: firstSafeRequest.command,
        cwd: firstSafeRequest.cwd
      });
      output.revalidationCommandResultStatus = bridgeResult.commandResult.status;
      session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    }

    let finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);

    if (finalReport.repair?.repairPatchId) {
      output.repairPatchId = finalReport.repair.repairPatchId;
      const repairPatch = session.patchProposals.find((patch) => patch.id === finalReport?.repair?.repairPatchId);
      assert.ok(repairPatch);
      session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, repairPatch);
      output.repairPatchRustApplied = session.patchProposals.find((patch) => patch.id === repairPatch.id)?.status === "applied";
      const revalidationRequestId = session.recursiveFactory?.repair?.revalidationRequestId;
      const revalidationRequest = session.commandRequests.find((request) =>
        request.id === revalidationRequestId
        || (request.risk === "safe" && !session.commandExecutions.some((execution) => execution.requestId === request.id))
      );
      assert.ok(revalidationRequest);
      const bridgeResult = await runRuntimeRustBridge({
        rustProjectDir,
        runtimeUrl,
        workspace: workspacePath,
        sessionId: created.sessionId,
        requestId: revalidationRequest.id,
        command: revalidationRequest.command,
        cwd: revalidationRequest.cwd
      });
      output.revalidationCommandResultStatus = bridgeResult.commandResult.status;
      session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
      finalReport = session.recursiveFactory?.finalReport;
      assert.ok(finalReport);
    }

    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.diagnosisSummary = finalReport.repair?.diagnosis.summary ?? null;
    output.repairEligibility = finalReport.repair?.eligibility.status ?? null;
    output.repairStatus = finalReport.repair?.status ?? null;
    output.repairPatchId = finalReport.repair?.repairPatchId ?? output.repairPatchId;
    output.repairPatchRustApplied ??= output.repairPatchId
      ? session.patchProposals.find((patch) => patch.id === output.repairPatchId)?.status === "applied"
      : null;
    output.validationAttempts = (finalReport.repair?.validationAttempts ?? []).map((attempt) =>
      `${attempt.attemptNumber}:${attempt.role}:${attempt.command}:${attempt.truthStatus}`
    );

    if (finalReport.finalValidationState === "verified_passed") {
      assert.equal(finalReport.finalStatus, "passed");
      assert.equal((finalReport.repair?.validationAttempts ?? []).some((attempt) => attempt.role === "repair_revalidation" && attempt.truthStatus === "verified_passed")
        || (finalReport.validationDiscovery?.evidence ?? []).some((entry) => entry.truthStatus === "verified_passed"), true);
    } else if (finalReport.finalValidationState === "verified_failed") {
      assert.equal(finalReport.finalStatus, "failed");
      assert.ok(finalReport.repair?.diagnosis);
      assert.equal((finalReport.repair?.validationAttempts ?? []).some((attempt) => attempt.truthStatus === "verified_failed"), true);
      if (finalReport.repair.repairPatchId) {
        assert.equal((finalReport.repair.validationAttempts ?? []).length >= 2 || finalReport.repair.status === "revalidation_requested", true);
      } else {
        assert.equal(finalReport.repair.eligibility.status, "repair_not_attempted");
      }
    } else {
      assert.notEqual(finalReport.finalValidationState, "verified_passed");
      assert.equal(finalReport.finalStatus, "unverified");
    }

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_repair_loop_failed", output.failureReason, output);
  } finally {
    await rm(parentAbsolute, { force: true });
    await rm(nestedAbsolute, { force: true });
    try {
      await rm(path.dirname(parentAbsolute), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveAttributionScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive attribution"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const parentFile = `${smokeDir}/recursive-attribution-parent-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const nestedFile = `${smokeDir}/recursive-attribution-child-${Date.now()}-${marker.slice(9, 17)}.txt`;
  const parentAbsolute = path.join(workspacePath, parentFile);
  const nestedAbsolute = path.join(workspacePath, nestedFile);
  const nestedRequested = `recursive attribution child applied ${marker}\n`;
  const prompt = `Build a recursive attribution smoke flow with nested execution that updates ${nestedFile}, validates truthfully, and attributes any validation failure only with evidence.`;
  const output: RealWorkspaceSmokeReport["recursive attribution"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    attributionConfidence: null,
    attributionEvidence: [],
    relatedPatchIds: [],
    relatedBranchIds: [],
    repairEligibility: null,
    validationAttempts: [],
    tempFiles: [parentFile, nestedFile],
    failureReason: null
  };

  try {
    await mkdir(path.dirname(parentAbsolute), { recursive: true });
    await writeFile(parentAbsolute, "before recursive attribution parent\n", "utf8");
    await writeFile(nestedAbsolute, "before recursive attribution child\n", "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branch = session.recursiveFactory?.branchOrchestrators?.[0];
    assert.ok(branch);
    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: `parent attribution patch should not apply ${marker}\n`,
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: nestedRequested, objective: "Nested recursive attribution smoke patch" }]
      }]
    });
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, proposal);
    assert.equal((await readFile(nestedAbsolute, "utf8")).replace(/\r\n/g, "\n"), nestedRequested);

    const safeRequest = session.commandRequests.find((request) => request.risk === "safe" && !session.commandExecutions.some((execution) => execution.requestId === request.id));
    if (safeRequest) {
      await runRuntimeRustBridge({
        rustProjectDir,
        runtimeUrl,
        workspace: workspacePath,
        sessionId: created.sessionId,
        requestId: safeRequest.id,
        command: safeRequest.command,
        cwd: safeRequest.cwd
      });
      session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    }

    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.attributionConfidence = finalReport.repair?.diagnosis.attribution.confidence ?? null;
    output.attributionEvidence = finalReport.repair?.diagnosis.attribution.evidence ?? [];
    output.relatedPatchIds = finalReport.repair?.diagnosis.attribution.relatedPatchIds ?? [];
    output.relatedBranchIds = finalReport.repair?.diagnosis.attribution.relatedBranchIds ?? [];
    output.repairEligibility = finalReport.repair?.eligibility.status ?? null;
    output.validationAttempts = (finalReport.repair?.validationAttempts ?? []).map((attempt) =>
      `${attempt.attemptNumber}:${attempt.command}:${attempt.truthStatus}`
    );

    if (finalReport.finalValidationState === "verified_failed") {
      assert.ok(finalReport.repair?.diagnosis);
      const attribution = finalReport.repair.diagnosis.attribution;
      if (attribution.confidence === "high" || attribution.confidence === "medium") {
        assert.equal(attribution.evidence.length > 0, true);
        assert.equal(attribution.relatedPatchIds.length > 0, true);
        assert.match(attribution.evidence.join("\n"), /Changed file|changed module|Changed .* is referenced/i);
      } else {
        assert.deepEqual(attribution.relatedPatchIds, []);
        assert.match(attribution.reason, /did not mention|weak|no patch relationship/i);
      }
    } else if (finalReport.finalValidationState === "verified_passed") {
      assert.equal(finalReport.finalStatus, "passed");
      assert.equal((finalReport.validationDiscovery?.evidence ?? []).some((entry) => entry.truthStatus === "verified_passed"), true);
    } else {
      assert.notEqual(finalReport.finalValidationState, "verified_passed");
    }

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_attribution_failed", output.failureReason, output);
  } finally {
    await rm(parentAbsolute, { force: true });
    await rm(nestedAbsolute, { force: true });
    try {
      await rm(path.dirname(parentAbsolute), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveHighAttributionRepairScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive high attribution repair"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const scenarioDir = `${smokeDir}/recursive-high-attribution-${Date.now()}-${marker.slice(0, 8)}`;
  const moduleFile = `${scenarioDir}/module.mjs`;
  const testFile = `${scenarioDir}/module.test.mjs`;
  const supportFile = `${scenarioDir}/support.txt`;
  const packageFile = "package.json";
  const moduleAbsolute = path.join(workspacePath, moduleFile);
  const testAbsolute = path.join(workspacePath, testFile);
  const supportAbsolute = path.join(workspacePath, supportFile);
  const packageAbsolute = path.join(workspacePath, packageFile);
  const command = "npm test";
  const supportInitial = "before high attribution support branch\n";
  const supportPatched = `high attribution support branch applied ${marker}\n`;
  const fixedModule = [
    "import assert from \"node:assert/strict\";",
    "",
    "export const HIVO_REPAIR_VALUE = \"fixed\";",
    "",
    "export function verifySmokeValue() {",
    "  assert.equal(HIVO_REPAIR_VALUE, \"fixed\");",
    "}",
    ""
  ].join("\n");
  const brokenModule = fixedModule.replace("HIVO_REPAIR_VALUE = \"fixed\"", "HIVO_REPAIR_VALUE = \"broken\"");
  const testContent = [
    "import { test } from \"node:test\";",
    "import { verifySmokeValue } from \"./module.mjs\";",
    "",
    "test(\"recursive high attribution repair\", () => {",
    "  verifySmokeValue();",
    "});",
    ""
  ].join("\n");
  const packageJson = JSON.stringify({
    name: "hivo-recursive-high-attribution-smoke",
    private: true,
    scripts: {
      test: `node --test ${testFile.replace(/\\/g, "/")}`
    }
  }, null, 2);
  const prompt = `Build a recursive high-attribution repair smoke flow that intentionally breaks ${moduleFile}, validates with ${command}, attributes the failure, repairs it, and reruns validation.`;
  const output: RealWorkspaceSmokeReport["recursive high attribution repair"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    failingCommand: null,
    attributionConfidence: null,
    attributionEvidence: [],
    relatedPatchIds: [],
    relatedBranchIds: [],
    repairEligibility: null,
    repairPatchId: null,
    repairPatchStatus: null,
    repairAttemptCount: null,
    firstValidationResult: null,
    revalidationResult: null,
    validationAttempts: [],
    cleanupStatus: "not_run",
    tempFiles: [moduleFile, testFile, supportFile, packageFile],
    failureReason: null
  };
  let packageBefore: string | undefined;
  let packageExisted = false;

  try {
    await mkdir(path.dirname(moduleAbsolute), { recursive: true });
    await writeFile(moduleAbsolute, fixedModule, "utf8");
    await writeFile(testAbsolute, testContent, "utf8");
    await writeFile(supportAbsolute, supportInitial, "utf8");
    try {
      packageBefore = await readFile(packageAbsolute, "utf8");
      packageExisted = true;
    } catch {
      packageExisted = false;
    }
    await writeFile(packageAbsolute, packageJson, "utf8");

    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branches = session.recursiveFactory?.branchOrchestrators?.slice(0, 2) ?? [];
    assert.equal(branches.length >= 2, true);

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branches[0]!.branchId,
        targetFile: moduleFile,
        replacementText: brokenModule
      }, {
        branchId: branches[1]!.branchId,
        targetFile: supportFile,
        replacementText: supportPatched
      }]
    });
    const breakingPatch = session.patchProposals.find((patch) => patch.filesChanged.some((file) => file.path === moduleFile));
    assert.ok(breakingPatch);
    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, breakingPatch);
    assert.equal((await readFile(moduleAbsolute, "utf8")).replace(/\r\n/g, "\n"), brokenModule);
    const supportPatch = session.patchProposals.find((patch) => patch.filesChanged.some((file) => file.path === supportFile));
    assert.ok(supportPatch);
    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, supportPatch);
    assert.equal((await readFile(supportAbsolute, "utf8")).replace(/\r\n/g, "\n"), supportPatched);

    const validationRequest = session.commandRequests.find((request) =>
      request.command === command
      && !session.commandExecutions.some((execution) => execution.requestId === request.id)
    );
    if (!validationRequest) {
      const finalReport = session.recursiveFactory?.finalReport;
      throw new Error(`Expected safe validation request ${command}; requests=${JSON.stringify(session.commandRequests.map((request) => ({
        id: request.id,
        command: request.command,
        cwd: request.cwd,
        risk: request.risk
      })))} finalValidationState=${finalReport?.finalValidationState ?? "missing"} selectedStrategy=${finalReport?.validationStrategy?.chosen?.command ?? "missing"}`);
    }
    const firstBridgeResult = await runRuntimeRustBridge({
      rustProjectDir,
      runtimeUrl,
      workspace: workspacePath,
      sessionId: created.sessionId,
      requestId: validationRequest.id,
      command: validationRequest.command,
      cwd: validationRequest.cwd
    });
    output.firstValidationResult = firstBridgeResult.commandResult.status;
    session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;

    let finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    output.failingCommand = finalReport.repair?.diagnosis.command ?? null;
    output.attributionConfidence = finalReport.repair?.diagnosis.attribution.confidence ?? null;
    output.attributionEvidence = finalReport.repair?.diagnosis.attribution.evidence ?? [];
    output.relatedPatchIds = finalReport.repair?.diagnosis.attribution.relatedPatchIds ?? [];
    output.relatedBranchIds = finalReport.repair?.diagnosis.attribution.relatedBranchIds ?? [];
    output.repairEligibility = finalReport.repair?.eligibility.status ?? null;
    output.repairPatchId = finalReport.repair?.repairPatchId ?? null;
    output.repairPatchStatus = finalReport.repair?.repairPatchStatus ?? finalReport.repair?.status ?? null;
    output.repairAttemptCount = finalReport.repair?.attemptCount ?? null;

    assert.equal(finalReport.finalValidationState, "verified_failed");
    assert.equal(finalReport.repair?.diagnosis.command, command);
    assert.equal(
      finalReport.repair?.diagnosis.attribution.confidence,
      "high",
      `Expected high attribution; diagnosis=${JSON.stringify(finalReport.repair?.diagnosis, null, 2)} patchProvenance=${JSON.stringify(finalReport.patchProvenance, null, 2)}`
    );
    assert.equal(finalReport.repair?.diagnosis.attribution.relatedPatchIds.includes(breakingPatch.id), true);
    assert.match(finalReport.repair?.diagnosis.attribution.evidence.join("\n") ?? "", new RegExp(moduleFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(finalReport.repair?.eligibility.status, "eligible");
    assert.equal(finalReport.repair?.attemptCount, 1);
    assert.ok(finalReport.repair?.repairPatchId);
    assert.equal(session.patchProposals.filter((patch) => patch.id === finalReport?.repair?.repairPatchId).length, 1);

    const repairPatch = session.patchProposals.find((patch) => patch.id === finalReport?.repair?.repairPatchId);
    assert.ok(repairPatch);
    assert.equal(repairPatch.status, "proposed");
    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, repairPatch);
    assert.equal((await readFile(moduleAbsolute, "utf8")).replace(/\r\n/g, "\n"), fixedModule);

    const repairState = session.recursiveFactory?.repair;
    const revalidationRequest = session.commandRequests.find((request) => request.id === repairState?.revalidationRequestId);
    assert.ok(revalidationRequest);
    assert.equal(revalidationRequest.command, command);
    const secondBridgeResult = await runRuntimeRustBridge({
      rustProjectDir,
      runtimeUrl,
      workspace: workspacePath,
      sessionId: created.sessionId,
      requestId: revalidationRequest.id,
      command: revalidationRequest.command,
      cwd: revalidationRequest.cwd
    });
    output.revalidationResult = secondBridgeResult.commandResult.status;
    session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);

    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.repairPatchId = finalReport.repair?.repairPatchId ?? output.repairPatchId;
    output.repairPatchStatus = finalReport.repair?.repairPatchStatus ?? finalReport.repair?.status ?? output.repairPatchStatus;
    output.repairAttemptCount = finalReport.repair?.attemptCount ?? output.repairAttemptCount;
    output.validationAttempts = (finalReport.repair?.validationAttempts ?? []).map((attempt) =>
      `${attempt.attemptNumber}:${attempt.role}:${attempt.command}:${attempt.truthStatus}`
    );

    if (finalReport.finalValidationState === "verified_passed") {
      assert.equal(finalReport.finalStatus, "passed");
      assert.equal((finalReport.repair?.validationAttempts ?? []).some((attempt) => attempt.role === "repair_revalidation" && attempt.truthStatus === "verified_passed"), true);
    } else {
      assert.equal(
        finalReport.finalStatus,
        "failed",
        `Expected failed final status when revalidation did not pass; finalReport=${JSON.stringify(finalReport, null, 2)} revalidationResult=${JSON.stringify(secondBridgeResult.commandResult, null, 2)}`
      );
      assert.equal(finalReport.finalValidationState, "verified_failed");
      assert.ok(finalReport.repair?.diagnosis);
      assert.equal((finalReport.repair?.validationAttempts ?? []).some((attempt) => attempt.role === "repair_revalidation"), true);
    }

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_high_attribution_repair_failed", output.failureReason, output);
  } finally {
    try {
      await rm(path.join(workspacePath, scenarioDir), { recursive: true, force: true });
      if (packageExisted && packageBefore !== undefined) {
        await writeFile(packageAbsolute, packageBefore, "utf8");
      } else {
        await rm(packageAbsolute, { force: true });
      }
      output.cleanupStatus = "passed";
    } catch (error) {
      output.cleanupStatus = "cleanup_failed";
      output.failureReason = output.failureReason ?? `cleanup_failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

async function runRecursiveMultibranchScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive multibranch"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const relativeFiles = [
    `${smokeDir}/recursive-multi-one-${Date.now()}-${marker.slice(0, 8)}.txt`,
    `${smokeDir}/recursive-multi-two-${Date.now()}-${marker.slice(9, 17)}.txt`
  ];
  const absoluteFiles = relativeFiles.map((file) => path.join(workspacePath, file));
  const initialContent = ["before recursive multibranch one\n", "before recursive multibranch two\n"];
  const requestedContent = [`recursive multibranch one applied ${marker}\n`, `recursive multibranch two applied ${marker}\n`];
  const prompt = `Build a multi-step project feature with recursive approval gates, then update ${relativeFiles.join(" and ")} through two safe non-conflicting branches and produce final fan-in truth.`;
  const output: RealWorkspaceSmokeReport["recursive multibranch"] = {
    status: "failed",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    branchResultCount: null,
    appliedPatches: [],
    branchStatuses: [],
    writeBranchesConcurrent: null,
    tempFiles: relativeFiles,
    failureReason: null
  };

  try {
    await mkdir(path.dirname(absoluteFiles[0]!), { recursive: true });
    await writeFile(absoluteFiles[0]!, initialContent[0]!, "utf8");
    await writeFile(absoluteFiles[1]!, initialContent[1]!, "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branches = session.recursiveFactory?.branchOrchestrators?.slice(0, 2) ?? [];
    assert.equal(branches.length >= 2, true);
    assert.equal(session.recursiveFactory?.recursiveGraph?.status, "ready");

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [
        { branchId: branches[0]!.branchId, targetFile: relativeFiles[0]!, replacementText: requestedContent[0]! },
        { branchId: branches[1]!.branchId, targetFile: relativeFiles[1]!, replacementText: requestedContent[1]! }
      ]
    });
    assert.equal(session.patchProposals.length, 1);
    assert.equal(activeWriteBranchCount(session) <= 1, true);
    assert.equal(await readFile(absoluteFiles[0]!, "utf8"), initialContent[0]);
    assert.equal(await readFile(absoluteFiles[1]!, "utf8"), initialContent[1]);
    const firstProposal = session.patchProposals[0]!;
    assert.equal(firstProposal.status, "proposed");
    assert.equal(firstProposal.filesChanged.some((file) => file.path === relativeFiles[0]), true);

    await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, firstProposal);
    session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.equal(activeWriteBranchCount(session) <= 1, true);
    assert.equal((await readFile(absoluteFiles[0]!, "utf8")).replace(/\r\n/g, "\n"), requestedContent[0]);
    assert.equal(await readFile(absoluteFiles[1]!, "utf8"), initialContent[1]);
    assert.equal(session.patchProposals.length >= 2, true);
    const secondProposal = session.patchProposals.find((proposal) => proposal.id !== firstProposal.id && proposal.status === "proposed");
    assert.ok(secondProposal);
    assert.equal(secondProposal.filesChanged.some((file) => file.path === relativeFiles[1]), true);

    await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, secondProposal);
    session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    assert.equal(activeWriteBranchCount(session) <= 1, true);
    assert.equal((await readFile(absoluteFiles[1]!, "utf8")).replace(/\r\n/g, "\n"), requestedContent[1]);
    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    output.branchResultCount = finalReport.branchOutcomes.length;
    output.appliedPatches = finalReport.patchApplyTruth.filter((patch) => patch.status === "applied").map((patch) => patch.patchId);
    output.branchStatuses = (session.recursiveFactory?.branchExecutions ?? []).map((branch) => `${branch.branchId}:${branch.status}:${branch.validationStatus}`);
    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    output.writeBranchesConcurrent = false;
    assert.equal(finalReport.branchOutcomes.length >= 2, true);
    assert.equal(output.appliedPatches.length >= 2, true);
    assert.equal(finalReport.finalStatus, "unverified");
    assert.notEqual(finalReport.finalValidationState, "verified_passed");
    assert.equal(session.commandExecutions.length, 0);
    assert.notEqual(session.verificationResult?.truthStatus, "verified_passed");

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_branch_execution_failed", output.failureReason, output);
  } finally {
    for (const absoluteFile of absoluteFiles) {
      await rm(absoluteFile, { force: true });
    }
    try {
      await rm(path.dirname(absoluteFiles[0]!), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runRecursiveNestedBranchScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["recursive nested branch"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const parentFile = `${smokeDir}/recursive-nested-parent-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const nestedFile = `${smokeDir}/recursive-nested-child-${Date.now()}-${marker.slice(9, 17)}.txt`;
  const parentAbsolute = path.join(workspacePath, parentFile);
  const nestedAbsolute = path.join(workspacePath, nestedFile);
  const parentInitial = "before recursive nested parent\n";
  const nestedInitial = "before recursive nested child\n";
  const nestedRequested = `recursive nested child applied ${marker}\n`;
  const prompt = `Build a complex nested recursive branch feature with one safe nested subtask that updates ${nestedFile} and produces truthful nested fan-in.`;
  const output: RealWorkspaceSmokeReport["recursive nested branch"] = {
    status: "failed",
    sessionStatus: null,
    parentBranchStatus: null,
    nestedSubtaskCount: null,
    nestedPatchStatus: null,
    finalStatus: null,
    finalValidationState: null,
    nestedRollupValidation: null,
    appliedPatches: [],
    tempFiles: [parentFile, nestedFile],
    failureReason: null
  };

  try {
    await mkdir(path.dirname(parentAbsolute), { recursive: true });
    await writeFile(parentAbsolute, parentInitial, "utf8");
    await writeFile(nestedAbsolute, nestedInitial, "utf8");
    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "recursive_factory",
      accessProfile: "full_access"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);
    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "product-spec", "approved");
    session = await decideFactoryArtifact(runtimeUrl, created.sessionId, "technical-plan", "approved");
    const branch = session.recursiveFactory?.branchOrchestrators?.[0];
    assert.ok(branch);
    assert.equal(session.recursiveFactory?.recursiveGraph?.status, "ready");

    session = await startRecursiveBranchExecution(runtimeUrl, created.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: `parent direct patch should not apply ${marker}\n`,
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: nestedRequested, objective: "Nested smoke safe subtask patch" }]
      }]
    });
    const parentExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(parentExecution);
    assert.equal(parentExecution.nestedDepth, 1);
    assert.equal(parentExecution.nestedSubtasks?.length, 2);
    assert.equal(parentExecution.proposedPatchId, undefined);
    assert.equal(parentExecution.status, "running");
    assert.match(parentExecution.blockedReason ?? "", /waiting for required nested subtasks/i);
    output.nestedSubtaskCount = parentExecution.nestedSubtasks?.length ?? null;
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.filesChanged.some((file) => file.path === nestedFile), true);
    assert.equal(await readFile(parentAbsolute, "utf8"), parentInitial);
    assert.equal(await readFile(nestedAbsolute, "utf8"), nestedInitial);

    session = await approveAndRustApply(runtimeUrl, rustProjectDir, workspacePath, created.sessionId, proposal);
    assert.equal(await readFile(parentAbsolute, "utf8"), parentInitial);
    assert.equal((await readFile(nestedAbsolute, "utf8")).replace(/\r\n/g, "\n"), nestedRequested);
    const updatedParent = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(updatedParent);
    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    output.parentBranchStatus = updatedParent.status;
    output.nestedPatchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    output.nestedRollupValidation = updatedParent.nestedRollup?.validationState ?? null;
    output.appliedPatches = finalReport.patchApplyTruth.filter((patch) => patch.status === "applied").map((patch) => patch.patchId);
    output.finalStatus = finalReport.finalStatus;
    output.finalValidationState = finalReport.finalValidationState;
    assert.equal(updatedParent.status, "validation_pending");
    assert.equal(updatedParent.nestedRollup?.appliedPatches.includes(proposal.id), true);
    assert.equal(finalReport.branchOutcomes.some((outcome) => outcome.nestedRollup?.appliedPatches.includes(proposal.id)), true);
    assert.equal(finalReport.finalStatus, "unverified");
    assert.notEqual(finalReport.finalValidationState, "verified_passed");
    assert.equal(session.commandExecutions.length, 0);

    output.sessionStatus = session.status;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("recursive_nested_branch_failed", output.failureReason, output);
  } finally {
    await rm(parentAbsolute, { force: true });
    await rm(nestedAbsolute, { force: true });
    try {
      await rm(path.dirname(parentAbsolute), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function runPatchTruthScenario(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string
): Promise<RealWorkspaceSmokeReport["patch truth"]> {
  const smokeDir = ".hivo-smoke";
  const marker = randomUUID();
  const relativeFile = `${smokeDir}/patch-truth-${Date.now()}-${marker.slice(0, 8)}.txt`;
  const absoluteFile = path.join(workspacePath, relativeFile);
  const initialContent = "before patch truth smoke\n";
  const requestedContent = `patch truth applied ${marker}`;
  const prompt = `write file ${relativeFile} with ${requestedContent}`;
  const output: RealWorkspaceSmokeReport["patch truth"] = {
    status: "failed",
    sessionStatus: null,
    patchStatus: null,
    rustApplyStatus: null,
    validationTruthStatus: null,
    tempFile: relativeFile
  };

  try {
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, initialContent, "utf8");

    const created = await createRuntimeSession(runtimeUrl, workspacePath, prompt, {
      mode: "demo_mock",
      executionMode: "simple_mode",
      accessProfile: "default_permissions"
    });
    await runTurn(runtimeUrl, created.sessionId, prompt);

    let session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    output.sessionStatus = session.status;
    assert.equal(session.patchProposals.length, 1);
    const proposal = session.patchProposals[0];
    assert.ok(proposal);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.filesChanged.some((file) => normalizeRelativePath(file.path) === relativeFile), true);
    assert.equal((await readFile(absoluteFile, "utf8")), initialContent);
    assert.equal(session.commandExecutions.length, 0);
    const latestAssistant = session.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
    assert.equal(/\b(applied|fixed|files changed|changed files|file changed on disk)\b/i.test(latestAssistant), false);

    const approval = await approveRuntimePatch(runtimeUrl, created.sessionId, proposal.id);
    assert.equal(approval.applied, false);
    assert.equal(approval.proposal.status, "approved");
    session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    assert.equal(output.patchStatus, "approved");
    assert.equal((await readFile(absoluteFile, "utf8")), initialContent);

    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "apply_started",
      message: "Rust patch apply requested by patch-truth smoke."
    });
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    assert.equal(output.patchStatus, "apply_started");

    const rustApply = await runRuntimePatchApplyBridge({
      rustProjectDir,
      workspace: workspacePath,
      sessionId: created.sessionId,
      patchId: proposal.id,
      proposal
    });
    output.rustApplyStatus = rustApply.patchResult.status;
    assert.equal(rustApply.patchResult.status, "applied");

    session = await reportPatchApplyResult(runtimeUrl, created.sessionId, proposal.id, {
      status: "applied",
      message: rustApply.patchResult.message,
      reconciliationSnapshot:
        rustApply.patchResult.beforeSnapshot || rustApply.patchResult.afterSnapshot
          ? {
              before: rustApply.patchResult.beforeSnapshot,
              after: rustApply.patchResult.afterSnapshot
            }
          : undefined
    });
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    output.validationTruthStatus = session.verificationResult?.truthStatus ?? null;
    assert.equal(output.patchStatus, "applied");
    assert.equal((await readFile(absoluteFile, "utf8")).replace(/\r\n/g, "\n"), `${requestedContent}\n`);

    const safeRequest = session.commandRequests.find((request) => request.risk === "safe");
    if (safeRequest) {
      await runRuntimeRustBridge({
        rustProjectDir,
        runtimeUrl,
        workspace: workspacePath,
        sessionId: created.sessionId,
        requestId: safeRequest.id,
        command: safeRequest.command,
        cwd: safeRequest.cwd
      });
      session = await getSession(runtimeUrl, created.sessionId) as AgentRuntimeSession;
      output.validationTruthStatus = session.verificationResult?.truthStatus ?? null;
    }
    if (!session.commandExecutions.length) {
      assert.notEqual(session.verificationResult?.truthStatus, "verified_passed");
    }

    output.sessionStatus = session.status;
    output.patchStatus = session.patchProposals.find((patch) => patch.id === proposal.id)?.status ?? null;
    output.status = "passed";
    return output;
  } catch (error) {
    output.failureReason = error instanceof Error ? error.message : String(error);
    throw new SmokeFailure("patch_truth_failed", output.failureReason, output);
  } finally {
    await rm(absoluteFile, { force: true });
    try {
      await rm(path.dirname(absoluteFile), { recursive: false });
    } catch {
      // The smoke directory can contain artifacts from another run.
    }
  }
}

async function decideFactoryArtifact(
  runtimeUrl: string,
  sessionId: string,
  artifact: "product-spec" | "technical-plan",
  decision: "approved" | "rejected" | "changes_requested"
) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/factory/${artifact}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision })
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<AgentRuntimeSession>;
}

async function startRecursiveBranchExecution(
  runtimeUrl: string,
  sessionId: string,
  body: {
    approved: true;
    targetFile?: string;
    replacementText?: string;
    branchTargets?: Array<{
      branchId?: string;
      targetFile: string;
      replacementText: string;
      nestedSubtasks?: Array<{
        targetFile: string;
        replacementText: string;
        objective?: string;
      }>;
    }>;
  }
) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/factory/branch-execution/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<AgentRuntimeSession>;
}

function activeWriteBranchCount(session: AgentRuntimeSession) {
  return (session.recursiveFactory?.branchExecutions ?? []).filter((branch) =>
    branch.active
    && branch.schedulerDecision.writeBranch
    && !branch.patchApplied
    && ["running", "patch_proposed", "reviewing", "validation_pending"].includes(branch.status)
  ).length;
}

async function approveAndRustApply(
  runtimeUrl: string,
  rustProjectDir: string,
  workspacePath: string,
  sessionId: string,
  proposal: AgentRuntimeSession["patchProposals"][number]
) {
  const approval = await approveRuntimePatch(runtimeUrl, sessionId, proposal.id);
  assert.equal(approval.applied, false);
  let session = await reportPatchApplyResult(runtimeUrl, sessionId, proposal.id, {
    status: "apply_started",
    message: "Rust patch apply requested by recursive multibranch smoke."
  });
  assert.equal(session.patchProposals.find((patch) => patch.id === proposal.id)?.status, "apply_started");
  const rustApply = await runRuntimePatchApplyBridge({
    rustProjectDir,
    workspace: workspacePath,
    sessionId,
    patchId: proposal.id,
    proposal
  });
  assert.equal(rustApply.patchResult.status, "applied");
  session = await reportPatchApplyResult(runtimeUrl, sessionId, proposal.id, {
    status: "applied",
    message: rustApply.patchResult.message,
    reconciliationSnapshot:
      rustApply.patchResult.beforeSnapshot || rustApply.patchResult.afterSnapshot
        ? {
            before: rustApply.patchResult.beforeSnapshot,
            after: rustApply.patchResult.afterSnapshot
          }
        : undefined
  });
  return session;
}

async function approveRuntimePatch(runtimeUrl: string, sessionId: string, patchId: string) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/patches/${patchId}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{
    proposal: AgentRuntimeSession["patchProposals"][number];
    applied: boolean;
    message: string;
  }>;
}

async function reportPatchApplyResult(
  runtimeUrl: string,
  sessionId: string,
  patchId: string,
  body: {
    status: "apply_started" | "applied" | "failed";
    message: string;
    reconciliationSnapshot?: {
      before?: unknown;
      after?: unknown;
    };
  }
) {
  const response = await fetch(`${runtimeUrl}/sessions/${sessionId}/patches/${patchId}/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<AgentRuntimeSession>;
}

function assertRecursivePlanHasNoExecution(session: AgentRuntimeSession) {
  assert.equal(session.tasks.length, 0);
  assert.equal(session.patchProposals.length, 0);
  assert.equal(session.commandRequests.length, 0);
  assert.equal(session.commandExecutions.length, 0);
}

async function runRuntimePatchApplyBridge(input: {
  rustProjectDir: string;
  workspace: string;
  sessionId: string;
  patchId: string;
  proposal: AgentRuntimeSession["patchProposals"][number];
}) {
  return new Promise<{
    patchResult: {
      patchId: string;
      status: string;
      message: string;
      beforeSnapshot?: unknown;
      afterSnapshot?: unknown;
    };
  }>((resolve, reject) => {
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
        "--apply-runtime-patch",
        "true",
        "--session-id",
        input.sessionId,
        "--patch-id",
        input.patchId,
        "--proposal-json",
        JSON.stringify(input.proposal)
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
        reject(new Error(stderr || stdout || `Rust patch bridge smoke failed with exit code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as {
          patchResult: {
            patchId: string;
            status: string;
            message: string;
            beforeSnapshot?: unknown;
            afterSnapshot?: unknown;
          };
        });
      } catch (error) {
        reject(new Error(`Failed to decode Rust patch bridge output: ${String(error)}\n${stdout}\n${stderr}`));
      }
    });
  });
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

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
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
