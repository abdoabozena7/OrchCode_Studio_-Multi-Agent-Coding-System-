# Architecture

Hivo Studio is structured as a Windows-first Tauri 2 desktop application with a React + TypeScript frontend, a Rust backend/core, and a separate TypeScript agent runtime service. The current branch includes a local operator console, durable runtime event foundations, replay-aware restore, patch review/apply flows, and Rust-evidence-backed post-apply reconciliation.

## Desktop Frontend

The frontend lives in `apps/desktop/src` and uses Vite, React, and strict TypeScript. The primary screen is now an operator-console-oriented coding-agent shell:

- Left sidebar: workspace path input, open workspace action, recent projects placeholder, file tree placeholder.
- Main panel: chat-like task panel, provider-authored plan actions, and git diff view.
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
- `LlmProvider`: required abstraction for configured real providers.

Module 3 adds the final multi-agent architecture:

- `ProductOrchestrator`: creates `ProductBrief`.
- `BusinessOrchestrator`: creates `BusinessBrief`.
- `EngineeringOrchestrator`: creates `TechnicalPlan` and deterministic `TaskGraph`.
- Worker agents: Codebase Mapper, Architect, Rust Backend, Frontend, Tooling Terminal, Test, Security, Reviewer.
- Scheduler: dependency-aware task graph execution, file locks, agent pool placeholder, merge controller.
- Safety settings: max parallel agents, safe-command auto-run flag, patch approval requirement, dangerous-command blocking, secret redaction, network-command blocking.

Phase 5 adds the Internal Swarm Autopilot Runtime in `apps/agent-runtime/src/orchestration`. The user still sees one coding agent through `agent run "<goal>"`, while the runtime internally creates a `StaffingPlan`, logical agent templates and instances, dependency-aware work items, scheduler traces, metrics, consensus artifacts, and a final report under `.agent_memory/swarm_runs/<run_id>/`. The maximum capacity is 300 internal logical agents, but the planner chooses small counts for small tasks and caps write-capable executors separately. See `docs/architecture/internal-swarm-autopilot.md`.

Phase 6 adds the Swarm Autopilot Trial Lab. The normal UX remains `agent run` and `agent plan`; trial commands such as `agent trial staffing-eval`, `agent trial compare "<goal>"`, and `agent trial scheduler-scale` are measurement tools for validating whether automatic staffing is small when it should be small, scales read-only work when justified, caps executors, creates specialists only from evidence, and reports where swarm work helps or wastes effort. Trial artifacts live under `.agent_memory/swarm_trials/<experiment_id>/`, with tuning lessons appended to swarm-specific JSONL memory files. See `docs/architecture/phase-6-swarm-autopilot-trial-lab-plan.md`.

The expected flow is:

1. User opens a workspace.
2. User starts a provider-required runtime session.
3. Runtime creates a session and the Senior Coding Agent runs a turn.
4. Agent scans the repo, plans, gathers context, proposes a patch, and requests validation commands.
5. In simple mode, frontend renders lifecycle stage, plan, tool calls, patch proposals, command requests, and git diff state.
6. In orchestrated mode, frontend also renders product/business/engineering briefs, task graph, agent cards, worker outputs, security review, reviewer summary, and orchestration timeline.
7. Patch proposals require approval before any filesystem write path.

## Event Flow

The shared protocol package defines `AppEvent` for workspace, git, command, session, task, agent, provider, runtime session, tool-call, patch, and command-request updates. The runtime exposes `GET /sessions/:id/events` as SSE, and the desktop UI subscribes to that stream for live runtime updates. Rust SQLite now also stores canonical `runtime_events` for durable ordered history, but SSE, runtime snapshots, and projections are still not yet a single replay-authoritative source for every lifecycle path.

## Patch Proposal Flow

