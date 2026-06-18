import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectRelationshipKind } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";
import { refreshRepoIndex } from "../memory/IndexFreshness.js";
import { runProjectUnderstandingKernel } from "../runtime/ProjectUnderstandingKernel.js";
import { runReadOnlyUnderstandingEscalation } from "../runtime/ProjectUnderstandingEscalation.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

export type ProjectUnderstandingBenchmarkCase = {
  id: string;
  language: "arabic" | "english";
  question: string;
  requiredClaims: string[];
  forbiddenClaims: string[];
  expectedRelationships: Array<{
    kind: ProjectRelationshipKind;
    fromContains?: string;
    toContains?: string;
  }>;
  expectedEvidence: string[];
};

export type ProjectUnderstandingBenchmarkCorpus = {
  repositories: Array<{
    id: string;
    path: string;
    cases: ProjectUnderstandingBenchmarkCase[];
  }>;
};

export async function runProjectUnderstandingBenchmark(input: {
  corpusPath: string;
  providerFactory: (repositoryId: string) => LlmProvider;
  embeddingModel: string;
  outputWorkspace?: string;
  minimumCases?: number;
  minimumRepositories?: number;
}) {
  const corpus = JSON.parse(await readFile(path.resolve(input.corpusPath), "utf8")) as ProjectUnderstandingBenchmarkCorpus;
  validateCorpus(corpus, input.minimumCases ?? 120, input.minimumRepositories ?? 5);
  const caseResults: Array<{
    repositoryId: string;
    caseId: string;
    passed: boolean;
    decision: string;
    elapsedMs: number;
    providerCalls: number;
    unsupportedMaterialClaims: number;
    materialClaims: number;
    safetyErrors: string[];
    failures: string[];
  }> = [];

  for (const repository of corpus.repositories) {
    const workspacePath = path.resolve(path.dirname(input.corpusPath), repository.path);
    await refreshRepoIndex(workspacePath);
    const tools = new ToolRegistry(workspacePath);
    const provider = input.providerFactory(repository.id);
    for (const benchmarkCase of repository.cases) {
      const result = await runProjectUnderstandingKernel({
        question: benchmarkCase.question,
        provider,
        tools,
        embeddingModel: input.embeddingModel,
        mode: "on",
        escalate: (question, missingFacts, budget) => runReadOnlyUnderstandingEscalation({
          workspacePath,
          provider,
          question,
          missingFacts,
          budget
        })
      });
      const normalizedAnswer = normalize(result.finalAnswerMarkdown);
      const failures = [
        ...benchmarkCase.requiredClaims.filter((claim) => !normalizedAnswer.includes(normalize(claim))).map((claim) => `missing_required_claim:${claim}`),
        ...benchmarkCase.forbiddenClaims.filter((claim) => normalizedAnswer.includes(normalize(claim))).map((claim) => `included_forbidden_claim:${claim}`),
        ...benchmarkCase.expectedRelationships.filter((relationship) => !matchesRelationship(result.graphExpansionTrace, relationship))
          .map((relationship) => `missing_expected_relationship:${relationship.kind}:${relationship.fromContains ?? "*"}:${relationship.toContains ?? "*"}`),
        ...benchmarkCase.expectedEvidence.filter((pattern) => !result.evidenceRefs.some((ref) => ref.toLowerCase().includes(pattern.toLowerCase()))).map((pattern) => `missing_expected_evidence:${pattern}`)
      ];
      const safetyErrors = result.evidenceRefs
        .map((ref) => ref.replace(/:\d+$/, ""))
        .filter((filePath) => !tools.workspace.fileExists(filePath))
        .map((filePath) => `missing_or_unsafe_evidence:${filePath}`);
      const materialClaims = result.claimLedger.claims.filter((claim) => claim.material).length;
      caseResults.push({
        repositoryId: repository.id,
        caseId: benchmarkCase.id,
        passed: result.decision === "ANSWER" && !failures.length && !safetyErrors.length,
        decision: result.decision,
        elapsedMs: result.elapsedMs,
        providerCalls: result.providerCalls,
        unsupportedMaterialClaims: result.claimLedger.unsupportedMaterialClaims,
        materialClaims,
        safetyErrors,
        failures
      });
    }
  }

  const perRepository = corpus.repositories.map((repository) => {
    const results = caseResults.filter((result) => result.repositoryId === repository.id);
    return {
      repositoryId: repository.id,
      passed: results.filter((result) => result.passed).length,
      total: results.length,
      successRate: ratio(results.filter((result) => result.passed).length, results.length)
    };
  });
  const passed = caseResults.filter((result) => result.passed).length;
  const unsupportedMaterialClaims = caseResults.reduce((sum, result) => sum + result.unsupportedMaterialClaims, 0);
  const materialClaims = caseResults.reduce((sum, result) => sum + result.materialClaims, 0);
  const safetyErrors = caseResults.flatMap((result) => result.safetyErrors);
  const p95Ms = percentile(caseResults.map((result) => result.elapsedMs), 0.95);
  const maxProviderCalls = Math.max(...caseResults.map((result) => result.providerCalls), 0);
  const summary = {
    id: `project_understanding_eval_${randomUUID()}`,
    generatedAt: new Date().toISOString(),
    gates: {
      overallSuccessAtLeast80: ratio(passed, caseResults.length) >= 0.8,
      everyRepositoryAtLeast70: perRepository.every((repository) => repository.successRate >= 0.7),
      unsupportedMaterialClaimsAtMost5: ratio(unsupportedMaterialClaims, materialClaims) <= 0.05,
      safetyErrorsZero: safetyErrors.length === 0,
      p95AtMost90Seconds: p95Ms <= 90_000,
      maxProviderCallsAtMost12: maxProviderCalls <= 12
    },
    passed,
    total: caseResults.length,
    successRate: ratio(passed, caseResults.length),
    unsupportedMaterialClaimRate: ratio(unsupportedMaterialClaims, materialClaims),
    safetyErrorCount: safetyErrors.length,
    p95Ms,
    maxProviderCalls,
    perRepository,
    caseResults
  };
  const outputWorkspace = input.outputWorkspace
    ? path.resolve(input.outputWorkspace)
    : path.resolve(path.dirname(input.corpusPath), corpus.repositories[0]!.path);
  const memory = await ensureMemoryLayout(outputWorkspace);
  await writeJson(path.join(memory.evalsDir, summary.id, "summary.json"), summary);
  return summary;
}

