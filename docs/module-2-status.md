# Module 2 Status

## Implemented

- Separate TypeScript agent runtime workspace at `apps/agent-runtime`.
- HTTP API:
  - `POST /sessions`
  - `POST /sessions/:id/turn`
  - `GET /sessions/:id`
  - `GET /sessions/:id/events`
  - patch approve/reject endpoints
- Single `SeniorCodingAgent` lifecycle:
  - `INTAKE`
  - `REPO_SCAN`
  - `PLAN`
  - `CONTEXT_GATHERING`
  - `PATCH_PROPOSAL`
  - `REVIEW_REQUEST`
  - `OPTIONAL_COMMAND_REQUEST`
  - `DONE` reserved for future no-approval paths
- Mock LLM provider with deterministic plan and patch proposal output.
- OpenAI provider skeleton isolated in one file and reading `OPENAI_API_KEY` from the environment only.
- Controlled runtime tools:
  - `workspace.list_files`
  - `workspace.read_file`
  - `workspace.search_code`
  - `workspace.get_project_summary`
  - `git.status`
  - `git.diff`
  - `command.request_run`
  - `patch.propose`
  - `patch.validate`
- Desktop UI integration for mock runtime sessions, lifecycle status, plan, tasks, tool calls, patch proposals, command requests, proposed diff, and actual git diff.
- Patch approval/rejection state exists. Approved patches can now be applied by the Rust desktop command path after operator review.
- Runtime sessions are still in-memory only. The old JSON persistence description is no longer accurate, and `SessionManager.load()` does not restore sessions after restart.
- Tests for mock LLM, tool registry, command policy integration, patch validation, and agent lifecycle.

## Mock Mode

Mock mode requires no API key and no hosted service. It produces deterministic plan and patch output and is the default runtime mode.

Run the runtime service:

```powershell
npm run agent:dev
```

In a second terminal, run the desktop app:

```powershell
npm run dev
```

If Rust/Cargo is not installed, the Tauri desktop command will fail before opening. The frontend still builds with `npm run build`, and the runtime can be exercised with `npm run test -w @orchcode/agent-runtime`.

## Real Provider Later

`OpenAIProvider` is present as an isolated skeleton. It reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` from environment variables only. It is intentionally not wired to SDK calls in Module 2 so the rest of the runtime remains independent of any hosted provider.

## Current Limitations

- Runtime workspace tools are temporary Node-side read-only tools with their own path guards. Module 3 should move these behind a Rust/Tauri sidecar bridge or command API.
- Patch application is implemented on the Rust desktop side, but runtime state still depends on the frontend reporting the Rust result back to the TypeScript runtime.
- SSE endpoint exists, but the desktop UI currently refreshes session state after actions instead of maintaining a live stream.
- Runtime persistence is not durable yet. The desktop mirrors events into Rust SQLite, but runtime sessions and task state are not restored from that store.
- Command requests are not executed by the runtime. The UI routes safe command execution through the Rust terminal command.
- Real LLM mode is a skeleton.

## Module 3 Prerequisites

- Add a runtime-to-Rust bridge for workspace tools and command execution that removes the frontend from the reconciliation path.
- Replace in-memory runtime state with SQLite-backed restore/replay or another shared durable boundary.
- Expand runtime events to live UI streaming.
- Add multi-agent orchestration while reusing the session, tool call, patch proposal, and command request protocol types.
