# Architecture Map

## High-Level Packages
- `apps/agent-runtime`: Node/Fastify runtime, session manager, RunEngine, inspect/explain analyzers, provider adapters, memory CLI, orchestration/swarm CLI.
- `apps/desktop`: React/Vite desktop UI. The captured web DOM renders startup controls, but native Tauri behavior was not automated.
- `apps/desktop/src-tauri`: Rust authority for workspace selection, command execution, patch apply, provider validation, SQLite state.
- `packages/protocol`: shared TypeScript models for runtime sessions, approvals, provider config, commands, patches.
- `docs`: architecture/phase/operator documentation. Treated as claims, not truth.
- `scripts`: launch/smoke helpers.
- `.agent_memory`: committed/local memory, repo index, command inventory, swarm trials/runs.
- `.orchcode-agent-runtime`: Node runtime snapshot store; current root sessions.json is empty, but apps/agent-runtime/.orchcode-agent-runtime/sessions.json is 68 MB.
- `C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite`: desktop SQLite state, 839 MB, 95 sessions, 6274 session_events.

## Runtime Responsibility Map
- Planning: `RunEngine` for normal desktop sessions; `CoreOrchestrator` and `SwarmAutopilotRuntime` for CLI/orchestrated paths.
- Inspect/explain: `RunEngine.runInspectExplainTurn` -> `UniversalProjectQuestionEngine` -> read lanes/facts/evidence -> `LlmProjectExplainer`/fallback.
- Run-to-green: deterministic `RunEngine` path; startup command inference bypasses brittle provider planning.
- Command requests: runtime creates command requests; frontend/Rust executes and reports back.
- Patch proposals: provider/runtime proposes; frontend approves/applies; Rust applies; frontend reports result back.
- Session manager: `SessionManager` stores snapshots and tokens in `sessions.json`.
- Event log/replay: Rust SQLite `runtime_events`; runtime can replay via `DurableRuntimeEvents` but still falls back to snapshots.
- Swarm runtime: `SwarmAutopilotRuntime`, `SwarmStaffingPlanner`, `SwarmScheduler`, `SwarmArtifactStore`.
- Memory/indexing: `RepoIndexer`, `CommandInventory`, memory CLIs.

## Desktop Responsibility Map
- UI state: `apps/desktop/src/app/App.tsx` owns workspace, runtime session, provider config, access profile, panels.
- SSE subscription: `subscribeRuntimeEvents` in `lib/agentRuntime.ts`; `App.tsx` mirrors events into Rust SQLite.
- Command approval/execution: frontend effect can auto-run via `terminalOrchestrator.ts`; Rust `execute_approved_command` is authority.
- Patch bridge: frontend calls Rust `apply_runtime_patch`, then reports result to runtime.
- Workspace selection: Rust commands canonicalize/guard workspace; frontend caches recent workspaces in localStorage.
- LocalStorage: recent sessions/tokens/workspaces/sidebar/RTL/full-access banner.
- Tauri calls: `lib/tauri.ts` wraps invoke commands.

## Rust/Tauri Responsibility Map
- Command execution: `commands/terminal.rs`, `services/terminal.rs`.
- Command policy: `services/command_policy.rs`.
- Patch apply: `commands/patch.rs` and patch services.
- Git snapshots: patch apply captures snapshots/reconciliation evidence when possible.
- DB persistence/projections: `db/mod.rs` tables for sessions/events/commands/artifacts/provider config.
- Workspace guards: terminal service canonicalizes cwd/workspace and rejects cwd outside workspace.

## Suspicious Parallel Implementations
- Command policy exists in both `apps/agent-runtime/src/tools/CommandPolicy.ts` and Rust `services/command_policy.rs`.
- File lock managers exist in `src/orchestration/FileLockManager.ts` and `src/scheduler/FileLockManager.ts`.
- Session truth is split across Node `sessions.json`, Rust SQLite `session_events/runtime_events`, and frontend localStorage.
- Provider config shape differs at the edge: protocol uses `providerType`; an audit using `type` failed with "Unsupported provider type: undefined", showing the path is brittle outside the UI wrapper.
