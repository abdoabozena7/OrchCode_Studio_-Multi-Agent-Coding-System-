import assert from "node:assert/strict";
import test from "node:test";
import { validateCorpus } from "../evals/projectUnderstanding.js";

test("project-understanding corpus gate requires 120 cases, five repositories, and 25% Arabic", () => {
  const repositories = Array.from({ length: 5 }, (_, repositoryIndex) => ({
    id: `repo_${repositoryIndex}`,
    path: ".",
    cases: Array.from({ length: 24 }, (_, caseIndex) => ({
      id: `case_${repositoryIndex}_${caseIndex}`,
      language: caseIndex < 6 ? "arabic" as const : "english" as const,
      question: "question",
      requiredClaims: [],
      forbiddenClaims: [],
      expectedRelationships: [],
      expectedEvidence: []
    }))
  }));
  assert.doesNotThrow(() => validateCorpus({ repositories }));
  assert.throws(() => validateCorpus({ repositories: repositories.slice(0, 4) }), /at least 5 repositories/);
});
