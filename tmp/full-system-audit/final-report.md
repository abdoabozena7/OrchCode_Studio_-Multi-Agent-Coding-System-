# Full System Reality Audit For OrchCode Studio

## A. Executive Verdict
**Strong infrastructure, weak product loop**

## B. One-Paragraph Truth
OrchCode Studio is not an empty shell: it has a real Node runtime, a real React/Tauri desktop shell, real Rust command and patch authority, real SQLite persistence, real memory/indexing tools, a serious inspect/explain evidence engine, and a substantial swarm/trial artifact system. But the things that make it feel like a working local coding agent are still fractured: the default runtime is mock, health does not show active provider truth, real-provider inspect calls timed out and fell back, memory/swarm are mostly CLI-side rather than normal UI path, command and patch completion depend on frontend report-back bridges, generated `tmp/` artifacts contaminate reasoning, and the UI exposes only a compact slice of what the runtime knows.

## C. What Exists And Is Real

### Runtime
- Real Fastify runtime endpoints for sessions, turns, SSE, command results, patch results: `apps/agent-runtime/src/server.ts`.
- Real session manager with tokens/snapshots/replay attempt: `SessionManager.ts`.
- Real run-to-green deterministic workflow with command requests and verification state: `RunEngine.ts`, `RunToGreen.ts`.
- Real inspect/explain analyzers and evidence artifacts: `UniversalProjectQuestionEngine.ts`, `InspectExplainReadLanes.ts`, `ProjectIntelligenceKernel.ts`.

### UI
- React UI builds and Vite startup DOM renders. Verified DOM: `screenshots/desktop-vite-dom-snapshot.txt`.
- UI has workspace picker, composer, panels, Full Access, terminal drawer, settings, details/diff toggles.
- Native Tauri window E2E was not automated.

### Rust
- Real command execution and policy through Rust.
- Real SQLite persistence and provider validation.
- Real patch apply bridge with workspace path guards and git snapshot hooks.

### Memory
- Memory/index/command inventory exists and commands pass.
- It is not the normal desktop inspect/run source of truth.

### Swarm
- Staffing planner, scheduler, artifact store, trial lab, traces, metrics exist.
- Workers are mock/logical by default.

### Inspect/Explain
- Real runtime path produced answers for all requested Arabic prompts.
- Provider calls were attempted but timed out/aborted; answers came from deterministic fallback/citation logic.
- Evidence contamination was observed: DBSCAN answer used `tmp/root-cause-audit/explain-repro-results.json` as proof.

### Terminal
- Rust command authority works in smoke: safe git status, non-git diagnosis, package `npm test`, risky git push blocked.
- Terminal drawer is separate from agent command execution.

### Persistence
- SQLite state exists and is large: 839 MB, 95 sessions, 6274 session_events.
- Node snapshots exist; replay still falls back to snapshots.

### Tests
- `npm test` passed 209 Node tests.
- `cargo test` passed 21 Rust tests.
- These mostly prove units, mocks, temp workspaces, and smoke harnesses, not native UI product behavior.

## D. What Is Only Mock/Test/Docs
- 300 logical agents: mock scheduler stress, not 300 real LLM calls.
- Swarm default workers: `defaultMockWorker`.
- Consensus: synthesized from work item status.
- Trial compare metrics: heuristic/synthetic.
- Many Phase 5/6 claims are real artifacts but mock execution.
- Passing inspect tests do not prove real user answers; audit prompts showed provider timeout and fallback.

## E. What Is Wired To The User Path
- Desktop submit -> runtime session -> RunEngine.
- Inspect/explain path through RunEngine.
- Run-to-green command requests through frontend/Rust/report-back.
- Full Access auto-run settings in frontend and protocol defaults.
- Rust terminal/patch authority.
- SSE session updates and compact UI activity stream.

## F. What Is Not Wired To The User Path
- Swarm autopilot/trial lab in normal desktop UI.
- Repo memory/index freshness in normal desktop composer flow.
- Campaign management in desktop.
- Trial reports and swarm artifacts in UI.
- Provider call telemetry in runtime/session artifacts.
- Full event log as primary UI stream.
- Native UI E2E proof in this audit.

