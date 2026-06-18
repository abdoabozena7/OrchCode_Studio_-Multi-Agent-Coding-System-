# Hivo Studio / OrchCode Studio - Complete Project Deep Dive

> This document is a practical English deep dive into the repository.
> It is intentionally long, line-oriented, and searchable.
> It explains the project from the desktop UI down to the runtime, memory system, swarm autopilot, Rust command authority, and patch application path.
> Review date: 2026-06-18.
> Original request: create a detailed Markdown explanation with at least 700 lines.
> This English version keeps that depth while replacing the earlier Arabic text.
> Current memory index at this update: schema version 2, fresh, 416 indexed files.

## 1. Executive Summary

001. The root package name is `hivo-studio`.
002. The repository is an npm workspace monorepo.
003. The three primary workspaces are `apps/agent-runtime`, `apps/desktop`, and `packages/protocol`.
004. `apps/agent-runtime` is the TypeScript runtime service.
005. `apps/desktop` is the Tauri desktop application.
006. `packages/protocol` is the shared type and contract package.
007. The project is a multi-agent coding system.
008. The system is designed around orchestration rather than a single all-knowing model.
009. Small models are treated as narrow workers.
010. Reliability comes from memory, task decomposition, structured outputs, verification, review, and authority boundaries.
011. The Node runtime reads the workspace and proposes patches.
012. The Node runtime does not directly write user files.
013. The Rust backend owns workspace boundaries.
014. The Rust backend owns terminal command execution.
015. The Rust backend owns patch application.
016. The Rust backend owns SQLite persistence for the desktop app.
017. The React frontend displays and controls the operator experience.
018. The shared protocol package keeps the TypeScript frontend, TypeScript runtime, and Rust bridge aligned.
019. `.agent_memory/` stores durable repository memory and run artifacts.
020. `.agent_memory/factory_metadata.sqlite` is now the SQLite-first memory source of truth.
021. The memory index should be checked before context-sensitive work.
022. The documented memory command for that is `npm run memory:index-status`.
023. The system supports simple runtime sessions.
024. The system supports orchestrated multi-agent sessions.
025. The system supports CLI-driven internal swarm autopilot runs.
026. The system supports campaign workflows for larger goals.
027. The system supports ReasoningKernel v2 adaptive provider loops.
028. The system supports project-understanding and adaptive-reasoning certification gates.
029. The system supports planning-only recursive factory approval layers for large work.
030. The internal swarm has a maximum supported logical capacity of 300 agents.
031. The 300-agent number is a maximum, not a normal default.
032. Write-capable executors are capped separately from read-only agents.
033. Read-only fan-out is preferred for exploration, scouting, review, and validation.
034. Approval-required states are real safety stops.
035. A run is not verified if validation only produced blocked commands.
036. Patch fingerprints, file locks, validation logs, review artifacts, and durable events are sources of truth.
037. The safest debugging strategy is to follow boundaries one by one.
038. Start with the UI if the operator display is wrong.
039. Move to runtime HTTP/SSE if live state is wrong.
040. Move to session state if the runtime lifecycle is wrong.
041. Move to protocol types if payload shapes are wrong.
042. Move to Rust commands if workspace, terminal, or patch authority is wrong.
043. Move to SQLite events if restore or authoritative patch evidence is wrong.
044. Move to `.agent_memory` if swarm, orchestration, memory, or artifact state is wrong.

## 2. Top-Level Repository Map

041. The root `package.json` defines npm workspaces.
042. The root `AGENTS.md` contains persistent operating instructions for coding agents.
043. The root `README.md` gives a high-level product and usage overview.
044. `AUDIT_RECURSIVE_AGENTIC_FACTORY_ALIGNMENT.md` is a large architecture audit artifact.
045. `docs/` contains architecture, usage, security, and status documentation.
046. `.agent_memory/` contains generated memory and durable local project state.
047. `apps/agent-runtime/` contains the TypeScript runtime service and orchestration logic.
048. `apps/desktop/` contains the desktop UI and Tauri backend.
049. `packages/protocol/` contains shared TypeScript contracts.
050. `scripts/launch-desktop.mjs` launches the desktop workflow.
051. `node_modules/` is dependency output and not source architecture.
052. `tmp/` contains audit and experiment artifacts.
053. `test-results/` contains generated test output.
054. `.orchcode-*.log` files are runtime logs.
055. Desktop icons and image assets live under the Tauri app folder.
056. Important runtime entrypoints include `apps/agent-runtime/src/index.ts`.
057. Another runtime entrypoint is `apps/agent-runtime/src/server.ts`.
058. The desktop frontend entrypoint is `apps/desktop/src/main.tsx`.
059. The Tauri backend entrypoint is `apps/desktop/src-tauri/src/lib.rs`.
060. The shared protocol entrypoint is `packages/protocol/src/index.ts`.
061. TypeScript is the dominant language in the repository.
062. Rust is used for the desktop backend and authority layer.
063. React is used for the operator console frontend.
064. Fastify is used by the TypeScript runtime HTTP service.
065. SQLite is used by the Rust desktop persistence layer.
066. Tauri 2 provides the desktop shell and command bridge.
067. npm scripts are the main command surface.
068. Cargo commands apply inside `apps/desktop/src-tauri`.
069. The memory index ignores generated folders such as `dist`, `target`, `node_modules`, and `tmp`.
070. The repository is intentionally split so UI, runtime, protocol, and authority code remain separable.

## 3. Root Package Scripts

071. `npm run build` builds `@hivo/protocol`, then `@hivo/agent-runtime`, then `@hivo/desktop`.
072. `npm run typecheck` builds protocol and typechecks all TypeScript workspaces.
073. `npm run test` runs the agent-runtime test suite.
074. `npm run smoke:desktop-run-project` runs the desktop run-project smoke flow.
075. `npm run smoke:terminal-authority` runs a terminal authority smoke flow.
076. `npm run smoke:run-to-green` exercises the run-to-green runtime path.
077. `npm run smoke:inspect-provider-truth` checks provider-truth evidence.
078. `npm run smoke:python-pygame-fallback` checks a Python fallback scenario.
079. `npm run memory:index` rebuilds repository memory.
080. `npm run memory:index-status` checks whether the index is fresh.
081. `npm run memory:index-refresh` refreshes the memory index.
082. `npm run memory:index-explain` explains index state.
083. `npm run memory:inspect` inspects memory.
084. `npm run memory:status` reports memory health.
085. `npm run memory:show-commands` shows detected commands.
086. `npm run memory:clean-runs` cleans local run artifacts.
087. `npm run memory:compact` compacts memory lessons and evidence.
088. `npm run memory:lessons` prints learned lessons.
089. `npm run memory:decisions` prints decision records.
090. `npm run memory:failed-attempts` prints failed strategies.
091. `npm run memory:explain-task` explains task context.
092. `npm run agent:run` runs the internal swarm autopilot.
093. `npm run agent:plan` creates a swarm plan without full execution.
094. `npm run agent:inspect-run` inspects a swarm run.
095. `npm run agent:report` shows a swarm report.
096. `npm run agent:resume` resumes a swarm run.
097. `npm run agent:trial:architecture-scan` runs an architecture scan trial.
098. `npm run agent:trial:test-discovery` runs a test discovery trial.
099. `npm run agent:trial:staffing-eval` evaluates staffing heuristics.
100. `npm run agent:trial:scheduler-scale` tests scheduler scaling.
101. `npm run agent:trial:compare` compares execution strategies.
102. `npm run agent:trial:small-safe-fix` tests a small safe fix scenario.
103. `npm run agent:trial:huge-readonly-scan` tests a large read-only scan.
104. `npm run agentic:run` runs the older agentic task CLI path.
105. `npm run agentic:plan` creates an older agentic plan.
106. `npm run agentic:resume-run` resumes an older agentic run.
107. `npm run campaign:create` creates a campaign.
108. `npm run campaign:plan` plans a campaign.
109. `npm run campaign:run-next` runs the next campaign step.
110. `npm run campaign:status` reports campaign status.
111. `npm run campaign:pause` pauses a campaign.
112. `npm run campaign:resume` resumes a campaign.
113. `npm run campaign:report` writes a campaign report.
114. `npm run campaign:metrics` reports campaign metrics.
115. `npm run eval:phase4` runs Phase 4 evals.
116. `npm run agent:dev` starts the agent runtime in watch mode.
117. `npm run web:dev` starts the desktop web frontend dev server.
118. `npm run desktop:dev` starts the full Tauri desktop dev app.
119. `npm run dev` runs the desktop launcher script.
120. Root scripts are wrappers around workspace scripts and TypeScript CLI entrypoints.

## 4. Architecture Principles

121. The project avoids big-bang rewrites.
122. The project prefers small verifiable steps.
123. Existing behavior should be preserved unless a task explicitly changes it.
124. Architecture changes should be reflected in docs.
125. Memory format changes should be reflected in docs.
126. Orchestration contract changes should be reflected in docs.
127. Operator workflow changes should be reflected in docs.
128. LLMs are narrow workers in this architecture.
129. The system avoids treating a model as a magical global brain.
130. Intelligence is placed in architecture.
131. Intelligence is placed in memory.
132. Intelligence is placed in task decomposition.
133. Intelligence is placed in verification.
134. Intelligence is placed in review.
135. Intelligence is placed in orchestration.
136. Repository memory is the default durable context.
137. Context packs keep worker context narrow.
138. Structured outputs keep worker results machine-readable.
139. Review loops catch scope and correctness issues.
140. Validation loops check actual commands where possible.
141. Patch authority prevents direct filesystem writes by LLM workers.
142. Command authority prevents untrusted command execution.
143. File locks prevent conflicting write scopes.
144. Approval gates stop unsafe actions.
145. Durable artifacts make runs auditable.
146. Persistent learning helps future runs avoid repeated failures.
147. Dynamic specialists are created from evidence.
148. High logical-agent counts are reserved for justified broad work.
149. Executor counts stay small even when read-only counts are large.
150. The user should not need to manually choose agent counts by default.

