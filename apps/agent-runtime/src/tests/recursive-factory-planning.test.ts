import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { declaredAccessPolicyForProfile, resolvedAccessPolicyForProfile } from "@hivo/protocol";
import type { AgentRuntimeSession, AppEvent, CommandExecutionRecord } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { saveMemory } from "../memory/ProjectMemory.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { routeConversation } from "../runtime/ConversationRouter.js";
import { createDurableRuntimeEvent } from "../runtime/DurableRuntimeEvents.js";
import { EventBus } from "../runtime/EventBus.js";
import { buildHierarchicalRecursiveGraph } from "../runtime/RecursiveFactoryPlanning.js";
import {
  discoverRecursiveValidationCommands,
  findRecursiveValidationEvidence,
  selectRecursiveValidationStrategy,
  truthFromRecursiveValidation
} from "../runtime/RecursiveValidation.js";
import { replaySessionFromDurableEvents } from "../runtime/SessionReplay.js";
import { SessionManager } from "../runtime/SessionManager.js";

const largePrompt = "Build a multi-step project feature across the runtime, protocol, desktop UI, durable replay, tests, and smoke validation with product and technical approval gates before any execution.";

test("large feature prompt enters recursive_factory while normal chat does not", () => {
  assert.equal(routeConversation(largePrompt).route, "recursive_factory");
  assert.notEqual(routeConversation("hello, how are you?").route, "recursive_factory");
  assert.notEqual(routeConversation("fix the typo in README.md").route, "recursive_factory");
});