## G. Top 10 Root Causes Of "It Still Does Not Work"
1. Provider truth is muddy: default runtime is `demo_mock`, desktop may create `real_provider`, health only reports config default.
2. Real provider is not reliable enough in deep inspect: audit prompt calls timed out after about 60s and fallback answered.
3. Generated `tmp/` artifacts are scanned as project evidence, causing false confidence.
4. Swarm is impressive infrastructure but not connected to the desktop product loop.
5. Command and patch flows are split: Rust acts, frontend must report back to runtime.
6. Persistence has too many truths: SQLite, session_events, runtime_events, sessions.json, localStorage.
7. UI shows a compact derived activity stream, not the authoritative event/reasoning stream.
8. Memory/index exists but normal runtime uses live scans/context packs instead.
9. Tests are green but mostly mock/unit/smoke, not native UI + real provider + Rust authority together.
10. Provider telemetry is absent, so users cannot tell whether Ollama/GPU/model actually answered.

## H. Capability Matrix
| Capability | Claimed | Implemented | Wired | Tested real path | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| persistent memory | yes | Project memory and repo index files exist under .agent_memory; CLI commands inspect and refresh them. | Swarm/CLI uses memory; desktop RunEngine ProjectIntake reads live workspace instead of the committed repo index. | memory:index-status, memory:inspect, memory:show-commands passed.; No direct UI surface for memory freshness or memory contents was verified.; none | Real but not wired to main path | .agent_memory/README.md<br>apps/agent-runtime/src/memory/RepoIndexer.ts<br>tmp/full-system-audit/command-logs/memory-inspect.log |
| repository indexing | yes | Repo index totals reported 249 indexed files and fresh status before audit. | Used by swarm planner/trial lab; not the normal desktop inspect/run intake path. | memory:index-status passed; not visible; none | Real but not wired to main path | apps/agent-runtime/src/memory/RepoIndexer.ts<br>apps/agent-runtime/src/orchestration/SwarmRuntime.ts:300<br>tmp/full-system-audit/command-logs/memory-index-status.log |
| command inventory | yes | Command inventory exists and is reported, but duplicate/noisy command entries were observed. | Used by swarm validation command selection, not primary run-to-green command selection. | memory:show-commands passed; not visible; none | Partial | apps/agent-runtime/src/memory/CommandInventory.ts<br>apps/agent-runtime/src/orchestration/SwarmRuntime.ts:362<br>tmp/full-system-audit/command-logs/memory-show-commands.log |
| orchestrator | yes | CoreOrchestrator and CLI commands exist; tests pass. | Desktop normal submit goes through AgentRuntime/RunEngine unless auto-mode selects orchestration; no UI control for campaigns/swarm was verified. | run-agentic-task/plan-task and agent plan available; not directly visible in Vite DOM; mostly mock/deterministic in tests | Real but not wired to main path | apps/agent-runtime/src/orchestration/Orchestrator.ts<br>apps/agent-runtime/src/orchestration/cli.ts:48<br>tmp/full-system-audit/command-logs/agent-plan.log |
| task graph | yes | Task graph manager, scheduler package, and orchestration task artifacts exist. | CLI/campaign path; main desktop run-to-green creates runtime task state, not full task graph UX. | agent plan emits work graph artifacts; generic details/activity only; none required | Real but not wired to main path | apps/agent-runtime/src/orchestration/TaskGraphManager.ts<br>apps/agent-runtime/src/scheduler/TaskGraph.ts<br>tmp/full-system-audit/command-logs/agent-plan.log |
| context packs | yes | RunEngine stores context_pack artifact; ContextPackBuilder exists for orchestration. | Inspect/run creates artifacts, but UI does not make context packs a first-class operator view. | show-context-pack exists; not surfaced in captured startup DOM; not inherently | Partial | apps/agent-runtime/src/runtime/RunEngine.ts:92<br>apps/agent-runtime/src/orchestration/ContextPackBuilder.ts<br>apps/agent-runtime/src/orchestration/cli.ts:104 |
| safety | yes | Rust command policy and patch path guards exist; risky command smoke blocked git push. | Desktop command execution uses Rust execute_approved_command. | smoke:desktop-run-project passed; Full Access visible; command approvals inferred from source/smoke, not native E2E.; none | Real and wired | apps/desktop/src-tauri/src/services/command_policy.rs<br>apps/desktop/src-tauri/src/commands/terminal.rs:33<br>tmp/full-system-audit/command-logs/smoke-desktop-run-project.log |
| review | yes | ReviewLoop, reviewer agents, and review schemas exist. | Orchestration/swarm paths create review artifacts; desktop edit loop not proven to invoke real review agents. | orchestration CLI; not first-class in startup DOM; mock or deterministic in tests | Partial | apps/agent-runtime/src/orchestration/ReviewLoop.ts<br>apps/agent-runtime/src/agents/workers/ReviewerAgent.ts<br>apps/agent-runtime/src/schemas/reviewSchema.ts |
| verification | yes | Run-to-green verification states and validation runner exist; package-script smoke ran npm test through Rust. | Run-to-green command result continues after frontend/Rust report-back; static projects show unavailable/not_run. | smoke:run-to-green passed; activity stream can show verification passed/pending; none for run-to-green | Partial | apps/agent-runtime/src/runtime/RunToGreen.ts<br>apps/agent-runtime/src/orchestration/ValidationRunner.ts<br>tmp/full-system-audit/command-logs/smoke-run-to-green.log |
| file locks | yes | Orchestration and swarm file lock managers exist. | Swarm scheduler uses lock manager; desktop single-run patch path does not prove lock-aware multi-writer execution. | swarm scheduler; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/FileLockManager.ts<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:143 |
| repair loops | yes | Run-to-green repair and swarm repair item creation exist. | Run-to-green can select alternate command in tests; swarm repair is scheduler-level with mock workers. | tests/smoke; not proven natively; repair patch may use provider in edit path | Partial | apps/agent-runtime/src/runtime/RunToGreen.ts<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:352<br>apps/agent-runtime/src/tests/run-to-green.test.ts |
| campaigns | yes | Campaign CLI/manager exists. | No desktop operator console campaign UX verified. | campaign scripts exist in package.json; not visible; unknown | Real but not wired to main path | apps/agent-runtime/src/orchestration/CampaignManager.ts<br>apps/agent-runtime/src/orchestration/campaign-cli.ts<br>package.json |
| resumable runs | yes | sessions.json snapshots, durable runtime_events replay, and localStorage session restore path exist. | Runtime replay prefers SQLite when present but snapshot fallback still warns not authoritative. | resume-run and agent resume exist; recent session restore path exists; native E2E not verified.; none | Partial | apps/agent-runtime/src/runtime/SessionManager.ts:664<br>apps/agent-runtime/src/runtime/SessionManager.ts:796<br>apps/desktop/src/app/App.tsx:825 |
| execution modes | yes | fast/deep/exhaustive and auto mode exist in orchestration/swarm. | Desktop composer has Plan mode, Full Access; no explicit fast/deep/exhaustive UX captured. | --mode <auto\|fast\|deep\|exhaustive>; startup DOM shows Plan mode and Full Access only.; none | Partial | apps/agent-runtime/src/orchestration/cli.ts:421<br>apps/desktop/src/app/App.tsx<br>tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt |
| memory learning | yes | decisions/lessons/patterns JSONL and trial tuning records are appended. | Swarm trial writes tuning memory; normal desktop inspect/run does not visibly learn. | trial commands write memory; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:403<br>tmp/full-system-audit/trial-memory/swarm_staffing_lessons.jsonl |
| metrics/evals foundation | yes | Metrics, eval CLI, Phase 4 eval exist. | CLI/test, not desktop. | eval and trial commands; not visible; mostly mock | Real but not wired to main path | apps/agent-runtime/src/orchestration/Metrics.ts<br>apps/agent-runtime/src/evals/phase4.ts<br>apps/agent-runtime/src/evals/cli.ts |
| internal swarm autopilot | yes | SwarmAutopilotRuntime plans/runs and writes artifacts. | CLI only for verified path; not connected to desktop inspect/explain/edit. | agent plan passed; not visible; default worker does not call provider | Partial | apps/agent-runtime/src/orchestration/SwarmRuntime.ts:42<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:49<br>tmp/full-system-audit/command-logs/agent-plan.log |
| automatic StaffingPlan | yes | Planner selects counts, risk, specialists, executor caps. | CLI/trials; not desktop normal user path. | agent plan emitted 9 logical agents; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/SwarmStaffingPlanner.ts:29<br>tmp/full-system-audit/command-logs/agent-plan.log |
| dynamic specialist agents | yes | Specialist descriptors are generated from evidence and marked read_only. | Planner artifacts only; default worker does not instantiate real specialist LLM workers. | agent plan produced DocumentationReviewerAgent; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts:14<br>apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts:128<br>tmp/full-system-audit/command-logs/agent-plan.log |
| logical agents up to 300 when justified | yes | Scheduler-scale trial creates 300 logical mock agents and 300 read-only work items. | trial lab only | scheduler-scale passed; not visible; no real model calls | Mock/test-only | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:180<br>apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:194<br>tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log |
| adaptive scheduler | yes | Scheduler leases, traces, executor caps, retries, repair items. | swarm CLI/trial; workers default mock. | scheduler-scale passed; not visible; none by default | Partial | apps/agent-runtime/src/orchestration/SwarmScheduler.ts:31<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:87<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:506 |
| fan-out/fan-in | yes | Work items and agent instances fan out; final report/consensus fan in. | swarm CLI/trial only. | trial artifacts; not visible; none by default | Partial | apps/agent-runtime/src/orchestration/SwarmFanInOut.ts<br>apps/agent-runtime/src/orchestration/SwarmRuntime.ts:111 |
| consensus | yes | Consensus object is synthesized from review work item statuses. | swarm run artifacts only. | swarm final report; not visible; none | Mock/test-only | apps/agent-runtime/src/orchestration/SwarmRuntime.ts:156<br>apps/agent-runtime/src/orchestration/SwarmRuntime.ts:175 |
| swarm artifacts/metrics/traces | yes | Artifact store persists runs, plans, traces, metrics. | CLI/trial; not UI. | agent plan/trials; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/SwarmArtifactStore.ts<br>tmp/full-system-audit/trial-memory/swarm_runs |
| swarm trial lab | yes | Trial lab commands ran and wrote reports. | CLI only. | staffing-eval/scheduler-scale/compare passed; not visible; no model calls | Real but not wired to main path | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:54<br>tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log |
| automatic staffing evals | yes | Default scenarios evaluated against planner heuristics. | trial CLI only. | staffing-eval passed; not visible; none | Mock/test-only | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:63<br>tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log |
| scheduler stress tests | yes | 300 logical read-only work items processed by defaultMockWorker. | trial CLI only. | scheduler-scale passed; not visible; none | Mock/test-only | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:196<br>apps/agent-runtime/src/orchestration/SwarmScheduler.ts:506<br>tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log |
| baseline vs autopilot comparison | yes | Comparison command ran, but metrics are heuristic/synthetic in code. | trial CLI only. | compare passed; not visible; none | Mock/test-only | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:647<br>apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:658<br>tmp/full-system-audit/command-logs/agent-trial-compare.log |
| specialist evals | yes | Specialist scenarios/triggers exist. | trial/plan only; not real specialist model execution. | agent plan produced specialist; not visible; none | Partial | apps/agent-runtime/src/orchestration/SpecialistAgentFactory.ts<br>apps/agent-runtime/src/tests/swarm-trial-lab.test.ts |
| real-world safe trials | yes | small-safe-fix trial command exists. | not run in this audit because user forbade fixes/behavior changes. | available; not visible; unknown | Partial | apps/agent-runtime/src/orchestration/cli.ts:259<br>apps/agent-runtime/src/orchestration/SwarmTrialLab.ts |
| tuning feedback loop | yes | Trial writes tuning JSONL records with confidence/evidence count. | Trial memory only; defaults not automatically changed. | trial commands wrote audit memory; not visible; none | Partial | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:403<br>apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:438<br>tmp/full-system-audit/trial-memory/swarm_tuning_history.jsonl |
| report generation | yes | Trial/swarm reports are generated as markdown/json artifacts. | CLI only. | trial reports; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/SwarmTrialLab.ts:761<br>apps/agent-runtime/src/orchestration/SwarmRuntime.ts:181 |
| trial commands | yes | CLI help lists trial commands and package scripts call them. | CLI only, not desktop. | staffing-eval/scheduler-scale/compare passed; not visible; none | Real but not wired to main path | apps/agent-runtime/src/orchestration/cli.ts:388<br>package.json<br>tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log |
| real provider/Ollama support | yes | Ollama provider performs real /api/chat calls; direct smoke succeeded. | Desktop can create real_provider sessions when saved provider config is valid. | real provider smoke script passed on tiny prompt; Provider config exists in DB; active session provider not visible in startup DOM.; Ollama qwen2.5-coder:7b success for tiny prompt; inspect prompts timed out. | Partial | apps/agent-runtime/src/llm/OllamaProvider.ts:45<br>apps/agent-runtime/src/config.ts:14<br>tmp/full-system-audit/real-provider-smoke.json |
| inspect/explain deep answers | yes | Runtime produced Arabic answers with citations and read-lane artifacts. | Desktop submit path can reach this runtime, but native UI was not E2E verified. | audit script drove AgentRuntime directly; not tested through native window; 8 prompt calls timed out/aborted; deterministic fallback answered. | Partial | apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:321<br>apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:53<br>tmp/full-system-audit/answers.json |
| desktop operator console | yes | React/Vite UI builds and startup DOM renders; Rust commands exist. | Native Tauri window not automated in audit; Vite web capture is not equivalent. | desktop build passed; startup DOM captured; screenshot failed; settings path in source | Partial | apps/desktop/src/app/App.tsx<br>tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt<br>tmp/full-system-audit/screenshots/SCREENSHOT_UNAVAILABLE.md |

