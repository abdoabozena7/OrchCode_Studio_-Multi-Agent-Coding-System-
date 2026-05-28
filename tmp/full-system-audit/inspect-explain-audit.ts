import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "../../apps/agent-runtime/src/runtime/AgentRuntime.js";
import { SessionManager } from "../../apps/agent-runtime/src/runtime/SessionManager.js";
import { EventBus } from "../../apps/agent-runtime/src/runtime/EventBus.js";
import { loadConfig } from "../../apps/agent-runtime/src/config.js";

type FetchCall = {
  url: string;
  model?: string;
  startedAt: string;
  durationMs: number;
  ok?: boolean;
  status?: number;
  error?: string;
};

const auditDir = path.resolve("tmp/full-system-audit");
const outAnswers = path.join(auditDir, "answers.json");
const outFailures = path.join(auditDir, "failures.json");
const outReport = path.join(auditDir, "inspect-explain-reality-report.md");
const storageDir = path.join(auditDir, "inspect-explain-runtime-storage");
const workspacePath = process.cwd();
const baseUrl = "http://127.0.0.1:11434";
const model = process.env.ORCHCODE_AUDIT_MODEL ?? "qwen2.5-coder:7b";

const prompts = [
  "\u0639\u0646\u062f\u064a \u0647\u0646\u0627 \u0643\u0627\u0645 \u0635\u0641\u062d\u0629 \u0641 \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u062f\u0647 \u0648\u0643\u0644 \u0648\u0627\u062d\u062f\u0629 \u0628\u062a\u0639\u0645\u0644 \u0625\u064a\u0647\u061f",
  "\u0625\u064a\u0647 \u0627\u0644\u0632\u0631\u0627\u064a\u0631 \u0627\u0644\u0644\u064a \u0639\u0646\u062f\u064a \u0641\u064a \u0627\u0644\u0633\u064a\u0633\u062a\u0645 \u0648\u0628\u062a\u0639\u0645\u0644 \u0625\u064a\u0647\u061f",
  "\u0639\u0646\u062f\u0646\u0627 \u0643\u0627\u0645 algorithm \u0647\u0646\u0627\u061f \u0648\u0627\u0634\u0631\u062d\u0647\u0645 \u0648\u0627\u062d\u062f\u0629 \u0648\u0627\u062d\u062f\u0629.",
  "\u0627\u0632\u0627\u064a \u0627\u0644DBSCAN \u0628\u064a\u062a\u0637\u0628\u0642 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d \u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644.",
  "\u0627\u0632\u0627\u064a \u0627\u0644feedback \u0628\u064a\u062a\u0637\u0628\u0642 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d \u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644.",
  "\u0627\u0632\u0627\u064a \u0627\u0644outerloop \u0628\u064a\u062a\u0637\u0628\u0642 \u0647\u0646\u0627\u061f \u0627\u0634\u0631\u062d \u0628\u0627\u0644\u062a\u0641\u0635\u064a\u0644.",
  "\u0647\u0644 \u0641\u064a\u0647 inner loop \u0648 outer loop \u0647\u0646\u0627\u061f \u0627\u0644\u0641\u0631\u0642 \u0628\u064a\u0646\u0647\u0645 \u0625\u064a\u0647\u061f",
  "\u0647\u0644 \u0639\u0646\u062f\u064a training \u0648 inference \u0645\u0646\u0641\u0635\u0644\u064a\u0646\u061f \u0643\u0644 \u0648\u0627\u062d\u062f \u0641\u064a\u0646 \u0648\u0628\u064a\u0639\u0645\u0644 \u0625\u064a\u0647\u061f"
];

const originalFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  let bodyModel: string | undefined;
  try {
    if (typeof init?.body === "string") {
      bodyModel = JSON.parse(init.body).model;
    }
  } catch {
    bodyModel = undefined;
  }
  try {
    const response = await originalFetch(input, init);
    if (url.includes("127.0.0.1:11434") || url.includes("localhost:11434")) {
      fetchCalls.push({
        url,
        model: bodyModel,
        startedAt,
        durationMs: Date.now() - start,
        ok: response.ok,
        status: response.status
      });
    }
    return response;
  } catch (error) {
    if (url.includes("127.0.0.1:11434") || url.includes("localhost:11434")) {
      fetchCalls.push({
        url,
        model: bodyModel,
        startedAt,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  }
}) as typeof fetch;

function artifact(session: any, type: string) {
  return session.artifacts?.find((entry: any) => entry.type === type);
}

function truncate(text: unknown, max = 2000) {
  const value = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function scoreAnswer(input: {
  prompt: string;
  providerCalls: number;
  answer: string;
  report: any;
  explainAnswer: any;
}) {
  const answer = input.answer.toLowerCase();
  const prompt = input.prompt.toLowerCase();
  const targetFound = input.explainAnswer?.payload?.metadata?.conceptResolution?.target_found;
  const evidence = input.report?.payload?.metadata?.openedFiles?.length ?? input.report?.payload?.metadata?.searchedFiles?.length ?? 0;
  const hasCitations = input.answer.includes("orchcode-file:");
  let grade = "C";
  const reasons: string[] = [];
  if (input.providerCalls === 0) reasons.push("no real provider call");
  if (!hasCitations) reasons.push("answer has no file citations");
  if (evidence === 0) reasons.push("no opened/searched file evidence surfaced");
  if (/dbscan|feedback|outerloop|inner loop|training|inference|algorithm/.test(prompt) && targetFound === false) {
    grade = "F";
    reasons.push("target concept not found by runtime");
  }
  if (answer.includes("not find") || answer.includes("could not find") || answer.includes("لم أجد")) {
    grade = grade === "F" ? "F" : "D";
    reasons.push("final answer reports not-found");
  }
  if (input.providerCalls > 0 && hasCitations && evidence > 0 && grade !== "F" && grade !== "D") {
    grade = "B";
    reasons.push("real provider path with citations and surfaced evidence");
  }
  if (input.providerCalls > 0 && hasCitations && evidence > 5 && targetFound !== false && input.answer.length > 1200) {
    grade = "A";
    reasons.push("detailed answer with real provider path and multiple evidence files");
  }
  return { grade, reasons };
}

async function main() {
  await mkdir(auditDir, { recursive: true });
  await rm(storageDir, { recursive: true, force: true });

  const tagsStarted = Date.now();
  let tags: any = null;
  try {
    const response = await fetch(`${baseUrl}/api/tags`);
    tags = await response.json();
  } catch (error) {
    tags = { error: error instanceof Error ? error.message : String(error) };
  }
  const tagsLatencyMs = Date.now() - tagsStarted;

  const sessionManager = new SessionManager(storageDir, new EventBus(), { runtimeEventLoader: async () => [] });
  await sessionManager.load();
  (sessionManager as any).persist = async () => undefined;
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager);

  const answers: any[] = [];
  const failures: any[] = [];
  for (const prompt of prompts) {
    const before = fetchCalls.length;
    const startedAt = new Date().toISOString();
    const start = Date.now();
    try {
      const created = await runtime.createSession({
        workspacePath,
        mode: "real_provider",
        userPrompt: prompt,
        providerConfig: {
          providerType: "ollama",
          providerName: "Ollama",
          baseUrl,
          selectedModel: model,
          isValid: true
        } as any,
        accessProfile: "full_access"
      });
      const afterTurn = await runtime.runTurn(created.sessionId, prompt);
      const finalSession = sessionManager.getSession(afterTurn.sessionId) ?? afterTurn;
      const calls = fetchCalls.slice(before);
      const report = artifact(finalSession, "project_explain_report");
      const explainAnswer = artifact(finalSession, "project_explain_answer");
      const mechanism = artifact(finalSession, "mechanism_chain");
      const evidenceTiers = artifact(finalSession, "evidence_tiers");
      const concept = artifact(finalSession, "concept_resolution");
      const graph = artifact(finalSession, "investigation_graph");
      const contextPack = artifact(finalSession, "context_pack");
      const assistant = [...(finalSession.messages ?? [])].reverse().find((message: any) => message.role === "assistant");
      const answerText = assistant?.content ?? "";
      const grade = scoreAnswer({
        prompt,
        providerCalls: calls.length,
        answer: answerText,
        report,
        explainAnswer
      });
      answers.push({
        prompt,
        startedAt,
        durationMs: Date.now() - start,
        status: finalSession.status,
        lifecycleStage: finalSession.lifecycleStage,
        detectedIntent: finalSession.taskState?.intent,
        targetConcept:
          explainAnswer?.payload?.metadata?.questionUnderstanding?.targetConcept ??
          concept?.payload?.metadata?.targetConcept ??
          concept?.payload?.targetConcept,
        workspaceRoot: finalSession.workspacePath,
        providerMode: finalSession.mode,
        model,
        providerCalls: calls.length,
        providerCallDetails: calls,
        swarmUsed: false,
        artifactTypes: finalSession.artifacts?.map((entry: any) => entry.type) ?? [],
        contextPackFiles: contextPack?.payload?.metadata?.files?.slice?.(0, 25) ?? [],
        filesRead:
          explainAnswer?.payload?.metadata?.openedFiles ??
          report?.payload?.metadata?.openedFiles ??
          graph?.payload?.metadata?.files ??
          [],
        searchedFiles: report?.payload?.metadata?.searchedFiles ?? [],
        analyzersUsed:
          explainAnswer?.payload?.metadata?.analysisPipeline ??
          report?.payload?.metadata?.analysisPipeline ??
          ["project-intake", "universal-project-question-engine", "inspect-explain-read-lanes"],
        structuredFacts:
          report?.payload?.metadata?.facts?.slice?.(0, 20) ??
          graph?.payload?.metadata?.facts?.slice?.(0, 20) ??
          [],
        evidenceTiers: evidenceTiers?.payload ?? evidenceTiers?.summary,
        mechanismChains: mechanism?.payload ?? mechanism?.summary,
        conceptResolution: concept?.payload ?? explainAnswer?.payload?.metadata?.conceptResolution,
        fallbackUsed: explainAnswer?.payload?.metadata?.fallbackUsed ?? report?.payload?.metadata?.fallbackUsed,
        validation: explainAnswer?.payload?.metadata?.validation ?? report?.payload?.metadata?.validation,
        finalAnswer: answerText,
        finalAnswerPreview: truncate(answerText, 1200),
        grade: grade.grade,
        gradeReasons: grade.reasons
      });
    } catch (error) {
      const calls = fetchCalls.slice(before);
      failures.push({
        prompt,
        startedAt,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
        providerCalls: calls.length,
        providerCallDetails: calls
      });
    }
  }

  const markdown = [
    "# Inspect/Explain Reality Report",
    "",
    `Workspace: ${workspacePath}`,
    `Provider: ollama ${model}`,
    `Ollama tags latency: ${tagsLatencyMs} ms`,
    `Available models: ${Array.isArray(tags?.models) ? tags.models.map((entry: any) => entry.name).join(", ") : JSON.stringify(tags)}`,
    "",
    "| Prompt | Provider calls | Files surfaced | Fallback | Grade | Verdict |",
    "| --- | ---: | ---: | --- | --- | --- |",
    ...answers.map((entry) => `| ${entry.prompt.replaceAll("|", "\\|")} | ${entry.providerCalls} | ${Array.isArray(entry.filesRead) ? entry.filesRead.length : 0} | ${entry.fallbackUsed ?? "unknown"} | ${entry.grade} | ${entry.gradeReasons.join("; ").replaceAll("|", "\\|")} |`),
    "",
    "## Failures",
    failures.length ? failures.map((entry) => `- ${entry.prompt}: ${entry.error}`).join("\n") : "None.",
    "",
    "## Notes",
    "- `swarmUsed` is recorded as false because the inspect/explain runtime path calls ProjectIntake and UniversalProjectQuestionEngine directly; no SwarmRuntime entry point was observed in this path.",
    "- Grades are audit heuristics, not product tests. They penalize no provider call, no citations, not-found answers for requested concepts, and lack of surfaced file evidence."
  ].join("\n");

  await writeFile(outAnswers, `${JSON.stringify(answers, null, 2)}\n`, "utf8");
  await writeFile(outFailures, `${JSON.stringify(failures, null, 2)}\n`, "utf8");
  await writeFile(outReport, `${markdown}\n`, "utf8");
  console.log(JSON.stringify({
    ok: failures.length === 0,
    answers: answers.length,
    failures: failures.length,
    providerCalls: fetchCalls.length,
    model,
    outAnswers,
    outFailures,
    outReport
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
