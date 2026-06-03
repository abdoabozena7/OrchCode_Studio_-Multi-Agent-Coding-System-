import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { classifyAgenticTaskIntent } from "../runtime/AgenticIntentClassifier.js";
import { buildAgenticReadPlan } from "../runtime/AgenticReadPlanner.js";
import { runAgenticTaskKernel } from "../runtime/AgenticTaskKernel.js";
import { validateAgenticOutput } from "../runtime/AgenticClaimValidator.js";
import { buildAgenticEvidenceGraph } from "../runtime/AgenticEvidenceGraph.js";
import type { AgenticOutputDraft } from "../runtime/AgenticTaskModels.js";
import { defaultAgenticTaskKernelConfig } from "../runtime/AgenticTaskModels.js";
import { readWorkspaceForAgenticPlan } from "../runtime/AgenticWorkspaceReader.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

class ThrowingTextProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    throw new Error("not used");
  }

  async generateText(): Promise<string> {
    throw new Error("provider unavailable");
  }
}

test("AgenticIntentClassifier classifies core task modes including Arabic", () => {
  assert.equal(classifyAgenticTaskIntent("Explain the architecture and main runtime modules").mode, "architecture_explain");
  assert.equal(classifyAgenticTaskIntent("Explain the billing feature and its moving parts").mode, "feature_explain");
  assert.equal(classifyAgenticTaskIntent("Do we have audit logging implemented?").mode, "feature_existence");
  assert.equal(classifyAgenticTaskIntent("Trace the data flow from dataset to API").mode, "data_flow");
  assert.equal(classifyAgenticTaskIntent("Is this design production-grade or wrong?").mode, "design_assessment");
  assert.equal(classifyAgenticTaskIntent("Debug this validation failure").mode, "debugging_analysis");
  const arabic = classifyAgenticTaskIntent("\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0639\u0645\u0627\u0631\u064a\u0629 \u0647\u0646\u0627");
  assert.equal(arabic.language, "arabic");
  assert.equal(arabic.mode, "architecture_explain");
});

test("AgenticReadPlanner chooses mode-specific strategies and respects budgets", () => {
  const files = [
    "package.json",
    "src/runtime/RunEngine.ts",
    "src/orchestration/IntegrationManager.ts",
    "src/routes/api.ts",
    "tests/debug.test.ts",
    ".agent_memory/swarm_runs/run.json"
  ];
  const budget = {
    maxOpenedFiles: 3,
    maxRelationshipDepth: 1,
    maxCharsPerFile: 1000,
    maxTotalChars: 3000,
    maxEvidenceItems: 10,
    timeoutMs: 1000
  };
  const architecture = buildAgenticReadPlan({ intent: classifyAgenticTaskIntent("Explain the architecture"), allFiles: files, budget });
  assert.match(architecture.strategy, /manifest_entrypoint/);
  assert.ok(architecture.steps.some((step) => step.paths.includes("package.json")));

  const flow = buildAgenticReadPlan({ intent: classifyAgenticTaskIntent("Trace the data flow through the API"), allFiles: files, budget });
  assert.ok(flow.steps.some((step) => step.kind === "route_follow"));

  const debugging = buildAgenticReadPlan({ intent: classifyAgenticTaskIntent("Debug validation failure in routes"), allFiles: files, budget });
  assert.ok(debugging.steps.some((step) => step.reason.includes("Debugging")));

  const repair = buildAgenticReadPlan({ intent: classifyAgenticTaskIntent("Create a repair plan for failed stage artifacts"), allFiles: files, budget });
  assert.ok(repair.steps.some((step) => step.kind === "artifact_follow"));
});