test("recursive validation discovers package.json test commands as safe auto candidates", async () => {
  const workspace = await tempWorkspace("recursive-validation-package");
  try {
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    const commands = discoverRecursiveValidationCommands({ workspacePath: workspace });
    const testCommand = commands.find((command) => command.command === "npm test");
    assert.ok(testCommand);
    assert.equal(testCommand.kind, "test");
    assert.equal(testCommand.classification, "safe_auto");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive validation discovers Python requirements validation", async () => {
  const workspace = await tempWorkspace("recursive-validation-python");
  try {
    await writeFile(path.join(workspace, "requirements.txt"), "pytest\nruff\n", "utf8");
    const commands = discoverRecursiveValidationCommands({ workspacePath: workspace });
    assert.equal(commands.some((command) => command.command === "pytest" && command.classification === "safe_auto"), true);
    assert.equal(commands.some((command) => command.command === "ruff check ." && command.kind === "lint"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive validation missing command remains not_run_missing_command", () => {
  const strategy = selectRecursiveValidationStrategy({
    discoveredCommands: [],
    patches: [],
    exactPatchEffectAllowed: false
  });
  assert.equal(strategy.classification, "missing");
  assert.equal(truthFromRecursiveValidation({ strategy, evidence: [] }), "not_run_missing_command");
});

test("recursive validation blocks install or network validation scripts", async () => {
  const workspace = await tempWorkspace("recursive-validation-blocked");
  try {
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "npm install" } }), "utf8");
    const commands = discoverRecursiveValidationCommands({ workspacePath: workspace });
    const testCommand = commands.find((command) => command.command === "npm test");
    assert.ok(testCommand);
    assert.equal(testCommand.classification, "blocked");
    const strategy = selectRecursiveValidationStrategy({ discoveredCommands: commands, patches: [], exactPatchEffectAllowed: false });
    assert.equal(truthFromRecursiveValidation({ strategy, evidence: [] }), "not_run_blocked_by_policy");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive validation approval_required evidence remains not_run_needs_approval", async () => {
  const workspace = await tempWorkspace("recursive-validation-approval");
  try {
    const strategy = {
      kind: "command" as const,
      command: "npm run dev",
      cwd: ".",
      classification: "needs_approval" as const,
      scope: "project" as const,
      reason: "Development server command requires approval.",
      source: "test"
    };
    const session = createBareSession(workspace, [{
      id: "exec_approval",
      sessionId: "session_validation_approval",
      requestId: "cmd_approval",
      autoRun: false,
      command: "npm run dev",
      cwd: workspace,
      risk: "medium",
      status: "approval_required",
      stdout: "",
      stderr: "",
      message: "Rust TerminalService requires approval.",
      provenance: { source: "agent", trigger: "manual", executionAuthority: "rust", policyDecision: "require_approval" },
      createdAt: new Date().toISOString()
    }]);
    session.commandRequests.push({
      id: "cmd_approval",
      sessionId: session.id,
      command: "npm run dev",
      cwd: workspace,
      risk: "medium",
      reason: "test",
      status: "requested",
      createdAt: new Date().toISOString()
    });
    const evidence = findRecursiveValidationEvidence({ session, strategy, patches: [] });
    assert.equal(evidence[0]?.truthStatus, "not_run_needs_approval");
    assert.equal(truthFromRecursiveValidation({ strategy, evidence }), "not_run_needs_approval");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("recursive exact patch-effect validation only verifies scoped smoke changes", async () => {
  const workspace = await tempWorkspace("recursive-validation-patch-effect");
  try {
    const target = ".hivo-smoke/effect.txt";
    await mkdir(path.join(workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(workspace, target), "after exact effect\n", "utf8");
    const patch = {
      id: "patch_effect",
      sessionId: "session_patch_effect",
      title: "Patch effect",
      summary: "Patch-effect fixture",
      riskLevel: "low" as const,
      filesChanged: [{ path: target, changeType: "modify" as const, explanation: "fixture" }],
      artifacts: [{ path: target, content: "after exact effect\n" }],
      unifiedDiff: "",
      requiresApproval: true,
      status: "applied" as const,
      createdAt: new Date().toISOString()
    };
    const strategy = selectRecursiveValidationStrategy({ discoveredCommands: [], patches: [patch], exactPatchEffectAllowed: true });
    const evidence = findRecursiveValidationEvidence({ session: createBareSession(workspace), strategy, patches: [patch] });
    assert.equal(strategy.kind, "patch_effect");
    assert.equal(evidence[0]?.truthStatus, "verified_passed");
    assert.equal(evidence[0]?.scope, "patch_effect");
    assert.match(evidence[0]?.summary ?? "", /not whole-project correctness/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("durable factory events replay the active approval gate and recursive graph", async () => {
  const fixture = await createFixture();
  try {
    const createdSnapshot = structuredClone(fixture.runtime.getSession(fixture.sessionId)!);
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    const proposed = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.productSpec!;
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    const approved = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.productSpec!;
    const technicalPlan = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.technicalPlan!;
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graph = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.recursiveGraph!;
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: createdSnapshot } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "product_spec.proposed", actor: "system", authority: "runtime", payload: { productSpec: proposed } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 3, type: "product_spec.approved", actor: "user", authority: "runtime_bridge", payload: { productSpec: approved } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 4, type: "technical_plan.proposed", actor: "system", authority: "runtime", payload: { technicalPlan } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 5, type: "technical_plan.approved", actor: "user", authority: "runtime_bridge", payload: { technicalPlan: fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.technicalPlan! } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 6, type: "recursive_graph.ready", actor: "system", authority: "runtime", payload: { graph } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.phase, "recursive_graph_ready");
    assert.equal(replayed.session?.status, "completed");
    assert.ok(replayed.session?.recursiveFactory?.technicalPlan);
    assert.ok(replayed.session?.recursiveFactory?.recursiveGraph);
    assert.equal(replayed.session?.recursiveFactory?.branchOrchestrators?.length, graph.branches.length);
    assert.equal(replayed.session?.recursiveFactory?.executionStarted, false);
  } finally {
    await fixture.close();
  }
});

test("Product Specification precedes Technical Plan and both gates block execution", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    let session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.resolvedExecutionMode, "recursive_factory");
    assert.equal(session.recursiveFactory?.phase, "product_spec_approval");
    assert.ok(session.recursiveFactory?.productSpec);
    assert.equal(session.recursiveFactory?.technicalPlan, undefined);
    assert.equal(session.recursiveFactory?.recursiveGraph, undefined);
    assertPlanningOnly(session);
    assert.deepEqual(fixture.events.filter(isFactoryEvent).map((event) => event.type), ["runtime.product_spec.proposed"]);

    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.productSpec?.status, "approved");
    assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
    assert.ok(session.recursiveFactory?.technicalPlan);
    assert.equal(session.recursiveFactory?.recursiveGraph, undefined);
    assert.equal(session.status, "needs_approval");
    assertPlanningOnly(session);

    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.technicalPlan?.status, "approved");
    assert.equal(session.recursiveFactory?.phase, "recursive_graph_ready");
    assert.ok(session.recursiveFactory?.recursiveGraph);
    assert.equal(session.recursiveFactory?.branchOrchestrators?.length, session.recursiveFactory?.recursiveGraph?.branches.length);
    assert.equal(session.recursiveFactory?.graphReadiness?.status, "ready");
    for (const branch of session.recursiveFactory?.branchOrchestrators ?? []) {
      assert.equal(branch.status, "planned");
      assert.equal(branch.fileScopes.length > 0, true);
      assert.equal(branch.semanticScopes.length > 0, true);
      assert.equal(branch.lockScopes.length > 0, true);
    }
    assert.equal(session.recursiveFactory?.executionStarted, false);
    assertPlanningOnly(session);
    assert.deepEqual(fixture.events.filter(isFactoryEvent).map((event) => event.type).filter((type) =>
      !type.startsWith("runtime.branch_orchestrator.") && !type.startsWith("runtime.branch_scope.")
    ), [
      "runtime.product_spec.proposed",
      "runtime.product_spec.approved",
      "runtime.technical_plan.proposed",
      "runtime.technical_plan.approved",
      "runtime.recursive_graph.proposed",
      "runtime.recursive_graph.ready"
    ]);
  } finally {
    await fixture.close();
  }
});

test("overlapping branch file scopes create unsafe conflict records and block graph readiness", () => {
  const sessionId = "session_conflict";
  const productSpec = {
    id: "product_spec_conflict",
    sessionId,
    revision: 1,
    status: "approved" as const,
    userGoal: "Build a feature with overlapping UI branches.",
    clarifiedAssumptions: [],
    targetUsers: ["Operators"],
    expectedBehavior: [],
    acceptanceCriteria: [],
    nonGoals: [],
    openQuestions: [],
    risks: ["Overlap risk"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const technicalPlan = {
    id: "technical_plan_conflict",
    sessionId,
    revision: 1,
    status: "approved" as const,
    summary: "Conflict fixture",
    architectureImpact: "Two branches touch one file.",
    affectedAreas: ["UI A", "UI B"],
    projectAreasAffected: ["UI A", "UI B"],
    filesLikelyTouched: ["src/App.tsx"],
    implementationStrategy: [],
    testStrategy: ["npm test"],
    validationCommands: ["npm test"],
    expectedPatchGroups: [],
    rollbackNotes: [],
    riskLevel: "high" as const,
    taskGraph: {
      sessionId,
      nodes: [
        { id: "ui_a", title: "UI A", description: "First UI branch", assignedAgent: "Frontend", status: "pending" as const, dependsOn: [], fileLocks: ["src/App.tsx"], expectedOutput: "A", riskLevel: "medium" as const },
        { id: "ui_b", title: "UI B", description: "Second UI branch", assignedAgent: "Frontend", status: "pending" as const, dependsOn: [], fileLocks: ["src/App.tsx"], expectedOutput: "B", riskLevel: "medium" as const }
      ],
      edges: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const graph = buildHierarchicalRecursiveGraph({ sessionId, productSpec, technicalPlan });
  assert.equal(graph.status, "blocked");
  assert.equal(graph.readiness.status, "blocked");
  assert.equal(graph.readiness.blockedReasons.includes("unsafe_parallel_write_scope"), true);
  assert.equal(graph.conflicts.some((conflict) => conflict.code === "unsafe_parallel_write_scope" && conflict.filePath === "src/App.tsx"), true);
});

test("change requests revise the active artifact without advancing or executing", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    const originalSpec = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.productSpec!;
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "changes_requested", feedback: "Make operators the primary users." });
    let session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.productSpec?.revision, originalSpec.revision + 1);
    assert.match(session.recursiveFactory?.productSpec?.clarifiedAssumptions.join(" ") ?? "", /operators/i);
    assert.equal(session.recursiveFactory?.technicalPlan, undefined);
    assertPlanningOnly(session);

    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    const originalPlan = fixture.runtime.getSession(fixture.sessionId)!.recursiveFactory!.technicalPlan!;
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "rejected", feedback: "Split the UI and runtime patch groups." });
    session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.technicalPlan?.revision, (originalPlan.revision ?? 1) + 1);
    assert.match(session.recursiveFactory?.technicalPlan?.implementationStrategy?.join(" ") ?? "", /Split the UI and runtime/i);
    assert.equal(session.recursiveFactory?.phase, "technical_plan_approval");
    assertPlanningOnly(session);
  } finally {
    await fixture.close();
  }
});

test("branch execution cannot start before Product Spec, Technical Plan, and graph readiness", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await assert.rejects(
      () => fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, { approved: true }),
      /approved Product Specification|approved Technical Plan|ready recursive graph/
    );
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await assert.rejects(
      () => fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, { approved: true }),
      /approved Technical Plan|ready recursive graph/
    );
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    await assert.rejects(
      () => fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, { approved: false as true }),
      /explicit user approval/
    );
  } finally {
    await fixture.close();
  }
});

