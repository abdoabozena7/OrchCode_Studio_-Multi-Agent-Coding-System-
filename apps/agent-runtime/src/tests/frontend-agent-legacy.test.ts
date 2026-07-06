import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap, TaskNode } from "@hivo/protocol";
import { FrontendAgent } from "../agents/workers/FrontendAgent.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("legacy FrontendAgent blocks instead of producing local patches", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-frontend-agent-"));
  try {
    const task: TaskNode = {
      id: "task_frontend",
      title: "Build frontend",
      description: "Create a playable Three.js snake game",
      assignedAgent: "FrontendAgent",
      status: "pending",
      dependsOn: [],
      fileLocks: ["apps/desktop/src/app/App.tsx"],
      expectedOutput: "PatchProposal",
      riskLevel: "medium"
    };
    const projectMap: ProjectMap = {
      stack: ["typescript"],
      packageManagers: ["npm"],
      testCommands: [],
      entryPoints: [],
      importantFiles: []
    };

    const result = new FrontendAgent().run(task, {
      sessionId: "session_frontend",
      userPrompt: "Create a playable Three.js snake game",
      workspacePath: workspace,
      projectMap,
      tools: new ToolRegistry(workspace),
      previousOutputs: []
    });

    assert.equal(result.patch, undefined);
    assert.equal(result.commandRequest, undefined);
    assert.match(result.output.summary, /Legacy local FrontendAgent execution is disabled/);
    assert.deepEqual(result.output.selfCheck?.failedCriteria, ["legacy_local_worker_disabled"]);
    assert.deepEqual(result.output.selfCheck?.missingItems, ["provider_backed_worker_executor"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