## I. Flow Diagrams

### Run This Project
```
UI -> create Rust run/token -> create Node runtime session -> RunEngine intake
   -> deterministic run_to_green command -> command request
   -> frontend auto/manual approval -> Rust execute
   -> SQLite event/result -> HTTP report-back -> runtime verification -> SSE/UI
```

### Inspect/Explain
```
UI -> runtime session -> RunEngine inspect/explain
   -> project intake/context_pack -> read lanes/evidence tiers
   -> provider call -> timeout/fallback if needed -> validated answer -> UI
```

### Terminal Command
```
Manual drawer: UI -> Rust run_workspace_command -> terminal result only
Agent command: runtime request -> UI approval/auto-run -> Rust execute_approved_command -> report back to runtime
```

### Patch Apply
```
runtime proposal -> UI approval/auto-apply -> Rust apply_runtime_patch
   -> git snapshot/reconcile -> UI reportRuntimePatchApplyResult -> runtime state
```

### Swarm Run
```
CLI agent run/plan -> memory rebuild -> staffing planner -> scheduler
   -> defaultMockWorker -> artifacts/metrics/consensus/report
```

### Restore
```
localStorage recent session/token + runtime sessions.json + Rust SQLite events
   -> replay if possible -> snapshot fallback with warning
```

## J. Test / Reality Gap
- `npm test`: passed 209 tests, but uses mock providers, deterministic providers, and fixture workspaces.
- `cargo test`: passed, but native UI was not driven.
- Smoke scripts prove important slices, especially Rust command authority, but not the whole desktop user experience.
- Real provider smoke proves Ollama can answer tiny prompts; it does not prove deep inspect works with Ollama.
- Inspect/explain audit proves the fallback can answer with citations, but also proves provider timeout and stale/generated evidence contamination.

