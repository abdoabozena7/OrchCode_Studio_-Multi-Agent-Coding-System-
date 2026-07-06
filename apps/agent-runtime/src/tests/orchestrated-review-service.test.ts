import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRequest, PatchProposal, ReviewResult, WorkerOutput } from "@hivo/protocol";
import { OrchestratedReviewService } from "../runtime/OrchestratedReviewService.js";
import type { BranchBankruptcyError } from "../orchestration/CircuitBreaker.js";

test("orchestrated review service passes clean security reviewer and quality gates", async () => {
  const service = new OrchestratedReviewService(cleanSecurity(), cleanReviewer());

  const outcome = await service.review({
    sessionId: "session-review",
    prompt: "Update the app",
    patches: [patchProposal()],
    commands: [],
    outputs: [workerOutput()],
    bankruptcyErrors: [],
    canonicalBlockingReasons: []
  });

  assert.equal(outcome.gatesPassed, true);
  assert.equal(outcome.securityReview.status, "passed");
  assert.equal(outcome.reviewerSummary.status, "passed");
  assert.deepEqual(outcome.qualityGates.map((gate) => [gate.gateName, gate.status]), [
    ["ReviewerGate", "passed"],
    ["SecurityGate", "passed"],
    ["TestGate", "passed"]
  ]);
});

test("orchestrated review service blocks missing patches and bankruptcy findings", async () => {
  const service = new OrchestratedReviewService(cleanSecurity(), cleanReviewer());

  const outcome = await service.review({
    sessionId: "session-review",
    prompt: "Update the app",
    patches: [],
    commands: [],
    outputs: [workerOutput()],
    bankruptcyErrors: [bankruptcy()],
    canonicalBlockingReasons: []
  });

  assert.equal(outcome.gatesPassed, false);
  const reviewerGate = outcome.qualityGates.find((gate) => gate.gateName === "ReviewerGate");
  const testGate = outcome.qualityGates.find((gate) => gate.gateName === "TestGate");
  assert.match(reviewerGate?.blockingReasons.join("\n") ?? "", /No patch proposal was produced/);
  assert.match(reviewerGate?.blockingReasons.join("\n") ?? "", /Bankruptcy: WorkerAgent - repeated output/);
  assert.equal(testGate?.status, "failed");
});

test("orchestrated review service preserves canonical graph blockers as deterministic gate findings", async () => {
  const service = new OrchestratedReviewService(cleanSecurity(), cleanReviewer());

  const outcome = await service.review({
    sessionId: "session-review",
    prompt: "Update the app",
    patches: [patchProposal()],
    commands: [],
    outputs: [workerOutput()],
    bankruptcyErrors: [],
    canonicalBlockingReasons: ["Task task-b depends on missing task task-a."]
  });

  assert.equal(outcome.gatesPassed, false);
  const reviewerGate = outcome.qualityGates.find((gate) => gate.gateName === "ReviewerGate");
  assert.match(reviewerGate?.blockingReasons.join("\n") ?? "", /Canonical graph blocked: Task task-b depends on missing task task-a/);
});

test("orchestrated review service blocks default adversarial review when no provider is configured", async () => {
  const service = new OrchestratedReviewService(cleanSecurity());

  const outcome = await service.review({
    sessionId: "session-review",
    prompt: "Update the app",
    patches: [patchProposal()],
    commands: [],
    outputs: [workerOutput()],
    bankruptcyErrors: [],
    canonicalBlockingReasons: []
  });

  assert.equal(outcome.gatesPassed, false);
  assert.equal(outcome.reviewerSummary.status, "blocked");
  assert.match(outcome.reviewerSummary.summary, /Provider adversarial review blocked/);
  const reviewerGate = outcome.qualityGates.find((gate) => gate.gateName === "ReviewerGate");
  assert.match(reviewerGate?.blockingReasons.join("\n") ?? "", /No provider configured for adversarial review/);
});

function cleanSecurity() {
  return {
    review(sessionId: string, patches: PatchProposal[], commands: CommandRequest[]): ReviewResult {
      return {
        id: "security-review",
        sessionId,
        reviewer: "SecurityAgent",
        targetIds: [...patches.map((patch) => patch.id), ...commands.map((command) => command.id)],
        status: "passed",
        summary: "Security passed.",
        findings: [],
        createdAt: new Date().toISOString()
      };
    }
  };
}

function cleanReviewer() {
  return {
    async reviewAdversarial(
      sessionId: string,
      patches: PatchProposal[],
      outputs: WorkerOutput[],
      conflictFindings: string[]
    ): Promise<ReviewResult> {
      return {
        id: "reviewer-review",
        sessionId,
        reviewer: "ReviewerAgent",
        targetIds: [...patches.map((patch) => patch.id), ...outputs.map((output) => output.id)],
        status: conflictFindings.length ? "needs_changes" : "passed",
        summary: "Reviewer completed.",
        findings: conflictFindings,
        createdAt: new Date().toISOString()
      };
    }
  };
}

function patchProposal(): PatchProposal {
  return {
    id: "patch-a",
    sessionId: "session-review",
    title: "Patch A",
    summary: "Update app.",
    riskLevel: "low",
    filesChanged: [{
      path: "src/app.ts",
      changeType: "modify",
      explanation: "Update app."
    }],
    artifacts: [{ path: "src/app.ts", content: "export const value = 1;\n" }],
    unifiedDiff: "diff --git a/src/app.ts b/src/app.ts\n",
    requiresApproval: true,
    status: "proposed",
    createdAt: new Date().toISOString()
  };
}

function workerOutput(): WorkerOutput {
  return {
    id: "output-a",
    sessionId: "session-review",
    taskId: "task-a",
    agentName: "WorkerAgent",
    summary: "Done.",
    details: ["Updated app."],
    patchProposalIds: ["patch-a"],
    commandRequestIds: [],
    risks: [],
    selfCheck: {
      workOrderId: "work-a",
      passedCriteria: ["implemented"],
      failedCriteria: [],
      missingItems: [],
      confidence: 0.9
    },
    intentHandoffGate: {
      schema_version: 1,
      gate_id: "gate-a",
      run_id: "run-a",
      task_id: "task-a",
      layer: "legacy_orchestrated",
      passed: true,
      status: "passed",
      deterministic_errors: [],
      provider_used: false,
      reviewed_artifact_refs: [],
      created_at: new Date().toISOString(),
      metadata_json: {}
    },
    status: "completed",
    createdAt: new Date().toISOString()
  };
}

function bankruptcy(): BranchBankruptcyError {
  return {
    kind: "branch_bankruptcy",
    branch_id: "task-a",
    agent_name: "WorkerAgent",
    reason: "duplicate_output_detected",
    attempt_count: 3,
    max_bankruptcy_attempts: 3,
    repair_rounds: 0,
    max_repair_rounds: 1,
    last_error: "repeated output",
    fingerprint_history: ["same"],
    reported_at: new Date().toISOString()
  };
}
