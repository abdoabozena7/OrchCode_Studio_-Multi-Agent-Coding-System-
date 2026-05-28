# Runtime Flow Map

## Run This Project
```
UI submit
  -> App.tsx createRuntimeRun() in Rust for token/session shell
  -> createRuntimeSession() HTTP to Node runtime
  -> AgentRuntime.runTurn()
  -> RunEngine project intake
  -> deterministic run_to_green command inference
  -> runtime command request
  -> frontend auto-run/approval effect
  -> Rust execute_approved_command()
  -> Rust persists command event/result
  -> Rust posts runtime command result back to Node
  -> runtime updates run_to_green/verification
  -> SSE/front-end state update
```

Evidence: `App.tsx:848`, `RunEngine.ts:238`, `terminalOrchestrator.ts:20`, `terminal.rs:33`, smoke logs. Status: Partial. The split frontend/Rust report-back is real risk.

## Inspect/Explain
```
UI submit
  -> AgentRuntime.runTurn()
  -> RunEngine.runInspectExplainTurn()
  -> ProjectIntake + context_pack
  -> UniversalProjectQuestionEngine
  -> read lanes / evidence tiers / mechanism chain
  -> LlmProjectExplainer provider call
  -> validation/fallback
  -> assistant answer + artifacts
```

Evidence: `RunEngine.ts:885`, `UniversalProjectQuestionEngine.ts:321`, `LlmProjectExplainer.ts:53`, `answers.json`. Status: Partial. Audit prompts attempted real provider calls but timed out; deterministic fallback answered and sometimes used stale `tmp/` artifacts.

## User Approves Command
```
runtime.command.requested
  -> frontend command approval or full-access auto-run
  -> Rust execute_approved_command
  -> SQLite session_events/runtime_events
  -> post_runtime_command_result back to Node runtime
  -> Node marks command completed/failed
```

Evidence: `terminal.rs:33`, `terminal.rs:135`, `App.tsx:482`. Status: Real and wired for smoke, but split handoff can fail after command execution.

## Patch Apply
```
runtime patch proposal
  -> frontend approval/auto-apply effect
  -> Rust apply_runtime_patch loads proposal from SQLite session_events
  -> path guard + apply + git snapshot/reconciliation event
  -> frontend reportRuntimePatchApplyResult()
  -> runtime marks patch applied/rejected/failed
```

Evidence: `patch.rs:28`, `App.tsx:517`. Status: Partial. Rust applies, but runtime reconciliation still depends on frontend report-back.

## Swarm Run
```
agent run/plan CLI
  -> SwarmAutopilotRuntime
  -> load/rebuild memory index
  -> SwarmStaffingPlanner
  -> create templates/instances/work items
  -> SwarmScheduler
  -> defaultMockWorker unless custom worker injected
  -> artifact/metrics/report/consensus
```

Evidence: `SwarmRuntime.ts:62`, `SwarmScheduler.ts:49`, `SwarmScheduler.ts:506`, `agent-plan.log`. Status: Partial/mock-heavy.

## Restore
```
Runtime startup
  -> SessionManager loads sessions.json
  -> tries durable SQLite runtime_events
  -> replays if sufficient
  -> otherwise snapshot fallback with warning
Frontend
  -> localStorage recent session/token
  -> subscribe/get runtime session
  -> fallback to Rust saved snapshot if token/runtime unavailable
```

Evidence: `SessionManager.ts:664`, `SessionManager.ts:796`, `App.tsx:825`. Status: Partial.
