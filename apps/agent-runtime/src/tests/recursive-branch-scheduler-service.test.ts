import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRuntimeSession,
  RecursiveBranchExecutionRecord
} from "@hivo/protocol";
import { RecursiveBranchSchedulerService } from "../runtime/RecursiveBranchSchedulerService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive branch scheduler selects one ready write branch for proposal", async () => {
  const session = runtimeSession([branchExecution("branch-a", { status: "planned" })]);
  const manager = new FakeSessionManager(session);
  const proposedBranches: string[] = [];
  const proposedNested: Array<{ branchId: string; subtaskId: string }> = [];
  const service = createService(manager, proposedBranches, proposedNested);

  const result = await service.advance(session.id);

  assert.equal(result.branchToPropose, "branch-a");
  assert.deepEqual(proposedBranches, ["branch-a"]);
  assert.deepEqual(proposedNested, []);
  assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.status, "running");
  assert.equal(session.recursiveFactory?.activeBranchId, "branch-a");
  assert.equal(session.status, "needs_approval");
});

test("recursive branch scheduler blocks failed dependencies without proposing", async () => {
  const session = runtimeSession([
    branchExecution("branch-a", { status: "failed" }),
    branchExecution("branch-b", { status: "planned", dependencies: ["branch-a"] })
  ]);
  const manager = new FakeSessionManager(session);
  const proposedBranches: string[] = [];
  const proposedNested: Array<{ branchId: string; subtaskId: string }> = [];
  const service = createService(manager, proposedBranches, proposedNested);

  const result = await service.advance(session.id);
  const blocked = session.recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === "branch-b");

  assert.equal(result.branchToPropose, undefined);
  assert.deepEqual(proposedBranches, []);
  assert.equal(blocked?.status, "blocked_failed_dependency");
  assert.match(blocked?.blockedReason ?? "", /Dependency branch-a failed/);
  assert.equal(session.recursiveFactory?.phase, "branch_execution_blocked");
  assert.equal(session.status, "blocked");
});

test("recursive branch scheduler creates nested subtasks and proposes first nested write", async () => {
  const session = runtimeSession([
    branchExecution("branch-complex", {
      status: "planned",
      title: "Complex branch",
      plannedNestedPatches: [{
        targetFile: "src/a.ts",
        replacementText: "a",
        objective: "Update A"
      }, {
        targetFile: "src/b.ts",
        replacementText: "b",
        objective: "Update B"
      }]
    })
  ]);
  const manager = new FakeSessionManager(session);
  const proposedBranches: string[] = [];
  const proposedNested: Array<{ branchId: string; subtaskId: string }> = [];
  const service = createService(manager, proposedBranches, proposedNested);

  const result = await service.advance(session.id);
  const branch = session.recursiveFactory?.branchExecutions?.[0];

  assert.deepEqual(result.nestedToPropose, { branchId: "branch-complex", subtaskId: "branch-complex_subtask_1" });
  assert.deepEqual(proposedBranches, []);
  assert.deepEqual(proposedNested, [{ branchId: "branch-complex", subtaskId: "branch-complex_subtask_1" }]);
  assert.equal(branch?.nestedDepth, 1);
  assert.equal(branch?.nestedSubtasks?.length, 3);
  assert.equal(branch?.nestedSubtasks?.[0]?.status, "running");
  assert.equal(branch?.nestedSubtasks?.[1]?.status, "waiting_on_dependency");
  assert.equal(branch?.nestedSubtasks?.[2]?.writeSubtask, false);
  assert.equal(branch?.nestedRollup?.validationState, "unverified");
});

