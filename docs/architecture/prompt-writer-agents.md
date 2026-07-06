# Controlled PromptWriter Agents

PromptWriter agents generate advisory prompt drafts and template input suggestions for factory orchestration roles. They are not recursive teams, executors, command runners, patch writers, or source-file writers.

## Modes

- `off`: PromptWriter agents do not run.
- `shadow`: PromptWriter agents run, artifacts and metadata are saved, and execution still uses the static PromptSystem prompt.
- `advisory`: PromptWriter recommendations are recorded for reports and metadata, but rendered prompts are not replaced.
- `gated_adopt`: PromptWriter suggestions can affect a rendered prompt only after schema validation, safety checks, PromptSystem rendering, PromptQualityGate, metadata consistency checks, and role adoption permission all pass.

The default mode is `shadow`.

## Safety Contract

PromptWriter output is structured JSON. Invalid schema, unsafe language, protected template input changes, weakened validation requirements, or blocked PromptQualityGate results prevent adoption. PromptWriter agents cannot modify allowed or forbidden file policy, run commands, write files, create patches, mark tasks complete, or claim validation passed.

PromptWriter semantic output must come from the configured provider through `ReasoningKernel`. Provider mode is limited to `provider_read_only` or `auto`; there is no runtime deterministic PromptWriter mode. If the provider is missing or fails, the run records a blocked raw artifact, schema failure, and rejected adoption decision; it does not synthesize deterministic prompt suggestions.

## Artifacts And Metadata

PromptWriter artifacts are stored under:

`.agent_memory/runs/<run_id>/prompt_writers/<task_id>/`

Artifacts include input JSON, raw output, parsed output, schema validation, candidate prompt, adoption decision, and summary. SQLite stores artifact refs and summary metadata only; it does not store full prompts or raw provider output.

Metadata tables:

- `factory_prompt_writer_outputs`
- `factory_prompt_writer_adoption_decisions`

Trace events use the unified factory trace stream with `prompt_writer_*` event types and retain the causal chain from context and planning evidence through candidate prompt rendering, quality gate, adoption evaluation, and static or adopted prompt invocation.
