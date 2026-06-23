# Agent Contracts

All agents must produce structured outputs. Agents must not write directly to the workspace, expose secrets, request dangerous commands, or bypass patch approval.

Agents may use [ACP](architecture/agent-compact-protocol.md) for compact dispatch, handoff, and status envelopes. ACP messages carry references to durable structured outputs; they do not replace schema validation, review gates, or auditable artifacts.

## Intent Handoff Gate

Every worker invocation must receive an `AgentIntentInputFrame` containing the exact original user request, the ready `IntentContract`, locked definitions, ledger refs, and the current task slice. Downstream summaries are never a substitute for this frame.

Every successful worker output must include `intent_alignment` with:

- how the worker understood its task,
- how the output serves the original user goal,
- possible conflicts with the intent contract,
- assumptions used,
- refs/hash tying the output to the original request, contract, and task slice.

The `IntentHandoffGate` blocks outputs whose alignment is missing, points at the wrong original request hash or task slice, declares unresolved conflicts, or receives a provider-backed intent review other than `aligned`. Blocked outputs may be stored for audit, but they must not unblock dependencies, enter integration, or contribute patch/command handoffs.

## User Intent Compiler Gate

Every planning-capable run/session must first compile a provider-authored `intent_contract.json` under that run's artifact area, for example `.agent_memory/runs/<run_id>/intent/intent_contract.json` or `.agent_memory/swarm_runs/<run_id>/intent/intent_contract.json`.

No Product Orchestrator, planner, swarm staffing step, task graph builder, prompt writer, worker, or legacy orchestration path may start planning unless the latest contract has `status: "ready"`. Missing contracts, invalid contracts, provider-unavailable shells, and contracts with blocking missing questions stop planning and record the block in artifacts/events/reports.

The contract preserves `original_user_request` exactly, provides `precise_rewrite` for downstream planning objectives, records assumptions, missing questions, tradeoffs, priority scores, definition of done, non-goals, and conflict rules. Agents must carry `intent_contract_ref` and `intent_contract_status` in context packs, prompt-writer inputs, planning evidence, and reports.

## Orchestrators

### Product Orchestrator

- Input: ready `IntentContract`, optional workspace summary, project info.
- Output: `ProductBrief`.
- Role: clarify goal, intent, scope, constraints, success criteria, assumptions, and essential questions.
- Forbidden: raw prompt semantic inference, over-scoping, direct implementation, file writes.

### Business Orchestrator

- Input: `ProductBrief`, project info.
- Output: `BusinessBrief`.
- Role: define MVP, out-of-scope items, user value, risks, acceptance criteria, priority, release notes.
- Forbidden: adding unrelated product scope.

### Engineering Orchestrator

- Input: `ProductBrief`, `BusinessBrief`, project map, git/workspace context.
- Output: `TechnicalPlan` with `TaskGraph`.
- Role: deterministic decomposition, worker selection, dependency ordering, file locks, tests, review gates.
- Forbidden: free-form scheduling, conflicting parallel file work.

### Goal Steward

- Input: active `ProjectGoalSpec`, candidate task objectives, candidate summaries, changed files, and patch/change refs.
- Output: `GoalStewardReview` with `aligned`, `conflicts_with_spec`, `requires_human_approval`, `insufficient_spec`, or `provider_unavailable`.
- Role: provider-authored arbitration of whether integration candidates contradict the formal project goal, before locks or apply.
- Forbidden: applying patches, creating repair loops, inventing a local semantic fallback, or changing the project spec without operator approval.

## Workers

### CodebaseMapperAgent

- Output: project map.
- Tools: read-only workspace listing/search/project summary.
- Forbidden: reading secret-like files.

### ArchitectAgent

- Output: technical design notes.
- Tools: project map and briefs.
- Forbidden: patching directly or expanding scope without justification.

### RustBackendAgent

- Output: backend impact notes or patch proposal.
- Tools: patch proposal only for Rust/Tauri changes.
- Forbidden: unsafe local filesystem or command logic.

### FrontendAgent

- Output: React/TypeScript patch proposal.
- Tools: patch proposal only.
- Forbidden: direct writes, unrelated visual rewrites.

### ToolingTerminalAgent

- Output: command requests.
- Tools: command risk classifier.
- Forbidden: dangerous commands and unapproved medium commands.

### TestAgent

- Output: test plan and safe command requests.
- Tools: command request flow.
- Forbidden: running commands directly.

### SecurityAgent

- Output: `ReviewResult`.
- Tools: patch and command metadata.
- Forbidden: approving dangerous command requests or secret-like file changes.

### ReviewerAgent

- Output: final `ReviewResult`.
- Tools: worker outputs, patch proposals, merge conflict summary.
- Forbidden: nitpicking; focus on real correctness, consistency, maintainability, and readiness risks.
# Decision Pipeline Contract

Every request carries a provider-required `ReasoningKernel v2` trace from understanding through the final decision. The provider owns semantic understanding, adaptive `ReasoningStep` selection, planning, patch intent, claims, and final assistant prose, but it cannot create evidence, approve unknown citations, widen write authority, or bypass approval gates.

The final decision action is one of `ANSWER`, `FOLLOW_UP`, `REFUSE`, or `ESCALATE`. Each answer records `TurnUnderstanding`, steps, tool results, hashed evidence refs, verifier results, provider request refs, reasoning attempts, repair attempts, stage budgets, information-gain progress, structured repair errors, index readiness, budget usage, and `finalResponseSource: provider`. Provider failure records `terminalFailure`, leaves `finalResponseSource: none`, and creates no assistant message.

Runtime-selectable mock/demo providers, local semantic fallbacks, canned assistant responses, deterministic plans or patches, and answer caches are forbidden. Test suites may use private scripted provider fixtures that cannot be selected by runtime configuration.

All production provider calls must pass through the `ReasoningKernel` gateway. Safe read tools may run in parallel; stateful command and patch requests run serially and stop at Rust/operator approval. An `ANSWER` requires deterministic evidence validation plus an independent provider verdict. Only exact router/author/verifier/embedding profiles with a passing adaptive-reasoning certification record may use the v2 action lane or claim the 80% guarantee.

## Project Understanding Contract

Deep project questions use a `QuestionDecomposition`, bounded `InvestigationAction` records, and a `ClaimLedger`. Every material claim must be supported by allow-listed current-workspace evidence. Missing user intent may produce `FOLLOW_UP`; discoverable evidence gaps may produce one provider-backed read-only `ESCALATE`; unsupported claims after bounded repair or escalation produce `REFUSE`. Read-only swarm output is advisory and cannot bypass claim validation, evidence freshness, or deterministic path safety.
