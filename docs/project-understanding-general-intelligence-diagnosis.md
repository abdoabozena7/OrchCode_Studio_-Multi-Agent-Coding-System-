# Project Understanding General Intelligence Diagnosis

Date: 2026-06-03

This is a current-state architectural diagnosis of why Hivo Studio can still fail deep, arbitrary, project-specific questions even though it is designed as an LLM-backed agentic coding system.

The example questions about DBSCAN, Fuzzy C-Means, drift detection, offers, and orchestrator rules are symptoms only. The correct diagnosis is not "add a DBSCAN composer" or "add a re-cluster fallback." The architectural issue is that inspect/project-question mode does not yet have one general provider-backed project-understanding layer that can build, refine, validate, and reuse a real model of the codebase.

The current system has useful pieces: provider calls, evidence hygiene, read lanes, concept grounding, a project intelligence graph, an agentic task kernel, provider-backed swarm workers, and memory indexing. But the inspect answer path is still mostly a linear, locally controlled pipeline:

1. classify and clean the prompt
2. build a workspace report
3. select concepts and evidence with lexical/rule-based mechanisms
4. ask the provider to draft from that selected evidence
5. validate the provider answer against local rules
6. stop with a notice when the provider fails or validation rejects the answer

That pipeline is safer than pretending to understand, but it is not yet deep project comprehension.

## Exact Current Path From User Question To Final Answer

1. The desktop app normally requires a valid provider for real runs and creates a `real_provider` session unless the prompt asks for demo/mock behavior. This mode is selected in `apps/desktop/src/app/App.tsx` around the session creation path.
2. `AgentRuntime.runTurn` receives the message and creates provider telemetry before any normal workspace reasoning starts.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:99`
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:128`
3. A local `ConversationUnderstanding` is created before `ToolRegistry`, project summary, provider, or intake.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:135`
4. If the pre-retrieval intent is `direct_conversation`, the runtime returns a local direct-conversation response and never reads the workspace or calls the provider.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:138`
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:258`
5. Otherwise the runtime creates `ToolRegistry`, builds a project summary/map, and resolves execution mode.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:141`
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:150`
6. If execution mode is `orchestrated_mode` and session mode is `real_provider`, the runtime stops before deterministic orchestration workers run.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:160`
7. For simple/inspect/project questions, the runtime creates the provider only after routing and then enters `RunEngine`.
   - `apps/agent-runtime/src/runtime/AgentRuntime.ts:215`
8. `RunEngine.runInspectExplainTurn` builds an enriched project map, shared understanding, and local progress stages.
   - `apps/agent-runtime/src/runtime/RunEngine.ts:966`
   - `apps/agent-runtime/src/runtime/RunEngine.ts:976`
9. `buildLargeProjectExplainReport` scans the workspace, samples files, creates report sections, module maps, evidence refs, data flow text, and context-pack metadata.
   - `apps/agent-runtime/src/runtime/RunEngine.ts:983`
   - `apps/agent-runtime/src/runtime/LargeProjectContextBuilder.ts:184`
10. `RunEngine` calls `answerUniversalProjectQuestion` and, in real-provider mode, explicitly uses `providerFailureSynthesis: "notice_only"`.
    - `apps/agent-runtime/src/runtime/RunEngine.ts:1004`
    - `apps/agent-runtime/src/runtime/RunEngine.ts:1010`
