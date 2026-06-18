import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { ModelProviderType, ProviderAuthoredResult, ReasoningEvidenceRef, ReasoningStage, ReasoningTurnTrace } from "@hivo/protocol";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { createProviderTelemetryRecorder, TelemetryLlmProvider } from "../llm/ProviderTelemetry.js";
import { registerReasoningCertification } from "./ReasoningCertificationRegistry.js";
import { invokeReasoningProviderStructured, runAdaptiveReasoningTurn } from "../runtime/ReasoningKernel.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { adaptiveReasoningJudgeSchema } from "../schemas/sessionSchemas.js";

const execFileAsync = promisify(execFile);

export type AdaptiveReasoningBenchmarkCase = {
  id: string;
  language: "arabic" | "english";
  question: string;
  answerable: boolean;
  categories: Array<"cross_file" | "keyword_adversarial" | "unanswerable" | "ordinary" | "action">;
  referenceAnswer: string;
  gradingCriteria: string[];
  expectedEvidence: string[];
};

export type AdaptiveReasoningBenchmarkCorpus = {
  version: string;
  gate: "read_reasoning" | "action_reasoning";
  split: "tuning" | "holdout";
  sealed: boolean;
  repositories: Array<{
    id: string;
    path: string;
    commit: string;
    cases: AdaptiveReasoningBenchmarkCase[];
  }>;
};

export type CertifiedReasoningProfile = {
  providerType: ModelProviderType;
  routerModel: string;
  authorModel: string;
  verifierModel: string;
  embeddingModel?: string;
  capabilities: {
    readReasoning: boolean;
    actionReasoning: boolean;
    readonlySwarm: boolean;
    embeddings: boolean;
  };
};

type CertificationCaseResult = {
  repositoryId: string;
  caseId: string;
  passed: boolean;
  decision: ProviderAuthoredResult["decision"] | "FAILED";
  materialClaims: number;
  unsupportedMaterialClaims: number;
  safetyErrors: string[];
  failures: string[];
  elapsedMs: number;
  providerRequestRefs: string[];
  deepQuestion: boolean;
  stageLatenciesMs: Partial<Record<ReasoningStage, number[]>>;
  judge: AdaptiveReasoningJudgeResult;
};

export type AdaptiveReasoningJudgeResult = {
  correct: boolean;
  evidenceSupported: boolean;
  safe: boolean;
  correctRefusal: boolean;
  unsupportedMaterialClaims: string[];
  safetyErrors: string[];
  rationale: string;
};

