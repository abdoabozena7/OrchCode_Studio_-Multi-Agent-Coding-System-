import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, PatchProposal, RecursiveBranchExecutionRecord } from "@hivo/protocol";
import {
  buildRecursiveBranchResults,
  buildRecursiveBranchValidationRecords,
  buildRecursiveFinalReport,
  buildRecursiveIntegrationSummary
} from "../runtime/RecursiveFanInReportBuilders.js";

test("recursive fan-in report builders create passed final report with patch provenance", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-recursive-fan-in-builders-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src/module.ts"), "export function value() { return 'after'; }\n");
  const session = runtimeSession(workspace);

  try {
    const branchResults = buildRecursiveBranchResults(session);
    const branchValidations = buildRecursiveBranchValidationRecords(session, branchResults);
    const integration = buildRecursiveIntegrationSummary(session, branchResults, branchValidations);
    const finalReport = buildRecursiveFinalReport(session, branchResults, integration, branchValidations);

    assert.equal(branchResults.length, 1);
    assert.equal(branchResults[0]?.appliedState, "applied");
    assert.equal(branchValidations[0]?.status, "passed");
    assert.equal(integration.validation.status, "passed");
    assert.equal(finalReport.finalStatus, "passed");
    assert.equal(finalReport.patchProvenance.length, 1);
    assert.equal(finalReport.patchProvenance[0]?.filesChanged[0], "src/module.ts");
    assert.ok(finalReport.patchProvenance[0]?.touchedSymbols.some((symbol) => symbol.name === "value"));
    assert.ok(finalReport.patchProvenance[0]?.fileHashes[0]?.afterHash);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function runtimeSession(workspacePath: string): AgentRuntimeSession {
  const now = new Date().toISOString();
  return ({
    id: "session-fan-in-builders",
    workspacePath,
    userPrompt: "Build recursively",
    patchProposals: [patchProposal(now)],
    commandExecutions: [{
      id: "exec-test",
      sessionId: "session-fan-in-builders",
      autoRun: false,
      command: "npm test",
      cwd: workspacePath,
      risk: "safe",
      status: "executed",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      message: "passed",
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        executionAuthority: "rust"
      },
      createdAt: now
    }],
    artifacts: [],
    recursiveFactory: {
      phase: "branch_execution_completed",
      executionStarted: true,
      productSpec: {
        id: "product-1",
        sessionId: "session-fan-in-builders",
        revision: 1,
        userGoal: "Build recursively",
        acceptanceCriteria: [],
        constraints: [],
        assumptions: [],
        openQuestions: [],
        status: "approved",
        createdAt: now,
        updatedAt: now
      },
      technicalPlan: {
        id: "plan-1",
        sessionId: "session-fan-in-builders",
        revision: 1,
        summary: "Plan summary",
        implementationSteps: [],
        validationCommands: ["npm test"],
        risks: [],
        status: "approved",
        createdAt: now,
        updatedAt: now
      },
      recursiveGraph: {
        id: "graph-1",
        sessionId: "session-fan-in-builders",
        rootGoal: "Build recursively",
        branches: [],
        conflicts: [],
        status: "approved",
        createdAt: now,
        updatedAt: now
      },
      branchOrchestrators: [{
        branchId: "branch-a",
        sessionId: "session-fan-in-builders",
        title: "Branch A",
        objective: "Update module",
        ownerRole: "Runtime",
        fileScopes: ["src/module.ts"],
        semanticScopes: ["runtime"],
        lockScopes: ["file:src/module.ts"],
        dependencies: [],
        inputContextRequirements: [],
        validationStrategy: ["npm test"],
        risks: [],
        status: "completed",
        createdAt: now,
        updatedAt: now
      }],
      branchExecutions: [branchExecution(now)],
      branchScopeConflicts: [],
      semanticConflictDecisions: [],
      updatedAt: now
    }
  } as unknown) as AgentRuntimeSession;
}

function branchExecution(now: string): RecursiveBranchExecutionRecord {
  return {
    branchId: "branch-a",
    sessionId: "session-fan-in-builders",
    title: "Branch A",
    status: "completed",
    active: false,
    executionContext: {
      branchObjective: "Update module",
      approvedProductSpecSummary: "Build recursively",
      approvedTechnicalPlanSummary: "Plan summary",
      fileScopes: ["src/module.ts"],
      semanticScopes: ["runtime"],
      lockScopes: ["file:src/module.ts"],
      dependencies: [],
      evidenceContextPack: []
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: true
    },
    proposedPatchId: "patch-a",
    reviewStatus: "approved",
    validationStatus: "verified_passed",
    validationPlan: ["npm test"],
    patchApplied: true,
    createdAt: now,
    updatedAt: now
  };
}

function patchProposal(now: string): PatchProposal {
  const before = "export function value() { return 'before'; }";
  const after = "export function value() { return 'after'; }";
  return {
    id: "patch-a",
    sessionId: "session-fan-in-builders",
    title: "Patch A",
    summary: "Update module",
    riskLevel: "low",
    filesChanged: [{
      path: "src/module.ts",
      changeType: "modify",
      explanation: "test"
    }],
    artifacts: [{ path: "src/module.ts", content: `${after}\n` }],
    unifiedDiff: [
      "diff --git a/src/module.ts b/src/module.ts",
      "--- a/src/module.ts",
      "+++ b/src/module.ts",
      "@@ -1,1 +1,1 @@",
      `-${before}`,
      `+${after}`
    ].join("\n"),
    requiresApproval: true,
    status: "applied",
    createdAt: now,
    lastStatusAt: now,
    appliedAt: now
  };
}
