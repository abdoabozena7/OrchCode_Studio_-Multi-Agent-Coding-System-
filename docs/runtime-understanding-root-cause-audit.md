# Runtime Understanding Root-Cause Audit

This audit explains why the local runtime can feel like it "does not understand" the user even when an LLM is configured.

## Current Message Path

1. `AgentRuntime.runTurn` receives the user message.
2. A pre-retrieval gate calls `decideIntentBeforeRetrieval`.
3. If the message is not direct conversation, `AgentRuntime` creates `ToolRegistry`, reads the workspace summary, resolves execution mode, and calls `RunEngine`.
4. `RunEngine` builds project intake, context pack, snapshot, and for inspect-only questions calls `answerUniversalProjectQuestion`.
5. `answerUniversalProjectQuestion` builds local evidence first: search plan, read lanes, structured facts, concept resolution, mechanism chain, and positive evidence.
6. Only after that, `explainProjectWithLlm` calls the provider.
7. The provider answer is treated as a draft. Local validation can reject it.
8. By default, provider timeout, invalid JSON, schema failure, unsupported claims, language mismatch, stale canned shape, or missing citations produce explicit provider failure/validation notices instead of local synthesis. Local synthesis after provider failure/validation now requires an explicit `providerFailureSynthesis: "allow_local_synthesis"` policy.

Authoritative code refs:

- `apps/agent-runtime/src/runtime/AgentRuntime.ts:99`
- `apps/agent-runtime/src/runtime/AgentRuntime.ts:106`
- `apps/agent-runtime/src/runtime/AgentRuntime.ts:139`
- `apps/agent-runtime/src/runtime/AgentRuntime.ts:208`
- `apps/agent-runtime/src/runtime/RunEngine.ts:148`
- `apps/agent-runtime/src/runtime/RunEngine.ts:962`
- `apps/agent-runtime/src/runtime/RunEngine.ts:988`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:352`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:483`

## Root Causes Found

### 1. The LLM is not the main understanding owner

The runtime puts most "understanding" in deterministic architecture: intent heuristics, workspace search, concept resolution, read lanes, validators, and fallback builders. The provider is one component in the middle, not the final authority.

This is intentional safety architecture, but it explains the user-visible problem: when the deterministic layers misunderstand the prompt, the LLM often cannot correct the route because the route and evidence pack have already been chosen.

### 2. Provider output can be replaced even when the provider answered

`answerUniversalProjectQuestion` collects validation errors from:

- provider unsupported parts
- concept coverage
- role classification
- language validation
- dedupe/output cleanup
- answer shape
- target evidence
- mechanism coverage
- read-lane evidence
- stale canned outerloop detection

If any validation errors remain, the default behavior is a `provider_validation_notice`. The older behavior, calling `createEvidenceFallbackAnswer` and setting `fallbackReason = local_validation_failed...`, is now opt-in through `providerFailureSynthesis: "allow_local_synthesis"`.

Authoritative code refs:

- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:494`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:559`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:564`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:566`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:583`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:584`

Diagnostic test proving this:

- `apps/agent-runtime/src/tests/universal-project-question.test.ts`
- Test name: `UniversalProjectQuestionEngine treats provider text as draft, not final authority`

### 3. Provider failures used to turn into deterministic local answers

`LlmProjectExplainer` calls `generateStructured`. If the provider throws, times out, or returns malformed structured output, `createProviderFailureFallback` builds a deterministic answer.

Authoritative code refs:

- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:78`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:80`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:89`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:94`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:117`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:127`

This directly explains answers with:

`Answer source: local evidence graph synthesis after provider output was unavailable or failed validation.`

Current mitigation: `answerUniversalProjectQuestion` now defaults to a `notice_only` policy. Provider timeout/failure produces `provider_failed_notice`, and provider answers that fail validation produce `provider_validation_notice`, instead of promoting local synthesis into the final answer. Direct engine calls and demo/mock tests can still request local synthesis explicitly with `providerFailureSynthesis: "allow_local_synthesis"`.