test("recursive branch scheduler does not expand beyond one nested level", async () => {
  const branch = branchExecution("branch-depth-limit", {
    status: "planned",
    title: "Complex branch at nested depth limit",
    plannedNestedPatches: [{
      targetFile: "src/depth.ts",
      replacementText: "depth",
      objective: "Should stay at parent level"
    }]
  });
  branch.nestedDepth = 1;
  branch.nestedEligible = false;
  const session = runtimeSession([branch]);
  const manager = new FakeSessionManager(session);
  const proposedBranches: string[] = [];
  const proposedNested: Array<{ branchId: string; subtaskId: string }> = [];
  const service = createService(manager, proposedBranches, proposedNested);

  const result = await service.advance(session.id);
  const updated = session.recursiveFactory?.branchExecutions?.[0];

  assert.equal(result.branchToPropose, "branch-depth-limit");
  assert.equal(result.nestedToPropose, undefined);
  assert.deepEqual(proposedBranches, ["branch-depth-limit"]);
  assert.deepEqual(proposedNested, []);
  assert.equal(updated?.nestedDepth, 1);
  assert.equal(updated?.nestedEligible, false);
  assert.equal(updated?.nestedSubtasks, undefined);
  assert.equal(updated?.nestedBlockedReason, "max_nested_depth_reached");
});

class FakeSessionManager {
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
}

function createService(
  manager: FakeSessionManager,
  proposedBranches: string[],
  proposedNested: Array<{ branchId: string; subtaskId: string }>
) {
  return new RecursiveBranchSchedulerService(manager.asSessionManager(), {
    proposeScheduledBranchPatch: async (_sessionId, branchId) => {
      proposedBranches.push(branchId);
    },
    proposeNestedSubtaskPatch: async (_sessionId, branchId, subtaskId) => {
      proposedNested.push({ branchId, subtaskId });
    }
  });
}

function runtimeSession(branches: RecursiveBranchExecutionRecord[]): AgentRuntimeSession {
  return ({
    id: "session-recursive-scheduler",
    workspacePath: "D:/workspace",
    status: "needs_approval",
    lifecycleStage: "APPROVAL",
    recursiveFactory: {
      phase: "branch_execution_running",
      executionStarted: true,
      branchExecutions: branches,
      branchOrchestrators: branches.map((branch) => ({
        branchId: branch.branchId,
        sessionId: branch.sessionId,
        title: branch.title,
        objective: branch.executionContext.branchObjective,
        ownerRole: "Runtime",
        fileScopes: branch.executionContext.fileScopes,
        semanticScopes: branch.executionContext.semanticScopes,
        lockScopes: branch.executionContext.lockScopes,
        dependencies: branch.executionContext.dependencies,
        inputContextRequirements: [],
        validationStrategy: branch.validationPlan,
        risks: [],
        status: branch.status,
        createdAt: branch.createdAt,
        updatedAt: branch.updatedAt
      })),
      branchScopeConflicts: [],
      updatedAt: new Date().toISOString()
    }
  } as unknown) as AgentRuntimeSession;
}

function branchExecution(
  branchId: string,
  input: {
    status: RecursiveBranchExecutionRecord["status"];
    dependencies?: string[];
    title?: string;
    plannedNestedPatches?: RecursiveBranchExecutionRecord["plannedNestedPatches"];
  }
): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  return {
    branchId,
    sessionId: "session-recursive-scheduler",
    title: input.title ?? `Branch ${branchId}`,
    status: input.status,
    active: false,
    executionContext: {
      branchObjective: input.title ?? `Branch ${branchId}`,
      approvedProductSpecSummary: "spec",
      approvedTechnicalPlanSummary: "plan",
      fileScopes: ["src/a.ts"],
      semanticScopes: [],
      lockScopes: ["file:src/a.ts"],
      dependencies: input.dependencies ?? [],
      evidenceContextPack: []
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: true
    },
    plannedPatch: {
      targetFile: "src/a.ts",
      replacementText: "next"
    },
    plannedNestedPatches: input.plannedNestedPatches,
    reviewStatus: "not_started",
    validationStatus: "unverified",
    validationPlan: ["npm test"],
    patchApplied: false,
    createdAt: now,
    updatedAt: now
  };
}
