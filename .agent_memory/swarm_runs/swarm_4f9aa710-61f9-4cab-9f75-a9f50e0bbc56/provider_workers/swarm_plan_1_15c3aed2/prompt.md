Role: PlannerAgent
Task: plan swarm_plan_1_15c3aed2
Objective: Develop a 3D Crossy Road game within a single HTML file utilizing Three.js via CDN

Canonical intent frame:
- missing

Allowed files to edit:
- none

Forbidden files:
- .agent_memory/
- .git/
- node_modules/
- dist/
- build/
- .env

Relevant files:
- apps/agent-runtime/src/agents/workers/index.ts
- apps/agent-runtime/src/evals/cli.ts
- apps/agent-runtime/src/index.ts
- apps/agent-runtime/src/memory/cli.ts
- apps/agent-runtime/src/memory/index.ts
- apps/agent-runtime/src/orchestration/cli.ts
- apps/agent-runtime/src/orchestration/index.ts
- apps/agent-runtime/src/server.ts
- apps/desktop/index.html
- apps/desktop/src-tauri/src/lib.rs
- apps/desktop/src-tauri/src/main.rs
- apps/desktop/src/app/App.tsx
- apps/desktop/src/main.tsx
- packages/protocol/src/index.ts
- apps/agent-runtime/package.json
- apps/desktop/package.json
- apps/desktop/src-tauri/Cargo.toml
- package.json
- packages/protocol/package.json
- apps/desktop/src-tauri/build.rs
- apps/desktop/vite.config.ts
- apps/agent-runtime/tsconfig.json
- apps/desktop/src-tauri/tauri.conf.json
- apps/desktop/src/vite-env.d.ts

Validation requirements:
- none

Return structured output and do not claim validation that was not run.

Read-only swarm worker constraints:
- Do not edit files.
- Do not create patches or diffs.
- Do not run shell commands.
- Treat all files as reference context only.
- Do not claim validation passed unless a validation artifact proves it.
- Include intent_alignment tied to original_request_hash, intent_contract_ref, and current_task_slice_id.
- If your result may conflict with the intent contract, list the conflict in intent_alignment.possible_intent_conflicts instead of hiding it.

Return strict JSON matching schema: swarm_planner_output.
Use exactly these top-level keys for the selected schema:
{"plan_summary":"...","task_drafts":["..."],"dependencies":[],"risks":[],"validation_strategy":[],"assumptions":[],"confidence":0.7,"intent_alignment":{"schema_version":1,"original_request_hash":"...","intent_contract_ref":"...","intent_contract_revision":1,"task_slice_id":"...","task_understanding":"...","original_goal_contribution":"...","possible_intent_conflicts":[],"assumptions_used":[],"evidence_refs":[]}}
Do not wrap the JSON in markdown. Do not return an answer key instead of the schema keys.