import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectExplainReport, ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import {
  explainProjectWithLlm,
  type ProjectExplainLlmResponse
} from "../runtime/LlmProjectExplainer.js";
import {
  analyzeProjectQuestionGrounding,
  detectProjectQuestionKind,
  detectProjectAnswerStyle,
  detectProjectAnswerShape,
  extractRequestedConcept,
  type ProjectAnswerShape,
  type ProjectAnswerStyle
} from "../runtime/ProjectQuestionGrounding.js";
import { inferWorkspaceIntent } from "../runtime/WorkspaceReasoningPipeline.js";
import { buildServer } from "../server.js";

class CapturingExplainProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly outputs: ProjectExplainLlmResponse[]) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    assert.equal((schema as { name?: string }).name, "project-explain");
    this.requests.push(input);
    const next = this.outputs.shift();
    if (!next) throw new Error("No fake project-explain output left");
    return next as T;
  }

  async generateText(): Promise<string> {
    throw new Error("Project explain tests should use structured output");
  }
}

class ThrowingExplainProvider implements LlmProvider {
  requestCount = 0;

  async generateStructured(): Promise<never> {
    this.requestCount += 1;
    throw new Error("provider unavailable");
  }

  async generateText(): Promise<string> {
    throw new Error("Project explain tests should use structured output");
  }
}

class NaturalTextExplainProvider implements LlmProvider {
  structuredCalls = 0;
  textCalls = 0;
  lastEvidenceRefCount = 0;
  readonly requests: LlmRequest[] = [];

  async generateStructured(): Promise<never> {
    this.structuredCalls += 1;
    throw new Error("natural text provider should not use structured project explain");
  }

  async generateText(input: LlmRequest): Promise<string> {
    this.textCalls += 1;
    this.requests.push(input);
    this.lastEvidenceRefCount = (input.userPrompt.match(/^- ref:/gm) ?? []).length;
    const link = input.userPrompt.match(/\[[^\]]+\]\(hivo-file:[^)]+\)/)?.[0];
    if (!link) throw new Error("natural text prompt did not include hivo-file evidence links");
    return [
      "This project explanation is based on the current workspace evidence rather than a canned template.",
      "",
      `The key evidence is ${link}.`,
      "",
      "So the provider can answer naturally in Markdown while the runtime still validates the cited project evidence."
    ].join("\n");
  }
}

function explainProjectWithLegacySynthesis(input: Parameters<typeof explainProjectWithLlm>[0]) {
  return explainProjectWithLlm(input);
}

const ARABIC_DATASET_REALTIME_PROMPT = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0627 \u0644 \u0637\u0641\u0644 \u0627\u0632\u0627\u064a \u0628\u064a\u0642\u062f\u0631 \u064a\u062c\u064a\u0628 \u0627\u0644\u062f\u0627\u062a\u0627 \u0645\u0646 \u062f\u0627\u062a\u0627 \u0633\u064a\u062a \u0643\u0627\u0646\u0647\u0627 realtime prompt :";
const ARABIC_THRESHOLD_PROMPT = "\u0647\u0627\u062a\u0644\u064a \u0643\u0644 \u0627\u0644threshlods \u0627\u0644\u064a \u0628\u0642\u0627\u0631\u0646 \u0628\u064a\u0647\u0627 \u0641 \u0627\u0644\u0633\u064a\u0633\u062a\u0645\u0643 \u064a\u0639\u0646\u064a \u0627\u0646\u0627 \u0639\u0631\u0641\u062a \u0627\u0644\u0645\u0639\u0627\u062f\u0647 \u0628\u0633 \u0645\u0639\u0631\u0641\u062a\u0634 \u0628\u0642\u0627\u0631\u0646 \u0628 \u0643\u0627\u0627\u0645 \u0641\u0639\u0644\u064a\u0627 \u062c\u0648\u0627 \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u062f\u0627 \u0641 \u0647\u0627\u062a\u0644\u064a\u0628 \u0643\u0644 \u0627\u0644\u0627\u0631\u0642\u0627\u0645 \u062f\u064a \u0628 \u0643\u0644 \u0627\u0644\u0645\u0639\u0627\u062f\u0644\u0627\u062a \u0641\u0639\u0644\u0627 \u0628\u0627\u0644\u0630\u0627\u062a \u0641 \u0635\u0641\u062d\u0647\u0639 \u0627\u0644 agents";
const ARABIC_FORECASTING_PROMPT = "\u0627\u064a\u0647 \u0646\u0648\u0639 \u0627\u0644 forecasting \u0647\u0646\u0627 \u0648\u064a\u062a\u0637\u0628\u0642 \u0639\u0644\u064a customer \u0648\u0627\u062d\u062f \u0648\u0644\u0627 \u0627\u064a\u0647 \u061f";
const ARABIC_FORECASTING_LOGIC_PROMPT = "\u0627\u0632\u0627\u064a \u0627\u0644forecasting \u0647\u0646\u0627 \u0628\u064a\u062a\u0637\u0628\u0642 \u0648\u0647\u0644 \u062f\u0627 \u0627\u0644\u0645\u0646\u0637\u0642\u064a \u0648\u0644\u0627 \u0647\u0648 \u0645\u062a\u0637\u0628\u0642 \u0628 \u0634\u0643\u0644 \u063a\u0644\u0637 \u061f";
const ARABIC_ALGORITHMS_PROMPT = "\u0639\u0646\u062f\u0646\u0627 \u0643\u0627\u0645 algorithm \u0647\u0646\u0627\u061f \u0648\u0627\u0634\u0631\u062d\u0647\u0645 \u0648\u0627\u062d\u062f\u0647 \u0648\u0627\u062d\u062f\u0647.";
const MOJIBAKE_PATTERN = /[\u0080-\u00FF]|\uFFFD/;

const ARABIC_SVM_DETAIL_PROMPT = "\u0625\u0632\u0627\u064a \u0627\u0644 SVM \u0628\u064a\u062a\u0637\u0628\u0642 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d \u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644.";
const ARABIC_PAGE_INVENTORY_PROMPT = "\u0639\u0646\u062f\u064a \u0647\u0646\u0627 \u0643\u0627\u0645 \u0635\u0641\u062d\u0647 \u0641 \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u062f\u0627 \u0648\u0643\u0644 \u0648\u0627\u062d\u062f\u0647 \u0628\u062a\u0639\u0645\u0644 \u0627\u064a\u0647 \u061f";

type ConceptExtractionRegressionCase = {
  name: string;
  prompt: string;
  expectedStyle: ProjectAnswerStyle;
  expectedConceptLabel: string;
  expectedSpecific: boolean;
  expectedQuestionKind?: string;
  expectedAnswerShape?: ProjectAnswerShape;
  expectedEvidenceGroupIds?: string[];
  forbiddenConceptPattern?: RegExp;
};

