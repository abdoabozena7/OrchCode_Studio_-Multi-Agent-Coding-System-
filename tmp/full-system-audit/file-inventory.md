# File Inventory

- `rg --files` after audit artifacts: 699.
- `rg --files` excluding `tmp/`: 305.
- Top-level source counts after audit: tmp=394, apps=264, docs=21, packages=13, orchcode-icon.ico=1, Launch-OrchCode.cmd.lnk=1, Launch-OrchCode.cmd=1, AGENTS.md=1, package.json=1, package-lock.json=1, scripts=1.
- Filesystem excluding `node_modules/.git` is much larger because Rust target/build outputs are present: 16,684 files observed.

## Important Areas
- Frontend: `apps/desktop/src/app/App.tsx`, `apps/desktop/src/lib/agentRuntime.ts`, `apps/desktop/src/lib/tauri.ts`, `apps/desktop/src/app/activityStream.ts`.
- Runtime: `apps/agent-runtime/src/runtime/*.ts`, especially `AgentRuntime.ts`, `RunEngine.ts`, `ProjectIntake.ts`, `UniversalProjectQuestionEngine.ts`.
- Providers: `apps/agent-runtime/src/llm/OllamaProvider.ts`, `OpenAIProvider.ts`, `MockLlmProvider.ts`.
- Rust/Tauri: `apps/desktop/src-tauri/src/commands`, `services`, `db/mod.rs`.
- Protocol: `packages/protocol/src/agent-runtime.ts`, `approvals.ts`, `models.ts`.
- Swarm: `apps/agent-runtime/src/orchestration/Swarm*.ts`, `SpecialistAgentFactory.ts`.
- Tests: `apps/agent-runtime/src/tests`, `apps/desktop/src-tauri/src/db/mod.rs` embedded tests, Rust command tests.

## Large Bottlenecks / State Growth
- Rust target artifacts dominate disk and filesystem traversal. Largest observed file: `apps/desktop/src-tauri/target/debug/deps/orchcode_desktop_lib.lib` at 882 MB.
- Desktop SQLite state is `C:/Users/A-plus/AppData/Local/OrchCodeStudio/state.sqlite` at 839 MB.
- `apps/agent-runtime/.orchcode-agent-runtime/sessions.json` is 68 MB.
- Old `tmp/root-cause-audit` artifacts polluted inspect/explain evidence, including DBSCAN answers.

## Old Phase / Generated Remnants
- `tmp/root-cause-audit`, `.agent_memory/swarm_trials`, `.agent_memory/swarm_runs`, `.tmp-run`, and multiple `.orchcode-*.log` files are active risk for false grounding if runtime scans generated output as project source.