test("branch executor proposes a patch before apply and does not write directly", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/branch-exec.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before branch execution\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });

    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after branch execution\n"
    });
    assert.equal(session.recursiveFactory?.executionStarted, true);
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.status, "proposed");
    assert.equal(session.patchProposals[0]?.filesChanged.some((file) => file.path === targetFile), true);
    assert.equal(await readFile(path.join(fixture.workspace, targetFile), "utf8"), "before branch execution\n");
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === session.patchProposals[0]?.id);
    assert.ok(branch);
    assert.equal(branch.status, "patch_proposed");
    assert.equal(branch.reviewStatus, "pending");
    assert.equal(branch.patchApplied, false);
  } finally {
    await fixture.close();
  }
});

test("conflicting graph readiness blocks branch execution with explicit reason", async () => {
  const fixture = await createFixture();
  try {
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const session = fixture.runtime.getSession(fixture.sessionId)!;
    const conflict = {
      id: "branch_conflict_test",
      sessionId: fixture.sessionId,
      branchIds: session.recursiveFactory!.branchOrchestrators!.slice(0, 2).map((branch) => branch.branchId),
      filePath: "src/index.ts",
      semanticScope: "file:src/index.ts",
      code: "unsafe_parallel_write_scope" as const,
      severity: "blocking" as const,
      reason: "Two active write branches would touch src/index.ts without ordering.",
      requiresOrdering: true,
      createdAt: new Date().toISOString()
    };
    session.recursiveFactory!.branchScopeConflicts = [conflict];
    session.recursiveFactory!.recursiveGraph!.conflicts = [conflict];
    await assert.rejects(
      () => fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, { approved: true }),
      /unsafe_parallel_write_scope/
    );
    assert.equal(fixture.runtime.getSession(fixture.sessionId)?.recursiveFactory?.phase, "branch_execution_blocked");
  } finally {
    await fixture.close();
  }
});

test("branch status follows patch apply truth and unrun validation never passes", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/branch-validation.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before validation truth\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after validation truth\n"
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.reviewStatus, "approved");
    assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.status, "reviewing");
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "apply_started",
      message: "Rust apply started in test."
    });
    session = fixture.runtime.getSession(fixture.sessionId)!;
    assert.equal(session.recursiveFactory?.branchExecutions?.[0]?.status, "validation_pending");
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Rust apply reported applied in test."
    });
    session = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = session.recursiveFactory?.branchExecutions?.[0];
    assert.ok(branch);
    assert.equal(branch.patchApplied, true);
    assert.equal(branch.status, "validation_pending");
    assert.notEqual(branch.validationStatus, "verified_passed");
    assert.notEqual(session.verificationResult?.truthStatus, "verified_passed");
    assert.equal((session.recursiveFactory?.branchResults?.length ?? 0) >= 1, true);
    assert.equal(session.recursiveFactory?.integrationSummary?.unverifiedBranches.includes(branch.branchId), true);
    assert.equal(session.recursiveFactory?.finalReport?.finalStatus, "unverified");
    assert.notEqual(session.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
    assert.equal(session.recursiveFactory?.finalReport?.patchApplyTruth.some((patch) => patch.patchId === patchId && patch.status === "applied"), true);
  } finally {
    await fixture.close();
  }
});

test("failed branch blocks final verified_passed", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/branch-failed.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before failed branch\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after failed branch\n"
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "failed",
      message: "Rust apply failed in recursive final validation test."
    });
    assert.equal(session.recursiveFactory?.branchResults?.[0]?.appliedState, "apply_failed");
    assert.equal(session.recursiveFactory?.finalReport?.finalStatus, "failed");
    assert.notEqual(session.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
  } finally {
    await fixture.close();
  }
});

test("multi-branch scheduler sequences write branches and aggregates fan-in", async () => {
  const fixture = await createFixture();
  try {
    const firstFile = ".hivo-smoke/multi-one.txt";
    const secondFile = ".hivo-smoke/multi-two.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, firstFile), "before one\n", "utf8");
    await writeFile(path.join(fixture.workspace, secondFile), "before two\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branches = graphSession.recursiveFactory!.branchOrchestrators!.slice(0, 2);
    assert.equal(branches.length, 2);
    for (const branch of branches) {
      branch.dependencies = [];
      branch.fileScopes = [];
      branch.lockScopes = [];
    }
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [
        { branchId: branches[0]!.branchId, targetFile: firstFile, replacementText: "after one\n" },
        { branchId: branches[1]!.branchId, targetFile: secondFile, replacementText: "after two\n" }
      ]
    });
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.recursiveFactory?.branchExecutions?.filter((branch) => branch.active && branch.schedulerDecision.writeBranch).length, 1);
    const firstPatch = session.patchProposals[0]!;
    assert.equal(firstPatch.filesChanged[0]?.path, firstFile);

    await fixture.runtime.approvePatch(fixture.sessionId, firstPatch.id);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, firstPatch.id, { status: "applied", message: "First branch applied." });
    assert.equal(session.patchProposals.length, 2);
    const secondPatch = session.patchProposals[1]!;
    assert.equal(secondPatch.filesChanged[0]?.path, secondFile);
    assert.equal(session.recursiveFactory?.branchExecutions?.find((branch) => branch.proposedPatchId === firstPatch.id)?.active, false);
    assert.equal(session.recursiveFactory?.branchExecutions?.find((branch) => branch.proposedPatchId === secondPatch.id)?.status, "patch_proposed");

    await fixture.runtime.approvePatch(fixture.sessionId, secondPatch.id);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, secondPatch.id, { status: "applied", message: "Second branch applied." });
    assert.equal(session.recursiveFactory?.branchResults?.length, 2);
    assert.equal(session.recursiveFactory?.finalReport?.patchApplyTruth.filter((patch) => patch.status === "applied").length, 2);
    assert.equal(session.recursiveFactory?.finalReport?.finalStatus, "unverified");
    assert.notEqual(session.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: structuredClone(session) } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "recursive_final_report.created", actor: "system", authority: "runtime", payload: { finalReport: session.recursiveFactory!.finalReport! } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.branchResults?.length, 2);
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.branchOutcomes.length, 2);
  } finally {
    await fixture.close();
  }
});

test("dependency ordering waits for parent branch before proposing child", async () => {
  const fixture = await createFixture();
  try {
    const firstFile = ".hivo-smoke/dependency-parent.txt";
    const secondFile = ".hivo-smoke/dependency-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, firstFile), "before parent\n", "utf8");
    await writeFile(path.join(fixture.workspace, secondFile), "before child\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branches = graphSession.recursiveFactory!.branchOrchestrators!.slice(0, 2);
    branches[0]!.dependencies = [];
    branches[1]!.dependencies = [branches[0]!.branchId];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [
        { branchId: branches[0]!.branchId, targetFile: firstFile, replacementText: "after parent\n" },
        { branchId: branches[1]!.branchId, targetFile: secondFile, replacementText: "after child\n" }
      ]
    });
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branches[1]!.branchId)?.status, "waiting_on_dependency");
    const parentPatch = session.patchProposals[0]!;
    await fixture.runtime.approvePatch(fixture.sessionId, parentPatch.id);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, parentPatch.id, { status: "applied", message: "Parent applied." });
    assert.equal(session.patchProposals.length, 2);
    assert.equal(session.recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branches[1]!.branchId)?.status, "patch_proposed");
  } finally {
    await fixture.close();
  }
});