### 4. Ollama was forced through strict JSON for final explanations

The Ollama provider was asked for strict JSON even for the final human-facing project explanation, then the runtime parsed and schema-validated that JSON before treating the answer as usable. This made a natural LLM answer fail as "not understanding" when the real failure was JSON shape, timeout, or local schema rejection. It directly matched the observed failure:

`real_provider.timeout: Ollama request timed out`

Current mitigation:

- Runtime provider calls now use `providerRequestTimeoutMs` from config. It defaults to 180 seconds and can be changed with `HIVO_PROVIDER_TIMEOUT_MS` or `ORCHCODE_PROVIDER_TIMEOUT_MS`.
- Real-provider inspect/project-question answers now request natural Markdown from the provider (`generateText`) instead of strict `project-explain` JSON. The runtime then extracts the provided `hivo-file` citations and runs the same evidence validation gates. This removes the JSON bottleneck without allowing uncited free-form claims.
- Natural provider explanations now receive a focused evidence shortlist instead of the full broad report. The grounding pass still sees the complete evidence graph, but the provider prompt is capped to the most relevant concept refs, project-domain refs, workspace-reasoning refs, validation refs, and then a bounded fallback slice. This reduces local-model timeouts and generic answers caused by prompt overload.
- Legacy/demo deterministic synthesis can still opt into the old structured JSON path for regression coverage, but the real-provider notice-only path no longer requires JSON for the final explanation.

Authoritative code refs:

- `apps/agent-runtime/src/llm/OllamaProvider.ts:15`
- `apps/agent-runtime/src/llm/OllamaProvider.ts:18`
- `apps/agent-runtime/src/llm/OllamaProvider.ts:21`
- `apps/agent-runtime/src/llm/OllamaProvider.ts:38`
- `apps/agent-runtime/src/llm/OllamaProvider.ts:43`
- `apps/agent-runtime/src/llm/OllamaProvider.ts:68`
- `apps/agent-runtime/src/config.ts`
- `apps/agent-runtime/src/runtime/AgentRuntime.ts`
- `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts`
- `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts`

So "the LLM did not understand" may actually mean:

- it was never called,
- it timed out,
- it was asked for JSON when a natural answer would have been safer,
- it returned non-JSON to a JSON-only endpoint,
- it returned schema-invalid JSON,
- or it returned a natural answer that local validators rejected.

### 5. There were multiple intent/topic systems that could disagree

The runtime has several decision points:

- `decideIntentBeforeRetrieval`
- `classifyRunIntent`
- `resolveExecutionMode`
- `inferWorkspaceIntent`
- `inferUniversalInspectTopic`
- `classifyAgenticTaskIntent`
- concept resolution and grounding validators

Before the latest cleanup, `hi explain this project` correctly entered the workspace path, but downstream topic extraction could still choose `hi` as the target concept. That is not LLM failure; it is inconsistent deterministic prompt interpretation across layers.

Current mitigation:

