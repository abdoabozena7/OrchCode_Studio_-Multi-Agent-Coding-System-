import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentRuntimeSession,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRecord,
  RecursiveNestedSubtaskRollup,
  ValidationTruthStatus
} from "@hivo/protocol";
import { RecursiveBranchPatchStatusService } from "../runtime/RecursiveBranchPatchStatusService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive branch patch status service projects approved branch patches into review state", async () => {
  const branch = branchExecution({ branchId: "branch-a", proposedPatchId: "patch-1", status: "patch_proposed" });
  const session = runtimeSession([branch], [patchProposal("patch-1", "approved")]);
  const manager = new FakeSessionManager(session);
  const service = createService(manager);

  const projection = await service.projectPatchStatus(session.id, "patch-1");

  assert.equal(projection.projected, true);
  assert.equal(projection.branchId, "branch-a");
  assert.equal(projection.eventType, "runtime.branch_execution.reviewing");
  assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.status, "reviewing");
  assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.reviewStatus, "approved");
  assert.deepEqual(manager.eventTypes, ["runtime.branch_execution.reviewing"]);
});

test("recursive branch patch status service projects nested applied patches through validation truth", async () => {
  const nested = nestedSubtask({
    subtaskId: "branch-a-subtask-1",
    proposedPatchId: "patch-2",
    status: "validation_pending"
  });
  const branch = branchExecution({
    branchId: "branch-a",
    status: "validation_pending",
    nestedSubtasks: [nested]
  });
  const session = runtimeSession([branch], [patchProposal("patch-2", "applied")]);
  const manager = new FakeSessionManager(session);
  const service = createService(manager, "verified_passed");

  const projection = await service.projectPatchStatus(session.id, "patch-2");

  const updatedBranch = session.recursiveFactory?.branchExecutions?.[0];
  const updatedSubtask = updatedBranch?.nestedSubtasks?.[0];
  assert.equal(projection.projected, true);
  assert.equal(projection.eventType, "runtime.branch_execution.completed");
  assert.equal(updatedSubtask?.patchApplied, true);
  assert.equal(updatedSubtask?.status, "completed");
  assert.equal(updatedBranch?.patchApplied, true);
  assert.equal(updatedBranch?.status, "completed");
  assert.equal(updatedBranch?.nestedRollup?.appliedPatches[0], "patch-2");
  assert.deepEqual(manager.eventTypes, ["runtime.branch_execution.completed"]);
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

function createService(manager: FakeSessionManager, validationTruth: ValidationTruthStatus = "unverified") {
  return new RecursiveBranchPatchStatusService(manager.asSessionManager(), {
    buildNestedRollup,
    nestedBranchValidationStatus: (branch) => {
      const subtasks = branch.nestedSubtasks ?? [];
      if (subtasks.length && subtasks.every((subtask) => subtask.status === "completed" && subtask.validationStatus === "verified_passed")) {
        return "verified_passed";
      }
      return branch.validationStatus;
    },
    requiredNestedSubtasksTerminal: (branch) =>
      (branch.nestedSubtasks ?? [])
        .filter((subtask) => subtask.required)
        .every((subtask) => ["completed", "validation_pending", "failed", "blocked", "blocked_conflict"].includes(subtask.status)),
    evaluateBranchValidation: () => ({ truthStatus: validationTruth, summary: `validation is ${validationTruth}` }),
    prepareBranchValidation: async () => ({ truthStatus: validationTruth, summary: `validation is ${validationTruth}` })
  });
}

function runtimeSession(branches: RecursiveBranchExecutionRecord[], patches: PatchProposal[]): AgentRuntimeSession {
  return ({
    id: "session-recursive-status",
    workspacePath: "D:/workspace",
    status: "needs_approval",
    lifecycleStage: "APPROVAL",
    nextAction: undefined,
    patchProposals: patches,
    commandRequests: [],
    recursiveFactory: {
      phase: "branch_execution_running",
      executionStarted: true,
      branchExecutions: branches,
      branchOrchestrators: branches.map((branch) => ({
        branchId: branch.branchId,
        title: branch.title,
        status: branch.status,
        ownerRole: "implementer",
        updatedAt: branch.updatedAt
      }))
    }
  } as unknown) as AgentRuntimeSession;
}

function branchExecution(input: {
  branchId: string;
  status?: RecursiveBranchExecutionRecord["status"];
  proposedPatchId?: string;
  nestedSubtasks?: RecursiveNestedSubtaskRecord[];
}): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  return {
    branchId: input.branchId,
    sessionId: "session-recursive-status",
    title: `Branch ${input.branchId}`,
    status: input.status ?? "patch_proposed",
    active: true,
    executionContext: {
      branchObjective: `Implement ${input.branchId}`,
      approvedProductSpecSummary: "Approved product spec",
      approvedTechnicalPlanSummary: "Approved technical plan",
      fileScopes: ["src/feature.ts"],
      semanticScopes: [],
      lockScopes: ["src/feature.ts"],
      dependencies: [],
      evidenceContextPack: []
    },
    schedulerDecision: {
      maxActiveWriteBranches: 1,
      writeBranch: true
    },
    proposedPatchId: input.proposedPatchId,
    nestedSubtasks: input.nestedSubtasks,
    reviewStatus: "pending",
    validationStatus: "unverified",
    validationPlan: ["npm run test"],
    patchApplied: false,
    createdAt: now,
    updatedAt: now
  };
}

function nestedSubtask(input: {
  subtaskId: string;
  proposedPatchId: string;
  status: RecursiveNestedSubtaskRecord["status"];
}): RecursiveNestedSubtaskRecord {
  const now = new Date().toISOString();
  return {
    subtaskId: input.subtaskId,
    sessionId: "session-recursive-status",
    parentBranchId: "branch-a",
    depth: 1,
    objective: "Implement nested slice",
    fileScopes: ["src/nested.ts"],
    dependencies: [],
    expectedOutput: "Patch proposal",
    reviewerRequirement: "Review nested patch",
    validatorRequirement: "Validate nested patch",
    status: input.status,
    required: true,
    writeSubtask: true,
    proposedPatchId: input.proposedPatchId,
    patchApplied: false,
    validationStatus: "unverified",
    active: true,
    createdAt: now,
    updatedAt: now
  };
}

function patchProposal(id: string, status: PatchProposal["status"]): PatchProposal {
  return {
    id,
    sessionId: "session-recursive-status",
    title: `Patch ${id}`,
    summary: "Patch summary",
    riskLevel: "low",
    filesChanged: [{
      path: "src/feature.ts",
      changeType: "modify",
      explanation: "test"
    }],
    artifacts: [],
    unifiedDiff: "",
    requiresApproval: true,
    status,
    createdAt: new Date().toISOString()
  };
}

function buildNestedRollup(branch: RecursiveBranchExecutionRecord, patches: PatchProposal[]): RecursiveNestedSubtaskRollup {
  const patchIds = (branch.nestedSubtasks ?? []).flatMap((subtask) => subtask.proposedPatchId ? [subtask.proposedPatchId] : []);
  return {
    parentBranchId: branch.branchId,
    completedSubtasks: (branch.nestedSubtasks ?? []).filter((subtask) => subtask.status === "completed").map((subtask) => subtask.subtaskId),
    failedSubtasks: [],
    blockedSubtasks: [],
    appliedPatches: patchIds.filter((patchId) => patches.find((patch) => patch.id === patchId)?.status === "applied"),
    validationState: branch.validationStatus,
    limitations: [],
    updatedAt: new Date().toISOString()
  };
}
