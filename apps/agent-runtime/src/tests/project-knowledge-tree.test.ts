import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { declaredAccessPolicyForProfile, resolvedAccessPolicyForProfile, type AgentRuntimeSession, type AppEvent } from "@hivo/protocol";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { createDurableRuntimeEvent } from "../runtime/DurableRuntimeEvents.js";
import { EventBus } from "../runtime/EventBus.js";
import {
  buildProjectKnowledgeTree,
  createKnowledgeGuidedEditPlan,
  createKnowledgeRecursivePlanning,
  routeKnowledgeQuery,
  validateProjectKnowledgeNode
} from "../runtime/ProjectKnowledgeTree.js";
import { replaySessionFromDurableEvents } from "../runtime/SessionReplay.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("ProjectKnowledgeTree creates owners and required area routes from repo evidence", async () => {
  const workspace = await createKnowledgeFixture("knowledge-tree-create");
  try {
    await rebuildRepoIndex(workspace);
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    assert.equal(tree.memoryFreshness.status, "fresh");
    assert.ok(tree.nodes.find((node) => node.nodeId === "root"));
    assert.ok(tree.nodes.find((node) => node.nodeId === "frontend_ui"));
    assert.ok(tree.nodes.find((node) => node.nodeId === "backend_entry_api"));
    assert.ok(tree.nodes.find((node) => node.nodeId === "config_dependencies"));
    assert.ok(tree.nodes.find((node) => node.nodeId === "tests_validation"));
    assert.equal(tree.completeness.status, "ready");
    assert.equal(tree.nodes.every((node) => node.completeness.status === "complete"), true);
    assert.equal(validateProjectKnowledgeNode({ nodeId: "broken" }).status, "incomplete");
    assert.equal(ownerFor(tree, "frontend/app.js")?.primaryOwnerNodeId.startsWith("file_frontend_app_js"), true);
    assert.equal(tree.ownershipMap["frontend/app.js"]?.primaryOwnerNodeId, ownerFor(tree, "frontend/app.js")?.primaryOwnerNodeId);
    assert.equal(tree.routeDetails.some((route) => route.pattern === "frontend/app.js" && route.targetNodeId === "frontend_ui"), true);
    assert.equal(tree.rootRoutingGuarantees.filter((guarantee) => guarantee.matchingFiles.length).every((guarantee) => guarantee.status === "passed"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectKnowledgeTree reports important orphaned files instead of inventing owners", async () => {
  const workspace = await createKnowledgeFixture("knowledge-tree-orphan");
  try {
    await writeFile(path.join(workspace, "mystery_tool.py"), "def unknown_owner():\n    return True\n", "utf8");
    await rebuildRepoIndex(workspace);
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    assert.ok(ownerFor(tree, "mystery_tool.py") || tree.orphanedFiles.some((file) => file.path === "mystery_tool.py"));
    assert.equal(tree.fileOwnership.every((owner) => Boolean(owner.primaryOwnerNodeId)), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectKnowledgeTree marks stale memory and still maps changed workspace files directly", async () => {
  const workspace = await createKnowledgeFixture("knowledge-tree-stale");
  try {
    await rebuildRepoIndex(workspace);
    await writeFile(path.join(workspace, "backend", "new_auth.py"), "def login_user_v2():\n    return True\n", "utf8");
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    assert.equal(tree.memoryFreshness.status, "stale");
    assert.ok(tree.memoryFreshness.newFiles.includes("backend/new_auth.py"));
    assert.ok(ownerFor(tree, "backend/new_auth.py"));
    const route = routeKnowledgeQuery({ tree, request: "Update backend new_auth login_user_v2." });
    assert.notEqual(route.confidenceLevel, "high");
    assert.ok(route.confidence <= 0.6);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Knowledge Query Router routes auth edits to owned files, reviewers, risks, and branch targets", async () => {
  const workspace = await createKnowledgeFixture("knowledge-route-auth");
  try {
    await rebuildRepoIndex(workspace);
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    const route = routeKnowledgeQuery({ tree, request: "Update the login/auth flow across backend and frontend." });
    const routedEdit = createKnowledgeGuidedEditPlan({ tree, route, request: route.request });
    assert.ok(route.affectedNodeIds.some((nodeId) => /auth|frontend|backend/.test(nodeId)));
    assert.ok(route.likelyFiles.some((file) => /auth|frontend|backend/.test(file)));
    assert.ok(route.reviewerNodes.includes("root"));
    assert.ok(routedEdit.plan.requiredReviewChain.rootIntegrationReview.includes("root"));
    assert.equal(routedEdit.intentSummary, routedEdit.plan.userIntentSummary);
    assert.deepEqual(routedEdit.reviewChain, routedEdit.plan.requiredReviewChain);
    assert.equal(routedEdit.executionStarted, false);
    assert.equal(routedEdit.plan.executionStarted, false);
    assert.ok(routedEdit.evidenceUsed.length > 0);
    assert.ok(routedEdit.filesNotToTouch.length > 0);
    assert.equal(routedEdit.plan.suggestedBranchTargets.every((target) => target.status === "planned" || target.executionModeHint === "read_only"), true);
    assert.equal(routedEdit.plan.executionState, "Execution has not started. This edit was routed through the Project Knowledge Tree.");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Knowledge routed edit plan converts to owner-split branch targets and planned recursive records", async () => {
  const workspace = await createKnowledgeFixture("knowledge-branch-targets");
  try {
    await rebuildRepoIndex(workspace);
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    const route = routeKnowledgeQuery({ tree, request: "Update the login/auth flow across backend and frontend." });
    const routedEdit = createKnowledgeGuidedEditPlan({ tree, route, request: route.request });
    const targets = routedEdit.knowledgeBranchTargets;
    assert.ok(targets.length >= 2, "frontend/backend owners should split into separate branch targets");
    assert.equal(new Set(targets.map((target) => target.primaryOwnerNodeId)).size, targets.length);
    assert.equal(targets.every((target) => target.filesAllowed.length > 0), true);
    assert.equal(targets.every((target) => target.filesForbidden.length > 0), true);
    assert.equal(targets.every((target) => target.requiredReviewChain.rootIntegrationReview.includes(tree.rootNodeId)), true);
    assert.equal(targets.every((target) => target.evidenceUsed.length > 0), true);
    const planned = createKnowledgeRecursivePlanning({ sessionId: "session_knowledge_targets", routedEdit });
    assert.equal(planned.branchExecutions.length, targets.length);
    assert.equal(planned.branchExecutions.every((branch) => branch.active === false && branch.patchApplied === false && branch.status === "planned_only"), true);
    assert.equal(planned.graph.status, "ready");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("KnowledgeBranchTarget blocks incomplete owners, stale owners, low confidence, and missing review chain", async () => {
  const workspace = await createKnowledgeFixture("knowledge-branch-blocks");
  try {
    await rebuildRepoIndex(workspace);
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    const route = routeKnowledgeQuery({ tree, request: "Update backend auth login validation." });
    const baseline = createKnowledgeGuidedEditPlan({ tree, route, request: route.request });
    const firstTarget = baseline.knowledgeBranchTargets[0]!;

    const incompleteTree = structuredClone(tree);
    const incompleteOwner = incompleteTree.nodes.find((node) => node.nodeId === firstTarget.primaryOwnerNodeId)!;
    incompleteOwner.summary = "";
    incompleteOwner.completeness = validateProjectKnowledgeNode(incompleteOwner);
    const incompletePlan = createKnowledgeGuidedEditPlan({ tree: incompleteTree, route, request: route.request });
    assert.ok(incompletePlan.knowledgeBranchTargets.some((target) => target.blockedReasons.includes("owner_node_incomplete")));

    const staleTree = structuredClone(tree);
    const staleOwner = staleTree.nodes.find((node) => node.nodeId === firstTarget.primaryOwnerNodeId)!;
    staleOwner.freshness = { ...staleOwner.freshness, status: "stale" };
    staleTree.memoryFreshness = { ...staleTree.memoryFreshness, status: "stale" };
    const staleRoute = { ...route, confidence: 0.9, confidenceLevel: "high" as const };
    const stalePlan = createKnowledgeGuidedEditPlan({ tree: staleTree, route: staleRoute, request: route.request });
    assert.ok(stalePlan.knowledgeBranchTargets.some((target) => target.blockedReasons.includes("owner_node_stale")));
    assert.equal(stalePlan.knowledgeBranchTargets.every((target) => target.confidenceLevel !== "high"), true);

    const lowConfidenceRoute = { ...route, confidence: 0.18, confidenceLevel: "low" as const, blockedReason: "test low confidence" };
    const lowPlan = createKnowledgeGuidedEditPlan({ tree, route: lowConfidenceRoute, request: route.request });
    assert.equal(lowPlan.knowledgeBranchTargets.every((target) => target.executionModeHint !== "patch_candidate"), true);
    assert.ok(lowPlan.knowledgeBranchTargets.some((target) => target.blockedReasons.includes("confidence_too_low")));

    const missingReviewRoute = { ...route, reviewerNodes: [...route.reviewerNodes, "missing_reviewer_node"] };
    const missingReviewPlan = createKnowledgeGuidedEditPlan({ tree, route: missingReviewRoute, request: route.request });
    assert.ok(missingReviewPlan.knowledgeBranchTargets.some((target) => target.status === "blocked_review_chain_incomplete"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime routes existing-project edit without patches, commands, or provider execution", async () => {
  const workspace = await createKnowledgeFixture("knowledge-runtime-gate");
  const storageDir = await tempDir("knowledge-runtime-storage");
  try {
    const events: AppEvent[] = [];
    const eventBus = new EventBus();
    eventBus.subscribe((event) => events.push(event));
    const sessionManager = new SessionManager(storageDir, eventBus);
    await sessionManager.load();
    const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: "Update the login/auth flow across backend and frontend."
    });
    const response = await runtime.runTurn(created.sessionId, "Update the login/auth flow across backend and frontend.");
    const session = runtime.getSession(created.sessionId)!;
    assert.equal(response.status, "completed");
    assert.ok(session.projectKnowledgeTree);
    assert.ok(session.latestKnowledgeRoute);
    assert.ok(session.latestKnowledgeBranchTargets?.length);
    assert.equal(session.recursiveFactory?.executionStarted, false);
    assert.ok(session.recursiveFactory?.branchExecutions?.length);
    assert.equal(session.recursiveFactory.branchExecutions.every((branch) => branch.active === false && branch.patchApplied === false), true);
    assert.equal(session.patchProposals.length, 0);
    assert.equal(session.commandRequests.length, 0);
    assert.equal(session.commandExecutions.length, 0);
    assert.equal(session.artifacts.some((artifact) => artifact.type === "project_knowledge_tree"), true);
    assert.equal(session.artifacts.some((artifact) => artifact.type === "knowledge_edit_route"), true);
    assert.equal(session.artifacts.some((artifact) => artifact.type === "knowledge_branch_targets"), true);
    assert.equal(events.some((event) => event.type === "runtime.knowledge_tree.created"), true);
    assert.equal(events.some((event) => event.type === "runtime.edit_route.ready"), true);
    assert.equal(events.some((event) => event.type === "runtime.knowledge_branch_targets.created"), true);
    assert.equal(events.some((event) => event.type === "runtime.knowledge_branch_execution.planned"), true);
    assert.match(session.messages.at(-1)?.content ?? "", /Execution has not started/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("durable replay restores knowledge tree and routed edit artifacts", async () => {
  const workspace = await createKnowledgeFixture("knowledge-replay");
  try {
    const tree = await buildProjectKnowledgeTree({ workspacePath: workspace, tools: new ToolRegistry(workspace) });
    const route = routeKnowledgeQuery({ tree, request: "Change backend login validation." });
    const routedEdit = createKnowledgeGuidedEditPlan({ tree, route, request: route.request });
    const branchPlanning = createKnowledgeRecursivePlanning({ sessionId: "session_knowledge_replay", routedEdit });
    const session = createBareSession(workspace);
    const events = [
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 1,
        type: "session.created",
        actor: "runtime",
        authority: "runtime",
        payload: { session }
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 2,
        type: "knowledge_tree.created",
        actor: "runtime",
        authority: "runtime",
        payload: { tree }
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 3,
        type: "edit_route.ready",
        actor: "runtime",
        authority: "runtime",
        payload: { routedEdit }
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 4,
        type: "knowledge_branch_targets.created",
        actor: "runtime",
        authority: "runtime",
        payload: { targets: routedEdit.knowledgeBranchTargets }
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 5,
        type: "recursive_graph.ready",
        actor: "runtime",
        authority: "runtime",
        payload: { graph: branchPlanning.graph }
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 6,
        type: "knowledge_branch_execution.planned",
        actor: "runtime",
        authority: "runtime",
        payload: { branchExecution: branchPlanning.branchExecutions[0] }
      })
    ];
    const replayed = replaySessionFromDurableEvents(events).session;
    assert.ok(replayed?.projectKnowledgeTree);
    assert.equal(replayed.latestKnowledgeRoute?.id, routedEdit.id);
    assert.equal(replayed.projectKnowledgeTree.ownershipMap["frontend/app.js"]?.primaryOwnerNodeId, tree.ownershipMap["frontend/app.js"]?.primaryOwnerNodeId);
    assert.deepEqual(replayed.projectKnowledgeTree.orphanedFiles, tree.orphanedFiles);
    assert.equal(replayed.latestKnowledgeRoute?.executionStarted, false);
    assert.deepEqual(replayed.latestKnowledgeRoute?.reviewChain, routedEdit.reviewChain);
    assert.deepEqual(replayed.latestKnowledgeBranchTargets, routedEdit.knowledgeBranchTargets);
    assert.equal(replayed.recursiveFactory?.executionStarted, false);
    assert.equal(replayed.recursiveFactory?.branchExecutions?.[0]?.active, false);
    assert.equal(replayed.status, "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createKnowledgeFixture(prefix: string) {
  const workspace = await tempDir(prefix);
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await mkdir(path.join(workspace, "backend"), { recursive: true });
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "pytest" } }), "utf8");
  await writeFile(path.join(workspace, "requirements.txt"), "fastapi\npytest\n", "utf8");
  await writeFile(path.join(workspace, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(workspace, "frontend", "app.js"), "export function renderLogin() { return 'login'; }\n", "utf8");
  await writeFile(path.join(workspace, "backend", "main.py"), "from backend.auth import login_user\n\napp = object()\n", "utf8");
  await writeFile(path.join(workspace, "backend", "auth.py"), "def login_user():\n    return True\n", "utf8");
  await writeFile(path.join(workspace, "tests", "test_api_smoke.py"), "def test_login():\n    assert True\n", "utf8");
  return workspace;
}

async function tempDir(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function ownerFor(tree: Awaited<ReturnType<typeof buildProjectKnowledgeTree>>, filePath: string) {
  return tree.fileOwnership.find((owner) => owner.path === filePath);
}

function createBareSession(workspace: string): AgentRuntimeSession {
  const now = new Date().toISOString();
  return {
    id: "session_knowledge_replay",
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
    commandExecutions: [],
    backgroundJobs: [],
    reasoningSummaries: [],
    progressEvents: [],
    agentWorkStatuses: [],
    createdAt: now,
    updatedAt: now
  };
}