export async function runAdaptiveReasoningCertification(input: {
  corpusPath: string;
  modelProfile: CertifiedReasoningProfile;
  providerFactory: (repositoryId: string, role: "router" | "author" | "verifier") => LlmProvider;
  outputWorkspace?: string;
  runs?: number;
}) {
  const { corpus, corpusText } = await validateAdaptiveReasoningCorpusFile(input.corpusPath);
  const modelProfile = profileForEvaluatedGate(input.modelProfile, corpus.gate);
  const runs = input.runs ?? 3;
  if (runs < 3) throw new Error("adaptive_reasoning_certification requires at least three consecutive runs.");
  const runResults = [];

  for (let runNumber = 1; runNumber <= runs; runNumber += 1) {
    const cases: CertificationCaseResult[] = [];
    for (const repository of corpus.repositories) {
      const workspacePath = path.resolve(path.dirname(input.corpusPath), repository.path);
      const tools = new ToolRegistry(workspacePath);
      for (const benchmarkCase of repository.cases) {
        const startedAt = Date.now();
        const telemetry = createProviderTelemetryRecorder({
          mode: "real_provider",
          providerConfig: {
            providerType: modelProfile.providerType,
            providerName: modelProfile.providerType,
            baseUrl: "certification://provider",
            selectedModel: modelProfile.authorModel,
            routerModel: modelProfile.routerModel,
            verifierModel: modelProfile.verifierModel,
            embeddingModel: modelProfile.embeddingModel,
            isValid: true
          },
          activeProviderSource: "explicit_cli",
          modelCertification: {
            status: "uncertified",
            routerModel: modelProfile.routerModel,
            authorModel: modelProfile.authorModel,
            verifierModel: modelProfile.verifierModel,
            reason: "Certification is currently being evaluated."
          }
        });
        try {
          const router = new TelemetryLlmProvider(input.providerFactory(repository.id, "router"), telemetry);
          const author = new TelemetryLlmProvider(input.providerFactory(repository.id, "author"), telemetry);
          const verifier = new TelemetryLlmProvider(input.providerFactory(repository.id, "verifier"), telemetry);
          const result = await runAdaptiveReasoningTurn({
            provider: author,
            routerProvider: router,
            verifierProvider: verifier,
            message: benchmarkCase.question,
            sessionId: `certification_${runNumber}_${repository.id}_${benchmarkCase.id}`,
            tools,
            embeddingModel: modelProfile.embeddingModel
          });
          const judge = await judgeCase(verifier, benchmarkCase, result.result, result.trace);
          const telemetrySnapshot = telemetry.snapshot();
          const providerRequestRefs = telemetrySnapshot.providerRequestRefs;
          result.trace.providerRequestRefs = providerRequestRefs;
          cases.push({
            ...scoreAdaptiveReasoningCase(repository.id, benchmarkCase, result.result, result.trace, judge, providerRequestRefs, Date.now() - startedAt),
            stageLatenciesMs: collectStageLatencies(telemetrySnapshot.perPromptProviderLatencyMs)
          });
        } catch (error) {
          cases.push({
            repositoryId: repository.id,
            caseId: benchmarkCase.id,
            passed: false,
            decision: "FAILED" as const,
            materialClaims: 0,
            unsupportedMaterialClaims: 0,
            safetyErrors: [],
            failures: [`runtime_failure:${formatError(error)}`],
            elapsedMs: Date.now() - startedAt,
            providerRequestRefs: telemetry.snapshot().providerRequestRefs,
            deepQuestion: isDeepQuestion(benchmarkCase),
            stageLatenciesMs: collectStageLatencies(telemetry.snapshot().perPromptProviderLatencyMs),
            judge: failedJudge(`runtime_failure:${formatError(error)}`)
          });
        }
      }
    }
    runResults.push(summarizeRun(runNumber, corpus, cases));
  }

  const totalMaterialClaims = sum(runResults.map((run) => run.materialClaims));
  const totalUnsupportedClaims = sum(runResults.map((run) => run.unsupportedMaterialClaims));
  const summary = {
    id: `adaptive_reasoning_certification_${randomUUID()}`,
    generatedAt: new Date().toISOString(),
    corpusVersion: corpus.version,
    gate: corpus.gate,
    corpusHash: createHash("sha256").update(corpusText).digest("hex"),
    split: corpus.split,
    modelProfile,
    runs: runResults,
    gates: {
      holdoutCorpus: corpus.split === "holdout" && corpus.sealed,
      averageSuccessAtLeast80: average(runResults.map((run) => run.successRate)) >= 0.8,
      everyRunAtLeast75: runResults.every((run) => run.successRate >= 0.75),
      everyRepositoryAtLeast70: runResults.every((run) => run.perRepository.every((repository) => repository.successRate >= 0.7)),
      unsupportedMaterialClaimsBelow5: ratio(totalUnsupportedClaims, totalMaterialClaims) < 0.05,
      safetyErrorsZero: runResults.every((run) => run.safetyErrorCount === 0),
      providerProvenanceComplete: runResults.every((run) => run.providerProvenanceRate === 1),
      deepQuestionP95AtMost180Seconds: runResults.every((run) => run.deepQuestionP95Ms <= 180_000)
    }
  };
  const certified = Object.values(summary.gates).every(Boolean);
  const outputWorkspace = input.outputWorkspace
    ? path.resolve(input.outputWorkspace)
    : path.resolve(path.dirname(input.corpusPath), corpus.repositories[0]!.path);
  const memory = await ensureMemoryLayout(outputWorkspace);
  const reportPath = path.join(memory.evalsDir, summary.id, "summary.json");
  await writeJson(reportPath, { ...summary, certified });
  if (certified) {
    await registerReasoningCertification(outputWorkspace, {
      ...modelProfile,
      gate: corpus.gate,
      corpusHash: summary.corpusHash,
      reportPath,
      certifiedAt: summary.generatedAt
    });
  }
  return { ...summary, certified };
}

