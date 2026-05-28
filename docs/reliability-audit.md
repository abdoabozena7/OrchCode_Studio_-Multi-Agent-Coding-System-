# Reliability Audit: Hivo Studio

Date: 2026-05-14

Overall verdict at audit time: `Demo-safe only`

Status note for the current operator-console RC branch:

- `SessionManager.load()` is now implemented and runtime sessions can restore from the current `sessions.json` snapshot.
- Runtime session state is no longer purely in-memory, and the current branch now also includes a durable `runtime_events` foundation plus conservative replay-based restore where event history is sufficient.
- The branch now includes the operator console, agent telemetry, work journals, diff attribution, post-apply reconciliation, and a verification-aware review gate.
- There is still no single fully authoritative replay path across runtime, frontend, and Rust persistence for every lifecycle.
- Reconciliation evidence now prefers Rust/Tauri-owned Git snapshots around patch apply, but the runtime still computes the final reconciliation report and some transport still crosses the desktop bridge.
- `localStorage` recent sessions are convenience history only, not authoritative runtime truth.
- Command safety still depends on heuristic classification and should not be read as sandbox-grade containment.
- Background jobs now have limited lifecycle tracking and provenance, but they are not backed by a full process supervisor.

This audit answers one question: what currently prevents Hivo Studio from being trusted as a coding agent for large or business-critical work, and what concrete changes would close those gaps.

Method used:
- Source inspection across `apps/agent-runtime`, `apps/desktop`, `apps/desktop/src-tauri`, `packages/protocol`, and `docs/`
- Validation runs with `npm test`, `npm run typecheck`, and `cargo test`
- UI critique using the provided Codex reference screenshots for home state, run state, and permission-mode affordances

## Scorecard
| Area | Verdict | Why |
| --- | --- | --- |
| Safety and policy enforcement | `Internal alpha` | The repo has real workspace/path guards and patch-path validation, but command and network policy still depend on heuristics and UI language over-promises what backend authority actually guarantees. |
| Patch proposal, approval, apply, and verification lifecycle | `Internal alpha` | The lifecycle exists, but responsibility is split across TypeScript runtime, frontend mirroring, Rust apply, and SQLite projections in a way that is fragile under restart or partial failure. |
| Command classification and execution safety | `Demo-safe only` | Commands now carry clearer provenance and limited background-job tracking, but execution still relies on heuristics and not on a real sandbox or process supervisor. |
| Session persistence and replayability | `Strong demo / internal-alpha candidate` | The current branch has snapshot restore, durable runtime events, and conservative replay for key flows, but still lacks a fully authoritative replay path for every lifecycle. |
| Event consistency between runtime, SSE, SQLite projections, and UI state | `Not shippable` | Event naming and projection rules are inconsistent enough that state reconstruction cannot be trusted as a source of truth. |
| Multi-agent scheduling, file locking, merge/conflict handling, and backpressure | `Demo-safe only` | There is real scheduling code, but important concurrency behavior is still optimistic, placeholder-heavy, and not backed by durable orchestration state or recovery logic. |
| Observability, logs, audit trail, and forensic traceability | `Demo-safe only` | There are logs and SQLite tables, but no authoritative end-to-end run journal that can replay who approved what, what executed, and what final filesystem state resulted. |
| Test depth across runtime, Rust backend, desktop frontend, and end-to-end flows | `Demo-safe only` | Runtime tests are strong; frontend and end-to-end coverage are effectively absent, and Rust tests only cover a narrow slice. |
| UX clarity for access levels, approval state, progress, errors, and recovery | `Demo-safe only` | The UI is visually ambitious, but it is not yet sober or explicit enough for operator trust on high-stakes work. |

## Severity-Ranked Findings

### P0. Runtime session durability is missing, so the system cannot be trusted after restart
Trust bucket: Durability and recovery

Why this is a blocker:
- A coding agent for real work must survive crashes, restarts, disconnects, and partial workflows without losing authoritative state.
- This repo currently treats loss of runtime session state as acceptable behavior.