test("project explain rejects ungrounded plain path citations from provider output", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-plain-fake-citation-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  try {
    await writeFile(
      path.join(workspace, "src", "index.ts"),
      [
        "export function runOuterLoop(decision: string, feedback: string) {",
        "  return { decision, feedback, next: feedback ? 'retry' : 'done' };",
        "}"
      ].join("\n"),
      "utf8"
    );
    const prompt = "How is outerloop implemented here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        stack: ["TypeScript"],
        packageManagers: ["npm"],
        testCommands: [],
        entryPoints: ["src/index.ts"],
        importantFiles: ["src/index.ts"]
      }
    });
    const provider = new CapturingExplainProvider([
      {
        answerMarkdown: "The backend action executor applies the outerloop at backend/services/action_executor.py:38 and backend/routes.py:19.",
        usedEvidenceRefs: ["src/index.ts:1"],
        unsupportedOrUnclearParts: []
      },
      {
        answerMarkdown: "The same claim is still based on frontend/index.html:72, which is not in the evidence pack.",
        usedEvidenceRefs: ["src/index.ts:1"],
        unsupportedOrUnclearParts: []
      }
    ]);
    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: prompt, report });

    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason ?? "", /validation|failed|ungrounded/i);
    assert.doesNotMatch(result.answerMarkdown, /backend\/services\/action_executor\.py|backend\/routes\.py|frontend\/index\.html/);
    assert.ok(result.unsupportedOrUnclearParts.some((item) => /ungrounded plain file ref/.test(item)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// Add real mis-extracted user prompts here first, then make the smallest deterministic extractor change.
const CONCEPT_EXTRACTION_REGRESSIONS: ConceptExtractionRegressionCase[] = [
  {
    name: "Arabic child style plus dataset realtime concept",
    prompt: ARABIC_DATASET_REALTIME_PROMPT,
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"],
    forbiddenConceptPattern: /طفل|بيقدر|يجيب/i
  },
  {
    name: "Actual Arabic child style plus dataset realtime concept",
    prompt: "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0627 \u0644 \u0637\u0641\u0644 \u0627\u0632\u0627\u064a \u0628\u064a\u0642\u062f\u0631 \u064a\u062c\u064a\u0628 \u0627\u0644\u062f\u0627\u062a\u0627 \u0645\u0646 \u062f\u0627\u062a\u0627 \u0633\u064a\u062a \u0643\u0627\u0646\u0647\u0627 realtime prompt :",
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"],
    forbiddenConceptPattern: /طفل|بيقدر|يجيب/i
  },
  {
    name: "Arabic style plus English sentiment concept",
    prompt: "\u0627\u0634\u0631\u062d\u0644\u064a sentiment analysis \u0647\u0646\u0627 \u0644\u0637\u0641\u0644 \u064a\u0642\u062f\u0631 \u064a\u0641\u0647\u0645",
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /طفل|يقدر|يفهم/i
  },
  {
    name: "Arabic sentiment concept plus child style",
    prompt: "\u0625\u0632\u0627\u064a \u062a\u062d\u0644\u064a\u0644 \u0627\u0644\u0645\u0634\u0627\u0639\u0631 \u0628\u064a\u0634\u062a\u063a\u0644 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d\u0647 \u0644\u0637\u0641\u0644",
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /طفل/i
  },
  {
    name: "Sentement typo plus simple style",
    prompt: "\u0627\u0634\u0631\u062d sentement analysis \u0647\u0646\u0627 \u0628\u0628\u0633\u0627\u0637\u0629",
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /ببساطة/i
  },
  {
    name: "Arabic style-only project explanation",
    prompt: "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0647 \u0644\u0637\u0641\u0644",
    expectedStyle: "child_simple",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "this project",
    expectedSpecific: false,
    forbiddenConceptPattern: /طفل/i
  },
  {
    name: "English dataset realtime concept",
    prompt: "explain how the dataset looks realtime",
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"]
  },
  {
    name: "Smoke entrypoint inventory prompt is structural, not backendmainpy concept",
    prompt: "What are the main entrypoint files in this project? Use the detected candidates backend/main.py, backend/routes.py, frontend/app.js.",
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "this project",
    expectedSpecific: false,
    forbiddenConceptPattern: /backendmainpy|main/
  },
  {
    name: "Smoke backend/frontend source-flow prompt is structural, not SARIMA concept from file list",
    prompt: "How do the detected source files connect the backend and frontend flow? Use only project files such as backend/__init__.py, backend/main.py, backend/routes.py, backend/services/arima_model.py, frontend/app.js.",
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "this project",
    expectedSpecific: false,
    forbiddenConceptPattern: /sarima|arima/
  },
  {
    name: "Arabic threshold inventory typo prompt",
    prompt: ARABIC_THRESHOLD_PROMPT,
    expectedStyle: "default",
    expectedAnswerShape: "inventory_table",
    expectedConceptLabel: "threshold inventory",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["threshold_fact"]
  },
  {
    name: "Arabic forecasting type and customer scope prompt",
    prompt: ARABIC_FORECASTING_PROMPT,
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "forecasting type and scope",
    expectedSpecific: true,
    expectedQuestionKind: "forecasting_scope",
    expectedEvidenceGroupIds: ["forecasting_fact"]
  },
  {
    name: "Arabic re-cluster versus offer prompt is decision policy",
    prompt: "\u0627\u0645\u062a\u0649 \u0627\u0644\u0646\u0638\u0627\u0645 \u064a\u0642\u0631\u0631 Re-cluster \u0628\u062f\u0644 \u0645\u0627 \u064a\u0628\u0639\u062a offer\u061f \u0627\u0631\u0628\u0637 \u0625\u062c\u0627\u0628\u062a\u0643 \u0628\u064a\u0646 drift detection \u0648 FCM membership \u0648 orchestrator rules.",
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "decision policy",
    expectedSpecific: true,
    expectedQuestionKind: "decision_policy",
    expectedEvidenceGroupIds: ["decision_policy"],
    forbiddenConceptPattern: /forecasting type and scope|threshold inventory/i
  },
  {
    name: "Arabic page inventory prompt is not threshold inventory",
    prompt: ARABIC_PAGE_INVENTORY_PROMPT,
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "page/screen inventory",
    expectedSpecific: true,
    expectedQuestionKind: "page_inventory",
    expectedEvidenceGroupIds: ["page_structure"],
    forbiddenConceptPattern: /threshold|threshlod|forecast/i
  },
  {
    name: "Arabic algorithm count prompt is not threshold inventory",
    prompt: ARABIC_ALGORITHMS_PROMPT,
    expectedStyle: "default",
    expectedAnswerShape: "concise_explanation",
    expectedConceptLabel: "algorithms/models inventory",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["algorithms_models"],
    forbiddenConceptPattern: /threshold inventory|threshlod|membership|cosine/i
  },
  {
    name: "Arabic detailed SVM prompt is an algorithm/model explanation",
    prompt: ARABIC_SVM_DETAIL_PROMPT,
    expectedStyle: "detailed",
    expectedAnswerShape: "detailed_walkthrough",
    expectedConceptLabel: "algorithms/models inventory",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["algorithms_models"],
    forbiddenConceptPattern: /threshold inventory|threshlod|membership|cosine/i
  }
];

test("concept extraction regressions preserve concept, style, and evidence groups", () => {
  for (const entry of CONCEPT_EXTRACTION_REGRESSIONS) {
    const concept = extractRequestedConcept(entry.prompt);
    const style = detectProjectAnswerStyle(entry.prompt);
    const answerShape = detectProjectAnswerShape(entry.prompt);
    const questionKind = detectProjectQuestionKind(entry.prompt);
    const aggregateConceptText = [
      concept.label,
      concept.displayLabel ?? "",
      ...concept.terms,
      ...concept.coreTerms
    ].join(" ");

    assert.equal(style, entry.expectedStyle, entry.name);
    assert.equal(answerShape, entry.expectedAnswerShape ?? "concise_explanation", entry.name);
    assert.equal(concept.label, entry.expectedConceptLabel, entry.name);
    assert.equal(concept.specific, entry.expectedSpecific, entry.name);
    if (entry.expectedQuestionKind) assert.equal(questionKind, entry.expectedQuestionKind, entry.name);
    if (entry.prompt === ARABIC_ALGORITHMS_PROMPT) {
      const intent = inferWorkspaceIntent(entry.prompt);
      assert.equal(intent.actionMode, "answer_only");
      assert.equal(intent.answerGoal, "count");
      assert.equal(intent.outputShape, "bullets");
      assert.ok(intent.requiredFacets.includes("algorithms_models"));
      assert.equal(intent.requiredFacets.includes("numeric_logic"), false);
    }
    if (entry.prompt === ARABIC_SVM_DETAIL_PROMPT) {
      const intent = inferWorkspaceIntent(entry.prompt);
      assert.equal(intent.actionMode, "answer_only");
      assert.equal(intent.answerGoal, "trace_flow");
      assert.equal(intent.outputShape, "walkthrough");
      assert.ok(intent.topicTerms.includes("svm"));
      assert.ok(intent.requiredFacets.includes("algorithms_models"));
      assert.equal(intent.requiredFacets.includes("numeric_logic"), false);
    }

    if (entry.expectedEvidenceGroupIds) {
      assert.deepEqual(
        concept.evidenceGroups?.map((group) => group.id),
        entry.expectedEvidenceGroupIds,
        entry.name
      );
    } else {
      assert.equal(concept.evidenceGroups, undefined, entry.name);
    }

    if (entry.forbiddenConceptPattern) {
      assert.doesNotMatch(aggregateConceptText, entry.forbiddenConceptPattern, entry.name);
    }
  }
});

test("DBSCAN followed by FCM comparison is not misclassified as decision policy", () => {
  const prompt = "Why does the project use DBSCAN followed by Fuzzy C-Means? Compare noise/outliers with membership certainty in the final decision.";
  const concept = extractRequestedConcept(prompt);
  assert.notEqual(detectProjectQuestionKind(prompt), "decision_policy");
  assert.notEqual(concept.label, "decision policy");
});

test("large project explain report uses cleaned social preamble for section ranking", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-clean-report-preamble-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  try {
    await writeFile(
      path.join(workspace, "src", "hi.ts"),
      [
        "export function casualGreetingOnly() {",
        "  return 'hi';",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "src", "feedback.ts"),
      [
        "export function submitFeedback(label: string) {",
        "  return fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify({ label }) });",
        "}"
      ].join("\n"),
      "utf8"
    );

    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "\u0647\u0627\u064a \u0627\u0632\u0627\u064a \u0627\u0644feedback \u0628\u064a\u062a\u0637\u0628\u0642\u061f",
      projectMap: {
        stack: ["TypeScript"],
        packageManagers: ["npm"],
        testCommands: [],
        entryPoints: ["src/feedback.ts"],
        importantFiles: ["src/feedback.ts"]
      }
    });

    assert.equal(report.sections[0]?.filePath, "src/feedback.ts");
    assert.ok(report.evidence.some((item) => item.path === "src/feedback.ts"));
    assert.equal(report.evidence.some((item) => item.path === "src/hi.ts"), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("large project explain report clusters modules and ignores vendor/build folders", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-large-explain-${Date.now()}`);
  await mkdir(path.join(workspace, "apps", "web", "src"), { recursive: true });
  await mkdir(path.join(workspace, "packages", "core", "src"), { recursive: true });
  await mkdir(path.join(workspace, "apps", "api", "src", "features"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules", "ignored"), { recursive: true });
  await mkdir(path.join(workspace, ".venv", "Lib", "site-packages"), { recursive: true });
  await mkdir(path.join(workspace, "apps", "api", "__pycache__"), { recursive: true });
  await mkdir(path.join(workspace, "dist"), { recursive: true });

  try {
    await writeFile(path.join(workspace, "README.md"), "# Large fixture\n\nExplains the fixture.\n", "utf8");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "large-fixture", workspaces: ["apps/*", "packages/*"], scripts: { test: "npm test" } }, null, 2),
      "utf8"
    );
    await writeFile(path.join(workspace, "apps", "web", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
    await writeFile(path.join(workspace, "packages", "core", "src", "index.ts"), "export const core = true;\n", "utf8");
    await writeFile(path.join(workspace, "packages", "core", "src", "index.test.ts"), "import { core } from './index';\n", "utf8");
    await writeFile(path.join(workspace, "node_modules", "ignored", "index.js"), "module.exports = {}\n", "utf8");
    await writeFile(path.join(workspace, ".venv", "Lib", "site-packages", "ignored.py"), "value = 1\n", "utf8");
    await writeFile(path.join(workspace, "apps", "api", "__pycache__", "ignored.pyc"), "compiled\n", "utf8");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "console.log('generated')\n", "utf8");
    for (let index = 0; index < 1005; index += 1) {
      await writeFile(
        path.join(workspace, "apps", "api", "src", "features", `feature-${index}.ts`),
        `export const feature${index} = ${index};\n`,
        "utf8"
      );
    }

    const projectMap: ProjectMap = {
      stack: ["TypeScript"],
      packageManagers: ["npm"],
      testCommands: ["npm test"],
      entryPoints: ["apps/web/src/App.tsx"],
      importantFiles: ["package.json", "apps/web/src/App.tsx", "packages/core/src/index.ts"]
    };
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "explain this project",
      projectMap
    });

    assert.ok(report.contextPack.inventory.scannedFiles > 1000);
    assert.ok(report.contextPack.inventory.ignoredDirectories.includes("node_modules"));
    assert.ok(report.contextPack.inventory.ignoredDirectories.includes(".venv"));
    assert.ok(report.contextPack.inventory.ignoredDirectories.includes("dist"));
    assert.ok(report.moduleMap.some((module) => module.root === "apps/web"));
    assert.ok(report.moduleMap.some((module) => module.root === "packages/core"));
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("node_modules")), false);
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes(".venv")), false);
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("__pycache__")), false);
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("dist/")), false);
    assert.ok(report.sections.length > 0);
    assert.ok(report.sections.every((section) => section.lineStart > 0 && section.snippet.length > 0));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("static explain report emits line refs, snippets, and ignores agent proposals by default", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-static-explain-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    await writeFile(path.join(workspace, "AGENT_PROPOSAL.md"), "# Agent Proposal\n\nInternal agent note.\n", "utf8");
    await writeFile(
      path.join(workspace, "index.html"),
      [
        "<!doctype html>",
        "<html>",
        "  <body>",
        "    <canvas id=\"scene\"></canvas>",
        "    <script type=\"module\" src=\"./main.js\"></script>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "main.js"),
      [
        "import * as THREE from \"three\";",
        "",
        "const canvas = document.getElementById(\"scene\");",
        "",
        "function animate() {",
        "  requestAnimationFrame(animate);",
        "}",
        "",
        "window.addEventListener(\"keydown\", () => {});"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(workspace, "styles.css"), ":root { color-scheme: dark; }\n#scene { width: 100%; }\n", "utf8");

    const projectMap: ProjectMap = {
      stack: ["HTML", "JavaScript", "CSS"],
      packageManagers: [],
      testCommands: [],
      entryPoints: ["index.html", "main.js"],
      importantFiles: ["index.html", "main.js", "styles.css", "AGENT_PROPOSAL.md"]
    };
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639",
      projectMap
    });

    assert.equal(report.importantFiles.includes("AGENT_PROPOSAL.md"), false);
    assert.ok(report.sections.some((section) => section.filePath === "index.html" && section.lineStart === 5));
    assert.ok(report.sections.some((section) => section.filePath === "main.js" && section.title === "DOM wiring"));
    assert.ok(report.sections.some((section) => section.filePath === "styles.css" && section.lineStart === 1));
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("AGENT_PROPOSAL")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LLM project explainer answers the focused child realtime dataset prompt from evidence", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = "Explain to a child how this project makes the dataset look realtime.";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message, projectMap });
    const appRef = requireRef(report, /dashboard_ui\/src\/App\.jsx/);
    const cleaningRef = requireRef(report, /services\/cleaning\.py/);
    const sentimentRef = requireRef(report, /analytics_engine\/sentiment_pipeline\.py/);
    const answerMarkdown = [
      "LLM_SENTINEL",
      `This project is sentiment analysis, and the classifier is shown in ${linkForRef(sentimentRef)}.`,
      "Imagine a notebook with many review rows. The project takes recent dataset rows, cleans each row, and refreshes the screen about every second.",
      "",
      `This is polling/repeated refresh, not a proven socket stream; the UI uses setInterval/fetch in ${linkForRef(appRef)}.`,
      `After that, the data is prepared for sentiment analysis in ${linkForRef(cleaningRef)} and shown as a fresh dashboard snapshot.`
    ].join("\n");
    const provider = new CapturingExplainProvider([{
      answerMarkdown,
      usedEvidenceRefs: [sentimentRef, appRef, cleaningRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.conceptFound, true);
    if (provider.requests.length) {
      assert.equal(provider.requests.length, 1);
      assert.match(provider.requests[0]!.systemPrompt, /Do not use memorized project categories/);
      assert.match(provider.requests[0]!.userPrompt, /setInterval|fetch|normalize_dataset_row/);
      assert.match(result.answerMarkdown, /LLM_SENTINEL/);
    } else {
      assert.match(result.answerMarkdown, /could not safely produce|current workspace evidence|realtime/i);
    }
    assert.match(result.answerMarkdown, /dataset|داتا/i);
    assert.match(result.answerMarkdown, /polling|repeated refresh|about every second|setInterval/i);
    assert.doesNotMatch(result.answerMarkdown, /e-commerce|cart|checkout/i);
    assert.deepEqual(result.usedEvidenceRefs, [sentimentRef, appRef, cleaningRef]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic spaced child dataset realtime prompt requires dataset and realtime evidence", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = ARABIC_DATASET_REALTIME_PROMPT;
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message, projectMap });
    const appRef = requireRef(report, /dashboard_ui\/src\/App\.jsx/);
    const cleaningRef = requireRef(report, /services\/cleaning\.py/);
    const sentimentRef = requireRef(report, /analytics_engine\/sentiment_pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: [
        `This project is a sentiment analysis project, with the classifier in ${linkForRef(sentimentRef)}.`,
        "The dataset is like a notebook of rows.",
        `The project cleans each row in ${linkForRef(cleaningRef)}.`,
        `Then the screen asks for a fresh snapshot again and again with fetch/setInterval in ${linkForRef(appRef)}.`,
        "So it looks realtime, but the evidence shows repeated refresh, not a proven socket stream."
      ].join(" "),
      usedEvidenceRefs: [sentimentRef, cleaningRef, appRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.concept.label, "dataset realtime behavior");
    assert.equal(result.grounding.projectDomain.label, "sentiment analysis");
    assert.equal(result.grounding.conceptFound, true);
    assert.equal(result.grounding.decision, "concept_found");
    assert.ok(result.grounding.evidenceGroupCoverage.find((group) => group.id === "dataset_source")?.found);
    assert.ok(result.grounding.evidenceGroupCoverage.find((group) => group.id === "realtime_update")?.found);
    assert.equal(provider.requests.length, 1);
    assert.match(provider.requests[0]!.userPrompt, /Evidence groups:/);
    assert.doesNotMatch(result.answerMarkdown, /could not find .*طفل|طفل بيقدر|بيقدر يجيب/i);
    assert.deepEqual(result.usedEvidenceRefs, [sentimentRef, cleaningRef, appRef]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("actual Arabic project dataset realtime answer keeps sentiment project context", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0627 \u0644 \u0637\u0641\u0644 \u0627\u0632\u0627\u064a \u0628\u064a\u0642\u062f\u0631 \u064a\u062c\u064a\u0628 \u0627\u0644\u062f\u0627\u062a\u0627 \u0645\u0646 \u062f\u0627\u062a\u0627 \u0633\u064a\u062a \u0643\u0627\u0646\u0647\u0627 realtime";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message, projectMap });
    const sentimentRef = requireRef(report, /analytics_engine\/sentiment_pipeline\.py/);
    const streamRef = requireRef(report, /ingestion\/stream_comments\.py/);
    const appRef = requireRef(report, /dashboard_ui\/src\/App\.jsx/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: [
        `المشروع هنا sentiment analysis مثبت من ${linkForRef(sentimentRef)}.`,
        `الداتا جاية كـ dataset records من ${linkForRef(streamRef)}.`,
        `والواجهة بتعمل fetch مع setInterval في ${linkForRef(appRef)} عشان تبان قريبة من realtime.`,
        "ده polling/refresh، مش socket حقيقي مثبت."
      ].join(" "),
      usedEvidenceRefs: [sentimentRef, streamRef, appRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.projectContextRequired, true);
    assert.equal(result.grounding.projectDomain.label, "sentiment analysis");
    assert.equal(result.grounding.concept.label, "dataset realtime behavior");
    assert.equal(result.grounding.conceptFound, true);
    assert.ok(result.grounding.projectDomain.sourceEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
    assert.match(provider.requests[0]!.userPrompt, /Project Mapper:|Data Flow Mapper:|Grounding Skeptic:/);
    assert.match(result.answerMarkdown, /sentiment analysis|تحليل/);
    assert.match(result.answerMarkdown, /stream_comments|setInterval|fetch|polling/);
    assert.doesNotMatch(result.answerMarkdown, /notebook of rows|ظƒراسة/);
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("stream_comments.py")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project-context provider answer cannot omit proven sentiment domain", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0627 \u0644 \u0637\u0641\u0644 \u0627\u0632\u0627\u064a \u0628\u064a\u0642\u062f\u0631 \u064a\u062c\u064a\u0628 \u0627\u0644\u062f\u0627\u062a\u0627 \u0645\u0646 \u062f\u0627\u062a\u0627 \u0633\u064a\u062a \u0643\u0627\u0646\u0647\u0627 realtime";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message, projectMap });
    const streamRef = requireRef(report, /ingestion\/stream_comments\.py/);
    const appRef = requireRef(report, /dashboard_ui\/src\/App\.jsx/);
    const badAnswer = [
      "BAD_DOMAIN_OMITTED",
      `الداتا جاية من ${linkForRef(streamRef)}.`,
      `والواجهة بتعمل refresh من ${linkForRef(appRef)}.`,
      "كده تبان realtime."
    ].join(" ");
    const provider = new CapturingExplainProvider([
      { answerMarkdown: badAnswer, usedEvidenceRefs: [streamRef, appRef], unsupportedOrUnclearParts: [] },
      { answerMarkdown: badAnswer, usedEvidenceRefs: [streamRef, appRef], unsupportedOrUnclearParts: [] }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 2);
    assert.match(result.unsupportedOrUnclearParts.join(" "), /project identity\/domain|sentiment analysis/i);
    assert.doesNotMatch(result.answerMarkdown, /BAD_DOMAIN_OMITTED/);
    assert.match(result.answerMarkdown, /sentiment analysis/);
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("provider failure during Arabic dataset realtime explain returns grounded fallback instead of throwing", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.concept.label, "dataset realtime behavior");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.unsupportedOrUnclearParts.join(" "), /provider unavailable/i);
    assert.match(result.answerMarkdown, /sentiment analysis|sentiment_pipeline/);
    assert.match(result.answerMarkdown, /dataset|realtime|داتا|أقوى دلائل/i);
    assert.doesNotMatch(result.answerMarkdown, /could not find .*طفل|طفل بيقدر|بيقدر يجيب/i);
    assert.ok(result.usedEvidenceRefs.length >= 2);
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("notice-only provider failure during Arabic explain does not synthesize a local answer", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({
      provider,
      userPrompt: ARABIC_DATASET_REALTIME_PROMPT,
      report
    });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason ?? "", /Provider failed during project explanation: provider unavailable/);
    assert.equal(result.usedEvidenceRefs.length, 0);
    assert.match(result.answerMarkdown, /مش هطلع شرح تخميني/);
    assert.doesNotMatch(result.answerMarkdown, /أقوى دلائل|strongest local evidence|كده تبان realtime|sentiment_pipeline.*realtime/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project explainer defaults to notice-only on provider failure", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLlm({
      provider,
      userPrompt: ARABIC_DATASET_REALTIME_PROMPT,
      report
    });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason ?? "", /Provider failed during project explanation: provider unavailable/);
    assert.equal(result.usedEvidenceRefs.length, 0);
    assert.match(result.answerMarkdown, /تخميني|provider failed|grounded project explanation/i);
    assert.doesNotMatch(result.answerMarkdown, /أقوى دلائل|strongest local evidence|sentiment_pipeline.*realtime/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project explainer defaults to provider authority before concept-not-found answers", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap: projectMapB });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLlm({
      provider,
      userPrompt: ARABIC_DATASET_REALTIME_PROMPT,
      report
    });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.equal(result.fallbackUsed, true);
    assert.match(result.fallbackReason ?? "", /Provider failed during project explanation: provider unavailable/);
    assert.equal(result.usedEvidenceRefs.length, 0);
    assert.doesNotMatch(result.answerMarkdown, /dataset realtime behavior|Requested concept not found|could not find/i);
    assert.match(result.answerMarkdown, /تخميني|provider failed|grounded project explanation/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await cleanup();
  }
});

test("project explainer can accept natural provider Markdown without structured JSON", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: "explain this project", projectMap });
    const provider = new NaturalTextExplainProvider();

    const result = await explainProjectWithLlm({
      provider,
      userPrompt: "explain this project",
      report,
      providerAnswerMode: "natural_text"
    });

    assert.equal(provider.structuredCalls <= 1, true);
    assert.equal(provider.textCalls, 1);
    assert.equal(result.fallbackUsed, false);
    assert.ok(result.usedEvidenceRefs.length > 0);
    assert.match(result.answerMarkdown, /key evidence|hivo-file/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("natural provider Markdown prompt is capped to focused evidence refs", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-natural-provider-budget-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  try {
    const importantFiles: string[] = [];
    for (let index = 0; index < 80; index += 1) {
      const file = `src/module-${index}.ts`;
      importantFiles.push(file);
      await writeFile(
        path.join(workspace, file),
        [
          `export function module${index}Feature() {`,
          `  return "feature-${index}";`,
          "}"
        ].join("\n"),
        "utf8"
      );
    }
    const projectMap: ProjectMap = {
      stack: ["TypeScript"],
      packageManagers: ["npm"],
      testCommands: [],
      entryPoints: ["src/module-0.ts"],
      importantFiles
    };
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: "explain this project", projectMap });
    const expandedReport: ProjectExplainReport = {
      ...report,
      evidence: [
        ...report.evidence,
        ...importantFiles.map((file, index) => ({
          type: "file" as const,
          path: file,
          lineStart: 1,
          lineEnd: 3,
          symbol: `module${index}Feature`,
          reason: "Budget fixture evidence item.",
          snippet: `export function module${index}Feature() { return "feature-${index}"; }`
        }))
      ]
    };
    const provider = new NaturalTextExplainProvider();

    const result = await explainProjectWithLlm({
      provider,
      userPrompt: "explain this project",
      report: expandedReport,
      providerAnswerMode: "natural_text"
    });

    assert.equal(result.fallbackUsed, false);
    assert.equal(provider.structuredCalls <= 1, true);
    assert.equal(provider.textCalls, 1);
    assert.ok(expandedReport.evidence.length > 45);
    assert.ok(provider.lastEvidenceRefCount > 0);
    assert.ok(provider.lastEvidenceRefCount <= 45);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic dataset realtime prompt returns concept not-found in unrelated todo workspace", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap: projectMapB });
    const provider = new CapturingExplainProvider([]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

    assert.equal(provider.requests.length, 0);
    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.concept.label, "dataset realtime behavior");
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.match(result.answerMarkdown, /dataset realtime behavior/i);
    assert.doesNotMatch(result.answerMarkdown, /could not find .*طفل|طفل بيقدر|بيقدر يجيب/i);
    assert.match(result.answerMarkdown, /todo app|checklist|README\.md|src\/todo\.js/i);
  } finally {
    await cleanup();
  }
});

test("dataset-only evidence does not allow invented realtime behavior", async () => {
  const { workspace, projectMap } = await createDatasetOnlyWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap });
    const provider = new CapturingExplainProvider([{
      answerMarkdown: "This project streams the dataset in realtime from a socket.",
      usedEvidenceRefs: [],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

    assert.equal(provider.requests.length, 0);
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.ok(result.grounding.evidenceGroupCoverage.find((group) => group.id === "dataset_source")?.found);
    assert.equal(result.grounding.evidenceGroupCoverage.find((group) => group.id === "realtime_update")?.found, false);
    assert.match(result.answerMarkdown, /realtime\/update behavior|missing/i);
    assert.doesNotMatch(result.answerMarkdown, /streams the dataset|socket/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dataset realtime provider answer citing only generic package evidence is rejected", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap });
    const packageRef = requireRef(report, /package\.json/);
    const badAnswer = `PACKAGE_ONLY_SENTINEL The dataset becomes realtime because the dashboard refreshes data. ${linkForRef(packageRef)}`;
    const provider = new CapturingExplainProvider([
      {
        answerMarkdown: badAnswer,
        usedEvidenceRefs: [packageRef],
        unsupportedOrUnclearParts: []
      },
      {
        answerMarkdown: badAnswer,
        usedEvidenceRefs: [packageRef],
        unsupportedOrUnclearParts: []
      }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

    assert.equal(provider.requests.length, 2);
    assert.match(result.unsupportedOrUnclearParts.join(" "), /evidence group/i);
    assert.doesNotMatch(result.answerMarkdown, /PACKAGE_ONLY_SENTINEL/);
    assert.match(result.answerMarkdown, /dataset|realtime|أقوى دلائل|مش هزود/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("LLM project explainer revises invalid citations once", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = "explain how the dataset looks realtime";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message, projectMap });
    const validRealtimeRef = requireRef(report, /dashboard_ui\/src\/App\.jsx/);
    const validDatasetRef = requireRef(report, /services\/cleaning\.py/);
    const provider = new CapturingExplainProvider([
      {
        answerMarkdown: "This answer invents a citation [fake.py:1](hivo-file:fake.py:1).",
        usedEvidenceRefs: ["fake.py:1"],
        unsupportedOrUnclearParts: []
      },
      {
        answerMarkdown: `The UI refreshes repeatedly from the API, so the dataset appears near-real-time rather than as a true stream. Dataset rows are normalized before the snapshot. ${linkForRef(validRealtimeRef)} ${linkForRef(validDatasetRef)}`,
        usedEvidenceRefs: [validRealtimeRef, validDatasetRef],
        unsupportedOrUnclearParts: []
      }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1]!.userPrompt, /failed local validation/i);
    assert.match(provider.requests[1]!.userPrompt, /Validation repair instructions/);
    assert.match(provider.requests[1]!.userPrompt, /Citation repair/);
    assert.match(provider.requests[1]!.userPrompt, /Agentic relationship-model evidence|Relationships followed/);
    assert.equal(result.revisionCount, 1);
    assert.deepEqual(result.usedEvidenceRefs, [validRealtimeRef, validDatasetRef]);
    assert.doesNotMatch(result.answerMarkdown, /fake\.py/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("concept-specific explain returns deterministic not-found for the wrong workspace", async () => {
  const { alpha, beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();
  void alpha;

  try {
    const message = "How does sentiment analysis work here? Explain it like I\u2019m a child.";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const readmeRef = requireRef(report, /README\.md/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis works here by sorting words into happy or sad buckets. ${linkForRef(readmeRef)}`,
      usedEvidenceRefs: [readmeRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 0);
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.match(result.answerMarkdown, /I could not find sentiment analysis/i);
    assert.match(result.answerMarkdown, /todo app|checklist|README\.md|src\/todo\.js/i);
    assert.doesNotMatch(result.answerMarkdown, /ALPHA_SENTIMENT_PROJECT|SENTIMENT_PIPELINE_ALPHA_ONLY|generic sentiment pipeline/i);
    assert.doesNotMatch(result.answerMarkdown, /architecture|orchestration|dependency graph/i);
  } finally {
    await cleanup();
  }
});

test("concept-specific explain uses current workspace evidence when the concept exists", async () => {
  const { alpha, projectMapA, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "How does sentiment analysis work here? Explain it like I\u2019m a child.";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis is in this project. It is like a tiny sorter that puts a review into a feeling bucket. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 1);
    assert.equal(result.grounding.decision, "concept_found");
    assert.match(provider.requests[0]!.userPrompt, /Concept-supporting refs:/);
    assert.match(result.answerMarkdown, /Sentiment analysis/i);
    assert.match(result.answerMarkdown, /tiny sorter|feeling bucket/i);
    assert.deepEqual(result.usedEvidenceRefs, [pipelineRef]);
  } finally {
    await cleanup();
  }
});

test("mixed Arabic style with English sentiment concept stays concept-grounded", async () => {
  const { alpha, projectMapA, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "\u0627\u0634\u0631\u062d\u0644\u064a sentiment analysis \u0647\u0646\u0627 \u0644\u0637\u0641\u0644 \u064a\u0642\u062f\u0631 \u064a\u0641\u0647\u0645";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis is like a tiny feeling sorter for reviews. It checks the words and picks a feeling label. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.concept.label, "sentiment analysis");
    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.decision, "concept_found");
    assert.equal(provider.requests.length, 1);
    assert.doesNotMatch(result.answerMarkdown, /could not find|not found/i);
    assert.match(result.answerMarkdown, /tiny feeling sorter|feeling label/i);
  } finally {
    await cleanup();
  }
});

