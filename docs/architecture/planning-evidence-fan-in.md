# Planning Evidence Fan-In

The MultiPlanFactory can optionally consume read-only evidence from swarm workers before generating plan variants. Evidence is advisory only. It never authorizes writes, executor work, shell commands, patches, or validation success.

## Sources

The first implementation collects from `factory_worker_invocations` metadata and follows artifact refs to schema-validated parsed provider outputs. Supported source labels include provider scout, planner, risk analyst, reviewer, specialist, tester planner, reporter, mock worker, deterministic context, repo index, context pack, validation history, prior failure, and prior decision evidence.

Invalid schema output, missing parsed artifacts, disabled mock evidence, duplicate items, and items below the configured confidence floor are rejected and traced.

## Artifacts

Evidence artifacts live under the existing run layout:

```text
.agent_memory/runs/<run_id>/planning_evidence/
  evidence_bundle_<id>.json
  evidence_summary_<id>.md
```

The bundle stores extracted summaries and refs to worker artifacts. It does not duplicate raw provider output bodies, and SQLite stores refs/metadata only.

## Planning Influence

Evidence can influence deterministic plan generation:

- scout output informs high-signal files and MVP/speed scope.
- risk analyst, reviewer, and specialist output inform risk-first planning and safety scoring.
- tester planner output informs validation strategy and testability scoring.
- architect/planner/specialist output informs module boundary and integration concerns.

If evidence is missing or disabled, the existing deterministic/heuristic behavior remains the fallback and the evidence limitations are recorded.

## Evaluation And Merge

PlanEvaluator adjusts deterministic scores using evidence:

- plans that ignore high-risk evidence lose safety and integration-risk score.
- plans carrying tester evidence gain testability.
- plans matching scout evidence gain confidence.
- evidence conflicts become contradiction warnings.

PlanMerger preserves evidence refs, conflicts, limitations, and influence notes in the merged plan so later reports or planning stages can audit why a decision was made.

## Config

Planning evidence is controlled by:

- `use_planning_evidence`
- `planning_evidence_mode`: `off`, `available`, or `require_for_provider_mode`
- `max_evidence_items`
- `min_evidence_confidence`
- `allow_mock_evidence`

Defaults keep evidence optional and deterministic fallback available.