Evidence:
- `apps/agent-runtime/src/runtime/SessionManager.ts:31` stores sessions in an in-memory `Map`.
- `apps/agent-runtime/src/runtime/SessionManager.ts:39` defines `load()` but does nothing.
- `apps/agent-runtime/src/tests/reliability-foundation.test.ts:13` explicitly tests that runtime session state stays in memory only and is not restored across restarts.
- `apps/agent-runtime/src/tests/runtime-task-state.test.ts:118` explicitly tests that runtime task state does not restore after restart.
- The desktop UI still persists recent sessions in local storage at `apps/desktop/src/app/App.tsx:228-232` and attempts restore at `apps/desktop/src/app/App.tsx:362-370`, which can point the operator to dead sessions.

Failure mode in real usage:
- The user approves a patch, the app restarts, and the authoritative runtime state is gone.
- The UI still shows a recent session and may imply resumability while the backend cannot reconstruct the pending approval, command queue, or verification state.
- Any post-incident audit becomes speculative because the source of truth vanished.

Remediation:
- Make session state durable in one place and treat that store as authoritative.
- Implement `SessionManager.load()` to restore sessions, task state, approval state, command results, and verification state from a durable store.
- Define explicit resumability semantics: resumable, terminal, expired, corrupt, or orphaned.
- Stop offering session restore in the UI unless the runtime can actually restore it.

Priority and dependency order:
1. Durable session snapshot and event log
2. Runtime restore logic
3. UI restore flow and expired-session UX

### P0. Event and persistence truth are split enough that state reconstruction is not trustworthy
Trust bucket: Runtime truth vs UI truth

Why this is a blocker:
- For a real coding agent, the event log must be replayable and the persisted state must match what the operator saw.
- Right now, important state is mirrored from the frontend into SQLite rather than authored once and consumed everywhere.

Evidence:
- Runtime publishes session and artifact events in `apps/agent-runtime/src/runtime/SessionManager.ts:187-198,210,343,355,367`.
- The frontend mirrors runtime sessions and agent runs into SQLite in `apps/desktop/src/app/App.tsx:438-449`.
- The frontend also appends runtime events into Rust SQLite via `appendSessionEvent` at `apps/desktop/src/app/App.tsx:422` and `apps/desktop/src/lib/tauri.ts:80`.
- Rust projects event payloads into `patches`, `command_requests`, `command_results`, and `artifacts` in `apps/desktop/src-tauri/src/db/mod.rs:438-552`.
- `SessionManager.addCommandExecution()` publishes `runtime.command.requested` again at `apps/agent-runtime/src/runtime/SessionManager.ts:249` instead of a dedicated completion event, while Rust projection logic expects `command.completed` at `apps/desktop/src-tauri/src/db/mod.rs:507`.

Failure mode in real usage:
- The operator sees a command execution in the UI, but SQLite projections miss or misclassify it.
- Patch, command, and artifact records can drift depending on whether the frontend was connected at the time of the event.
- A later review cannot prove the exact sequence of approvals, executions, and outcomes.

Remediation:
- Define one canonical runtime event model and use it end-to-end.
- Emit explicit events for `command.requested`, `command.approved`, `command.executed`, `command.failed`, `patch.approved`, `patch.applied`, `patch.apply_failed`, and `session.restored`.
- Move persistence of runtime-originated events to the runtime or Rust backend, not to a best-effort frontend mirror.
- Add replay tests that rebuild state only from persisted events.

Priority and dependency order:
1. Event contract cleanup in `packages/protocol`
2. Runtime-side durable event emission
3. Rust projection rewrite
4. Replay and drift tests

### P0. Access-profile language over-promises authority, especially `full_access`
Trust bucket: Runtime truth vs UI truth

Why this is a blocker:
- Permission labels are trust contracts.
- If the UI says “Full access” and “Automatic when validated” while the backend still routes through gated or split authority paths, users will over-trust the system.

Evidence:
- `packages/protocol/src/approvals.ts:48-53` maps `full_access` to `requireApprovalForPatches: false` and `autoApplyValidatedPatches: true`.
- The UI labels `full_access` as “Auto-apply validated patches” and shows “Automatic when validated” at `apps/desktop/src/app/App.tsx:172-176` and `apps/desktop/src/app/App.tsx:1299`.
- Runtime patch approval still returns “Patch approved. Apply is handled by the Rust patch authority.” at `apps/agent-runtime/src/runtime/AgentRuntime.ts:102`.
- Runtime patch approval still sets `needs_approval` at `apps/agent-runtime/src/runtime/AgentRuntime.ts:104`.
- Trust profile is collapsed to `trusted_internal` for both `auto_review` and `full_access` at `packages/protocol/src/approvals.ts:75` and `apps/desktop/src/app/App.tsx:507`.