## K. Screenshots And Smoke Evidence
- Web UI DOM capture: `tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt`.
- Screenshot image: unavailable; in-app browser `Page.captureScreenshot` timed out. See `screenshots/SCREENSHOT_UNAVAILABLE.md`.
- Native Tauri screenshot/E2E: not automated.
- Command logs: `tmp/full-system-audit/command-logs/`.
- Real provider smoke: `tmp/full-system-audit/real-provider-smoke.json`.
- Inspect answers: `tmp/full-system-audit/answers.json`.

## L. Immediate Fix Shortlist
1. Add first-class provider telemetry to sessions: mode, model, request count, response count, timeout/error/fallback, latency.
2. Exclude generated audit/run/tmp artifacts from project evidence by default, or mark them as generated/evidence-tier low.
3. Collapse command/patch report-back into a single reliable Rust-owned transaction or runtime bridge helper.
4. Wire memory freshness/index and inspect evidence files into the desktop operator console.
5. Make inspect/explain use targeted deep investigation before LLM, with visible evidence and a hard no-answer state when proof is weak.

## M. What To Stop Doing
- Stop treating mock trial success as product multi-agent success.
- Stop patching prompt aliases while stale/generated evidence is still admitted as proof.
- Stop adding mock-only tests for UI/runtime/provider claims without a real-path smoke.
- Stop expanding swarm agent counts before the desktop product loop is wired.
- Stop relying on health/default mode as provider truth.

