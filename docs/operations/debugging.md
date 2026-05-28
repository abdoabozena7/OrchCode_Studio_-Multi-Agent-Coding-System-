# Debugging Hivo Runs

## Artifact Locations

- Run state: `.agent_memory/runs/<run_id>/run.json`
- Task graph: `.agent_memory/runs/<run_id>/tasks.json`
- Events: `.agent_memory/runs/<run_id>/events.jsonl`
- Checkpoints: `.agent_memory/runs/<run_id>/checkpoints/`
- Context packs: `.agent_memory/runs/<run_id>/context_packs/`
- Patch safety: `.agent_memory/runs/<run_id>/patches/`
- Reviews and approval gates: `.agent_memory/runs/<run_id>/reviews/`
- Validation logs: `.agent_memory/runs/<run_id>/validation/`
- Metrics: `.agent_memory/runs/<run_id>/metrics/run_metrics.json`
- Final report: `.agent_memory/runs/<run_id>/reports/final_report.json`

## Inspect Failed Tasks

```bash
npm run agentic:show-run -- <run_id>
npm run agentic:inspect-task -- --run <run_id> <task_id>
npm run agentic:show-task-artifacts -- --run <run_id> <task_id>
```

## Inspect Validation

```bash
npm run agentic:show-validation-logs -- <run_id>
npm run agentic:show-run-events -- <run_id>
```

Validation commands can be blocked by safety policy. Blocked commands should be treated as unverified work that needs operator attention.

## Refresh Stale Indexes

```bash
npm run memory:index-status
npm run memory:index-refresh
npm run memory:index-explain -- apps/agent-runtime/src/orchestration/Orchestrator.ts
```

`-- --changed-only` reports changed files before the safe full refresh:

```bash
npm run memory:index-refresh -- --changed-only
```

## Resume Run Inspection

```bash
npm run agentic:resume-run -- <run_id>
```

Terminal runs are safe no-ops. Non-terminal runs write a checkpoint and require operator reconciliation before continuing ambiguous in-flight work.

## Clean Volatile Artifacts

```bash
npm run memory:clean-runs -- --older-than-days 14
```

Do not delete artifacts needed for an active campaign or unresolved review.
