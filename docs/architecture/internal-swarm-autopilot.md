# Internal Swarm Autopilot

Phase 5 adds an internal Swarm Autopilot Runtime to the TypeScript agent runtime. The user still talks to one coding agent. The system internally decides whether to use a small or large logical swarm, which roles are needed, how much write authority is safe, and how much review and validation are required.

The main user-facing commands stay simple:

- `agent run "<goal>"`
- `agent plan "<goal>"`
- `agent inspect-run <run_id>`
- `agent report <run_id>`
- `agent resume <run_id>`

Swarm-specific commands exist for debugging and audit only:

- `swarm inspect <run_id>`
- `swarm staffing-plan <run_id>`
- `swarm scheduler-trace <run_id>`
- `swarm metrics <run_id>`

Phase 6 adds Trial Lab commands for measurement and tuning:

- `agent trial staffing-eval`
- `agent trial architecture-scan`
- `agent trial test-discovery`
- `agent trial compare "<goal>"`
- `agent trial small-safe-fix "<goal>"`
- `agent trial huge-readonly-scan`
- `agent trial scheduler-scale`

These are not manual agent-count controls. They evaluate whether the autopilot chose a sensible internal shape.

## User Model

The user does not choose an agent count by default. A request such as "implement this feature" enters the Swarm Autopilot as one goal. The runtime analyzes the goal, repository index, likely files, command inventory, stale-index state, risk signals, and previous failures, then creates a `StaffingPlan`.

`300` is the maximum internal logical capacity. It is not the default and not a normal UX control. High counts are reserved for justified read-only exploration, review, validation, and whole-repo mapping. Write-capable workers are capped separately.

## Runtime Visualization

The desktop Swarm Dock renders the session-owned `swarmState` as a layered projection of real runtime records. The center is the session goal, first-ring nodes are role or runtime groups, second-ring nodes are real coordinator, worker, specialist, or aggregator agent instances, and outer nodes are work items or gates such as review, test, validation, conflict, and integration checks. Group, work-item, and gate nodes are visualization helpers only; they do not count toward `effectiveTotalLogicalAgents` and they do not accept scoped messages. A 300-agent run is therefore displayed across groups and work records instead of as 300 direct root children.

## StaffingPlan

`SwarmStaffingPlanner` emits a structured `StaffingPlan` with:

- task complexity: `tiny`, `small`, `medium`, `large`, or `huge`
- repo scope: `single_file`, `few_files`, `single_module`, `multiple_modules`, or `whole_repo`
- risk level: `low`, `medium`, `high`, or `critical`
- recommended total logical agents
- max parallel agents
- role counts and specialist agents
- executor, reviewer, tester, and write-agent limits
- read-only ratio
- validation level
- human-approval requirement
- reasoning, confidence, downgrade conditions, and escalation conditions

Default behavior:

- Tiny: 3-5 logical agents, usually scout, executor, reviewer, optional tester, and reporter.
- Small: 5-8 logical agents, one executor, one planner, one or two reviewers, focused validation.
- Medium: 12-25 logical agents, several scouts, planners, one architect, one to three executors, reviewers, testers, and an integrator.
- Large: 40-120 logical agents, many scouts/reviewers/testers, a small executor pool, and specialists when evidence justifies them.
- Huge: 120-300 logical agents only for whole-repo or campaign-grade work, with most agents read-only.

## Dynamic Specialists

`SpecialistAgentFactory` creates temporary read-only or review-only templates when evidence justifies them:

- `AuthSecurityReviewerAgent`
- `AccessibilityReviewerAgent`
- `MigrationSafetyReviewerAgent`
- `PerformanceReviewerAgent`
- `APICompatibilityReviewerAgent`
- `DependencyUpgradeReviewerAgent`
- `TestCoverageReviewerAgent`
- `DocumentationReviewerAgent`

Specialists do not edit files by default. A simple HTML text change does not create UI specialists unless accessibility or broader UI risk is present.

## Scheduler

`SwarmScheduler` executes `WorkItem`s from the plan. It is:

- Dependency-aware: dependencies must succeed before a work item can run.
- Role-aware: work items are leased to matching logical `AgentInstance`s.
- File-lock-aware: write work requests locks through `OrchestrationFileLockManager`.
- Risk-aware: high and critical risk reduce executor concurrency.
- Staffing-plan-aware: role counts, parallel limits, and executor limits are obeyed.
- Resource-aware: parallelism is adapted from the staffing plan, run scheduler config, local CPU availability, and scheduler health.
- Backpressure-aware: failures, invalid structured outputs, and slow batches reduce parallelism or executor concurrency and create retries or repair items.
- Aging-aware: repeatedly deferred ready work gains scheduling priority so lower-priority items are not starved by retry-heavy work.
- Read/write separated: read-only work can fan out widely; write work stays narrow.
- Explainable: scheduling decisions are written to `scheduler_trace.jsonl`.

The adaptive scheduler is still a single-process worker pool. Logical agents are leased concurrently inside the TypeScript runtime when capacity allows, but they are not OS processes, threads, distributed workers, RabbitMQ consumers, or Kafka consumers. Distributed queues remain a future architecture option, not part of this runtime slice.

## Fan-Out And Fan-In

Scout fan-out splits repository exploration by file clusters from the repository index. Evidence fan-in aggregates scout outputs into relevant files, risks, test recommendations, unknowns, and confidence. Planner and review fan-out can produce multiple perspectives. Integration fan-in accepts only reviewed and validated work, and consensus groups preserve dissenting findings.

## Artifacts

Swarm artifacts are written under:

`.agent_memory/swarm_runs/<swarm_run_id>/`

Key files:

- `swarm_run.json`
- `staffing_plan.json`
- `scheduler_config.json`
- `agent_templates.json`
- `agent_instances.json`
- `work_items.json`
- `leases.json`
- `events.jsonl`
- `scheduler_trace.jsonl`
- `metrics.json`
- role result directories
- `consensus/`
- `final_report.md`

The final report explains what the user asked for, how many internal agents were selected, why that number was chosen, role distribution, executed work, review and validation, changed files, risks, and limitations.

## Safety

Write-capable agents are always a small subset of total logical agents. Dynamic specialists are read-only by default. Forbidden paths such as `.agent_memory`, `.git`, `node_modules`, build folders, and `.env` are rejected for writes. Overlapping writes are blocked by file locks. High-risk files can trigger human approval. Validation failures create repair work instead of silently integrating broken output.

## Current Limits

The Phase 5 scheduler and stress tests use test-only scripted workers where needed so scale tests do not perform expensive model calls. Logical agents are scheduling units; they do not map one-to-one to OS processes or external model sessions. Real provider-backed workers can be attached behind the same `SwarmWorker` interface.

## Trial Lab

The Swarm Autopilot Trial Lab records experiments under `.agent_memory/swarm_trials/<experiment_id>/`. Each experiment can write:

- `experiment.json`
- `runs.json`
- `staffing_evaluations.json`
- `comparison_result.json`
- `tuning_policy.json`
- `trial_report.json`
- `trial_report.md`

The lab measures staffing accuracy, baseline-vs-autopilot tradeoffs, specialist selection, scheduler scale, safety behavior, duplicate work, useful findings, and tuning recommendations. Durable learning records are appended to `swarm_staffing_lessons.jsonl`, `swarm_tuning_history.jsonl`, `swarm_failure_patterns.jsonl`, `swarm_success_patterns.jsonl`, and `swarm_specialist_selection_history.jsonl`.

Trial reports should be read as evidence. A single failed or successful run should not permanently change defaults without repeated, confidence-backed patterns.
