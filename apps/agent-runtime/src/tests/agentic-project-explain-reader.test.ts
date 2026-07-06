import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { ProjectExplainAgenticAdapter, FutureAgenticTaskAdapters } from "../runtime/AgenticTaskAdapters.js";
import { runAgenticTaskKernel } from "../runtime/AgenticTaskKernel.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import { answerUniversalProjectQuestion } from "../runtime/UniversalProjectQuestionEngine.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

class ThrowingProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    throw new Error("provider unavailable");
  }

  async generateText(): Promise<string> {
    throw new Error("provider unavailable");
  }
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/index.ts"],
  importantFiles: ["src/index.ts", "src/runtime/kernel.ts"]
};

test("Project Explain adapter exposes evidence metadata without composing answer prose", async () => {
  const workspace = await createWorkspace("agentic-project-adapter");
  try {
    await mkdir(path.join(workspace, "src", "runtime"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "import { UniversalKernel } from './runtime/kernel';\nexport const kernel = new UniversalKernel();\n", "utf8");
    await writeFile(path.join(workspace, "src", "runtime", "kernel.ts"), "export class UniversalKernel { explain() { return 'agentic'; } }\n", "utf8");

    const tools = new ToolRegistry(workspace);
    const request = ProjectExplainAgenticAdapter.toRequest({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: "Explain the architecture of the universal kernel",
      workspacePath: workspace,
      config: { agenticTaskAllowNaturalDraft: false }
    });
    assert.equal(ProjectExplainAgenticAdapter.canHandle(request), true);
    const result = await runAgenticTaskKernel(request);
    const output = ProjectExplainAgenticAdapter.fromResult(result);

    assert.ok(output.trace.readPlan.steps.length > 0);
    assert.ok(output.result.evidenceGraph.accepted.some((item) => item.path === "src/runtime/kernel.ts"));
    assert.equal("answerMarkdown" in output, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine fails without provider prose instead of using agentic debug as an answer", async () => {
  const workspace = await createWorkspace("agentic-project-explain");
  try {
    await mkdir(path.join(workspace, "src", "runtime"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "agentic-app", scripts: { test: "node --test" } }), "utf8");
    await writeFile(path.join(workspace, "src", "index.ts"), "import { RunEngine } from './runtime/RunEngine';\nexport function boot() { return new RunEngine().start(); }\n", "utf8");
    await writeFile(path.join(workspace, "src", "runtime", "RunEngine.ts"), "export class RunEngine { start() { return 'started'; } }\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const prompt = "Explain the architecture and how the runtime entrypoint relates to the engine.";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });

    await assert.rejects(
      answerUniversalProjectQuestion({
        provider: new ThrowingProvider(),
        tools,
        userPrompt: prompt,
        explainReport: report
      }),
      /project_explain_provider_failed/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Future agentic adapters are registered as safe non-executing extension points", () => {
  const ids = FutureAgenticTaskAdapters.map((adapter) => adapter.id).sort();
  assert.deepEqual(ids, [
    "coding_planning",
    "debugging",
    "docs",
    "refactor_planning",
    "repair_planning",
    "review_reasoning",
    "validation_planning"
  ]);
  assert.ok(FutureAgenticTaskAdapters.every((adapter) => adapter.canHandle({} as never) === false));
});

async function createWorkspace(name: string) {
  const workspace = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}