test("AgenticWorkspaceReader opens relevant files, follows imports, avoids generated files, and records summaries", async () => {
  const workspace = await createWorkspace("agentic-reader");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    await writeFile(path.join(workspace, "src", "index.ts"), "import { loadCustomers } from './service';\nexport function run() { return loadCustomers(); }\n", "utf8");
    await writeFile(path.join(workspace, "src", "service.ts"), "export function loadCustomers() { return fetch('/api/customers'); }\n", "utf8");
    await mkdir(path.join(workspace, "dist"), { recursive: true });
    await writeFile(path.join(workspace, "dist", "generated.ts"), "export const stale = 'do not read';\n", "utf8");

    const tools = new ToolRegistry(workspace);
    const intent = classifyAgenticTaskIntent("Trace the data flow for customers");
    const plan = buildAgenticReadPlan({
      intent,
      allFiles: tools.workspace.listFiles(100).map((file) => file.path),
      budget: { maxOpenedFiles: 4, maxRelationshipDepth: 1, maxCharsPerFile: 2000, maxTotalChars: 5000, maxEvidenceItems: 20, timeoutMs: 1000 }
    });
    const result = readWorkspaceForAgenticPlan({ tools, prompt: "Trace the data flow for customers", plan });

    assert.ok(result.openedFiles.some((file) => file.path === "src/index.ts"));
    assert.ok(result.openedFiles.some((file) => file.path === "src/service.ts"));
    assert.ok(result.openedFiles.every((file) => !file.path.startsWith("dist/")));
    assert.ok(result.relationships.some((relationship) => relationship.kind === "import" && relationship.toPath === "src/service.ts"));
    assert.ok(result.fileSummaries.some((summary) => summary.symbols.includes("run") || summary.symbols.includes("loadCustomers")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("AgenticEvidenceGraph downgrades fixture-only evidence for production feature existence", async () => {
  const workspace = await createWorkspace("agentic-fixture-evidence");
  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "feature.test.ts"),
      "test('audit logging fixture', () => { const feature = 'audit logging implemented'; });\n",
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const intent = classifyAgenticTaskIntent("Do we have audit logging implemented?");
    const openedFiles = [{
      path: "tests/feature.test.ts",
      content: tools.workspace.readWholeFile("tests/feature.test.ts"),
      truncated: false,
      charsRead: 80,
      openedBecause: ["test"],
      readMode: "full_file" as const
    }];
    const graph = buildAgenticEvidenceGraph({
      prompt: "Do we have audit logging implemented?",
      intent,
      openedFiles,
      relationships: [],
      fileExists: tools.workspace.fileExists.bind(tools.workspace),
      maxEvidenceItems: 10
    });

    assert.equal(graph.summary.productionEvidenceCount, 0);
    assert.ok(graph.downgraded.some((item) => item.evidenceType === "test"));
    assert.equal(graph.accepted.some((item) => item.canSupportProductionBehavior), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Agentic claim validation rejects fake path citations and preserves grounded ones", async () => {
  const workspace = await createWorkspace("agentic-claim-validation");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "real.ts"), "export const featureFlag = true;\n", "utf8");
    const tools = new ToolRegistry(workspace);
    const intent = classifyAgenticTaskIntent("Explain featureFlag");
    const graph = buildAgenticEvidenceGraph({
      prompt: "Explain featureFlag",
      intent,
      openedFiles: [{
        path: "src/real.ts",
        content: tools.workspace.readWholeFile("src/real.ts"),
        truncated: false,
        charsRead: 32,
        openedBecause: ["test"],
        readMode: "full_file"
      }],
      relationships: [],
      fileExists: tools.workspace.fileExists.bind(tools.workspace),
      maxEvidenceItems: 10
    });
    const draft: AgenticOutputDraft = {
      format: "markdown",
      text: "The real flag is in [src/real.ts:1](hivo-file:src%2Freal.ts:1), not backend/fake.py:99.",
      claims: [],
      fallbackReason: "none"
    };
    const final = validateAgenticOutput({
      draft,
      intent,
      evidenceGraph: graph,
      fileExists: tools.workspace.fileExists.bind(tools.workspace),
      claimValidationRequired: true
    });

    assert.ok(final.citations.includes("src/real.ts:1"));
    assert.doesNotMatch(final.markdown, /backend\/fake\.py:99/);
    assert.ok(final.warnings.some((warning) => /fake|missing citation/i.test(warning)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("AgenticTaskKernel falls back to evidence-grounded Arabic output without mojibake", async () => {
  const workspace = await createWorkspace("agentic-arabic");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "architecture.ts"), "export class AgenticKernel { run() { return 'ok'; } }\n", "utf8");
    const result = await runAgenticTaskKernel({
      prompt: "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0639\u0645\u0627\u0631\u064a\u0629 \u0648\u0627\u0644 kernel \u0647\u0646\u0627",
      workspacePath: workspace,
      provider: new ThrowingTextProvider(),
      tools: new ToolRegistry(workspace),
      config: {
        ...defaultAgenticTaskKernelConfig(),
        agenticTaskAllowNaturalDraft: true,
        agenticTaskProviderTimeoutMs: 50
      }
    });

    assert.equal(result.intent.language, "arabic");
    assert.ok(result.evidenceGraph.accepted.length > 0);
    assert.doesNotMatch(result.finalOutput.markdown, /\uFFFD|ï؟½|أک|أ™|ط§|ظپ|ط¨ط/);
    assert.match(result.finalOutput.markdown, /\u0627\u0644\u062e\u0644\u0627\u0635\u0629/);
    assert.notEqual(result.trace.providerCalls[0]?.status, "success");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createWorkspace(name: string) {
  const workspace = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}