11. `answerUniversalProjectQuestion` prepares the prompt, infers topic/intent, optionally runs the agentic task kernel as diagnostic/augmenting evidence, lists files, filters evidence paths, builds read lanes, collects facts, builds lexical searches, builds a project intelligence graph, extracts implementation evidence, and resolves concept evidence.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:375`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:384`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:400`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:411`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:423`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:433`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:438`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:453`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:465`
12. The universal engine augments the project report and calls `explainProjectWithLlm`.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:516`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:520`
13. In `notice_only` mode the final provider answer uses natural text, not structured JSON, and concept-not-found cannot become final before provider authority.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:524`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:525`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:526`
14. `explainProjectWithLlm` builds evidence items, grounds the question, selects up to 45 evidence items for natural text, calls `provider.generateText`, validates the result, asks for a revision if needed, then optionally expands repair evidence up to 75 items and asks for one more revision.
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:73`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:75`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:91`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:94`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:103`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:108`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:127`
15. If the provider fails in `notice_only`, `explainProjectWithLlm` returns a provider failure notice. If validation never passes, it returns `provider_answer_failed_local_validation`.
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:97`
    - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:164`
16. Back in `answerUniversalProjectQuestion`, provider failure or provider validation failure becomes a no-synthesis notice.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:540`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:545`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:555`
17. Additional local validators run over answer shape, concept coverage, language, target evidence, mechanism coverage, read-lane evidence, stale canned templates, and citations.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:579`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:591`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:598`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:602`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:608`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:614`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:622`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:717`
18. If validation errors remain in real-provider notice-only mode, the system again returns a provider validation notice instead of local synthesis.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:624`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:635`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:670`
19. The final result includes evidence provenance and an explicit answer strategy such as `provider_final`, `provider_validation_notice`, `provider_failed_notice`, `local_synthesis_after_provider_failure`, or `agentic_kernel_after_provider_fallback`.
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:742`
    - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:829`

## Provider Output Failure Points

| Failure point | Files/functions | Trigger conditions | Failure mechanism | Downstream impact | Architectural consequence |
| --- | --- | --- | --- | --- | --- |
| Provider unavailable or timed out | `OllamaProvider.generateText`, `OllamaProvider.generateStructured` in `apps/agent-runtime/src/llm/OllamaProvider.ts:18` and `apps/agent-runtime/src/llm/OllamaProvider.ts:41` | Slow local model, bad endpoint, missing response content, malformed JSON in structured paths | Throws `real_provider.timeout`, `real_provider.invalid_json`, `real_provider.unreachable`, or malformed response errors | `LlmProjectExplainer` returns provider failure notice in notice-only mode | The system stops instead of using the provider as a partner in iterative investigation |
| Provider answer lacks accepted refs | `validateProjectExplainResponse` in `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:644` | Natural answer has no `hivo-file` links, unknown refs, ungrounded plain path refs, or cites refs outside selected evidence | Validation errors block acceptance | Universal engine returns `provider_validation_notice` in real-provider mode | A valid high-level answer can be discarded if the local evidence pack was too narrow |
| Provider answer cites evidence but not the locally required concept | `validateProjectExplainResponse` in `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:699` | The cited refs do not support the locally selected concept, or missing evidence groups are detected | Concept support and evidence-group validation rejects the answer | Revision attempts may still fail because they receive only selected evidence, plus bounded repair evidence | The provider cannot correct a wrong local concept selection unless the right evidence was already in the report |
| Provider answer misses project identity/domain | `validateProjectExplainResponse` in `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:751` | Local grounding decides project context is required and the answer does not cite domain refs | Validation rejects or warns | Final answer becomes notice or revision loop | Validation optimizes for answer-shape/domain contract before checking whether the user actually needed that shape |
| Provider natural-text repair is bounded to existing report refs | `selectRepairEvidenceItems` in `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:582` | First answer and normal revision fail validation | Repair can expand from 45 to 75 refs but only from the already-built report | No new filesystem read, graph traversal, provider file request, or alternate route is triggered | Repair is "use more of the existing pack," not "continue understanding the project" |

## Local Synthesis And Why It Is Not Used After Provider Failure

This part is deliberate and partially correct. In real-provider inspect mode, `RunEngine` passes `providerFailureSynthesis: "notice_only"` at `apps/agent-runtime/src/runtime/RunEngine.ts:1010`. The universal engine maps that to:

- `providerFailureBehavior: "notice_only"`
- `providerAnswerMode: "natural_text"`
- `requireProviderForConceptNotFound: true`

Those are set at `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:524` through `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:526`.

That prevents deterministic fallback prose from masquerading as LLM understanding. The failure is that no stronger recovery loop replaces it. When provider output fails or is rejected, the system does not:

- ask the provider to decompose the question into required relationships
- request specific new files to inspect
- follow imports/calls/data outputs named in the failed answer
- challenge whether local validation chose the wrong target concept
- build or revise a claim ledger
- run a read-only review worker over the proposed reasoning

So the product has moved from "fake local synthesis after provider failure" to "honest stop after provider failure." That is safer, but still not deep understanding.

## Validation Rejects Instead Of Repairing

There are several local validators:

- `validateProjectExplainResponse` validates the provider candidate against allowed refs, concept support, evidence groups, project domain, unsupported claims, requested style, and detailed answer shape.
  - `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:644`
- `validateAnswer` validates final answer shape, citations, not-found contradictions, forecasting scope, generic templates, shallow refs, multi-agent terminology, off-intent answers, answer length, section count, implementation symbol mentions, and code examples.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1886`
- `validateConceptCoverage` validates target-concept centering and requested facets.
  - `apps/agent-runtime/src/runtime/ProjectQuestionConceptEngine.ts:317`