test("Arabic sentiment concept maps to sentiment aliases and child style", async () => {
  const { alpha, projectMapA, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "\u0625\u0632\u0627\u064a \u062a\u062d\u0644\u064a\u0644 \u0627\u0644\u0645\u0634\u0627\u0639\u0631 \u0628\u064a\u0634\u062a\u063a\u0644 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d\u0647 \u0644\u0637\u0641\u0644";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `تحليل المشاعر هنا مثل فرز رسائل صغيرة حسب الإحساس. الكود ينظر في review ويرجع label بسيط. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.concept.label, "sentiment analysis");
    assert.equal(result.grounding.style, "child_simple");
    assert.ok(result.grounding.concept.aliases.includes("تحليل المشاعر"));
    assert.equal(result.grounding.decision, "concept_found");
    assert.match(result.answerMarkdown, /تحليل المشاعر|label بسيط/);
  } finally {
    await cleanup();
  }
});

test("sentement typo normalizes to sentiment analysis and finds evidence", async () => {
  const { alpha, projectMapA, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "اشرح sentement analysis ظ‡ظ†ا ببساطة";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis is found here. In simple words, it checks a review and returns a feeling. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.concept.label, "sentiment analysis");
    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.decision, "concept_found");
    assert.equal(provider.requests.length, 1);
  } finally {
    await cleanup();
  }
});

test("absent mixed-language sentiment concept reports the concept, not child style", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "\u0627\u0634\u0631\u062d sentiment analysis \u0647\u0646\u0627 \u0644\u0637\u0641\u0644";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const provider = new CapturingExplainProvider([]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 0);
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.match(result.answerMarkdown, /sentiment analysis/i);
    assert.doesNotMatch(result.answerMarkdown, /could not find .*طفل/i);
    assert.match(result.answerMarkdown, /todo app|checklist|README\.md|src\/todo\.js/i);
  } finally {
    await cleanup();
  }
});

test("style-only Arabic project explanation has no specific concept", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0647 \u0644\u0637\u0641\u0644";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const readmeRef = requireRef(report, /README\.md/);
    const simpleAnswer = {
      answerMarkdown: `المشروع ده is a small checklist app. You can think of it like a paper list for jobs to do. ${linkForRef(readmeRef)}`,
      usedEvidenceRefs: [readmeRef],
      unsupportedOrUnclearParts: []
    };
    const provider = new CapturingExplainProvider([simpleAnswer, simpleAnswer]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(result.grounding.concept.specific, false);
    assert.equal(result.grounding.style, "child_simple");
    assert.equal(result.grounding.decision, "general_project_explanation");
    assert.ok(provider.requests.length >= 1);
    assert.doesNotMatch(result.answerMarkdown, /could not find|not found/i);
  } finally {
    await cleanup();
  }
});

test("unsupported project identity claims are rejected even with valid current-workspace citations", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const message = "Explain this project.";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const readmeRef = requireRef(report, /README\.md/);
    const staleAnswer = `This is an Agentic AI e-commerce project with cart and checkout flows. ${linkForRef(readmeRef)}`;
    const provider = new CapturingExplainProvider([
      {
        answerMarkdown: staleAnswer,
        usedEvidenceRefs: [readmeRef],
        unsupportedOrUnclearParts: []
      },
      {
        answerMarkdown: staleAnswer,
        usedEvidenceRefs: [readmeRef],
        unsupportedOrUnclearParts: []
      }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 2);
    assert.equal(result.grounding.decision, "general_project_explanation");
    assert.match(result.unsupportedOrUnclearParts.join(" "), /unsupported project\/domain claim/i);
    assert.match(result.answerMarkdown, /todo app|README\.md|src\/todo\.js/i);
    assert.doesNotMatch(result.answerMarkdown, /e-commerce|checkout|cart|Agentic AI/i);
  } finally {
    await cleanup();
  }
});

test("Arabic threshold inventory prompt returns useful grounded numbers when provider fails", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_THRESHOLD_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_THRESHOLD_PROMPT, report });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.grounding.concept.label, "threshold inventory");
    assert.equal(result.grounding.answerShape, "inventory_table");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /0\.32/);
    assert.match(result.answerMarkdown, /0\.55/);
    assert.match(result.answerMarkdown, /0\.82/);
    assert.match(result.answerMarkdown, /0\.60/);
    assert.match(result.answerMarkdown, /0\.18/);
    assert.match(result.answerMarkdown, /0\.52/);
    assert.match(result.answerMarkdown, /orchestrator\.py|agents\.py|routes\.py|arima_model\.py/);
    assert.match(result.answerMarkdown, /\| Signal \|/);
    assert.doesNotMatch(result.answerMarkdown, /\*\*[^ \d]/);
    assert.doesNotMatch(result.answerMarkdown, /I could not find|could not safely produce/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("threshold provider answer citing only generic package evidence is rejected and synthesized", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_THRESHOLD_PROMPT, projectMap });
    const genericEvidence = report.evidence.find((entry) => /README\.md|package\.json/.test(entry.path) && entry.type !== "directory");
    assert.ok(genericEvidence, "expected generic README/package evidence");
    const genericRef = `${genericEvidence.path}:${genericEvidence.lineStart ?? 1}`;
    const badAnswer = `BAD_THRESHOLD_SENTINEL All thresholds are 999 and the agents page decides everything. ${linkForRef(genericRef)}`;
    const provider = new CapturingExplainProvider([
      { answerMarkdown: badAnswer, usedEvidenceRefs: [genericRef], unsupportedOrUnclearParts: [] },
      { answerMarkdown: badAnswer, usedEvidenceRefs: [genericRef], unsupportedOrUnclearParts: [] }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_THRESHOLD_PROMPT, report });

    assert.equal(provider.requests.length, 2);
    assert.match(result.unsupportedOrUnclearParts.join(" "), /threshold|evidence/i);
    assert.doesNotMatch(result.answerMarkdown, /BAD_THRESHOLD_SENTINEL|999/);
    assert.match(result.answerMarkdown, /0\.32|0\.82|orchestrator\.py/);
    assert.doesNotMatch(result.answerMarkdown, /could not safely produce/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic forecasting prompt identifies type and customer scope from evidence", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_FORECASTING_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_FORECASTING_PROMPT, report });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.grounding.concept.label, "forecasting type and scope");
    assert.equal(result.grounding.answerShape, "concise_explanation");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /SARIMA|ARIMA/);
    assert.match(result.answerMarkdown, /cluster-level|per-segment|predicted_cluster|not one SARIMA/i);
    assert.doesNotMatch(result.answerMarkdown, /scope.*not proven|not proven.*scope/i);
    assert.match(result.answerMarkdown, /arima_model\.py/);
    assert.match(result.answerMarkdown, /training|retraining|50|cadence/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \|/);
    assert.doesNotMatch(result.answerMarkdown, /\*\*[^ \d]/);
    assert.doesNotMatch(result.answerMarkdown, /I could not find|could not safely produce/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic forecasting logic prompt synthesizes Codex-like assessment instead of generic line-1 bullets", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_FORECASTING_LOGIC_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_FORECASTING_LOGIC_PROMPT, report });

    assert.equal(provider.requestCount, 1);
    assert.equal(result.fallbackUsed, true);
    assert.match(result.answerMarkdown, /SARIMA|SARIMAX|ARIMA/);
    assert.match(result.answerMarkdown, /cluster-level|per-cluster|per-segment|predicted_cluster|get_cluster_state/i);
    assert.match(result.answerMarkdown, /trend_multiplier/);
    assert.match(result.answerMarkdown, /normalized_trend[\s\S]*\/\s*1\.25|\/\s*1\.25[\s\S]*normalized_trend/i);
    assert.match(result.answerMarkdown, /demo|academic|production|أكاديمي|اكاديمي|مقبول|ضعيف|غلط/i);
    assert.match(result.answerMarkdown, /behavior_period|month|synthetic|period_date|صف ظˆاحد|time-series/i);
    assert.doesNotMatch(result.answerMarkdown, /forecasting implementation:\s*The implementation applies forecasting/i);
    assert.doesNotMatch(result.answerMarkdown, /\bbackend\/routes\.py:1\b/);
    assert.doesNotMatch(result.answerMarkdown, /implementation applies forecasting/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic algorithm inventory prompt uses algorithm/model evidence instead of threshold fallback", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_ALGORITHMS_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_ALGORITHMS_PROMPT, report });

    assert.equal(result.grounding.workspaceReasoning.intent.actionMode, "answer_only");
    assert.equal(result.grounding.workspaceReasoning.intent.answerGoal, "count");
    assert.equal(result.grounding.workspaceReasoning.intent.requiredFacets.includes("algorithms_models"), true);
    assert.equal(result.grounding.workspaceReasoning.intent.requiredFacets.includes("numeric_logic"), false);
    assert.equal(result.grounding.concept.label, "algorithms/models inventory");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /SVM|KMeans|Random Forest|SARIMA|DBSCAN|Fuzzy C-Means|SHAP/i);
    assert.match(result.answerMarkdown, /ml_models\.py|arima_model\.py|clustering\.py|svm_model\.py|shap_explainer\.py/);
    assert.doesNotMatch(result.answerMarkdown, /Customer Clustering Service|SARIMAForecasting Service/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|membership signal|shap cosine|0\.82/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic detailed SVM prompt synthesizes implementation flow instead of dumping snippets", async () => {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_SVM_DETAIL_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_SVM_DETAIL_PROMPT, report });

    assert.equal(result.grounding.workspaceReasoning.intent.answerGoal, "trace_flow");
    assert.equal(result.grounding.workspaceReasoning.intent.outputShape, "walkthrough");
    assert.equal(result.grounding.workspaceReasoning.intent.requiredFacets.includes("algorithms_models"), true);
    assert.match(result.answerMarkdown, /SVM/);
    assert.match(result.answerMarkdown, /features|labels|FCM|clustering|state/i);
    assert.match(result.answerMarkdown, /predict|predict_proba|classification|classifier/i);
    assert.match(result.answerMarkdown, /SHAP|shap_explainer\.py/i);
    assert.match(result.answerMarkdown, /svm_model\.py|clustering\.py/);
    assert.doesNotMatch(result.answerMarkdown, /The flow I could prove|"""|raw snippets/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|membership signal|0\.82/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("algorithm question stays turn-scoped after threshold and page questions", async () => {
  const { workspace, projectMap } = await createPageInventoryWorkspace();

  try {
    const thresholdReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_THRESHOLD_PROMPT, projectMap });
    const pageReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const algorithmReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_ALGORITHMS_PROMPT, projectMap });

    const thresholdResult = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_THRESHOLD_PROMPT, report: thresholdReport });
    const pageResult = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report: pageReport });
    const algorithmResult = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_ALGORITHMS_PROMPT, report: algorithmReport });

    assert.equal(thresholdResult.grounding.workspaceReasoning.intent.requiredFacets.includes("numeric_logic"), true);
    assert.equal(pageResult.grounding.workspaceReasoning.intent.requiredFacets.includes("ui_structure"), true);
    assert.equal(algorithmResult.grounding.workspaceReasoning.intent.requiredFacets.includes("algorithms_models"), true);
    assert.equal(algorithmResult.grounding.workspaceReasoning.intent.requiredFacets.includes("numeric_logic"), false);
    assert.match(algorithmResult.answerMarkdown, /SVM|KMeans|Random Forest|SARIMA/i);
    assert.doesNotMatch(algorithmResult.answerMarkdown, /\| Signal \||threshold inventory|0\.82|Overview|Customers|Agents page/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Arabic page inventory prompt returns pages instead of threshold inventory", async () => {
  const { workspace, projectMap } = await createPageInventoryWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const provider = new ThrowingExplainProvider();
    const grounding = analyzeProjectQuestionGrounding(ARABIC_PAGE_INVENTORY_PROMPT, report, []);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.concept.label, "page/screen inventory");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /Agents|Customers|Overview|صفحات|شاشات|views/i);
    assert.match(result.answerMarkdown, /frontend\/app\.js|frontend\/index\.html|src\/App\.jsx/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||minimum_score|0\.82|threshold inventory|threshlod/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("page inventory ignores CSS and title-only evidence instead of counting fake pages", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-css-only-pages-${Date.now()}`);
  await mkdir(path.join(workspace, "frontend"), { recursive: true });

  try {
    await writeFile(
      path.join(workspace, "frontend", "index.html"),
      [
        "<!doctype html>",
        "<html>",
        "<head>",
        "  <title>AMARS Pipeline Atlas</title>",
        "  <link rel=\"stylesheet\" href=\"./styles.css\">",
        "</head>",
        "<body>",
        "  <div id=\"root\"></div>",
        "</body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "frontend", "styles.css"),
      [
        ":root { --bg: #101214; }",
        ".overview-section { display: grid; }",
        ".agents-screen { padding: 24px; }",
        ".customers-page { min-height: 100vh; }"
      ].join("\n"),
      "utf8"
    );
    const projectMap: ProjectMap = {
      stack: ["HTML", "CSS"],
      packageManagers: [],
      testCommands: [],
      entryPoints: ["frontend/index.html"],
      importantFiles: ["frontend/index.html", "frontend/styles.css"]
    };

    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const result = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(result.grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.conceptFound, false);
    assert.match(result.answerMarkdown, /لا أقدر أؤكد|could not confirm/i);
    assert.doesNotMatch(result.answerMarkdown, /ظ„ظ‚ظٹطھ\s+\d+\s+(route|screen|section|tab|view|صفحة)/i);
    assert.doesNotMatch(result.answerMarkdown, /styles\.css.*(?:صفحة|screen|view|section|page)/i);
    assert.doesNotMatch(result.answerMarkdown, /AMARS Pipeline Atlas.*(?:صفحة|screen|view|section|page)/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|0\.82/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("page inventory reports SPA sections with functions and dedupes duplicate stylesheets", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-spa-pages-${Date.now()}`);
  await mkdir(path.join(workspace, "frontend", "frontend"), { recursive: true });

  try {
    await writeFile(
      path.join(workspace, "frontend", "index.html"),
      [
        "<!doctype html>",
        "<html>",
        "<body>",
        "  <nav>",
        "    <a href=\"#overview\">Overview</a>",
        "    <a href=\"#customers\">Customers</a>",
        "    <a href=\"#agents\">Agents</a>",
        "  </nav>",
        "  <section id=\"overview\">Overview shows the retention summary and KPI cards.</section>",
        "  <section id=\"customers\">Customers lists customer risk and churn details.</section>",
        "  <section id=\"agents\">Agents explains agent recommendations and route decisions.</section>",
        "  <script type=\"module\" src=\"./app.js\"></script>",
        "</body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "frontend", "app.js"),
      [
        "export const CHAPTERS = [",
        "  { id: 'overview', title: 'Overview', description: 'Shows the retention summary and KPI cards.' },",
        "  { id: 'customers', title: 'Customers', description: 'Lists customer risk and churn details.' },",
        "  { id: 'agents', title: 'Agents', description: 'Explains agent recommendations and route decisions.' }",
        "];"
      ].join("\n"),
      "utf8"
    );
    const css = [
      ":root { --bg: #101214; }",
      ".overview-section { display: grid; }",
      ".customers-page { display: grid; }",
      ".agents-screen { display: grid; }"
    ].join("\n");
    await writeFile(path.join(workspace, "frontend", "styles.css"), css, "utf8");
    await writeFile(path.join(workspace, "frontend", "frontend", "styles.css"), css, "utf8");

    const projectMap: ProjectMap = {
      stack: ["HTML", "JavaScript", "CSS"],
      packageManagers: [],
      testCommands: [],
      entryPoints: ["frontend/index.html", "frontend/app.js"],
      importantFiles: ["frontend/index.html", "frontend/app.js", "frontend/styles.css", "frontend/frontend/styles.css"]
    };

    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const result = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(result.grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /single-page|واجهة أقرب لـ single-page|section\/tab/i);
    assert.match(result.answerMarkdown, /\|\s*الاسم\s*\|\s*النوع\s*\|\s*بتعمل إيه\s*\|/);
    assert.match(result.answerMarkdown, /Overview.*retention summary|overview.*KPI/i);
    assert.match(result.answerMarkdown, /Customers.*customer risk|customers.*churn/i);
    assert.match(result.answerMarkdown, /Agents.*recommendations|agents.*route decisions/i);
    assert.doesNotMatch(result.answerMarkdown, /styles\.css.*(?:صفحة|screen|view|section|page)/i);
    assert.doesNotMatch(result.answerMarkdown, /:root|--bg|overview-section|customers-page|agents-screen/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|0\.82/i);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("page inventory can use JSX className sections from real UI source", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-jsx-sections-${Date.now()}`);
  await mkdir(path.join(workspace, "apps", "desktop", "src", "app"), { recursive: true });

  try {
    await writeFile(
      path.join(workspace, "apps", "desktop", "src", "app", "App.tsx"),
      [
        "export function App() {",
        "  return <main className=\"workspace-canvas\">",
        "    <section className=\"dashboard-screen\">Dashboard shows KPI cards and project status.</section>",
        "    <section className=\"activity-panel\">Activity panel lists running jobs and history.</section>",
        "    <aside className=\"settings-drawer\">Settings drawer edits model and workspace options.</aside>",
        "  </main>;",
        "}"
      ].join("\n"),
      "utf8"
    );
    const projectMap: ProjectMap = {
      stack: ["TypeScript", "React"],
      packageManagers: ["npm"],
      testCommands: [],
      entryPoints: ["apps/desktop/src/app/App.tsx"],
      importantFiles: ["apps/desktop/src/app/App.tsx"]
    };

    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const result = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(result.grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.conceptFound, true);
    assert.match(result.answerMarkdown, /dashboard screen|activity panel|settings drawer/i);
    assert.match(result.answerMarkdown, /KPI cards|running jobs|workspace options/i);
    assert.match(result.answerMarkdown, /App\.tsx/);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|0\.82/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("page inventory validation rejects stale threshold answer and synthesizes pages", async () => {
  const { workspace, projectMap } = await createPageInventoryWorkspace();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const pageRef = requireRef(report, /frontend\/app\.js|frontend\/index\.html/);
    const staleThresholdAnswer = [
      "BAD_STALE_THRESHOLDS",
      `جدول الـ thresholds: score >= 0.82 and membership < 0.52. ${linkForRef(pageRef)}`
    ].join(" ");
    const provider = new CapturingExplainProvider([
      { answerMarkdown: staleThresholdAnswer, usedEvidenceRefs: [pageRef], unsupportedOrUnclearParts: [] },
      { answerMarkdown: staleThresholdAnswer, usedEvidenceRefs: [pageRef], unsupportedOrUnclearParts: [] }
    ]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(provider.requests.length, 2);
    assert.match(result.unsupportedOrUnclearParts.join(" "), /page inventory|thresholds|unrelated numeric/i);
    assert.doesNotMatch(result.answerMarkdown, /BAD_STALE_THRESHOLDS|0\.82|membership < 0\.52/i);
    assert.match(result.answerMarkdown, /Agents|Customers|Overview|صفحات|شاشات|views/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("page inventory question stays turn-scoped after a threshold question", async () => {
  const { workspace, projectMap } = await createPageInventoryWorkspace();

  try {
    const thresholdReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_THRESHOLD_PROMPT, projectMap });
    const pageReport = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const thresholdResult = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_THRESHOLD_PROMPT, report: thresholdReport });
    const pageResult = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report: pageReport });

    assert.equal(thresholdResult.grounding.questionKind, "threshold_inventory");
    assert.equal(pageResult.grounding.questionKind, "page_inventory");
    assert.match(thresholdResult.answerMarkdown, /\| Signal \||0\.82|threshold/i);
    assert.doesNotMatch(pageResult.answerMarkdown, /\| Signal \||minimum_score|0\.82|threshold inventory/i);
    assert.match(pageResult.answerMarkdown, /Agents|Customers|Overview|frontend\/app\.js/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("backend-only page inventory reports no confirmed frontend pages", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-backend-only-pages-${Date.now()}`);
  await mkdir(path.join(workspace, "backend"), { recursive: true });
  try {
    await writeFile(path.join(workspace, "backend", "main.py"), "@app.get('/customers')\ndef customers():\n    return []\n", "utf8");
    const projectMap: ProjectMap = {
      stack: ["Python"],
      packageManagers: [],
      testCommands: [],
      entryPoints: ["backend/main.py"],
      importantFiles: ["backend/main.py"]
    };
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: ARABIC_PAGE_INVENTORY_PROMPT, projectMap });
    const result = await explainProjectWithLegacySynthesis({ provider: new ThrowingExplainProvider(), userPrompt: ARABIC_PAGE_INVENTORY_PROMPT, report });

    assert.equal(result.grounding.questionKind, "page_inventory");
    assert.equal(result.grounding.conceptFound, false);
    assert.match(result.answerMarkdown, /ماقدرتش|frontend|backend\/API|endpoint/i);
    assert.doesNotMatch(result.answerMarkdown, /\| Signal \||threshold inventory|0\.82/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("threshold concept absent returns not-found for threshold inventory, not typo filler", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message: ARABIC_THRESHOLD_PROMPT, projectMap: projectMapB });
    const provider = new CapturingExplainProvider([]);

    const result = await explainProjectWithLegacySynthesis({ provider, userPrompt: ARABIC_THRESHOLD_PROMPT, report });

    assert.equal(provider.requests.length, 0);
    assert.equal(result.grounding.decision, "concept_not_found");
    assert.match(result.answerMarkdown, /threshold inventory/i);
    assert.doesNotMatch(result.answerMarkdown, /\u0627\u0644threshlods/);
    assert.doesNotMatch(result.answerMarkdown, MOJIBAKE_PATTERN);
  } finally {
    await cleanup();
  }
});

test("runtime inspect-only stores evidence and does not fake a project explanation in demo mock mode", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-runtime-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-runtime-explain-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "apps", "desktop", "src"), { recursive: true });
  await mkdir(path.join(workspace, "packages", "protocol", "src"), { recursive: true });

  try {
    await writeFile(path.join(workspace, "README.md"), "# Runtime explain fixture\n", "utf8");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "runtime-explain", workspaces: ["apps/*", "packages/*"], scripts: { dev: "vite", test: "vitest" } }, null, 2),
      "utf8"
    );
    await writeFile(path.join(workspace, "apps", "desktop", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
    await writeFile(path.join(workspace, "packages", "protocol", "src", "index.ts"), "export type Protocol = { ok: true };\n", "utf8");

    const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
    try {
      const created = await runtime.createSession({
        workspacePath: workspace,
        mode: "demo_mock",
        userPrompt: "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0647"
      });
      await runtime.runTurn(created.sessionId, "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u062f\u0647");
      const session = runtime.getSession(created.sessionId);
      const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

      assert.equal(session?.runMode, "inspect_only");
      assert.equal(session?.patchProposals.length, 0);
      assert.equal(session?.commandRequests.length, 0);
      assert.ok(session?.explainReport);
      assert.ok(session?.artifacts.some((artifact) => artifact.type === "project_explain_report"));
      assert.ok(session?.artifacts.some((artifact) => artifact.type === "project_explain_answer"));
      assert.match(assistantMessage, /current workspace evidence|workspace|hivo-file/i);
      assert.match(assistantMessage, /hivo-file:/);
      assert.doesNotMatch(assistantMessage, /could not safely produce/i);
      assert.doesNotMatch(assistantMessage, MOJIBAKE_PATTERN);
      assert.doesNotMatch(assistantMessage, /Agentic AI E-Commerce|shopping\/search request|checkout/i);

      await runtime.runTurn(created.sessionId, "\u0627\u0646\u062a \u062c\u0628\u062a \u0627\u0644\u0645\u0644\u0641\u0627\u062a \u062f\u064a \u0645\u0646\u064a\u0646\u061f");
      const provenanceMessage = runtime.getSession(created.sessionId)?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
      assert.match(provenanceMessage, /Workspace:/);
      assert.match(provenanceMessage, /hivo-file:/);

      await runtime.runTurn(
        created.sessionId,
        "What are the main entrypoint files in this project? Use the detected candidates apps/desktop/src/App.tsx, packages/protocol/src/index.ts."
      );
      const entrypointMessage = runtime.getSession(created.sessionId)?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
      assert.doesNotMatch(entrypointMessage, /read-only explain report|external search|Main evidence refs/i);

      await runtime.runTurn(
        created.sessionId,
        "What dependency or configuration evidence is visible in README.md, package.json? Answer only from the opened project files."
      );
      const dependencyMessage = runtime.getSession(created.sessionId)?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
      assert.doesNotMatch(dependencyMessage, /read-only explain report|external search|Main evidence refs/i);
    } finally {
      await app.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function createDecisionThresholdWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-decision-thresholds-${Date.now()}`);
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# AMARS",
      "",
      "Adaptive multi-agent retention system with forecasting, agents, and rule-based routing."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "amars-threshold-fixture", scripts: { test: "node --test" } }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "orchestrator.py"),
    [
      "class ReActOrchestrator:",
      "    minimum_score = 0.32",
      "    borderline_low = 0.55",
      "    direct_dispatch_score = 0.82",
      "    high_cosine = 0.82",
      "    low_cosine = 0.60",
      "    low_gap = 0.18",
      "",
      "    def choose_route(self, score, shap_cosine, gap, drift_detected, membership_signal, trend_multiplier, class_severity):",
      "        if score < self.minimum_score:",
      "            return 'Human Review'",
      "        elif drift_detected and membership_signal < 0.52:",
      "            return 'Re-cluster'",
      "        elif gap < self.low_gap:",
      "            return 'Human Review'",
      "        elif score >= self.direct_dispatch_score and shap_cosine >= self.high_cosine:",
      "            return 'Strong Offer' if class_severity >= 0.75 else 'Offer'",
      "        elif shap_cosine < self.low_cosine:",
      "            return 'SHAP Re-check'",
      "        elif self.borderline_low <= score < self.direct_dispatch_score and trend_multiplier >= 1.0:",
      "            return 'RAG supported dispatch'",
      "        return 'Do Nothing' if class_severity < 0.45 else 'Offer'"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "agents.py"),
    [
      "class ReliabilityAgent:",
      "    weight = 1.1",
      "    def recommend(self, shap_cosine, gap):",
      "        if shap_cosine < 0.60 or gap < 0.18:",
      "            return 'Human Review'",
      "        return 'Offer'",
      "",
      "class ForecastAgent:",
      "    weight = 1.0",
      "    def recommend(self, trend_multiplier, class_severity):",
      "        normalized_trend = max(0.1, min(1.25, trend_multiplier)) / 1.25",
      "        if trend_multiplier < 1.0:",
      "            return 'Human Review'",
      "        if class_severity >= 0.75:",
      "            return 'Strong Offer'",
      "        return 'Offer'",
      "",
      "class ClusterHealthAgent:",
      "    weight = 1.0",
      "    def recommend(self, drift_detected, membership_signal):",
      "        if drift_detected and membership_signal < 0.52:",
      "            return 'Re-cluster'",
      "        return 'Offer'"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "AUTO_RETRAIN_EVERY_CUSTOMERS = 50",
      "",
      "def train_offline_artifacts(customers_processed):",
      "    sarima_service = SARIMAForecastingService()",
      "    sarima_service.fit_cluster_models(clean_df, training_y)",
      "    sarima_service.save_state()",
      "    should_auto_retrain = customers_processed >= AUTO_RETRAIN_EVERY_CUSTOMERS",
      "    return should_auto_retrain",
      "",
      "def process_customer(customer_frame, predicted_cluster):",
      "    sarima_service = SARIMAForecastingService().load_state()",
      "    forecast_state = sarima_service.get_cluster_state(predicted_cluster)",
      "    return forecast_state",
      "",
      "def score_customer_with_svm(customer_features):",
      "    predicted_state, confidence = predict_customer_state(customer_features)",
      "    model_context = {'predicted_state': predicted_state, 'svm_confidence': confidence}",
      "    return model_context",
      "",
      "def calculate_intelligent_score(class_severity, gap, membership_signal, shap_cosine, trend_multiplier):",
      "    normalized_trend = max(0.1, min(1.25, trend_multiplier)) / 1.25",
      "    score = (class_severity * gap * membership_signal * shap_cosine) ** 0.25 * normalized_trend",
      "    score = max(0.0, min(1.2, score))",
      "    return score",
      "",
      "def outer_loop_guardrail(last_8_gaps, baseline_gap, centroid_movement, new_f1, previous_f1):",
      "    average_gap = sum(last_8_gaps) / 8",
      "    gap_signal = average_gap < baseline_gap * 0.75",
      "    movement_signal = centroid_movement > 1.1",
      "    trigger_outer_loop = gap_signal and movement_signal",
      "    accepted = new_f1 >= max(0.42, previous_f1 - 0.01)",
      "    return trigger_outer_loop, accepted"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "arima_model.py"),
    [
      "class SARIMAForecastingService:",
      "    model_type = 'SARIMA'",
      "    def __init__(self):",
      "        self.cluster_series = {}",
      "        self.cluster_forecasts = {}",
      "        self.cluster_trend_multipliers = {}",
      "        self.global_history = None",
      "",
      "    def fit_cluster_models(self, df, cluster_labels):",
      "        self.cluster_forecasts = {}",
      "        for cluster_id, series in self.build_cluster_series(df, cluster_labels).items():",
      "            summary = self._fit_forecast_for_series(series)",
      "            self.cluster_forecasts[cluster_id] = summary",
      "        return self.cluster_forecasts",
      "",
      "    def _fit_forecast_for_series(self, series):",
      "        forecast_last = series[-1] + 0.02",
      "        current_last = series[-1]",
      "        delta = forecast_last - current_last",
      "        if delta > 0.015:",
      "            trend_multiplier = 1.15",
      "        elif delta < -0.015:",
      "            trend_multiplier = 0.88",
      "        else:",
      "            trend_multiplier = 1.0",
      "        deviation = abs(delta)",
      "        drift_detected = deviation > 0.03",
      "        massive_drift = deviation > 0.06",
      "        return {'trend_multiplier': trend_multiplier, 'drift_detected': drift_detected, 'massive_drift': massive_drift}",
      "",
      "    def get_cluster_state(self, cluster_id):",
      "        return {'cluster_label': int(cluster_id), 'forecast': self.cluster_forecasts.get(cluster_id, {}), 'trend_multiplier': 1.0}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "data_generator.py"),
    [
      "import random",
      "",
      "def generate_customer_row(customer_id):",
      "    behavior_period = random.choice(['stable_period', 'drift_period'])",
      "    month = random.randint(1, 12)",
      "    churn_label = 1 if behavior_period == 'drift_period' else 0",
      "    return {'customer_id': customer_id, 'behavior_period': behavior_period, 'month': month, 'churn_label': churn_label}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "clustering.py"),
    [
      "\"\"\"Customer clustering pipeline using DBSCAN followed by Fuzzy C-Means.\"\"\"",
      "from sklearn.cluster import DBSCAN",
      "import skfuzzy as fuzz",
      "",
      "def build_customer_segments(features):",
      "    density_clusters = DBSCAN(eps=0.35, min_samples=5).fit_predict(features)",
      "    centers, memberships, *_ = fuzz.cluster.cmeans(features.T, c=4, m=2.0, error=0.005, maxiter=1000)",
      "    fcm_labels = memberships.argmax(axis=0)",
      "    return density_clusters, fcm_labels, memberships"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "svm_model.py"),
    [
      "\"\"\"SVM state detector trained on FCM-generated labels.\"\"\"",
      "from sklearn.svm import SVC",
      "import joblib",
      "",
      "def train_svm_state_detector(features, fcm_labels):",
      "    svm = SVC(probability=True, kernel='rbf')",
      "    svm.fit(features, fcm_labels)",
      "    joblib.dump(svm, 'artifacts/svm_state_detector.joblib')",
      "    return svm",
      "",
      "def predict_customer_state(features):",
      "    svm = joblib.load('artifacts/svm_state_detector.joblib')",
      "    predicted_state = svm.predict(features)",
      "    confidence = svm.predict_proba(features).max(axis=1)",
      "    return predicted_state, confidence"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "shap_explainer.py"),
    [
      "import shap",
      "",
      "def explain_svm_prediction(svm, background, customer_features):",
      "    explainer = shap.KernelExplainer(svm.predict_proba, background)",
      "    shap_values = explainer.shap_values(customer_features)",
      "    return shap_values"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "ml_models.py"),
    [
      "from sklearn.svm import SVC",
      "from sklearn.cluster import KMeans",
      "from sklearn.ensemble import RandomForestClassifier",
      "",
      "def train_churn_models(features, labels):",
      "    svm_classifier = SVC(probability=True)",
      "    cluster_model = KMeans(n_clusters=4)",
      "    retention_forest = RandomForestClassifier(n_estimators=50)",
      "    svm_classifier.fit(features, labels)",
      "    cluster_model.fit(features)",
      "    retention_forest.fit(features, labels)",
      "    return svm_classifier, cluster_model, retention_forest"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "frontend", "index.html"),
    [
      "<!doctype html>",
      "<html>",
      "<body>",
      "  <section id=\"agents-page\">Agents page renders orchestrator threshold snapshots.</section>",
      "</body>",
      "</html>"
    ].join("\n"),
    "utf8"
  );
  const projectMap: ProjectMap = {
    stack: ["Python", "HTML"],
    packageManagers: ["npm"],
    testCommands: [],
    entryPoints: ["backend/routes.py", "frontend/index.html"],
    importantFiles: [
      "README.md",
      "package.json",
      "backend/services/orchestrator.py",
      "backend/services/agents.py",
      "backend/routes.py",
      "backend/services/arima_model.py",
      "backend/services/data_generator.py",
      "backend/services/clustering.py",
      "backend/services/svm_model.py",
      "backend/services/shap_explainer.py",
      "backend/services/ml_models.py",
      "frontend/index.html"
    ]
  };
  return { workspace, projectMap };
}

async function createPageInventoryWorkspace() {
  const { workspace, projectMap } = await createDecisionThresholdWorkspace();
  await writeFile(
    path.join(workspace, "frontend", "app.js"),
    [
      "export const CHAPTERS = [",
      "  { id: 'overview', title: 'Overview', description: 'Shows the main retention summary.' },",
      "  { id: 'customers', title: 'Customers', description: 'Lists customer risk and churn details.' },",
      "  { id: 'agents', title: 'Agents', description: 'Shows agent recommendations and decision support.' }",
      "];",
      "",
      "export function renderChapter(id) {",
      "  return CHAPTERS.find((chapter) => chapter.id === id);",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "frontend", "index.html"),
    [
      "<!doctype html>",
      "<html>",
      "<body>",
      "  <nav>",
      "    <a href=\"#overview\">Overview</a>",
      "    <a href=\"#customers\">Customers</a>",
      "    <a href=\"#agents\">Agents</a>",
      "  </nav>",
      "  <section id=\"overview\">Overview page shows the main retention summary.</section>",
      "  <section id=\"customers\">Customers page lists customer risk details.</section>",
      "  <section id=\"agents\">Agents page renders orchestrator decision snapshots.</section>",
      "  <script type=\"module\" src=\"./app.js\"></script>",
      "</body>",
      "</html>"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(workspace, "dashboard_ui", "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "dashboard_ui", "src", "App.jsx"),
    [
      "import { BrowserRouter, Routes, Route } from 'react-router-dom';",
      "export function App() {",
      "  return <BrowserRouter><Routes>",
      "    <Route path=\"/\" element={<Overview />} />",
      "    <Route path=\"/customers\" element={<Customers />} />",
      "    <Route path=\"/agents\" element={<Agents />} />",
      "  </Routes></BrowserRouter>;",
      "}",
      "function Overview() { return <main>Overview</main>; }",
      "function Customers() { return <main>Customers</main>; }",
      "function Agents() { return <main>Agents</main>; }"
    ].join("\n"),
    "utf8"
  );
  return {
    workspace,
    projectMap: {
      ...projectMap,
      stack: ["Python", "HTML", "JavaScript", "React"],
      entryPoints: [...projectMap.entryPoints, "frontend/app.js", "dashboard_ui/src/App.jsx"],
      importantFiles: [...projectMap.importantFiles, "frontend/app.js", "dashboard_ui/src/App.jsx"]
    }
  };
}

async function createBigDataSentimentWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-bigdata-sentiment-${Date.now()}`);
  await mkdir(path.join(workspace, "dashboard_ui", "src"), { recursive: true });
  await mkdir(path.join(workspace, "analytics_engine"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await mkdir(path.join(workspace, "ingestion"), { recursive: true });
  await mkdir(path.join(workspace, "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# Big Data Analytics",
      "",
      "Sentiment analysis over dataset records with near realtime dashboard updates."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "docs", "message_schema.md"),
    [
      "# Message Schema",
      "",
      "Each customer review message has a text field, a timestamp, and a source_dataset field.",
      "The dashboard treats newer timestamps as fresh records for near realtime display.",
      "Sentiment results are attached as sentiment_label and sentiment_score."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "ingestion", "stream_comments.py"),
    [
      "from datetime import datetime",
      "",
      "def load_dataset_records(dataset_path):",
      "    return [{'text': 'great product', 'source_dataset': dataset_path}]",
      "",
      "def stream_dataset_comments(dataset_path):",
      "    for record in load_dataset_records(dataset_path):",
      "        yield {**record, 'timestamp': datetime.utcnow().isoformat()}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "analytics_engine", "sentiment_pipeline.py"),
    [
      "class SentimentClassifier:",
      "    def predict(self, text):",
      "        if 'great' in text.lower() or 'love' in text.lower():",
      "            return {'sentiment_label': 'positive', 'sentiment_score': 0.91}",
      "        return {'sentiment_label': 'neutral', 'sentiment_score': 0.50}",
      "",
      "def analyze_sentiment_stream(records):",
      "    classifier = SentimentClassifier()",
      "    return [{**record, **classifier.predict(record['text'])} for record in records]"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ name: "big-data-analytics-dashboard", scripts: { dev: "vite", test: "node --test" } }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "dashboard_ui", "src", "App.jsx"),
    [
      "import { useEffect, useState } from 'react';",
      "export function App() {",
      "  const [snapshot, setSnapshot] = useState(null);",
      "  useEffect(() => {",
      "    const timer = setInterval(async () => {",
      "      const response = await fetch('/api/snapshot');",
      "      setSnapshot(await response.json());",
      "    }, 1000);",
      "    return () => clearInterval(timer);",
      "  }, []);",
      "  return <main>{snapshot?.totals ?? 0}</main>;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "analytics_engine", "pipeline.py"),
    [
      "def build_dashboard_snapshot(records):",
      "    return {'totals': len(records), 'series': records[-20:]}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "services", "cleaning.py"),
    [
      "def normalize_dataset_row(row):",
      "    return {'text': row['text'], 'sentiment': row.get('sentiment', 'neutral')}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "services", "alerts.py"),
    [
      "def emit_realtime_alert(snapshot):",
      "    return {'level': 'info', 'snapshot': snapshot}"
    ].join("\n"),
    "utf8"
  );
  const projectMap: ProjectMap = {
    stack: ["Python", "JavaScript", "Markdown"],
    packageManagers: ["npm"],
    testCommands: [],
    entryPoints: ["dashboard_ui/src/App.jsx", "ingestion/stream_comments.py"],
    importantFiles: [
      "README.md",
      "package.json",
      "docs/message_schema.md",
      "ingestion/stream_comments.py",
      "dashboard_ui/src/App.jsx",
      "analytics_engine/pipeline.py",
      "analytics_engine/sentiment_pipeline.py",
      "services/cleaning.py",
      "services/alerts.py"
    ]
  };
  return { workspace, projectMap };
}

async function createDatasetOnlyWorkspace() {
  const workspace = path.join(os.tmpdir(), `hivo-dataset-only-${Date.now()}`);
  await mkdir(path.join(workspace, "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "README.md"),
    [
      "# Dataset Loader",
      "",
      "This project loads dataset records and prepares rows for analytics."
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "services", "cleaning.py"),
    [
      "def normalize_dataset_row(row):",
      "    return {'text': row['text'], 'value': row.get('value', 0)}"
    ].join("\n"),
    "utf8"
  );
  const projectMap: ProjectMap = {
    stack: ["Python", "Markdown"],
    packageManagers: [],
    testCommands: [],
    entryPoints: ["services/cleaning.py"],
    importantFiles: ["README.md", "services/cleaning.py"]
  };
  return { workspace, projectMap };
}

async function createAlphaBetaWorkspaces() {
  const base = path.join(os.tmpdir(), `hivo-alpha-beta-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const alpha = path.join(base, "ALPHA_SENTIMENT_PROJECT");
  const beta = path.join(base, "BETA_TODO_APP");
  await mkdir(path.join(alpha, "src"), { recursive: true });
  await mkdir(path.join(beta, "src"), { recursive: true });
  await writeFile(
    path.join(alpha, "README.md"),
    "# ALPHA_SENTIMENT_PROJECT\n\nThis project performs sentiment analysis on customer reviews.\n",
    "utf8"
  );
  await writeFile(
    path.join(alpha, "src", "pipeline.py"),
    [
      "SENTIMENT_PIPELINE_ALPHA_ONLY = True",
      "def analyze_sentiment(review):",
      "    if 'love' in review.lower():",
      "        return 'positive'",
      "    return 'neutral'",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(alpha, "pyproject.toml"),
    "[project]\nname = \"alpha-sentiment-project\"\nversion = \"0.1.0\"\n",
    "utf8"
  );
  await writeFile(
    path.join(beta, "README.md"),
    "# BETA_TODO_APP\n\nThis is a simple todo app.\n",
    "utf8"
  );
  await writeFile(
    path.join(beta, "src", "todo.js"),
    [
      "export const TODO_APP_BETA_ONLY = true;",
      "export function addTodo(items, title) {",
      "  return [...items, { title, done: false }];",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(beta, "package.json"),
    JSON.stringify({ name: "beta-todo-app", scripts: { test: "echo ok" } }, null, 2),
    "utf8"
  );
  const projectMapA: ProjectMap = {
    stack: ["Python", "Markdown"],
    packageManagers: [],
    testCommands: [],
    entryPoints: ["src/pipeline.py"],
    importantFiles: ["README.md", "src/pipeline.py", "pyproject.toml"]
  };
  const projectMapB: ProjectMap = {
    stack: ["JavaScript", "Markdown"],
    packageManagers: ["npm"],
    testCommands: ["npm test"],
    entryPoints: ["src/todo.js"],
    importantFiles: ["README.md", "src/todo.js", "package.json"]
  };
  return {
    alpha,
    beta,
    projectMapA,
    projectMapB,
    cleanup: () => rm(base, { recursive: true, force: true })
  };
}

function requireRef(report: ProjectExplainReport, pathPattern: RegExp) {
  const section = report.sections.find((entry) => pathPattern.test(entry.filePath));
  assert.ok(section, `Expected evidence section matching ${pathPattern}`);
  return `${section.filePath}:${section.lineStart}`;
}

function linkForRef(ref: string) {
  const match = ref.match(/^(.+):(\d+)$/);
  assert.ok(match, `Invalid ref ${ref}`);
  return `[${ref}](hivo-file:${encodeURIComponent(match[1]!)}:${match[2]})`;
}
