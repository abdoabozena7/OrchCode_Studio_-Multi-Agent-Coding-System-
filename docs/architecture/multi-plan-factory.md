# Multi-Plan Factory

The multi-plan factory is a read-only planning layer in the factory orchestration path. It improves planning quality for medium and larger tasks by generating several deterministic or heuristic planning variants, evaluating them, and writing one merged advisory plan before task graph finalization.

The factory currently implements five perspectives:

- `mvp_first`: smallest useful scope and shortest path to user value.
- `architecture_first`: module boundaries, public contracts, extensibility, and integration risk.
- `risk_first`: safety, validation gaps, blockers, rollback path, and approval needs.
- `test_first`: validation strategy, smoke checks, and proof of success.
- `speed_first`: fastest safe path using existing components and minimal touched surface.

This layer does not create patches, edit source files, run provider-backed swarm workers, or authorize new executor behavior. Merged plans are advisory context for existing planning and future task graph expansion. Existing single-plan task graph behavior remains the compatibility fallback, and small or tiny tasks can skip multi-plan generation.

Artifacts are stored under the existing run layout:

```text
.agent_memory/runs/<run_id>/plans/
  plan_variant_<perspective>_<plan_id>.json
  plan_evaluation_<id>.json
  merged_plan_<id>.json
  planning_summary_<id>.md
```

SQLite stores metadata only in `factory_plan_variants`, `factory_plan_evaluations`, and `factory_merged_plans`. Full plan text stays in file artifacts so run evidence remains auditable and diffable.

Trace events cover the planning chain:

- `multi_plan_started`
- `plan_variant_created`
- `plan_variant_evaluated`
- `plan_variant_selected`
- `plan_variant_rejected`
- `plan_merge_started`
- `plan_merge_completed`
- `merged_plan_artifact_written`
- `multi_plan_skipped`

