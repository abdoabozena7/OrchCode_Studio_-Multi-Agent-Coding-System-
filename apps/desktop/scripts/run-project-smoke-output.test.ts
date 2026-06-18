import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, ProviderTruthTelemetry } from "@hivo/protocol";
import { describeCurrentStep } from "../src/app/activityStream.ts";
import { isTerminalOrOperatorHeldSession, mergeRuntimeSessionState } from "../src/app/App.tsx";
import { subscribeRuntimeEvents } from "../src/lib/agentRuntime.ts";
import {
  createProviderTruthSmokeOutput,
  createRealWorkspaceSmokeReport,
  generateProjectQuestions,
  inspectWorkspaceForQuestions
} from "./run-project-smoke.ts";

let browserHarnessLock = Promise.resolve();

test("real workspace smoke output exposes provider truth telemetry", () => {
  const telemetry: ProviderTruthTelemetry = {
    providerMode: "real_provider",
    providerName: "OpenAI-compatible",
    modelName: "smoke-model",
    providerBaseUrl: "http://127.0.0.1:47891",
    providerRequestCount: 2,
    mockProviderRequestCount: 0,
    realProviderRequestCount: 2,
    providerResponseCount: 1,
    providerFailureCount: 1,
    providerTimeoutCount: 0,
    totalProviderLatencyMs: 42,
    totalProviderPromptChars: 12345,
    totalProviderResponseChars: 678,
    totalProviderContextChars: 2345,
    perPromptProviderLatencyMs: [
      {
        requestId: "provider_1",
        requestType: "text",
        providerName: "OpenAI-compatible",
        modelName: "smoke-model",
        latencyMs: 42,
        status: "failure",
        errorSummary: "provider request failed without exposing secrets",
        systemPromptChars: 120,
        userPromptChars: 1000,
        contextChars: 2345,
        promptChars: 3465
      }
    ],
    fallbackUsed: false,
    lastError: "provider gate preserved last error",
    deterministicOnly: false,
    mockProviderUsed: false,
    realProviderUsed: true,
    activeProviderSource: "explicit_cli",
    updatedAt: "2026-06-03T00:00:00.000Z"
  };

  const output = createProviderTruthSmokeOutput({
    providerTelemetry: telemetry,
    runSummary: undefined,
    reasoningSummaries: []
  });

  assert.equal(output.activeProviderSource, "explicit_cli");
  assert.equal(output.mockProviderUsed, false);
  assert.equal(output.fallbackUsed, false);
  assert.equal(output.requestCount, 2);
  assert.equal(output.promptChars, 12345);
  assert.equal(output.responseChars, 678);
  assert.equal(output.contextChars, 2345);
  assert.equal(output.lastError, "provider gate preserved last error");
  assert.equal(output.raw?.providerBaseUrl, "http://127.0.0.1:47891");
});

test("real workspace smoke output includes session update reconciliation status", () => {
  const report = createRealWorkspaceSmokeReport("http://127.0.0.1:4317", "D:/project");

  assert.deepEqual(report["session updates"], {
    status: "unknown",
    sseUpdateCount: 0,
    canonicalFetchCount: 0,
    lastCanonicalStatus: null,
    lastError: null
  });
  assert.deepEqual(report["work accounting"], {
    scannedFiles: null,
    sampledFiles: null,
    evidenceFilesUsed: null,
    generatedEvidenceExcluded: null,
    progressEventCount: null,
    artifactCount: null
  });
  assert.deepEqual(report["orchestrated swarm"], {
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
  });
  assert.deepEqual(report["provider prompt matrix"], {
    status: "not_run",
    prompts: []
  });
  assert.deepEqual(report["recursive final validation"], {
    status: "not_run",
    sessionStatus: null,
    finalStatus: null,
    finalValidationState: null,
    branchResultCount: null,
    appliedPatches: [],
    unverifiedValidations: [],
    tempFile: null,
    failureReason: null
  });
  assert.deepEqual(report["recursive validated"], {
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
  });
  assert.deepEqual(report["recursive repair loop"], {
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
  });
  assert.deepEqual(report["recursive attribution"], {
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
  });
  assert.deepEqual(report["recursive high attribution repair"], {
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
  });
  assert.deepEqual(report["recursive multibranch"], {
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
  });
  assert.deepEqual(report["recursive nested branch"], {
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
  });
});