- `validateRoleClassification` requires concept-flow steps to be implementation/direct-target-call shaped, unless the question is separately classified as decision-policy.
  - `apps/agent-runtime/src/runtime/ProjectQuestionConceptEngine.ts:360`

These validators are useful as guardrails, but architecturally they are blocking checks, not repair planners. A validation error is usually converted to one of these:

- provider revision over the same selected evidence
- bounded evidence expansion from the same report
- provider validation notice
- insufficient evidence notice
- local fallback synthesis only when explicitly allowed

What is missing is a validation-to-action loop:

- "missing DBSCAN-to-FCM relationship" should trigger import/call/data-flow traversal
- "missing orchestrator decision policy" should inspect the routing/agent modules
- "wrong concept selected" should re-run concept grounding with provider help
- "citation not in pack" should verify whether the cited file exists and pull it in
- "domain validator irrelevant" should be downgraded by a review step

## Why The System Falls Back To Cannot-Answer Behavior

The current stop behavior is caused by policy and topology:

1. Real-provider inspect mode sets `notice_only`.
2. `LlmProjectExplainer` uses provider failure/validation notices when the provider fails or never validates.
3. `UniversalProjectQuestionEngine` converts provider failure or provider rejection into a no-synthesis notice.
4. Later local validation errors in notice-only mode also create a provider validation notice.
5. The agentic kernel cannot become the final answer in this path because `allowLocalFinalAnswer` is false.
   - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:544`
   - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:558`

The system does not continue investigation because no component owns the state machine "answer failed, identify missing relationship, read more, revise model, retry provider, validate claims."

## Retrieval Is Still Mostly Keyword/Snippet Based

The main universal project-question retrieval path is lexical:

- `createSearchPlan` builds queries from target concept, entities, topic terms, aliases, facets, and hardcoded architecture/algorithm aliases.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1220`
- `collectLocalEvidence` sorts files, reads content, and checks whether normalized path or normalized line text includes the normalized query.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1255`
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1284`
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1305`
- `WorkspaceReasoningPipeline.analyzeWorkspaceReasoning` scores evidence by regex facets and term/topic matches.
  - `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:190`
  - `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:201`
- The agentic read planner still selects term-search paths by checking whether the normalized file path includes a term.
  - `apps/agent-runtime/src/runtime/AgenticReadPlanner.ts:35`
  - `apps/agent-runtime/src/runtime/AgenticReadPlanner.ts:131`
- The agentic workspace reader opens term-search files by path/content substring checks.
  - `apps/agent-runtime/src/runtime/AgenticWorkspaceReader.ts:63`
  - `apps/agent-runtime/src/runtime/AgenticWorkspaceReader.ts:73`
- Memory relevant-file lookup scores summaries by term overlap over path, roles, purpose, imports, exports, and symbols.
  - `apps/agent-runtime/src/memory/ProjectMemory.ts:350`
  - `apps/agent-runtime/src/memory/ProjectMemory.ts:412`

