import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  CommandRequest,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup,
  RecursiveRepairRecord,
  RecursiveValidationStrategy,
  ToolIntent
} from "@hivo/protocol";
import { RecursiveRepairStateService } from "../runtime/RecursiveRepairStateService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive repair state service queues Rust revalidation after repair patch apply", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession({
    workspacePath: workspace,
    patchStatus: "applied",
    strategy: commandStrategy()
  });
  const manager = new FakeSessionManager(session);
  const service = createService(manager);

  try {
    const update = await service.updateFromPatch(session.id, "patch-repair", "applied");

    assert.equal(update.updated, true);
    assert.ok(update.queuedCommandRequestId);
    assert.equal(session.commandRequests.length, 1);
    assert.equal(session.toolIntents.length, 1);
    assert.equal(session.commandRequests[0]?.provenance?.executionAuthority, "rust");
    assert.equal(session.recursiveFactory?.repair?.status, "revalidation_requested");
    assert.equal(session.recursiveFactory?.repair?.repairPatchStatus, "applied");
    assert.equal(session.recursiveFactory?.repair?.revalidationRequestId, session.commandRequests[0]?.id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive repair state service projects Rust revalidation result into repair and branch state", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession({
    workspacePath: workspace,
    patchStatus: "applied",
    strategy: commandStrategy(),
    revalidationRequestId: "cmd-revalidate"
  });
  const manager = new FakeSessionManager(session);
  const service = createService(manager);

  try {
    const update = await service.updateFromCommandResult(session.id, commandExecution("cmd-revalidate", "executed", 0, workspace));

    const branch = session.recursiveFactory?.branchExecutions?.[0];
    assert.equal(update.updated, true);
    assert.equal(update.revalidated, true);
    assert.equal(session.recursiveFactory?.repair?.status, "revalidated");
    assert.equal(session.recursiveFactory?.repair?.finalOutcome, "verified_passed");
    assert.equal(session.recursiveFactory?.repair?.validationAttempts[0]?.truthStatus, "verified_passed");
    assert.equal(branch?.status, "completed");
    assert.equal(branch?.validationStatus, "verified_passed");
    assert.equal(branch?.nestedRollup?.validationState, "verified_passed");
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

  async updateSession(_sessionId: string, updater: (session: AgentRuntimeSession) => void) {
    updater(this.session);
    return this.session;
  }

  async addCommandRequest(_sessionId: string, request: CommandRequest) {
    this.session.commandRequests.push(request);
  }

  async addToolIntent(_sessionId: string, intent: ToolIntent) {
    this.session.toolIntents.push(intent);
  }
}

function createService(manager: FakeSessionManager) {
  return new RecursiveRepairStateService(manager.asSessionManager(), {
    buildNestedRollup,
    summarizeOutput: (output) => output?.trim()
  });
}

function runtimeSession(input: {
  workspacePath: string;
  patchStatus: PatchProposal["status"];
  strategy: RecursiveValidationStrategy;
  revalidationRequestId?: string;
}): AgentRuntimeSession {
  const repair = repairRecord(input.revalidationRequestId);
  return ({
    id: "session-recursive-repair",
    workspacePath: input.workspacePath,
    patchProposals: [patchProposal(input.patchStatus)],
    commandRequests: [],
    toolIntents: [],
    recursiveFactory: {
      phase: "branch_execution_running",
      executionStarted: true,
      repair,
      finalReport: {
        repair,
        validationDiscovery: {
          chosenStrategy: input.strategy
        }
      },
      branchExecutions: [branchExecution()]
    }
  } as unknown) as AgentRuntimeSession;
}

function repairRecord(revalidationRequestId?: string): RecursiveRepairRecord {
  const now = new Date().toISOString();
  return {
    id: "repair-1",
    sessionId: "session-recursive-repair",
    status: revalidationRequestId ? "revalidation_requested" : "patch_proposed",
    attemptCount: 1,
    maxAttempts: 1,
    diagnosis: {
      id: "diagnosis-1",
      sessionId: "session-recursive-repair",
      command: "npm test",
      cwd: "D:/workspace",
      failingTests: [],
      errors: [],
      likelyFiles: ["src/feature.ts"],
      branchIds: ["branch-a"],
      patchIds: ["patch-repair"],
      failureSignals: {
        commandType: "npm",
        failingTestFiles: [],
        sourceFiles: ["src/feature.ts"],
        assertionMessages: [],
        importModules: [],
        stackFrames: [],
        lineNumbers: []
      },
      attribution: {
        relatedPatchIds: ["patch-repair"],
        relatedBranchIds: ["branch-a"],
        confidence: "high",
        evidence: ["direct test fixture"],
        reason: "test",
        memoryFreshness: "fresh"
      },
      summary: "validation failed",
      createdAt: now
    },
    eligibility: {
      status: "eligible",
      reasons: ["eligible"],
      attemptCount: 0,
      maxAttempts: 1,
      relatedFiles: ["src/feature.ts"],
      relatedPatchIds: ["patch-repair"]
    },
    repairPatchId: "patch-repair",
    repairPatchStatus: "proposed",
    revalidationRequestId,
    validationAttempts: [],
    summary: "repair patch proposed",
    createdAt: now,
    updatedAt: now
  };
}

function branchExecution(): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  return {
    branchId: "branch-a",
    sessionId: "session-recursive-repair",
    title: "Branch A",
    status: "validation_pending",
    active: false,
    executionContext: {
      branchObjective: "Repair branch A",
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
    proposedPatchId: "patch-repair",
    reviewStatus: "approved",
    validationStatus: "verified_failed",
    validationPlan: ["npm test"],
    patchApplied: true,
    createdAt: now,
    updatedAt: now
  };
}

function patchProposal(status: PatchProposal["status"]): PatchProposal {
  return {
    id: "patch-repair",
    sessionId: "session-recursive-repair",
    title: "Repair patch",
    summary: "Repair summary",
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

function commandStrategy(): RecursiveValidationStrategy {
  return {
    kind: "command",
    command: "npm test",
    cwd: ".",
    classification: "safe_auto",
    scope: "project",
    reason: "test command"
  };
}

function commandExecution(
  requestId: string,
  status: CommandExecutionRecord["status"],
  exitCode: number,
  cwd: string
): CommandExecutionRecord {
  return {
    id: "exec-revalidate",
    sessionId: "session-recursive-repair",
    requestId,
    autoRun: false,
    command: "npm test",
    cwd,
    risk: "safe",
    status,
    exitCode,
    stdout: "ok",
    stderr: "",
    message: "tests passed",
    provenance: {
      source: "agent",
      trigger: "manual",
      requestedBy: "agent",
      executionAuthority: "rust"
    },
    createdAt: new Date().toISOString()
  };
}

async function createWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-repair-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function buildNestedRollup(branch: RecursiveBranchExecutionRecord): RecursiveNestedSubtaskRollup {
  return {
    parentBranchId: branch.branchId,
    completedSubtasks: [],
    failedSubtasks: [],
    blockedSubtasks: [],
    appliedPatches: [branch.proposedPatchId].filter(Boolean) as string[],
    validationState: branch.validationStatus,
    limitations: [],
    updatedAt: new Date().toISOString()
  };
}
