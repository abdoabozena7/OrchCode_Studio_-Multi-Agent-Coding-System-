# Provider-Backed Read-Only Swarm Workers

The swarm runtime can opt into provider-backed workers for read-only roles while preserving the existing mock worker as the default and fallback path.

## Modes

- `mock`: default. Uses the existing deterministic mock worker.
- `provider_read_only`: uses a configured provider for read-only roles and blocks when no provider is available.
- `auto`: uses a configured provider for read-only roles and falls back to mock workers when unavailable.

The runtime reads `HIVO_SWARM_WORKER_MODE` through orchestration config. Tests use fake providers only.

## Allowed Roles

Provider-backed workers are allowed only for read-only swarm roles such as scouts, planners, reviewers, tester-planners, reporters, risk analysts, architects, and specialist reviewers. Executor, repair, integrator, patch-producing, write-file, and command-executing work items are rejected before any provider call.

Tester-backed provider work is planning-only. It can recommend validation, but it does not mark validation as mechanically passed.

## Prompt And Output Flow

Each provider-backed worker invocation:

1. Runs the read-only guard.
2. Builds a minimal context summary or references the existing context pack.
3. Renders a versioned PromptSystem template for the role.
4. Runs PromptQualityGate before invocation.
5. Calls the provider only after the prompt passes.
6. Validates strict structured output schemas.
7. Stores raw and parsed output artifacts.
8. Records trace and SQLite metadata refs.

Free-form or schema-invalid provider output is not fed into execution-driving state.

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
  worker_result.json
```

Artifact contents remain on disk. SQLite stores refs and metadata only.

## Metadata And Trace

Provider worker invocations are recorded in `factory_worker_invocations` with prompt refs, quality refs, output refs, schema status, provider/model names, and status metadata.

Trace events include provider selection/unavailability, read-only guard pass/block, provider invocation start/completion/failure, output save/schema validation, worker result recording, and fallback to mock.