There are relationship-aware fragments, but they are not primary:

- `AgenticRelationshipFollower` extracts imports, routes, symbols, and potential call names with regexes.
  - `apps/agent-runtime/src/runtime/AgenticRelationshipFollower.ts:4`
  - `apps/agent-runtime/src/runtime/AgenticRelationshipFollower.ts:30`
- `ProjectIntelligence` stores dependency and reverse-dependency graphs, but only for resolved relative imports.
  - `apps/agent-runtime/src/memory/ProjectIntelligence.ts:12`
  - `apps/agent-runtime/src/memory/ProjectIntelligence.ts:78`
- `AgenticMentalModelBuilder` summarizes components from accepted evidence, but it is a compact run artifact, not a durable semantic model.
  - `apps/agent-runtime/src/runtime/AgenticMentalModelBuilder.ts:3`

The consequence is that deep questions succeed only when their terms happen to retrieve the right files and snippets. They fail when understanding requires following a concept across names, modules, outputs, data structures, and intent.

## Does The System Build A Real Mental Model?

It builds partial, run-local models:

- `ProjectExplainReport` summarizes inventory, modules, sampled files, sections, evidence, and data flow.
- `ProjectIntelligenceGraph` and read lanes provide some mechanism-chain and graph context.
- `AgenticTaskKernel` builds an evidence graph and mental model.
- `.agent_memory/project_intelligence.json` stores import dependency, reverse dependency, test-to-source, command-area, ownership, module, entrypoint, risk, and generated-file maps.

But it does not yet build a durable mental model with:

- entities and domain concepts
- functions/classes and their responsibilities
- call graph edges with confidence
- data-flow edges from produced fields to consumed fields
- route/UI/service/storage/model-output links
- model semantics such as "DBSCAN labels mark noise/outliers" and "FCM membership expresses soft certainty"
- evidence-backed claim ledgers
- cached reasoning artifacts reusable by future questions
- query-time graph expansion when a relationship is missing

So the current answer is: the system collects and summarizes chunks. It does not yet maintain a general project model that can answer unseen cross-module questions quickly and reliably.

## Memory And Persistent Knowledge

Repository memory is real and fresh after the current audit refresh:

- `.agent_memory/repo_index.json`
- `.agent_memory/file_manifest.json`
- `.agent_memory/symbol_index.json`
- `.agent_memory/command_inventory.json`
- `.agent_memory/project_intelligence.json`
- `.agent_memory/file_summaries.jsonl`
- `.agent_memory/task_history.jsonl`
- lessons, decisions, successes, failures, and swarm tuning artifacts

The indexer builds those artifacts in `rebuildRepoIndex`.

- `apps/agent-runtime/src/memory/RepoIndexer.ts:205`
- `apps/agent-runtime/src/memory/RepoIndexer.ts:217`
- `apps/agent-runtime/src/memory/RepoIndexer.ts:228`
- `apps/agent-runtime/src/memory/RepoIndexer.ts:236`

The persistent intelligence graph is useful but limited:

- import dependency graph
- reverse dependency graph
- test-to-source map
- command-to-area map
- module map
- entrypoint map
- risk map

Evidence:

- `apps/agent-runtime/src/memory/ProjectIntelligence.ts:12`
- `apps/agent-runtime/src/memory/ProjectIntelligence.ts:40`
- `apps/agent-runtime/src/memory/ProjectIntelligence.ts:45`

What is missing:

- embeddings
- vector/semantic search
- entity extraction beyond simple symbols/imports
- domain concept graph
- data-flow graph
- call graph with cross-language support
- SQLite-backed semantic model for inspect answers
- cached reasoning or claim-ledger artifacts
- refresh-aware query of the durable model before re-reading

The system has enough persistent knowledge to orient future work, but not enough persistent understanding to answer arbitrary deep questions without re-reading and re-reasoning each time.

## Why Simple Questions Succeed And Deep Questions Fail

Simple questions succeed when the answer needs one or two of these:

- find a symbol
- list files/pages/routes
- explain one file
- locate a threshold
- summarize a visible component
- cite a direct implementation line

