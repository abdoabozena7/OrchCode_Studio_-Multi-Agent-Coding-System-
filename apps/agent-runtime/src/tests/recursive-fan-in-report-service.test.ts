import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRuntimeSession,
  RecursiveBranchResultRecord,
  RecursiveFinalReport,
  RecursiveIntegrationSummary,
  RecursiveRepairRecord,
  RecursiveValidationRecord
} from "@hivo/protocol";
import { RecursiveFanInReportService } from "../runtime/RecursiveFanInReportService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive fan-in report service persists reports, artifacts, events, and completed lifecycle", async () => {
  const session = runtimeSession();
  const manager = new FakeSessionManager(session);
  const service = createService(manager, "passed");

  const result = await service.refresh(session.id);

  assert.equal(result.refreshed, true);
  assert.equal(result.branchResultCount, 1);
  assert.equal(session.status, "completed");
  assert.equal(session.lifecycleStage, "DONE");
  assert.equal(session.recursiveFactory?.branchResults?.length, 1);
  assert.equal(session.recursiveFactory?.integrationSummary?.id, "integration-1");
  assert.equal(session.recursiveFactory?.finalReport?.id, "final-1");
  assert.equal(session.artifacts.length, 3);
  assert.deepEqual(manager.eventTypes, [
    "runtime.branch_result.recorded",
    "runtime.recursive_fan_in.updated",
    "runtime.recursive_final_report.created"
  ]);
});

test("recursive fan-in report service applies repair approval lifecycle", async () => {
  const session = runtimeSession();
  const manager = new FakeSessionManager(session);
  const repair = repairRecord();
  const service = createService(manager, "failed", repair);

  const result = await service.refresh(session.id);

  assert.equal(result.finalStatus, "failed");
  assert.equal(session.status, "needs_approval");
  assert.equal(session.lifecycleStage, "APPROVAL");
  assert.equal(session.nextAction?.kind, "approve_patch");
  assert.equal(session.recursiveFactory?.repair?.repairPatchId, "patch-repair");
  assert.ok(session.artifacts.find((artifact) => artifact.id === "diagnosis-1"));
});

class FakeSessionManager {
  readonly eventTypes: string[] = [];

  constructor(private readonly session: AgentRuntimeSession) {}

  asSessionManager(): SessionManager {
    return this as unknown as SessionManager;
  }

  getSession(sessionId: string) {
    return this.session.id === sessionId ? this.session : undefined;
  }

  async updateSession(_sessionId: string, updater: (session: AgentRuntimeSession) => void) {
    updater(this.session);
    return this.session;
  }

  publishFactoryEvent(event: { type: string }) {
    this.eventTypes.push(event.type);
  }
}

function createService(
  manager: FakeSessionManager,
  finalStatus: RecursiveFinalReport["finalStatus"],
  repair?: RecursiveRepairRecord
) {
  return new RecursiveFanInReportService(manager.asSessionManager(), {
    buildBranchResults: (session) => [branchResult(session.id)],
    buildBranchValidationRecords: (session) => [validationRecord(session.id, "branch_validation", finalStatus === "passed" ? "passed" : "failed")],
    buildIntegrationSummary: (session) => integrationSummary(session.id, finalStatus === "passed" ? "passed" : "failed"),
    buildFinalReport: (session, branchResults, integration, validations) =>
      finalReport(session.id, branchResults, integration, validations, finalStatus),
    prepareRepairLoop: async (_sessionId, report) => repair ? { ...report, repair } : report
  });
}

function runtimeSession(): AgentRuntimeSession {
  return ({
    id: "session-fan-in",
    workspacePath: "D:/workspace",
    status: "needs_approval",
    lifecycleStage: "POST_VERIFY",
    nextAction: undefined,
    artifacts: [],
    recursiveFactory: {
      phase: "branch_execution_running",
      executionStarted: true,
      branchExecutions: [{
        branchId: "branch-a",
        sessionId: "session-fan-in",
        title: "Branch A",
        status: "completed",
        active: false,
        executionContext: {
          branchObjective: "Complete branch A",
          approvedProductSpecSummary: "spec",
          approvedTechnicalPlanSummary: "plan",
          fileScopes: ["src/a.ts"],
          semanticScopes: [],
          lockScopes: ["src/a.ts"],
          dependencies: [],
          evidenceContextPack: []
        },
        schedulerDecision: {
          maxActiveWriteBranches: 1,
          writeBranch: true
        },
        reviewStatus: "approved",
        validationStatus: "verified_passed",
        validationPlan: ["npm test"],
        patchApplied: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }]
    }
  } as unknown) as AgentRuntimeSession;
}

