# Add An Agent Role

Agent roles live in `apps/agent-runtime/src/orchestration/RoleRegistry.ts`.

## Required Contract

Each role must define:

- `name`
- `purpose`
- `allowed_operations`
- `forbidden_operations`
- `default_prompt`
- `expected_output_schema`
- `can_edit_files`
- `can_run_commands`
- `review_required`
- `required_output_format`
- `success_criteria`

Machine-consumed outputs must validate through `StructuredOutputs.ts`. Add or extend a schema before wiring the role into the orchestrator.

## Safety Rules

- Read-only roles must not edit files or run commands.
- Editing roles must receive `allowed_files_to_edit` and `forbidden_files`.
- Editing roles must produce a patch proposal or be wrapped by before/after diff capture.
- Risky files should trigger approval gates.
- Validation and review artifacts must be written before integration.

## Wiring Steps

1. Add the role to `AgentRoleName` if it is new.
2. Add the registry entry in `RoleRegistry.ts`.
3. Add or reuse a structured output schema.
4. Build a context pack section only if the role needs additional context.
5. Add orchestrator invocation logic.
6. Add tests for role registry, structured output validation, safety behavior, and artifact output.

## Tests To Add

- role exists in the registry
- invalid output is rejected or repaired
- role cannot perform forbidden operations
- context pack stays bounded
- run events and artifacts are written
- final report includes the role result or limitation
