# AGENTS.md

Persistent guidance for future coding-agent work in OrchCode Studio.

## Operating Principles

- Do not do big-bang rewrites. Change the smallest coherent slice that advances the architecture.
- Preserve existing behavior unless the current task explicitly changes it.
- Prefer small, verifiable changes with focused tests over broad speculative refactors.
- Run available tests, lint, typecheck, or build commands when the change touches code paths they cover.
- Keep generated run artifacts auditable. Do not hide important state in temporary-only output.
- Update docs when architecture, memory formats, orchestration contracts, or operator workflows change.
- Treat LLMs as narrow workers, not magical global brains.
- Put intelligence in architecture, memory, task decomposition, verification, review, and orchestration.

## Multi-Agent Direction

OrchCode is evolving from a simple coding agent into an orchestration-first multi-agent coding system. The goal is not to make a small model pretend to be a huge model. The goal is to make small models reliable by surrounding them with:

- Repository memory and repeatable indexing.
- Durable project instructions and decision history.
- Narrow context packs for each worker.
- Structured outputs for agent-to-agent communication.
- Explicit verification, review loops, and patch authority.
- Persistent learning from previous runs.

## Repository Memory

- Default local memory lives under `.agent_memory/`.
- Rebuild the index with `npm run memory:index`.
- Check index freshness with `npm run memory:index-status` before relying on old context.
- Refresh memory with `npm run memory:index-refresh`; `-- --changed-only` reports changed files before the safe full refresh.
- Inspect memory with `npm run memory:inspect`, `npm run memory:status`, and `npm run memory:show-commands`.
- Keep `.agent_memory/README.md` and `.agent_memory/schema_version.json` committed.
- Avoid committing large or volatile generated memory artifacts such as run outputs.
- Append decisions, lessons, failed attempts, successful patterns, and task history instead of overwriting useful evidence.
- Compact memory with `npm run memory:compact` after meaningful runs so future workers can avoid repeated failed approaches.

## Campaigns And Modes

- Use campaigns for large goals that need multiple runs: create, plan, run the next safe step, pause/resume, inspect metrics, then report.
- Default to `deep` mode for serious work. Use `fast` only for small low-risk tasks and `exhaustive` for high-risk or large campaigns.
- Treat approval-required status as a real safety stop. Do not bypass it by widening edit scope without explicit operator intent.
- Runs are checkpointed, but background execution is not implied. Resume commands must reconcile saved task state and repository freshness.

## Coding Rules

- Read the surrounding code before editing.
- Prefer existing project patterns and helpers over new abstractions.
- Do not bypass Rust-owned patch, command, workspace, or authority boundaries.
- Do not let invalid JSON or malformed structured output drive code changes.
- Reject or repair executor output before integration when it violates schema, scope, validation, or review gates.
- Treat file locks, patch fingerprints, validation logs, and review artifacts as part of the source of truth for a run.
- Treat stale-index warnings as blockers for context-sensitive work until memory is refreshed.
- Do not silently accept validation that only produced blocked commands; report unverified status clearly.
- Keep TypeScript strict-mode clean.
- Keep generated JSON deterministic enough to diff and debug.
- Add tests for memory/indexing behavior, command detection, context selection, orchestration contracts, and verification logic as those areas evolve.

## Communication Contracts

- Use structured outputs for worker plans, worker results, reviews, command requests, and patch proposals.
- Include file paths, evidence refs, commands run, command results, and unresolved risks in worker outputs.
- Review agents should prioritize concrete correctness, safety, scope, and test gaps.
- Orchestrators should decompose tasks into narrow work orders with clear ownership and merge constraints.
