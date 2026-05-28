# Phase 6 Swarm Autopilot Trial Lab Plan

## Current Swarm Autopilot Summary

Phase 5 introduced the internal Swarm Autopilot Runtime. The user still speaks to one agent through `agent run` and `agent plan`, while the system internally creates a `StaffingPlan`, logical agent templates, agent instances, work items, scheduler traces, metrics, consensus artifacts, and final reports under `.agent_memory/swarm_runs/`.

The current runtime already supports:

- automatic agent-count selection up to a maximum of 300 logical agents
- dynamic read-only/review-only specialist agents
- dependency-aware work items
- read/write separation
- executor caps for risky work
- file-lock-aware scheduling
- backpressure and repair work
- swarm metrics and scheduler traces

Phase 6 does not make user-selected agent count the product. Phase 6 measures whether the system chooses the right internal swarm shape without asking the user.

## What Needs To Be Measured

The Trial Lab must measure:

- staffing accuracy by task size and risk
- overstaffing and understaffing
- executor cap behavior for risky edits
- read-only ratio when scaling wide
- specialist selection precision and recall
- scheduler scale to 300 logical agents with mock workers
- conflict prevention through locks and write limits
- duplicate work rate
- useful finding rate
- repair and validation failure rates
- baseline vs orchestrated vs autopilot behavior
- cases where swarm work is unnecessary

## Automatic Staffing Eval Scenarios

Required scenarios:

1. Tiny HTML/Text Change
   - Expect tiny or small complexity, very small agent count, one executor, no unnecessary specialists, basic validation.

2. Small Bug Fix
   - Expect small count, one executor, one or two reviewers, tester when tests exist.

3. Medium Feature
   - Expect medium count, several scouts, one or more planners, limited executors, reviewers and testers.

4. Large Multi-Module Refactor
   - Expect large count, many scouts, multiple planners/architects, limited executors, many reviewers, strict validation, API compatibility reviewer when appropriate.

5. Huge Read-Only Architecture Scan
   - Expect high logical count when repo size justifies it, no executors, high read-only ratio, aggregation and consensus.

6. Risky Security/Auth Change
   - Expect security specialist, high or critical risk, executor cap, strict review, possible approval.

7. Database Migration Task
   - Expect migration/data-safety specialist, strict validation, executor cap, approval if risky.

8. Frontend Accessibility/UI Task
   - Expect accessibility/frontend review when evidence justifies it and small/medium staffing depending on scope.

9. Ambiguous Large Goal
   - Expect planning/reporting first, mostly read-only work, no broad writes, possible campaign recommendation.

10. Huge Campaign
   - Expect high internal count, staged/campaign recommendation, many scouts/reviewers/testers, few executors.

## Baseline Comparison Design

Comparison modes:

- `baseline-simple`: minimal direct/single-agent path.
- `orchestrated`: task graph and review without wide swarm.
- `autopilot-fast`: conservative automatic staffing.
- `autopilot-deep`: normal serious automatic staffing.
- `autopilot-exhaustive`: stronger exploration and review.
- `autopilot-huge-readonly`: high-capacity read-only scan when justified.

The comparison report must include selected staffing, validation results, conflicts, duplicate work, useful findings, final quality indicators, and a recommendation. The Trial Lab must not claim swarm is better unless measured indicators support that interpretation.

## Specialist-Agent Evaluation

Specialist evals verify:

- auth/security prompts create security specialists
- database migration prompts create migration/data-safety specialists
- UI prompts create accessibility/frontend reviewers when scope warrants it
- performance prompts create performance reviewers
- public API prompts create API compatibility reviewers
- simple tasks avoid unnecessary specialists
- specialists are read-only or review-only
- specialist creation appears in `StaffingPlan.reasoning`

## Scheduler Stress Design

Scale tests must use mock workers and avoid expensive real model calls:

- produce a justified high-capacity read-only `StaffingPlan`
- create and manage 300 logical `AgentInstance`s
- process 300 read-only `WorkItem`s
- prevent 300 executors
- respect executor caps and file locks
- record peak active agents
- write metrics and traces
- generate readable final reports

## Safety Constraints

- Users do not provide agent count by default.
- Trial commands must be read-only unless explicitly named `small-safe-fix`.
- Trial scale tests use mock agents by default.
- Dynamic specialists do not edit files.
- Executor count is capped separately from total logical agents.
- File locks and forbidden path checks remain active.
- Risky edits trigger approval-gate reporting instead of broad writes.

## Report Format

Each experiment writes JSON and Markdown:

- `experiment.json`
- `runs.json`
- `staffing_evaluations.json`
- `comparison_result.json`
- `tuning_policy.json`
- `trial_report.json`
- `trial_report.md`

Reports include:

- staffing accuracy
- usefulness
- safety
- comparison
- tuning recommendations

## Tuning Feedback Loop

The lab writes append-only memory:

- `swarm_staffing_lessons.jsonl`
- `swarm_tuning_history.jsonl`
- `swarm_failure_patterns.jsonl`
- `swarm_success_patterns.jsonl`
- `swarm_specialist_selection_history.jsonl`

One noisy experiment must not rewrite defaults. Recommendations include confidence and evidence counts, and future default changes should require repeated evidence.

## Validation Plan

Validation must run:

- existing test suite
- new trial/eval tests
- scheduler scale test with mock agents
- typecheck/build
- repo indexing and freshness status
- automatic staffing eval command
- architecture-scan trial command
- scheduler-scale trial command
- comparison command
- report and tuning artifact inspection

If any validation cannot run, the final report must state the attempted command and remaining risk.