The current pipeline is good at those because lexical retrieval plus citations is enough.

Deep cross-file questions fail because they require all of these:

- decompose the question into multiple concepts
- locate each concept even when names differ
- follow imports/calls/routes/data fields across files
- distinguish source evidence from tests/docs/artifacts
- infer the meaning of intermediate outputs
- connect algorithm outputs to business/orchestrator decisions
- synthesize a coherent mechanism rather than list snippets
- validate claims without overfitting to one answer shape
- repair missing evidence by reading more

The current system can collect evidence for each piece, but no single layer owns the relationship-modeling loop.

## Orchestration Diagnosis

Hivo has multiple orchestration systems, but inspect/project explain is separated from the strongest potential reasoning architecture.

Findings:

- `AgentRuntime` explicitly blocks real-provider deterministic orchestration.
  - `apps/agent-runtime/src/runtime/AgentRuntime.ts:160`
- `RunEngine.runInspectExplainTurn` calls `answerUniversalProjectQuestion` directly, not a provider-backed swarm or read-only understanding campaign.
  - `apps/agent-runtime/src/runtime/RunEngine.ts:1004`
- Legacy `OrchestratedRuntime` uses deterministic product/business/engineering orchestrators and generic workers, not provider-backed project-understanding workers.
  - `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:78`
  - `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:104`
  - `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:129`
  - `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:228`
- `CoreOrchestrator.invokeExecutor` creates nested `SeniorCodingAgent` sessions for executor tasks. That path can be provider-backed, but it is an executor bridge, not a general inspect-question intelligence layer.
  - `apps/agent-runtime/src/orchestration/Orchestrator.ts:919`
  - `apps/agent-runtime/src/orchestration/Orchestrator.ts:923`
  - `apps/agent-runtime/src/orchestration/Orchestrator.ts:932`
- `ProviderBackedSwarmWorker` can be genuinely provider-backed, but mock mode still exists and `auto` can fall back to mock if the provider is unavailable.
  - `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:42`
  - `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:55`
  - `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:71`
- Provider-backed swarm workers require strict JSON schemas.
  - `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:256`
  - `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:330`
- `SwarmRuntime` defaults worker mode to `provider_read_only` only if a provider factory is supplied; otherwise environment default is `mock`.
  - `apps/agent-runtime/src/orchestration/SwarmRuntime.ts:74`
  - `apps/agent-runtime/src/orchestration/SwarmRuntime.ts:578`

The architectural consequence is that "multi-agent" exists as infrastructure, but deep inspect answers are not answered by a multi-agent, provider-backed, relationship-aware understanding campaign.

## Domain-Specific And Shape-Dependent Validation Risks

Several validators encode expected answer shapes or known domain terms:

