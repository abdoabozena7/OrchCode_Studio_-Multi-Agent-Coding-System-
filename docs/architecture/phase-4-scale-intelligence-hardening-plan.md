# Phase 4 Scale, Intelligence, And Hardening Plan

## Current Phase 3 Architecture Summary

OrchCode now has a file-backed project memory layer, repository indexing, command inventory, an orchestration task graph, role registry, context packs, structured output validators, patch safety checks, file locks, review loops, validation runner, repair task creation, and run artifacts under `.agent_memory/runs/<run_id>/`.

The current vertical slice is intentionally conservative. `CoreOrchestrator` rebuilds repository memory, creates a Scout/Planner/Executor/Reporter task graph, invokes deterministic read-only roles, routes ExecutorAgent through the existing `SeniorCodingAgent` path, records artifacts, runs safety and validation gates, and writes a final report.

## Scaling Gaps

- Repository memory is rebuilt as a full scan; the system does not yet warn clearly when an existing index is stale.
- Context packs use simple file ranking and snippets, which is safe but not rich enough for very large repositories.
- Command inventory is useful but not yet mapped to repository areas.
- Parallel execution defaults to one task and file locks are in-memory leases, not durable distributed locks.
- Artifact inspection exists, but operators still need better run reports, metrics, campaign state, and eval output.

## Memory Gaps

- Runs, decisions, and task history are durable, but repeated failures, lessons learned, successful patterns, glossary terms, and architecture notes need first-class files.
- Existing JSONL append behavior should be append-only instead of rewriting full files.
- Memory compaction should summarize useful signals from prior runs without requiring expensive LLM calls.
- Index state should record enough data to detect changed, new, and deleted files before reusing context.

## Campaign And Resume Design

Campaigns are larger than runs. A campaign stores the original goal, milestones, associated runs, risks, decisions, memory references, pause/resume status, metrics, and final report.

Phase 4 will implement operator-invoked campaign commands:

- create a campaign from a large goal
- plan heuristic milestones
- run the next milestone as a normal safety-gated orchestration run
- pause and resume campaign execution
- report campaign progress and metrics

Runs will gain practical checkpointing under `.agent_memory/runs/<run_id>/checkpoints/`. A checkpoint captures the run, task graph, memory reference, config, index freshness, and timestamp. Resume support will reload terminal runs safely, skip completed work in reports, and mark ambiguous in-flight work as requiring reconciliation rather than pretending perfect background recovery exists.

## Metrics And Evals Design

Each run and campaign should produce metrics that prove the architecture is doing real work:

- task counts and failures
- repair attempts
- validation pass/fail/blocked counts
- changed files
- review findings
- context size
- invalid structured outputs
- repeated failure fingerprints
- stale index warnings
- approval gates

Phase 4 will add a lightweight eval harness using temporary fixture repositories. Evals will cover indexing, planning, context bounds, patch safety, validation/repair signals, stale index detection, campaign pause/resume, memory learning, mode behavior, and final report content.

## Developer Experience Improvements

The CLI should let an operator:

- index, refresh, inspect, and explain repository memory
- compact memory and inspect decisions, lessons, and failed attempts
- run, plan, resume, and inspect agentic runs
- inspect reports, metrics, artifacts, events, validation logs, and patch history
- create, plan, run-next, pause, resume, inspect, and report campaigns
- run Phase 4 evals

Commands will stay project-native through the existing npm scripts and TypeScript CLIs.

## Final Hardening Plan

Phase 4 will add:

- index freshness and project intelligence artifacts
- campaign manager and campaign CLI
- practical run checkpoints and resume inspection
- mode-based config for `fast`, `deep`, and `exhaustive`
- approval gate assessment for risky edits
- run and campaign metrics
- memory compaction and learning files
- eval suite and tests
- docs and durable AGENTS.md updates

Known hardening items that remain visible but outside this slice:

- runtime HTTP auth/CORS hardening
- Rust-side patch authority enforcement parity with Node orchestration scope checks
- durable cross-process locks
- true incremental index updates instead of full refresh with changed-file reporting
- real provider-backed multi-agent parallel execution

## Validation Plan

Validation will include:

- existing agent-runtime tests
- new Phase 4 tests
- Phase 4 eval suite
- TypeScript typecheck/build
- repository index rebuild
- small campaign create/plan/run-next/report flow
- artifact inspection for checkpoints, metrics, reports, and stale-index status
