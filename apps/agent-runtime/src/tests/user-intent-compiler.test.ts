import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { UserIntentCompiler } from "../orchestration/UserIntentCompiler.js";

test("UserIntentCompiler saves a ready fixed intent contract when provider output is valid", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-ready-"));
  try {
    const originalRequest = "Implement a safe login form.";
    const artifactsPath = path.join(workspace, ".agent_memory", "runs", "run_ready");
    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_ready",
      runKind: "core",
      artifactsPath,
      originalRequest,
      provider: new IntentContractProvider({ originalRequest })
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.equal(result.contract.original_user_request, originalRequest);
    assert.equal(result.contract.revision, 1);
    assert.equal(existsSync(path.join(artifactsPath, "intent", "intent_contract.json")), true);
    assert.equal(existsSync(path.join(artifactsPath, "intent", "intent_contract.md")), true);
    assert.equal(existsSync(path.join(artifactsPath, "intent", "intent_contract_revisions.jsonl")), true);

    const saved = JSON.parse(await readFile(path.join(artifactsPath, "intent", "intent_contract.json"), "utf8")) as IntentContract;
    assert.equal(saved.contract_id, result.contract.contract_id);
    assert.equal(saved.priorities.security.score, 90);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler marks blocking missing questions as needs_clarification", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-clarify-"));
  try {
    const originalRequest = "Build the integration.";
    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_clarify",
      runKind: "core",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_clarify"),
      originalRequest,
      provider: new IntentContractProvider({
        originalRequest,
        missing_questions: [{
          question: "Which external API should the integration target?",
          reason: "Planning would choose different files and auth behavior depending on the API.",
          blocking: true
        }]
      })
    });

    assert.equal(result.ready, false);
    assert.equal(result.contract.status, "needs_clarification");
    assert.deepEqual(result.blockingQuestions, ["Which external API should the integration target?"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler marks incomplete priorities as invalid", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-invalid-"));
  try {
    const originalRequest = "Refactor the cache.";
    const output = validIntentOutput(originalRequest);
    delete (output.priorities as Record<string, unknown>).cost;
    const provider = new IntentContractProvider({ originalRequest, output });
    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_invalid",
      runKind: "core",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_invalid"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, false);
    assert.equal(result.contract.status, "invalid");
    assert.equal(provider.requests.length, 3);
    assert.equal(provider.requests[1]?.purpose, "repair");
    assert.equal(provider.requests[2]?.purpose, "repair");
    assert.equal(result.contract.metadata_json.provider_repair_attempted, true);
    assert.equal(result.contract.metadata_json.provider_repair_attempt_count, 2);
    assert.equal(result.contract.metadata_json.provider_repair_succeeded, false);
    assert.equal(result.validationErrors.some((error) => error.includes("priorities.cost")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler repairs an invalid provider contract with a second provider-authored pass", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-repair-"));
  try {
    const originalRequest = "create a 3d sanke game with three js ";
    const invalidOutput = {
      original_user_request: originalRequest,
      priorities: validIntentOutput(originalRequest).priorities
    };
    const provider = new IntentContractProvider({
      originalRequest,
      outputs: [invalidOutput, validIntentOutput(originalRequest)]
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_repair",
      runKind: "core",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_repair"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0]?.purpose, "route");
    assert.equal(provider.requests[1]?.purpose, "repair");
    assert.equal(result.contract.metadata_json.provider_repair_attempted, true);
    assert.equal(result.contract.metadata_json.provider_repair_succeeded, true);
    assert.deepEqual(result.validationErrors, []);
    const initialErrors = result.contract.metadata_json.initial_validation_errors;
    assert.equal(Array.isArray(initialErrors), true);
    assert.equal((initialErrors as string[]).some((error) => error.includes("precise_rewrite")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler normalizes provider-equivalent question and tradeoff shapes", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-shape-normalize-"));
  try {
    const originalRequest = "Build a feature-complete Three.js game.";
    const output = {
      ...validIntentOutput(originalRequest),
      missing_questions: [{
        question: "Which port should the local development server use, or may the system choose any available port?",
        blocking: true
      }],
      tradeoffs: ["quality over speed", "fun over realism"]
    };
    const provider = new IntentContractProvider({
      originalRequest,
      output
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_shape_normalize",
      runKind: "core",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_shape_normalize"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.equal(provider.requests.length, 1);
    assert.equal(result.contract.missing_questions[0]?.blocking, false);
    assert.equal(result.contract.missing_questions[0]?.reason, "Provider did not explain this missing question.");
    assert.equal(result.contract.tradeoffs[0]?.name, "quality over speed");
    assert.deepEqual(result.validationErrors, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler treats testing framework choice as a safe default question", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-test-framework-default-"));
  try {
    const originalRequest = "Build a feature-complete Three.js game with focused tests.";
    const output = {
      ...validIntentOutput(originalRequest),
      missing_questions: [{
        question: "Which testing framework do you prefer (e.g., Jest, Mocha)?",
        reason: "The provider thinks a framework preference could affect implementation.",
        blocking: true
      }]
    };
    const provider = new IntentContractProvider({
      originalRequest,
      output
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_test_framework_default",
      runKind: "swarm",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_test_framework_default"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.deepEqual(result.blockingQuestions, []);
    assert.equal(result.contract.missing_questions[0]?.blocking, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler treats internal agent count preference as a safe default question", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-agent-count-default-"));
  try {
    const originalRequest = "Use multi-agent orchestration and automatically choose the number of agents.";
    const output = {
      ...validIntentOutput(originalRequest),
      missing_questions: [{
        question: "Is there a preferred maximum number of internal agents or a budget constraint?",
        reason: "The provider thinks staffing could affect cost.",
        blocking: true
      }]
    };
    const provider = new IntentContractProvider({
      originalRequest,
      output
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_agent_count_default",
      runKind: "swarm",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_agent_count_default"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.deepEqual(result.blockingQuestions, []);
    assert.equal(result.contract.missing_questions[0]?.blocking, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler treats browser/device support as a safe default question", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-browser-device-default-"));
  try {
    const originalRequest = "Build a browser Three.js game.";
    const output = {
      ...validIntentOutput(originalRequest),
      missing_questions: [{
        question: "Which browsers or devices should be officially supported?",
        reason: "The provider thinks official support could affect implementation.",
        blocking: true
      }]
    };
    const provider = new IntentContractProvider({
      originalRequest,
      output
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_browser_device_default",
      runKind: "swarm",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_browser_device_default"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.deepEqual(result.blockingQuestions, []);
    assert.equal(result.contract.missing_questions[0]?.blocking, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler treats runtime environment choice as a safe default question", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-runtime-default-"));
  try {
    const originalRequest = "Run this existing Vite project again.";
    const output = {
      ...validIntentOutput(originalRequest),
      missing_questions: [{
        question: "Which specific runtime environment or interpreter should be used for the execution?",
        reason: "The provider thinks a runtime choice could affect command selection.",
        blocking: true
      }]
    };
    const provider = new IntentContractProvider({
      originalRequest,
      output
    });

    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_runtime_default",
      runKind: "core",
      artifactsPath: path.join(workspace, ".agent_memory", "runs", "run_runtime_default"),
      originalRequest,
      provider
    });

    assert.equal(result.ready, true);
    assert.equal(result.contract.status, "ready");
    assert.deepEqual(result.blockingQuestions, []);
    assert.equal(result.contract.missing_questions[0]?.blocking, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UserIntentCompiler saves provider_unavailable shell without a provider", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-compiler-unavailable-"));
  try {
    const originalRequest = "Patch the dashboard.";
    const artifactsPath = path.join(workspace, ".agent_memory", "runs", "run_unavailable");
    const result = await new UserIntentCompiler().compile({
      workspacePath: workspace,
      runId: "run_unavailable",
      runKind: "core",
      artifactsPath,
      originalRequest
    });

    assert.equal(result.ready, false);
    assert.equal(result.contract.status, "provider_unavailable");
    assert.equal(result.contract.original_user_request, originalRequest);
    assert.equal(result.contract.missing_questions[0]?.blocking, true);
    assert.equal(existsSync(path.join(artifactsPath, "intent", "intent_contract.json")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class IntentContractProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly options: {
    originalRequest: string;
    missing_questions?: IntentContract["missing_questions"];
    output?: unknown;
    outputs?: unknown[];
  }) {}

  async generateStructured<T>(input: LlmRequest): Promise<T> {
    assert.equal(input.purpose === "route" || input.purpose === "repair", true);
    this.requests.push(input);
    if (this.options.outputs?.length) {
      const output = this.options.outputs[Math.min(this.requests.length - 1, this.options.outputs.length - 1)];
      return output as T;
    }
    return (this.options.output ?? validIntentOutput(this.options.originalRequest, this.options.missing_questions)) as T;
  }

  async generateText(): Promise<string> {
    return "{}";
  }
}

function validIntentOutput(originalRequest: string, missingQuestions: IntentContract["missing_questions"] = []) {
  return {
    original_user_request: originalRequest,
    precise_rewrite: `${originalRequest} Keep changes minimal and verifiable.`,
    assumptions: ["The current repository contains the target implementation."],
    missing_questions: missingQuestions,
    tradeoffs: [{
      name: "speed_vs_quality",
      options: ["ship quickly", "add focused tests"],
      preferred: "add focused tests",
      rationale: "The request touches code behavior."
    }],
    priorities: {
      speed: { score: 55, rationale: "Keep the first slice small." },
      quality: { score: 85, rationale: "Correctness matters for code changes." },
      realism: { score: 80, rationale: "Use repository evidence." },
      fun: { score: 20, rationale: "Not a playful request." },
      security: { score: 90, rationale: "Preserve safety gates." },
      cost: { score: 50, rationale: "Avoid unnecessary provider work." }
    },
    definition_of_done: ["A focused plan or patch satisfies the request.", "Relevant checks are reported."],
    non_goals: ["Do not rewrite unrelated modules."],
    conflict_rules: ["Safety and explicit non-goals override speed."]
  };
}