- `prepareWorkspacePromptForUnderstanding` strips social preambles before workspace topic extraction.
- `ConversationUnderstanding` now computes the pre-retrieval decision, cleaned workspace message, and workspace intent once for the local runtime path.
- The local `IntentDecisionEngine` Arabic signal text and direct-conversation labels are now valid UTF-8, with regression coverage proving Arabic direct replies, provider-intent failure progress, and run summaries do not contain mojibake.
- The local pre-retrieval intent decision is now authoritative for the first gate. This is intentional: a social message such as `هاي` should not depend on Ollama availability and should not require a provider timeout before the runtime decides not to search the workspace.
- `AgentRuntime`, `RunEngine`, and `ProjectIntake` now pass that shared understanding through direct conversation, run-intent classification, intake, snapshot search query selection, and inspect/explain routing instead of recomputing those decisions independently.
- In `real_provider` sessions, `AgentRuntime` now runs the local `IntentDecisionEngine` before `ToolRegistry`, `getProjectSummary`, project intake, snapshot, search, provider calls, or fallback paths are allowed to run. Direct social messages complete without provider calls; workspace questions still receive provider-backed answer drafting later in the inspect path.
- `AgentRuntime` now passes the cleaned workspace message into `CoreOrchestrator.planOnly` / `runAgenticTask`, so the orchestration run request and task graph are not seeded with social preambles.
- The legacy `OrchestratedRuntime` also uses `ConversationUnderstanding` before product brief creation, worker execution context, plan-mode summaries, and quality-gate request text.
- `inferWorkspaceIntent("hi explain this project").topicTerms` is now empty, meaning it becomes a general project explanation instead of a search for `hi`.
- `inferWorkspaceIntent("هاي ازاي الfeedback بيتطبق؟").topicPhrase` is now `feedback`.
- `classifyAgenticTaskIntent("هاي ازاي الfeedback بيتطبق؟")` now uses the same cleaned workspace prompt, classifies it as `feature_explain`, and does not keep `هاي` as a task term.
- `buildLargeProjectExplainReport` now accepts/creates `ConversationUnderstanding` and uses the cleaned workspace message for inventory filtering, module grouping, section ranking, evidence creation, and risks/unknowns.
- Concept-scoped report evidence is now narrower: when a specific concept has matching evidence, generic source/doc/remaining samples are not promoted into the final report evidence list. This prevents unrelated files, such as a file only containing `هاي`, from appearing as evidence for `feedback`.
- `answerUniversalProjectQuestion` now uses the cleaned workspace prompt for topic selection, agentic task classification, evidence scope, concept resolution, read lanes, search planning, and local validation. The returned `question` remains the original user text for auditability.
- `RunEngine` now uses the cleaned workspace message as the execution message for project intake, snapshots, search-query metadata, run planning, module planning, patch-intent prompts, run-to-green objectives, and repair-patch prompts. This closes a leakage path where `User request` was cleaned but the serialized `Workspace snapshot` / `Project intake` JSON still carried the raw social preamble into provider prompts.
- Latest regression coverage proves the new provider-owned first gate: in real-provider sessions the first provider call is `conversation-intent-decision`; a direct `هاي` response completes before workspace retrieval; provider intent failure stops before local workspace search; and mixed requests such as `هاي update App.tsx color` keep the actionable request while removing the social preamble from provider prompts.
- Additional regression coverage proves that when a provider-owned `workspace_action` has a weak cleaned message such as `continue this project`, downstream classifiers still keep it as implementation work instead of converting it into an inspect/explain answer.
- Runtime project-explain now requires a provider call even when local grounding says the requested concept was not found. This closes `concept_not_found_without_provider_answer` for the real-provider runtime path: concept-not-found can still be used as grounding/validation evidence, but it cannot become the final answer before the provider is asked. If the provider then fails, the final answer is an explicit `provider_failed_notice`, not a deterministic not-found explanation.
- Notice-only project-question mode now also prevents the agentic kernel from replacing the final provider answer, even if `HIVO_AGENTIC_TASK_KERNEL_MODE=force`. In real-provider runtime, the agentic kernel can remain diagnostic/debug context, but it cannot become the final answer source unless the caller explicitly uses `allow_local_synthesis` for demo/test behavior.
- Regression coverage now proves both sides of the gate: a direct `hai`/Arabic social message does not call the provider or create project-intake artifacts even when workspace files contain the same token, while `hai update App.tsx color` still enters the edit path and provider prompts receive the cleaned edit request.
- Real-provider implementation planning now rejects any provider-planner fallback before applying plan state. A malformed or unavailable `run-plan` response stops with a provider planning failure instead of creating a deterministic continuation plan whose mode might look like a real decision.
- Regression coverage now also proves the final explanation path can accept provider-authored Markdown with `hivo-file` citations without any `project-explain` structured JSON call, while still rejecting uncited or locally invalid provider text.
- Regression coverage proves a wide project report with more than 45 evidence refs is narrowed before the natural provider call, while the final answer still has to cite one of the allowed `hivo-file` links.

### 6. Composite decision-policy questions were overvalidated as forecasting or implementation