export function validateCorpus(corpus: ProjectUnderstandingBenchmarkCorpus, minimumCases = 120, minimumRepositories = 5) {
  if (corpus.repositories.length < minimumRepositories) throw new Error(`project_understanding_eval requires at least ${minimumRepositories} repositories.`);
  const cases = corpus.repositories.flatMap((repository) => repository.cases);
  if (cases.length < minimumCases) throw new Error(`project_understanding_eval requires at least ${minimumCases} cases.`);
  const arabic = cases.filter((entry) => entry.language === "arabic").length;
  if (arabic / cases.length < 0.25) throw new Error("project_understanding_eval requires at least 25% Arabic cases.");
  const ids = cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error("project_understanding_eval case ids must be unique.");
  if (cases.some((entry) => !Array.isArray(entry.expectedRelationships))) {
    throw new Error("project_understanding_eval cases must declare expectedRelationships.");
  }
}

function matchesRelationship(
  traces: string[],
  expected: ProjectUnderstandingBenchmarkCase["expectedRelationships"][number]
) {
  return traces.some((trace) => {
    const normalized = normalize(trace);
    return normalized.includes(`-[${expected.kind}]->`)
      && (!expected.fromContains || normalized.includes(normalize(expected.fromContains)))
      && (!expected.toContains || normalized.includes(normalize(expected.toContains)));
  });
}

function percentile(values: number[], value: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : 0;
}

function normalize(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