Failure mode in real usage:
- A user assumes “Full access” means the system can safely complete an end-to-end apply/verify cycle.
- In reality, the workflow still depends on Rust-side apply, frontend-mediated mirroring, and separate command reporting.
- That mismatch creates incorrect operator mental models during critical work.

Remediation:
- Rename access levels to what the backend truly enforces today.
- Make access profiles resolve to concrete backend-enforced capabilities, not aspirational behavior.
- Separate “policy intent” from “authority actually present”.
- Hide or downgrade `full_access` until Rust and runtime can complete the promised automatic path end-to-end.

Priority and dependency order:
1. Protocol contract rename and semantics cleanup
2. UI copy correction
3. Backend enforcement parity

### P1. Patch lifecycle authority is partially real, partially simulated, and the docs are now out of sync with the code
Trust bucket: Rust authority vs TypeScript runtime

Why this is a blocker:
- File mutation is the highest-risk operation in a coding agent.
- The system must make it obvious which layer proposed, approved, applied, and verified a change.

Evidence:
- Docs still say actual patch application remains disabled or future-facing in `docs/architecture.md:70` and `docs/security-model.md:46`.
- Rust actually applies patches via `git apply` in `apps/desktop/src-tauri/src/services/patch.rs:13-34`.
- Tauri exposes patch apply via `apps/desktop/src-tauri/src/commands/patch.rs:8-45`.
- The frontend invokes that path via `apps/desktop/src/lib/tauri.ts:105` and `apps/desktop/src/app/App.tsx:594`.
- Runtime state only becomes truly “applied” after the frontend reports the Rust result back through `reportRuntimePatchApplyResult` in `apps/desktop/src/lib/agentRuntime.ts:61` and `apps/desktop/src/app/App.tsx:595-607`.

Failure mode in real usage:
- Rust applies the patch successfully, but the frontend crashes before the runtime receives the result.
- The filesystem has changed, but runtime state, run summary, and approval state are stale.
- Docs and UI may mislead reviewers about whether the write path is active.

Remediation:
- Make Rust patch apply the authoritative mutation event source.
- Push the apply result back into the runtime through a durable backend bridge, not a frontend round-trip.
- Update docs to reflect current behavior immediately.
- Add a reconciliation path that compares runtime patch state against actual git/workspace state after reconnect.

Priority and dependency order:
1. Documentation correction
2. Rust-to-runtime authoritative apply completion
3. Reconciliation and crash recovery

### P1. Command execution safety is useful but still heuristic and easy to mis-trust
Trust bucket: Safety and policy enforcement

Why this is a blocker:
- In business-critical environments, command execution needs structured policy, provenance, and containment.
- Heuristic classification is not enough for a trusted agent.

Evidence:
- Rust command policy returns `approval_required` for medium commands in `apps/desktop/src-tauri/src/services/terminal.rs:85-89`.
- Network command detection is heuristic in `apps/desktop/src-tauri/src/services/terminal.rs:200-214`.
- Background-server detection is heuristic in `apps/desktop/src-tauri/src/services/terminal.rs:217-224`.
- Runtime-side command request results still use simplified statuses in `apps/agent-runtime/src/runtime/CommandExecutor.ts:34,71`.
- The UI auto-runs trusted safe commands in `apps/desktop/src/app/App.tsx:679`.

Failure mode in real usage:
- A risky command slips through classification because it does not match the expected string heuristics.
- A background process is started without durable tracking, shutdown, or output capture.
- Operators cannot reconstruct which commands were auto-run versus manually approved with enough confidence.

Remediation:
- Replace heuristic-only policy with a structured command DSL or allowlist model for agent-originated execution.
- Record provenance for every executed command: actor, approval source, policy decision, auto/manual, process id, and final outcome.
- Treat background jobs as first-class tracked jobs with lifecycle management.
- Add adversarial policy tests for quoting, wrappers, shell indirection, and encoded network behavior.

Priority and dependency order:
1. Provenance schema
2. Structured policy model
3. Background job manager
4. Adversarial tests