## 5. End-to-End Runtime Flow

151. The operator opens a workspace from the desktop UI.
152. React calls `openWorkspace` in `apps/desktop/src/lib/tauri.ts`.
153. `openWorkspace` invokes the Tauri command `open_workspace`.
154. Rust receives the command in the desktop backend.
155. `WorkspaceService` canonicalizes the path.
156. `WorkspaceService` verifies that the path is a directory.
157. Rust stores or updates project state in SQLite.
158. The UI renders workspace state, files, git status, and session controls.
159. The operator enters a prompt.
160. The UI creates a runtime run or session.
161. The runtime session can include a session token.
162. The UI calls the agent runtime HTTP service.
163. `server.ts` receives `POST /sessions`.
164. `AgentRuntime.createSession` delegates to `SessionManager`.
165. `SessionManager` creates an `AgentRuntimeSession`.
166. `SessionManager` stores the session in memory.
167. `SessionManager` persists session state.
168. `SessionManager` publishes runtime events.
169. The frontend subscribes to session events through SSE.
170. The operator sends a turn.
171. The UI calls `POST /sessions/:id/turn`.
172. `AgentRuntime.runTurn` processes the message.
173. `runTurn` checks pending actions.
174. `runTurn` updates lifecycle state.
175. `runTurn` builds a project map from workspace tools.
176. `runTurn` resolves the execution mode.
177. Simple execution uses `RunEngine`.
178. Orchestrated execution uses orchestrated runtime paths.
179. CLI swarm execution uses `SwarmAutopilotRuntime`.
180. Runtime tools read files and inspect git state.
181. Runtime tools can request commands.
182. Runtime tools can propose patches.
183. Runtime tools cannot apply patches directly.
184. Patch proposals are sent to the UI as events.
185. The operator can approve or reject a patch.
186. Runtime approval is not the same as filesystem application.
187. The UI invokes Rust `apply_runtime_patch` for actual application.
188. Rust loads the patch payload from SQLite.
189. Rust validates patch paths.
190. Rust captures a before Git snapshot.
191. Rust applies the patch with `git apply`.
192. Rust captures an after Git snapshot.
193. Rust writes authoritative runtime events.
194. The UI reports the patch apply result back to the runtime.
195. The runtime moves to post-verify, completed, blocked, or failed.
196. Command requests follow a similar authority split.
197. Runtime asks for command execution.
198. UI and Rust evaluate whether approval is required.
199. Rust executes approved commands.
200. Runtime receives command results.

## 6. Shared Protocol Package

201. The protocol package lives in `packages/protocol`.
202. It is a TypeScript package.
203. It defines the data contracts used across the system.
204. `packages/protocol/src/index.ts` re-exports protocol modules.
205. `packages/protocol/src/events.ts` defines `AppEvent`.
206. `packages/protocol/src/agent-runtime.ts` defines runtime session contracts.
207. `packages/protocol/src/approvals.ts` defines access and safety contracts.
208. `packages/protocol/src/models.ts` defines shared model records.
209. `packages/protocol/src/orchestration.ts` defines orchestration-facing types.
210. `packages/protocol/src/patch.ts` defines patch proposal contracts.
211. `packages/protocol/src/task-graph.ts` defines task graph contracts.
212. `packages/protocol/src/tools.ts` defines worker tool grants.
213. Protocol changes affect both frontend and runtime.
214. Protocol changes can also affect Rust payload expectations.
215. Build order keeps protocol first for this reason.
216. `AppEvent` is the live event union consumed by the UI.
217. `DurableRuntimeEvent` is the canonical event type for durable replay.
218. Durable events have actors.
219. Durable events have authorities.
220. Durable events have sequence numbers.
221. Durable events have correlation IDs when needed.
222. Durable events have payloads.
223. Runtime event authority may be `runtime`.
224. Rust event authority may be `rust`.
225. Bridge event authority may be `runtime_bridge`.
226. The distinction matters during restore and reconciliation.
227. `AgentRuntimeSession` is the central user-facing session object.
228. Session status can be `created`.
229. Session status can be `restored`.
230. Session status can be `running`.
231. Session status can be `completed`.
232. Session status can be `needs_approval`.
233. Session status can be `blocked`.
234. Session status can be `failed`.
235. Session status can be `expired`.
236. Lifecycle stages include `INTAKE`.
237. Lifecycle stages include `THINK`.
238. Lifecycle stages include `PLAN`.
239. Lifecycle stages include `CONTEXT_GATHER`.
240. Lifecycle stages include `EXECUTION_DRAFT`.
241. Lifecycle stages include `SELF_REVIEW`.
242. Lifecycle stages include `CROSS_REVIEW`.
243. Lifecycle stages include `VALIDATION`.
244. Lifecycle stages include `APPROVAL`.
245. Lifecycle stages include `APPLY`.
246. Lifecycle stages include `POST_VERIFY`.
247. Lifecycle stages include `DONE`.
248. Lifecycle stages include `BLOCKED`.
249. Lifecycle stages include `FAILED`.
250. This protocol-level vocabulary keeps UI and runtime lifecycle rendering aligned.

## 7. Protocol Event Snippet

```ts
export const DURABLE_RUNTIME_EVENT_TYPES = [
  "session.created",
  "session.snapshot_persisted",
  "patch.proposed",
  "patch.approved",
  "patch.apply_started",
  "patch.applied",
  "patch.apply_failed",
  "patch.reconciled",
  "command.requested",
  "command.completed",
  "review_gate.updated"
] as const;
```

251. The list is intentionally finite.
252. Durable event types are not arbitrary strings.
253. A finite event list protects replay logic.
254. A finite event list protects UI projections.
255. A finite event list protects test expectations.
256. Adding an event should begin at the protocol boundary.
257. Runtime code should then emit the new event.
258. Rust code should then persist or bridge the event if needed.
259. Frontend code should then render or consume the event if needed.
260. Tests should cover the new event semantics.

## 8. Agent Runtime Service

261. The agent runtime lives in `apps/agent-runtime`.
262. It is an ESM TypeScript package.
263. The runtime package name is `@hivo/agent-runtime`.
264. It depends on `@hivo/protocol`.
265. It depends on Fastify.
266. It uses `tsx` for development execution.
267. It uses TypeScript for builds.
268. The runtime entrypoint is `src/index.ts`.
269. `src/index.ts` loads runtime config.
270. `src/index.ts` builds the Fastify server.
271. `src/index.ts` starts listening on configured host and port.
272. The runtime HTTP server is built in `src/server.ts`.
273. Runtime state is managed by `SessionManager`.
274. Runtime orchestration is mediated by `AgentRuntime`.
275. Runtime events are published through `EventBus`.
276. Simple turn execution uses runtime modules under `src/runtime`.
277. Multi-agent orchestration uses modules under `src/orchestration`.
278. Worker implementations live under `src/agents`.
279. LLM providers live under `src/llm`.
280. Prompt templates live under `src/prompts`.
281. Tool wrappers live under `src/tools`.
282. Memory indexing lives under `src/memory`.
283. Runtime tests live under `src/tests`.
284. Runtime smoke scripts live under `scripts`.
285. Runtime CLI entrypoints live under `src/orchestration/cli.ts` and `campaign-cli.ts`.
286. The service is currently separate from the Tauri process.
287. The architecture allows it to become a bundled sidecar later.
288. The frontend default runtime URL is `http://127.0.0.1:4317`.
289. That URL can be overridden by `VITE_AGENT_RUNTIME_URL`.
290. Runtime availability can be checked with `GET /health`.

## 9. Agent Runtime Entrypoint Snippet

```ts
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const { app } = await buildServer(config);

await app.listen({ host: config.host, port: config.port });
```

291. The entrypoint is deliberately small.
292. Small entrypoints make startup failures easier to isolate.
293. Config loading happens before server creation.
294. Server creation constructs the runtime dependencies.
295. Listening happens only after dependencies are ready.
296. If startup fails before listening, inspect `config.ts` and `server.ts`.
297. If listening fails, inspect port conflicts and host settings.
298. If HTTP works but sessions fail, inspect `AgentRuntime` and `SessionManager`.
299. If events fail, inspect `EventBus` and the SSE route.
300. If provider execution fails, inspect runtime provider configuration.

## 10. Fastify Runtime Server