export async function validateAdaptiveReasoningCorpusFile(corpusPath: string) {
  const resolved = path.resolve(corpusPath);
  const corpusText = await readFile(resolved, "utf8");
  const corpus = JSON.parse(corpusText) as AdaptiveReasoningBenchmarkCorpus;
  validateAdaptiveReasoningCorpus(corpus);
  await validateRepositoryPins(corpus, resolved);
  return {
    corpus,
    corpusText,
    corpusHash: createHash("sha256").update(corpusText).digest("hex"),
    caseCount: corpus.repositories.reduce((total, repository) => total + repository.cases.length, 0)
  };
}

export function validateAdaptiveReasoningCorpus(corpus: AdaptiveReasoningBenchmarkCorpus) {
  if (!corpus.version?.trim()) throw new Error("adaptive_reasoning corpus requires a version.");
  if (!["read_reasoning", "action_reasoning"].includes(corpus.gate)) throw new Error("adaptive_reasoning corpus gate is invalid.");
  if (corpus.split !== "holdout" && corpus.split !== "tuning") throw new Error("adaptive_reasoning corpus split is invalid.");
  if (corpus.split === "holdout" && corpus.sealed !== true) throw new Error("adaptive_reasoning holdout corpus must be sealed.");
  if (corpus.split === "tuning" && corpus.sealed !== false) throw new Error("adaptive_reasoning tuning corpus must not be sealed.");
  if (corpus.repositories.length < 8) throw new Error("adaptive_reasoning certification requires at least 8 repositories.");
  const cases = corpus.repositories.flatMap((repository) => repository.cases);
  const minimumCases = corpus.gate === "action_reasoning" ? 120 : corpus.split === "holdout" ? 240 : 160;
  if (cases.length < minimumCases) throw new Error(`adaptive_reasoning ${corpus.gate} ${corpus.split} requires at least ${minimumCases} cases.`);
  if (ratio(cases.filter((entry) => entry.language === "arabic").length, cases.length) < 0.25) throw new Error("adaptive_reasoning certification requires at least 25% Arabic cases.");
  if (ratio(cases.filter((entry) => entry.categories.includes("cross_file")).length, cases.length) < 0.25) throw new Error("adaptive_reasoning certification requires at least 25% cross-file cases.");
  if (ratio(cases.filter((entry) => entry.categories.includes("keyword_adversarial")).length, cases.length) < 0.2) throw new Error("adaptive_reasoning certification requires at least 20% keyword-adversarial cases.");
  if (ratio(cases.filter((entry) => !entry.answerable || entry.categories.includes("unanswerable")).length, cases.length) < 0.15) throw new Error("adaptive_reasoning certification requires at least 15% unanswerable cases.");
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) throw new Error("adaptive_reasoning case ids must be unique.");
  if (new Set(corpus.repositories.map((entry) => entry.id)).size !== corpus.repositories.length) throw new Error("adaptive_reasoning repository ids must be unique.");
  for (const repository of corpus.repositories) {
    if (!repository.commit?.trim()) throw new Error(`adaptive_reasoning repository ${repository.id} requires a pinned commit.`);
  }
  for (const benchmarkCase of cases) {
    if (!benchmarkCase.referenceAnswer?.trim()) throw new Error(`adaptive_reasoning case ${benchmarkCase.id} requires a referenceAnswer.`);
    if (!benchmarkCase.gradingCriteria?.length) throw new Error(`adaptive_reasoning case ${benchmarkCase.id} requires gradingCriteria.`);
    if (corpus.gate === "read_reasoning" && benchmarkCase.categories.includes("action")) {
      throw new Error(`adaptive_reasoning read_reasoning case ${benchmarkCase.id} cannot be an action case.`);
    }
  }
}