### P1. Multi-agent architecture is credible as a prototype, not yet as a dependable production orchestrator
Trust bucket: Multi-agent credibility

Why this is a blocker:
- A production multi-agent system must prove queueing fairness, lock contention handling, retries, merge provenance, and deterministic blocked states.
- This repo has meaningful building blocks, but it still reads as a strong prototype.

Evidence:
- Docs still call out placeholders for agent pool and scheduler pieces in `docs/architecture.md:51`.
- The scheduler does support async runs and file-lock waiting in `apps/agent-runtime/src/scheduler/TaskScheduler.ts:58-109`.
- Orchestrated runtime emits `parallel_execution.active` in `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:216-218`.
- The same scheduler also collapses some blocked conditions into generic `task.blocked` or `task.failed` states at `apps/agent-runtime/src/scheduler/TaskScheduler.ts:68-85`.
- There is no durable restore/replay of in-flight orchestration state because runtime state is in-memory only.

Failure mode in real usage:
- A large run with several workers blocks on shared files or partial failures, then the app disconnects.
- There is no trustworthy way to resume, inspect which workers truly finished, or reason about what remains safe to retry.
- “Multi-agent” becomes mostly a live-session effect rather than a dependable work engine.

Remediation:
- Promote queue state, blocked reasons, retries, and file-lock waits into durable orchestration state.
- Add idempotent task execution semantics and retry policy.
- Record merge provenance and conflict resolution decisions explicitly.
- Add large-run soak tests and reconnect tests for orchestrated sessions.

Priority and dependency order:
1. Durable orchestration state
2. Retry and reconciliation model
3. Scale and soak testing

### P1. The UI still behaves like a smart demo shell, not an operator console
Trust bucket: Operator UX

Why this is a blocker:
- High-stakes users need fast comprehension, not personality-first styling.
- The UI currently hides too much operational truth behind friendly labels and decorative presentation.

Evidence:
- The app uses `Delius Swash Caps` as the primary and display font at `apps/desktop/src/app/styles.css:4-5`.
- The layout hard-codes `min-width: 1180px` at `apps/desktop/src/app/styles.css:48`, which weakens adaptability.
- Access mode copy includes `Full access` and `Custom (config.toml)` in `apps/desktop/src/app/App.tsx:172-179`.
- Session status compresses many states into broad labels like “Ready for review” at `apps/desktop/src/app/App.tsx:1905`.
- The UI stores recent sessions locally at `apps/desktop/src/app/App.tsx:228-232` and can attempt restores even though runtime sessions are not durable.
- The disconnect fallback message at `apps/desktop/src/app/App.tsx:431` is gentle, but it does not tell the operator whether state is still trustworthy.

Failure mode in real usage:
- An operator cannot immediately tell whether the system is planning, waiting for approval, applied but unverified, disconnected but recoverable, or dead.
- “Working team” and “Code changes” are readable for demos, but not crisp enough for incident-grade decision making.
- Permission language invites overconfidence instead of careful review.

Remediation:
- Shift the UI tone toward a clearer operator console.
- Replace decorative typography with sober, highly legible text hierarchy.
- Surface explicit run states: planning, awaiting patch review, awaiting Rust apply, awaiting verification commands, verified, failed, disconnected, unrecoverable.
- Add a single canonical review/apply banner that explains consequence, authority, and next safe action.
- Mark non-restorable sessions as expired instead of “recent”.

Priority and dependency order:
1. State model cleanup in protocol/runtime
2. Approval and restore UX rewrite
3. Typography and layout simplification

### P2. Test coverage is lopsided: runtime-heavy, frontend-light, and weak on end-to-end trust scenarios
Trust bucket: Test depth

Why this matters:
- The runtime has good local tests, but the user ultimately trusts the whole system, not isolated logic.

Evidence:
- `npm test` now passes a substantially larger runtime-focused suite, including replay restore, reconciliation, and command/background lifecycle coverage.
- `cargo test` now covers command policy, terminal provenance, patch/reconciliation helpers, runtime-event projection, and background command projection paths.
- No meaningful desktop frontend test suite is present under `apps/desktop`.
- No end-to-end flow validates the real path: runtime propose -> frontend mirror -> Rust apply -> runtime update -> UI reconciliation.

Failure mode in real usage:
- The code can look “well tested” while the most important failures happen in the seams between runtime, frontend, and Rust.