301. `server.ts` creates a Fastify instance.
302. It creates an `EventBus`.
303. It creates a `SessionManager`.
304. It loads persisted session state.
305. It creates an `AgentRuntime`.
306. It adds permissive CORS headers for local desktop usage.
307. It responds to `OPTIONS` preflight requests.
308. `GET /health` returns runtime health.
309. `POST /sessions` creates a session.
310. `POST /sessions/:id/turn` runs a user turn.
311. `GET /sessions/:id` returns a session.
312. `GET /sessions/:id/events` opens an SSE stream.
313. `POST /sessions/:id/patches/:patchId/approve` approves a patch proposal.
314. `POST /sessions/:id/patches/:patchId/reject` rejects a patch proposal.
315. `POST /sessions/:id/patches/:patchId/result` accepts Rust patch apply results.
316. `POST /sessions/:id/commands/:requestId/result` accepts command execution results.
317. Protected endpoints check session tokens.
318. Session tokens can arrive as `x-hivo-session-token`.
319. Session tokens can arrive as `x-orchcode-session-token`.
320. SSE tokens can arrive as `?token=...`.
321. Missing token records are treated as no-token sessions.
322. Invalid token records reject the request.
323. Expired tokens can mark sessions expired.
324. SSE filters session events.
325. SSE writes `event: <type>`.
326. SSE writes `data: <json>`.
327. The frontend subscribes to specific event types.
328. HTTP routes perform basic body validation.
329. Runtime routes return `400` for missing required fields.
330. Runtime routes return `401` for invalid session tokens.
331. Runtime routes return `404` for missing sessions or patch IDs.
332. The server does not apply patches to disk.
333. The server only records runtime approval and accepts Rust results.
334. The server does not run shell commands directly.
335. Command execution is reported back from Rust authority.

## 11. SSE Server Snippet

```ts
app.get("/sessions/:id/events", async (request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const unsubscribe = eventBus.subscribe((event) => {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", unsubscribe);
});
```

336. This is the live bridge from runtime to UI.
337. If the UI does not update, check this endpoint.
338. If the endpoint is unauthorized, check the session token.
339. If the endpoint connects but events are missing, check `EventBus.publish`.
340. If events arrive but do not render, check frontend event handlers.

## 12. Session Manager

341. `SessionManager` lives in `apps/agent-runtime/src/runtime/SessionManager.ts`.
342. It stores sessions in a `Map`.
343. It stores session token records in a `Map`.
344. It persists session snapshots to `sessions.json`.
345. It can restore sessions from persisted state.
346. It can attempt replay from durable runtime events.
347. It falls back to snapshot restore when replay is insufficient.
348. It publishes `runtime.session.restored` on restore.
349. It publishes `runtime.session.created` on create.
350. It publishes `runtime.session.updated` on updates.
351. It creates session IDs with a helper based on UUIDs.
352. It hashes session tokens.
353. It stores token expiry timestamps.
354. It validates tokens during HTTP requests.
355. It marks sessions expired when token expiry is reached.
356. It initializes `taskState`.
357. It initializes `messages`.
358. It initializes `tasks`.
359. It initializes `toolCalls`.
360. It initializes `toolIntents`.
361. It initializes `artifacts`.
362. It initializes `patchProposals`.
363. It initializes `commandRequests`.
364. It initializes `commandExecutions`.
365. It initializes `backgroundJobs`.
366. It initializes `reasoningSummaries`.
367. It initializes `progressEvents`.
368. It initializes `agentWorkStatuses`.
369. It initializes orchestration state for orchestrated sessions.
370. It merges safety settings from the selected access profile.
371. It records declared access policy.
372. It records resolved access policy.
373. It records trust profile.
374. It records provider config.
375. It records active provider source.
376. It records execution mode.
377. It records whether `thinkFirst` is active.
378. It adds the initial user prompt as the first message.
379. It updates `updatedAt` on every session mutation.
380. It writes and publishes after updates.

## 13. Session Creation Snippet

```ts
const session: AgentRuntimeSession = {
  id: randomId("session"),
  workspacePath: input.workspacePath,
  mode: input.mode,
  status: "created",
  lifecycleStage: "INTAKE",
  messages: [{
    id: randomId("msg"),
    role: "user",
    content: input.userPrompt,
    createdAt: now
  }],
  patchProposals: [],
  commandRequests: [],
  commandExecutions: []
};
```

381. The real object contains more fields than the shortened snippet.
382. The snippet shows the most important runtime shape.
383. Session state is the UI-facing source of truth.
384. Durable runtime events are the replay-oriented source of truth.
385. SQLite session events are the Rust bridge source of truth.
386. These sources overlap but are not identical.
387. Debugging restore requires checking all relevant stores.
388. Debugging patch apply requires checking SQLite events.
389. Debugging live UI requires checking session updates and SSE.
390. Debugging stale lifecycle state requires checking session mutation paths.

## 14. AgentRuntime Facade

391. `AgentRuntime` lives in `apps/agent-runtime/src/runtime/AgentRuntime.ts`.
392. It is the public runtime facade.
393. It creates sessions.
394. It runs turns.
395. It handles pending actions.
396. It handles direct conversation replies.
397. It resolves execution mode.
398. It creates provider telemetry.
399. It creates tool registries.
400. It builds a project map.
401. It routes simple mode to `RunEngine`.
402. It routes orchestrated mode to orchestrated runtime logic.
403. It stops unsafe deterministic orchestration combinations when needed.
404. It handles `thinkFirst` planning clarification.
405. It handles patch approval.
406. It handles patch rejection.
407. It handles patch apply results.
408. It handles command execution results.
409. It builds run summaries after failure.
410. It records provider telemetry.
411. It can use `MockLlmProvider`.
412. It can use `OllamaProvider`.
413. It can use `OpenAIProvider`.
414. It wraps providers with `TelemetryLlmProvider`.
415. It uses `ConversationUnderstanding`.
416. It uses `IntentDecisionEngine`.
417. It uses `ToolRegistry`.
418. It uses `RunEngine`.
419. It uses `OrchestratedRuntime`.
420. It uses `CoreOrchestrator` for some agentic paths.
421. It uses patch planning and reconciliation helpers.
422. It uses command risk helpers.
423. It uses module execution validation helpers.
424. It catches runtime errors and marks sessions failed.
425. A failed turn receives a human-readable assistant message.
426. A failed turn receives a `runSummary`.
427. Runtime failures should be visible to the operator.
428. Runtime failures should not silently continue.
429. Runtime approval state should be explicit.
430. Runtime execution mode should be visible in session state.

## 15. Execution Mode Snippet

```ts
if (modeResolution.mode === "orchestrated_mode") {
  updated = await this.runOrchestratedTurn(
    sessionId,
    promptForExecution,
    projectMap,
    thinkFirst,
    conversationUnderstanding
  );
} else {
  updated = await new RunEngine(provider, this.sessionManager, { providerTelemetry }).runTurn(
    sessionId,
    promptForExecution,
    { resolvedMode: modeResolution.mode, projectMap, thinkFirst, conversationUnderstanding }
  );
}
```

431. This is the main runtime fork.
432. If a task did not use multi-agent mode, inspect `resolveExecutionMode`.
433. If a task paused for clarification, inspect `thinkFirst`.
434. If a task responded conversationally, inspect `IntentDecisionEngine`.
435. If simple execution failed, inspect `RunEngine`.
436. If orchestrated execution failed, inspect orchestration session state.
437. If real provider behavior is unexpected, inspect provider telemetry.
438. If commands are blocked, inspect safety settings and command policy.
439. If patches are not applied, inspect Rust patch authority.
440. If status is stale, inspect `SessionManager.updateSession`.

## 16. ToolRegistry

441. `ToolRegistry` lives in `apps/agent-runtime/src/tools/ToolRegistry.ts`.
442. It creates the runtime tool surface.
443. It owns `workspace`.
444. It owns `git`.
445. It owns `command`.
446. It owns `patch`.
447. It accepts a workspace path.
448. It accepts an optional worker capability grant.
449. Grants restrict worker tools.
450. Grants restrict worker paths.
451. Grants restrict patch proposal ability.
452. `createToolCall` creates tool-call records.
453. Tool-call IDs start with `tool_`.
454. Tool calls have a status.
455. Tool calls can include input summaries.
456. Tool calls can include output summaries.
457. Tool calls are attached to sessions.
458. Tool calls are useful for UI tracing.
459. Tool calls are useful for debugging worker actions.
460. Tool calls are not the same as durable runtime events.

```ts
export class ToolRegistry {
  readonly workspace: WorkspaceTools;
  readonly git: GitTools;
  readonly command: CommandTools;
  readonly patch: PatchTools;
}
```

461. `WorkspaceTools` reads and searches files.
462. `GitTools` inspects git state.
463. `CommandTools` creates command requests.
464. `PatchTools` creates patch proposals.
465. Runtime tools are intentionally constrained.
466. Tool grants allow narrow worker behavior.
467. Narrow workers reduce accidental broad edits.
468. Narrow workers make review easier.
469. Tool boundaries make audit easier.
470. Tool boundaries support future safe delegation.

## 17. WorkspaceTools

471. `WorkspaceTools` lives in `apps/agent-runtime/src/tools/WorkspaceTools.ts`.
472. It is the Node-side workspace reader.
473. It lists files.
474. It reads files.
475. It reads whole files when allowed.
476. It checks file existence.
477. It searches code.
478. It creates a project summary.
479. It blocks secret-like files.
480. It resolves paths inside the workspace.
481. It honors worker capability grants.
482. It ignores generated and vendor directories.
483. It reads text-like files.
484. It infers languages from extensions.
485. It infers package managers from important files.
486. It infers test commands from package managers and languages.
487. It limits list results.
488. It limits file read preview size.
489. It does not write files.
490. It does not delete files.
491. The disabled write path is intentional.
492. Runtime writes would bypass Rust authority.
493. Runtime writes would weaken patch auditability.
494. Runtime writes would weaken approval gates.
495. Runtime writes would make reconciliation harder.
496. If a worker needs to change code, it should propose a patch.
497. If a worker needs to execute a command, it should request a command.
498. If a worker needs to read a file outside its grant, the grant is wrong or the task is too broad.
499. If a file is blocked as a secret, that is usually intended.
500. If search misses a file, check ignore rules and limits.

## 18. Disabled Runtime Write Snippet

