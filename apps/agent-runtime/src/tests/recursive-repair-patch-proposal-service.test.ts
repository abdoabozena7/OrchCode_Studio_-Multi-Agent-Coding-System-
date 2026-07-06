import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  AgentRuntimeSession,
  Artifact,
  PatchProposal,
  RecursiveFinalReport,
  RecursiveRepairRecord,
  ToolIntent
} from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { RecursiveRepairPatchProposalService } from "../runtime/RecursiveRepairPatchProposalService.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("recursive repair patch proposal service creates a reviewable repair without writing files", async () => {
  const workspace = await createWorkspace();
  const targetFile = "src/module.mjs";
  const targetPath = path.join(workspace, targetFile);
  await writeFile(targetPath, "export const HIVO_REPAIR_VALUE = \"broken\";\n");
  const session = runtimeSession(workspace);
  const manager = new FakeSessionManager(session);
  const provider = new RepairIntentProvider(targetFile);
  const service = new RecursiveRepairPatchProposalService(manager.asSessionManager(), {
    getProvider: () => provider
  });

  try {
    const result = await service.propose(session.id, finalReport(session.id), repairRecord(session.id, targetFile));

    assert.equal(provider.calls, 1);
    assert.equal(result.status, "patch_proposed");
    assert.equal(result.attemptCount, 1);
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.requiresApproval, true);
    assert.equal(session.patchProposals[0]?.status, "proposed");
    assert.match(session.patchProposals[0]?.unifiedDiff ?? "", /HIVO_REPAIR_VALUE = "fixed"/);
    assert.equal(session.artifacts.length, 1);
    assert.equal(session.toolIntents.length, 1);
    assert.equal(session.toolIntents[0]?.type, "patch.proposed");
    assert.equal(await readFile(targetPath, "utf8"), "export const HIVO_REPAIR_VALUE = \"broken\";\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive repair patch proposal service skips provider when no related file is readable", async () => {
  const workspace = await createWorkspace();
  const session = runtimeSession(workspace);
  const manager = new FakeSessionManager(session);
  const provider = new RepairIntentProvider("src/missing.mjs");
  const service = new RecursiveRepairPatchProposalService(manager.asSessionManager(), {
    getProvider: () => provider
  });

  try {
    const result = await service.propose(session.id, finalReport(session.id), repairRecord(session.id, "src/missing.mjs"));

    assert.equal(provider.calls, 0);
    assert.equal(result.status, "repair_not_attempted");
    assert.equal(result.eligibility.status, "repair_not_attempted");
    assert.match(result.summary, /No readable related file excerpt/);
    assert.equal(session.patchProposals.length, 0);
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

  async addPatchProposal(_sessionId: string, proposal: PatchProposal) {
    this.session.patchProposals.push(proposal);
  }

  async addArtifact(_sessionId: string, artifact: Artifact) {
    this.session.artifacts.push(artifact);
  }

  async addToolIntent(_sessionId: string, intent: ToolIntent) {
    this.session.toolIntents.push(intent);
  }
}

class RepairIntentProvider implements LlmProvider {
  calls = 0;

  constructor(private readonly targetFile: string) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    this.calls += 1;
    return {
      title: "Recursive repair",
      summary: "Fix the proven repair sentinel.",
      intents: [{
        path: this.targetFile,
        operation: "replace_range",
        preimageText: "export const HIVO_REPAIR_VALUE = \"broken\";",
        replacementText: "export const HIVO_REPAIR_VALUE = \"fixed\";",
        reason: "Fix only the sentinel value proven by recursive validation.",
        risk: "low"
      }],
      suggestedCommands: []
    } as T;
  }

  async generateText(): Promise<string> {
    return "unused";
  }
}

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-recursive-repair-patch-"));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  return workspace;
}

function runtimeSession(workspacePath: string): AgentRuntimeSession {
  return ({
    id: "session-recursive-repair-patch",
    workspacePath,
    patchProposals: [],
    artifacts: [],
    toolIntents: []
  } as unknown) as AgentRuntimeSession;
}

function finalReport(sessionId: string): RecursiveFinalReport {
  const now = new Date().toISOString();
  return {
    id: "final-1",
    sessionId,
    productGoal: "Goal",
    approvedTechnicalPlanSummary: "Plan",
    graphSummary: "Graph",
    branchOutcomes: [],
    patchApplyTruth: [],
    patchProvenance: [],
    validationHierarchy: [],
    finalValidationState: "verified_failed",
    finalStatus: "failed",
    knownLimitations: [],
    recommendedNextStep: "Repair run.",
    createdAt: now,
    updatedAt: now
  };
}

function repairRecord(sessionId: string, relatedFile: string): RecursiveRepairRecord {
  const now = new Date().toISOString();
  return {
    id: "repair-1",
    sessionId,
    status: "diagnosed",
    attemptCount: 0,
    maxAttempts: 1,
    diagnosis: {
      id: "diagnosis-1",
      sessionId,
      command: "npm test",
      cwd: "D:/workspace",
      failingTests: [],
      errors: [],
      likelyFiles: [relatedFile],
      branchIds: ["branch-a"],
      patchIds: ["patch-a"],
      failureSignals: {
        commandType: "npm",
        failingTestFiles: [],
        sourceFiles: [relatedFile],
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
      summary: "validation failed",
      createdAt: now
    },
    eligibility: {
      status: "eligible",
      reasons: ["eligible"],
      attemptCount: 0,
      maxAttempts: 1,
      relatedFiles: [relatedFile],
      relatedPatchIds: ["patch-a"]
    },
    validationAttempts: [],
    summary: "diagnosed",
    createdAt: now,
    updatedAt: now
  };
}
