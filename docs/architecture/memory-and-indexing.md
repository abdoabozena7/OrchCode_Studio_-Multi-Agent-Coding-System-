# Memory And Indexing

Repository memory is SQLite-first. `.agent_memory/factory_metadata.sqlite` is the source of truth for repository snapshots, durable knowledge records, structured run state, ordered events, and FTS5 search. Files remain for large auditable artifacts, explicit legacy import, and backup export.

## Why This Exists

Small coding agents become more reliable when they receive narrow, grounded context. Repository memory supports that by storing:

- Project layout and high-signal files.
- Source, test, config, docs, package, dependency, and build file classification.
- Likely entrypoints.
- Heuristic symbol, import, and export indexes.
- Lightweight file summaries.
- Detected validation commands.
- Append-only decisions and task history.
- Project intelligence for dependencies, reverse dependencies, tests, command areas, entrypoints, and risk hints.
- A durable semantic project model with file/symbol/route nodes, relationship edges, evidence refs, freshness hashes, and provider embeddings.
- Stale-index reports, lessons learned, failed attempts, successful patterns, glossary terms, and architecture notes.

The memory layer does not replace reading files before editing. It gives agents a durable map so they know what to read first.

## Memory Layout

Default path:

```text
.agent_memory/
  README.md
  schema_version.json
  factory_metadata.sqlite
  backups/
  runs/
  swarm_runs/
  campaigns/
  evals/
```

Root JSON/JSONL files from the earlier file-backed schema may still exist:

```text
.agent_memory/
  repo_index.json
  file_manifest.json
  symbol_index.json
  file_summaries.jsonl
  command_inventory.json
  decisions.jsonl
  task_history.jsonl
  lessons_learned.jsonl
  failed_attempts.jsonl
  successful_patterns.jsonl
  project_glossary.json
  architecture_notes.jsonl
  index_state.json
  project_intelligence.json
```

They are legacy migration inputs or backup material. Runtime memory reads and writes do not use them after cutover.

Phase 4 run artifacts add safety, verification, checkpoint, and metrics detail under each run:

```text
.agent_memory/runs/<run_id>/
  run.json
  tasks.json
  events.jsonl
  checkpoints/
  context_packs/
  invocations/
  raw_outputs/
  parsed_outputs/
  patches/
  reviews/
  validation/
  integration/
  repairs/
  locks/
  metrics/
  reports/
```

Committed files:

- `README.md`: schema and operating notes.
- `schema_version.json`: local schema marker.

SQLite tables:

- `factory_memory_snapshots`: repository index, manifest, symbol index, summaries, command inventory, freshness state, intelligence, and glossary.
- `factory_repo_files`, `factory_repo_symbols`, `factory_memory_fts`: indexed repository search.
- `factory_semantic_nodes`, `factory_semantic_relationships`, `factory_semantic_embeddings`: relationship-aware deep-question retrieval with stale-embedding rejection.
- `factory_memory_records`: decisions, history, lessons, failures, patterns, architecture notes, and swarm tuning knowledge.
- `factory_state_objects`: full structured state used by DB-first run, task, swarm, and campaign reads.
- `factory_event_stream`: original ordered run, swarm, scheduler, and campaign events.
- `factory_memory_imports`, `factory_backup_exports`, `factory_memory_meta`: migration, backup, mode, and cache metadata.

Legacy files:

- `repo_index.json`: top-level repository map, counts, languages, entrypoints, important files, ignored directories, and skipped files.
- `file_manifest.json`: indexed files with extension, size, mtime, hash, language, and roles.
- `symbol_index.json`: heuristic symbols, imports, and exports.
- `file_summaries.jsonl`: one metadata-based summary per indexed file.
- `command_inventory.json`: detected validation and development commands.
- `index_state.json`: schema, index version, manifest hash, and freshness metadata.
- `project_intelligence.json`: dependency graph, reverse dependency graph, test-source map, command-area map, module map, entrypoint map, and risk map.
- `decisions.jsonl`: append-only durable decisions.
- `task_history.jsonl`: append-only task/run history.
- `lessons_learned.jsonl`: compacted durable lessons.
- `failed_attempts.jsonl`: failed strategies and fingerprints to avoid repeating.
- `successful_patterns.jsonl`: accepted patterns found in successful runs.
- `project_glossary.json`: local domain vocabulary.
- `architecture_notes.jsonl`: durable architecture facts.
- `runs/`: volatile run-specific artifacts.
- `campaigns/`: volatile long-running campaign artifacts.
- `evals/`: local eval summaries.

