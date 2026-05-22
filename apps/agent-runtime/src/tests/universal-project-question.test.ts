import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import { answerUniversalProjectQuestion } from "../runtime/UniversalProjectQuestionEngine.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

class ThrowingProvider implements LlmProvider {
  async generateStructured(): Promise<never> {
    throw new Error("provider unavailable");
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class NotFoundProvider implements LlmProvider {
  constructor(private readonly refs: string[] = []) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "I could not find that concept in the project evidence, even after checking the supplied local reference. [src/analytics.ts:1](orchcode-file:src%2Fanalytics.ts:1)",
      usedEvidenceRefs: this.refs,
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/index.ts"],
  importantFiles: ["package.json", "src/index.ts"]
};

async function createWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: prefix, scripts: { test: "echo ok" } }, null, 2), "utf8");
  return workspace;
}

test("UniversalProjectQuestionEngine finds evidence beyond the old searchCode file cap", async () => {
  const workspace = await createWorkspace("universal-search-cap");
  try {
    await mkdir(path.join(workspace, "aaa"), { recursive: true });
    await mkdir(path.join(workspace, "zzz", "deep"), { recursive: true });
    for (let index = 0; index < 650; index += 1) {
      await writeFile(path.join(workspace, "aaa", `filler-${index}.ts`), `export const filler${index} = ${index};\n`, "utf8");
    }
    await writeFile(
      path.join(workspace, "zzz", "deep", "payment.ts"),
      [
        "export function rarePaymentGatewayAdapter(payload: unknown) {",
        "  return { provider: 'stripe', payload };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    assert.equal(tools.workspace.searchCode("rarePaymentGatewayAdapter", 10).length, 0);

    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is rarePaymentGatewayAdapter?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: "Where is rarePaymentGatewayAdapter?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /rarePaymentGatewayAdapter|payment\.ts/);
    assert.match(result.answerMarkdown, /orchcode-file:/);
    assert.ok(result.positiveEvidence.some((item) => item.path === "zzz/deep/payment.ts"));
    assert.ok(result.openedFiles.includes("zzz/deep/payment.ts"));
    assert.equal(result.fallbackUsed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine rejects not-found provider text when local evidence exists", async () => {
  const workspace = await createWorkspace("universal-not-found-override");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "analytics.ts"),
      [
        "export class CustomerRiskScorer {",
        "  score(customer: { churnRisk: number }) {",
        "    return customer.churnRisk;",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is CustomerRiskScorer?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new NotFoundProvider(["src/analytics.ts:1"]),
      tools,
      userPrompt: "Where is CustomerRiskScorer?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /CustomerRiskScorer|analytics\.ts/);
    assert.match(result.answerMarkdown, /orchcode-file:/);
    assert.ok(result.validationErrors.length > 0);
    assert.doesNotMatch(result.answerMarkdown, /could not find/i);
    assert.equal(result.fallbackUsed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
