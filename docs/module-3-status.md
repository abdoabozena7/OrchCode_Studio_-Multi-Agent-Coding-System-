# Module 3 Status

## Implemented

- Simple Agent mode remains available.
- Multi-Agent Orchestrated mode added.
- Product, Business, and Engineering orchestrators added.
- Eight worker agents added:
  - CodebaseMapperAgent
  - ArchitectAgent
  - RustBackendAgent
  - FrontendAgent
  - ToolingTerminalAgent
  - TestAgent
  - SecurityAgent
  - ReviewerAgent
- Deterministic scheduler added with task dependencies and file lock checks.
- FileLockManager added.
- MergeController added for patch conflict detection and reviewer summary support.
- Orchestration events added and persisted in runtime JSON state.
- Protocol expanded with orchestration, task graph, agents, and approvals types.
- UI now shows mode selector, safety settings, orchestration timeline, briefs, agent cards, task graph, reviews, patch proposals, and command requests.
- Mock orchestrated mode runs end-to-end without API keys.
- Tests added for schemas, task graph scheduling, file locks, orchestrated mock run, security blocking, and merge conflicts.

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

## Mock vs Real Provider

Mock mode is the default and requires no API key. It creates deterministic briefs, task graphs, worker outputs, patch proposals, command requests, security review, and reviewer summary.

Real provider mode remains isolated behind `OpenAIProvider`. It reads environment variables only:

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com"
```

The rest of the runtime does not depend on any provider SDK. Future adapters can swap in:

- internal orchestrator models
- OpenAI Agents SDK
- LangGraph supervisor

## Limitations

- Patch approval still happens in the runtime, but reviewed patch apply now goes through the Rust desktop command path and must be reported back into the runtime to complete lifecycle state.
- Runtime persistence is not durable yet; orchestration and task state still do not restore after runtime restart.
- Runtime workspace tools are still temporary Node-side read-only tools with their own guards.
- Scheduler is deterministic and currently executes synchronously, while still enforcing dependency and lock rules.
- Worker patch proposals are representative in mock mode, not guaranteed to apply.
- Tauri dev requires Rust/Cargo installed.

## Recommended Module 4 Backlog

- Bridge runtime tools to Rust/Tauri commands so Rust is the only filesystem authority and reconciliation source.
- Persist orchestration state in SQLite with actual restore/replay.
- Stream SSE events live into the UI.
- Add real provider structured-output adapter.
- Add patch composition and conflict resolution workflow.
- Add command approval UI for medium-risk commands.
- Add session reload/history screen.
