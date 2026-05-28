# Memory And Indexing

Phase 1 adds durable, file-backed repository memory to Hivo Studio. The memory layer gives the runtime and future orchestrator a stable project map instead of forcing every worker to rediscover the same repository facts during every turn.

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
- Stale-index reports, lessons learned, failed attempts, successful patterns, glossary terms, and architecture notes.

The memory layer does not replace reading files before editing. It gives agents a durable map so they know what to read first.

## Memory Layout

Default path:

```text
.agent_memory/
  README.md
  schema_version.json
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
  runs/
  campaigns/
  evals/
```

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

Generated files:

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
```

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
