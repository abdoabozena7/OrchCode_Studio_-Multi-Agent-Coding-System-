# Phase 3 Swarm Verification And Safety Plan

## Current Phase 2 Architecture Summary

Phase 1 added file-backed project memory under `.agent_memory/`, repository indexing, command inventory detection, and architecture documentation. Phase 2 added a deterministic orchestration vertical slice in `apps/agent-runtime/src/orchestration/`:

- `CoreOrchestrator` creates a run, rebuilds or loads the repository index, creates a task graph, builds context packs, invokes roles, and writes final reports.
- `TaskGraphManager` owns durable task lifecycle transitions and persists `tasks.json` plus task history.
- `ContextPackBuilder` narrows repository context using Phase 1 memory.
- `RoleRegistry` defines the agent roles needed by the future swarm.
- `ArtifactStore` writes run metadata, task artifacts, context packs, invocations, parsed outputs, raw outputs, patches, and reports.
- `ExecutorAgent` currently routes through the existing `SeniorCodingAgent` path in mock provider mode, preserving the original simple coding-agent behavior.

The system can create auditable runs, but Phase 2 still trusts parsed role output too much. Review, validation, patch safety, locks, and retry behavior are mostly advisory.

## Safety Gaps

- Executor output is summarized after the fact, but there is no role-specific structured output validator for every machine-consumed result.
- Patch proposals are captured by the existing runtime path, but Phase 2 does not compute a canonical patch manifest or fingerprint for safety gates.
- Scope checks catch some files outside `allowed_files_to_edit`, but the safety result is not persisted as a first-class artifact.
- Direct workspace editing is blocked in Node tools, while `.agent_memory` writes are broad by design. Runtime artifacts need to be treated as a separate authority from source edits.
- Path containment helpers use prefix checks in a few places; Phase 3 should harden them with relative containment checks.
- There is no orchestrator-level rollback/restore wrapper for direct file changes if a future executor path edits files.

## Verification Gaps

- Phase 1 command inventory preserves full command records, including `cwd`, but Phase 2 often stores only command strings.
- `TesterAgent` exists in the role registry but is not wired into the run.
- Phase 2 marks validation commands as `not_run`; no durable validation logs are written.
- Rust remains the preferred command execution authority in the desktop app. The CLI needs a conservative local runner for the Phase 3 vertical slice until a shared Rust execution bridge is available.
- Dev/server, install, network, background, and destructive commands must remain blocked from automatic validation.

## Proposed Review Loop

After each `ExecutorAgent` invocation:

1. Validate structured executor output. Invalid output is stored, repaired once or within configured limits, and rejected if it still fails validation.
2. Build a patch proposal from the output or captured runtime session. Compute changed files, operation hints, and a patch fingerprint.
3. Run scope review:
   - changed files must be inside `allowed_files_to_edit` unless the task is read-only and produced no changes;
   - `forbidden_files` must not be touched;
   - patch size and file count must be within configured limits.
4. Run heuristic code review for maintainability, style consistency, and suspicious changes.
5. Run validation selection and safe command execution.
6. Consolidate review and validation into a decision:
   - `accept`
   - `request_repair`
   - `reject`
   - `split_task`
   - `require_human_approval`
7. Persist review, validation, integration, and patch artifacts before the task can succeed.

Multi-perspective review is enabled by configuration and used for non-trivial or risky changes. The initial perspectives are security, performance, maintainability, and test coverage.

## Proposed Retry And Repair Loop

- Each task is bounded by `max_attempts_per_task`.
- Review or validation failures create a child repair task when the failure is scoped and repair rounds remain.
- Repair tasks include the original objective, failure details, validation logs, and the previous patch fingerprint.
- Repeated identical patch fingerprints are rejected to avoid loops.
- After `max_repair_rounds`, the task fails with a clear artifact trail.

## File Locking Design

- Read-only tasks do not need exclusive locks.
- Write tasks lock `allowed_files_to_edit`.
- A write task with no allowed edit scope receives a workspace-level write lock and runs serially.
- Lock paths are normalized relative to the workspace.
- Directory locks conflict with nested file locks.
- Lock records include path, run id, owner task id, acquired time, heartbeat time, and expiry.
- Locks are released in `finally` blocks and stale lock recovery is conservative.

Phase 3 keeps `max_parallel_tasks = 1` by default, but adds a scheduler abstraction and tests proving that disjoint edit scopes can be scheduled safely.

## Parallel Execution Constraints

Parallel execution may only schedule tasks that:

- have satisfied dependencies;
- do not overlap with active or batch-local edit locks;
- fit within `max_parallel_tasks`;
- do not require unsafe global validation while another write task is running.

The default remains sequential until a later phase wires real concurrent agent execution into the durable orchestration path.

## Artifact Layout Additions

Phase 3 keeps the Phase 2 layout and adds:

```text
.agent_memory/runs/<run_id>/
  patches/
  reviews/
  validation/
  integration/
  repairs/
  locks/
```

Events in `events.jsonl` record run, task, lock, agent, output validation, patch, review, validation, repair, integration, and completion milestones.

## Validation Plan

- Unit tests for structured output validation and repair.
- Unit tests for scope violations, forbidden file rejection, patch fingerprinting, and restore behavior.
- Unit tests for file lock acquisition, release, stale recovery, overlapping locks, and disjoint scheduling.
- Unit tests for review consolidation and repair task creation limits.
- Unit tests for validation runner command selection, safe-command filtering, log persistence, and failure summaries.
- Existing agent-runtime tests must still pass.
- Run `npm run test -w @orchcode/agent-runtime`.
- Run root `npm run typecheck` and `npm run build`.
- Run `cargo check`.
- Rebuild repository memory with `npm run memory:index -- --json`.
- Run one small harmless orchestrated task and inspect events, review artifacts, validation logs, and the final report.

## Known Limitations

- Phase 3 does not make this a full swarm. Parallel execution remains conservatively disabled by default.
- The CLI validation runner uses a local bounded process runner for safe commands; desktop/Rust command authority should become the shared execution backend in a later phase.
- Heuristic review is intentionally conservative and should later be backed by role-specific reviewer invocations.
- Rust patch application should eventually enforce the same task scope metadata immediately before `git apply`.
- Patch parsing starts with unified diff and file manifest heuristics. It should later reject binary, symlink, mode-change, rename, and copy operations unless explicitly approved.