- Forecasting validation requires scope language and can reject answers that do not explain cluster/customer/aggregate scope.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1921`
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1933`
- Multi-agent validation requires specific wiring tokens such as `build_default_agents`, `ReActOrchestrator`, `choose_route`, `agent_recommendations`, and `agent_consensus`.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1949`
- Detailed answers have minimum character and section counts.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1908`
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1975`
- Detailed flow answers must mention concrete functions, endpoints, or implementation symbols.
  - `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:1983`
- Concept coverage requires the answer text to stay centered on the target concept and include requested facets.
  - `apps/agent-runtime/src/runtime/ProjectQuestionConceptEngine.ts:327`
- Role classification can reject non-direct implementation or downstream evidence.
  - `apps/agent-runtime/src/runtime/ProjectQuestionConceptEngine.ts:366`

These checks prevent bad canned answers, but they can also reject valid reasoning when the question asks for a relationship, decision policy, or architecture-level explanation rather than a direct implementation snippet. The checks should become repair contracts, not final answer blockers.

## Where Understanding Is Lost

Understanding is lost or weakened at these points:

1. Local intent and concept extraction happen before provider-assisted decomposition.
2. Evidence selection depends heavily on term/path/regex matching.
3. The provider receives a selected evidence pack rather than owning question decomposition and read expansion.
4. Provider revisions repair prose and citations, but do not request new filesystem reads.
5. Validation does not turn failures into graph-expansion actions.
6. Agentic kernel evidence is augmenting/diagnostic in real-provider project-explain mode, not the final answer authority.
7. Persistent memory is not a semantic model, and inspect answers do not query a durable relationship graph as their primary substrate.
8. Orchestration and inspect/explain do not share one intelligence layer.

## Root Architectural Causes

1. There is no first-class `ProjectUnderstandingKernel` for arbitrary deep project questions.
2. Retrieval is evidence-snippet-first, not relationship-model-first.
3. The provider is used mostly as a final drafter/reviser, not as a reasoning partner that can drive decomposition and read expansion.
4. Validation is answer-blocking and shape-dependent rather than repair-oriented.
5. Memory stores useful indexes but not a durable semantic project model.
6. Orchestration facilities are not wired into inspect/project-question answering.
7. Safety/provenance/honesty improvements now correctly prevent fake synthesis, but no deeper investigation loop has replaced the old fallback.
8. Some "agentic" paths still rely on deterministic heuristics, regex extraction, strict JSON schemas, or mock fallback modes.

## Components Requiring Redesign

- `UniversalProjectQuestionEngine`: should become a coordinator over a relationship-aware understanding kernel, not the owner of a giant local retrieval/validation/fallback pipeline.
- `LlmProjectExplainer`: should support provider-guided decomposition, missing-evidence requests, claim-ledger drafting, and validator challenge, not only first draft, revision, and bounded repair.
- `ProjectQuestionGrounding`: should provide evidence contracts and concept candidates, not hardcoded domain answer shapes.
- `ProjectQuestionConceptEngine`: should validate relationship coverage and claim support, not only direct implementation role shape.
- `WorkspaceReasoningPipeline`: should become a semantic workspace understanding contract rather than facet regex scoring and fallback generation.
- `AgenticTaskKernel`: should be promoted or replaced by a true read/reason/repair kernel with provider-guided planning and durable graph outputs.
- `RepoIndexer` and `ProjectIntelligence`: should index semantic nodes/edges, not only file/symbol/import/command metadata.
- `OrchestratedRuntime` and swarm runtime: should expose read-only understanding campaigns for deep questions instead of being separate execution-oriented systems.

## Components Requiring Replacement

- Special-case fallback composers for project explanations should be replaced with claim-ledger synthesis.
- Keyword alias expansion as the main retrieval strategy should be replaced with graph-edge planning and semantic retrieval.
- Strict answer-shape validation should be replaced with claim/evidence/relationship validation plus repair actions.
- Mock worker output must never be allowed to stand in for provider-backed understanding.
- Concept-not-found local final answers should remain provider-authorized or explicitly demo-only.

## Recommended Architecture For True Project Understanding

### 1. ProjectUnderstandingKernel

Create a first-class kernel for inspect/project questions. It should own:

- provider-assisted question decomposition
- concept and entity extraction
- required relationship planning
- graph query and graph expansion
- file reads and source verification
- mental model construction
- claim ledger construction
- provider synthesis
- claim validation
- repair loop
- final answer provenance

### 2. DurableProjectModel

Persist a graph under `.agent_memory` or SQLite-backed storage with:

- files, symbols, imports, exports
- call edges
- route/UI/service/storage edges
- model input/output edges
- data fields produced and consumed
- domain concepts and aliases
- summaries per component
- evidence confidence and freshness
- tests/docs/source separation
- cached reasoning artifacts and claim ledgers

### 3. Relationship-Aware Retrieval

Answer planning should start from required edges:

- "DBSCAN followed by FCM" means find DBSCAN output, FCM input, data cleaning, labels, memberships, and consumers.
- "drift detection, FCM membership, and orchestrator rules" means find signal producers, agent recommendation rules, vote/route logic, and final action selection.

This should be generated from the question's structure, not from a hardcoded example.

### 4. Provider As Reasoning Partner

Use the provider to:

- decompose the user question
- propose candidate concepts and disambiguations
- identify missing edges
- request specific reads
- synthesize a mental model
- draft a claim ledger
- challenge validator assumptions
- write the final answer only after evidence is validated

### 5. Validation As Repair Loop

Validation should output actions:

- `read_more`: open specific files or follow specific edges
- `expand_graph`: follow imports, calls, routes, data fields, or storage writes
- `revise_claim`: ask provider to rewrite a claim against known refs
- `challenge_validator`: determine whether a domain-specific validator applies
- `mark_unknown`: keep unknowns explicit when evidence is missing

Only after bounded repair fails should the user see a cannot-answer notice.

### 6. Read-Only Understanding Campaigns

Deep questions should route to a read-only campaign:

- scout relevant components
- trace relationships
- build model
- review claims
- synthesize answer
- validate citations

This can use multiple logical agents, but they should be read-only/review-only by default and provenance must say whether they were provider-backed, deterministic, or mock.

## General Intelligence Layer For Future Questions

A general intelligence layer should expose one contract:

```ts
type ProjectUnderstandingAnswer = {
  question: string;
  decomposition: QuestionConcept[];
  requiredRelationships: RelationshipRequirement[];
  graphQueries: GraphQuery[];
  filesRead: EvidenceRead[];
  model: ProjectMentalModel;
  claimLedger: Claim[];
  validation: ClaimValidationResult[];
  repairIterations: RepairIteration[];
  finalAnswerMarkdown: string;
  provenance: ProviderTruthAndEvidenceProvenance;
};
```

The important point is ownership: one layer owns the loop from question decomposition to evidence gathering to model building to final answer. The current architecture spreads that responsibility across intent gates, report builders, grounding, local search, provider draft, local validators, and fallback notices.

## What Must Not Be Solved With

Do not solve this with:

- special cases
- hardcoded phrases
- custom composers
- answer templates
- mock orchestration
- keyword tricks
- domain-specific shortcuts
- one more DBSCAN/FCM rule
- one more re-cluster/offer rule
- local synthesis that hides provider failure
- validation rules that only make current tests pass

## Completion Audit Against The Requested Investigation

| Requested area | Diagnosis status |
| --- | --- |
| Exact user-question to answer path | Covered in the current path section with file/function refs. |
| Provider output unavailable/rejected/discarded | Covered in provider failure points and validation sections. |
| Local synthesis disabled/bypassed/weakened | Covered in the notice-only policy section. |
| Validation rejects instead of repairing | Covered with validator refs and missing repair actions. |
| Fallback to cannot-answer | Covered as policy plus missing state machine. |
| Orchestrated mode deterministic/mock/rule-driven | Covered in orchestration diagnosis. |
| Project explain/inspect separated from stronger reasoning | Covered in exact path and orchestration diagnosis. |
| Simple vs deep questions | Covered in simple/deep section. |
| Keyword/snippet retrieval | Covered in retrieval section. |
| Mental model vs disconnected chunks | Covered in mental model section. |
| Indexed project knowledge | Covered in memory and persistent knowledge section. |
| Persistent understanding for quick answers | Covered as insufficient durable semantic model. |
| Overfit/narrow validators | Covered in validation risk section. |
| Domain-specific checks blocking reasoning | Covered with forecasting, multi-agent, and role validators. |
| Safety/fallback optimized over understanding | Covered in root causes. |
| Illusion of intelligence | Covered through deterministic, mock, local-synthesis, and provider-truth analysis. |

## Bottom Line

Hivo Studio is safer and more honest than before: real-provider inspect mode no longer quietly promotes local synthesis after provider failure. But the architecture still cannot reliably answer arbitrary deep project questions because it lacks a single, provider-backed, relationship-aware, repair-capable project understanding layer.

The right fix is not another composer. The right fix is to make project understanding a first-class architecture: durable semantic graph, provider-guided read planning, relationship tracing, claim ledger, validation-as-repair, and read-only understanding campaigns that share the same intelligence layer as inspect/explain.
