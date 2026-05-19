import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectExplainReport, ProjectMap } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { loadConfig } from "../config.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import {
  explainProjectWithLlm,
  type ProjectExplainLlmResponse
} from "../runtime/LlmProjectExplainer.js";
import {
  detectProjectAnswerStyle,
  extractRequestedConcept,
  type ProjectAnswerStyle
} from "../runtime/ProjectQuestionGrounding.js";
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

const ARABIC_DATASET_REALTIME_PROMPT = "اشرح المشروع دا ل طفل ازاي بيقدر يجيب الداتا من داتا سيت كانها realtime prompt :";

type ConceptExtractionRegressionCase = {
  name: string;
  prompt: string;
  expectedStyle: ProjectAnswerStyle;
  expectedConceptLabel: string;
  expectedSpecific: boolean;
  expectedEvidenceGroupIds?: string[];
  forbiddenConceptPattern?: RegExp;
};

// Add real mis-extracted user prompts here first, then make the smallest deterministic extractor change.
const CONCEPT_EXTRACTION_REGRESSIONS: ConceptExtractionRegressionCase[] = [
  {
    name: "Arabic child style plus dataset realtime concept",
    prompt: ARABIC_DATASET_REALTIME_PROMPT,
    expectedStyle: "child_simple",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"],
    forbiddenConceptPattern: /طفل|بيقدر|يجيب/i
  },
  {
    name: "Actual Arabic child style plus dataset realtime concept",
    prompt: "اشرح المشروع دا ل طفل ازاي بيقدر يجيب الداتا من داتا سيت كانها realtime prompt :",
    expectedStyle: "child_simple",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"],
    forbiddenConceptPattern: /طفل|بيقدر|يجيب/i
  },
  {
    name: "Arabic style plus English sentiment concept",
    prompt: "اشرحلي sentiment analysis هنا لطفل يقدر يفهم",
    expectedStyle: "child_simple",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /طفل|يقدر|يفهم/i
  },
  {
    name: "Arabic sentiment concept plus child style",
    prompt: "إزاي تحليل المشاعر بيشتغل هنا؟ اشرحه لطفل",
    expectedStyle: "child_simple",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /طفل/i
  },
  {
    name: "Sentement typo plus simple style",
    prompt: "اشرح sentement analysis هنا ببساطة",
    expectedStyle: "child_simple",
    expectedConceptLabel: "sentiment analysis",
    expectedSpecific: true,
    forbiddenConceptPattern: /ببساطة/i
  },
  {
    name: "Arabic style-only project explanation",
    prompt: "اشرح المشروع ده لطفل",
    expectedStyle: "child_simple",
    expectedConceptLabel: "this project",
    expectedSpecific: false,
    forbiddenConceptPattern: /طفل/i
  },
  {
    name: "English dataset realtime concept",
    prompt: "explain how the dataset looks realtime",
    expectedStyle: "default",
    expectedConceptLabel: "dataset realtime behavior",
    expectedSpecific: true,
    expectedEvidenceGroupIds: ["dataset_source", "realtime_update"]
  }
];

