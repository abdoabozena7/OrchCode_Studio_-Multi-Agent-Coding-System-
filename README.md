# Hivo Studio – Multi‑Agent Coding System  

**A self‑orchestrating, memory‑backed, safety‑first coding platform that turns many small LLM workers into a reliable software‑factory.**  

> **TL;DR** – Install, index the repository, start a campaign, and let the built‑in swarm planner staff the right number of narrow agents, enforce locks, run verification loops, and persist the results in `.agent_memory/`.  

---  

## Table of Contents  

| Section | Description |
|---------|-------------|
| [Project Overview](#project‑overview) | What the system does and why it matters |
| [Key Features](#key‑features) | Core capabilities of Hivo Studio |
| [Technologies & Architecture](#technologies‑&‑architecture) | Languages, runtimes and design pillars |
| [Getting Started](#getting‑started) | Install, build, and initialise the memory store |
| [Running a Campaign](#running-a-campaign) | Normal workflow – modes, commands and artefacts |
| [Memory & Indexing](#memory‑&‑indexing) | Persistent repository memory, inspection and maintenance |
| [Swarm Autopilot & Staffing](#swarm‑autopilot‑&‑staffing) | How the system decides the number & type of agents |
| [Safety & Verification](#safety‑&‑verification) | Locks, review loops, patch‑safety and approval gates |
| [Testing & Linting](#testing‑&‑linting) | Keeping the code‑base strict and type‑safe |
| [Contributing](#contributing) | Guidelines for extending the platform |
| [License](#license) | Open‑source terms |
| [References](#references) | Important docs (AGENTS.md, audit report…) |

---  

## Project Overview  

Hivo Studio is **not** a single “smart” LLM that pretends to be a large model.  
Instead, it **orchestrates many narrow agents** (LLMs, static analysers, test runners, etc.) that each receive a *tiny, well‑defined context pack* and produce deterministic, structured JSON output.  

The orchestration layer supplies:

* **Repository‑wide memory** (`.agent_memory/`) that is incrementally indexed and searchable.  
* **Campaign‑based execution** – a campaign is a series of safe, checkpointed steps that can be paused, inspected, and resumed.  
* **Swarm staffing heuristics** – the system automatically decides **how many** logical agents to spin up, what roles they play, and what executor caps apply.  
* **Safety‑first contracts** – file locks, review & validation loops, approval gates and deterministic patch‑fingerprints protect the code base.  

The overall goal is **a reliable, recursive software factory** that learns from every run while keeping all artefacts auditable.

---  

## Key Features  

| Feature | Description |
|---------|-------------|
| **Persistent Repository Memory** | Indexes every file under the repo, stores decisions, lessons, and run artefacts under `.agent_memory/`. |
| **Campaign & Mode System** | `deep` (default), `fast`, `exhaustive` – each mode tunes risk tolerance, staffing, and verification depth. |
| **Swarm Autopilot** | Self‑staffing up to 300 logical agents (read‑only only for scouts). Dynamic specialist creation based on detected risk (security, performance, UI, etc.). |
| **Structured Agent‑to‑Agent Communication** | JSON contracts containing file paths, evidential references, command results, and open risks. |
| **Verification Loop** | Review → Validation → Repair → Patch‑Safety → Human‑Approval before any write. |
| **Deterministic Artefact Store** | All run artefacts are stored under `.agent_memory/runs/<run‑id>/` and are fully version‑controlled. |
| **Cross‑Language Runtime** | Node/TypeScript for orchestration + Rust (Tauri) for desktop UI & SQLite persistence. |
| **CLI‑First Experience** | `npm run …` commands for memory, campaigns, trials, and agent debugging. |
| **Extensible Plugin Model** | New workers can be added by implementing the `IWorker` interface and publishing a context‑pack builder. |
| **Observability** | Event tracing, metrics dashboards, and automatic report generation for each campaign. |

---  

## Technologies & Architecture  

| Layer | Implementation | Notes |
|-------|----------------|-------|
| **Orchestrator Core** | `apps/agent-runtime/src/orchestration/Orchestrator.ts` (TypeScript) | Manages run creation, deterministic task graphs, context‑pack construction, and artefact persistence. |
| **Task Graph & Scheduler** | `TaskGraphManager.ts` & `SwarmScheduler.ts` | Handles state transitions, dependencies, and executor caps. |
| **Swarm Staffing Planner** | `SwarmStaffingPlanner.ts` | Heuristics based on repo index size, risk scores, and available commands. |
| **Memory / Index** | `RepoIndexer.ts`, `ProjectMemory.ts`, `memory/` folder | Incremental file indexing, schema‑versioned storage, compacting utilities. |
| **Verification Primitives** | `ReviewLoop.ts`, `ValidationRunner.ts`, `RepairLoop.ts`, `PatchSafety.ts`, `ApprovalGates.ts` | Enforce read‑only fan‑out, deterministic patches, multi‑stage approval. |
| **File Locks** | `FileLockManager.ts` | Logical lock objects persisted alongside the artefact store. |
| **Desktop UI (optional)** | Rust Tauri (`apps/desktop/src-tauri/`) | SQLite DB for long‑term run metadata; Rust‑owned patch authority (`patch.rs`). |
| **Testing & Type‑Safety** | `jest` + `tsc --noEmit --strict` | Full strict‑mode TypeScript; test suite covers memory, orchestration, and verification. |
| **Command‑Line Interface** | `agent` (bin) + NPM scripts | Unified entry point for campaigns, trials, inspection, and maintenance. |

---  

## Getting Started  

> **Prerequisites**  
> * Node.js ≥ 20 (LTS)  
> * npm ≥ 10  
> * (Optional) Rust ≥ 1.70 + Cargo for the desktop UI  

```bash
# 1️⃣ Clone the repository
git clone https://github.com/your-org/hivo-studio.git
cd hivo-studio

# 2️⃣ Install Node dependencies
npm ci

# 3️⃣ Build TypeScript sources
npm run build          # => ./dist/
```

### Initialise Repository Memory  

```bash
# Create the persistent memory folder (committed .gitkeep files are already present)
npm run memory:index          # Full first‑time index
npm run memory:index-status   # Verify freshness (should be "up‑to‑date")
```

> **Tip** – For large repos you can run an incremental refresh:  

```bash
npm run memory:index-refresh -- --changed-only
```

### Verify the Setup  

```bash
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit --strict
npm test                    # Run the unit‑test suite
```

If all commands succeed you are ready to launch a campaign.

---  

## Running a Campaign  

A **campaign** is a high‑level goal that may span many orchestrated runs.  
Typical lifecycle:

1. **Create** a campaign (stores goal, initial context, and metadata).  
2. **Plan** – the orchestrator builds a deterministic task graph.  
3. **Run** – workers are auto‑staffed, execute, and feed results back.  
4. **Pause / Inspect** – you can stop after any checkpoint, view artefacts, or adjust the plan.  
5. **Resume** – the system reconciles saved state with the latest repo index.  
6. **Report** – an auto‑generated markdown / JSON report summarises outcome, staffing, and lessons learned.  

### Example CLI Flow  

```bash
# 1️⃣ Start a new deep‑mode campaign
agent campaign start "Implement a new secure login flow" --mode deep

# 2️⃣ Inspect the generated plan
agent campaign show-plan

# 3️⃣ Execute the next safe step
agent campaign run-next

# 4️⃣ (Optional) Pause and inspect artefacts
agent campaign pause
agent memory:inspect --run <run-id>

# 5️⃣ Resume after a code change or memory refresh
npm run memory:index-refresh   # keep index fresh first
agent campaign resume

# 6️⃣ Generate a final report
agent campaign report > login-campaign-report.md
```

#### Modes & When to Use Them  

| Mode | Typical Use‑Case | Behaviour |
|------|----------------|-----------|
| **deep** (default) | Production‑grade work, security‑critical changes | Full verification, conservative staffing, all approval gates. |
| **fast** | Quick prototyping, low‑risk refactors | Minimal verification, higher‑risk staffing, skips exhaustive repair loops. |
| **exhaustive** | Large migrations, regulatory compliance | Max staffing, exhaustive trial runs, detailed metric collection. |

---  

## Memory & Indexing  

All **persistent artefacts** live under the hidden directory `.agent_memory/`.  

| Command | Purpose |
|--------|---------|
| `npm run memory:index` | Full repository scan and index creation (first‑time only). |
| `npm run memory:index-status` | Verify that the index matches the current repo state. |
| `npm run memory:index-refresh [--changed-only]` | Incremental refresh; `--changed-only` reports files that actually changed. |
| `npm run memory:compact` | Remove stale artefacts, compress JSON, and deduplicate decisions. |
| `npm run memory:inspect` | Browse stored decisions, run artefacts, and the memory schema. |
| `npm run memory:show-commands` | List all registered CLI commands a worker can invoke. |
| `npm run memory:status` | High‑level health: index freshness, size, last‑compact timestamp. |

**Never commit large generated memory files** – only the static schema files (`README.md`, `schema_version.json`) are version‑controlled.

### Memory Schema (high‑level)  

* `runs/<run-id>/` – JSON artefacts: `plan.json`, `patches.json`, `review.log`, `metrics.json`.  
* `decisions/` – Append‑only logs of “why we did X”.  
* `lessons/` – Successful patterns and failure analyses.  
* `swarm_trials/` – Results of `agent trial …` experiments.  

---  

## Swarm Autopilot & Staffing  

The swarm layer **self‑staffs** agents based on five signals:

1. **Repo size & change density** (from the index).  
2. **Task risk score** (security, performance, UI, test‑coverage heuristics).  
3. **Available command inventory** (e.g., `npm run lint`, `cargo test`).  
4. **Current campaign mode** (deep / fast / exhaustive).  
5. **Operator‑defined caps** (executor, write‑ability).  

**Key Guarantees**

* The default **read‑only fan‑out** never exceeds 300 logical agents; only a handful are write‑capable.  
* Dynamic specialists (security analyst, performance auditor, docs reviewer) are **created on‑demand** once evidence justifies them.  
* All staffing decisions are recorded in the artefact store and appear in the final campaign report.  

### Trial Commands (for developers)

```bash
# Evaluate staffing heuristics across scenario sizes
agent trial staffing-eval

# Stress‑test the scheduler with 300 mock agents (read‑only only)
agent trial scheduler-scale

# Compare three orchestration strategies on a sample goal
agent trial compare "Refactor data‑layer for multi‑tenant support"
```

All trial artefacts are stored under `.agent_memory/swarm_trials/`.

---  

## Safety & Verification  

Safety is baked into **every write path**:

| Component | Responsibility |
|-----------|----------------|
| **FileLockManager** | Logical per‑file lock objects; enforced before any patch is accepted. |
| **PatchSafety** | Diff‑based fingerprinting, ensures patches only touch declared sections. |
| **ReviewLoop** | Automatic static‑analysis + optional human reviewer; produces a deterministic `review.json`. |
| **ValidationRunner** | Executes unit/integration tests, type‑checks, lints; only passes on *full* success. |
| **RepairLoop** | If validation fails, creates a new “repair” work‑item that the swarm executes. |
| **ApprovalGates** | Configurable human‑approval checkpoint; required for any **write‑capable** agent. |
| **Executor Caps** | Upper bound on concurrent writers (default = 2) to avoid race conditions. |

> **Important:** A run is considered **verified** only when **all** gates are passed *and* the patch fingerprint matches the stored version. Any blocked or malformed JSON output aborts the run and is logged as an **unverified** status.

---  

## Testing & Linting  

```bash
# Run the full test suite (Jest + integration tests)
npm test

# Lint the codebase (ESLint + prettier)
npm run lint

# Type‑check with strict mode
npm run typecheck
```

**Test coverage focus**

* Memory/indexing behaviour  
* Command detection & context‑pack creation  
* Orchestration contracts (task graph, state transitions)  
* Verification logic (review, validation, repair)  

Add new tests whenever you extend a primitive – the project’s operating principle is “small, verifiable changes with focused tests”.

---  

## Contributing  

1. **Fork** the repository.  
2. Create a **feature branch** (`git checkout -b feat/your-feature`).  
3. Follow the **Operating Principles** from `AGENTS.md`:  
   * Small coherent changes, no massive rewrites.  
   * Preserve existing behaviour unless the task explicitly changes it.  
   * Keep TypeScript strict‑mode clean; ensure all new code runs through the verification pipeline.  
4. Add **unit / integration tests** that exercise the new logic.  
5. Update **memory docs** if you modify any contract or schema.  
6. Run the full CI locally (`npm run lint && npm run typecheck && npm test`).  
7. Submit a Pull Request – the CI will automatically run the swarm autopilot in `fast` mode to sanity‑check the change.  

### Documentation  

* `AGENTS.md` – the **operating handbook** for all contributors.  
* `AUDIT_RECURSIVE_AGENTIC_FACTORY_ALIGNMENT.md` – a self‑audit summarising the current alignment score; useful for roadmap planning.  

---  

## License  

This project is licensed under the **MIT License**. See `LICENSE` for details.

---  

## References  

* **AGENTS.md** – detailed operating principles, memory commands, campaign modes, swarm staffing, coding rules, and communication contracts.  
* **AUDIT_RECURSIVE_AGENTIC_FACTORY_ALIGNMENT.md** – a systematic audit (May 2026) that scores the repository on 10 alignment dimensions; highlights current strengths (orchestration primitives, memory, safety) and gaps (recursive teams, prompt‑writer agents, durable DB‑backed run state).  
* **Source Tree Highlights**  

```
apps/
 └─ agent-runtime/
     ├─ src/orchestration/
     │   ├─ Orchestrator.ts
     │   ├─ TaskGraphManager.ts
     │   ├─ ArtifactStore.ts
     │   ├─ ContextPackBuilder.ts
     │   ├─ ValidationRunner.ts
     │   ├─ ReviewLoop.ts
     │   └─ PatchSafety.ts
     └─ src/swarm/
         ├─ SwarmRuntime.ts
         ├─ SwarmScheduler.ts
         └─ SwarmStaffingPlanner.ts
apps/
 └─ desktop/src-tauri/
     ├─ src/db/mod.rs           # SQLite persistence
     └─ src/commands/patch.rs   # Rust‑owned patch authority
.agent_memory/
 ├─ README.md
 ├─ schema_version.json
 ├─ runs/
 └─ swarm_trials/
```

---  

*Happy coding! Let the swarm do the heavy lifting while you stay safely in control.*