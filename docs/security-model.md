# Security Model

Module 1 establishes local safety boundaries before any agent runtime exists.

## Workspace Boundary

The app requires an active workspace directory. File reads, file listing roots, and command working directories are canonicalized and must remain inside the active workspace. Reads outside the workspace are rejected.

Secret-like files are blocked by a baseline detector:

- `.env`
- `*.pem`
- `id_rsa`
- `id_ed25519`
- `credentials.json`

This detector is intentionally conservative and will be expanded later.

## Command Risk Levels

Commands are classified in Rust before execution.

- Safe: examples include `git status`, `git diff`, `npm test`, `pnpm test`, `cargo test`, `pytest`, `rg`, `ls`, and `dir`.
- Medium: examples include `npm install`, `pnpm add`, `cargo add`, `git checkout`, and `git merge`.
- Dangerous: examples include `rm -rf`, `del /s`, `format`, `curl | sh`, `Invoke-WebRequest | iex`, and commands that reference paths outside the workspace.

Module 1 executes safe commands only. Medium commands return `approval_required`. Dangerous commands return `blocked`.

## Model Provider Validation

Provider validation is handled in the Rust backend.

- Ollama validation checks that `baseUrl` is reachable, `/api/tags` returns models, and `selectedModel` exists in that list.
- OpenAI-compatible validation checks required fields and attempts `GET /v1/models` when possible. Some custom providers may not support that endpoint reliably, so endpoint validation is limited in Module 1.

The legacy Module 1 backend mock-session command blocks unless a saved provider config is valid. Module 2 and Module 3 mock runtime modes intentionally run without API keys so the app can be tested offline. Real provider sessions must use validated provider settings.

## API Key Handling

Raw API keys are never logged and are never returned to the frontend from backend commands. Module 1 does not include OS keychain or secure storage integration. Because of that, raw API keys are not persisted in SQLite.

Ollama configuration can be persisted because it has no API key. OpenAI-compatible non-secret settings can be saved, but the config is marked invalid after save until secure secret storage is implemented in a future module.

## Future Patch Review

Patch application is disabled in Module 1. Module 2 adds explicit patch proposals and approval/rejection state, but approval still does not write files. The Rust patch service remains the intended future write path.

## Module 2 Runtime Boundary

The TypeScript agent runtime performs temporary read-only workspace inspection because it runs as a separate local service and cannot call Tauri internals directly yet. It enforces its own workspace boundary checks, ignores build/vendor folders, and blocks secret-like files. It does not write files and does not execute commands.

Runtime command tools only create command requests with risk labels. Actual command execution in the desktop UI still goes through the Rust terminal service and command policy.