The agent never writes files directly. It creates a `PatchProposal` with changed-file metadata, risk level, summary, and unified diff. Patch lifecycle truth is `proposed -> approved -> apply_started -> applied|apply_failed`, with `rejected` as the no-write terminal path. Approval re-runs proposal preflight, and the desktop persists the proposal plus approval event before calling Rust `apply_runtime_patch`. Rust loads the proposal from SQLite `session_events`, requires a persisted approval, validates diff paths/files/secrets, runs `git apply --check` when available, applies the unified diff, captures before/after Git snapshots where possible, and records authoritative apply events in SQLite. Only a successful Rust result may produce an `applied` or files-changed claim. The TypeScript runtime still computes the final reconciliation report today, but it now does so from Rust/Tauri-owned snapshot evidence rather than frontend-collected Git state.

Validation truth is recorded separately from display-oriented check status. A session can only report `verified_passed` after at least one Rust-authoritative validation command actually executes successfully. Policy-blocked, approval-required, missing-command, and runtime-error paths remain explicitly unverified.

## Inspect/Explain Read Lanes

The `inspect_only` answer path uses read-only inspect/explain lanes before composing project answers. `RunEngine` still enters through `answerUniversalProjectQuestion`, but that engine first runs lane-scoped readers for frontend, API, service, storage, tests, and concept search. Each lane returns structured findings, edges, inspected files, confidence, missing links, rejected evidence, and warnings rather than prose.

The synthesizer builds cross-lane chains such as UI to API to backend to storage to downstream consumers, and the evidence reviewer downgrades incomplete proof: UI state is partial, tests are expectation-only, general storage is not target storage, lifecycle/status text is not implementation, wrappers are not algorithms, and CSS/title evidence is not page structure. These lanes are not UI-visible workers and do not use the patch-oriented `OrchestratedRuntime`; their artifacts are persisted inside existing project explain payloads for auditability without changing protocol artifact types.

## Unified Reasoning Pipeline

`ReasoningKernel v2` owns the adaptive provider loop. The first provider call returns a combined `TurnUnderstanding` and initial `ReasoningStep`, then the provider repeatedly returns `tool_batch`, `final`, `ask_user`, `refuse`, or `escalate`. Local code executes allowed tools, stores evidence, enforces authority, and returns results to the provider. `ReasoningDirective` is no longer requested from providers and remains only as a compatibility projection for old persisted pipeline fields.

Budgets are profile-specific: direct conversation uses 4 provider calls and 60 seconds; ordinary project questions use 12 calls, 4 tool rounds, and 90 seconds; deep questions and actions use 24 calls, 8 tool rounds, 4 repairs, and 180 seconds. Each provider stage also has its own deadline, output-token limit, and time reserve. Tool compaction preserves structured discovery results. Evidence omission is recorded and triggers explicit provider curation. Provider contexts fail explicitly if they exceed their declared bound; they are never silently truncated.

Direct-conversation classifications receive an independent provider route audit before the initial final result is accepted. If the audit determines that workspace evidence is required, the turn is promoted to the deep budget and the auditing provider chooses the first read-tool step. Provider adapters pass native JSON Schemas for the v2 reasoning contracts to Ollama and OpenAI-compatible endpoints, then local validators check the returned object again. Long text queries may use ranked multi-term retrieval only as a candidate-finding tool; it never writes an answer or selects the semantic route.

The adaptive loop rejects an identical tool batch instead of executing it twice. It measures new evidence, source files, relationships, and information gain after every tool round. Two zero-gain rounds trigger independent repair; a third fails explicitly. Every failure after the loop starts raises a trace-bearing terminal error containing completed steps, tool results, evidence, stage budgets, progress, structured repair errors, omissions, and the terminal reason. `AgentRuntime` persists that partial trace while keeping `finalResponseSource: none` and creating no local assistant message.

`investigate_project` is the preferred deep/cross-file read tool. In one fact-only round it checks or refreshes index readiness, combines ranked text, full-text, optional vector, and relationship retrieval, reads bounded source excerpts, and returns hashes plus retrieval diagnostics. It never writes an explanation or answer.

The provider owns semantic understanding, routing, plans, patch intent, and all user-facing assistant prose. Local code owns repository facts, tools, evidence allow-lists, access policy, safety rules, Rust-owned write authority, approval gates, and verification. Local validators never replace a rejected provider result with prose.

