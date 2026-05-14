import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PatchProposal, ProductBrief, BusinessBrief, TechnicalPlan, TaskGraph } from "@orchcode/protocol";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";
import { FileLockManager } from "../scheduler/FileLockManager.js";
import { TaskScheduler } from "../scheduler/TaskScheduler.js";
import { validateBusinessBrief, validateProductBrief, validateTaskGraph, validateTechnicalPlan } from "../schemas/validators.js";
import { SecurityAgent } from "../agents/workers/SecurityAgent.js";
import { MergeController } from "../scheduler/MergeController.js";

test("ProductBrief and BusinessBrief validators accept valid briefs", () => {
  const product: ProductBrief = {
    goal: "Add a settings page with theme toggle",
    userIntent: "add_feature",
    scope: ["settings page"],
    constraints: ["patch proposal only"],
    successCriteria: ["theme can be toggled"],
    clarifyingQuestions: [],
    assumptions: ["existing React app"]
  };
  const business: BusinessBrief = {
    mvpScope: ["settings page"],
    outOfScope: ["account settings"],
    userValue: "User controls theme",
    businessRisks: ["visual regression"],
    acceptanceCriteria: ["toggle works"],
    priority: "medium",
    releaseNotesDraft: "Adds theme setting."
  };
  assert.equal(validateProductBrief(product).valid, true);
  assert.equal(validateBusinessBrief(business).valid, true);
});

test("TechnicalPlan and TaskGraph validators check dependency shape", () => {
  const graph: TaskGraph = {
    sessionId: "s1",
    nodes: [
      {
        id: "a",
        title: "A",
        description: "first",
        assignedAgent: "ArchitectAgent",
        status: "pending",
        dependsOn: [],
        fileLocks: [],
        expectedOutput: "notes",
        riskLevel: "low"
      }
    ],
    edges: []
  };
  const plan: TechnicalPlan = {
    summary: "plan",
    architectureImpact: "low",
    affectedAreas: ["ui"],
    testStrategy: ["npm test"],
    riskLevel: "low",
    taskGraph: graph
  };
  assert.equal(validateTaskGraph(graph).valid, true);
  assert.equal(validateTechnicalPlan(plan).valid, true);
});

test("FileLockManager detects conflicts", async () => {
  const locks = new FileLockManager();
  assert.equal((await locks.acquireLocks("task-a", ["src/App.tsx"])).acquired, true);
  const conflict = await locks.acquireLocks("task-b", ["src/App.tsx"], { timeoutMs: 1 });
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.conflict?.ownerTaskId, "task-a");
});

test("TaskScheduler respects dependencies and file locks", () => {
  const graph: TaskGraph = {
    sessionId: "s1",
    nodes: [
      {
        id: "a",
        title: "A",
        description: "first",
        assignedAgent: "ArchitectAgent",
        status: "pending",
        dependsOn: [],
        fileLocks: ["src/a.ts"],
        expectedOutput: "a",
        riskLevel: "low"
      },
      {
        id: "b",
        title: "B",
        description: "second",
        assignedAgent: "FrontendAgent",
        status: "pending",
        dependsOn: ["a"],
        fileLocks: ["src/a.ts"],
        expectedOutput: "b",
        riskLevel: "medium"
      }
    ],
    edges: [{ from: "a", to: "b" }]
  };
  const scheduler = new TaskScheduler(graph, new FileLockManager(), 3);
  scheduler.runAll(() => undefined);
  assert.deepEqual(graph.nodes.map((node) => node.status), ["completed", "completed"]);
  assert.deepEqual(scheduler.events.filter((event) => event.type === "task.started").map((event) => event.task.id), ["a", "b"]);
});

test("Mock orchestrated run creates dynamic tasks, intents, artifacts, and patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-module3-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-module3-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "apps/desktop/src/app"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"echo ok\"}}\n", "utf8");
  await writeFile(path.join(workspace, "apps/desktop/src/app/App.tsx"), "export function App(){return null}\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    executionMode: "orchestrated_mode",
    userPrompt: "Add a settings page with theme toggle"
  });
  const turn = await runtime.runTurn(created.sessionId, "Add a settings page with theme toggle");
  const session = runtime.getSession(created.sessionId);

  assert.equal(turn.status, "needs_approval");
  assert.ok(session?.plan);
  assert.ok((session?.tasks.length ?? 0) >= 1);
  assert.ok((session?.toolIntents.length ?? 0) >= 4);
  assert.ok((session?.artifacts.length ?? 0) >= 3);
  assert.ok((session?.patchProposals.length ?? 0) >= 1);
  assert.equal(session?.verificationResult?.status, "pending");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("SecurityAgent blocks dangerous command requests", () => {
  const review = new SecurityAgent().review(
    "s1",
    [],
    [
      {
        id: "cmd1",
        sessionId: "s1",
        command: "rm -rf .",
        cwd: "C:/workspace",
        risk: "dangerous",
        reason: "bad",
        status: "blocked",
        createdAt: new Date().toISOString()
      }
    ]
  );
  assert.equal(review.status, "blocked");
});

test("MergeController detects patch conflicts", () => {
  const basePatch = (id: string): PatchProposal => ({
    id,
    sessionId: "s1",
    title: id,
    summary: id,
    riskLevel: "low",
    filesChanged: [{ path: "src/App.tsx", changeType: "modify", explanation: "same file" }],
    unifiedDiff: "diff --git a/src/App.tsx b/src/App.tsx",
    requiresApproval: true,
    status: "proposed",
    createdAt: new Date().toISOString()
  });
  const summary = new MergeController().detectPatchConflicts([basePatch("p1"), basePatch("p2")]);
  assert.equal(summary.conflicts.length, 1);
});