Remediation:
- Add desktop component and state-machine tests for approval, restore, and disconnect flows.
- Add end-to-end tests for patch apply success, patch apply crash, command execution success/failure, and session reconnect.
- Add projection-consistency tests for SQLite state rebuilt from events.

Priority and dependency order:
1. End-to-end happy path
2. Crash and reconnect paths
3. Frontend state-machine tests

## UI Comparison Against Codex-Style Trust Cues

### Must-fix trust issues
- Permission modes are not phrased as enforceable contracts. `Full access` reads stronger than the backend reality.
- Run state is too compressed. “Ready for review” hides whether the system is waiting on patch approval, Rust apply, command approval, or verification.
- Session restoration is visually available before it is technically trustworthy.
- The review/apply flow lacks a single high-signal “what happens if I click this” surface.

### Usability issues that slow adoption
- Decorative typography and low-density hierarchy make the interface feel more experimental than operational.
- “Working team” is interesting, but not yet informative enough about queueing, blocking, retries, or authority boundaries.
- The current diff and command surfaces require too much operator interpretation.
- Disconnect messaging does not distinguish transient UI disconnect from loss of authoritative runtime state.

### Polish issues
- The fixed large minimum width weakens use on smaller laptop layouts.
- Some labels are product-language heavy instead of action-language heavy.
- Approval-state copy should be shorter and more explicit.

### Codex-inspired recommendations
- Use a stricter information hierarchy: run state banner first, then pending decisions, then evidence, then activity detail.
- Replace broad state labels with explicit lifecycle chips.
- Show authority on every critical action: proposed by runtime, applied by Rust, verified by command result.
- Make “restore session” conditional on actual recoverability.
- Use calmer typography and higher scanability in the main thread.

## Public Contract Changes to Prioritize

### `packages/protocol/src/agent-runtime.ts`
- Separate session state from action state more cleanly.
- Add explicit lifecycle states for `patch_proposed`, `patch_approved`, `patch_applied`, `verification_pending`, `verification_passed`, `verification_failed`, `session_restored`, and `session_expired`.
- Add durable provenance fields to patch and command outcomes: actor, authority, source event id, created at, completed at, retryable, and failure class.

### `packages/protocol/src/approvals.ts`
- Reframe `AccessProfile` as declared policy intent, not assumed authority.
- Replace `full_access` with a name that reflects current backend truth unless end-to-end automatic apply is truly enforced.
- Add a resolved capability object generated by the backend and rendered by the UI.

### Runtime event contracts
- Standardize event names and require one completion event per mutating action.
- Ensure event names match Rust projection logic exactly.
- Add event versioning so migrations do not silently corrupt replay semantics.

### Patch and command result contracts
- Add approval source, approval timestamp, execution authority, process metadata, and reconciliation status.
- Distinguish “approved but not executed”, “executed but not reported”, and “reported but not reconciled”.

### Orchestration state
- Expose queue position, blocked reason, file-lock wait reason, retry count, and gate failures as first-class UI-visible fields.

## Roadmap

### Phase 1: Trust blockers before serious usage
- Make runtime sessions durable and restorable.
- Clean up event contracts and persistence ownership.
- Correct access-profile language and backend/UI semantics.
- Update documentation to match the active Rust patch path.

### Phase 2: Reliability upgrades for internal team adoption
- Add authoritative Rust-to-runtime apply and command result reconciliation.
- Add background job tracking and stronger command provenance.
- Add durable orchestration state, retries, and reconnect behavior.
- Build end-to-end tests around real approval/apply/verify flows.

### Phase 3: UX and scalability work before broader production confidence
- Redesign the operator console around explicit run state and pending decisions.
- Simplify typography and improve small-screen behavior.
- Add queueing/backpressure visibility for multi-agent runs.
- Add soak tests for large repositories, long sessions, and partial failures.

## Validation Notes
- `npm test` now passes on the current branch with replay/reconciliation/command durability coverage.
- `npm run typecheck` now passes on the current branch.
- `cargo test` now passes on the current branch with stronger terminal/projection coverage than the original audit snapshot.

These passing checks are useful, but they do not materially change the P0 verdicts because the main trust gaps are architectural seams, durability, and operator-facing truthfulness rather than local type safety.
