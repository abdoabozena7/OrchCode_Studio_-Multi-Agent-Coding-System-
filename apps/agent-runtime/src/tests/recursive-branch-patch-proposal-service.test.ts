import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  Artifact,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup,
  RecursiveNestedSubtaskRecord,
  RuntimeMessage
} from "@hivo/protocol";
import { RecursiveBranchPatchProposalService } from "../runtime/RecursiveBranchPatchProposalService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive branch patch proposal service records branch proposals without writing files", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-patch-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  const target = path.join(workspace, "src", "feature.ts");
  await writeFile(target, "export const value = 'old';\n");
  const session = runtimeSession(workspace, [branchExecution({
    branchId: "branch-a",
    plannedPatch: {
      targetFile: "src/feature.ts",
      replacementText: "export const value = 'new';\n"
    }
  })]);
  const manager = new FakeSessionManager(session);
  const service = new RecursiveBranchPatchProposalService(manager.asSessionManager(), nestedRollup);

  try {
    await service.proposeScheduledBranchPatch(session.id, "branch-a");

    assert.equal(await readFile(target, "utf8"), "export const value = 'old';\n");
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.status, "proposed");
    assert.match(session.patchProposals[0]?.unifiedDiff ?? "", /-export const value = 'old';/);
    assert.match(session.patchProposals[0]?.unifiedDiff ?? "", /\+export const value = 'new';/);
    assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.status, "patch_proposed");
    assert.equal(session.status, "needs_approval");
    assert.equal(session.lifecycleStage, "APPROVAL");
    assert.equal(session.nextAction?.kind, "approve_patch");
    assert.deepEqual(manager.eventTypes, ["runtime.branch_execution.started", "runtime.branch_execution.patch_proposed"]);
    assert.match(session.messages.at(-1)?.content ?? "", /Rust apply authority/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive branch patch proposal service records nested subtask proposals", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-nested-patch-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  const subtask = nestedSubtask({
    subtaskId: "branch-a-subtask-1",
    targetFile: "src/nested.ts",
    replacementText: "export const nested = true;\n"
  });
  const session = runtimeSession(workspace, [branchExecution({
    branchId: "branch-a",
    nestedSubtasks: [subtask]
  })]);
  const manager = new FakeSessionManager(session);
  const service = new RecursiveBranchPatchProposalService(manager.asSessionManager(), nestedRollup);

  try {
    await service.proposeNestedSubtaskPatch(session.id, "branch-a", subtask.subtaskId);

    const updatedBranch = session.recursiveFactory?.branchExecutions?.[0];
    const updatedSubtask = updatedBranch?.nestedSubtasks?.[0];
    assert.equal(session.patchProposals.length, 1);
    assert.equal(updatedBranch?.status, "running");
    assert.equal(updatedSubtask?.status, "patch_proposed");
    assert.equal(updatedSubtask?.proposedPatchId, session.patchProposals[0]?.id);
    assert.equal(updatedBranch?.nestedRollup?.parentBranchId, "branch-a");
    assert.equal(session.status, "needs_approval");
    assert.equal(session.nextAction?.kind, "approve_patch");
    assert.deepEqual(manager.eventTypes, ["runtime.branch_execution.patch_proposed"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class FakeSessionManager {
  readonly artifacts: Artifact[] = [];
  readonly eventTypes: string[] = [];

  constructor(private readonly session: AgentRuntimeSession) {}

  asSessionManager(): SessionManager {
    return this as unknown as SessionManager;
  }

  getSession(sessionId: string) {
    return this.session.id === sessionId ? this.session : undefined;
  }

  async addPatchProposal(_sessionId: string, proposal: PatchProposal) {
    this.session.patchProposals.push(proposal);
  }

  async addArtifact(_sessionId: string, artifact: Artifact) {
    this.artifacts.push(artifact);
    this.session.artifacts.push(artifact);
  }

  async updateSession(_sessionId: string, updater: (session: AgentRuntimeSession) => void) {
    updater(this.session);
    return this.session;
  }

  publishFactoryEvent(event: { type: string }) {
    this.eventTypes.push(event.type);
  }

  async addMessage(_sessionId: string, message: Omit<RuntimeMessage, "id" | "createdAt">) {
    this.session.messages.push({
      id: `msg_${this.session.messages.length + 1}`,
      createdAt: new Date().toISOString(),
      ...message
    });
  }
}

function runtimeSession(workspacePath: string, branches: RecursiveBranchExecutionRecord[]): AgentRuntimeSession {
  return ({
    id: "session-recursive-patch",
    workspacePath,
    status: "running",
    lifecycleStage: "EXECUTE",
    nextAction: undefined,
    patchProposals: [],
    artifacts: [],
    messages: [],
    reasoningSummaries: [],
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
  plannedPatch?: RecursiveBranchExecutionRecord["plannedPatch"];
  nestedSubtasks?: RecursiveNestedSubtaskRecord[];
}): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  return {
    branchId: input.branchId,
    sessionId: "session-recursive-patch",
    title: `Branch ${input.branchId}`,
    status: "running",
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
    reviewStatus: "not_started",
    validationStatus: "unverified",
    validationPlan: ["npm run test"],
    patchApplied: false,
    plannedPatch: input.plannedPatch,
    nestedSubtasks: input.nestedSubtasks,
    createdAt: now,
    updatedAt: now
  };
}

function nestedSubtask(input: {
  subtaskId: string;
  targetFile: string;
  replacementText: string;
}): RecursiveNestedSubtaskRecord {
  const now = new Date().toISOString();
  return {
    subtaskId: input.subtaskId,
    sessionId: "session-recursive-patch",
    parentBranchId: "branch-a",
    depth: 1,
    objective: "Implement nested slice",
    fileScopes: [input.targetFile],
    dependencies: [],
    expectedOutput: "Patch proposal",
    reviewerRequirement: "Review nested patch",
    validatorRequirement: "Validate nested patch",
    status: "running",
    required: true,
    writeSubtask: true,
    plannedPatch: {
      targetFile: input.targetFile,
      replacementText: input.replacementText
    },
    patchApplied: false,
    validationStatus: "unverified",
    active: true,
    createdAt: now,
    updatedAt: now
  };
}

function nestedRollup(branch: RecursiveBranchExecutionRecord): RecursiveNestedSubtaskRollup {
  return {
    parentBranchId: branch.branchId,
    completedSubtasks: [],
    failedSubtasks: [],
    blockedSubtasks: [],
    appliedPatches: [],
    validationState: "unverified",
    limitations: ["Nested validation truth is unverified."],
    updatedAt: new Date().toISOString()
  };
}
