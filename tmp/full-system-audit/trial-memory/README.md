# Agent Memory

This directory stores durable local project memory for OrchCode.

Committed files:

- `README.md`: schema and operating notes for humans and future agents.
- `schema_version.json`: current local memory schema marker.

Generated local files:

- `repo_index.json`: repository layout, language, entrypoint, and high-signal file metadata.
- `file_manifest.json`: deterministic file manifest with hashes/mtimes for indexed text files.
- `symbol_index.json`: heuristic symbol/import/export index.
- `file_summaries.jsonl`: lightweight per-file summaries.
- `command_inventory.json`: detected build, test, lint, typecheck, smoke, and run commands.
- `decisions.jsonl`: append-only architecture and task decisions.
- `task_history.jsonl`: append-only task/run notes.
- `lessons_learned.jsonl`: compacted lessons from prior runs.
- `failed_attempts.jsonl`: failed strategies and fingerprints to avoid repeating.
- `successful_patterns.jsonl`: accepted project patterns discovered by runs.
- `project_glossary.json`: durable terms and local vocabulary.
- `architecture_notes.jsonl`: append-only architecture facts and constraints.
- `index_state.json`: index freshness metadata.
- `project_intelligence.json`: dependency, risk, entrypoint, and test mapping hints.
- `swarm_staffing_lessons.jsonl`: append-only staffing fit lessons from Phase 6 experiments.
- `swarm_tuning_history.jsonl`: append-only tuning recommendations with confidence/evidence metadata.
- `swarm_failure_patterns.jsonl`: swarm trial failure patterns and avoidance notes.
- `swarm_success_patterns.jsonl`: swarm trial success patterns.
- `swarm_specialist_selection_history.jsonl`: specialist selection precision notes.
- `runs/`: volatile run-specific artifacts.
- `swarm_runs/`: internal Swarm Autopilot run artifacts, staffing plans, scheduler traces, metrics, and reports.
- `campaigns/`: long-running campaign artifacts.
- `evals/`: local eval and benchmark artifacts.

Do not store secrets here. Large generated artifacts and volatile run files should stay local.
