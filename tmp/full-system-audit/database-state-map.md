# Database / Persistence / State Map

## SQLite
- Path: `C:\Users\A-plus\AppData\Local\OrchCodeStudio\state.sqlite`.
- Size observed: 838,959,104 bytes.
- Tables: agent_runs, artifacts, background_jobs, command_requests, command_results, model_provider_config, orchestration_runs, patches, project_memory, projects, runtime_events, session_events, sessions, tasks, tool_calls.
- Counts: `{"agent_runs":0,"artifacts":621,"background_jobs":0,"command_requests":3,"command_results":4,"model_provider_config":1,"orchestration_runs":95,"patches":0,"project_memory":0,"projects":6,"runtime_events":312,"session_events":6274,"sessions":95,"tasks":0,"tool_calls":0}`.
- Saved provider config: `{"provider_type":"ollama","provider_name":"Ollama","base_url":"http://localhost:11434","selected_model":"deepseek-coder:6.7b","api_key_configured":0,"is_valid":1,"last_validated_at":"2026-05-18T11:50:42.329407800+00:00","last_validation_error":null}`.
- Recent sessions in SQLite are mostly `status=created` while session_events contain many runtime updates. That is a source-of-truth smell.

## Node Runtime Snapshot
- Default root storage: `.orchcode-agent-runtime/sessions.json`; current root file contains empty sessions.
- Secondary observed storage: `apps/agent-runtime/.orchcode-agent-runtime/sessions.json`, 68 MB.
- SessionManager still warns snapshot restore is not event-replay authoritative.

## Frontend LocalStorage
- Source stores recent workspaces/sessions/tokens/sidebar/RTL/full-access notice in localStorage. Not directly inspectable from native app in this audit.

## Memory State
- `.agent_memory` contains committed memory files plus many swarm run/trial artifacts.
- Audit-local trial memory under `tmp/full-system-audit/trial-memory` was created for non-destructive trial commands.

## Source-of-Truth Diagram
```
Live UI state
  -> runtime HTTP/SSE session snapshot
  -> async mirror to Rust session_events
  -> derived runtime_events in SQLite
  -> Node sessions.json snapshot
  -> frontend localStorage recent session/token
```

Verdict: persistence is real but duplicated. Replay exists, but the product still uses snapshot/localStorage fallbacks and split session ids/tokens.
