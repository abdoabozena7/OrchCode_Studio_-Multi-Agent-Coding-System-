import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderAuthoredResult, ReasoningTurnTrace } from "@hivo/protocol";
import type { AdaptiveReasoningBenchmarkCorpus } from "../evals/adaptiveReasoningCertification.js";
import { scoreAdaptiveReasoningCase, validateAdaptiveReasoningCorpus } from "../evals/adaptiveReasoningCertification.js";
import { registerReasoningCertification, resolveModelCertification } from "../evals/ReasoningCertificationRegistry.js";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";

test("adaptive reasoning certification accepts only a sufficiently broad versioned corpus", () => {
  const corpus = validCorpus();
  assert.doesNotThrow(() => validateAdaptiveReasoningCorpus(corpus));
  assert.throws(
    () => validateAdaptiveReasoningCorpus({ ...corpus, repositories: corpus.repositories.slice(0, 7) }),
    /at least 8 repositories/
  );
  assert.throws(
    () => validateAdaptiveReasoningCorpus({
      ...corpus,
      repositories: corpus.repositories.map((repository) => ({
        ...repository,
        cases: repository.cases.map((benchmarkCase) => ({ ...benchmarkCase, language: "english" as const }))
      }))
    }),
    /25% Arabic/
  );
});

test("a forged certification record without a passing holdout report is rejected", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-forged-certification-"));
  try {
    await assert.rejects(
      registerReasoningCertification(workspace, {
        providerType: "ollama",
        routerModel: "author",
        authorModel: "author",
        verifierModel: "verifier",
        capabilities: {
          readReasoning: true,
          actionReasoning: false,
          readonlySwarm: true,
          embeddings: false
        },
        gate: "read_reasoning",
        corpusHash: "forged",
        reportPath: path.join(workspace, "forged.json"),
        certifiedAt: new Date().toISOString()
      }),
      /certification_record_invalid/
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("certification registry matches the exact router author verifier and embedding profile", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-exact-profile-certification-"));
  try {
    const memory = await ensureMemoryLayout(workspace);
    const reportPath = path.join(memory.evalsDir, "exact-profile", "summary.json");
    const profile = {
      providerType: "ollama" as const,
      routerModel: "router",
      authorModel: "author",
      verifierModel: "verifier",
      embeddingModel: "embedding",
      capabilities: {
        readReasoning: true,
        actionReasoning: false,
        readonlySwarm: true,
        embeddings: true
      }
    };
    await writeJson(reportPath, {
      certified: true,
      split: "holdout",
      gate: "read_reasoning",
      corpusHash: "exact-profile-corpus",
      modelProfile: profile,
      gates: { allRequiredGatesPassed: true }
    });
    await registerReasoningCertification(workspace, {
      ...profile,
      gate: "read_reasoning",
      corpusHash: "exact-profile-corpus",
      reportPath,
      certifiedAt: new Date().toISOString()
    });

    assert.equal(resolveModelCertification(workspace, {
      providerType: "ollama",
      providerName: "ollama",
      baseUrl: "http://localhost",
      selectedModel: "author",
      routerModel: "router",
      verifierModel: "verifier",
      embeddingModel: "embedding",
      isValid: true
    }).status, "certified");
    assert.equal(resolveModelCertification(workspace, {
      providerType: "ollama",
      providerName: "ollama",
      baseUrl: "http://localhost",
      selectedModel: "author",
      routerModel: "different-router",
      verifierModel: "verifier",
      embeddingModel: "embedding",
      isValid: true
    }).status, "uncertified");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("certification scores expected evidence by cited path rather than random evidence id", () => {
  const benchmarkCase = {
    ...validCorpus().repositories[0]!.cases[10]!,
    answerable: true,
    expectedEvidence: ["src/flow.ts"]
  };
  const result: ProviderAuthoredResult = {
    decision: "ANSWER",
    answerMarkdown: "The flow is implemented.",
    claims: [{ id: "claim", text: "The flow is implemented.", material: true, evidenceIds: ["evidence_random"], confidence: "high" }],
    evidenceRefs: ["evidence_random"],
    unknowns: [],
    rationale: "Grounded."
  };
  const trace = {
    evidenceRefs: [{
      id: "evidence_random",
      sourceType: "workspace_file",
      summary: "Flow source",
      path: "src/flow.ts",
      startLine: 1,
      endLine: 2,
      contentHash: "hash",
      excerpt: "flow",
      createdAt: new Date().toISOString()
    }]
  } as unknown as ReasoningTurnTrace;
  const judge = {
    correct: true,
    evidenceSupported: true,
    safe: true,
    correctRefusal: false,
    unsupportedMaterialClaims: [],
    safetyErrors: [],
    rationale: "Correct and supported."
  };

  const scored = scoreAdaptiveReasoningCase("repo", benchmarkCase, result, trace, judge, ["provider_request"], 10);
  assert.equal(scored.passed, true);
  const missing = scoreAdaptiveReasoningCase("repo", { ...benchmarkCase, expectedEvidence: ["src/missing.ts"] }, result, trace, judge, ["provider_request"], 10);
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.some((failure) => failure.startsWith("missing_expected_evidence:")));
});

function validCorpus(): AdaptiveReasoningBenchmarkCorpus {
  return {
    version: "holdout-v1",
    gate: "read_reasoning",
    split: "holdout",
    sealed: true,
    repositories: Array.from({ length: 8 }, (_, repositoryIndex) => ({
      id: `repo_${repositoryIndex}`,
      path: `repo_${repositoryIndex}`,
      commit: "0123456789abcdef",
      cases: Array.from({ length: 30 }, (_, caseIndex) => ({
        id: `repo_${repositoryIndex}_case_${caseIndex}`,
        language: caseIndex < 8 ? "arabic" : "english",
        question: `Question ${caseIndex}`,
        answerable: caseIndex >= 5,
        categories: [
          ...(caseIndex < 8 ? ["cross_file" as const] : []),
          ...(caseIndex < 6 ? ["keyword_adversarial" as const] : []),
          ...(caseIndex < 5 ? ["unanswerable" as const] : ["ordinary" as const])
        ],
        referenceAnswer: caseIndex < 5 ? "The repository does not contain enough evidence to answer." : "Reference answer.",
        gradingCriteria: ["Judge semantic correctness rather than keyword overlap."],
        expectedEvidence: []
      }))
    }))
  };
}