```ts
writeFile(relativePath: string, content: string) {
  void relativePath;
  void content;
  throw new Error("Runtime file writes are disabled; propose a patch intent for Rust authority.");
}
```

501. This is one of the clearest safety decisions in the codebase.
502. Runtime workers can inspect.
503. Runtime workers can reason.
504. Runtime workers can propose.
505. Runtime workers cannot directly mutate source files.
506. Rust is the patch authority.
507. The UI is the operator approval surface.
508. SQLite is the authoritative patch event store.
509. Git snapshots provide evidence.
510. This split is central to the project.

## 19. PatchTools

511. `PatchTools` lives in `apps/agent-runtime/src/tools/PatchTools.ts`.
512. It creates `PatchProposal` objects.
513. It validates patch proposal metadata.
514. It checks changed file paths.
515. It warns when a diff does not look like a standard git unified diff.
516. It marks proposals as requiring approval.
517. It sets proposal status to `proposed`.
518. It assigns patch IDs with the `patch_` prefix.
519. It checks capability grants.
520. It refuses proposals when grants disallow them.
521. It does not apply proposals.
522. `applyProposal` intentionally returns `applied: false`.
523. The message says Rust patch authority must apply the patch.
524. This prevents accidental runtime mutation.
525. Patch proposals should include `filesChanged`.
526. Patch proposals should include `unifiedDiff`.
527. Patch proposals should include a summary.
528. Patch proposals should include risk metadata.
529. Patch proposals should be displayed in the desktop diff panel.
530. Patch proposals require operator approval before application.

```ts
applyProposal(proposal: PatchProposal) {
  return {
    applied: false,
    changedPaths: [],
    message: `Runtime patch apply is disabled for ${proposal.id}; Rust patch authority must apply it.`
  };
}
```

531. If a patch is approved but no files change, check whether Rust apply was invoked.
532. If Rust cannot find the proposal, check SQLite `session_events`.
533. If Rust rejects paths, check diff file headers.
534. If `git apply` rejects the diff, check working tree and patch context.
535. If UI does not show the proposal, check runtime patch events.
536. If runtime does not receive the result, check `reportRuntimePatchApplyResult`.
537. Patch debugging is easiest when you keep runtime approval and Rust application separate.
538. Approval is a decision.
539. Application is a filesystem operation.
540. Reconciliation is evidence after application.

## 20. Memory System

541. Project memory lives under `.agent_memory/`.
542. `.agent_memory/README.md` documents the memory layout.
543. `.agent_memory/schema_version.json` marks the schema version.
544. `repo_index.json` stores repository structure.
545. `file_manifest.json` stores deterministic file metadata.
546. `symbol_index.json` stores heuristic symbols, imports, and exports.
547. `file_summaries.jsonl` stores per-file summaries.
548. `command_inventory.json` stores discovered commands.
549. `decisions.jsonl` stores append-only architectural decisions.
550. `task_history.jsonl` stores append-only task notes.
551. `lessons_learned.jsonl` stores durable lessons.
552. `failed_attempts.jsonl` stores failed strategies.
553. `successful_patterns.jsonl` stores successful patterns.
554. `project_glossary.json` stores project vocabulary.
555. `architecture_notes.jsonl` stores durable architecture facts.
556. `index_state.json` stores freshness metadata.
557. `project_intelligence.json` stores dependency, test, command, module, and risk maps.
558. `runs/` stores volatile run artifacts.
559. `campaigns/` stores volatile campaign artifacts.
560. `evals/` stores evaluation summaries.
561. Large generated artifacts should usually remain local.
562. Secrets should never be stored in memory.
563. Memory indexing ignores vendor and build directories.
564. Memory indexing skips binary files.
565. Memory indexing records skipped files.
566. Memory indexing records important files.
567. Memory indexing records entrypoints.
568. Memory indexing records test files.
569. Memory indexing records config files.
570. Memory indexing records docs.
571. A stale index is a blocker for context-sensitive work.
572. `memory:index-status` checks freshness.
573. `memory:index-refresh` refreshes stale memory.
574. `memory:compact` stores lessons after meaningful runs.
575. Memory artifacts are part of auditability.
576. Memory artifacts help future workers avoid repeated discovery.
577. Memory artifacts help staffing decisions.
578. Memory artifacts help command selection.
579. Memory artifacts help context pack construction.
580. Memory artifacts help run reporting.

## 21. RepoIndexer

581. `RepoIndexer.ts` lives in `apps/agent-runtime/src/memory/RepoIndexer.ts`.
582. It is the main memory index builder.
583. It resolves the workspace root.
584. It ensures the memory layout exists.
585. It collects files.
586. It skips ignored directories.
587. It skips binary files.
588. It honors a max file size.
589. It hashes files for the manifest.
590. It builds the symbol index.
591. It builds the command inventory.
592. It builds file summaries.
593. It builds the repo index document.
594. It builds project intelligence.
595. It writes `repo_index.json`.
596. It writes `file_manifest.json`.
597. It writes `symbol_index.json`.
598. It writes `command_inventory.json`.
599. It writes `project_intelligence.json`.
600. It writes file summaries.
601. Text extensions include `.ts`, `.tsx`, `.js`, `.rs`, `.md`, `.json`, `.toml`, and others.
602. Binary extensions include images, archives, executables, and SQLite files.
603. Ignored directories include `.git`.
604. Ignored directories include `.agent_memory`.
605. Ignored directories include `node_modules`.
606. Ignored directories include `dist`.
607. Ignored directories include `target`.
608. Ignored directories include `tmp`.
609. Config basenames include `package.json`.
610. Config basenames include `tsconfig.json`.
611. Config basenames include `Cargo.toml`.
612. Config basenames include `tauri.conf.json`.
613. Build basenames include `vite.config.ts`.
614. Dependency basenames include `package-lock.json`.
615. Dependency basenames include `Cargo.lock`.
616. Source extensions determine source file counts.
617. Docs are counted separately.
618. Tests are mapped heuristically.
619. Command inventory is built from package and Cargo metadata.
620. Project intelligence combines these signals.

## 22. RepoIndexer Pipeline Snippet

```ts
const symbolIndex = buildSymbolIndex(fileManifest, fileText, generatedAt);
const commandInventory = buildCommandInventory({ generatedAt, files: fileManifest, fileText });
const fileSummaries = buildFileSummaries(fileManifest, symbolIndex.files);
const repoIndex = buildRepoIndexDocument({
  generatedAt,
  workspaceRoot,
  files: fileManifest,
  fileText,
  skippedFiles: collection.skippedFiles,
  ignoredDirectories: collection.ignoredDirectories
});
```

621. The symbol index powers lightweight code understanding.
622. The command inventory powers validation and run planning.
623. File summaries power context selection.
624. Repo index powers staffing and architecture maps.
625. Project intelligence ties these outputs together.
626. The index should be deterministic enough to diff.
627. Changed files should trigger freshness warnings.
628. Freshness warnings should not be ignored in serious work.
629. Index refresh is safer than relying on stale memory.
630. Index compacting is useful after successful or failed runs.

## 23. Core Orchestrator

631. `CoreOrchestrator` lives in `apps/agent-runtime/src/orchestration/Orchestrator.ts`.
632. It is the older core orchestration engine.
633. It can run plan-only mode.
634. It can run agentic tasks.
635. It creates runs.
636. It writes checkpoints.
637. It transitions run state.
638. It loads or rebuilds repository memory.
639. It creates multi-plans when needed.
640. It creates task graphs.
641. It creates agent teams when needed.
642. It runs dependency-ready tasks.
643. It acquires durable locks for write scopes.
644. It derives module locks.
645. It derives semantic locks.
646. It invokes role-specific workers.
647. It validates structured outputs.
648. It repairs malformed outputs when possible.
649. It tracks patch fingerprints.
650. It runs review loops.
651. It runs validation loops.
652. It manages patch apply sandboxing.
653. It manages integration gates.
654. It writes final reports.
655. It writes run metrics.
656. It appends memory decisions.
657. It appends failed attempts.
658. It appends successful patterns.
659. It is heavily tested by orchestration tests.
660. It is a central place for task graph debugging.

## 24. Durable Lock Snippet

```ts
const lockResult = await lockManager.acquireLocks({
  request_id: `lock_request_${randomUUID()}`,
  run_id: run.id,
  task_id: task.id,
  owner_component: "CoreOrchestrator",
  scopes: lockScopes.map((scope) => lockManager.normalizeLockScope(scope, "write"))
});
```

661. Durable locks protect write scopes.
662. Lock scopes can be file-level.
663. Lock scopes can be module-level.
664. Lock scopes can be semantic.
665. Lock results should be recorded.
666. Lock failures should block unsafe execution.
667. Lock TTL comes from orchestration config.
668. Lock artifacts are part of the source of truth.
669. A blocked run may be blocked by locks rather than model failure.
670. Lock debugging belongs in orchestration artifacts.

## 25. Orchestration CLI

