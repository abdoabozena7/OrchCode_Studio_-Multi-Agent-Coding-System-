import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  Artifact,
  CommandRequest,
  RecursiveBranchExecutionRecord,
  ToolIntent
} from "@hivo/protocol";
import { RecursiveBranchValidationService } from "../runtime/RecursiveBranchValidationService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive branch validation service evaluates without queuing commands", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession(workspace);
  const manager = new FakeSessionManager(session);
  const service = new RecursiveBranchValidationService(manager.asSessionManager());

  try {
    const evaluation = service.evaluateBranch(session, "branch-a");

    assert.equal(evaluation.strategy.kind, "command");
    assert.match(evaluation.strategy.command ?? "", /test/);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.toolIntents.length, 0);
    assert.equal(session.artifacts.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive branch validation service queues Rust-owned validation requests once", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession(workspace);
  const manager = new FakeSessionManager(session);
  const service = new RecursiveBranchValidationService(manager.asSessionManager());

  try {
    const first = await service.prepareBranchValidation(session.id, "branch-a");
    const second = await service.prepareBranchValidation(session.id, "branch-a");

    assert.equal(first.strategy.kind, "command");
    assert.equal(second.strategy.kind, "command");
    assert.equal(session.commandRequests.length, 1);
    assert.equal(session.toolIntents.length, 1);
    assert.equal(session.artifacts.length, 1);
    assert.equal(session.commandRequests[0]?.provenance?.executionAuthority, "rust");
    assert.equal(session.toolIntents[0]?.type, "validation.requested");
    assert.equal(session.artifacts[0]?.type, "verification");
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

  async addCommandRequest(_sessionId: string, request: CommandRequest) {
    this.session.commandRequests.push(request);
  }

  async addToolIntent(_sessionId: string, intent: ToolIntent) {
    this.session.toolIntents.push(intent);
  }

  async addArtifact(_sessionId: string, artifact: Artifact) {
    this.session.artifacts.push(artifact);
  }
}

async function createWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-validation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    scripts: {
      test: "node --test"
    }
  }, null, 2));
  return workspace;
}

function runtimeSession(workspacePath: string): AgentRuntimeSession {
  return ({
    id: "session-recursive-validation",
    workspacePath,
    patchProposals: [],
    commandRequests: [],
    commandExecutions: [],
    toolIntents: [],
    artifacts: [],
    orchestration: {
      projectMap: {
        stack: ["node"],
        packageManagers: ["npm"],
        testCommands: [],
        entryPoints: [],
        importantFiles: []
      }
    },
    recursiveFactory: {
      phase: "branch_execution_running",
      executionStarted: true,
      branchExecutions: [branchExecution()]
    }
  } as unknown) as AgentRuntimeSession;
}

function branchExecution(): RecursiveBranchExecutionRecord {
  const now = new Date().toISOString();
  return {
    branchId: "branch-a",
    sessionId: "session-recursive-validation",
    title: "Branch A",
    status: "validation_pending",
    active: false,
    executionContext: {
      branchObjective: "Validate branch A",
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
    reviewStatus: "approved",
    validationStatus: "unverified",
    validationPlan: ["npm test"],
    patchApplied: false,
    createdAt: now,
    updatedAt: now
  };
}
