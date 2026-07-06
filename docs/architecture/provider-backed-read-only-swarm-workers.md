# Provider-Backed Read-Only Swarm Workers

The swarm runtime uses provider-backed workers for read-only roles. There is no runtime-selectable mock or local semantic fallback path for these workers.

## Mode

- `provider_read_only`: uses a configured provider for read-only roles and blocks when no provider is available.

Tests may use private scripted providers, but runtime configuration only accepts provider-backed read-only workers.

## Allowed Roles

Provider-backed workers are allowed only for read-only swarm roles such as scouts, planners, reviewers, tester-planners, reporters, risk analysts, architects, and specialist reviewers. Executor, repair, integrator, patch-producing, write-file, and command-executing work items are rejected before any provider call.

Tester-backed provider work is planning-only. It can recommend validation, but it does not mark validation as mechanically passed.

## Prompt And Output Flow

Each provider-backed worker invocation:

1. Runs the read-only guard.
2. Requires a ready intent frame with the exact original prompt, intent contract, and work item task slice.
3. Builds a minimal context summary or references the existing context pack.
4. Renders a versioned PromptSystem template for the role.
5. Runs PromptQualityGate before invocation.
6. Calls the provider only after the prompt passes.
7. Validates strict structured output schemas, including `intent_alignment`.
8. Runs `IntentHandoffGate` before returning success to the scheduler.
9. Stores raw and parsed output artifacts.
10. Records trace and SQLite metadata refs.

Free-form, schema-invalid, or intent-unanchored provider output is not fed into execution-driving state.

## Artifacts

Provider worker artifacts live under the existing swarm run layout:

```text
.agent_memory/swarm_runs/<run_id>/provider_workers/<work_item_id>/
  context_summary.json
  prompt.md
  prompt_quality.json
  raw_output.md
  parsed_output.json
  schema_validation.json
  intent_handoffs/<work_item_id>/handoff_gate.json
  worker_result.json
```

Artifact contents remain on disk. SQLite stores refs and metadata only.

## Metadata And Trace

Provider worker invocations are recorded in `factory_worker_invocations` with prompt refs, quality refs, output refs, schema status, provider/model names, and status metadata.

Trace events include provider selection/unavailability, read-only guard pass/block, provider invocation start/completion/failure, output save/schema validation, and worker result recording.
