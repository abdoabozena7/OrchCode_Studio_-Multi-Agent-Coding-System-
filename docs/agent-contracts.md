# Agent Contracts

All agents must produce structured outputs. Agents must not write directly to the workspace, expose secrets, request dangerous commands, or bypass patch approval.

Agents may use [ACP](architecture/agent-compact-protocol.md) for compact dispatch, handoff, and status envelopes. ACP messages carry references to durable structured outputs; they do not replace schema validation, review gates, or auditable artifacts.

## Orchestrators

### Product Orchestrator

- Input: user prompt, optional workspace summary, project info.
- Output: `ProductBrief`.
- Role: clarify goal, intent, scope, constraints, success criteria, assumptions, and essential questions.
- Forbidden: over-scoping, direct implementation, file writes.

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
