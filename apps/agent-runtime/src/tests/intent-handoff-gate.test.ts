import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import {
  createAlignmentFromFrame,
  createLegacyIntentInputFrame,
  IntentHandoffGate
} from "../orchestration/index.js";

test("intent handoff gate passes output anchored to original prompt contract and task slice", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-handoff-pass-"));
  try {
    const contract = readyContract("session_pass", "Explain src/index.ts without changing files.");
    const frame = createLegacyIntentInputFrame({
      sessionId: "session_pass",
      intentContract: contract,
      role: "ReviewerAgent",
      taskId: "task_review",
      objective: "Review read-only explanation artifacts.",
      expectedOutputSchema: "WorkerOutput"
    });
    const alignment = createAlignmentFromFrame(frame);
    const gate = await new IntentHandoffGate({ workspacePath: workspace }).evaluate({
      runId: "session_pass",
      runKind: "runtime_session",
      artifactsPath: path.join(workspace, ".agent_memory", "runtime_intents", "session_pass"),
      layer: "legacy_orchestrated",
      taskId: "task_review",
      frame,
      alignment,
      candidate: { summary: "Reviewed without edits.", intentAlignment: alignment },
      reviewedArtifactRefs: ["artifact:review"]
    });

    assert.equal(gate.status, "passed");
    assert.equal(gate.passed, true);
    assert.equal(existsSync(gate.artifact_ref ?? ""), true);
    assert.equal(existsSync(gate.frame_ref ?? ""), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("intent handoff gate blocks output without explicit intent alignment", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-handoff-block-"));
  try {
    const contract = readyContract("session_block", "Only explain src/index.ts. Do not edit files.");
    const frame = createLegacyIntentInputFrame({
      sessionId: "session_block",
      intentContract: contract,
      role: "FrontendAgent",
      taskId: "task_frontend",
      objective: "Prepare a frontend patch.",
      expectedOutputSchema: "WorkerOutput"
    });
    const gate = await new IntentHandoffGate({ workspacePath: workspace }).evaluate({
      runId: "session_block",
      runKind: "runtime_session",
      artifactsPath: path.join(workspace, ".agent_memory", "runtime_intents", "session_block"),
      layer: "legacy_orchestrated",
      taskId: "task_frontend",
      frame,
      alignment: undefined,
      candidate: { summary: "Prepared a patch without alignment." },
      reviewedArtifactRefs: ["artifact:frontend"]
    });

    assert.equal(gate.status, "blocked");
    assert.equal(gate.passed, false);
    assert.ok(gate.deterministic_errors.some((error) => /intent_alignment is required/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("intent handoff gate treats insufficient provider context as non-blocking for read-only swarm handoffs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-handoff-swarm-readonly-"));
  try {
    const contract = readyContract("session_swarm_readonly", "Scout files before creating a browser game.");
    const baseFrame = createLegacyIntentInputFrame({
      sessionId: "session_swarm_readonly",
      intentContract: contract,
      role: "ScoutAgent",
      taskId: "swarm_scout",
      objective: "Scout current files without edits.",
      expectedOutputSchema: "ScoutResult"
    });
    const frame = { ...baseFrame, layer: "swarm" as const };
    const alignment = createAlignmentFromFrame(frame);
    const gate = await new IntentHandoffGate({
      workspacePath: workspace,
      provider: new IntentReviewStatusProvider("insufficient_context")
    }).evaluate({
      runId: "session_swarm_readonly",
      runKind: "runtime_session",
      artifactsPath: path.join(workspace, ".agent_memory", "runtime_intents", "session_swarm_readonly"),
      layer: "swarm",
      taskId: "swarm_scout",
      frame,
      alignment,
      candidate: { summary: "Scouted files only.", intentAlignment: alignment },
      reviewedArtifactRefs: ["artifact:scout"]
    });

    assert.equal(gate.status, "passed");
    assert.equal(gate.provider_status, "insufficient_context");
    assert.deepEqual(gate.deterministic_errors, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("intent handoff gate still blocks insufficient provider context for write-capable swarm handoffs", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "intent-handoff-swarm-write-"));
  try {
    const contract = readyContract("session_swarm_write", "Create a browser game.");
    const baseFrame = createLegacyIntentInputFrame({
      sessionId: "session_swarm_write",
      intentContract: contract,
      role: "ExecutorAgent",
      taskId: "swarm_execute",
      objective: "Edit src/main.js.",
      writeFiles: ["src/main.js"],
      expectedOutputSchema: "ExecutorOutput"
    });
    const frame = { ...baseFrame, layer: "swarm" as const };
    const alignment = createAlignmentFromFrame(frame);
    const gate = await new IntentHandoffGate({
      workspacePath: workspace,
      provider: new IntentReviewStatusProvider("insufficient_context")
    }).evaluate({
      runId: "session_swarm_write",
      runKind: "runtime_session",
      artifactsPath: path.join(workspace, ".agent_memory", "runtime_intents", "session_swarm_write"),
      layer: "swarm",
      taskId: "swarm_execute",
      frame,
      alignment,
      candidate: { summary: "Prepared write output.", intentAlignment: alignment },
      reviewedArtifactRefs: ["artifact:execute"]
    });

    assert.equal(gate.status, "blocked");
    assert.ok(gate.deterministic_errors.some((error) => /insufficient_context/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function readyContract(runId: string, request: string): IntentContract {
  return {
    schema_version: 1,
    contract_id: `intent_contract_${runId}`,
    run_id: runId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: request,
    precise_rewrite: request,
    assumptions: ["Fixture intent is explicit."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced fixture." },
      quality: { score: 90, rationale: "Intent preservation is required." },
      realism: { score: 70, rationale: "Use real gate artifacts." },
      fun: { score: 0, rationale: "Not relevant." },
      security: { score: 80, rationale: "Do not bypass gates." },
      cost: { score: 40, rationale: "Keep fixture small." }
    },
    definition_of_done: ["Gate result is recorded."],
    non_goals: ["Do not infer missing alignment."],
    conflict_rules: ["The original request overrides downstream summaries."],
    status: "ready",
    artifact_ref: `.agent_memory/runtime_intents/${runId}/intent/intent_contract.json`,
    summary_ref: `.agent_memory/runtime_intents/${runId}/intent/intent_contract.md`,
    created_at: new Date().toISOString(),
    metadata_json: {}
  };
}

class IntentReviewStatusProvider implements LlmProvider {
  constructor(private readonly status: "aligned" | "possible_drift" | "drift_detected" | "insufficient_context") {}

  async generateStructured<T>(): Promise<T> {
    return {
      status: this.status,
      rationale: `Fixture review status: ${this.status}.`,
      findings: [{
        finding_type: this.status,
        severity: this.status === "aligned" ? "info" : "warning",
        rationale: `Fixture review status: ${this.status}.`,
        evidence_refs: [],
        recommended_action: this.status === "aligned" ? "allow" : "review_manually"
      }]
    } as T;
  }

  async generateText(): Promise<string> {
    return "";
  }
}