function branchResult(sessionId: string): RecursiveBranchResultRecord {
  const now = new Date().toISOString();
  return {
    id: "branch-result-a",
    sessionId,
    branchId: "branch-a",
    objective: "Complete branch A",
    patchIds: ["patch-a"],
    appliedState: "applied",
    reviewResult: "approved",
    validationState: "verified_passed",
    filesChanged: ["src/a.ts"],
    risksAndLimitations: [],
    evidenceSummary: ["Branch A complete."],
    createdAt: now,
    updatedAt: now
  };
}

function validationRecord(
  sessionId: string,
  level: RecursiveValidationRecord["level"],
  status: RecursiveValidationRecord["status"]
): RecursiveValidationRecord {
  const truthStatus = status === "passed" ? "verified_passed" : status === "failed" ? "verified_failed" : "unverified";
  const now = new Date().toISOString();
  return {
    id: `validation-${level}`,
    sessionId,
    level,
    truthStatus,
    status,
    summary: `${level} ${status}`,
    blockingReasons: status === "passed" ? [] : ["failed validation"],
    evidenceRefs: [],
    createdAt: now,
    updatedAt: now
  };
}

function integrationSummary(
  sessionId: string,
  status: RecursiveValidationRecord["status"]
): RecursiveIntegrationSummary {
  const now = new Date().toISOString();
  return {
    id: "integration-1",
    sessionId,
    completedBranches: status === "passed" ? ["branch-a"] : [],
    blockedBranches: [],
    failedBranches: status === "failed" ? ["branch-a"] : [],
    unverifiedBranches: [],
    conflictsResolved: [],
    conflictsUnresolved: [],
    integrationRisks: status === "passed" ? [] : ["failed validation"],
    remainingManualSteps: status === "passed" ? [] : ["Inspect failed validation."],
    validation: validationRecord(sessionId, "integration_validation", status),
    createdAt: now,
    updatedAt: now
  };
}

function finalReport(
  sessionId: string,
  branchResults: RecursiveBranchResultRecord[],
  integration: RecursiveIntegrationSummary,
  validations: RecursiveValidationRecord[],
  finalStatus: RecursiveFinalReport["finalStatus"]
): RecursiveFinalReport {
  const status = finalStatus === "passed" ? "passed" : finalStatus === "failed" ? "failed" : "unverified";
  const finalValidation = validationRecord(sessionId, "final_validation", status);
  const now = new Date().toISOString();
  return {
    id: "final-1",
    sessionId,
    productGoal: "Goal",
    approvedTechnicalPlanSummary: "Plan",
    graphSummary: "Graph",
    branchOutcomes: branchResults,
    patchApplyTruth: [],
    patchProvenance: [],
    validationHierarchy: [...validations, integration.validation, finalValidation],
    finalValidationState: finalValidation.truthStatus,
    finalStatus,
    knownLimitations: [],
    recommendedNextStep: finalStatus === "passed" ? "Close run." : "Repair run.",
    createdAt: now,
    updatedAt: now
  };
}

function repairRecord(): RecursiveRepairRecord {
  const now = new Date().toISOString();
  return {
    id: "repair-1",
    sessionId: "session-fan-in",
    status: "patch_proposed",
    attemptCount: 1,
    maxAttempts: 1,
    diagnosis: {
      id: "diagnosis-1",
      sessionId: "session-fan-in",
      command: "npm test",
      cwd: "D:/workspace",
      failingTests: [],
      errors: [],
      likelyFiles: ["src/a.ts"],
      branchIds: ["branch-a"],
      patchIds: ["patch-a"],
      failureSignals: {
        commandType: "npm",
        failingTestFiles: [],
        sourceFiles: ["src/a.ts"],
        assertionMessages: [],
        importModules: [],
        stackFrames: [],
        lineNumbers: []
      },
      attribution: {
        relatedPatchIds: ["patch-a"],
        relatedBranchIds: ["branch-a"],
        confidence: "high",
        evidence: ["test"],
        reason: "test",
        memoryFreshness: "fresh"
      },
      summary: "diagnosis",
      createdAt: now
    },
    eligibility: {
      status: "eligible",
      reasons: ["eligible"],
      attemptCount: 0,
      maxAttempts: 1,
      relatedFiles: ["src/a.ts"],
      relatedPatchIds: ["patch-a"]
    },
    repairPatchId: "patch-repair",
    repairPatchStatus: "proposed",
    validationAttempts: [],
    summary: "repair proposed",
    createdAt: now,
    updatedAt: now
  };
}
