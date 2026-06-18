# Adaptive Reasoning Certification

Hivo does not claim an 80% reasoning guarantee from unit tests or prompt inspection. Certification is issued only for an exact provider, router model, author model, verifier model, optional embedding model, corpus hash, and gate.

## Gates

- `read_reasoning`: novel project questions, including Arabic, cross-file, paraphrased, keyword-adversarial, and unanswerable questions.
- `action_reasoning`: planning, approval-gated patches, run-to-green, and swarm actions.

Read holdouts require at least 240 human-reviewed cases across eight pinned Git repositories. Action holdouts require at least 120 cases across eight pinned repositories. Holdouts must be marked `sealed: true`; tuning corpora must be marked `sealed: false`.

Each case must include a human reference answer, semantic grading criteria, and expected evidence paths. The independent verifier judges meaning and evidence relevance. Keyword overlap alone cannot pass a case.

## Corpus Shape

```json
{
  "version": "read-holdout-v1",
  "gate": "read_reasoning",
  "split": "holdout",
  "sealed": true,
  "repositories": [
    {
      "id": "hivo",
      "path": "../../",
      "commit": "<full-git-commit>",
      "cases": [
        {
          "id": "hivo-cross-file-001",
          "language": "english",
          "question": "A novel project-specific question",
          "answerable": true,
          "categories": ["cross_file", "keyword_adversarial"],
          "referenceAnswer": "Human-reviewed semantic reference answer.",
          "gradingCriteria": ["Must explain the verified cross-file relationship."],
          "expectedEvidence": ["apps/agent-runtime/src/runtime/ReasoningKernel.ts"]
        }
      ]
    }
  ]
}
```

Repository paths are resolved relative to the corpus file. Validation fails unless every repository exists and its current `HEAD` exactly matches the pinned commit.

## Commands

Validate corpus shape and repository pins without calling a provider:

```powershell
npm run eval:adaptive-reasoning -- --corpus <corpus.json> --validate-only
```

Run certification with the first target matrix:

```powershell
$env:OLLAMA_AUTHOR_MODEL="qwen2.5-coder:7b"
$env:OLLAMA_ROUTER_MODEL="qwen2.5-coder:7b"
$env:OLLAMA_VERIFIER_MODEL="gpt-oss:120b-cloud"
$env:OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
npm run eval:adaptive-reasoning -- --corpus <sealed-holdout.json> --runs 3
```

Certification requires an average success rate of at least 80%, every run at least 75%, every repository at least 70%, unsupported material claims below 5%, zero safety errors, complete provider provenance, and deep-question p95 at most 180 seconds.

Passing `read_reasoning` certification never enables the action lane. The exact profile must separately pass `action_reasoning`. Registry v2 refuses a different router, author, verifier, or embedding model even when another profile from the same provider passed.

Reports include p95 latency by reasoning stage and a failure taxonomy. The runtime records `route`, `audit`, `investigate`, `reason`, `curate`, `compose`, `verify`, and `repair` budgets independently so a slow stage cannot silently consume the entire turn.

Unit tests and one-off real-provider smoke runs are diagnostics only. A smoke timeout, malformed structured result, stagnant tool loop, stale index, or unsupported claim must remain a failed case with its partial reasoning trace; none can be converted into a local answer or counted as certification success.
