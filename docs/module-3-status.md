# Module 3 Status

## Implemented

- Simple Agent mode remains available.
- Multi-Agent Orchestrated mode added.
- Product, Business, and Engineering orchestrators added.
- Ordinary queue worker execution is now contract-based through `OrchestratedWorkerExecutionContracts`.
- Local deterministic worker implementations were removed from the ordinary orchestration surface; worker execution must be injected explicitly and provider-backed paths remain the semantic authority.
- Security and reviewer review boundaries remain:
  - `SecurityAgent` performs deterministic patch/command safety checks.
  - `ReviewerAgent` performs provider-backed adversarial review and blocks when provider review is unavailable or invalid.
- Queue-driven scheduler added with task dependencies and canonical file lock checks.
- `OrchestrationFileLockManager` is the shared lock primitive for ordinary queue and swarm scheduling.
- Review, quality gate, and approval-boundary services now capture patch/conflict blockers and reviewer summary support after queue execution.
- Orchestration events added and persisted in runtime JSON state.
- Protocol expanded with orchestration, task graph, agents, and approvals types.
- UI now shows mode selector, safety settings, orchestration timeline, briefs, agent cards, task graph, reviews, patch proposals, and command requests.
- Runtime orchestration requires a configured provider for semantic plans and user-facing prose; scripted fixtures are limited to tests.
- Tests added for schemas, task graph scheduling, file locks, orchestrated runs, security blocking, queue adapters, and approval-boundary conflict blockers.

## How To Run Simple Mode

Terminal 1:

```powershell
npm run agent:dev
```

Terminal 2:

```powershell
npm run dev
```

In the UI, choose `Simple Agent`.

## How To Run Orchestrated Mode

Terminal 1:

```powershell
npm run agent:dev
```

Terminal 2:

```powershell
npm run dev
```

In the UI:

1. Open a workspace.
2. Choose `Multi-Agent Orchestrated`.
3. Adjust safety settings if needed.
4. Enter a request such as `Add a settings page with theme toggle`.
5. Run orchestration.

## Provider Configuration

Runtime provider mode remains isolated behind `OpenAIProvider`. It reads environment variables only:

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com"
```

The rest of the runtime does not depend on any provider SDK. Test suites may use private scripted provider fixtures, but runtime-selectable mock/demo providers are not valid production behavior. Future adapters can swap in:

- internal orchestrator models
- OpenAI Agents SDK
- LangGraph supervisor

## Limitations

- Patch approval still happens in the runtime, but reviewed patch apply now goes through the Rust desktop command path and must be reported back into the runtime to complete lifecycle state.
- Runtime persistence is not durable yet; orchestration and task state still do not restore after runtime restart.
- Runtime workspace tools are still temporary Node-side read-only tools with their own guards.
- Scheduler is deterministic and currently executes synchronously, while still enforcing dependency and lock rules.
- Worker patch proposals remain reviewable intent until approval, Rust apply, and validation evidence confirm them.
- Project-explain runtime fallback builders for provider failure/validation failure have been removed from the production path; remaining project-explain tests still need broader fixture cleanup around provider-required failures.
- Tauri dev requires Rust/Cargo installed.

## Recommended Module 4 Backlog

- Bridge runtime tools to Rust/Tauri commands so Rust is the only filesystem authority and reconciliation source.
- Persist orchestration state in SQLite with actual restore/replay.
- Stream SSE events live into the UI.
- Add real provider structured-output adapter.
- Add patch composition and conflict resolution workflow.
- Add command approval UI for medium-risk commands.
- Add session reload/history screen.