test("concept extraction regressions preserve concept, style, and evidence groups", () => {
  for (const entry of CONCEPT_EXTRACTION_REGRESSIONS) {
    const concept = extractRequestedConcept(entry.prompt);
    const style = detectProjectAnswerStyle(entry.prompt);
    const aggregateConceptText = [
      concept.label,
      concept.displayLabel ?? "",
      ...concept.terms,
      ...concept.coreTerms
    ].join(" ");

    assert.equal(style, entry.expectedStyle, entry.name);
    assert.equal(concept.label, entry.expectedConceptLabel, entry.name);
    assert.equal(concept.specific, entry.expectedSpecific, entry.name);

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

test("large project explain report clusters modules and ignores vendor/build folders", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-large-explain-${Date.now()}`);
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
  const workspace = path.join(os.tmpdir(), `orchcode-static-explain-${Date.now()}`);
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
      message: "اشرح المشروع",
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
      "تخيل عندك كراسة فيها جمل كتير. المشروع بياخد شوية سطور من الـ dataset، ينضف كل سطر، وبعدين يحدّث الشاشة كل ثانية تقريبا.",
      "",
      `ده مش realtime حقيقي زي socket أو stream؛ الدليل هنا إن الواجهة بتعمل polling/تحديث متكرر من ${linkForRef(appRef)}.`,
      `بعد كده الداتا بتتجهز للتحليل في ${linkForRef(cleaningRef)}، ومنها يقدر يحسب sentiment ويعرض snapshot جديد.`
    ].join("\n");
    const provider = new CapturingExplainProvider([{
      answerMarkdown,
      usedEvidenceRefs: [sentimentRef, appRef, cleaningRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    assert.match(result.answerMarkdown, /polling|تحديث متكرر|كل ثانية/i);
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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "اشرح المشروع دا ل طفل ازاي بيقدر يجيب الداتا من داتا سيت كانها realtime";
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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

    assert.equal(result.grounding.projectContextRequired, true);
    assert.equal(result.grounding.projectDomain.label, "sentiment analysis");
    assert.equal(result.grounding.concept.label, "dataset realtime behavior");
    assert.equal(result.grounding.conceptFound, true);
    assert.ok(result.grounding.projectDomain.sourceEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
    assert.match(provider.requests[0]!.userPrompt, /Project Mapper:|Data Flow Mapper:|Grounding Skeptic:/);
    assert.match(result.answerMarkdown, /sentiment analysis|تحليل/);
    assert.match(result.answerMarkdown, /stream_comments|setInterval|fetch|polling/);
    assert.doesNotMatch(result.answerMarkdown, /notebook of rows|كراسة/);
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("sentiment_pipeline.py")));
    assert.ok(result.usedEvidenceRefs.some((ref) => ref.includes("stream_comments.py")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("project-context provider answer cannot omit proven sentiment domain", async () => {
  const { workspace, projectMap } = await createBigDataSentimentWorkspace();

  try {
    const message = "اشرح المشروع دا ل طفل ازاي بيقدر يجيب الداتا من داتا سيت كانها realtime";
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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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

    const result = await explainProjectWithLlm({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

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

test("Arabic dataset realtime prompt returns concept not-found in unrelated todo workspace", async () => {
  const { beta, projectMapB, cleanup } = await createAlphaBetaWorkspaces();

  try {
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message: ARABIC_DATASET_REALTIME_PROMPT, projectMap: projectMapB });
    const provider = new CapturingExplainProvider([]);

    const result = await explainProjectWithLlm({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

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

    const result = await explainProjectWithLlm({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

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

    const result = await explainProjectWithLlm({ provider, userPrompt: ARABIC_DATASET_REALTIME_PROMPT, report });

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
        answerMarkdown: "This answer invents a citation [fake.py:1](orchcode-file:fake.py:1).",
        usedEvidenceRefs: ["fake.py:1"],
        unsupportedOrUnclearParts: []
      },
      {
        answerMarkdown: `The UI refreshes repeatedly from the API, so the dataset appears near-real-time rather than as a true stream. Dataset rows are normalized before the snapshot. ${linkForRef(validRealtimeRef)} ${linkForRef(validDatasetRef)}`,
        usedEvidenceRefs: [validRealtimeRef, validDatasetRef],
        unsupportedOrUnclearParts: []
      }
    ]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 2);
    assert.match(provider.requests[1]!.userPrompt, /failed local validation/i);
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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "اشرحلي sentiment analysis هنا لطفل يقدر يفهم";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis is like a tiny feeling sorter for reviews. It checks the words and picks a feeling label. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "إزاي تحليل المشاعر بيشتغل هنا؟ اشرحه لطفل";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `تحليل المشاعر هنا مثل فرز رسائل صغيرة حسب الإحساس. الكود ينظر في review ويرجع label بسيط. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "اشرح sentement analysis هنا ببساطة";
    const report = buildLargeProjectExplainReport({ workspacePath: alpha, message, projectMap: projectMapA });
    const pipelineRef = requireRef(report, /src\/pipeline\.py/);
    const provider = new CapturingExplainProvider([{
      answerMarkdown: `Sentiment analysis is found here. In simple words, it checks a review and returns a feeling. ${linkForRef(pipelineRef)}`,
      usedEvidenceRefs: [pipelineRef],
      unsupportedOrUnclearParts: []
    }]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "اشرح sentiment analysis هنا لطفل";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const provider = new CapturingExplainProvider([]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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
    const message = "اشرح المشروع ده لطفل";
    const report = buildLargeProjectExplainReport({ workspacePath: beta, message, projectMap: projectMapB });
    const readmeRef = requireRef(report, /README\.md/);
    const simpleAnswer = {
      answerMarkdown: `المشروع ده is a small checklist app. You can think of it like a paper list for jobs to do. ${linkForRef(readmeRef)}`,
      usedEvidenceRefs: [readmeRef],
      unsupportedOrUnclearParts: []
    };
    const provider = new CapturingExplainProvider([simpleAnswer, simpleAnswer]);

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

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

    const result = await explainProjectWithLlm({ provider, userPrompt: message, report });

    assert.equal(provider.requests.length, 2);
    assert.equal(result.grounding.decision, "general_project_explanation");
    assert.match(result.unsupportedOrUnclearParts.join(" "), /unsupported project\/domain claim/i);
    assert.match(result.answerMarkdown, /todo app|README\.md|src\/todo\.js/i);
    assert.doesNotMatch(result.answerMarkdown, /e-commerce|checkout|cart|Agentic AI/i);
  } finally {
    await cleanup();
  }
});

test("runtime inspect-only stores evidence and does not fake a project explanation in demo mock mode", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-explain-storage-${Date.now()}`);
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
        userPrompt: "اشرح المشروع ده"
      });
      await runtime.runTurn(created.sessionId, "اشرح المشروع ده");
      const session = runtime.getSession(created.sessionId);
      const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

      assert.equal(session?.runMode, "inspect_only");
      assert.equal(session?.patchProposals.length, 0);
      assert.equal(session?.commandRequests.length, 0);
      assert.ok(session?.explainReport);
      assert.ok(session?.artifacts.some((artifact) => artifact.type === "project_explain_report"));
      assert.ok(session?.artifacts.some((artifact) => artifact.type === "project_explain_answer"));
      assert.match(assistantMessage, /مش هطلع شرح تخميني|could not safely produce/i);
      assert.match(assistantMessage, /orchcode-file:/);
      assert.doesNotMatch(assistantMessage, /Agentic AI E-Commerce|shopping\/search request|checkout/i);

      await runtime.runTurn(created.sessionId, "انت جبت الملفات دي منين؟");
      const provenanceMessage = runtime.getSession(created.sessionId)?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
      assert.match(provenanceMessage, /Workspace:/);
      assert.match(provenanceMessage, /orchcode-file:/);
    } finally {
      await app.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

async function createBigDataSentimentWorkspace() {
  const workspace = path.join(os.tmpdir(), `orchcode-bigdata-sentiment-${Date.now()}`);
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
  const workspace = path.join(os.tmpdir(), `orchcode-dataset-only-${Date.now()}`);
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
  const base = path.join(os.tmpdir(), `orchcode-alpha-beta-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  return `[${ref}](orchcode-file:${encodeURIComponent(match[1]!)}:${match[2]})`;
}