A prompt such as "when does the system choose Re-cluster instead of Offer, linking drift detection, FCM membership, and orchestrator rules" is not a pure forecasting question and not a pure FCM implementation question. It is a decision-policy question: the answer has to connect model signals, agent recommendation rules, orchestrator voting/routing, and the final action.

Before the latest fix, the deterministic layers could see `drift`, `membership`, `FCM`, or `cluster` and route validation toward the wrong shape:

- forecasting validation demanded cluster/customer/aggregate forecast scope even though the user asked action-routing policy
- role classification could reject downstream/orchestrator evidence as not being the direct target implementation
- a good provider answer could then be replaced by `provider_validation_notice`

Current mitigation:

- `ProjectQuestionGrounding` now has a `decision_policy` question kind and evidence group for terms such as `Re-cluster`, `Offer`, `drift_detected`, `membership_strength`, `agent_recommendations`, `weighted_votes`, `agent_consensus`, and `choose_route`.
- `LlmProjectExplainer` now tells the provider to answer decision-policy questions as a full condition chain across signals, agent rules, orchestrator routing, and final selected action.
- `UniversalProjectQuestionEngine` treats decision-policy questions as routing-policy questions, so role classification does not reject orchestrator/downstream routing evidence and forecasting-specific answer-shape validation is not triggered just because the prompt contains `drift`.
- Regression coverage now proves the exact failure shape: a natural Arabic provider answer with citations for `ClusterHealthAgent`, `process_customer`, and `ReActOrchestrator.choose_route` is accepted as `provider_final` and does not fall back with `Forecasting answer...` or `Downstream stage...` validation notices.

Diagnostic tests:

- `apps/agent-runtime/src/tests/project-explain.test.ts`
- Test name: `Arabic re-cluster versus offer prompt is decision policy`
- `apps/agent-runtime/src/tests/universal-project-question.test.ts`
- Test name: `UniversalProjectQuestionEngine accepts provider decision-policy answers without forecasting validation`

### 7. Retrieval is still too eager after the first gate

The pre-retrieval gate now protects direct social messages such as `هاي`, but once a message is classified as a workspace question, the system still enters a heavy evidence path. It does not yet have a second semantic confidence gate that can say:

- "this is a project question but the target is unclear,"
- "ask a clarifying question,"
- "evidence is too weak to synthesize,"
- or "provider unavailable, do not generate a templated explanation."

This is a remaining root problem.

### 8. Fallback text exists in many places

Deterministic answer text is spread across multiple modules:

- `ProjectQuestionGrounding`
- `UniversalProjectQuestionEngine`
- `WorkspaceReasoningPipeline`
- `LlmProjectExplainer`
- `RunEngine`
- `AgenticOutputSynthesizer`
- `SeniorCodingAgent`
- `ProviderBackedSwarmWorker`
- `Orchestrator`
- `PromptWriterService`

That makes it easy for the product to regress into template-like phrasing even if one fallback path is improved.

### 9. Some "agentic" paths are still deterministic or mock by default

The current architecture has real provider-backed pieces, but it also has legacy/simple and swarm paths that can produce summaries from deterministic code:

- `SeniorCodingAgent` scans workspace, searches a term, and reads one file deterministically. Current mitigation: in `real_provider` sessions, inspect/explain final answers must come from `provider.generateText`; if the provider fails, it stops instead of returning the legacy local summary.
- `Orchestrator.invokeExecutor` used to create the nested executor session with `mode: "demo_mock"` even when a provider factory was wired. Current mitigation: if a provider is available, the nested executor session is recorded as `real_provider` and the final report says provider-backed planner, not demo mock. For inspect/explain, the final answer now requires a provider-authored answer; scan/search/tool orchestration remains deterministic.
- `ProviderBackedSwarmWorker` used to default to `mock`; even if a provider factory was supplied directly, tests proved it remained mock unless `mode` was explicitly `provider_read_only` or `auto`. Current mitigation: an explicit `providerFactory` now defaults the worker to `provider_read_only`; explicit `mode: "mock"` still keeps demo/mock behavior.
- `SwarmRuntime` defaults worker mode from env and falls back to `mock` when `HIVO_SWARM_WORKER_MODE` / `ORCHCODE_SWARM_WORKER_MODE` is not set. Current mitigation: an explicit runtime `providerFactory` now defaults worker mode to `provider_read_only`.