671. The orchestration CLI lives in `apps/agent-runtime/src/orchestration/cli.ts`.
672. It parses command-line arguments.
673. It supports `--workspace`.
674. It supports `--memory-dir`.
675. It supports `--run`.
676. It supports `--json`.
677. It supports `--mode`.
678. It supports `--agent-limit`.
679. It supports `--artifact`.
680. It dispatches `agent` commands.
681. It dispatches `swarm` commands.
682. It dispatches older `run-agentic-task` commands.
683. It dispatches older `plan-task` commands.
684. It dispatches artifact inspection commands.
685. `agent run` uses `SwarmAutopilotRuntime`.
686. `agent plan` uses `SwarmAutopilotRuntime.plan`.
687. `agent inspect-run` uses swarm inspection helpers.
688. `agent report` loads swarm reports.
689. `agent resume` resumes swarm runs.
690. `agent trial` uses `SwarmTrialLab`.
691. `show-run` loads core orchestration run details.
692. `show-context-pack` loads task context packs.
693. `show-validation-logs` loads validation logs.
694. `show-patch-history` loads patch history.
695. `show-artifacts` lists run artifacts.
696. `show-artifact` reads one artifact.
697. CLI output can be JSON.
698. CLI errors are written to stderr.
699. CLI failures set `process.exitCode = 1`.
700. CLI commands are the primary non-UI automation surface.

## 26. Swarm Autopilot Runtime

701. `SwarmAutopilotRuntime` lives in `apps/agent-runtime/src/orchestration/SwarmRuntime.ts`.
702. It is the internal swarm autopilot engine.
703. It hides internal staffing from the normal user experience.
704. It creates a run for a user goal.
705. It transitions through intake.
706. It transitions through prompt rewrite.
707. It transitions through clarification check.
708. It transitions through repository mapping.
709. It loads or rebuilds memory.
710. It reads previous failed attempts.
711. It creates a staffing plan.
712. It saves the staffing plan.
713. It records effective logical agent count.
714. It builds scheduler config.
715. It emits staffing events.
716. It creates agent templates.
717. It creates agent instances.
718. It creates work items.
719. It saves work items.
720. It saves initial leases.
721. It emits queued work-item events.
722. `run` calls `plan` first.
723. `run` creates a scheduler.
724. The scheduler uses `DurableLockManager`.
725. The scheduler uses a configured worker.
726. The worker may be mock.
727. The worker may be provider-backed and read-only.
728. The scheduler returns work items and metrics.
729. The runtime creates a consensus group.
730. The runtime writes metrics.
731. The runtime writes a final report.
732. The runtime appends durable memory decisions.
733. Successful runs append successful patterns.
734. Failed or blocked runs preserve evidence.
735. Swarm artifacts live under `.agent_memory/swarm_runs/<run_id>/`.
736. Trial artifacts live under `.agent_memory/swarm_trials/<experiment_id>/`.
737. The maximum supported logical agent count is 300.
738. The selected count is usually much smaller.
739. Executor limits are separate from total agent counts.
740. Validation level is selected from task risk and available commands.

## 27. Swarm Staffing Snippet

```ts
const staffingPlan = new SwarmStaffingPlanner().createPlan({
  swarmRunId: run.id,
  userGoal,
  mode: this.mode,
  repoIndex: memory.repoIndex,
  commandInventory: memory.commandInventory,
  previousFailures,
  explicitAgentLimit: this.explicitAgentLimit
});
```

741. Staffing depends on the goal.
742. Staffing depends on repository memory.
743. Staffing depends on command inventory.
744. Staffing depends on previous failures.
745. Staffing can be capped by an explicit limit.
746. The explicit limit is not meant to become the normal UX.
747. The planner records reasoning.
748. The planner records risk level.
749. The planner records repository scope.
750. The planner records validation level.

## 28. SwarmStaffingPlanner

751. `SwarmStaffingPlanner` lives in `apps/agent-runtime/src/orchestration/SwarmStaffingPlanner.ts`.
752. It creates `StaffingPlan` objects.
753. It uses `SpecialistAgentFactory`.
754. It infers relevant files.
755. It infers task complexity.
756. It infers repository scope.
757. It infers risk level.
758. It detects read-only goals.
759. It checks whether validation commands exist.
760. It creates dynamic specialists from evidence.
761. It creates base role counts.
762. It adds specialist role counts.
763. It calculates executor caps.
764. It caps executor count.
765. It calculates recommended total logical agents.
766. It shrinks read-only roles if an explicit limit is provided.
767. It enforces `MAX_SUPPORTED_LOGICAL_AGENTS`.
768. It calculates write-agent limits.
769. It calculates read-only ratio.
770. It calculates max parallel agents.
771. It calculates validation level.
772. It decides whether human approval is required.
773. It records reasoning strings.
774. It records downgrade conditions.
775. It records escalation conditions.
776. It records confidence.
777. Tiny tasks usually get very few agents.
778. Small tasks usually get a scout, planner, executor, reviewer, and reporter.
779. Medium tasks add context, architecture, risk, testing, and integration roles.
780. Large tasks scale scout and review counts.
781. Huge read-only tasks may use very high read-only counts.
782. Critical risk reduces executors and increases review.
783. Sensitive files require human approval.
784. Package files and lockfiles increase risk.
785. Auth, secrets, payment, and production language can make risk critical.
786. Runtime, scheduler, and orchestrator changes tend to be medium risk.
787. The planner should avoid overstaffing tiny changes.
788. The planner should avoid understaffing whole-repo audits.
789. Staffing decisions are written to artifacts.
790. Staffing decisions are reported back to the operator.

## 29. Staffing Tiny Task Snippet

```ts
if (taskComplexity === "tiny") {
  counts.ScoutAgent = 1;
  counts.PlannerAgent = 0;
  counts.ExecutorAgent = isReadOnly ? 0 : 1;
  counts.ReviewerAgent = 1;
  counts.ReporterAgent = 1;
}
```

791. Tiny tasks do not get hundreds of agents.
792. Read-only tiny tasks get no executor.
793. Write tiny tasks can get one executor.
794. Review remains present even for tiny tasks.
795. Reporting remains present even for tiny tasks.
796. Tester count depends on validation availability and write behavior.
797. Executor fan-out is intentionally conservative.
798. This supports the AGENTS.md instruction to avoid asking the user how many agents to use.
799. The system staffs itself from evidence.
800. The staffing report explains the decision.

## 30. Swarm Scheduler and Work Items

801. `SwarmScheduler` runs dependency-aware work items.
802. `SwarmFanInOut.ts` creates initial work items.
803. Work items can be scout work.
804. Work items can be planning work.
805. Work items can be architecture work.
806. Work items can be execution work.
807. Work items can be review work.
808. Work items can be validation work.
809. Work items can be integration work.
810. Work items can be reporting work.
811. Scout work is read-only.
812. Planning work is read-only.
813. Review work is read-only.
814. Validation work may request commands.
815. Execution work may write through controlled paths.
816. Integration work combines results.
817. Work items have dependencies.
818. Work items have required roles.
819. Work items have read files.
820. Work items have write files.
821. Work items have status.
822. Work items produce results.
823. Leases prevent duplicate active work.
824. Durable locks protect write scopes.
825. Scheduler traces record execution order.
826. Metrics record active agent counts.
827. Metrics record validation information.
828. Metrics record failures and blocks.
829. Consensus groups summarize readiness.
830. The final report combines work items, metrics, and staffing.

## 31. Traditional Multi-Agent Orchestration

831. The traditional orchestrated mode has product, business, and engineering layers.
832. `ProductOrchestrator` creates a `ProductBrief`.
833. `BusinessOrchestrator` creates a `BusinessBrief`.
834. `EngineeringOrchestrator` creates a `TechnicalPlan`.
835. `EngineeringOrchestrator` creates a deterministic `TaskGraph`.
836. Worker agents include a codebase mapper.
837. Worker agents include an architect.
838. Worker agents include a Rust backend worker.
839. Worker agents include a frontend worker.
840. Worker agents include a tooling terminal worker.
841. Worker agents include a test worker.
842. Worker agents include a security worker.
843. Worker agents include a reviewer.
844. `BaseWorker` provides common worker execution behavior.
845. `GenericWorkerAgent` supports dynamically specified work.
846. Worker prompts live under `apps/agent-runtime/src/prompts/workers`.
847. Structured worker outputs should include evidence.
848. Structured worker outputs should include file paths.
849. Structured worker outputs should include command requests.
850. Structured worker outputs should include unresolved risks.
851. Reviewers prioritize correctness.
852. Reviewers prioritize safety.
853. Reviewers prioritize scope.
854. Reviewers prioritize test gaps.
855. Security review is a mandatory gate in orchestrated mode.
856. Reviewer summary is a mandatory gate in orchestrated mode.
857. Patch proposals require approval.
858. The desktop UI can render orchestration timelines.
859. The desktop UI can render briefs and worker outputs.
860. Orchestrated mode is the user-facing multi-agent path.

## 32. Desktop Frontend

861. The desktop frontend lives in `apps/desktop/src`.
862. It uses Vite.
863. It uses React.
864. It uses TypeScript.
865. The entrypoint is `apps/desktop/src/main.tsx`.
866. The main component is `apps/desktop/src/app/App.tsx`.
867. Styles live in `apps/desktop/src/app/styles.css`.
868. Frontend runtime HTTP helpers live in `apps/desktop/src/lib/agentRuntime.ts`.
869. Tauri invoke helpers live in `apps/desktop/src/lib/tauri.ts`.
870. Terminal orchestration helpers live in `apps/desktop/src/lib/terminalOrchestrator.ts`.
871. Activity stream helpers live in `apps/desktop/src/app/activityStream.ts`.
872. The UI imports icons from `lucide-react`.
873. The UI imports shared types from `@hivo/protocol`.
874. The UI stores recent workspaces.
875. The UI stores recent sessions.
876. The UI stores prompt history.
877. The UI stores composer scale.
878. The UI stores sidebar width.
879. The UI stores RTL text mode.
880. The UI stores session tokens.
881. The UI stores collapsed projects.
882. The UI stores archived sessions.
883. The UI stores pinned sessions.
884. The UI stores provider settings.
885. The UI shows a workspace sidebar.
886. The UI shows a chat/task panel.
887. The UI shows agent and task state.
888. The UI shows git status.
889. The UI shows terminal output.
890. The UI shows diffs.
891. The UI opens settings for model providers.
892. The UI calls runtime HTTP endpoints.
893. The UI calls Tauri commands.
894. The UI subscribes to runtime SSE events.
895. The UI reports patch apply results back to runtime.
896. The UI reports command results back to runtime.
897. The UI does not directly mutate the filesystem.
898. The UI mediates operator approvals.
899. The UI is the human control surface.
900. The UI is not the authority layer.