## Commands

From the repository root:

```powershell
npm run memory:index
npm run memory:index-status
npm run memory:index-refresh
npm run memory:index-explain -- <file>
npm run memory:inspect
npm run memory:status
npm run memory:show-commands
npm run memory:clean-runs
npm run memory:compact
npm run memory:lessons
npm run memory:failed-attempts
npm run memory:migrate-sqlite -- --verify
npm run memory:search -- "query"
npm run memory:db-status
npm run memory:export-backup
npm run eval:project-understanding -- --corpus <multi-repository-corpus.json>
```

The deep project-understanding lane requires a fresh index and an embedding model. Semantic nodes and relationships are refreshed from current file hashes. Durable file, symbol, semantic, FTS, and embedding rows are updated incrementally by content fingerprint; unchanged embeddings are retained, while stale vectors are deleted before they can support a current answer.

`memory:migrate-sqlite -- --dry-run` parses every legacy input and reports prospective counts without creating or modifying the SQLite database. A migration without `--verify` remains in `migration_pending_verification`; `storage_mode=db_first` is set only after entity hashes verify successfully. Malformed input aborts before any import transaction.

`memory:export-backup` checkpoints WAL and writes a hashed database plus manifest under `.agent_memory/backups/<timestamp>/`. The typed `restoreMemoryBackup` API verifies that hash before restoring the database.

Phase 4 orchestration inspection commands:

```powershell
npm run agentic:run -- --mode deep "<request>"
npm run agentic:resume-run -- <run_id>
npm run agentic:show-run -- <run_id>
npm run agentic:show-report -- <run_id>
npm run agentic:run-metrics -- <run_id>
npm run agentic:show-artifacts -- <run_id>
npm run agentic:show-run-events -- <run_id>
npm run agentic:show-validation-logs -- <run_id>
npm run agentic:show-patch-history -- <run_id>
```

The memory directory can be overridden with:

```powershell
$env:HIVO_MEMORY_DIR=".custom_agent_memory"
npm run memory:index
```

The CLI also accepts `--workspace`, `--memory-dir`, `--json`, and `--limit`.

## Indexing Rules

The Phase 1 indexer ignores generated, vendor, cache, and build-heavy paths such as:

- `.git`
- `.agent_memory`
- `.hivo-agent-runtime`
- `.venv`, `venv`, `__pycache__`
- `node_modules`
- `dist`, `build`, `coverage`, `target`
- `tmp`, `.tmp-run`
- `vendor`, `generated`, `gen`

Large files and binary assets are skipped. Source files are hashed and summarized only when they are text-like and below the configured size limit.

## Future Orchestrator Use

The future orchestrator can use memory to:

- Select relevant files before worker assignment.
- Build narrow context packs for each worker.
- Avoid sending every worker the whole repository.
- Route tasks to specialist agents based on file roles and module roots.
- Choose validation commands from `command_inventory.json`.
- Compare current files against previous runs using hashes.
- Reuse decisions and task history instead of repeating solved debates.

## Debugging Memory

Use `npm run memory:inspect -- --json` to inspect the generated state as structured JSON. If an expected file or command is missing, check:

- Whether the file is under an ignored directory.
- Whether the file is too large or binary.
- Whether the command is declared in a recognized manifest.
- Whether the workspace path passed to the CLI is the repository root.

Phase 1 symbol extraction is heuristic. It is designed to be safe and expandable, not exhaustive.

## Concurrency And Cache

SQLite uses WAL, foreign keys, `busy_timeout`, `synchronous=FULL` for primary memory writes, and short `BEGIN IMMEDIATE` transactions with bounded retry. SQLite does not provide row-level locks; conflict safety comes from transaction boundaries, unique keys, and idempotent upserts.

`HIVO_REDIS_URL` enables an optional read-through Redis cache when the optional `redis` package is available. Without it, memory uses a bounded in-process TTL cache. Redis is never a source of truth and cache failures never delay SQLite writes.