Every workspace citation is stored with path, line range, content hash, source type, and excerpt. Before accepting an answer, the runtime re-reads cited workspace files and verifies hashes and line ranges. Every `ANSWER` also passes an independent provider verifier using only the final result and selected evidence; a failed verdict returns to the adaptive loop.

All provider calls pass through the gateway exported by `ReasoningKernel`. Architecture tests reject direct production calls and assistant messages without provider request provenance. There is no runtime mock/demo provider, semantic fallback, deterministic answer composer, or answer cache in the v2 lane. A provider-authored result may explicitly say it does not know. Operational provider failure ends the turn as failed with `finalResponseSource: none` and no assistant message.

Conversation and project-question turns use v2 now. Planning, patch, run-to-green, and swarm execution migrate behind the certification gate: an exact router/author/verifier/embedding profile with a passing local certification record uses the v2 action loop; uncertified profiles are labeled `uncertified` and remain on migration adapters until they pass. Read-only delegation from the v2 lane creates a capability-limited nested `ReasoningKernel` worker. The legacy adapters must not be deleted or described as v2 until the holdout gate passes.

## Project Understanding Kernel

Deep project questions may opt into the provider-backed relationship/embedding lane with `HIVO_PROJECT_UNDERSTANDING_KERNEL_MODE=on`. The unified `ReasoningKernel` remains the default path so a missing embedding model cannot block ordinary project questions. The deep lane owns a bounded `Decompose -> Query Model -> Read Sources -> Build Claim Ledger -> Validate -> Repair -> Decide` loop and may produce a final answer only after material claims are evidence-supported.

The durable semantic model is stored in `.agent_memory/factory_metadata.sqlite`. It records file, symbol, route, concept, and data-field nodes; relationship edges; content hashes and freshness; evidence refs; and provider embeddings. Deep understanding requires an embedding model configured through `embeddingModel`, `HIVO_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_MODEL`, or `OLLAMA_EMBEDDING_MODEL`. Missing embeddings or stale repository memory block the deep lane rather than allowing it to claim understanding.

Validation failures become bounded investigation repairs. Remaining user-only ambiguity produces `FOLLOW_UP`; repository-discoverable evidence gaps produce one `ESCALATE` opportunity to a provider-backed read-only swarm; unresolved or unsafe claims produce `REFUSE`. Swarm review text is advisory and must still pass the same claim ledger and evidence allow-list before it can affect the final answer.

The adaptive release gates are documented in `docs/adaptive-reasoning-certification.md`. Read reasoning uses a sealed 240-case holdout; action reasoning uses a separate sealed 120-case holdout. Both span at least eight commit-pinned repositories and use an independent semantic judge rather than keyword scoring. Passing records are gate-specific and stored in `.agent_memory/adaptive_reasoning_certifications.json`; no model or gate is certified by default.

## Project Knowledge Tree

Existing-project edit requests now pass through a planning-only Project Knowledge Tree before execution. The tree is built from fresh repository memory when `repo_index`, `file_manifest`, `symbol_index`, `file_summaries`, `project_intelligence`, and `command_inventory` are fresh. If memory is stale or missing, the router does not trust it for final file selection and marks nodes with stale/missing freshness while using direct workspace evidence instead.

The root node summarizes the whole project and owns route defaults: `frontend/app.js` routes to `frontend/UI`, `backend/main.py` routes to `backend-entry/API`, README/requirements/package config route to `config/dependencies`, and tests route to `tests/validation`. Area and leaf nodes record owned files, important symbols, dependencies, risks, parent/child links, freshness, and the local specialist responsible for understanding that area.

For an edit request, the Knowledge Query Router returns affected nodes, the primary node, reviewer nodes, likely files, risks, confidence, and the grounded reasons for the route. The Knowledge-Guided Edit Plan records target files, files not to touch, local and cross-node risks, the required leaf/parent/sibling/root review chain, and suggested branch targets for later recursive execution. This layer does not propose patches, run commands, or write files; sessions clearly report: `Execution has not started. This edit was routed through the Project Knowledge Tree.`

