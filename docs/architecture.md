# Architecture

OrchCode Studio is structured as a Windows-first Tauri 2 desktop application with a React + TypeScript frontend, a Rust backend/core, and a separate TypeScript agent runtime service. The current branch includes a local operator console, durable runtime event foundations, replay-aware restore, patch review/apply flows, and Rust-evidence-backed post-apply reconciliation.

## Desktop Frontend

The frontend lives in `apps/desktop/src` and uses Vite, React, and strict TypeScript. The primary screen is now an operator-console-oriented coding-agent shell:

- Left sidebar: workspace path input, open workspace action, recent projects placeholder, file tree placeholder.
- Main panel: chat-like task panel, guarded mock-plan action, and git diff view.
- Right panel: agent statuses, tasks, session metadata, and git status.
- Bottom panel: terminal command input and collected command output.
- Settings modal: model provider configuration and validation.

Frontend state is still mostly local React state. The frontend imports shared app types from `packages/protocol`, subscribes to runtime SSE events, and calls backend commands through Tauri `invoke`.

## Rust Core

The Rust core lives in `apps/desktop/src-tauri/src` and is split into services:

- `WorkspaceService`: opens a workspace, tracks active project state, lists files, reads files, and guards paths.
- `GitService`: detects git repositories, reads status, reads diffs, and exposes a safety-branch placeholder.
- `CommandPolicyService`: classifies commands as safe, medium, or dangerous.
- `TerminalService`: runs commands allowed by the current heuristic policy classification, blocks dangerous commands, returns `approval_required` for medium or heuristic network/background commands, and records explicit provenance for terminal/background lifecycle state. This is not sandbox-grade containment or a full process supervisor.
- `PatchService`: validates patch paths and applies unified diffs through Rust-owned `git apply`.
- `ProjectIndexService`: scans important files, language counts, package managers, and test command guesses.
- `DatabaseService`: initializes local SQLite state for projects, sessions, tasks, agent runs, tool calls, patches, project memory, and provider config.
- `ModelProviderService`: validates Ollama and OpenAI-compatible provider settings through backend-owned HTTP checks.

Tauri commands in `src-tauri/src/commands` expose typed request/response boundaries to the frontend.

## Future Agent Runtime

Module 2 adds a single-agent runtime as a separate TypeScript service under `apps/agent-runtime`. It exposes HTTP and SSE boundaries that can later become a bundled sidecar process.

Runtime modules:

- `AgentRuntime`: public session/turn/approval facade.
- `SessionManager`: snapshot-based runtime session persistence, token hashing, durable-event-aware restore, and event publication. `load()` now attempts replay from durable `runtime_events` first where enough canonical history exists, then falls back to the current `sessions.json` snapshot when replay is insufficient. Snapshot restore is still not event-replay authoritative.
- `EventBus`: in-process event publication for SSE clients.
- `SeniorCodingAgent`: single agent lifecycle implementation.
- `ToolRegistry`: controlled workspace, git, command-request, and patch tools.
- `LlmProvider`: abstraction for mock and future real providers.

Module 3 adds the final multi-agent architecture:

- `ProductOrchestrator`: creates `ProductBrief`.
- `BusinessOrchestrator`: creates `BusinessBrief`.
- `EngineeringOrchestrator`: creates `TechnicalPlan` and deterministic `TaskGraph`.
- Worker agents: Codebase Mapper, Architect, Rust Backend, Frontend, Tooling Terminal, Test, Security, Reviewer.
- Scheduler: dependency-aware task graph execution, file locks, agent pool placeholder, merge controller.
- Safety settings: max parallel agents, safe-command auto-run flag, patch approval requirement, dangerous-command blocking, secret redaction, network-command blocking.

The expected flow is:

1. User opens a workspace.
2. User starts a mock or real runtime session.
3. Runtime creates a session and the Senior Coding Agent runs a turn.
4. Agent scans the repo, plans, gathers context, proposes a patch, and requests validation commands.
5. In simple mode, frontend renders lifecycle stage, plan, tool calls, patch proposals, command requests, and git diff state.
6. In orchestrated mode, frontend also renders product/business/engineering briefs, task graph, agent cards, worker outputs, security review, reviewer summary, and orchestration timeline.
7. Patch proposals require approval before any filesystem write path.

## Event Flow

The shared protocol package defines `AppEvent` for workspace, git, command, session, task, agent, provider, runtime session, tool-call, patch, and command-request updates. The runtime exposes `GET /sessions/:id/events` as SSE, and the desktop UI subscribes to that stream for live runtime updates. Rust SQLite now also stores canonical `runtime_events` for durable ordered history, but SSE, runtime snapshots, and projections are still not yet a single replay-authoritative source for every lifecycle path.

## Patch Proposal Flow

The agent never writes files directly. It creates a `PatchProposal` with changed-file metadata, risk level, summary, and unified diff. The proposal is displayed in the desktop diff panel and can be approved or rejected. When the operator approves, the desktop app calls the Rust `apply_runtime_patch` Tauri command in `apps/desktop/src-tauri/src/commands/patch.rs`. Rust loads the proposal from SQLite `session_events`, validates paths with `PatchService`, applies the unified diff, captures before/after Git snapshots where possible, and records authoritative apply events in SQLite. The TypeScript runtime still computes the final reconciliation report today, but it now does so from Rust/Tauri-owned snapshot evidence rather than frontend-collected Git state.

## Security Boundaries

The Rust backend owns desktop workspace boundaries, terminal command execution, command policy, provider validation, patch application, and SQLite persistence. The Node runtime temporarily performs read-only workspace inspection with its own path guards because it cannot call Tauri internals directly. It blocks secret-like files, ignores build/vendor folders, and does not write files.

Command execution from the UI still routes through Tauri/Rust. Runtime command requests record requested commands and risk, but Rust performs the actual execution and now preserves provenance such as manual vs policy approval, heuristic background/network detection, and limited background-job lifecycle state. Session durability is still partial: some sessions can restore from durable runtime-event replay, while others still fall back to snapshot restore. There is still not yet a single replay-authoritative source of truth across runtime, frontend, and Rust persistence for every lifecycle path.