test("failed dependency blocks child branch without silent execution", async () => {
  const fixture = await createFixture();
  try {
    const firstFile = ".hivo-smoke/failed-parent.txt";
    const secondFile = ".hivo-smoke/blocked-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, firstFile), "before parent failure\n", "utf8");
    await writeFile(path.join(fixture.workspace, secondFile), "before blocked child\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branches = graphSession.recursiveFactory!.branchOrchestrators!.slice(0, 2);
    branches[0]!.dependencies = [];
    branches[1]!.dependencies = [branches[0]!.branchId];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [
        { branchId: branches[0]!.branchId, targetFile: firstFile, replacementText: "after parent failure\n" },
        { branchId: branches[1]!.branchId, targetFile: secondFile, replacementText: "after blocked child\n" }
      ]
    });
    const parentPatch = session.patchProposals[0]!;
    await fixture.runtime.approvePatch(fixture.sessionId, parentPatch.id);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, parentPatch.id, { status: "failed", message: "Parent apply failed." });
    const child = session.recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branches[1]!.branchId);
    assert.equal(child?.status, "blocked_failed_dependency");
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.recursiveFactory?.integrationSummary?.blockedBranches.includes(branches[1]!.branchId), true);
    assert.notEqual(session.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
  } finally {
    await fixture.close();
  }
});

test("read-only branches can complete while safe write branch is proposed", async () => {
  const fixture = await createFixture();
  try {
    const writeFilePath = ".hivo-smoke/read-and-write.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, writeFilePath), "before write\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branches = graphSession.recursiveFactory!.branchOrchestrators!.slice(0, 2);
    branches[0]!.dependencies = [];
    branches[0]!.fileScopes = [];
    branches[0]!.lockScopes = [];
    branches[0]!.semanticScopes = ["read-only:architecture"];
    branches[1]!.dependencies = [];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [
        { branchId: branches[1]!.branchId, targetFile: writeFilePath, replacementText: "after write\n" }
      ]
    });
    assert.equal(session.recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branches[0]!.branchId)?.status, "completed");
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.recursiveFactory?.branchResults?.some((result) => result.branchId === branches[0]!.branchId), undefined);
  } finally {
    await fixture.close();
  }
});

test("small branch does not create nested subtasks", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/small-flat.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before small\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after small\n"
    });
    const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.proposedPatchId === session.patchProposals[0]?.id);
    assert.ok(branch);
    assert.equal(branch.nestedSubtasks, undefined);
    assert.equal(branch.nestedEligible, false);
  } finally {
    await fixture.close();
  }
});

test("eligible branch creates one-level nested subtasks and parent waits", async () => {
  const fixture = await createFixture();
  try {
    const parentFile = ".hivo-smoke/nested-parent.txt";
    const nestedFile = ".hivo-smoke/nested-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, parentFile), "before parent\n", "utf8");
    await writeFile(path.join(fixture.workspace, nestedFile), "before nested\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = graphSession.recursiveFactory!.branchOrchestrators![0]!;
    branch.dependencies = [];
    branch.fileScopes = [];
    branch.lockScopes = [];
    graphSession.recursiveFactory!.branchScopeConflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.conflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: "after parent direct path should not apply\n",
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: "after nested\n", objective: "Nested safe subtask patch" }]
      }]
    });
    const branchExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(branchExecution);
    assert.equal(branchExecution.nestedDepth, 1);
    assert.equal(branchExecution.nestedEligible, true);
    assert.equal(branchExecution.nestedSubtasks?.length, 2);
    assert.equal(branchExecution.proposedPatchId, undefined);
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.filesChanged[0]?.path, nestedFile);
    assert.equal(branchExecution.status, "running");
    assert.match(branchExecution.blockedReason ?? "", /waiting for required nested subtasks/i);
    assert.equal(await readFile(path.join(fixture.workspace, nestedFile), "utf8"), "before nested\n");
    assert.equal(branchExecution.nestedSubtasks?.every((subtask) => subtask.depth === 1), true);
  } finally {
    await fixture.close();
  }
});

test("nested depth greater than one is not expanded", async () => {
  const fixture = await createFixture();
  try {
    const parentFile = ".hivo-smoke/nested-depth-parent.txt";
    const nestedFile = ".hivo-smoke/nested-depth-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, parentFile), "before depth parent\n", "utf8");
    await writeFile(path.join(fixture.workspace, nestedFile), "before depth nested\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = graphSession.recursiveFactory!.branchOrchestrators![0]!;
    branch.dependencies = [];
    branch.fileScopes = [];
    branch.lockScopes = [];
    graphSession.recursiveFactory!.branchScopeConflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.conflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: "after depth parent\n",
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: "after forbidden depth two\n", objective: "Forbidden nested depth two" }]
      }]
    });
    const branchExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(branchExecution);
    branchExecution.status = "ready";
    branchExecution.active = false;
    branchExecution.nestedDepth = 1;
    branchExecution.nestedEligible = false;
    branchExecution.nestedSubtasks = undefined;
    branchExecution.nestedRollup = undefined;
    branchExecution.proposedPatchId = undefined;
    branchExecution.blockedReason = undefined;
    session.patchProposals.length = 0;

    await (fixture.runtime as unknown as { advanceRecursiveBranchScheduler(sessionId: string): Promise<void> })
      .advanceRecursiveBranchScheduler(fixture.sessionId);
    session = fixture.runtime.getSession(fixture.sessionId)!;
    const updated = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.equal(updated?.nestedDepth, 1);
    assert.equal(updated?.nestedSubtasks, undefined);
    assert.equal(updated?.nestedEligible, false);
    assert.equal(session.patchProposals.length, 1);
    assert.equal(session.patchProposals[0]?.filesChanged[0]?.path, parentFile);
  } finally {
    await fixture.close();
  }
});