That means "multi-agent" can still mean deterministic staffing, deterministic scouts/planners/reporters, or mock executor summaries unless provider-backed worker mode is explicitly enabled and verified in artifacts.

## User-Visible Deterministic Answer Inventory

These are the current paths that can send user-visible text without a successful final provider answer.

| Area | Trigger | User-visible behavior | Code refs |
| --- | --- | --- | --- |
| Direct conversation | `decideIntentBeforeRetrieval` returns `direct_conversation` | Sends a local greeting/ack without provider or workspace | `apps/agent-runtime/src/runtime/AgentRuntime.ts:106`, `apps/agent-runtime/src/runtime/AgentRuntime.ts:248`, `apps/agent-runtime/src/runtime/RunEngine.ts:162` |
| Explain evidence follow-up | Session already has `explainReport` and user asks where evidence came from | Sends `formatExplainEvidenceAnswer` from stored report | `apps/agent-runtime/src/runtime/AgentRuntime.ts:115`, `apps/agent-runtime/src/runtime/AgentRuntime.ts:1757` |
| Runtime failure | Any thrown runtime/provider error escapes `runTurn` | Sends `formatRunTurnFailureMessage` | `apps/agent-runtime/src/runtime/AgentRuntime.ts:218`, `apps/agent-runtime/src/runtime/AgentRuntime.ts:1797` |
| Run-to-green no command | No grounded command or only preview is found | Sends local no-command message | `apps/agent-runtime/src/runtime/RunEngine.ts:487`, `apps/agent-runtime/src/runtime/RunEngine.ts:2459` |
| Inspect/project question provider failure | Provider timeout, invalid JSON, schema failure, or provider exception | Default engine behavior returns a `provider_failed_notice`; local synthesis is opt-in through `allow_local_synthesis` | `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:518`, `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:915`, `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:117` |
| Inspect/project question validation replacement | Provider answer exists but local validators reject it | Default engine behavior returns `provider_validation_notice`; `createEvidenceFallbackAnswer` is opt-in through `allow_local_synthesis` | `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:523`, `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:594`, `apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts:841` |
| Concept not found before provider authority | Specific concept is not found in local evidence | Deterministic not-found answer can be returned | `apps/agent-runtime/src/runtime/LlmProjectExplainer.ts:64`, `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:633` |
| Project-question fallback variants | Page inventory, thresholds, forecasting, Arabic dataset realtime, generic evidence | Specialized local answer templates | `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:699`, `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:1468`, `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:1837`, `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:1917`, `apps/agent-runtime/src/runtime/ProjectQuestionGrounding.ts:2149` |
| Workspace reasoning fallback | Unified workspace reasoning has weak/no provider answer | Generic not-found/inventory/grounded answer templates | `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:253`, `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:419`, `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:533`, `apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts:551` |
| Agentic kernel synthesis | Natural draft disabled/fails/times out or accepted evidence is enough | `AgenticOutputSynthesizer` writes local markdown | `apps/agent-runtime/src/runtime/AgenticTaskKernel.ts:96`, `apps/agent-runtime/src/runtime/AgenticTaskKernel.ts:205`, `apps/agent-runtime/src/runtime/AgenticOutputSynthesizer.ts:10` |
| Legacy SeniorCodingAgent inspect | Legacy/simple path handles explain/inspect | In real-provider sessions, final inspect answer must come from provider text; provider failure stops instead of returning the local summary. Demo/mock still uses local summary. | `apps/agent-runtime/src/agents/SeniorCodingAgent.ts:43`, `apps/agent-runtime/src/agents/SeniorCodingAgent.ts:194`, `apps/agent-runtime/src/agents/SeniorCodingAgent.ts:254`, `apps/agent-runtime/src/agents/SeniorCodingAgent.ts:267` |
| Orchestrator executor bridge | Core orchestrator invokes ExecutorAgent through nested SeniorCodingAgent | Provider-wired runs now record provider-backed planner provenance; no-provider runs still record demo mock. Inspect answers require provider final text, while scan/search orchestration remains deterministic. | `apps/agent-runtime/src/orchestration/Orchestrator.ts:923`, `apps/agent-runtime/src/orchestration/Orchestrator.ts:931`, `apps/agent-runtime/src/orchestration/Orchestrator.ts:3091`, `apps/agent-runtime/src/orchestration/Orchestrator.ts:3108` |
| Provider-backed swarm default | ProviderBackedSwarmWorker constructed without explicit mode | If `providerFactory` is supplied, defaults to provider read-only; explicit `mode: "mock"` still runs the mock worker | `apps/agent-runtime/src/orchestration/ProviderBackedSwarmWorker.ts:42`, `apps/agent-runtime/src/tests/provider-backed-swarm-worker.test.ts:116` |
| Swarm runtime worker mode | `HIVO_SWARM_WORKER_MODE` / `ORCHCODE_SWARM_WORKER_MODE` missing | If runtime `providerFactory` is supplied, worker mode defaults to provider read-only; otherwise it defaults to mock | `apps/agent-runtime/src/orchestration/SwarmRuntime.ts:347`, `apps/agent-runtime/src/orchestration/SwarmRuntime.ts:578` |
| Patch planning fallback | Provider patch output invalid or missing | Real-provider mode now fails clearly unless the user supplied an exact file path and exact content; demo mode still uses mock/demo patch generation | `apps/agent-runtime/src/runtime/RunEngine.ts:702`, `apps/agent-runtime/src/runtime/RunEngine.ts:1798`, `apps/agent-runtime/src/runtime/RunEngine.ts:1833` |
| Deterministic run plan | Provider plan malformed/unavailable | Run-to-green can still use a bounded deterministic inspection/command-selection plan; real-provider implementation requests now stop before implementation instead of inventing a deterministic implementation plan | `apps/agent-runtime/src/runtime/RunEngine.ts:506`, `apps/agent-runtime/src/runtime/RunEngine.ts:1316`, `apps/agent-runtime/src/runtime/RunEngine.ts:2314` |
| Orchestrated mode summary | Worker outputs and gates are deterministic/mocked in current local worker path | Real-provider sessions now stop before orchestrated workers run; demo/mock sessions can still generate deterministic worker summaries and patches | `apps/agent-runtime/src/runtime/AgentRuntime.ts:158`, `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:189`, `apps/agent-runtime/src/runtime/OrchestratedRuntime.ts:498` |
| Desktop activity stream | UI appends fallback notes if reasoning summaries contain known phrases | User sees fallback as activity item, but not necessarily as answer strategy | `apps/desktop/src/app/activityStream.ts:55`, `apps/desktop/src/app/activityStream.ts:67`, `apps/desktop/src/app/App.tsx:4931` |

