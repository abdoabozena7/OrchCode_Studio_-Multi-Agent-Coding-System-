# Agent / Swarm Audit

## Reality
- Multi-agent swarm is a real scheduler/artifact/planner subsystem.
- Default workers are mock/logical. `SwarmScheduler` constructor defaults to `defaultMockWorker`.
- A 300-agent trial means 300 logical scheduler entries, not 300 model calls or OS workers.
- Specialist agents are descriptors and role counts unless a real worker is injected.
- Consensus is synthesized from review work-item statuses, not an independent deliberation among provider-backed agents.
- Swarm is not connected to the main desktop inspect/explain path.

## Commands Run
- `agent trial staffing-eval`: passed; 10 scenarios; uses mock agents.
- `agent trial scheduler-scale`: passed; 300 logical agents; executor peak 0; mock read-only work.
- `agent trial compare`: passed; comparison metrics are heuristic/synthetic.
- `agent plan "Explain architecture without editing"`: passed; produced 9 logical agents and one DocumentationReviewerAgent descriptor.

## Useful Today?
Useful for planning artifacts, repo-scale heuristic scans, and exercising scheduler constraints. Not useful as real provider-backed multi-agent understanding in the desktop product today.

## Real-vs-Mock Worker Matrix
| Worker/role | Real file reads | Provider-backed | Writes | Main UI path | Status |
| --- | --- | --- | --- | --- | --- |
| Scout/Planner/Reviewer in swarm scheduler | Through work item metadata/index, not active deep read by default worker | No | No | No | Mock/test-only |
| Specialist descriptors | Triggered from goal/file evidence | No | No, read_only=true | No | Real but not wired to main path |
| RunEngine inspect/explain read lanes | Yes | Attempts provider, fallback deterministic | No | Yes through runtime submit | Partial |
| Rust command executor | Yes, executes commands | No | Command side effects | Yes | Real and wired |
