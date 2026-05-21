# Agentic Coding Factory Architecture

OrchCode is an orchestration-first coding system. It keeps small worker agents reliable by surrounding them with repository memory, narrow task scopes, structured outputs, review, verification, repair, and durable artifacts.

## Core Layers

1. Memory and indexing
   - `.agent_memory/repo_index.json` stores layout, important files, entrypoints, and role guesses.
   - `.agent_memory/file_manifest.json` stores hashes and mtimes for freshness checks.
   - `.agent_memory/symbol_index.json` stores heuristic imports, exports, classes, functions, and types.
   - `.agent_memory/command_inventory.json` stores detected test, lint, typecheck, build, smoke, and run commands.
   - `.agent_memory/project_intelligence.json` stores dependency graph, reverse dependencies, test-to-source mapping, command-to-area mapping, module map, entrypoint map, and risk map.
   - learning files store decisions, lessons learned, failed attempts, successful patterns, glossary terms, and architecture notes.

2. Orchestrator and task graph
   - `CoreOrchestrator` turns a request into Scout, Planner, Executor, and Reporter tasks.
   - `TaskGraphManager` enforces status transitions, dependencies, and persisted task state.
   - Context packs include only relevant snippets, constraints, allowed edit scope, validation requirements, prior decisions, and warnings.

3. Roles
   - ScoutAgent, ArchitectAgent, PlannerAgent, ExecutorAgent, ReviewerAgent, TesterAgent, IntegratorAgent, and ReporterAgent are registered with allowed/forbidden operations and output contracts.
   - Phase 4 actively wires the Scout, Planner, Executor, and Reporter path. ExecutorAgent still routes through the existing `SeniorCodingAgent` mock provider path.

4. Safety, review, and verification
   - Executor outputs must validate as structured data.
   - Patch proposals pass scope checks, forbidden-file checks, fingerprinting, review, approval gates, and validation.
   - File locks prevent overlapping edit scopes during a run.
   - Validation commands are selected from memory and blocked unless they pass command policy and allowlist checks.
   - Failed review or validation creates repair artifacts and bounded repair tasks.

5. Campaigns and modes
   - Campaigns are larger than runs and contain milestones, risks, decisions, run ids, reports, and metrics.
   - `fast`, `deep`, and `exhaustive` modes adjust task budgets, context budgets, review strictness, repair attempts, validation level, and approval behavior.

6. Metrics and evals
   - Runs store metrics under `.agent_memory/runs/<run_id>/metrics/run_metrics.json`.
   - Campaigns store metrics under `.agent_memory/campaigns/<campaign_id>/metrics/campaign_metrics.json`.
   - Phase 4 evals use temporary repositories to prove indexing, planning, context bounds, safety rejection, validation/repair signals, stale-index detection, campaigns, memory learning, mode behavior, and final reports.

## Artifact Layout

Run artifacts:

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

Campaign artifacts:

```text
.agent_memory/campaigns/<campaign_id>/
  campaign.json
  events.jsonl
  reports/final_report.json
  metrics/campaign_metrics.json
```

## Operating Principles

- Do not send the whole repository by default.
- Do not let malformed structured output drive code changes.
- Do not treat blocked validation as invisible success.
- Do not silently rely on stale memory.
- Do not assume campaign work runs in the background.
- Keep each run auditable enough that a human can inspect what happened and why.

## Current Limitations

- Worker roles are not yet true provider-backed parallel agents.
- Checkpoint resume is practical and conservative, not perfect process restoration.
- Changed-only indexing reports changed files, then performs a full refresh for correctness.
- Locks are process-local leases, not durable distributed locks.
- Rust patch authority and runtime HTTP auth hardening remain roadmap items.
