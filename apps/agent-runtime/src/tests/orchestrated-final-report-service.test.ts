import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession, PatchProposal, QualityGateResult } from "@hivo/protocol";
import { OrchestratedFinalReportService } from "../runtime/OrchestratedFinalReportService.js";

test("orchestrated final report summarizes proposed patches at approval boundary", () => {
  const service = new OrchestratedFinalReportService();
  const report = service.build({
    session: sessionWithPatches([
      patch("patch-a", "src/app.ts", "two"),
      patch("patch-b", "src/app.ts", "three")
    ]),
    qualityGates: [gate("ReviewerGate", "passed")],
    gatesPassed: true
  });

  assert.equal(report.runSummary.status, "completed");
  assert.equal(report.runSummary.summary, "I prepared 2 code change proposal(s) for review.");
  assert.deepEqual(report.runSummary.proposedPatchIds, ["patch-a", "patch-b"]);
  assert.equal(report.runSummary.filesChanged.length, 1);
  assert.equal(report.runSummary.filesChanged[0]?.path, "src/app.ts");
  assert.equal(report.runSummary.filesChanged[0]?.added, 2);
  assert.match(report.message, /Files proposed/);
  assert.match(report.message, /ReviewerGate: passed/);
});

test("orchestrated final report preserves blocked review gate reasons", () => {
  const service = new OrchestratedFinalReportService();
  const report = service.build({
    session: sessionWithPatches([patch("patch-a", "src/app.ts", "todo")]),
    qualityGates: [gate("ReviewerGate", "failed", ["placeholder content"])],
    gatesPassed: false
  });

  assert.equal(report.runSummary.status, "blocked");
  assert.equal(report.runSummary.summary, "I stopped before changing files because the review gates found blocking issues.");
  assert.deepEqual(report.runSummary.gates[0]?.notes, ["placeholder content"]);
  assert.match(report.message, /ReviewerGate: failed/);
});

function sessionWithPatches(patches: PatchProposal[]): AgentRuntimeSession {
  return ({
    id: "session-final-report",
    patchProposals: patches,
    commandExecutions: [],
    nextAction: {
      kind: "approve_patch",
      patchId: patches[0]?.id ?? "patch-a",
      message: "Review and approve the patch before Rust apply."
    }
  } as unknown) as AgentRuntimeSession;
}

function patch(id: string, filePath: string, addedLine: string): PatchProposal {
  return {
    id,
    sessionId: "session-final-report",
    title: `Patch ${id}`,
    summary: "Update file.",
    riskLevel: "low",
    filesChanged: [{
      path: filePath,
      changeType: "modify",
      explanation: "Update file."
    }],
    artifacts: [{ path: filePath, content: `one\n${addedLine}\n` }],
    unifiedDiff: [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,1 +1,2 @@",
      " one",
      `+${addedLine}`
    ].join("\n"),
    requiresApproval: true,
    status: "proposed",
    createdAt: new Date().toISOString()
  };
}

function gate(
  gateName: QualityGateResult["gateName"],
  status: QualityGateResult["status"],
  blockingReasons: string[] = []
): QualityGateResult {
  return {
    id: `gate-${gateName}`,
    sessionId: "session-final-report",
    gateName,
    status,
    blockingReasons,
    reviewerNotes: status === "passed" ? ["passed"] : [],
    createdAt: new Date().toISOString()
  };
}