test("nested subtask patch uses apply truth and rolls up into parent/root fan-in", async () => {
  const fixture = await createFixture();
  try {
    const parentFile = ".hivo-smoke/nested-rollup-parent.txt";
    const nestedFile = ".hivo-smoke/nested-rollup-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, parentFile), "before parent rollup\n", "utf8");
    await writeFile(path.join(fixture.workspace, nestedFile), "before nested rollup\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = graphSession.recursiveFactory!.branchOrchestrators![0]!;
    branch.dependencies = [];
    branch.fileScopes = [];
    branch.lockScopes = [];
    graphSession.recursiveFactory!.branchScopeConflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.conflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: "after parent rollup direct path should not apply\n",
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: "after nested rollup\n", objective: "Nested rollup patch" }]
      }]
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, { status: "apply_started", message: "Nested Rust apply started." });
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, { status: "applied", message: "Nested Rust apply reported applied." });
    const branchExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.ok(branchExecution);
    assert.equal(branchExecution.patchApplied, true);
    assert.equal(branchExecution.status, "validation_pending");
    assert.equal(branchExecution.nestedRollup?.appliedPatches.includes(patchId), true);
    assert.equal(branchExecution.nestedRollup?.validationState, "not_run_missing_command");
    assert.equal(session.recursiveFactory?.branchResults?.[0]?.nestedRollup?.appliedPatches.includes(patchId), true);
    assert.equal(session.recursiveFactory?.finalReport?.patchApplyTruth.some((patch) => patch.patchId === patchId && patch.status === "applied"), true);
    assert.equal(session.recursiveFactory?.finalReport?.finalStatus, "unverified");
    assert.notEqual(session.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
  } finally {
    await fixture.close();
  }
});

test("conflicting nested subtasks block duplicate write scopes", async () => {
  const fixture = await createFixture();
  try {
    const parentFile = ".hivo-smoke/nested-conflict-parent.txt";
    const nestedFile = ".hivo-smoke/nested-conflict-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, parentFile), "before conflict parent\n", "utf8");
    await writeFile(path.join(fixture.workspace, nestedFile), "before conflict nested\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = graphSession.recursiveFactory!.branchOrchestrators![0]!;
    branch.dependencies = [];
    branch.fileScopes = [];
    branch.lockScopes = [];
    graphSession.recursiveFactory!.branchScopeConflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.conflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.branches = graphSession.recursiveFactory!.branchOrchestrators!;

    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: "after conflict parent direct path should not apply\n",
        nestedSubtasks: [
          { targetFile: nestedFile, replacementText: "after conflict nested one\n", objective: "Nested conflict one" },
          { targetFile: nestedFile, replacementText: "after conflict nested two\n", objective: "Nested conflict two" }
        ]
      }]
    });
    const branchExecution = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branch.branchId);
    assert.equal(branchExecution?.nestedSubtasks?.some((subtask) => subtask.status === "blocked_conflict"), true);
    assert.match(branchExecution?.nestedSubtasks?.find((subtask) => subtask.status === "blocked_conflict")?.blockedReason ?? "", /unsafe_parallel_write_scope/);
    assert.equal(session.patchProposals.length, 1);
  } finally {
    await fixture.close();
  }
});

test("nested branch replay restores nested tree and fan-in", async () => {
  const fixture = await createFixture();
  try {
    const parentFile = ".hivo-smoke/nested-replay-parent.txt";
    const nestedFile = ".hivo-smoke/nested-replay-child.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, parentFile), "before replay parent\n", "utf8");
    await writeFile(path.join(fixture.workspace, nestedFile), "before replay nested\n", "utf8");
    const createdSnapshot = structuredClone(fixture.runtime.getSession(fixture.sessionId)!);
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const graphSession = fixture.runtime.getSession(fixture.sessionId)!;
    const branch = graphSession.recursiveFactory!.branchOrchestrators![0]!;
    branch.dependencies = [];
    branch.fileScopes = [];
    branch.lockScopes = [];
    graphSession.recursiveFactory!.branchScopeConflicts = [];
    graphSession.recursiveFactory!.recursiveGraph!.conflicts = [];
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      branchTargets: [{
        branchId: branch.branchId,
        targetFile: parentFile,
        replacementText: "after replay parent direct path should not apply\n",
        nestedSubtasks: [{ targetFile: nestedFile, replacementText: "after replay nested\n", objective: "Nested replay patch" }]
      }]
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, { status: "applied", message: "Nested replay apply." });
    const branchExecution = session.recursiveFactory!.branchExecutions!.find((candidate) => candidate.branchId === branch.branchId)!;
    const finalReport = session.recursiveFactory!.finalReport!;
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: createdSnapshot } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "branch_execution.patch_proposed", actor: "system", authority: "runtime", payload: { branchExecution } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 3, type: "recursive_final_report.created", actor: "system", authority: "runtime", payload: { finalReport } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.branchExecutions?.[0]?.nestedSubtasks?.length, 2);
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.branchOutcomes[0]?.nestedRollup?.appliedPatches.includes(patchId), true);
  } finally {
    await fixture.close();
  }
});

test("final report replay restores branch results fan-in and validation truth", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/final-replay.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before final replay\n", "utf8");
    const createdSnapshot = structuredClone(fixture.runtime.getSession(fixture.sessionId)!);
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after final replay\n"
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "apply_started",
      message: "Rust apply started in final replay test."
    });
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Rust apply reported applied in final replay test."
    });
    const branchResult = session.recursiveFactory!.branchResults![0]!;
    const integrationSummary = session.recursiveFactory!.integrationSummary!;
    const finalReport = session.recursiveFactory!.finalReport!;
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: createdSnapshot } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "branch_result.recorded", actor: "system", authority: "runtime", payload: { branchResult } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 3, type: "recursive_fan_in.updated", actor: "system", authority: "runtime", payload: { integrationSummary } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 4, type: "recursive_final_report.created", actor: "system", authority: "runtime", payload: { finalReport } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.branchResults?.[0]?.branchId, branchResult.branchId);
    assert.equal(replayed.session?.recursiveFactory?.integrationSummary?.validation.truthStatus, integrationSummary.validation.truthStatus);
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.finalValidationState, finalReport.finalValidationState);
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.finalStatus, "unverified");
  } finally {
    await fixture.close();
  }
});

test("recursive final report includes scoped validation evidence for verified patch-effect passes", async () => {
  const fixture = await createFixture();
  try {
    await rm(path.join(fixture.workspace, "package.json"), { force: true });
    await writeFile(path.join(fixture.workspace, "README.md"), "Fixture project without validation commands.\n", "utf8");
    const targetFile = ".hivo-smoke/final-evidence.txt";
    const requestedContent = "after final evidence\n";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before final evidence\n", "utf8");
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: requestedContent
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await writeFile(path.join(fixture.workspace, targetFile), requestedContent, "utf8");
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Rust apply reported applied in final evidence test."
    });
    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    assert.equal(finalReport.finalValidationState, "verified_passed");
    assert.equal(finalReport.finalStatus, "passed");
    assert.equal(finalReport.validationDiscovery?.chosenStrategy.kind, "patch_effect");
    assert.equal(finalReport.validationDiscovery?.evidence.some((entry) => entry.kind === "patch_effect" && entry.truthStatus === "verified_passed"), true);
    assert.match(finalReport.validationDiscovery?.statusReason ?? "", /patch-effect|Final recursive validation passed/i);
  } finally {
    await fixture.close();
  }
});

