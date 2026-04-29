# Module 1 Status

## Implemented

- Tauri 2 desktop app scaffold under `apps/desktop`.
- React + TypeScript frontend with workspace, chat, agents, tasks, diff, terminal, and settings surfaces.
- Shared TypeScript protocol package under `packages/protocol`.
- Rust services for workspace management, git status/diff, command policy, terminal execution, patch placeholders, project indexing, SQLite state, and model provider validation.
- SQLite initialization for `projects`, `sessions`, `tasks`, `agent_runs`, `tool_calls`, `patches`, `project_memory`, and `model_provider_config`.
- Backend-enforced startup guard that blocks mock sessions without a valid saved provider.
- Ollama provider validation using `GET /api/tags`.
- OpenAI-compatible provider UI and backend validation skeleton.
- Rust unit tests for command risk classification and workspace path guard.

## Mocked Or Disabled

- No real LLM calls.
- No real multi-agent runtime.
- Mock session creates three fixed tasks and three fixed agent statuses.
- Patch application exists as a disabled placeholder.
- Recent projects and file tree are basic local UI surfaces, not a full explorer.
- Medium-risk command approval returns `approval_required` but has no approval workflow yet.

## Provider Setup

### Ollama

1. Run Ollama locally.
2. Pull at least one model, for example `ollama pull llama3.1`.
3. Open Settings.
4. Choose the Ollama preset.
5. Use `http://localhost:11434`.
6. Click `Refresh Ollama Models`.
7. Select a model.
8. Click `Validate`, then `Save`.

After saving a valid Ollama config, the main screen enables `Create Mock Plan`.

### OpenAI-Compatible

The UI supports custom OpenAI-compatible providers, OpenRouter-compatible endpoints, and local/private OpenAI-compatible servers. Module 1 can validate required fields and tries `GET /v1/models` where practical.

Secure API key storage is not implemented yet. Raw API keys are not persisted in SQLite. Because of that, saved cloud/private provider configs are marked invalid after save until keychain-backed storage is added.

## Known Limitations

- `cargo` is required for Rust checks and Tauri dev/build.
- The terminal is collected-output only; streaming is not implemented yet.
- Command risk classification is intentionally conservative and should be expanded before autonomous editing.
- Project indexing is shallow and ignores `node_modules`, `target`, `dist`, `build`, and `.git`.
- Event streaming is represented in protocol types but not yet wired.

## How To Run

Install dependencies:

```powershell
npm install
```

Run frontend typecheck/build:

```powershell
npm run typecheck
npm run build
```

Run the desktop app in dev mode:

```powershell
npm run dev
```

Run Rust checks when Rust is installed and `cargo` is on PATH:

```powershell
cd apps/desktop/src-tauri
cargo test
cargo check
```

## Next Module Readiness

Module 2 can build on the existing session/task/agent/tool/patch schema, provider guard, command policy, workspace guard, and protocol event types to add a real agent runtime and streamed tool execution.
