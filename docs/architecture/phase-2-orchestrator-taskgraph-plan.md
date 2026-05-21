# Phase 2 Orchestrator Task Graph Plan

## Current Phase 1 Summary

Phase 1 introduced durable local repository memory under `.agent_memory/` and TypeScript memory services in `apps/agent-runtime/src/memory`. The system can now rebuild and inspect:

- `repo_index.json`
- `file_manifest.json`
- `symbol_index.json`
- `file_summaries.jsonl`
- `command_inventory.json`
- `decisions.jsonl`
- `task_history.jsonl`
- `runs/`

The existing runtime still owns the simple coding-agent path through `AgentRuntime`, `SeniorCodingAgent`, `RunEngine`, guarded tools, provider abstractions, patch proposals, and command requests.

## New Orchestration Components

Phase 2 adds a separate orchestration foundation under `apps/agent-runtime/src/orchestration`:

- Strict Phase 2 data models and validators.
- Role registry for Scout, Architect, Planner, Executor, Reviewer, Tester, Integrator, and Reporter roles.
- Artifact store for `.agent_memory/runs/<run_id>/`.
- Task graph manager with auditable status transitions.
- Context pack builder backed by Phase 1 memory and snippets.
- Deterministic planner for an initial task graph.
- Orchestrator state machine for one vertical slice.
- CLI surface for planning, running, listing, showing runs, inspecting tasks, and showing context packs.

## Integration With Existing Coding Agent

The Phase 2 `ExecutorAgent` does not write files directly. For the vertical slice it creates an isolated runtime session with:

- `MockLlmProvider`
- `EventBus`
- `SessionManager`
- `SeniorCodingAgent`

The Executor invokes `SeniorCodingAgent.runTurn()` with a narrow task prompt generated from a Phase 2 `ContextPack`. The existing path can inspect the workspace and propose patches or command requests while preserving current patch/command authority behavior.

## Task Lifecycle

Tasks use this lifecycle:

```text
pending -> ready -> running -> succeeded
pending -> blocked
ready -> blocked
running -> failed
running -> blocked
blocked -> ready
```

Final task states are `succeeded`, `failed`, `skipped`, and `cancelled`. Every transition is appended to `events.jsonl` and persisted through `tasks.json`. Task history is also appended to Phase 1 memory.

## Artifact Layout

Each orchestration run writes:

```text
.agent_memory/runs/<run_id>/
  run.json
  tasks.json
  events.jsonl
  context_packs/
  invocations/
  raw_outputs/
  parsed_outputs/
  reports/
  patches/
```

Artifacts include run metadata, task graph state, context packs, prompts, raw/parsed outputs, errors, and final reports.

## Validation Plan

- Unit tests for Run, Task, AgentRole, AgentInvocation, ContextPack, and FinalRunReport validation.
- Task graph status transition tests.
- Role registry coverage for all required roles.
- Context pack builder tests with a fake indexed repository.
- Orchestrator tests that create a run, tasks, context pack, invocation artifacts, and final report.
- Existing simple coding-agent path test remains green.
- Run existing agent-runtime tests, root typecheck/build, repo indexing, and a small harmless orchestrator CLI run.
