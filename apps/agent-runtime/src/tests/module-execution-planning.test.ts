import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSession, ModuleExecutionPlan, PatchProposal, ProjectIntake, VerificationResult } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { buildModuleExecutionPlan, summarizeModuleExecution, validatePatchAgainstModulePlan } from "../runtime/ModuleExecutionPlanning.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("existing project edit records intake and Knowledge Tree route before implementation", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-module-plan-existing-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-module-plan-existing-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox", scripts: { test: "echo ok" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const main = true;\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "update the main module"
    });
    await runtime.runTurn(created.sessionId, "update the main module");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.moduleExecutionPlan, undefined);
    assert.ok(session?.projectKnowledgeTree);
    assert.ok(session?.latestKnowledgeRoute);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "project_intake"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "context_pack"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "project_knowledge_tree"));
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "knowledge_edit_route"));
    assert.ok((session?.decisionLedger ?? []).some((record) => /Project Knowledge Tree/i.test(record.decision)));
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("empty project does not force continuation module planning", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-module-plan-empty-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-module-plan-empty-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "create a new app"
    });
    await runtime.runTurn(created.sessionId, "create a new app");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.projectIntake?.projectKind, "empty_project");
    assert.equal(session?.moduleExecutionPlan, undefined);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("unknown project prefers inspect-only over broad implementation assumptions", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-module-plan-unknown-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-module-plan-unknown-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "tests", "smoke.test.snap"), "fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "continue this project"
    });
    await runtime.runTurn(created.sessionId, "continue this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.projectIntake?.projectKind, "unknown");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.verificationResult?.status, "passed");
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("context pack fields flow into the module execution plan", () => {
  const intake = createIntakeFixture();
  const modulePlan = buildModuleExecutionPlan({
    sessionId: "session_1",
    workspaceRoot: "workspace",
    objective: "update auth module",
    createdAt: "2026-05-15T00:00:00.000Z",
    intake,
    contextPack: intake.contextPack,
    targetFiles: ["src/auth.ts"],
    suggestedCommands: ["npm test"]
  });

  assert.ok(modulePlan.allowedPaths.includes("src/auth.ts"));
  assert.ok(modulePlan.cautionPaths.includes("package.json"));
  assert.ok(modulePlan.forbiddenPaths.includes(".git/"));
  assert.ok(modulePlan.publicContractsToPreserve.includes("src/auth.ts"));
  assert.ok(modulePlan.verificationCommands.includes("npm test"));
  assert.ok(modulePlan.targetMechanismChain?.includes("Auth form calls backend"));
  assert.ok(modulePlan.confirmedRelevantFiles?.includes("src/auth.ts"));
  assert.ok(modulePlan.safeEditSurface?.includes("src/auth.ts"));
  assert.ok(modulePlan.unknowns.includes("Missing mechanism link: backend_handler"));
});

test("Knowledge Tree route records target files and review chain for existing project edit", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-module-contract-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-module-contract-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox" }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "auth.ts"), "export const auth = true;\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "update auth.ts"
    });
    await runtime.runTurn(created.sessionId, "update auth.ts");
    const session = runtime.getSession(created.sessionId);
    const tree = session?.projectKnowledgeTree;
    const route = session?.latestKnowledgeRoute;

    assert.ok(tree);
    assert.ok(route);
    assert.ok(tree.fileOwnership.some((entry) => entry.path === "src/auth.ts"));
    assert.ok(route.plan.requiredReviewChain.rootIntegrationReview.length > 0);
    assert.equal(session?.patchProposals.length, 0);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("scope validator marks allowed paths as in scope", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture([{ path: "src/auth.ts", changeType: "modify", explanation: "edit auth" }]);
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "in_scope");
    assert.deepEqual(validation.allowedChanges, ["src/auth.ts"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scope validator marks caution paths as needs review", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture([{ path: "package.json", changeType: "modify", explanation: "tweak package" }]);
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "needs_review");
    assert.deepEqual(validation.cautionChanges, ["package.json"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("scope validator blocks forbidden paths", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture([{ path: "dist/bundle.js", changeType: "modify", explanation: "compiled output" }]);
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "blocked");
    assert.deepEqual(validation.forbiddenChanges, ["dist/bundle.js"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("unexpected new files are not silently allowed", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture([{ path: "notes/new-plan.md", changeType: "create", explanation: "parallel system" }]);
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "blocked");
    assert.deepEqual(validation.unexpectedNewFiles, ["notes/new-plan.md"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("deletes of preserved contract files are blocked", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture([{ path: "src/auth.ts", changeType: "delete", explanation: "remove auth" }]);
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "blocked");
    assert.ok(validation.deletionOrRenameConcerns.some((concern) => concern.includes("src/auth.ts")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("new dependency changes require review unless explicitly allowed", async () => {
  const workspace = await createWorkspaceWithPackage();
  try {
    const modulePlan = createModulePlanFixture();
    const patch = createPatchFixture(
      [{ path: "package.json", changeType: "modify", explanation: "add dependency" }],
      [{ path: "package.json", content: JSON.stringify({ name: "fixture", dependencies: { zod: "^3.0.0" } }, null, 2) }]
    );
    const validation = validatePatchAgainstModulePlan(modulePlan, patch, new ToolRegistry(workspace).workspace);

    assert.equal(validation.verdict, "needs_review");
    assert.ok(validation.dependencyConcerns.some((concern) => concern.includes("zod")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Knowledge Tree route stops existing project edit before review-gate application", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-scope-review-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-scope-review-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "voxbox", scripts: { test: "echo ok" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Voxbox\n", "utf8");
  await writeFile(path.join(workspace, "src", "main.ts"), "export const main = true;\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  try {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "update the main module"
    });
    await runtime.runTurn(created.sessionId, "update the main module");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.reviewGate, undefined);
    assert.ok(session?.latestKnowledgeRoute);
    assert.equal(session?.runSummary?.gates[0]?.name, "Project Knowledge Tree routing");
    assert.match(session?.messages.at(-1)?.content ?? "", /Execution has not started/i);
  } finally {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("module completion summary stays conservative and records verification state", () => {
  const session = createSessionFixture();
  const verification: VerificationResult = {
    id: "verification_1",
    sessionId: session.id,
    status: "passed",
    summary: "done",
    checks: [{ name: "npm test", status: "passed", detail: "ok" }],
    createdAt: "2026-05-15T00:00:00.000Z"
  };
  const summary = summarizeModuleExecution(session, verification);

  assert.ok(summary);
  assert.equal(summary?.status, "complete");
  assert.equal(summary?.scopeVerdict, "in_scope");
  assert.deepEqual(summary?.completedAcceptanceCriteria, session.moduleExecutionPlan?.acceptanceCriteria);
});

function createIntakeFixture(): ProjectIntake {
  return {
    projectId: "project_1",
    workspaceRoot: "workspace",
    detectedProjectName: "voxbox",
    intakeStatus: "completed",
    projectKind: "existing_project",
    confidence: "high",
    detectedSignals: [],
    architectureSummary: "TypeScript app",
    moduleSummary: ["src/"],
    knownEntryPoints: ["src/auth.ts"],
    knownCommands: ["npm test"],
    testCommands: ["npm test"],
    buildCommands: ["npm run build"],
    importantFiles: ["src/auth.ts", "package.json"],
    riskyFiles: ["package.json"],
    doNotTouchCandidates: [".git/", "dist/"],
    currentStateSummary: "Existing project",
    nextActionRecommendation: "Inspect src/auth.ts before editing.",
    unknowns: ["Unknown test coverage"],
    warnings: ["Use caution in package.json"],
    progressReconstruction: {
      inferred: true,
      summary: "Inferred progress",
      implementedAreas: ["src/"],
      partialAreas: [],
      missingAreas: [],
      brokenAreas: [],
      previousPlanEvidence: [],
      nextSafeAction: "Inspect src/auth.ts before editing.",
      warnings: ["Inferred only"]
    },
    contextPack: {
      projectSummary: "Existing project",
      currentTaskObjective: "update auth module",
      relevantFiles: ["src/auth.ts"],
      relatedTests: ["tests/auth.test.ts"],
      conventionsDiscovered: ["Tests use .test.ts naming."],
      apisLikelyToPreserve: ["src/auth.ts"],
      safeToEdit: ["src/auth.ts"],
      cautionPaths: ["package.json"],
      doNotTouchCandidates: [".git/", "dist/"],
      acceptanceCriteriaDraft: ["Keep auth API stable.", "Run npm test."],
      verificationCommands: ["npm test"],
      knownRisks: ["Package changes require review."],
      unknowns: ["Unknown test coverage"],
      guardrails: {
        summary: "Read wide, edit narrow.",
        rules: ["No deleting files without explicit approval."]
      },
      targetMechanismChain: ["Auth form calls backend"],
      confirmedRelevantFiles: ["src/auth.ts"],
      missingEvidenceLinks: ["backend_handler"],
      safeEditSurface: ["src/auth.ts"]
    },
    runIntent: "implement_module",
    guardrails: {
      summary: "Read wide, edit narrow.",
      rules: ["No deleting files without explicit approval."]
    }
  };
}

function createModulePlanFixture(): ModuleExecutionPlan {
  return {
    id: "module_plan_1",
    sessionId: "session_1",
    projectId: "project_1",
    workspaceRoot: "workspace",
    source: "inferred_from_intake",
    status: "ready",
    title: "Auth module",
    objective: "update auth",
    rationale: "Scope auth.ts only",
    relevantFiles: ["src/auth.ts"],
    ownedPaths: ["src/auth.ts"],
    allowedPaths: ["src/auth.ts", "src"],
    cautionPaths: ["package.json"],
    forbiddenPaths: [".git/", "dist/"],
    expectedNewFiles: [],
    disallowedNewFiles: ["dist/"],
    requiredExistingPatterns: ["Keep existing auth API stable."],
    publicContractsToPreserve: ["src/auth.ts"],
    acceptanceCriteria: ["Keep auth API stable.", "Run npm test."],
    verificationCommands: ["npm test"],
    risks: ["Package changes require review."],
    unknowns: ["Unknown test coverage"],
    stopConditions: ["Stop outside scope."],
    approvalRequiredReasons: ["Caution paths require review."],
    targetMechanismChain: ["Auth form calls backend"],
    confirmedRelevantFiles: ["src/auth.ts"],
    missingEvidenceLinks: [],
    safeEditSurface: ["src/auth.ts"],
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z"
  };
}

function createPatchFixture(
  filesChanged: PatchProposal["filesChanged"],
  artifacts: NonNullable<PatchProposal["artifacts"]> = []
): PatchProposal {
  return {
    id: "patch_1",
    sessionId: "session_1",
    title: "Patch",
    summary: "Patch summary",
    riskLevel: "medium",
    filesChanged,
    artifacts,
    unifiedDiff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-export const auth = true;\n+export const auth = false;\n",
    requiresApproval: true,
    status: "proposed",
    createdAt: "2026-05-15T00:00:00.000Z"
  };
}

function createSessionFixture(): AgentRuntimeSession {
  const modulePlan = createModulePlanFixture();
  return {
    id: "session_1",
    workspacePath: "workspace",
    mode: "real_provider",
    trustProfile: "strict_gated",
    executionMode: "simple_mode",
    accessProfile: "default_permissions",
    declaredAccess: {
      accessProfile: "default_permissions",
      trustProfile: "strict_gated",
      requestedAuthority: "human_gated",
      requestedCapabilities: ["read_workspace", "propose_patch", "request_command"]
    },
    resolvedAccess: undefined,
    runPhases: [],
    decisionLedger: [],
    projectIntake: createIntakeFixture(),
    contextPack: createIntakeFixture().contextPack,
    runIntent: "implement_module",
    moduleExecutionPlan: { ...modulePlan, status: "completed" },
    moduleExecutionSummaries: [],
    latestScopeValidation: {
      allowedChanges: ["src/auth.ts"],
      cautionChanges: [],
      forbiddenChanges: [],
      unexpectedNewFiles: [],
      deletionOrRenameConcerns: [],
      dependencyConcerns: [],
      publicContractConcerns: [],
      verdict: "in_scope",
      reasons: []
    },
    reviewGate: {
      totalFilesChanged: 1,
      changesByAgent: [],
      riskyAreas: [],
      verificationChecks: [],
      unresolvedBlockers: [],
      recommendation: "ready",
      summary: "ready",
      scopeValidation: {
        allowedChanges: ["src/auth.ts"],
        cautionChanges: [],
        forbiddenChanges: [],
        unexpectedNewFiles: [],
        deletionOrRenameConcerns: [],
        dependencyConcerns: [],
        publicContractConcerns: [],
        verdict: "in_scope",
        reasons: []
      }
    },
    reconciliationReport: undefined,
    thinkFirst: false,
    userPrompt: "update auth",
    agentName: "Hivo",
    status: "completed",
    lifecycleStage: "DONE",
    taskState: {
      version: 1,
      phase: "completed",
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
    patchProposals: [createPatchFixture([{ path: "src/auth.ts", changeType: "modify", explanation: "edit auth" }])],
    commandRequests: [],
    commandExecutions: [],
    backgroundJobs: [],
    reasoningSummaries: [],
    progressEvents: [],
    agentWorkStatuses: [],
    runSummary: {
      status: "completed",
      summary: "done",
      filesChanged: [{ path: "src/auth.ts", changeType: "modify" }],
      appliedPatchIds: ["patch_1"],
      proposedPatchIds: [],
      commandResults: [],
      gates: [],
      nextAction: "done",
      createdAt: "2026-05-15T00:00:00.000Z"
    },
    verificationResult: undefined,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z"
  };
}

async function createWorkspaceWithPackage() {
  const workspace = path.join(os.tmpdir(), `hivo-scope-fixture-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture", dependencies: {} }, null, 2), "utf8");
  return workspace;
}