test("replay restores recursive validation strategy and evidence", async () => {
  const fixture = await createFixture();
  try {
    await rm(path.join(fixture.workspace, "package.json"), { force: true });
    await writeFile(path.join(fixture.workspace, "README.md"), "Fixture project without validation commands.\n", "utf8");
    const targetFile = ".hivo-smoke/validation-replay.txt";
    const requestedContent = "after validation replay\n";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before validation replay\n", "utf8");
    const createdSnapshot = structuredClone(fixture.runtime.getSession(fixture.sessionId)!);
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
    let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: requestedContent
    });
    const patchId = session.patchProposals[0]!.id;
    await fixture.runtime.approvePatch(fixture.sessionId, patchId);
    await writeFile(path.join(fixture.workspace, targetFile), requestedContent, "utf8");
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
      status: "applied",
      message: "Rust apply reported applied before replay."
    });
    const finalReport = session.recursiveFactory!.finalReport!;
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: createdSnapshot } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "recursive_final_report.created", actor: "system", authority: "runtime", payload: { finalReport } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.validationDiscovery?.chosenStrategy.kind, "patch_effect");
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.validationDiscovery?.evidence[0]?.truthStatus, "verified_passed");
    assert.equal(replayed.session?.recursiveFactory?.finalReport?.finalValidationState, "verified_passed");
  } finally {
    await fixture.close();
  }
});

test("recursive verified_failed creates diagnosis and skips unrelated repair", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/unrelated-repair.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before unrelated repair\n", "utf8");
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile,
      appliedContent: "after unrelated repair\n",
      stdout: "FAILED tests/test_unrelated.py::test_existing\nAssertionError: existing project failure\n",
      stderr: "",
      exitCode: 1
    });
    const finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    assert.equal(finalReport.finalValidationState, "verified_failed");
    assert.ok(finalReport.repair?.diagnosis);
    assert.match(finalReport.repair.diagnosis.summary, /node --test|npm test/i);
    assert.equal(finalReport.repair.eligibility.status, "repair_not_attempted");
    assert.equal(finalReport.repair.repairPatchId, undefined);
    assert.equal(session.artifacts.some((artifact) => artifact.title === "validation_failure_diagnosis"), true);
  } finally {
    await fixture.close();
  }
});

test("recursive repair patch is proposed only for Rust apply and revalidation uses same command", async () => {
  const targetFile = ".hivo-smoke/repairable.txt";
  const fixture = await createFixture({
    provider: new RecursiveRepairProvider(targetFile, "export const value = 'broken';\n", "export const value = 'fixed';\n")
  });
  try {
    let session = await driveRecursiveValidationFailure(fixture, {
      targetFile,
      appliedContent: "export const value = 'broken';\n",
      stdout: `FAILED tests/test_repairable.py::test_value\n  File "${targetFile}", line 1, in value\nAssertionError: expected fixed\n`,
      stderr: "",
      exitCode: 1
    });
    let finalReport = session.recursiveFactory?.finalReport;
    assert.ok(finalReport);
    assert.equal(finalReport.finalValidationState, "verified_failed");
    assert.equal(finalReport.repair?.eligibility.status, "eligible");
    assert.equal(finalReport.repair?.status, "patch_proposed");
    assert.equal(finalReport.repair?.attemptCount, 1);
    const repairPatchId = finalReport.repair?.repairPatchId;
    assert.ok(repairPatchId);
    assert.equal(finalReport.repair?.revalidationRequestId, undefined);
    assert.equal(session.patchProposals.find((patch) => patch.id === repairPatchId)?.status, "proposed");

    await fixture.runtime.approvePatch(fixture.sessionId, repairPatchId);
    await writeFile(path.join(fixture.workspace, targetFile), "export const value = 'fixed';\n", "utf8");
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, repairPatchId, {
      status: "applied",
      message: "Rust applied recursive repair patch."
    });
    const revalidationRequestId = session.recursiveFactory?.repair?.revalidationRequestId;
    assert.ok(revalidationRequestId);
    const originalCommand = session.recursiveFactory?.repair?.validationAttempts[0]?.command;
    const revalidationRequest = session.commandRequests.find((request) => request.id === revalidationRequestId);
    assert.equal(revalidationRequest?.command, originalCommand);

    session = await fixture.runtime.reportCommandResult(fixture.sessionId, revalidationRequestId, {
      command: revalidationRequest!.command,
      cwd: revalidationRequest!.cwd,
      risk: revalidationRequest!.risk,
      status: "executed",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      message: "Rust revalidation passed.",
      autoRun: true
    });
    finalReport = session.recursiveFactory?.finalReport;
    assert.equal(finalReport?.finalValidationState, "verified_passed");
    assert.equal(finalReport?.finalStatus, "passed");
    assert.equal(finalReport?.repair?.validationAttempts.length, 2);
    assert.equal(finalReport?.repair?.validationAttempts[1]?.role, "repair_revalidation");
  } finally {
    await fixture.close();
  }
});

test("recursive repair attempt is capped and failed revalidation is not green", async () => {
  const targetFile = ".hivo-smoke/repair-still-fails.txt";
  const fixture = await createFixture({
    provider: new RecursiveRepairProvider(targetFile, "broken\n", "fixed\n")
  });
  try {
    let session = await driveRecursiveValidationFailure(fixture, {
      targetFile,
      appliedContent: "broken\n",
      stdout: `FAILED tests/test_repair_still_fails.py::test_value\n  File "${targetFile}", line 1, in value\nAssertionError: expected fixed\n`,
      stderr: "",
      exitCode: 1
    });
    const repairPatchId = session.recursiveFactory?.finalReport?.repair?.repairPatchId;
    assert.ok(repairPatchId);
    await fixture.runtime.approvePatch(fixture.sessionId, repairPatchId);
    await writeFile(path.join(fixture.workspace, targetFile), "fixed\n", "utf8");
    session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, repairPatchId, {
      status: "applied",
      message: "Rust applied recursive repair patch before failing rerun."
    });
    const revalidationRequestId = session.recursiveFactory?.repair?.revalidationRequestId;
    assert.ok(revalidationRequestId);
    const revalidationRequest = session.commandRequests.find((request) => request.id === revalidationRequestId)!;
    session = await fixture.runtime.reportCommandResult(fixture.sessionId, revalidationRequestId, {
      command: revalidationRequest.command,
      cwd: revalidationRequest.cwd,
      risk: revalidationRequest.risk,
      status: "executed",
      exitCode: 1,
      stdout: `FAILED tests/test_repair_still_fails.py::test_value\n  File "${targetFile}", line 1, in value\nAssertionError: still failing\n`,
      stderr: "",
      message: "Rust revalidation still failed.",
      autoRun: true
    });
    const finalReport = session.recursiveFactory?.finalReport;
    assert.equal(finalReport?.finalValidationState, "verified_failed");
    assert.equal(finalReport?.finalStatus, "failed");
    assert.equal(finalReport?.repair?.attemptCount, 1);
    assert.equal(finalReport?.repair?.validationAttempts.length, 2);
    assert.equal(session.patchProposals.filter((patch) => patch.title === "Recursive repair").length, 1);
    assert.equal(finalReport?.repair?.validationAttempts[1]?.truthStatus, "verified_failed");
  } finally {
    await fixture.close();
  }
});