## Security Boundaries

The Rust backend owns desktop workspace boundaries, terminal command execution, command policy, provider validation, patch application, and SQLite persistence. The Node runtime temporarily performs read-only workspace inspection with its own path guards because it cannot call Tauri internals directly. It blocks secret-like files, ignores build/vendor folders, and does not write files.

Command execution from the UI still routes through Tauri/Rust. Runtime command requests record requested commands and risk, but Rust performs the actual execution and now preserves provenance such as manual vs policy approval, heuristic background/network detection, and limited background-job lifecycle state. Session durability is still partial: some sessions can restore from durable runtime-event replay, while others still fall back to snapshot restore. There is still not yet a single replay-authoritative source of truth across runtime, frontend, and Rust persistence for every lifecycle path.
# Recursive Factory Approval Layer

Large or explicitly multi-step build/fix requests may enter `recursive_factory`. This planning-only lane produces a durable Product Specification, waits for explicit approval, then produces a durable Technical Plan and waits for a second explicit approval. Product rejection or change requests revise the Product Specification; Technical Plan rejection or change requests revise the plan. The first layer stops after both approvals with `executionStarted: false`: it cannot create tasks, patches, file writes, or command requests.

After Technical Plan approval, the runtime may generate a durable hierarchical recursive graph and planned branch orchestrator records. Branch execution remains separately gated: the graph must be ready, unsafe scope conflicts must be absent, and the user must explicitly approve starting execution. The first branch execution layer schedules at most one write branch, creates a branch execution context, and can only propose a patch. Runtime branches do not write files or run commands directly; patch approval, Rust `apply_runtime_patch`, command execution, and validation truth remain the authoritative downstream lifecycle.

After branch execution, the recursive factory records durable branch result summaries and fans them into a root integration summary, validation hierarchy, and final recursive report. Final status is evidence-based: failed or blocked required branches prevent `verified_passed`, and unrun, blocked, approval-required, or missing validation remains unverified rather than green.

When final recursive validation is `verified_failed`, the runtime records a durable `validation_failure_diagnosis` artifact with the failed command, exit code, stdout/stderr summaries, extracted failures, validation failure signals, and deterministic failure-to-patch attribution. Final reports also persist applied recursive patch provenance: patch id, owner branch/subtask, changed files, diff hunks, touched symbols when detectable, best-effort before/after hashes, Rust apply evidence, and the validation attempt that followed. Attribution remains conservative: a changed file in a traceback is high confidence, a changed symbol reference is high or medium depending on stack evidence, an import of a changed module is medium, and generic failures stay none. Stale memory cannot strengthen attribution.

A single bounded repair loop may propose one reviewable repair patch only when the failure came from a known Rust-reported validation command, the affected files are workspace-local, the scope is small, attribution is high confidence by default, no unsafe conflicts remain, and the default attempt cap has not been reached. The runtime does not write the repair: patch approval and Rust apply are still required, and the same validation command must be rerun through Rust before the final report can become `verified_passed`. Unrelated, low-confidence, blocked, unrun, or still-failing validation remains non-green with the diagnosis, attribution, and repair outcome shown in the report.

The multi-branch execution layer keeps the same Rust-owned write boundary while allowing several planned branches to progress through one session. The scheduler is conservative: at most one write branch may have an active unapplied patch, dependent branches wait for prerequisite branch outcomes, failed dependencies block children explicitly, read-only branches can complete planning work without patches, and final fan-in reports dependency, conflict, apply, and validation truth across all branch results.

Nested sub-orchestration is intentionally limited to one level inside an already-running branch. Eligible large or complex branches with clear scopes may create planned subtasks, but subtasks inherit the same safety contract: max nested depth is one, at most one active write subtask may propose a patch, conflicting subtask scopes sequence or block, and no runtime subtask writes files directly. Parent branches wait for required subtasks to complete or block truthfully, then roll subtask patch, apply, validation, and limitation evidence into both the parent branch result and the root final report.
