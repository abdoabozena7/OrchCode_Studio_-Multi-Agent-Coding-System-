# Durable Factory Locks

Factory orchestration uses durable SQLite-backed locks for coordination-sensitive write paths. The in-memory file lock manager remains available as a compatibility fallback, but CoreOrchestrator and the normal swarm runtime use durable locks as the source of truth.

## Lock Types And Modes

Lock types:

- `file`
- `directory`
- `module`
- `semantic`
- `campaign`
- `task`
- `advisory`

Lock modes:

- `read`
- `write`
- `exclusive`
- `advisory`

Read/read on the same scope is allowed. Write and exclusive locks conflict with active read/write/exclusive locks on the same effective scope. Advisory locks record coordination warnings and do not block.

## Scope Derivation

File and directory locks normalize paths relative to the workspace. Directory write or exclusive locks conflict with child file locks.

Module locks are derived from path families such as orchestration, runtime, memory, swarm, desktop Rust, desktop UI, and protocol. Semantic locks are derived from sensitive areas such as prompt system, factory metadata, database schema, validation runner, lock manager, project config, dependency manifests, public API, and security-sensitive surfaces. Low-confidence semantic derivation creates advisory locks.

## Persistence And Artifacts

Durable lock rows are stored in `factory_locks`. SQLite stores scope keys, status, ownership, timestamps, conflict refs, trace refs, and compact metadata. Lock artifacts remain under:

`.agent_memory/runs/<run_id>/locks/`

Artifact types include lock request, lock snapshot, lock conflict, and lock release JSON.

## Runtime Use

CoreOrchestrator acquires durable locks before existing executor-like tasks are invoked. If acquisition fails, the task is blocked and the executor is not invoked.

SwarmScheduler accepts durable lock managers for write-capable work items. Provider-backed read-only workers do not acquire write locks.

PromptWriter agents do not acquire write locks and cannot weaken future lock requirements.