## 33. React Entrypoint Snippet

```tsx
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

901. The frontend entrypoint is straightforward.
902. Most UI complexity is inside `App.tsx`.
903. If the app does not mount, check `index.html` and `main.tsx`.
904. If state renders incorrectly, check `App.tsx`.
905. If runtime data does not arrive, check `agentRuntime.ts`.
906. If Tauri commands fail, check `tauri.ts` and Rust command names.
907. If terminal behavior is wrong, check `terminalOrchestrator.ts` and Rust terminal service.
908. If CSS layout breaks, check `styles.css`.
909. If protocol types break, rebuild `packages/protocol`.
910. Frontend changes should usually run desktop typecheck.

## 34. Frontend Runtime HTTP Helpers

911. `agentRuntime.ts` uses `fetch`.
912. It sets `runtimeBaseUrl` from `VITE_AGENT_RUNTIME_URL`.
913. It defaults to `http://127.0.0.1:4317`.
914. `createRuntimeSession` calls `POST /sessions`.
915. `runRuntimeTurn` calls `POST /sessions/:id/turn`.
916. `getRuntimeSession` calls `GET /sessions/:id`.
917. `approveRuntimePatch` calls the patch approve endpoint.
918. `rejectRuntimePatch` calls the patch reject endpoint.
919. `reportRuntimePatchApplyResult` calls the patch result endpoint.
920. `reportRuntimeCommandResult` calls the command result endpoint.
921. `subscribeRuntimeEvents` creates an `EventSource`.
922. SSE tokens are passed in the URL query.
923. Event listeners are registered for runtime session events.
924. Event listeners are registered for patch events.
925. Event listeners are registered for command events.
926. Event listeners are registered for verification events.
927. Event listeners are registered for orchestration events.
928. `runtimeFetch` adds JSON content type.
929. `runtimeFetch` adds session token headers when provided.
930. `runtimeFetch` throws when HTTP status is not OK.

## 35. Tauri Frontend Helpers

931. `tauri.ts` wraps Tauri `invoke`.
932. `openWorkspace` invokes `open_workspace`.
933. `getWorkspaceInfo` invokes `get_workspace_info`.
934. `listWorkspaceFiles` invokes `list_workspace_files`.
935. `readWorkspaceFile` invokes `read_workspace_file`.
936. `getGitStatus` invokes `get_git_status`.
937. `getGitDiff` invokes `get_git_diff`.
938. `runWorkspaceCommand` invokes `run_workspace_command`.
939. `executeApprovedCommand` invokes `execute_approved_command`.
940. `createRuntimeRun` invokes `create_runtime_run`.
941. `appendSessionEvent` invokes `append_session_event`.
942. `getSavedRuntimeSession` invokes `get_saved_runtime_session`.
943. `upsertOrchestrationRun` invokes `upsert_orchestration_run`.
944. `upsertAgentRun` invokes `upsert_agent_run`.
945. `applyRuntimePatch` invokes `apply_runtime_patch`.
946. `rejectRuntimePatchViaRust` invokes `reject_runtime_patch`.
947. `validateModelProvider` invokes `validate_model_provider`.
948. `listAvailableModels` invokes `list_available_models`.
949. `saveModelProviderConfig` invokes `save_model_provider_config`.
950. `restartWithLatestCode` invokes `restart_with_latest_code`.

## 36. Rust/Tauri Backend

951. Rust backend code lives in `apps/desktop/src-tauri/src`.
952. `lib.rs` builds the Tauri application state.
953. `main.rs` calls into `lib.rs`.
954. `commands/` contains Tauri command handlers.
955. `services/` contains backend services.
956. `db/` contains SQLite persistence.
957. `models/` contains Rust-side models.
958. `security/` contains security helpers.
959. `AppState` stores `WorkspaceService`.
960. `AppState` stores `DatabaseService`.
961. `AppState` stores `GitService`.
962. `AppState` stores `TerminalService`.
963. `AppState` stores `PatchService`.
964. `AppState` stores `ProjectIndexService`.
965. `AppState` stores `ModelProviderService`.
966. Tauri manages `AppState`.
967. Tauri registers workspace commands.
968. Tauri registers git commands.
969. Tauri registers terminal commands.
970. Tauri registers session commands.
971. Tauri registers patch commands.
972. Tauri registers system commands.
973. Tauri registers model provider commands.
974. Rust owns workspace boundaries.
975. Rust owns command execution.
976. Rust owns patch application.
977. Rust owns SQLite persistence.
978. Rust records authoritative patch events.
979. Rust validates paths before applying patches.
980. Rust captures Git evidence when possible.

## 37. Tauri State Snippet

```rust
pub struct AppState {
    pub workspace: Mutex<WorkspaceService>,
    pub db: Mutex<DatabaseService>,
    pub git: GitService,
    pub terminal: TerminalService,
    pub patch: PatchService,
    pub index: ProjectIndexService,
    pub model_provider: ModelProviderService,
}
```

981. The state object shows the Rust ownership split.
982. Workspace state is mutex-protected.
983. Database access is mutex-protected.
984. Git service is stateless enough to store directly.
985. Terminal service is stored directly.
986. Patch service is stored directly.
987. Project index service is stored directly.
988. Model provider service is stored directly.
989. Commands access this state through Tauri.
990. The frontend never owns these services directly.

## 38. WorkspaceService

991. `WorkspaceService` lives in `apps/desktop/src-tauri/src/services/workspace.rs`.
992. It stores the active workspace path.
993. It stores the active project ID.
994. `open_workspace` canonicalizes the requested path.
995. `open_workspace` rejects inaccessible paths.
996. `open_workspace` rejects non-directory paths.
997. `workspace_path` returns the active workspace path.
998. `ensure_inside_workspace` validates file paths.
999. `ensure_inside_workspace` accepts absolute or relative paths.
1000. `ensure_inside_workspace` canonicalizes candidates.
1001. `ensure_inside_workspace` rejects paths outside the workspace.
1002. `ensure_command_cwd` validates command working directories.
1003. `list_files` uses `ignore::WalkBuilder`.
1004. `list_files` can respect `.gitignore`.
1005. `list_files` has a max depth.
1006. `list_files` skips generated folders.
1007. `list_files` returns `FileEntry` objects.
1008. `read_file` rejects directories.
1009. `read_file` blocks secret-like files.
1010. `read_file` reads text from disk.

## 39. PatchService and Rust Patch Command

1011. `PatchService` lives in `apps/desktop/src-tauri/src/services/patch.rs`.
1012. `apply_runtime_patch` lives in `apps/desktop/src-tauri/src/commands/patch.rs`.
1013. The command receives `session_id`.
1014. The command receives `patch_id`.
1015. The command reads the active workspace path.
1016. The command loads the patch payload from SQLite.
1017. The command extracts `unifiedDiff`.
1018. The command validates that the payload patch ID matches.
1019. The command validates patch paths.
1020. The command captures a before Git snapshot.
1021. The command appends `patch.apply_started`.
1022. The command applies the patch.
1023. The patch service writes a temporary diff file.
1024. The patch service runs `git apply --whitespace=nowarn`.
1025. The patch service removes the temporary diff file.
1026. The command records `runtime.patch.apply_failed` on failure.
1027. The command captures an after Git snapshot on success.
1028. The command records `runtime.patch.applied` on success.
1029. The command sets provenance to `rust_patch_service`.
1030. The command returns `PatchApplyResult`.
1031. `PatchApplyResult` includes patch ID.
1032. `PatchApplyResult` includes status.
1033. `PatchApplyResult` includes message.
1034. `PatchApplyResult` includes authority.
1035. `PatchApplyResult` includes reconciliation source.
1036. `PatchApplyResult` includes snapshots.
1037. `PatchApplyResult` includes durable event IDs.
1038. Rejection records `runtime.patch.rejected`.
1039. Rejection does not change files.
1040. Patch authority is intentionally Rust-owned.

## 40. Rust Patch Apply Snippet

```rust
state
    .patch
    .validate_patch_paths_inside_workspace(&patch_text, &workspace_path)?;
let before_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
state.patch.apply_patch(&patch_text, &workspace_path)?;
let after_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
```

1041. Path validation happens before `git apply`.
1042. Git evidence is captured before applying.
1043. Git evidence is captured after applying.
1044. Snapshot availability is recorded.
1045. Non-git workspaces can have unavailable snapshots.
1046. Patch application can fail if context does not match.
1047. Patch application can fail if paths are invalid.
1048. Patch application can fail if the workspace is inaccessible.
1049. Patch application can fail if Git is unavailable.
1050. Rust returns a clear message for the UI and runtime.

## 41. SQLite Persistence

