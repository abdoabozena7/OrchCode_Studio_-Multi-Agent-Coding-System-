import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  RecursiveFinalReport,
  RecursiveRepairRecord
} from "@hivo/protocol";
import { RecursiveRepairPlanningService } from "../runtime/RecursiveRepairPlanningService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive repair planning diagnoses eligible failures and delegates patch proposal", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession(workspace, rustFailureOutput("src/module.mjs"));
  const manager = new FakeSessionManager(session);
  let proposedRepair: RecursiveRepairRecord | undefined;
  const service = new RecursiveRepairPlanningService(manager.asSessionManager(), {
    proposeRepairPatch: async (_sessionId, _finalReport, repair) => {
      proposedRepair = repair;
      return {
        ...repair,
        status: "patch_proposed",
        attemptCount: repair.attemptCount + 1,
        repairPatchId: "patch-repair",
        repairPatchStatus: "proposed",
        summary: "patch proposed",
        updatedAt: new Date().toISOString()
      };
    },
    summarizeOutput: summarize
  });

  try {
    const report = await service.prepare(session.id, failedFinalReport(session.id, workspace));

    assert.equal(proposedRepair?.status, "diagnosed");
    assert.equal(proposedRepair?.eligibility.status, "eligible");
    assert.deepEqual(proposedRepair?.eligibility.relatedFiles, ["src/module.mjs"]);
    assert.equal(proposedRepair?.diagnosis.attribution.confidence, "high");
    assert.equal(proposedRepair?.validationAttempts[0]?.truthStatus, "verified_failed");
    assert.equal(report.repair?.status, "patch_proposed");
    assert.equal(report.repair?.repairPatchId, "patch-repair");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive repair planning records ineligible weak attribution without proposing a patch", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession(workspace, "AssertionError: unrelated failure\n");
  const manager = new FakeSessionManager(session);
  let proposalCalls = 0;
  const service = new RecursiveRepairPlanningService(manager.asSessionManager(), {
    proposeRepairPatch: async (_sessionId, _finalReport, repair) => {
      proposalCalls += 1;
      return repair;
    },
    summarizeOutput: summarize
  });

  try {
    const report = await service.prepare(session.id, failedFinalReport(session.id, workspace));

    assert.equal(proposalCalls, 0);
    assert.equal(report.repair?.status, "repair_not_attempted");
    assert.equal(report.repair?.eligibility.status, "repair_not_attempted");
    assert.match(report.repair?.summary ?? "", /Repair not attempted/);
    assert.equal(report.repair?.diagnosis.attribution.confidence, "none");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class FakeSessionManager {
  constructor(private readonly session: AgentRuntimeSession) {}

  asSessionManager(): SessionManager {
    return this as unknown as SessionManager;
  }

  getSession(sessionId: string) {
    return this.session.id === sessionId ? this.session : undefined;
  }
}

async function createWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-repair-planning-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  return workspace;
}

function runtimeSession(workspacePath: string, output: string): AgentRuntimeSession {
  return ({
    id: "session-recursive-repair-planning",
    workspacePath,
    patchProposals: [{
      id: "patch-a",
      sessionId: "session-recursive-repair-planning",
      title: "Branch patch",
      summary: "Branch summary",
      riskLevel: "low",
      filesChanged: [{
        path: "src/module.mjs",
        changeType: "modify",
        explanation: "test"
      }],
      artifacts: [],
      unifiedDiff: "",
      requiresApproval: true,
      status: "applied",
      createdAt: new Date().toISOString()
    }],
    commandExecutions: [commandExecution(workspacePath, output)],
    recursiveFactory: {
      branchScopeConflicts: []
    }
  } as unknown) as AgentRuntimeSession;
}

function failedFinalReport(sessionId: string, workspacePath: string): RecursiveFinalReport {
  const now = new Date().toISOString();
  return {
    id: "final-1",
    sessionId,
    productGoal: "Goal",
    approvedTechnicalPlanSummary: "Plan",
    graphSummary: "Graph",
    branchOutcomes: [],
    patchApplyTruth: [],
    patchProvenance: [{
      patchId: "patch-a",
      branchId: "branch-a",
      filesChanged: ["src/module.mjs"],
      diffHunks: [],
      touchedSymbols: [],
      fileHashes: []
    }],
    validationHierarchy: [],
    finalValidationState: "verified_failed",
    finalStatus: "failed",
    validationDiscovery: {
      discoveredCommands: [],
      chosenStrategy: {
        kind: "command",
        command: "npm test",
        cwd: workspacePath,
        classification: "safe_auto",
        scope: "project",
        reason: "test"
      },
      evidence: [{
        kind: "command",
        truthStatus: "verified_failed",
        summary: "npm test failed",
        command: "npm test",
        cwd: workspacePath,
        executionId: "exec-failed",
        exitCode: 1,
        stdoutSummary: "failed",
        stderrSummary: "",
        scope: "project"
      }],
      statusReason: "Final validation failed."
    },
    knownLimitations: [],
    recommendedNextStep: "Repair run.",
    createdAt: now,
    updatedAt: now
  };
}

function commandExecution(cwd: string, output: string): CommandExecutionRecord {
  return {
    id: "exec-failed",
    sessionId: "session-recursive-repair-planning",
    autoRun: false,
    command: "npm test",
    cwd,
    risk: "safe",
    status: "executed",
    exitCode: 1,
    stdout: output,
    stderr: "",
    message: "tests failed",
    provenance: {
      source: "agent",
      trigger: "manual",
      requestedBy: "agent",
      executionAuthority: "rust"
    },
    createdAt: new Date().toISOString()
  };
}

function rustFailureOutput(filePath: string) {
  return [
    "AssertionError: expected fixed value",
    `at checkRepair (${filePath}:1:1)`
  ].join("\n");
}

function summarize(output?: string) {
  return output?.trim().slice(0, 80);
}
