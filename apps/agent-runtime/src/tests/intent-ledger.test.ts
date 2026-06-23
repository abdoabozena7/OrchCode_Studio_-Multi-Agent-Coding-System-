import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import {
  CoreOrchestrator,
  IntentLedgerService,
  type IntentReviewStatus
} from "../orchestration/index.js";
import { writeJson } from "../memory/ProjectMemory.js";

test("intent ledger reviewer records aligned drift and provider-unavailable states", async () => {
  const workspace = await fixtureWorkspace("intent-ledger-reviewer");
  try {
    const runId = "run_intent_reviewer";
    const artifactsPath = path.join(workspace, ".agent_memory", "runs", runId);
    const ledger = new IntentLedgerService({ workspacePath: workspace });
    const original = await ledger.saveOriginalRequest({
      runId,
      runKind: "core",
      artifactsPath,
      originalRequest: "Only explain src/index.ts. Do not edit files."
    });
    assert.equal(existsSync(original.artifact_ref), true);
    assert.equal(existsSync(original.summary_ref), true);

    const unavailable = await ledger.reviewIntent({
      runId,
      runKind: "core",
      artifactsPath,
      stage: "initial",
      reviewedArtifactRefs: ["task_graph.json"],
      candidate: { plan: "Explain src/index.ts" }
    });
    assert.equal(unavailable.status, "insufficient_context");
    assert.equal(unavailable.provider_used, false);

    const aligned = await ledger.reviewIntent({
      runId,
      runKind: "core",
      artifactsPath,
      stage: "initial",
      reviewedArtifactRefs: ["task_graph.json"],
      candidate: { plan: "Explain src/index.ts" },
      provider: new IntentReviewProvider("aligned")
    });
    assert.equal(aligned.status, "aligned");
    assert.equal(aligned.provider_used, true);

    const drift = await ledger.reviewIntent({
      runId,
      runKind: "core",
      artifactsPath,
      stage: "final",
      target: "final_report",
      reviewedArtifactRefs: ["final_report.json"],
      candidate: { output: "Edited src/index.ts" },
      provider: new IntentReviewProvider("drift_detected")
    });
    assert.equal(drift.status, "drift_detected");
    assert.equal(drift.findings.some((finding) => finding.finding_type === "drift_detected"), true);
    assert.equal(existsSync(drift.rewrite_suggestion_ref ?? ""), true);
    const suggestion = JSON.parse(await readFile(drift.rewrite_suggestion_ref!, "utf8")) as {
      status?: string;
      target?: string;
      rewritten_output_summary?: string;
      smarter_solution?: string;
    };
    assert.equal(suggestion.status, "suggested");
    assert.equal(suggestion.target, "final_report");
    assert.match(`${suggestion.rewritten_output_summary ?? ""} ${suggestion.smarter_solution ?? ""}`, /without editing|read-only/i);

    const snapshot = await ledger.loadContext(runId, "core", artifactsPath);
    assert.equal(snapshot.original_request_hash, original.request_hash);
    assert.equal(snapshot.latest_review?.review_id, drift.review_id);
    assert.ok(snapshot.intent_ledger_refs.some((ref) => ref.endsWith("intent_ledger.json")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Core plan-only run records original request refs and final intent review summary", async () => {
  const workspace = await fixtureWorkspace("intent-core-run");
  try {
    const result = await new CoreOrchestrator({
      workspacePath: workspace,
      providerFactory: () => new IntentReviewProvider("aligned"),
      config: {
        memory_path: ".agent_memory",
        enable_multi_plan_factory: false,
        enable_team_sub_planning: false,
        prompt_writer_mode: "off"
      }
    }).planOnly("Explain src/index.ts without changing files.");

    assert.equal(existsSync(result.run.original_request_ref ?? ""), true);
    assert.equal(existsSync(result.run.intent_ledger_ref ?? ""), true);
    assert.equal(existsSync(result.run.intent_contract_ref ?? ""), true);
    assert.equal(result.run.intent_contract_status, "ready");
    assert.equal(result.report.intent_review_used, true);
    assert.equal(result.report.intent_alignment_status, "aligned");
    assert.equal(result.report.intent_drift_count, 0);
    assert.equal(result.report.original_request_ref, result.run.original_request_ref);
    assert.equal(result.report.intent_ledger_ref, result.run.intent_ledger_ref);
    assert.equal(result.report.intent_contract_ref, result.run.intent_contract_ref);
    assert.equal(existsSync(result.report.intent_review_ref ?? ""), true);

    const original = JSON.parse(await readFile(result.run.original_request_ref!, "utf8")) as { original_request?: string; source?: string };
    assert.equal(original.source, "user");
    assert.match(original.original_request ?? "", /Explain src\/index\.ts/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class IntentReviewProvider implements LlmProvider {
  constructor(private readonly status: IntentReviewStatus) {}

  async generateStructured<T>(input: LlmRequest): Promise<T> {
    if (input.purpose === "route") {
      const context = input.context as { original_user_request?: string } | undefined;
      return readyIntentContractOutput(context?.original_user_request ?? "unknown request") as T;
    }
    if (input.reasoningStage === "repair") {
      return {
        target: "final_report",
        rationale: "Rewrite the drifting result with the original read-only intent and parent context.",
        rewritten_output_summary: "Explain src/index.ts only, preserve the no-edit intent, and report that no files should be changed.",
        smarter_solution: "Escalate to the parent orchestrator for more context if any worker proposes edits; keep the repaired path read-only.",
        additional_context_needed: ["parent_orchestrator_task_graph", "main_memory_goal"],
        parent_context_refs: ["parent:core-orchestrator"]
      } as T;
    }
    assert.equal(input.purpose, "verify");
    return {
      status: this.status,
      rationale: `Provider classified the candidate as ${this.status}.`,
      findings: [{
        severity: this.status === "drift_detected" ? "warning" : "info",
        finding_type: this.status,
        rationale: `Synthetic ${this.status} finding.`,
        evidence_refs: ["task_graph.json"],
        recommended_action: this.status === "drift_detected" ? "review_manually" : "allow"
      }]
    } as T;
  }

  async generateText(): Promise<string> {
    return "{}";
  }
}

function readyIntentContractOutput(originalRequest: string) {
  return {
    original_user_request: originalRequest,
    precise_rewrite: originalRequest,
    assumptions: ["The workspace contains the files needed for the request."],
    missing_questions: [],
    tradeoffs: [{
      name: "scope_vs_speed",
      options: ["narrow answer", "broader inspection"],
      preferred: "narrow answer",
      rationale: "The test fixture asks for a focused plan-only run."
    }],
    priorities: {
      speed: { score: 50, rationale: "Plan-only run should stay focused." },
      quality: { score: 80, rationale: "The plan should preserve intent." },
      realism: { score: 70, rationale: "Use repository context." },
      fun: { score: 10, rationale: "Not relevant to this request." },
      security: { score: 80, rationale: "No direct writes by workers." },
      cost: { score: 50, rationale: "Avoid unnecessary work." }
    },
    definition_of_done: ["A plan-only artifact is produced without changing files."],
    non_goals: ["Do not edit workspace files."],
    conflict_rules: ["The original request and no-edit constraint override speculative implementation."]
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  });
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}