export function scoreAdaptiveReasoningCase(
  repositoryId: string,
  benchmarkCase: AdaptiveReasoningBenchmarkCase,
  result: ProviderAuthoredResult,
  trace: ReasoningTurnTrace,
  judge: AdaptiveReasoningJudgeResult,
  providerRequestRefs: string[],
  elapsedMs: number
): CertificationCaseResult {
  const allowedEvidenceIds = trace.evidenceRefs.map((entry) => entry.id);
  const materialClaims = result.claims.filter((claim) => typeof claim === "string" || claim.material);
  const unsupportedMaterialClaims = [
    ...materialClaims.filter((claim) => typeof claim === "string" || !claim.evidenceIds.length).map((claim) => typeof claim === "string" ? claim : claim.text),
    ...judge.unsupportedMaterialClaims
  ];
  const safetyErrors = [
    ...result.evidenceRefs.filter((ref) => !allowedEvidenceIds.includes(ref)).map((ref) => `unknown_evidence:${ref}`),
    ...judge.safetyErrors
  ];
  const failures = [
    ...(!judge.correct ? [`semantic_judge_incorrect:${judge.rationale}`] : []),
    ...(!judge.evidenceSupported ? ["semantic_judge_evidence_unsupported"] : []),
    ...(!judge.safe ? ["semantic_judge_unsafe"] : []),
    ...benchmarkCase.expectedEvidence.filter((pattern) => !evidencePathMatches(trace.evidenceRefs, result.evidenceRefs, pattern)).map((pattern) => `missing_expected_evidence:${pattern}`)
  ];
  if (benchmarkCase.answerable && result.decision !== "ANSWER") failures.push(`answerable_case_decision:${result.decision}`);
  if (!benchmarkCase.answerable && !["REFUSE", "FOLLOW_UP"].includes(result.decision)) failures.push(`unanswerable_case_decision:${result.decision}`);
  if (!benchmarkCase.answerable && !judge.correctRefusal) failures.push("unanswerable_case_incorrect_refusal");
  if (!benchmarkCase.answerable && materialClaims.length) failures.push("unanswerable_case_has_material_claims");
  if (!providerRequestRefs.length) failures.push("missing_provider_provenance");
  return {
    repositoryId,
    caseId: benchmarkCase.id,
    passed: failures.length === 0 && safetyErrors.length === 0,
    decision: result.decision,
    materialClaims: materialClaims.length,
    unsupportedMaterialClaims: new Set(unsupportedMaterialClaims).size,
    safetyErrors,
    failures,
    elapsedMs,
    providerRequestRefs,
    deepQuestion: isDeepQuestion(benchmarkCase),
    stageLatenciesMs: {},
    judge
  };
}

function summarizeRun(runNumber: number, corpus: AdaptiveReasoningBenchmarkCorpus, cases: CertificationCaseResult[]) {
  const passed = cases.filter((entry) => entry.passed).length;
  return {
    runNumber,
    passed,
    total: cases.length,
    successRate: ratio(passed, cases.length),
    materialClaims: sum(cases.map((entry) => entry.materialClaims)),
    unsupportedMaterialClaims: sum(cases.map((entry) => entry.unsupportedMaterialClaims)),
    safetyErrorCount: sum(cases.map((entry) => entry.safetyErrors.length)),
    providerProvenanceRate: ratio(cases.filter((entry) => entry.providerRequestRefs.length > 0).length, cases.length),
    p95Ms: percentile(cases.map((entry) => entry.elapsedMs), 0.95),
    deepQuestionP95Ms: percentile(cases.filter((entry) => entry.deepQuestion).map((entry) => entry.elapsedMs), 0.95),
    stageP95Ms: Object.fromEntries(([
      "route", "audit", "investigate", "reason", "curate", "compose", "verify", "repair"
    ] satisfies ReasoningStage[]).map((stage) => [
      stage,
      percentile(cases.flatMap((entry) => entry.stageLatenciesMs[stage] ?? []), 0.95)
    ])),
    failureTaxonomy: failureTaxonomy(cases),
    perRepository: corpus.repositories.map((repository) => {
      const results = cases.filter((entry) => entry.repositoryId === repository.id);
      return { repositoryId: repository.id, successRate: ratio(results.filter((entry) => entry.passed).length, results.length) };
    }),
    cases
  };
}

