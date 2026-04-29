# Agent Contracts

All agents must produce structured outputs. Agents must not write directly to the workspace, expose secrets, request dangerous commands, or bypass patch approval.

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