test("real workspace smoke question discovery ignores memory and runtime artifacts", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-smoke-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, ".agent_memory"), { recursive: true });
  await mkdir(path.join(workspace, ".orchcode-agent-runtime"), { recursive: true });
  await mkdir(path.join(workspace, "backend"), { recursive: true });
  try {
    await writeFile(path.join(workspace, ".agent_memory", "README.md"), "# Saved Memory\n", "utf8");
    await writeFile(path.join(workspace, ".agent_memory", "sessions.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, ".orchcode-agent-runtime", "events.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "backend", "main.py"), "from fastapi import FastAPI\napp = FastAPI()\n", "utf8");
    await writeFile(path.join(workspace, "README.md"), "# Real Project\n", "utf8");

    const snapshot = await inspectWorkspaceForQuestions(workspace);
    const questions = generateProjectQuestions(snapshot);

    assert.equal(snapshot.files.some((file) => file.startsWith(".agent_memory/")), false);
    assert.equal(snapshot.files.some((file) => file.startsWith(".orchcode-agent-runtime/")), false);
    assert.deepEqual(snapshot.entrypointFiles, ["backend/main.py"]);
    assert.equal(questions.join("\n").includes("backend/main.py"), true);
    assert.equal(questions.join("\n").includes(".agent_memory"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("canonical session merge removes duplicate runtime messages", () => {
  const duplicate = { id: "m1", role: "assistant" as const, content: "done", createdAt: "2026-06-03T00:00:00.000Z" };
  const session = makeSession({
    messages: [
      { id: "u1", role: "user", content: "fix", createdAt: "2026-06-03T00:00:00.000Z" },
      duplicate,
      duplicate
    ]
  });

  const merged = mergeRuntimeSessionState(null, session);

  assert.equal(merged.messages.length, 2);
  assert.deepEqual(merged.messages.map((message) => message.id), ["u1", "m1"]);
});

test("failed, expired, blocked, and approval sessions do not look like loading UI states", () => {
  for (const status of ["failed_provider", "expired", "blocked", "needs_approval"] as const) {
    const session = makeSession({
      status,
      lifecycleStage: status === "failed_provider" ? "FAILED" : status === "expired" ? "BLOCKED" : "BLOCKED",
      progressEvents: [
        {
          id: "progress_1",
          stage: "implementation",
          status: "running",
          summary: "stale running progress",
          createdAt: "2026-06-03T00:00:00.000Z"
        }
      ]
    });

    const step = describeCurrentStep(session, "connected");

    assert.equal(isTerminalOrOperatorHeldSession(session), true);
    assert.notEqual(step.id, "progress_1");
    assert.notEqual(step.status, "running");
  }
});

test("SSE reconnect triggers canonical session fetch and reconnect callback", async () => {
  await withBrowserHarness(async () => {
    const harness = installEventSourceHarness({
      failFirst: true,
      authResponse: () => mockFetchResponse(200, makeSession())
    });
    let reconnects = 0;
    try {
      const unsubscribe = subscribeRuntimeEvents("session_1", "token", {
        onReconnect: () => {
          reconnects += 1;
        }
      });
      await delay(30);
      unsubscribe();
    } finally {
      harness.restore();
    }

    assert.equal(harness.fetchCount(), 1);
    assert.equal(reconnects, 1);
    assert.equal(harness.eventSourceCount(), 2);
  });
});

test("token expired stops SSE retry loop and surfaces clear auth state", async () => {
  await withBrowserHarness(async () => {
    const harness = installEventSourceHarness({
      failFirst: true,
      authResponse: () => mockFetchResponse(401, { error: "Session token expired.", code: "token_expired" })
    });
    const states: string[] = [];
    try {
      const unsubscribe = subscribeRuntimeEvents("session_1", "expired-token", {
        onStateChange: (state) => {
          states.push(state.status);
        }
      });
      await waitFor(() => states.includes("token_expired"), 1000);
      unsubscribe();
    } finally {
      harness.restore();
    }

    assert.equal(harness.fetchCount(), 1);
    assert.equal(harness.eventSourceCount(), 1);
    assert.equal(states.includes("token_expired"), true, `states: ${states.join(", ")}`);
  });
});

function makeSession(overrides: Partial<AgentRuntimeSession> = {}): AgentRuntimeSession {
  const now = "2026-06-03T00:00:00.000Z";
  return {
    id: "session_1",
    workspacePath: "D:/project",
    mode: "real_provider",
    requireRealProvider: true,
    trustProfile: "trusted_internal",
    executionMode: "simple_mode",
    accessProfile: "full_access",
    declaredAccess: { profile: "full_access", source: "user" },
    runPhases: [],
    decisionLedger: [],
    thinkFirst: false,
    userPrompt: "fix",
    agentName: "Hivo",
    status: "running",
    lifecycleStage: "THINK",
    taskState: {
      version: 1,
      phase: "planning",
      pendingCommandIds: [],
      completedCommandIds: [],
      failedCommandIds: [],
      transitions: []
    },
    messages: [],
    tasks: [],
    toolCalls: [],
    toolIntents: [],
    artifacts: [],
    patchProposals: [],
    commandRequests: [],
    commandExecutions: [],
    backgroundJobs: [],
    reasoningSummaries: [],
    progressEvents: [],
    agentWorkStatuses: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  } as AgentRuntimeSession;
}

function installEventSourceHarness(input: { failFirst: boolean; authResponse: () => Response }) {
  const originalEventSource = globalThis.EventSource;
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalRandom = Math.random;
  let eventSourceCount = 0;
  let fetchCount = 0;

  Math.random = () => 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 0),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer)
    }
  });
  globalThis.fetch = (async () => {
    fetchCount += 1;
    const response = input.authResponse();
    return response;
  }) as typeof fetch;
  globalThis.EventSource = class MockEventSource {
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(_url: string) {
      eventSourceCount += 1;
      const instanceNumber = eventSourceCount;
      globalThis.queueMicrotask(() => {
        if (input.failFirst && instanceNumber === 1) {
          this.onerror?.({} as Event);
        } else {
          this.onopen?.({} as Event);
        }
      });
    }

    addEventListener() {
      // The tests exercise connection state, not event decoding.
    }

    close() {
      // No-op for mock EventSource.
    }
  } as unknown as typeof EventSource;

  return {
    eventSourceCount: () => eventSourceCount,
    fetchCount: () => fetchCount,
    restore: () => {
      Math.random = originalRandom;
      globalThis.fetch = originalFetch;
      globalThis.EventSource = originalEventSource;
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow
      });
    }
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
}

function mockFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body
  } as Response;
}

async function withBrowserHarness<T>(fn: () => Promise<T>) {
  const previous = browserHarnessLock;
  let release!: () => void;
  browserHarnessLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}
