import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract, ProjectMap } from "@hivo/protocol";
import {
  inferEntryPoints,
  inferProjectMap,
  OrchestratedPlanningService
} from "../runtime/OrchestratedPlanningService.js";

test("orchestrated planning service preserves explicit project map and dynamic worker selection", () => {
  const prompt = "use 3 agents to make a html css js 3d snake game with threejs";
  const projectMap: ProjectMap = {
    stack: [],
    packageManagers: [],
    testCommands: [],
    entryPoints: [],
    importantFiles: ["README.md"]
  };

  const result = new OrchestratedPlanningService().plan({
    sessionId: "session-planning",
    workspacePath: "D:/workspace",
    intentContract: readyIntentContract("session-planning", prompt, [
      "Creates index.html, styles.css, and main.js",
      "Renders a nonblank Three.js scene",
      "Implements snake movement"
    ]),
    projectMap
  });

  assert.deepEqual(result.projectMap, projectMap);
  assert.equal(result.productBrief.goal, prompt);
  assert.deepEqual(result.engineering.delegationDecision.selectedAgentRoles, [
    "GameLogicAgent",
    "ThreeJsRenderingAgent",
    "FrontendIntegrationAgent"
  ]);
  assert.equal(result.engineering.technicalPlan.taskGraph.nodes.length, 3);
  assert.equal(result.engineering.workOrders.length, 3);
});

test("orchestrated planning service infers project map entry points from workspace facts", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-planning-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), "{\"scripts\":{\"test\":\"vitest\"}}\n", "utf8");
  await writeFile(path.join(workspace, "src", "App.tsx"), "export function App(){return null}\n", "utf8");
  await writeFile(path.join(workspace, "src", "helper.ts"), "export const helper = true;\n", "utf8");
  try {
    const projectMap = inferProjectMap(workspace);
    assert.equal(projectMap.packageManagers.includes("npm"), true);
    assert.equal(projectMap.testCommands.includes("npm test"), true);
    assert.equal(projectMap.importantFiles.some((file) => file.endsWith("package.json")), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("inferEntryPoints keeps only common app entry files", () => {
  assert.deepEqual(inferEntryPoints([
    "README.md",
    "src/App.tsx",
    "src/main.ts",
    "src/helper.ts",
    "src-tauri/src/lib.rs"
  ]), [
    "src/App.tsx",
    "src/main.ts",
    "src-tauri/src/lib.rs"
  ]);
});

function readyIntentContract(runId: string, request: string, definitionOfDone: string[]): IntentContract {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    contract_id: `contract_${runId}`,
    run_id: runId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: request,
    precise_rewrite: request,
    assumptions: ["Fixture supplies a ready provider-authored intent contract."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced fixture priority." },
      quality: { score: 80, rationale: "Expect useful planning." },
      realism: { score: 70, rationale: "Match request." },
      fun: { score: 60, rationale: "Game prompt." },
      security: { score: 70, rationale: "Approval remains gated." },
      cost: { score: 50, rationale: "Fixture does not optimize cost." }
    },
    definition_of_done: definitionOfDone,
    non_goals: [],
    conflict_rules: ["Preserve existing behavior unless explicitly changed."],
    status: "ready",
    created_at: now,
    metadata_json: {
      product_brief_user_intent: "add_feature"
    }
  };
}
