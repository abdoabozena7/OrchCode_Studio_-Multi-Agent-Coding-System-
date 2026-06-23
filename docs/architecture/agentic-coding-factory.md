# Agentic Coding Factory Architecture

Hivo is an orchestration-first coding system. It keeps small worker agents reliable by surrounding them with repository memory, narrow task scopes, structured outputs, review, verification, repair, and durable artifacts.

## Core Layers

1. Memory and indexing
   - `.agent_memory/repo_index.json` stores layout, important files, entrypoints, and role guesses.
   - `.agent_memory/file_manifest.json` stores hashes and mtimes for freshness checks.
   - `.agent_memory/symbol_index.json` stores heuristic imports, exports, classes, functions, and types.
   - `.agent_memory/command_inventory.json` stores detected test, lint, typecheck, build, smoke, and run commands.
   - `.agent_memory/project_intelligence.json` stores dependency graph, reverse dependencies, test-to-source mapping, command-to-area mapping, module map, entrypoint map, and risk map.
   - `.agent_memory/project_specs/` stores active and historical `ProjectGoalSpec` artifacts. The active spec defines non-negotiable product intent, non-goals, tradeoffs, constraints, accepted examples, and rejected examples.
   - learning files store decisions, lessons learned, failed attempts, successful patterns, glossary terms, and architecture notes.

2. Orchestrator and task graph
   - `CoreOrchestrator` turns a request into Scout, Planner, Executor, and Reporter tasks.
   - `TaskGraphManager` enforces status transitions, dependencies, and persisted task state.
   - Context packs include only relevant snippets, constraints, allowed edit scope, validation requirements, prior decisions, and warnings.
   - When an active `ProjectGoalSpec` exists, every context pack includes it as `project_goal_spec` context plus the constraint: do not propose or accept changes that contradict the active spec without human approval.
   - When a task or read-only worker is assigned to an `AgentTeam`, context packs carry team scope metadata, inherited parent constraints, memory-scope refs, planning evidence links, durable lock context, and explicit fallback warnings without changing task execution order.
   - Medium and multi-plan runs can produce read-only `TeamSubPlan` artifacts after AgentTeam proposal. These scoped sub-plans summarize team assumptions, task drafts, risks, dependencies, evidence, memory refs, lock context, and validation strategy, then aggregate them into a recursive planning summary without creating executor tasks or changing scheduling.
   - Team sub-plan task drafts can pass through a task adoption gate that records `AdoptedTaskProposal` metadata and readiness decisions. These proposals can be represented in a separate proposed task graph, but proposed nodes are explicitly non-executable and do not schedule work or grant write authority.

3. Roles
   - ScoutAgent, ArchitectAgent, PlannerAgent, ExecutorAgent, ReviewerAgent, TesterAgent, IntegratorAgent, and ReporterAgent are registered with allowed/forbidden operations and output contracts.
   - Phase 4 actively wires the Scout, Planner, Executor, and Reporter path. ExecutorAgent still routes through the existing `SeniorCodingAgent` mock provider path.

4. Safety, review, and verification
   - Executor outputs must validate as structured data.
   - Patch proposals pass scope checks, forbidden-file checks, fingerprinting, review, approval gates, and validation.
   - File locks prevent overlapping edit scopes during a run.
   - `GoalSteward` runs before integration conflict handling when an active `ProjectGoalSpec` exists. It asks the configured provider, through the `ReasoningKernel`, whether candidates align with the spec. Deterministic code only enforces the provider-authored result and records `goal_spec_conflict`, `goal_change_requires_approval`, `goal_spec_missing`, or `goal_steward_unavailable` conflicts.
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
  goal_steward/
  repairs/
  locks/
  teams/
  metrics/
  reports/
```

Project goal specs live outside individual runs so future workers inherit the same guardrail:

```text
.agent_memory/project_specs/<spec_id>/
  project_goal_spec.json
  project_goal_spec.md
```

Goal Steward reviews are run artifacts:

```text
.agent_memory/runs/<run_id>/goal_steward/<review_id>/
  goal_steward_review.json
  goal_steward_review.md
```

Team context artifacts live under the run `teams/` directory:

```text
.agent_memory/runs/<run_id>/teams/
  team_context_scope_<team_id>.json
  team_context_summary_<team_id>.md
  team_memory_query_<query_id>.json
```

Read-only recursive team planning artifacts live under `teams/sub_plans/`:

```text
.agent_memory/runs/<run_id>/teams/sub_plans/
  team_sub_plan_<team_id>_<sub_plan_id>.json
  team_sub_plan_summary_<team_id>_<sub_plan_id>.md
  sub_plan_aggregation_<aggregation_id>.json
  sub_plan_aggregation_summary_<aggregation_id>.md
```

Task adoption gate artifacts live under `teams/task_adoption/`:

```text
.agent_memory/runs/<run_id>/teams/task_adoption/
  adoption_request_<id>.json
  adopted_task_proposal_<id>.json
  rejected_task_draft_<id>.json
  readiness_result_<id>.json
  adoption_summary_<id>.json
  adoption_summary_<id>.md
```

Proposed task graph artifacts live under `task_graph/proposed/`:

```text
.agent_memory/runs/<run_id>/task_graph/proposed/
  proposed_task_graph_<id>.json
  proposed_task_nodes_<id>.json
  proposed_task_edges_<id>.json
  proposed_task_graph_validation_<id>.json
  proposed_task_graph_summary_<id>.md
```

Proposed task graph nodes are planning records only. They can represent adopted metadata-only drafts, read-only-ready drafts, future write candidates, blocked drafts, duplicates, dependency hints, shared scopes, and lock relationships, but they are never scheduled or granted write authority by this layer.

Execution readiness approval artifacts live under `execution_readiness/`:

```text
.agent_memory/runs/<run_id>/execution_readiness/
  readiness_batch_<id>.json
  readiness_decision_<id>.json
  approval_requirement_<id>.json
  readiness_summary_<id>.md
  dry_run_prompt_check_<id>.json
  context_preview_<id>.json
```

The execution readiness gate evaluates proposed graph nodes for context, prompt, validation, success criteria, lock metadata, review policy, integration readiness, and human approval requirements. It is an approval-readiness layer only: it does not schedule nodes, create executable tasks, acquire locks, invoke workers, run validation commands, or apply integration candidates.

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
- Do not treat team context, team sub-plans, or adopted task proposals as recursive execution authority; teams currently scope memory, context, read-only planning, and metadata-only future task proposals.
- Keep each run auditable enough that a human can inspect what happened and why.

## Current Limitations

- Recursive team execution is not enabled; AgentTeams currently provide metadata-first context, memory boundaries, read-only recursive planning summaries, and non-executable adopted task proposal records.
- Checkpoint resume is practical and conservative, not perfect process restoration.
- Changed-only indexing reports changed files, then performs a full refresh for correctness.
- Locks are process-local leases, not durable distributed locks.
- Rust patch authority and runtime HTTP auth hardening remain roadmap items.