## Provider Mode Confusion

There are two important entry behaviors:

- Runtime config defaults to `demo_mock` unless `HIVO_AGENT_MODE` or `ORCHCODE_AGENT_MODE` is `real_provider`/`real`.
- Real provider request timeout now defaults to 180 seconds and can be changed with `HIVO_PROVIDER_TIMEOUT_MS` or `ORCHCODE_PROVIDER_TIMEOUT_MS`.
- Desktop session creation normally requests `real_provider` unless the prompt contains `demo` or `mock`, and blocks if no valid provider is configured.
- Swarm/autopilot worker execution still defaults to mock unless `HIVO_SWARM_WORKER_MODE` or `ORCHCODE_SWARM_WORKER_MODE` is set to `auto` or `provider_read_only`.

Authoritative code refs:

- `apps/agent-runtime/src/config.ts:29`
- `apps/desktop/src/app/App.tsx:1008`
- `apps/desktop/src/app/App.tsx:1020`
- `apps/desktop/src/app/App.tsx:1025`

So the only reliable way to know whether the LLM actually participated is provider telemetry, not the shape of the answer text.

## Why This Feels Like "It Does Not Think"

The runtime currently has at least four competing "brains":

1. Pre-retrieval intent gate.
2. Workspace/project deterministic reasoning.
3. Provider draft.
4. Local validation/fallback replacement.

