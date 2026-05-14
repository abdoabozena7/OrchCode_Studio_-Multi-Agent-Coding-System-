# Architecture

OrchCode Studio is structured as a Windows-first Tauri 2 desktop application with a React + TypeScript frontend and a Rust backend/core. Module 1 builds the local foundation only. It does not call LLM APIs and does not implement the future multi-agent runtime.

## Desktop Frontend

The frontend lives in `apps/desktop/src` and uses Vite, React, and strict TypeScript. The primary screen is a functional coding-agent shell:

- Left sidebar: workspace path input, open workspace action, recent projects placeholder, file tree placeholder.
- Main panel: chat-like task panel, guarded mock-plan action, and git diff view.
- Right panel: agent statuses, tasks, session metadata, and git status.
- Bottom panel: terminal command input and collected command output.
- Settings modal: model provider configuration and validation.

Frontend state is local React state in Module 1. The frontend imports shared app types from `packages/protocol` and calls backend commands through Tauri `invoke`.

## Rust Core

The Rust core lives in `apps/desktop/src-tauri/src` and is split into services:

- `WorkspaceService`: opens a workspace, tracks active project state, lists files, reads files, and guards paths.
- `GitService`: detects git repositories, reads status, reads diffs, and exposes a safety-branch placeholder.
- `CommandPolicyService`: classifies commands as safe, medium, or dangerous.
- `TerminalService`: runs only safe commands, blocks dangerous commands, and returns `approval_required` for medium commands.
- `PatchService`: exposes disabled patch application and path validation placeholders.
- `ProjectIndexService`: scans important files, language counts, package managers, and test command guesses.
- `DatabaseService`: initializes local SQLite state for projects, sessions, tasks, agent runs, tool calls, patches, project memory, and provider config.
- `ModelProviderService`: validates Ollama and OpenAI-compatible provider settings through backend-owned HTTP checks.

Tauri commands in `src-tauri/src/commands` expose typed request/response boundaries to the frontend.

## Future Agent Runtime

Module 2 adds a single-agent runtime as a separate TypeScript service under `apps/agent-runtime`. It exposes HTTP and SSE boundaries that can later become a bundled sidecar process.

Runtime modules:

- `AgentRuntime`: public session/turn/approval facade.
- `SessionManager`: in-memory session state, token hashing, and event publication. `load()` is currently a no-op, so runtime sessions do not restore after restart.
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

The shared protocol package defines `AppEvent` for workspace, git, command, session, task, agent, provider, runtime session, tool-call, patch, and command-request updates. Module 2 exposes `GET /sessions/:id/events` as SSE. The desktop UI currently polls session state after actions; SSE is ready for live updates in Module 3.

## Patch Proposal Flow

The agent never writes files directly. It creates a `PatchProposal` with changed-file metadata, risk level, summary, and unified diff. The proposal is displayed in the desktop diff panel and can be approved or rejected. When the operator approves, the desktop app calls the Rust `apply_runtime_patch` Tauri command in `apps/desktop/src-tauri/src/commands/patch.rs`. Rust loads the proposal from SQLite `session_events`, validates paths with `PatchService`, applies the unified diff, and records `apply.completed` back into SQLite. The TypeScript runtime only moves the session to `applied` after the frontend reports that Rust result through `reportRuntimePatchApplyResult`, so patch authority is Rust-owned but runtime state reconciliation is still frontend-mediated.

## Security Boundaries

The Rust backend owns desktop workspace boundaries, terminal command execution, command policy, provider validation, patch application, and SQLite persistence. The Node runtime temporarily performs read-only workspace inspection with its own path guards because it cannot call Tauri internals directly. It blocks secret-like files, ignores build/vendor folders, and does not write files.

Command execution from the UI still routes through Tauri/Rust. Runtime `command.request_run` records requested commands and risk; it does not execute them. Session durability is not complete yet: the desktop app persists event mirrors into Rust SQLite, but runtime sessions themselves are still in-memory only and do not restore across runtime restarts.