1051. `DatabaseService` lives in `apps/desktop/src-tauri/src/db/mod.rs`.
1052. It opens a SQLite connection.
1053. It creates parent directories for the database path.
1054. It initializes tables.
1055. It enables foreign keys.
1056. It creates a `projects` table.
1057. It creates a `sessions` table.
1058. It creates a `tasks` table.
1059. It creates an `agent_runs` table.
1060. It creates a `tool_calls` table.
1061. It creates a `patches` table.
1062. It creates a `project_memory` table.
1063. It creates a `model_provider_config` table.
1064. It creates an `orchestration_runs` table.
1065. It creates a `session_events` table.
1066. It creates a `command_requests` table.
1067. It creates a `command_results` table.
1068. It creates a `background_jobs` table.
1069. It creates an `artifacts` table.
1070. It creates a `runtime_events` table.
1071. `runtime_events` has ordered sequences.
1072. `runtime_events` has event type.
1073. `runtime_events` has actor.
1074. `runtime_events` has authority.
1075. `runtime_events` has JSON payload.
1076. `runtime_events` has version.
1077. `runtime_events` has correlation ID.
1078. `runtime_events` has causation ID.
1079. `session_events` stores bridge events.
1080. `runtime_events` stores canonical durable events.
1081. Patch payload lookup uses SQLite session event state.
1082. Runtime restore may use durable runtime events.
1083. Snapshot restore is still a fallback.
1084. `add_column_if_missing` supports schema evolution.
1085. `backfill_event_metadata` repairs older event metadata.
1086. Debugging patch proposal lookup often starts in `session_events`.
1087. Debugging replay often starts in `runtime_events`.
1088. Debugging provider config starts in `model_provider_config`.
1089. Debugging command history starts in `command_requests` and `command_results`.
1090. Debugging background commands starts in `background_jobs`.

## 42. Terminal Authority

1091. `TerminalService` lives in `apps/desktop/src-tauri/src/services/terminal.rs`.
1092. It runs workspace commands.
1093. It validates the active workspace path.
1094. It validates the command working directory.
1095. It rejects working directories outside the workspace.
1096. It calls `CommandPolicyService::analyze`.
1097. It classifies command risk.
1098. It blocks dangerous commands by default.
1099. It can allow dangerous commands only under full-access style settings.
1100. It detects network commands.
1101. It detects background commands.
1102. It can block network commands.
1103. It can require approval for medium-risk commands.
1104. It can require approval for background commands.
1105. It can require approval for network commands.
1106. It returns `approval_required` when policy needs operator approval.
1107. It returns `blocked` when policy blocks execution.
1108. It returns `running` for started background commands.
1109. It returns `failed` for failed process starts or exits.
1110. It records command provenance.
1111. It records command failure diagnosis.
1112. It records limited background-job metadata.
1113. It uses `cmd /C` on Windows foreground command execution.
1114. It uses shell execution on non-Windows paths.
1115. It can redact secrets according to settings.
1116. Runtime command requests are not execution.
1117. Rust command execution is execution.
1118. Approval-required is a safety stop.
1119. Blocked commands do not verify the run.
1120. Foreground verification commands are best for reliable feedback.

## 43. Model Provider Layer

1121. The desktop UI has provider settings.
1122. It supports Ollama.
1123. It supports OpenAI-compatible APIs.
1124. It supports OpenRouter-style APIs.
1125. It supports local/private OpenAI-compatible servers.
1126. Rust validates provider settings.
1127. Rust stores sanitized provider config.
1128. Runtime reads provider config passed into sessions.
1129. Runtime can use mock provider mode.
1130. Runtime can use real provider mode.
1131. `ProviderTelemetry` records provider request counts.
1132. `ProviderTelemetry` records provider failures.
1133. `ProviderTelemetry` records provider timeouts.
1134. `ProviderTelemetry` records real provider usage.
1135. `ProviderTelemetry` records mock provider usage.
1136. `ProviderTelemetry` records fallback usage.
1137. `ProviderTelemetry` records active provider source.
1138. Provider source can be runtime default.
1139. Provider source can be desktop saved provider.
1140. Provider source can be session override.
1141. Provider source can be explicit CLI.
1142. Provider source can be unknown.
1143. Provider truth tests protect against false claims.
1144. If real provider was expected, inspect telemetry.
1145. If fallback happened, inspect fallback reason.
1146. If provider validation failed, inspect Rust provider checks.
1147. If model listing failed, inspect base URL and API key.
1148. If mock was used unexpectedly, inspect session mode.
1149. If deterministic-only path ran, inspect execution mode.
1150. Provider truth is part of evidence hygiene.

## 44. Existing Documentation

1151. `docs/architecture.md` is the concise architecture overview.
1152. `docs/orchestration-flow.md` contains a Mermaid orchestration flow.
1153. `docs/security-model.md` documents safety boundaries.
1154. `docs/usage/quickstart.md` documents setup and usage.
1155. `docs/usage/campaigns.md` documents campaign workflows.
1156. `docs/architecture/internal-swarm-autopilot.md` documents internal swarm direction.
1157. `docs/architecture/memory-and-indexing.md` documents repository memory.
1158. `docs/architecture/multi-plan-factory.md` documents multi-plan behavior.
1159. `docs/architecture/durable-locks.md` documents lock foundations.
1160. `docs/architecture/prompt-writer-agents.md` documents prompt writer direction.
1161. `docs/architecture/provider-backed-read-only-swarm-workers.md` documents provider-backed readers.
1162. `docs/architecture/planning-evidence-fan-in.md` documents evidence fan-in.
1163. `docs/architecture/phase-1-memory-indexing-plan.md` documents Phase 1.
1164. `docs/architecture/phase-2-orchestrator-taskgraph-plan.md` documents Phase 2.
1165. `docs/architecture/phase-3-swarm-verification-safety-plan.md` documents Phase 3.
1166. `docs/architecture/phase-4-scale-intelligence-hardening-plan.md` documents Phase 4.
1167. `docs/architecture/phase-6-swarm-autopilot-trial-lab-plan.md` documents Phase 6.
1168. `docs/extension/add-agent-role.md` documents extending worker roles.
1169. `docs/operations/debugging.md` documents debugging operations.
1170. Documentation should be updated when architecture changes.

## 45. Test Map

1171. Runtime tests live in `apps/agent-runtime/src/tests`.
1172. `memory-indexing.test.ts` covers memory indexing.
1173. `command-policy.test.ts` covers command policy.
1174. `orchestration.test.ts` covers orchestration behavior.
1175. `swarm-autopilot.test.ts` covers swarm autopilot.
1176. `swarm-trial-lab.test.ts` covers trial lab behavior.
1177. `patch-validation.test.ts` covers patch validation.
1178. `patch-apply-sandbox.test.ts` covers sandbox patch application.
1179. `durable-lock-manager.test.ts` covers durable locks.
1180. `replay-restore.test.ts` covers restore and replay.
1181. `runtime-event-semantics.test.ts` covers runtime event semantics.
1182. `provider-truth-evidence-hygiene.test.ts` covers provider evidence.
1183. `run-to-green.test.ts` covers run-to-green behavior.
1184. `inspect-explain.test.ts` covers project explanation behavior.
1185. `inspect-explain-read-lanes.test.ts` covers read lanes.
1186. `validation-semantics.test.ts` covers validation aggregation.
1187. Rust service tests exist inside Rust modules.
1188. Desktop smoke tests live under `apps/desktop/scripts`.
1189. Frontend-only changes should run desktop typecheck.
1190. Runtime changes should run agent-runtime tests.
1191. Protocol changes should run root typecheck.
1192. Rust authority changes should run Cargo check or tests.
1193. Memory changes should run memory indexing tests.
1194. Staffing heuristic changes should run staffing eval trials.
1195. Scheduler scale changes should run scheduler-scale trials.
1196. Command policy changes should run command policy tests.
1197. Patch authority changes should run patch tests.
1198. Restore changes should run replay restore tests.
1199. Provider changes should run provider truth tests.
1200. Unrun tests should be reported clearly.

## 46. Practical Debugging Checklist

1201. If the desktop app does not start, check Tauri startup and Vite dev server.
1202. If the UI does not mount, check `main.tsx` and `App.tsx`.
1203. If the workspace does not open, check `WorkspaceService.open_workspace`.
1204. If file listing is incomplete, check `list_files` skip rules and max depth.
1205. If a file cannot be read, check secret detection and workspace boundaries.
1206. If runtime HTTP fails, check whether the agent runtime is listening.
1207. If `/health` fails, check `src/index.ts` and config.
1208. If session create fails, check `POST /sessions` request body.
1209. If turns fail with unauthorized, check session token propagation.
1210. If SSE does not connect, check `/sessions/:id/events`.
1211. If SSE connects but UI is stale, check event handlers.
1212. If a prompt does not use the expected mode, check execution mode resolution.
1213. If a prompt pauses, check `nextAction`.
1214. If a command is approval-required, check safety settings.
1215. If a command is blocked, check command policy risk.
1216. If a command runs but runtime does not update, check command result reporting.
1217. If a patch proposal is missing, check runtime patch events.
1218. If a patch approval does not apply files, check Rust `apply_runtime_patch`.
1219. If Rust cannot find a patch, check SQLite `session_events`.
1220. If Rust rejects a patch path, check diff headers.
1221. If Git rejects a patch, check patch context and working tree state.
1222. If post-apply evidence is missing, check Git snapshot availability.
1223. If restore is wrong, check `sessions.json` and `runtime_events`.
1224. If swarm overstaffs, check staffing planner reasoning.
1225. If swarm understaffs, check relevant file inference.
1226. If specialists appear unexpectedly, check specialist triggers.
1227. If memory is stale, run `npm run memory:index-status`.
1228. If memory is stale, run `npm run memory:index-refresh`.
1229. If provider behavior is wrong, check provider telemetry.
1230. If mock mode was used unexpectedly, check session mode and provider source.

