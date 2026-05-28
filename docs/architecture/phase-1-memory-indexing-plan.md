# Phase 1 Memory And Indexing Plan

## Current Architecture Summary

Hivo Studio is a Windows-first Tauri desktop application with a React/Vite frontend, a Rust backend/core, a shared TypeScript protocol package, and a TypeScript agent runtime service.

- `apps/desktop` contains the operator console UI and Tauri bridge.
- `apps/desktop/src-tauri` owns workspace access, terminal authority, command policy, patch application, git state, SQLite persistence, and a shallow `ProjectIndexService`.
- `apps/agent-runtime` owns runtime sessions, LLM providers, tool requests, orchestration objects, project intake, context building, patch proposals, and SSE/HTTP endpoints.
- `packages/protocol` owns shared TypeScript contracts.

The existing agent runtime already performs temporary read-only workspace scans through `WorkspaceTools`, `ProjectIntake`, and `LargeProjectContextBuilder`, but those results are not written as durable repository memory. Runtime sessions persist separately under `.hivo-agent-runtime`.

## What Will Be Added

Phase 1 adds a file-backed project memory layer that can be rebuilt on demand:

- Persistent memory directory at `.agent_memory/`.
- Repository index generation for file metadata, source/test/config/doc categorization, entrypoint guesses, symbol hints, import/export hints, and command inventory.
- Heuristic file summaries stored as JSONL without requiring LLM calls.
- Decision and task-history append APIs for future orchestrators.
- CLI commands for rebuilding and inspecting memory.
- Tests covering ignore rules, classification, command detection, read/write behavior, and repeatable rebuilds.
- Architecture docs explaining how memory and indexing prepare the project for reliable small-agent orchestration.

## Where It Will Be Added

- `apps/agent-runtime/src/memory/`
  - TypeScript memory service, repository indexer, command inventory detector, file summary helpers, and CLI entrypoint.
- `apps/agent-runtime/src/tests/`
  - Node test coverage for the new memory/indexing foundation.
- Root `package.json` and `apps/agent-runtime/package.json`
  - Small CLI script aliases for index/status/inspect/commands/clean-runs.
- `.agent_memory/`
  - Committed README and schema marker only.
  - Generated index artifacts remain local and ignored where appropriate.
- `AGENTS.md`
  - Persistent operating guidance for future coding-agent work.
- `docs/architecture/memory-and-indexing.md`
- `docs/architecture/agentic-coding-factory.md`

## How Current Behavior Is Preserved

- The existing HTTP runtime and desktop app entrypoints are not replaced.
- Existing session persistence under `.hivo-agent-runtime` remains unchanged.
- Existing workspace tools remain read-only and continue to use their current guards.
- The new memory layer is invoked through explicit service calls or CLI commands; it does not automatically alter runtime turn behavior in Phase 1.
- The implementation avoids new heavy dependencies and uses Node/TypeScript standard library APIs.

## Validation Strategy

- Run the new memory tests through the existing `@hivo/agent-runtime` test command.
- Run TypeScript build/typecheck paths already defined by package scripts.
- Run the new repository index command against this repository.
- Inspect generated `.agent_memory` files for expected layout, ignored directories, command inventory, and index summaries.
- Verify existing runtime behavior is still covered by the current test suite.

## Known Limitations

- Symbol extraction is heuristic in Phase 1 and intentionally conservative.
- File summaries are metadata-based and do not call LLMs.
- The memory layer is not yet wired into context-pack generation for runtime turns.
- Command detection is best-effort from manifests, common build files, and CI files.
- Generated memory is local project state; large or volatile run artifacts should not be committed.
