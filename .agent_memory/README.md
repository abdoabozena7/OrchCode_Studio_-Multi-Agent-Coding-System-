# Agent Memory

This directory stores durable local project memory and auditable artifacts for Hivo.

Committed files:

- `README.md`: schema and operating notes for humans and future agents.
- `schema_version.json`: current local memory schema marker.

SQLite source of truth:

- `factory_metadata.sqlite`: repository memory, durable knowledge, semantic project nodes/relationships/embeddings, structured run state, ordered events, search indexes, and orchestration metadata.

Legacy import/backup files:

- `repo_index.json`: repository layout, language, entrypoint, and high-signal file metadata.
- `file_manifest.json`: deterministic file manifest with hashes/mtimes for indexed text files.
- `symbol_index.json`: heuristic symbol/import/export index.
- `file_summaries.jsonl`: lightweight per-file summaries.
- `command_inventory.json`: detected build, test, lint, typecheck, smoke, and run commands.
- `decisions.jsonl`: append-only architecture and task decisions.
- `task_history.jsonl`: append-only task/run notes.
- `lessons_learned.jsonl`: compacted durable lessons from prior runs.
- `failed_attempts.jsonl`: failed strategies and fingerprints to avoid repeating.
- `successful_patterns.jsonl`: accepted project patterns from successful runs.
- `project_glossary.json`: local project vocabulary.
- `architecture_notes.jsonl`: durable architecture facts and constraints.
- `index_state.json`: index version, manifest hash, and freshness metadata.
- `project_intelligence.json`: dependency, test, command-area, module, entrypoint, and risk maps.
- Root JSON/JSONL files are legacy migration inputs or backup exports, not normal runtime read sources.
- `backups/`: checkpointed SQLite backup exports and manifests.
- `runs/`: volatile run-specific artifacts.
- `campaigns/`: volatile campaign-specific artifacts.
- `evals/`: local eval and benchmark summaries.

Deep project understanding requires a fresh memory index. Refreshes update durable index rows by content fingerprint, retaining unchanged embeddings and deleting stale vectors. Run `npm run eval:project-understanding -- --corpus <file>` to evaluate the 80% multi-repository release gate.

Do not store secrets here. Large generated artifacts and volatile run files should stay local.

Run `npm run memory:migrate-sqlite -- --dry-run` before migration. Only verified migrations switch `storage_mode` to `db_first`. Backup restoration verifies the exported manifest hash before replacing the database.