## 47. Safe Change Rules

1231. Read surrounding code before editing.
1232. Prefer existing project patterns.
1233. Keep edits scoped.
1234. Avoid large speculative refactors.
1235. Preserve behavior unless asked to change it.
1236. Use structured APIs where available.
1237. Keep TypeScript strict-mode clean.
1238. Keep generated JSON deterministic.
1239. Do not bypass Rust patch authority.
1240. Do not bypass command authority.
1241. Do not let malformed agent JSON drive code changes.
1242. Repair or reject invalid worker outputs.
1243. Treat file locks as real state.
1244. Treat validation logs as real state.
1245. Treat patch fingerprints as real state.
1246. Treat review artifacts as real state.
1247. Treat approval gates as real stops.
1248. Treat stale memory warnings as blockers for context-sensitive work.
1249. Report unverified status clearly.
1250. Add tests for memory, commands, context, orchestration, and verification changes.

## 48. Ownership Map

1251. Shared type problems usually start in `packages/protocol`.
1252. Runtime HTTP problems usually start in `apps/agent-runtime/src/server.ts`.
1253. Session lifecycle problems usually start in `apps/agent-runtime/src/runtime/SessionManager.ts`.
1254. Turn routing problems usually start in `apps/agent-runtime/src/runtime/AgentRuntime.ts`.
1255. Simple execution problems usually start in `RunEngine`.
1256. Project explanation problems usually start in inspect/explain runtime modules.
1257. Core orchestration problems usually start in `Orchestrator.ts`.
1258. Swarm planning problems usually start in `SwarmRuntime.ts`.
1259. Staffing problems usually start in `SwarmStaffingPlanner.ts`.
1260. Scheduler problems usually start in `SwarmScheduler.ts`.
1261. Artifact problems usually start in `ArtifactStore.ts` or `SwarmArtifactStore.ts`.
1262. Memory index problems usually start in `RepoIndexer.ts`.
1263. Command inventory problems usually start in `CommandInventory.ts`.
1264. Node workspace read problems usually start in `WorkspaceTools.ts`.
1265. Patch proposal problems usually start in `PatchTools.ts`.
1266. Desktop UI state problems usually start in `App.tsx`.
1267. Frontend runtime API problems usually start in `agentRuntime.ts`.
1268. Frontend Tauri command problems usually start in `tauri.ts`.
1269. Rust workspace problems usually start in `services/workspace.rs`.
1270. Rust patch problems usually start in `commands/patch.rs` and `services/patch.rs`.
1271. Rust terminal problems usually start in `services/terminal.rs`.
1272. SQLite problems usually start in `db/mod.rs`.
1273. Model provider validation problems usually start in `services/model_provider.rs`.
1274. Git evidence problems usually start in `services/git.rs`.
1275. Desktop smoke problems usually start in `apps/desktop/scripts/run-project-smoke.ts`.
1276. Runtime smoke problems usually start in `apps/agent-runtime/scripts`.
1277. Test failures should be mapped to the touched module.
1278. Documentation drift should be fixed near the changed contract.
1279. Operator workflow changes should be reflected in usage docs.
1280. Architecture changes should be reflected in architecture docs.

## 49. Closing Notes

1281. The project is large, but its key boundaries are clear.
1282. The frontend is the operator console.
1283. The TypeScript runtime is the reasoning and orchestration engine.
1284. The protocol package is the contract layer.
1285. The Rust backend is the local authority layer.
1286. `.agent_memory` is the durable repository memory layer.
1287. Patch proposals are not patch application.
1288. Command requests are not command execution.
1289. Approval is not verification.
1290. Blocked commands are not validation success.
1291. Stale memory is not reliable context.
1292. High agent count is not inherently better.
1293. Narrow evidence-backed workers are the intended pattern.
1294. Durable artifacts make the system inspectable.
1295. Review gates make the system safer.
1296. Validation gates make the system more honest.
1297. Rust authority makes file and command changes auditable.
1298. Shared protocol types make the layers coherent.
1299. The fastest debugging path is to identify the failing boundary.
1300. The long-term goal is a trustworthy orchestration-first coding factory.

## 50. Current Idea Update - June 2026

1301. The current idea is no longer only "a multi-agent coding agent."
1302. The current idea is an orchestration-first, evidence-gated, recursive coding factory.
1303. The provider owns semantic understanding and final prose in the v2 lane.
1304. Local code owns repository facts, tools, access policy, evidence validation, and authority gates.
1305. `ReasoningKernel v2` is the preferred adaptive provider loop for conversation and project-question turns.
1306. The first v2 provider call returns `TurnUnderstanding` plus an initial `ReasoningStep`.
1307. Later v2 calls can return tool batches, final answers, ask-user actions, refusals, escalations, or repairs.
1308. The runtime rejects identical repeated tool batches instead of running them twice.
1309. Zero-gain tool rounds trigger independent repair.
1310. A third zero-gain failure ends the turn explicitly.
1311. Provider failures after the adaptive loop starts preserve partial traces.
1312. Failed adaptive turns keep `finalResponseSource: none`.
1313. Failed adaptive turns do not receive local fallback assistant prose.
1314. Final answers require accepted evidence.
1315. Final answers require citation verification.
1316. Final answers require an independent provider verifier.
1317. Workspace citations store path, line range, content hash, source type, and excerpt.
1318. Runtime re-reads cited files before accepting an answer.
1319. The old `ReasoningDirective` is now mostly a compatibility projection.
1320. `investigate_project` is the preferred deep cross-file read tool.
1321. `investigate_project` can combine ranked text, FTS, optional vector search, and relationship retrieval.
1322. `investigate_project` returns bounded source excerpts and hashes.
1323. `investigate_project` does not write final answers.
1324. `ProjectUnderstandingKernel` exists for deeper relationship and embedding-backed project questions.
1325. Deep project understanding can require an embedding model.
1326. Missing embeddings block the deep lane instead of allowing unsupported understanding claims.
1327. The durable semantic model lives in `.agent_memory/factory_metadata.sqlite`.
1328. The semantic model stores file, symbol, route, concept, and data-field nodes.
1329. The semantic model stores relationship edges.
1330. The semantic model stores content hashes and freshness.
1331. The semantic model can store provider embeddings.
1332. Repository memory is now SQLite-first.
1333. Root JSON and JSONL memory files are legacy migration inputs or backup exports.
1334. `SqliteMemoryStore` owns structured memory access in the runtime.
1335. SQLite FTS5 powers `npm run memory:search`.
1336. `npm run memory:db-status` inspects the SQLite memory store.
1337. `npm run memory:migrate-sqlite` migrates legacy memory into SQLite.
1338. `npm run memory:export-backup` creates checkpointed backup exports.
1339. Backup restoration verifies manifest hashes before replacing the database.
1340. `Project Knowledge Tree` is now a planning-only routing layer for existing-project edit requests.
1341. The tree uses fresh repository memory when available.
1342. The root node represents whole-project understanding.
1343. Area nodes represent architectural ownership areas.
1344. Leaf nodes represent specific file or module ownership.
1345. The Knowledge Query Router returns affected nodes, primary node, reviewer nodes, likely files, risks, confidence, and reasons.
1346. Knowledge-guided plans list files to touch.
1347. Knowledge-guided plans list files not to touch.
1348. Knowledge-guided plans describe local and cross-node risks.
1349. This layer does not propose patches.
1350. This layer does not run commands.
1351. This layer does not write files.
1352. The recursive factory lane handles large or explicitly multi-step work.
1353. Recursive factory first creates a durable Product Specification.
1354. Product Specification approval is required before technical planning.
1355. Recursive factory then creates a durable Technical Plan.
1356. Technical Plan approval is required before branch graph execution can be considered.
1357. Branch execution remains separately gated.
1358. Runtime branches still cannot write files directly.
1359. Branches can propose patches.
1360. Rust still applies approved patches.
1361. Validation truth still comes from Rust-authoritative validation commands.
1362. Recursive final reports include branch outcomes.
1363. Recursive final reports include conflict truth.
1364. Recursive final reports include apply truth.
1365. Recursive final reports include validation truth.
1366. A failed or blocked required branch prevents green final status.
1367. Unrun validation remains unverified.
1368. Approval-required validation remains unverified.
1369. Missing validation remains unverified.
1370. Validation failure can produce a durable failure diagnosis artifact.
1371. Repair loops are bounded.
1372. Repair loops still require patch approval and Rust apply.
1373. The action lane is gated by adaptive reasoning certification.
1374. Read reasoning certification uses sealed 240-case holdouts.
1375. Action reasoning certification uses sealed 120-case holdouts.
1376. Certification spans at least eight commit-pinned repositories.
1377. Certification uses independent semantic judging.
1378. Keyword overlap is not sufficient.
1379. Passing records are exact-profile records.
1380. The exact router, author, verifier, and embedding model profile matters.
1381. No model or gate is certified by default.
1382. `npm run test:reasoning-v2` covers adaptive kernel, certification, architecture, and decision-pipeline guards.
1383. `npm run eval:project-understanding` runs the deep project-understanding release gate.
1384. `npm run eval:adaptive-reasoning` runs adaptive reasoning certification.
1385. `npm run smoke:patch-truth` checks Rust patch truth behavior.
1386. `npm run smoke:real-workspace` checks a real-workspace desktop flow.
1387. The README now includes Mermaid diagrams for the current architecture and lifecycle.
1388. The deep-dive doc should be updated again when the v2 action lane fully replaces migration adapters.