test("recursive attribution marks pytest traceback changed file as high", async () => {
  const targetFile = "src/changed_module.py";
  const fixture = await createFixture({
    provider: new RecursiveRepairProvider(targetFile, "def changed_value():\n    return 'broken'\n", "def changed_value():\n    return 'fixed'\n")
  });
  try {
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile,
      appliedContent: "def changed_value():\n    return 'broken'\n",
      stdout: `FAILED tests/test_changed_module.py::test_changed_value\n  File "${targetFile}", line 1, in changed_value\nAssertionError: expected fixed\n`,
      stderr: "",
      exitCode: 1
    });
    const attribution = session.recursiveFactory?.finalReport?.repair?.diagnosis.attribution;
    assert.equal(attribution?.confidence, "high");
    assert.match(attribution?.evidence.join("\n") ?? "", /Changed file src\/changed_module.py appears/);
    assert.equal(session.recursiveFactory?.finalReport?.repair?.eligibility.status, "eligible");
  } finally {
    await fixture.close();
  }
});

test("recursive attribution marks node file URL stack frame changed file as high", async () => {
  const targetFile = ".hivo-smoke/url-stack/module.mjs";
  const fixture = await createFixture({
    provider: new RecursiveRepairProvider(targetFile, "export const value = 'broken';\n", "export const value = 'fixed';\n")
  });
  try {
    const moduleUrl = pathToFileURL(path.join(fixture.workspace, targetFile)).href;
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile,
      appliedContent: "export const value = 'broken';\n",
      stdout: [
        "TAP version 13",
        "# Subtest: recursive high attribution repair",
        "not ok 1 - recursive high attribution repair",
        "  failureType: 'testCodeFailure'",
        "  error: |-",
        "    Expected values to be strictly equal:",
        "    'broken' !== 'fixed'",
        "  stack: |-",
        `    verifySmokeValue (${moduleUrl}:6:10)`
      ].join("\n"),
      stderr: "",
      exitCode: 1
    });
    const attribution = session.recursiveFactory?.finalReport?.repair?.diagnosis.attribution;
    assert.equal(attribution?.confidence, "high");
    assert.match(attribution?.evidence.join("\n") ?? "", /Changed file \.hivo-smoke\/url-stack\/module\.mjs appears/);
    assert.equal(session.recursiveFactory?.finalReport?.repair?.eligibility.status, "eligible");
  } finally {
    await fixture.close();
  }
});

test("recursive attribution ignores traceback to unrelated files", async () => {
  const fixture = await createFixture();
  try {
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile: "src/changed-unrelated.ts",
      appliedContent: "export const unrelated = true;\n",
      stdout: "FAILED tests/test_unrelated.py::test_existing\n  File \"src/existing.py\", line 12, in existing\nAssertionError: existing failure\n",
      stderr: "",
      exitCode: 1
    });
    const attribution = session.recursiveFactory?.finalReport?.repair?.diagnosis.attribution;
    assert.equal(attribution?.confidence, "none");
    assert.deepEqual(attribution?.relatedPatchIds, []);
    assert.equal(session.recursiveFactory?.finalReport?.repair?.eligibility.status, "repair_not_attempted");
  } finally {
    await fixture.close();
  }
});

test("recursive attribution records import of changed module as medium but does not repair by default", async () => {
  const fixture = await createFixture();
  try {
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile: "src/payment.py",
      appliedContent: "PAYMENT_MODE = 'broken'\n",
      stdout: "FAILED tests/test_payment.py::test_mode\nfrom payment import PAYMENT_MODE\nAssertionError: expected paid\n",
      stderr: "",
      exitCode: 1
    });
    const repair = session.recursiveFactory?.finalReport?.repair;
    assert.equal(repair?.diagnosis.attribution.confidence, "medium");
    assert.match(repair?.diagnosis.attribution.evidence.join("\n") ?? "", /imports changed module payment/);
    assert.equal(repair?.eligibility.status, "repair_not_attempted");
    assert.match(repair?.eligibility.reasons.join("\n") ?? "", /requires high failure-to-patch attribution/i);
  } finally {
    await fixture.close();
  }
});

test("recursive attribution keeps generic failures unrelated", async () => {
  const fixture = await createFixture();
  try {
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile: "src/generic.ts",
      appliedContent: "export const generic = true;\n",
      stdout: "1 test failed\nAssertionError: expected true\n",
      stderr: "",
      exitCode: 1
    });
    const repair = session.recursiveFactory?.finalReport?.repair;
    assert.equal(repair?.diagnosis.attribution.confidence, "none");
    assert.equal(repair?.eligibility.status, "repair_not_attempted");
  } finally {
    await fixture.close();
  }
});

test("recursive stale memory cannot boost attribution without validation-output evidence", async () => {
  const fixture = await createFixture();
  try {
    await saveMemory(fixture.workspace, { indexState: { status: "stale" } });
    const session = await driveRecursiveValidationFailure(fixture, {
      targetFile: "src/memory-only.ts",
      appliedContent: "export const memoryOnly = true;\n",
      stdout: "FAILED tests/test_memory.py::test_memory\nAssertionError: memory says this file changed\n",
      stderr: "",
      exitCode: 1
    });
    const attribution = session.recursiveFactory?.finalReport?.repair?.diagnosis.attribution;
    assert.equal(attribution?.memoryFreshness, "stale");
    assert.equal(attribution?.confidence, "none");
    assert.deepEqual(attribution?.relatedPatchIds, []);
  } finally {
    await fixture.close();
  }
});