The user expects one coherent reasoning loop. The code is closer to a rule-driven evidence machine with an optional provider draft in the middle. When rules disagree, the final answer can be a locally synthesized template even if the product is marketed as LLM-backed.

## Remaining High-Risk Bugs To Prove Or Fix

1. **Fallback replacement still exists behind explicit policy and in other specialized paths:** inspect/project-question provider failure and validation no longer synthesize locally by default, but local synthesis remains available for explicit demo/test policy and scattered specialized answer paths.
2. **Weak-evidence gating still does not cover every path:** project-question fallback, judgment questions, real-provider orchestration, real-provider implementation planning, and real-provider patch planning now have stronger stop gates; run-to-green command selection, demo/mock orchestration, demo/mock patch generation, and some specialized deterministic paths still need equivalent "do not synthesize from weak evidence" gates.
3. **Intent is still duplicated:** the newer pre-retrieval gate does not yet fully replace older classifiers.
4. **Mock/default mode can hide reality:** non-desktop callers can silently use `demo_mock` unless provider mode is explicit.
5. **Swarm/autopilot still needs provider truth gates:** provider-backed workers exist, but default worker mode and legacy executor bridging can still produce deterministic/mock worker output.
6. **UI does not make answer provenance unavoidable:** activity stream has provider truth summaries, but the compact answer can still read like the agent "answered" rather than "provider failed and local synthesis took over".

## What Is Fixed So Far