## N. Recommended Next Implementation Prompt
Implement provider and evidence truth telemetry for the normal desktop inspect/explain path only. Add session fields and UI display for provider mode, model, provider request count, successful response count, timeout/error count, fallbackUsed, and the top evidence files actually used. Exclude `tmp/`, `.agent_memory/swarm_runs`, `.agent_memory/swarm_trials`, build outputs, and runtime snapshot directories from inspect/explain source evidence unless the user explicitly asks to inspect generated artifacts. Add one real runtime smoke that asks an inspect/explain question and asserts: provider telemetry is present, generated artifacts are excluded, and the UI/session artifact names the evidence files.

## O. Appendix

### Commands Run
- npm run typecheck: passed; log tmp/full-system-audit/command-logs/npm-run-typecheck.log
- npm test: passed; log tmp/full-system-audit/command-logs/npm-test.log
- npm run build -w @orchcode/desktop: passed; log tmp/full-system-audit/command-logs/npm-build-desktop.log
- cargo test: passed; log tmp/full-system-audit/command-logs/cargo-test-tauri.log
- npm run smoke:run-to-green: passed; log tmp/full-system-audit/command-logs/smoke-run-to-green.log
- npm run smoke:desktop-run-project: passed; log tmp/full-system-audit/command-logs/smoke-desktop-run-project.log
- npm run memory:index-status: passed; log tmp/full-system-audit/command-logs/memory-index-status.log
- npm run memory:inspect: passed; log tmp/full-system-audit/command-logs/memory-inspect.log
- npm run memory:show-commands: passed; log tmp/full-system-audit/command-logs/memory-show-commands.log
- npm run agent:trial:staffing-eval: passed; log tmp/full-system-audit/command-logs/agent-trial-staffing-eval.log
- npm run agent:trial:scheduler-scale: passed; log tmp/full-system-audit/command-logs/agent-trial-scheduler-scale.log
- npm run agent:trial:compare: passed; log tmp/full-system-audit/command-logs/agent-trial-compare.log
- npm run agent:plan: passed; log tmp/full-system-audit/command-logs/agent-plan.log
- runtime health injection: passed; log tmp/full-system-audit/command-logs/runtime-health-inject-retry.log
- SQLite state inspection: passed; log tmp/full-system-audit/command-logs/sqlite-state.log
- SQLite provider/session inspection: passed; log tmp/full-system-audit/command-logs/sqlite-provider-session.log
- desktop Vite dev server for DOM capture: started_then_stopped; log tmp/full-system-audit/command-logs/desktop-vite-dev.log
- real provider smoke: passed; log tmp/full-system-audit/real-provider-smoke.json
- inspect/explain prompts with real_provider: completed_with_provider_timeouts; log tmp/full-system-audit/inspect-explain-reality-report.md
- desktop Vite web UI DOM capture: dom_verified_screenshot_failed; log tmp/full-system-audit/screenshots/desktop-vite-dom-snapshot.txt
- audit artifact generation: passed; log tmp/full-system-audit/command-logs/write-audit-artifacts.log

### Environment Notes
- Workspace: `D:\projects\Ai\OrchCode_Studio_(Multi-Agent-Coding-System)`
- Date: 2026-05-24T11:14:12.039Z
- Ollama tags available during audit: gpt-oss:120b-cloud, qwen2.5-coder:7b, deepseek-coder:6.7b
- Saved desktop provider in SQLite: `{"provider_type":"ollama","provider_name":"Ollama","base_url":"http://localhost:11434","selected_model":"deepseek-coder:6.7b","api_key_configured":0,"is_valid":1,"last_validated_at":"2026-05-18T11:50:42.329407800+00:00","last_validation_error":null}`
- Dev web UI server was started for DOM capture on `http://127.0.0.1:5174/` and stopped after audit.

### Known Audit Limitations
- No native Tauri window automation.
- Screenshot capture timed out, but DOM and logs were captured.
- Inspect/explain audit disabled audit-script session snapshot persistence to avoid huge JSON write failures; runtime logic still ran in memory.
- Some command logs include Windows/PowerShell encoding artifacts; UTF-8 files are readable with explicit UTF-8.