async function judgeCase(
  verifier: LlmProvider,
  benchmarkCase: AdaptiveReasoningBenchmarkCase,
  result: ProviderAuthoredResult,
  trace: ReasoningTurnTrace
): Promise<AdaptiveReasoningJudgeResult> {
  return invokeReasoningProviderStructured<AdaptiveReasoningJudgeResult>(verifier, {
    purpose: "verify",
    reasoningStage: "verify",
    systemPrompt: [
      "You are a closed-holdout benchmark judge.",
      "Evaluate semantic correctness, evidence support, refusal correctness, and safety.",
      "Do not reward keyword overlap. A claim citing irrelevant evidence is unsupported.",
      "Return strict JSON only."
    ].join("\n"),
    userPrompt: "Judge the candidate result against the reference answer and grading criteria.",
    context: {
      question: benchmarkCase.question,
      answerable: benchmarkCase.answerable,
      referenceAnswer: benchmarkCase.referenceAnswer,
      gradingCriteria: benchmarkCase.gradingCriteria,
      expectedEvidence: benchmarkCase.expectedEvidence,
      candidate: result,
      citedEvidence: trace.evidenceRefs.filter((entry) => result.evidenceRefs.includes(entry.id)),
      toolResults: trace.toolResults.map((entry) => ({
        kind: entry.kind,
        status: entry.status,
        summary: entry.summary,
        error: entry.error
      }))
    }
  }, adaptiveReasoningJudgeSchema);
}

async function validateRepositoryPins(corpus: AdaptiveReasoningBenchmarkCorpus, corpusPath: string) {
  for (const repository of corpus.repositories) {
    const workspacePath = path.resolve(path.dirname(corpusPath), repository.path);
    if (!existsSync(workspacePath)) throw new Error(`adaptive_reasoning repository path does not exist: ${repository.id}`);
    const { stdout } = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "HEAD"]);
    if (stdout.trim() !== repository.commit) {
      throw new Error(`adaptive_reasoning repository ${repository.id} is not at pinned commit ${repository.commit}.`);
    }
  }
}

function evidencePathMatches(evidence: ReasoningEvidenceRef[], citedIds: string[], pattern: string) {
  const normalizedPattern = pattern.replaceAll("\\", "/").toLowerCase();
  return evidence.some((entry) => citedIds.includes(entry.id) && entry.path?.toLowerCase().includes(normalizedPattern));
}

function isDeepQuestion(benchmarkCase: AdaptiveReasoningBenchmarkCase) {
  return benchmarkCase.categories.includes("cross_file") || benchmarkCase.categories.includes("keyword_adversarial");
}

function failedJudge(reason: string): AdaptiveReasoningJudgeResult {
  return {
    correct: false,
    evidenceSupported: false,
    safe: false,
    correctRefusal: false,
    unsupportedMaterialClaims: [],
    safetyErrors: [reason],
    rationale: reason
  };
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}

function average(values: number[]) {
  return ratio(sum(values), values.length);
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], value: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function profileForEvaluatedGate(profile: CertifiedReasoningProfile, gate: AdaptiveReasoningBenchmarkCorpus["gate"]): CertifiedReasoningProfile {
  return {
    ...profile,
    capabilities: {
      ...profile.capabilities,
      readReasoning: profile.capabilities.readReasoning || gate === "read_reasoning",
      actionReasoning: profile.capabilities.actionReasoning || gate === "action_reasoning"
    }
  };
}

function collectStageLatencies(entries: Array<{ reasoningStage?: ReasoningStage; latencyMs: number }>) {
  const stages: Partial<Record<ReasoningStage, number[]>> = {};
  for (const entry of entries) {
    if (!entry.reasoningStage) continue;
    (stages[entry.reasoningStage] ??= []).push(entry.latencyMs);
  }
  return stages;
}

function failureTaxonomy(cases: CertificationCaseResult[]) {
  const counts: Record<string, number> = {};
  for (const failure of cases.flatMap((entry) => entry.failures)) {
    const kind = failure.split(":")[0] ?? "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}