- Direct social messages can now exit before workspace retrieval.
- `هاي` no longer searches files that contain `هاي`.
- Direct conversation does not require an existing workspace.
- Mixed prompts with social preambles are cleaned before workspace topic extraction.
- Mixed prompts with social preambles are also cleaned before agentic task classification and project-question evidence search. A regression test proves `هاي ازاي الfeedback بيتطبق؟` searches for feedback evidence and does not add `هاي` to the query plan.
- The local runtime path now has a first shared `ConversationUnderstanding` object. A regression test proves `هاي شغل المشروع` keeps `run_request` intent and becomes `run_to_green` through the shared object, while `هاي ازاي الfeedback بيتطبق؟` keeps `feedback` as the workspace topic.
- Large project explain reports now use the same cleaned prompt and concept-scoped evidence. A regression test proves `هاي ازاي الfeedback بيتطبق؟` ranks `src/feedback.ts` first and does not include `src/هاي.ts` in report evidence.
- Orchestrated planning now receives the cleaned request from `AgentRuntime`. A regression test proves `هاي use 3 agents...` creates an orchestrated plan without carrying `هاي` into the visible task graph or plan response.
- Arabic no-command run responses no longer leak the English blocker text.
- A diagnostic test now proves provider text is draft-only and can be replaced by local validation.
- Project-question results and artifacts now include explicit `answerStrategy` metadata so provider-final, provider-replaced, provider-failed, agentic-kernel, and local-synthesis answers can be distinguished without guessing from prose.
- Weak evidence after provider failure or local validation failure now returns `insufficient_evidence_notice` instead of synthesizing a confident-looking fallback from generic refs.
- Judgment/correctness questions now require implementation/mechanism evidence before local synthesis. Documentation-only or generic name matches return `insufficient_evidence_notice` instead of a fake "correct/wrong" assessment.
- Real-provider patch generation no longer invents a Pygame prototype, starter scaffold, or `AGENT_PROPOSAL.md` when the provider returns invalid/empty patch output. It fails clearly unless the user supplied an exact file path and exact content.
- Real-provider implementation planning now stops if planner structured output is malformed/unavailable. It no longer creates scoped module tasks from a deterministic fallback for edit/create requests.
- Real-provider orchestrated mode now stops before deterministic/mock workers run. Multi-agent orchestration is not allowed to masquerade as provider-backed worker understanding until workers actually use the configured provider.
- Core orchestrator executor bridging no longer reports a provider-wired nested SeniorCodingAgent run as demo mock. Reports now distinguish provider-backed planner provenance from no-provider mock execution.
- Provider-backed legacy `SeniorCodingAgent` inspect/explain no longer returns its local workspace summary as the final answer. It now requires a provider final answer and fails clearly if that provider final answer fails.
- Provider-backed swarm workers no longer ignore an explicit provider factory by default. A supplied `providerFactory` now selects provider read-only mode unless the caller explicitly asks for `mode: "mock"`.
- Swarm runtime no longer ignores an explicit provider factory when selecting its default worker mode. A supplied runtime provider factory now selects provider read-only workers unless `workerMode` is explicitly set.
- Real-provider inspect/explain provider failures now stop local answer synthesis. A timeout/failure produces `provider_failed_notice` instead of `local_synthesis_after_provider_failure`.
- Real-provider inspect/explain provider answers that fail validation now stop local answer synthesis. Unsupported or citation-free provider text produces `provider_validation_notice` instead of being replaced by local evidence synthesis.
- Direct `answerUniversalProjectQuestion` calls now default to notice-only after provider failure/validation. Local synthesis after provider failure/validation requires explicit `providerFailureSynthesis: "allow_local_synthesis"`.
- The visible answer banner now distinguishes notice-only provider failure from local synthesis. For `provider_failed_notice` and `provider_validation_notice`, it says local synthesis was not used instead of claiming "local evidence graph synthesis".
- A real-provider regression now covers the Arabic multi-agent timeout case. If the provider fails, the runtime returns a no-synthesis notice and does not emit canned lines such as "multi-agentic decision-support", "agents متخصصة", or "orchestrator مركزي".
- `LlmProjectExplainer` now has an explicit `providerFailureBehavior`, and `notice_only` is the default. Provider failure or provider validation failure returns a no-synthesis notice from the explainer itself, before deterministic grounded fallback text is built. Deterministic synthesis remains opt-in/legacy for demo and focused tests through `providerFailureBehavior: "deterministic_synthesis"`.
- `LlmProjectExplainer` also now requires provider authority before final concept-not-found answers by default. Deterministic `concept_not_found_without_provider_answer` remains available only when callers explicitly set `requireProviderForConceptNotFound: false`, which keeps old demo/test behavior from becoming the default product behavior.
- Real provider timeout is now configurable through runtime config. The default moved from the provider's fixed 60 seconds to 180 seconds, which reduces false fallback/notice outcomes for slow local Ollama models.

## What Is Still Not Solved

The deeper architecture still needs the shared understanding contract to own all of this end to end, not only the current local runtime/project-question path:

- whether workspace evidence is needed,
- cleaned prompt,
- target concept,
- topic terms,
- run/action/question mode,
- evidence confidence,
- whether to answer, clarify, or stop,
- provider status,
- final answer strategy.

Without that, another layer outside the shared-understanding path can still understand the prompt correctly at first and later extract the wrong topic, over-search, or replace the answer with a deterministic template.

## Next Correct Fixes

1. Expand `ConversationUnderstanding` beyond local runtime, large project explain, and orchestration entry points into repair/patch planning, provider-backed swarm prompt templates, team sub-planning, and worker-output validation. The current object covers pre-retrieval decision, cleaned workspace message, workspace intent, local run-intent classification, snapshot search, project-question understanding, large-context evidence report construction, and orchestration request seeding; it is not yet the single contract for every path.
2. Extend the minimum relevance/confidence gate to run-to-green command selection, demo/mock orchestration, demo/mock patch generation, and specialized deterministic paths.
3. If provider fails and local evidence is medium confidence, preserve useful provider fragments only when claims can be individually validated instead of replacing the whole answer.
4. Centralize fallback policy and remove scattered template authority from individual modules.
5. Surface provider truth in the UI as first-class state: called, succeeded, failed, timed out, rejected, replaced.