test("durable replay preserves branch execution records", async () => {
  const fixture = await createFixture();
  try {
    const targetFile = ".hivo-smoke/branch-replay.txt";
    await mkdir(path.join(fixture.workspace, ".hivo-smoke"), { recursive: true });
    await writeFile(path.join(fixture.workspace, targetFile), "before replay\n", "utf8");
    const createdSnapshot = structuredClone(fixture.runtime.getSession(fixture.sessionId)!);
    await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
    await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
    await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
    const session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
      approved: true,
      targetFile,
      replacementText: "after replay\n"
    });
    const branchExecution = session.recursiveFactory!.branchExecutions![0]!;
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 1, type: "session.created", actor: "system", authority: "system", payload: { session: createdSnapshot } }),
      createDurableRuntimeEvent({ sessionId: fixture.sessionId, sequence: 2, type: "branch_execution.patch_proposed", actor: "system", authority: "runtime", payload: { branchExecution } })
    ]);
    assert.equal(replayed.session?.recursiveFactory?.executionStarted, true);
    assert.equal(replayed.session?.recursiveFactory?.branchExecutions?.[0]?.branchId, branchExecution.branchId);
    assert.equal(replayed.session?.recursiveFactory?.branchExecutions?.[0]?.status, "patch_proposed");
  } finally {
    await fixture.close();
  }
});

function assertPlanningOnly(session: NonNullable<ReturnType<AgentRuntime["getSession"]>>) {
  assert.equal(session.tasks.length, 0);
  assert.equal(session.patchProposals.length, 0);
  assert.equal(session.commandRequests.length, 0);
  assert.equal(session.commandExecutions.length, 0);
  assert.equal(session.recursiveFactory?.executionStarted, false);
}

function isFactoryEvent(event: AppEvent) {
  return event.type.startsWith("runtime.product_spec.")
    || event.type.startsWith("runtime.technical_plan.")
    || event.type.startsWith("runtime.recursive_graph.")
    || event.type.startsWith("runtime.branch_orchestrator.")
    || event.type.startsWith("runtime.branch_execution.")
    || event.type.startsWith("runtime.branch_result.")
    || event.type.startsWith("runtime.recursive_fan_in.")
    || event.type.startsWith("runtime.recursive_final_report.")
    || event.type.startsWith("runtime.branch_scope.");
}

async function tempWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function createBareSession(workspace: string, commandExecutions: CommandExecutionRecord[] = []): AgentRuntimeSession {
  const now = new Date().toISOString();
  return {
    id: "session_validation_approval",
    workspacePath: workspace,
    mode: "real_provider",
    trustProfile: "strict_gated",
    executionMode: "auto_mode",
    accessProfile: "default_permissions",
    declaredAccess: declaredAccessPolicyForProfile("default_permissions"),
    resolvedAccess: resolvedAccessPolicyForProfile("default_permissions"),
    runPhases: [],
    decisionLedger: [],
    thinkFirst: false,
    userPrompt: "test",
    agentName: "test",
    status: "created",
    lifecycleStage: "INTAKE",
    taskState: {
      version: 1,
      phase: "created",
      pendingCommandIds: [],
      completedCommandIds: [],
      failedCommandIds: [],
      transitions: []
    },
    messages: [],
    tasks: [],
    toolCalls: [],
    toolIntents: [],
    artifacts: [],
    patchProposals: [],
    commandRequests: [],
    commandExecutions,
    backgroundJobs: [],
    reasoningSummaries: [],
    progressEvents: [],
    agentWorkStatuses: [],
    createdAt: now,
    updatedAt: now
  };
}

async function driveRecursiveValidationFailure(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  input: { targetFile: string; appliedContent: string; stdout: string; stderr: string; exitCode: number }
) {
  await mkdir(path.dirname(path.join(fixture.workspace, input.targetFile)), { recursive: true });
  await writeFile(path.join(fixture.workspace, input.targetFile), "before recursive repair fixture\n", "utf8");
  await fixture.runtime.runTurn(fixture.sessionId, largePrompt);
  await fixture.runtime.decideProductSpec(fixture.sessionId, { decision: "approved" });
  await fixture.runtime.decideTechnicalPlan(fixture.sessionId, { decision: "approved" });
  narrowToFirstBranch(fixture.runtime.getSession(fixture.sessionId)!);
  let session = await fixture.runtime.startRecursiveBranchExecution(fixture.sessionId, {
    approved: true,
    targetFile: input.targetFile,
    replacementText: input.appliedContent
  });
  const patchId = session.patchProposals[0]!.id;
  await fixture.runtime.approvePatch(fixture.sessionId, patchId);
  await writeFile(path.join(fixture.workspace, input.targetFile), input.appliedContent, "utf8");
  session = await fixture.runtime.reportPatchApplyResult(fixture.sessionId, patchId, {
    status: "applied",
    message: "Rust applied recursive fixture patch."
  });
  const request = session.commandRequests.find((candidate) => candidate.risk === "safe" && !session.commandExecutions.some((execution) => execution.requestId === candidate.id));
  assert.ok(request);
  return await fixture.runtime.reportCommandResult(fixture.sessionId, request.id, {
    command: request.command,
    cwd: request.cwd,
    risk: request.risk,
    status: "executed",
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    message: "Rust validation failed in recursive fixture.",
    autoRun: true
  });
}

function narrowToFirstBranch(session: AgentRuntimeSession) {
  const factory = session.recursiveFactory;
  const branch = factory?.branchOrchestrators?.[0];
  if (!factory || !branch || !factory.recursiveGraph) return;
  branch.dependencies = [];
  factory.branchOrchestrators = [branch];
  factory.recursiveGraph.branches = [branch];
  factory.recursiveGraph.dependencies = [];
  factory.branchScopeConflicts = [];
  factory.recursiveGraph.conflicts = [];
}

class RecursiveRepairProvider implements LlmProvider {
  constructor(
    private readonly targetFile: string,
    private readonly preimageText: string,
    private readonly replacementText: string
  ) {}

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    const name = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (name === "run-patch-intent") {
      return {
        title: "Recursive repair",
        summary: `Repair ${this.targetFile} for recursive validation.`,
        intents: [{
          path: this.targetFile,
          operation: "replace_range",
          preimageText: this.preimageText,
          replacementText: this.replacementText,
          reason: "Fix the diagnosed validation failure in the applied recursive patch.",
          risk: "low"
        }],
        suggestedCommands: [{ command: "npm test", reason: "Rerun the same validation command." }]
      } as T;
    }
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return `recursive repair provider fixture: ${input.userPrompt.slice(0, 40)}`;
  }
}

async function createFixture(options: { provider?: LlmProvider } = {}) {
  const workspace = path.join(os.tmpdir(), `hivo-recursive-factory-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const storageDir = `${workspace}-storage`;
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "index.ts"), "export const ready = true;\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  const eventBus = new EventBus();
  const events: AppEvent[] = [];
  eventBus.subscribe((event) => events.push(event));
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime(
    { ...loadConfig(), storageDir },
    sessionManager,
    options.provider ? { providerFactory: () => options.provider! } : {}
  );
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "recursive_factory",
    userPrompt: largePrompt
  });
  return {
    runtime,
    events,
    workspace,
    sessionId: created.sessionId,
    close: async () => {
      await rm(workspace, { recursive: true, force: true });
      await rm(storageDir, { recursive: true, force: true });
    }
  };
}
