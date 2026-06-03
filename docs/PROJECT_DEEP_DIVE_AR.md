# Hivo Studio / OrchCode Studio - شرح معماري عميق للمشروع

> هذا الملف مكتوب كدليل عملي طويل لفهم المشروع من الداخل.
> الهدف أن تستطيع تتبع الرحلة من واجهة المستخدم، إلى Tauri/Rust، إلى Runtime TypeScript، إلى الذاكرة، إلى السرب الداخلي، إلى تطبيق الباتش.
> تاريخ المراجعة: 2026-06-03.
> حالة فهرس الذاكرة وقت الكتابة: `fresh`.
> عدد الملفات المفهرسة وقت الكتابة: 378 ملف.
> لغات المشروع الأساسية: TypeScript، Rust، React، CSS، Markdown، JSON، TOML.

## 1. الملخص التنفيذي

01. المشروع اسمه في `package.json` هو `hivo-studio`.
02. الريبو Monorepo مبني على npm workspaces.
03. المساحات الأساسية هي `apps/agent-runtime` و `apps/desktop` و `packages/protocol`.
04. `apps/agent-runtime` هو Runtime TypeScript المسؤول عن الجلسات، التخطيط، أدوات القراءة، orchestration، والـ swarm autopilot.
05. `apps/desktop` هو تطبيق سطح مكتب Tauri 2 بواجهة React + TypeScript وخلفية Rust.
06. `packages/protocol` هو الحزمة المشتركة التي تعرف أنواع البيانات والعقود بين الواجهة والـ runtime وRust.
07. المشروع يريد بناء نظام Coding Agent متعدد الوكلاء.
08. الفكرة ليست جعل نموذج صغير يتصرف كنموذج عملاق.
09. الفكرة هي إحاطة النماذج الصغيرة بذاكرة، تقسيم مهام، سياقات ضيقة، مراجعة، تحقق، وسلطة باتش محدودة.
10. النظام يفرق بوضوح بين من يقرأ، من يقترح، ومن يكتب على القرص.
11. Node runtime يقرأ المشروع ويقترح patches وcommands.
12. Rust backend يملك حدود workspace، terminal authority، patch authority، SQLite persistence.
13. الواجهة تعرض الحالة وتدير تجربة المشغل.
14. `.agent_memory/` هي الذاكرة المحلية الدائمة.
15. `npm run memory:index-status` يجب تشغيله قبل الاعتماد على الذاكرة في أعمال حساسة للسياق.
16. وقت كتابة هذا الملف، الفهرس كان `fresh`.
17. النظام يدعم simple mode و orchestrated mode و swarm autopilot CLI.
18. simple mode يدير جلسة وكيل واحد أو مسار RunEngine.
19. orchestrated mode يدير Product وBusiness وEngineering orchestrators ثم workers.
20. swarm autopilot يدير عدد logical agents داخليا بناء على التعقيد والمخاطر ونطاق الريبو.
21. الحد الأقصى النظري في swarm هو 300 logical agents.
22. 300 ليس default UX.
23. 300 يستخدم فقط في تجارب read-only واسعة أو audits كبيرة.
24. executors الكتابية لها cap منفصل وصغير.
25. approval gates لا تعتبر زينة.
26. approval gates جزء من مصدر الحقيقة في أي run.
27. validation لا تعتبر ناجحة لو كانت الأوامر blocked فقط.
28. كل artifact مهم يجب أن يبقى قابلا للتدقيق.
29. الوثائق الموجودة مثل `docs/architecture.md` و`docs/orchestration-flow.md` تؤكد نفس الاتجاه.
30. هذا الملف يوسع الشرح ويجمع الخريطة في وثيقة واحدة.

## 2. خريطة الملفات العليا

31. جذر المشروع يحتوي `package.json` الخاص بالـ workspace.
32. جذر المشروع يحتوي `AGENTS.md` لتعليمات العاملين على الكود.
33. جذر المشروع يحتوي `README.md` كمدخل تسويقي/تشغيلي عام.
34. جذر المشروع يحتوي `AUDIT_RECURSIVE_AGENTIC_FACTORY_ALIGNMENT.md` كتقرير audit كبير.
35. `docs/` يحتوي وثائق architecture وsecurity وusage وstatus.
36. `.agent_memory/` يحتوي ذاكرة مفهرسة ومخرجات runs وتجارب.
37. `apps/agent-runtime/` يحتوي خدمة TypeScript منفصلة.
38. `apps/desktop/` يحتوي الواجهة وتطبيق Tauri.
39. `packages/protocol/` يحتوي أنواع shared protocol.
40. `scripts/launch-desktop.mjs` هو launcher لتشغيل desktop.
41. `node_modules/` موجود لكنه ليس جزءا من الفهم المعماري.
42. `tmp/` يحتوي artifacts وتجارب audit ولا يجب الاعتماد عليه كمصدر production.
43. `test-results/` output لا يشرح architecture مباشرة.
44. `.orchcode-*.log` ملفات logs ضخمة ومولدات تشغيل.
45. ملفات الصور والأيقونات داخل desktop binary assets.
46. أهم entrypoints حسب الذاكرة تشمل `apps/agent-runtime/src/index.ts`.
47. entrypoint آخر هو `apps/agent-runtime/src/server.ts`.
48. entrypoint الواجهة هو `apps/desktop/src/main.tsx`.
49. entrypoint Rust هو `apps/desktop/src-tauri/src/lib.rs`.
50. entrypoint protocol هو `packages/protocol/src/index.ts`.

## 3. أوامر التشغيل والبناء

51. `npm run build` يبني protocol ثم agent-runtime ثم desktop.
52. `npm run typecheck` يبني ويفحص TypeScript عبر workspaces.
53. `npm run test` يشغل اختبارات agent-runtime.
54. `npm run memory:index` يعيد بناء فهرس الذاكرة.
55. `npm run memory:index-status` يفحص freshness.
56. `npm run memory:index-refresh` يحدث الذاكرة.
57. `npm run memory:inspect` يعرض محتوى الذاكرة.
58. `npm run memory:compact` يدمج الدروس والقرارات بعد runs مهمة.
59. `npm run agent:run` يشغل swarm autopilot من الجذر.
60. `npm run agent:plan` ينتج خطة swarm بدون التنفيذ الكامل.
61. `npm run agent:inspect-run` يفحص run محفوظ.
62. `npm run agent:report` يقرأ التقرير النهائي.
63. `npm run agent:resume` يستأنف run محفوظ.
64. `npm run agent:trial:staffing-eval` يختبر heuristics staffing.
65. `npm run agent:trial:scheduler-scale` يختبر scheduler scale حتى 300 mock read-only agents.
66. `npm run campaign:create` ينشئ campaign.
67. `npm run campaign:plan` يخطط campaign.
68. `npm run campaign:run-next` ينفذ الخطوة الآمنة التالية.
69. `npm run campaign:status` يعرض حالة campaign.
70. `npm run campaign:report` ينتج تقرير campaign.
71. `npm run agent:dev` يشغل runtime service في watch mode.
72. `npm run web:dev` يشغل Vite frontend.
73. `npm run desktop:dev` يشغل Tauri desktop.
74. `npm run dev` يستخدم launcher العام.
75. `apps/desktop` لديه `npm run dev` على `127.0.0.1:1420`.
76. `apps/desktop` لديه `npm run tauri:dev` لتشغيل app كامل.
77. `apps/agent-runtime` لديه `npm run dev` لتشغيل `src/index.ts`.
78. `packages/protocol` يبنى بـ `tsc -p tsconfig.json`.
79. Rust backend يمكن فحصه بـ `cargo check` داخل `apps/desktop/src-tauri`.
80. Rust backend يمكن اختباره بـ `cargo test` داخل `apps/desktop/src-tauri`.

## 4. فلسفة النظام

81. المشروع مصمم كمنصة orchestration-first.
82. أي ذكاء حقيقي يجب أن يظهر في المعمارية لا في prompt واحد ضخم.
83. الذاكرة repository memory تمنع إعادة اكتشاف نفس الحقائق كل مرة.
84. context packs تضيق السياق المعطى للعامل.
85. structured outputs تمنع prose عشوائي من قيادة التعديلات.
86. review gates تفصل الإنتاج عن الاعتماد.
87. validation gates تمنع "أنا أعتقد أنه يعمل" من أن تصبح حقيقة.
88. patch authority تمنع العمال من الكتابة المباشرة.
89. file locks تمنع تعارض كتابات في نفس الملفات.
90. durable events تسمح بإعادة بناء الحالة لاحقا.
91. campaign flow يسمح بتقسيم الأهداف الكبيرة إلى خطوات.
92. swarm autopilot يقرر عدد العاملين بدلا من سؤال المستخدم.
93. dynamic specialists تظهر من evidence لا من الخيال.
94. executor cap يحمي من مئات writers.
95. read-only fan-out آمن نسبيا مقارنة بالكتابة.
96. command policy يحمي من أوامر خطرة أو خارج workspace.
97. security boundaries موجودة في Rust وNode معا.
98. لكن Rust هو السلطة الأعلى لتطبيق patch وتشغيل terminal.
99. هذا الفصل متعمد لتسهيل audit.
100. عند debugging، اسأل دائما: هل المشكلة في UI، runtime، protocol، Rust، أو memory artifacts؟

## 5. تدفق عالي المستوى من المستخدم إلى القرص

101. المستخدم يفتح workspace من desktop UI.
102. React يستدعي `openWorkspace` من `apps/desktop/src/lib/tauri.ts`.
103. `openWorkspace` يستخدم Tauri `invoke("open_workspace")`.
104. Rust command `open_workspace` يمر عبر workspace service.
105. `WorkspaceService` يتحقق أن المسار directory ومتاح.
106. Rust يحفظ المشروع في SQLite عبر `DatabaseService`.
107. الواجهة تعرض file tree وgit state وpanels.
108. المستخدم يكتب prompt في الواجهة.
109. الواجهة تنشئ runtime run/session.
110. Rust قد ينشئ session token عبر `create_runtime_run`.
111. الواجهة تستدعي agent runtime HTTP endpoint `/sessions`.
112. `server.ts` ينشئ session داخل `AgentRuntime`.
113. `SessionManager` يحفظ snapshot في `sessions.json`.
114. `SessionManager` ينشر events عبر `EventBus`.
115. الواجهة تشترك في `/sessions/:id/events` SSE.
116. المستخدم يرسل turn عبر `/sessions/:id/turn`.
117. `AgentRuntime.runTurn` يحدد نمط التنفيذ.
118. إن كان Direct Conversation يرد مباشرة.
119. إن كان simple mode يستخدم `RunEngine`.
120. إن كان orchestrated mode يستخدم `OrchestratedRuntime`.
121. إن كان CLI swarm، يستخدم `SwarmAutopilotRuntime`.
122. runtime يقرأ ملفات workspace من `ToolRegistry`.
123. `WorkspaceTools` يمنع قراءة secrets.
124. runtime ينتج patch proposal لا يطبقه.
125. proposal ينتقل إلى الواجهة كـ event.
126. المستخدم يوافق أو يرفض.
127. الواجهة عند approve تستدعي Rust `apply_runtime_patch`.
128. Rust يقرأ proposal من SQLite `session_events`.
129. Rust يستخرج `unifiedDiff`.
130. Rust يراجع مسارات الباتش داخل workspace.
131. Rust يلتقط git snapshot قبل التطبيق.
132. Rust يطبق diff بواسطة `git apply`.
133. Rust يلتقط git snapshot بعد التطبيق.
134. Rust يسجل events authoritative في SQLite.
135. الواجهة تبلغ runtime بنتيجة التطبيق.
136. runtime ينتقل إلى post-verify أو failed.
137. debugging الناجح يتتبع هذا المسار بالترتيب.
138. لو لم يظهر patch في Rust، افحص `session_events`.
139. لو ظهر patch ولم يتطبق، افحص `PatchService.apply_patch`.
140. لو اتطبق ولم يظهر في UI، افحص SSE/session update path.

## 6. Root package.json

141. root package يعلن workspaces.
142. workspaces الثلاثة هي agent runtime، desktop، protocol.
143. root scripts تجمع أوامر subpackages.
144. root `build` يفرض بناء protocol قبل runtime والdesktop.
145. هذا صحيح لأن runtime وdesktop يستوردان `@hivo/protocol`.
146. root `typecheck` يبني protocol ثم يفحص protocol/runtime/desktop.
147. root `test` يمرر الاختبارات إلى `@hivo/agent-runtime`.
148. root memory scripts تمرر `--workspace .`.
149. root agent scripts تمرر إلى `apps/agent-runtime/src/orchestration/cli.ts`.
150. root campaign scripts تمرر إلى `campaign-cli.ts`.
151. root smoke scripts تغطي run-to-green وprovider truth وdesktop run project.
152. `dev` يستخدم `scripts/launch-desktop.mjs`.
153. npm هو package manager الرئيسي.
154. Cargo مستخدم داخل Tauri backend.
155. package-lock موجود في الجذر.
156. أي تعديل في protocol غالبا يحتاج build قبل runtime.
157. أي تعديل في desktop frontend يحتاج typecheck workspace `apps/desktop`.
158. أي تعديل في Rust يحتاج `cargo check` أو `cargo test`.
159. أي تعديل في memory/indexing يحتاج tests الخاصة بالذاكرة.
160. أي تعديل في orchestration يحتاج tests orchestration والvalidation المناسبة.

## 7. `packages/protocol` كعقد مشترك

161. protocol هو القلب النوعي للنظام.
162. كل طبقة تتفق من خلال types.
163. `packages/protocol/src/events.ts` يعرف `AppEvent`.
164. `packages/protocol/src/agent-runtime.ts` يعرف `AgentRuntimeSession`.
165. `packages/protocol/src/approvals.ts` يعرف access profiles وsafety settings.
166. `packages/protocol/src/models.ts` يعرف models عامة مثل commands وpatches وtasks.
167. `packages/protocol/src/orchestration.ts` يعرف حالة orchestration.
168. `packages/protocol/src/patch.ts` يعرف patch contracts.
169. `packages/protocol/src/task-graph.ts` يعرف task graph contracts.
170. `packages/protocol/src/tools.ts` يعرف tool grants.
171. `packages/protocol/src/index.ts` يعيد تصدير كل ذلك.
172. أي mismatch بين الواجهة والruntime يظهر غالبا كخطأ TypeScript هنا.
173. `DURABLE_RUNTIME_EVENT_TYPES` يحدد الأحداث القانونية للتاريخ الدائم.
174. `DurableRuntimeEventActor` يفرق بين runtime وuser وrust وsystem وdesktop_bridge.
175. `DurableRuntimeEventAuthority` يفرق بين runtime وrust وruntime_bridge وsystem.
176. `AppEvent` هو stream حي للواجهة.
177. بعض `AppEvent` خاص بالworkspace/git/commands.
178. بعض `AppEvent` خاص بالruntime session.
179. بعض `AppEvent` خاص بالpatch.
180. بعض `AppEvent` خاص بالverification.
181. بعض `AppEvent` خاص بالorchestration event.
182. `AgentLifecycleStage` يحدد مراحل session مثل INTAKE وPLAN وVALIDATION وAPPROVAL وDONE.
183. `RuntimeSessionStatus` يحدد created/running/completed/needs_approval/blocked/failed/expired.
184. `RuntimeTaskPhase` يحدد مراحل task الدقيقة.
185. restore source قد يكون fresh أو snapshot_restored أو event_replayed.
186. `EvidenceTruthReport` جزء من آليات الإجابة grounded على أسئلة المشروع.
187. `ProviderTruthTelemetry` يوضح إن كان real provider أو mock مستخدم.
188. هذا مهم جدا عند debugging "النموذج الحقيقي لم يشتغل".
189. لو الحقل `mockProviderUsed` true في real run، افحص provider config/fallback.
190. إذا أضفت حدثا جديدا، عدل protocol أولا ثم runtime ثم desktop.

## 8. snippet من protocol events

```ts
export const DURABLE_RUNTIME_EVENT_TYPES = [
  "session.created",
  "patch.proposed",
  "patch.apply_started",
  "patch.applied",
  "command.requested",
  "command.completed",
  "review_gate.updated"
] as const;
```

191. هذا snippet يوضح أن الأحداث الدائمة ليست strings حرة.
192. وجود قائمة ثابتة يحمي replay وrestore من drift.
193. runtime يجب أن يكتب events متوافقة.
194. Rust يكتب canonical runtime events عند patch apply.
195. desktop bridge يضيف session events مرتبطة بالواجهة.
196. عند إضافة lifecycle جديد، لا تكفي إضافة UI text.
197. يجب تحديث type contracts.
198. يجب تحديث persistence أو replay لو الحدث durable.
199. يجب تحديث tests التي تتحقق من semantics.
200. العقود المشتركة هي أقوى خط دفاع ضد تضارب الطبقات.

## 9. Agent Runtime entrypoint

201. entrypoint الرئيسي هو `apps/agent-runtime/src/index.ts`.
202. الملف صغير جدا ومقصود.
203. يحمل config.
204. يبني Fastify server.
205. يستمع على host/port من config.
206. يطبع رسالة تشغيل runtime.
207. صغر الملف يجعل debugging التشغيل سهل.
208. لو runtime لا يبدأ، افحص `config.ts` ثم `server.ts`.
209. لو server يبنى ولا يستمع، افحص port/host.
210. لو endpoint لا يرد، افحص Fastify routes في `server.ts`.

```ts
const config = loadConfig();
const { app } = await buildServer(config);
await app.listen({ host: config.host, port: config.port });
```

211. `loadConfig` يحدد defaults.
212. `buildServer` يعيد app/runtime/sessionManager.
213. top-level await مستخدم لأن package type module.
214. dependency `tsx` تستخدم للتشغيل أثناء dev.
215. build ينتج dist عبر TypeScript compiler.
216. server ليس Tauri sidecar مدمجا بالكامل بعد.
217. docs تصفه كخدمة TypeScript منفصلة يمكن أن تصبح sidecar لاحقا.
218. الواجهة تتصل به عبر `VITE_AGENT_RUNTIME_URL`.
219. default URL في frontend هو `http://127.0.0.1:4317`.
220. عدم تشغيل runtime يؤدي لفشل fetch في `agentRuntime.ts`.

## 10. `server.ts`

221. `server.ts` يبني Fastify app.
222. ينشئ `EventBus`.
223. ينشئ `SessionManager`.
224. يستدعي `sessionManager.load()`.
225. ينشئ `AgentRuntime`.
226. يضيف CORS headers.
227. يعرف `GET /health`.
228. يعرف `POST /sessions`.
229. يعرف `POST /sessions/:id/turn`.
230. يعرف `GET /sessions/:id`.
231. يعرف `GET /sessions/:id/events` كـ SSE.
232. يعرف approve/reject patch endpoints.
233. يعرف patch result endpoint.
234. يعرف command result endpoint.
235. كل routes الحساسة تتحقق من session token.
236. token يمكن أن يأتي من header `x-hivo-session-token`.
237. token يمكن أن يأتي أيضا من query `?token=`.
238. SSE يستخدم query token لأن EventSource لا يدعم headers بسهولة.
239. auth يسمح لو session ليس لها token record.
240. لو token موجود وانتهى، `SessionManager` يضع session expired.

```ts
app.get("/sessions/:id/events", async (request, reply) => {
  reply.raw.writeHead(200, { "content-type": "text/event-stream" });
  const unsubscribe = eventBus.subscribe((event) => {
    reply.raw.write(`event: ${event.type}\n`);
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", unsubscribe);
});
```

241. SSE stream يفلتر events حسب session.
242. `runtime.session.updated` له شكل خاص ولذلك يتم فحص `event.session.id`.
243. بقية events تفحص `sessionId` إذا موجود.
244. لو UI لا يتحدث live، افحص هذا route.
245. لو route يعمل لكن UI لا يسمع، افحص `subscribeRuntimeEvents`.
246. لو unauthorized، افحص session token storage في UI.
247. endpoints ترجع 400 عند request body ناقص.
248. endpoints ترجع 404 عند session/patch/request غير موجود.
249. server لا يطبق patch.
250. server فقط يوافق أو يرفض runtime-level proposal وينتظر Rust apply result.

## 11. `SessionManager`

251. `SessionManager` يحفظ كل الجلسات في memory map.
252. يحفظ snapshot إلى `sessions.json`.
253. يمسك session tokens كـ hash وليس plaintext.
254. يستخدم `createHash`.
255. يستخدم `randomUUID` IDs.
256. عند load يحاول قراءة persisted state.
257. لكل session محفوظة يستدعي `restorePersistedSession`.
258. ينشر `runtime.session.restored`.
259. لو لا يوجد ملف state ينشئ directory ويpersist.
260. `createSession` يجهز status `created`.
261. `createSession` يجهز lifecycleStage `INTAKE`.
262. `createSession` يضيف أول user message.
263. `createSession` يبني `declaredAccess`.
264. `createSession` يبني `resolvedAccess`.
265. `accessProfileDefaults` تدمج safety settings.
266. لو execution mode orchestrated، ينشئ `orchestration` state فارغ.
267. mandatory gates تشمل Product وBusiness وEngineering وSecurity وReviewer.
268. `updateSession` يمرر draft ويحدث updatedAt.
269. كل update يعمل saveAndPublish.
270. saveAndPublish ينشر `runtime.session.updated`.
271. addMessage يضيف رسالة مع id وcreatedAt.
272. addToolCall ينشر `runtime.tool_call.updated`.
273. addToolIntent ينشر `runtime.tool_intent.updated`.
274. session restore يعتمد جزئيا على durable runtime events.
275. snapshot restore ما زال fallback عندما replay غير كاف.
276. هذا مذكور صراحة في docs architecture.
277. عند مشاكل resume، افحص `sessions.json` وSQLite `runtime_events`.
278. عند مشاكل expired، افحص token expiry.
279. عند مشاكل state مفقودة، افحص event replay coverage.
280. `SessionManager` هو الذاكرة الحية لجلسات runtime service.

```ts
const session: AgentRuntimeSession = {
  id: randomId("session"),
  workspacePath: input.workspacePath,
  status: "created",
  lifecycleStage: "INTAKE",
  messages: [{ role: "user", content: input.userPrompt, createdAt: now }],
  patchProposals: [],
  commandRequests: [],
  commandExecutions: []
};
```

281. snippet مختصر عن الشكل وليس نسخة كاملة.
282. session model الحقيقي أكبر بكثير.
283. وجود arrays للpatches والcommands يجعل UI يعرض history.
284. lifecycleStage يساعد operator يعرف أين توقف العمل.
285. taskState يعطي restore/reconciliation تفاصيل أعمق.
286. runPhases وdecisionLedger يضيفان trace للتفكير والتنفيذ.
287. providerConfig محفوظ في session.
288. activeProviderSource محفوظ أيضا.
289. safetySettings محفوظة داخل orchestration عند الحاجة.
290. session هي وحدة تشغيل user-facing.

## 12. `AgentRuntime`

291. `AgentRuntime` هو façade الخاص بالجلسات والturns والapproval.
292. `createSession` يفوض إلى `SessionManager`.
293. `runTurn` هو أهم method.
294. `runTurn` يبدأ بفحص pending action.
295. pending action قد يكون confirm plan أو clarify plan.
296. ثم يحول session إلى running.
297. lifecycleStage يبدأ بـ INTAKE.
298. لو السؤال عن explain evidence يستخدم answer سريع من session.
299. runtime يسجل user message عند الحاجة.
300. ثم ينشئ provider telemetry.
301. `createConversationUnderstanding` يحاول فهم intent.
302. direct conversation يتم الرد عليها بدون أدوات heavy.
303. `ToolRegistry` ينشأ على workspacePath.
304. `workspace.getProjectSummary()` يعطي stack/package managers/test commands.
305. `resolveExecutionMode` يحدد simple أو orchestrated.
306. لو real provider مع orchestrated mode، يوجد مسار deterministic stop.
307. هذا يمنع خلط غير آمن بين real provider وorchestration deterministic.
308. `thinkFirst` قد يطلب clarification قبل التنفيذ.
309. simple mode يستخدم `RunEngine`.
310. orchestrated mode يستخدم `runOrchestratedTurn`.
311. في الأخطاء، session تصبح failed.
312. runtime يضيف runSummary فاشل.
313. runtime يضيف assistant message يشرح الفشل.
314. runtime يفرق بين commands والpatch results.
315. runtime يعرف provider من Mock/Ollama/OpenAI-compatible.
316. telemetry يثبت إذا كان mock أو real provider.
317. `classifyCommandRisk` من tools يساهم في command requests.
318. `looksLikeBackgroundCommand` يحذر من dev servers.
319. `looksLikeNetworkCommand` يحذر من npm install/curl وما شابه.
320. `AgentRuntime` لا يملك Tauri internals مباشرة.

```ts
if (modeResolution.mode === "orchestrated_mode") {
  updated = await this.runOrchestratedTurn(sessionId, promptForExecution, projectMap, thinkFirst, conversationUnderstanding);
} else {
  updated = await new RunEngine(provider, this.sessionManager, { providerTelemetry }).runTurn(sessionId, promptForExecution, {
    resolvedMode: modeResolution.mode,
    projectMap,
    thinkFirst,
    conversationUnderstanding
  });
}
```

321. هذا snippet هو مفترق الطرق بين simple وorchestrated.
322. عند debugging سلوك "لماذا لم يستخدم multi-agent"، ابدأ من `resolveExecutionMode`.
323. لو user طلب agents صراحة، افحص prompt directive parsing.
324. لو mode auto، projectMap يؤثر على القرار.
325. لو direct conversation، لن يصل إلى RunEngine.
326. لو thinkFirst، قد يتوقف عند clarification.
327. لو real provider path، telemetry مهمة.
328. لو RunEngine فشل، error يذهب إلى runSummary.
329. لو orchestrated فشل، افحص orchestration state في session.
330. `AgentRuntime` هو مركز traffic لجلسات runtime.

## 13. `RunEngine` ومسارات الفهم

331. `RunEngine` ليس مفصلا بالكامل هنا لكنه مسؤول عن تنفيذ turn في simple mode.
332. يستخدم provider للحصول على structured output أو text.
333. يستخدم أدوات workspace/git/command/patch عبر ToolRegistry.
334. يبني summaries وartifacts.
335. يطلب command execution بدلا من تشغيلها مباشرة عندما يلزم.
336. يقترح patch بدلا من الكتابة.
337. يدعم run-to-green logic.
338. يدعم inspect-only/project question paths.
339. `UniversalProjectQuestionEngine` يجيب أسئلة المشروع.
340. `InspectExplainReadLanes` يقسم القراءة إلى lanes.
341. lanes تشمل frontend وAPI وservice وstorage وtests وconcept search.
342. كل lane يرجع findings structured.
343. `InspectExplainComposer` يجمع cross-lane chains.
344. `EvidenceHygiene` يرفض evidence الضعيفة.
345. CSS/title evidence لا يساوي proof على page structure.
346. tests expectation-only لا تساوي implementation proof.
347. generated artifacts تعامل بحذر.
348. هذا مهم لو سألت "أين توجد feature X؟".
349. الإجابة الجيدة يجب أن تشير للملفات الفعلية.
350. مسار inspect/explain لا يستخدم patch-oriented OrchestratedRuntime.

## 14. `ToolRegistry`

351. `ToolRegistry` يجمع الأدوات المتاحة للعامل.
352. يملك `workspace`.
353. يملك `git`.
354. يملك `command`.
355. يملك `patch`.
356. يأخذ workspacePath.
357. يأخذ optional `WorkerCapabilityGrant`.
358. grant يحدد ما يسمح به worker.
359. `createToolCall` يبني record للواجهة والsession.
360. tool call له id يبدأ بـ `tool_`.
361. tool call له status.
362. tool call له input/output summary.
363. الأدوات ليست حرة.
364. كل أداة قد تفحص grant.
365. هذا يدعم narrow workers.
366. worker قد يقرأ ملفات محددة فقط.
367. worker قد يقترح patches فقط إذا grant يسمح.
368. هذا جزء من الأمان الداخلي.
369. debugging tool access يبدأ من grant.
370. لو tool يقول capability grant لا يسمح، فالمشكلة ليست في fs.

```ts
export class ToolRegistry {
  readonly workspace: WorkspaceTools;
  readonly git: GitTools;
  readonly command: CommandTools;
  readonly patch: PatchTools;
}
```

371. `WorkspaceTools` تقرأ وتبحث.
372. `GitTools` تفحص status/diff.
373. `CommandTools` تنتج command requests.
374. `PatchTools` تنتج patch proposals.
375. separation يجعل كل مسؤولية واضحة.
376. لا توجد أداة runtime للكتابة المباشرة.
377. هذا intentional design.
378. لو احتجت write path، ابحث في Rust patch command.
379. لو احتجت read path، ابحث في WorkspaceTools.
380. لو احتجت command policy، ابحث في CommandTools وRust TerminalService.

## 15. `WorkspaceTools`

381. `WorkspaceTools` هي Node-side scanner.
382. `listFiles` يجمع ملفات workspace مع limit.
383. `readFile` يقرأ حتى 80,000 حرف.
384. `readWholeFile` يقرأ الملف كله.
385. `fileExists` يتحقق من الوجود بأمان.
386. `writeFile` معطل عمدا.
387. `deleteFile` معطل عمدا.
388. `searchCode` يبحث نصيا داخل الملفات.
389. `getProjectSummary` يستنتج languages وimportant files وpackage managers وtest commands.
390. `assertPathAllowed` يفحص allowed paths عند وجود grant.
391. `resolveInsideWorkspace` يمنع path traversal.
392. `isSecretCandidate` يمنع secrets.
393. `shouldIgnore` يتجاهل node_modules وdist وما شابه.
394. scanner مؤقت داخل Node لأنه لا يستطيع استدعاء Tauri internals مباشرة.
395. Rust يبقى authority الأقوى.
396. `isTextLike` يحدد امتدادات البحث.
397. `languageForPath` يستنتج لغة من extension.
398. important files تشمل package.json وCargo.toml وREADME وtsconfig.
399. test commands inferred تشمل npm test وcargo test وpytest.
400. لو search لا يجد ملفا، افحص limit وignored directories.

```ts
writeFile(relativePath: string, content: string) {
  void relativePath;
  void content;
  throw new Error("Runtime file writes are disabled; propose a patch intent for Rust authority.");
}
```

401. هذا السطر هو أحد أهم design decisions.
402. runtime لا يكتب الملف.
403. runtime يقترح intent/patch.
404. Rust يطبق.
405. ذلك يمنع LLM worker من bypass.
406. لو رأيت code يحاول fs.writeFile من runtime، غالبا يخالف الاتجاه.
407. الاستثناء هو كتابة artifacts داخل `.agent_memory`.
408. artifacts memory ليست patch على user code.
409. reading محدود لمنع secrets.
410. grant يسمح بتقسيم workers إلى سياقات ضيقة.

## 16. `PatchTools`

411. `PatchTools.propose` يبني `PatchProposal`.
412. proposal يحصل على id يبدأ بـ `patch_`.
413. proposal دائما `requiresApproval: true`.
414. proposal status يبدأ `proposed`.
415. `validate` يفحص paths والـ unified diff.
416. `.env` يعتبر secret-like.
417. warnings تظهر لو diff ليس `diff --git`.
418. `applyProposal` يرجع applied false دائما.
419. message يوضح أن Rust patch authority يجب أن تطبق.
420. يوجد helper قديم `extractContentFromDiff` غير مستخدم ظاهريا في snippet.
421. runtime patch apply disabled.
422. approval في runtime لا تعني file changed.
423. approval يعني proposal جاهز للواجهة/Rust.
424. التطبيق الحقيقي عبر `apply_runtime_patch`.
425. عند debugging patch لا يغير ملفات، افحص إن كانت الواجهة استدعت Rust.
426. لو runtime approved لكن Rust لم يسجل applied، ابحث في `session_events`.
427. لو diff malformed، Rust `git apply` سيرفض.
428. لو paths خارج workspace، Rust سيرفض قبل git apply.
429. كل proposal يجب أن يحمل unifiedDiff.
430. كل proposal يجب أن يذكر filesChanged.

## 17. Memory system

431. `.agent_memory/README.md` يشرح ملفات الذاكرة.
432. `repo_index.json` يحفظ layout وlanguages وentrypoints.
433. `file_manifest.json` يحفظ hashes/mtimes للملفات النصية.
434. `symbol_index.json` يحفظ symbols/imports/exports heuristics.
435. `file_summaries.jsonl` يحفظ summaries لكل ملف.
436. `command_inventory.json` يحفظ أوامر build/test/typecheck/smoke/run.
437. `decisions.jsonl` append-only decisions.
438. `task_history.jsonl` append-only task/run notes.
439. `lessons_learned.jsonl` durable lessons.
440. `failed_attempts.jsonl` failed strategies.
441. `successful_patterns.jsonl` patterns ناجحة.
442. `project_glossary.json` vocabulary.
443. `architecture_notes.jsonl` facts معماري.
444. `index_state.json` freshness metadata.
445. `project_intelligence.json` dependency/test/command/module/risk maps.
446. `runs/` volatile run artifacts.
447. `campaigns/` volatile campaign artifacts.
448. `evals/` eval summaries.
449. لا تخزن secrets هنا.
450. large artifacts لا يجب commit.
451. committed فقط README وschema_version حسب التعليمات.
452. memory index وقت الكتابة fresh.
453. indexedFiles = 378.
454. sourceFiles = 329.
455. testFiles = 63.
456. docFiles = 31.
457. ignoredDirectories تشمل `.agent_memory`, `.git`, `dist`, `node_modules`, `target`, `tmp`.
458. language distribution يظهر TypeScript كالأكبر.
459. Rust files حوالي 24.
460. docs حوالي 31 markdown.

## 18. `RepoIndexer`

461. `RepoIndexer.ts` يبني snapshot الذاكرة.
462. يستخدم `ensureMemoryLayout`.
463. يجمع الملفات عبر `collectFiles`.
464. يحسب manifest.
465. يبني symbol index.
466. يبني command inventory.
467. يبني file summaries.
468. يبني repo index document.
469. يبني project intelligence.
470. يكتب JSON/JSONL في `.agent_memory`.
471. `DEFAULT_MAX_FILE_BYTES` يساوي 1,000,000.
472. ignored directories كثيرة لتجنب vendor/build output.
473. text extensions تحدد ما يقرأ.
474. binary extensions تحدد ما يتخطى.
475. source extensions تستخدم لحساب source files.
476. config basenames تحدد config files.
477. dependency basenames تحدد lockfiles.
478. build basenames تحدد build files.
479. indexer لا يقرأ binary icons.
480. indexer لا يقرأ logs unreadable أو huge حسب السياسة.

```ts
const symbolIndex = buildSymbolIndex(fileManifest, fileText, generatedAt);
const commandInventory = buildCommandInventory({ generatedAt, files: fileManifest, fileText });
const fileSummaries = buildFileSummaries(fileManifest, symbolIndex.files);
const repoIndex = buildRepoIndexDocument({ generatedAt, workspaceRoot, files: fileManifest, fileText, skippedFiles, ignoredDirectories });
```

481. هذا snippet يوضح pipeline داخل الفهرسة.
482. symbol index يأتي قبل summaries.
483. command inventory يقرأ package scripts وCargo.
484. project intelligence يربط tests بالمصادر قدر الإمكان.
485. stale index يجب أن يوقف context-sensitive work.
486. `memory:index-status` هو gate تشغيلي.
487. `memory:index-refresh -- --changed-only` يعرض changed files قبل refresh safe.
488. `memory:compact` مفيد بعد runs مهمة.
489. أي schema change يجب أن يحدث schema_version.
490. memory artifacts جزء من قابلية audit.

## 19. Orchestration core

491. `CoreOrchestrator` في `apps/agent-runtime/src/orchestration/Orchestrator.ts`.
492. هذا هو orchestration engine التقليدي قبل swarm CLI الحديث.
493. يملك workspacePath.
494. يملك memoryDir.
495. يملك context limits.
496. يملك safety config.
497. يستخدم `OrchestrationArtifactStore`.
498. يستخدم `FactoryTraceWriter`.
499. يستخدم optional providerFactory.
500. `planOnly` ينشئ run دون agent invocation.
501. `runAgenticTask` ينفذ run كامل.
502. lifecycle يبدأ بـ intake.
503. ثم prompt_rewrite placeholder.
504. ثم clarification_check.
505. ثم repo_mapping.
506. ثم complexity_estimation.
507. ثم planning.
508. ثم task_graph_ready.
509. ثم executing.
510. ثم reviewing/validating/integrating/reporting حسب المسار.
511. يستخدم `loadOrRebuildIndex`.
512. يستخدم `createMultiPlanIfNeeded`.
513. يستخدم `createTaskGraph`.
514. يستخدم `createAgentTeamsIfNeeded`.
515. يستخدم `DurableLockManager` عند التنفيذ.
516. يستخدم `TaskGraphManager` لتحديد ready tasks.
517. يشتق lock scopes من tasks.
518. يكتسب locks قبل تنفيذ task قد يكتب.
519. ينتج parsed outputs.
520. يدير fingerprint tracker لتجنب patch loops.

```ts
const lockResult = lockScopes.length ? await lockManager.acquireLocks({
  request_id: `lock_request_${randomUUID()}`,
  run_id: run.id,
  task_id: task.id,
  owner_component: "CoreOrchestrator",
  scopes: [...]
}) : undefined;
```

521. lock acquisition يحمي الملفات والموديولات.
522. task بدون write scopes قد لا يحتاج locks.
523. semantic locks تضيف حماية أعلى من file path.
524. lock ttl يأتي من config.
525. لو run blocked بسبب locks، افحص durable lock artifacts.
526. orchestrator يكتب checkpoints.
527. checkpoints تجعل resume ممكنا.
528. final report يجمع limitations.
529. validation logs تحفظ في artifacts.
530. patch history تحفظ في artifacts.

## 20. CLI orchestration

531. `apps/agent-runtime/src/orchestration/cli.ts` هو CLI موحد.
532. parseArgs يدعم `--workspace`.
533. parseArgs يدعم `--memory-dir`.
534. parseArgs يدعم `--run`.
535. parseArgs يدعم `--json`.
536. parseArgs يدعم `--mode`.
537. parseArgs يدعم `--agent-limit`.
538. commands القديمة تشمل `run-agentic-task`.
539. commands القديمة تشمل `plan-task`.
540. commands inspection تشمل show-run/show-context-pack/show-validation-logs.
541. `agent run` يستخدم `SwarmAutopilotRuntime`.
542. `agent plan` يستخدم plan فقط في swarm.
543. `agent inspect-run` يفحص run swarm.
544. `agent report` يقرأ report swarm.
545. `agent resume` يستأنف swarm run.
546. `agent trial` يدخل SwarmTrialLab.
547. `agent trial staffing-eval` يقيس staffing.
548. `agent trial scheduler-scale` يقيس scheduler scale.
549. `agent trial compare` يقارن modes.
550. CLI هو interface مهم للعمليات.
551. root npm scripts تلف حول هذا الملف.
552. لو أمر npm agent فشل، شغل command underlying مباشرة للمزيد من الوضوح.
553. `--json` مفيد للautomation.
554. `--workspace` يجب أن يشير لجذر الريبو الهدف.
555. memoryDir يسمح بتجارب isolated.
556. `agentLimit` override محدود ولا يتجاوز max supported.
557. errors تطبع إلى stderr وتضبط process.exitCode = 1.
558. help يظهر عند unknown command.
559. CLI لا يعتمد على desktop UI.
560. هذا يسهل تشغيل trials في CI أو terminal.

## 21. Swarm Autopilot

561. `SwarmAutopilotRuntime` هو Phase 5/6 internal swarm.
562. المستخدم يرى أمر واحد مثل `agent run "<goal>"`.
563. runtime داخليا ينشئ run.
564. ينشئ staffing plan.
565. ينشئ agent templates.
566. ينشئ agent instances.
567. ينشئ work items.
568. يشغل dependency-aware scheduler.
569. ينشئ consensus group.
570. يحفظ metrics.
571. يحفظ final report.
572. يضيف decisions/successful patterns إلى memory.
573. artifacts تحفظ تحت `.agent_memory/swarm_runs/<run_id>/`.
574. run يبدأ بـ `createRun`.
575. `plan` ينتقل خلال مراحل intake وrepo_mapping وplanning.
576. `run` يستدعي `plan` أولا ثم scheduler.
577. `loadOrRebuildIndex` يستخدم freshness assessment.
578. previous failures تؤثر على staffing.
579. worker mode قد يكون mock أو provider_read_only.
580. providerFactory يسمح بعمال provider-backed read-only.

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

581. staffing plan هو قرار central.
582. يعتمد على userGoal.
583. يعتمد على repoIndex.
584. يعتمد على commandInventory.
585. يعتمد على previousFailures.
586. explicitAgentLimit مجرد cap وليس UX أساسي.
587. run.effective_total_logical_agents يأخذ recommended total.
588. scheduler_config يشتق من staffing plan.
589. max_parallel_agents منفصل عن total.
590. executor_limit منفصل عن read-only agents.
591. risk level يؤثر على backpressure.
592. specialists تظهر إذا specialist_agents length > 0.
593. work_items تحفظ قبل execution.
594. leases تحفظ وتبدأ فارغة.
595. كل work item queued event.
596. scheduler يأخذ DurableLockManager.
597. scheduler ينتج metrics.
598. consensus يقرر integration readiness.
599. final status يكون succeeded أو blocked أو failed.
600. final report يعرض staffing والmetrics والrisks.

## 22. `SwarmStaffingPlanner`

601. `SwarmStaffingPlanner` يقرر حجم الفريق الداخلي.
602. يستخدم `SpecialistAgentFactory`.
603. يستنتج relevant files من goal والrepo index.
604. يستنتج task complexity.
605. يستنتج repo scope.
606. يستنتج risk level.
607. ينشئ specialists من evidence.
608. يحدد إذا goal read-only.
609. يحدد هل validation commands متاحة.
610. يبني base role counts.
611. يضيف specialists إلى role counts.
612. يحسب executor cap.
613. يقلل ExecutorAgent إلى cap.
614. يحسب recommended total.
615. explicitAgentLimit يمكن أن يقلل المجموع.
616. MAX_SUPPORTED_LOGICAL_AGENTS يحمي من أكثر من 300.
617. writeAgentLimit يجمع executor وintegrator ضمن حدود.
618. readOnlyRatio يحسب نسبة read-only.
619. validationLevel يعتمد على complexity/risk/read-only.
620. requiresHumanApproval true للمخاطر العالية أو files sensitive.
621. reasoning يحفظ لماذا اختار العدد.
622. downgrade_conditions تحفظ متى نقلل.
623. escalation_conditions تحفظ متى نزيد.
624. confidence يعطي ثقة planner.
625. `tiny` task يحصل غالبا على scout قليل وexecutor واحد.
626. `small` task يحصل على planner واحد ومراجعة.
627. `medium` يضيف context builder وarchitect وربما risk analyzer.
628. `large` يرفع scouts/reviewers/testers.
629. `huge` قد يقترب من 300 في read-only whole repo.
630. critical risk يقلل executors ويرفع reviewers.

```ts
if (taskComplexity === "tiny") {
  counts.ScoutAgent = 1;
  counts.ExecutorAgent = isReadOnly ? 0 : 1;
  counts.ReviewerAgent = 1;
  counts.ReporterAgent = 1;
}
```

631. هذا يوضح أن tiny task لا يحصل على مئات agents.
632. read-only يعني executor صفر.
633. reporter موجود حتى في tiny.
634. tester يظهر عند validation وwrite.
635. high risk يقلل الكتابة.
636. specialist agents لا يجب أن تكون write-capable افتراضيا.
637. risk inference ينظر إلى auth/security/payment/production.
638. package.json وCargo.lock وtsconfig تعتبر high risk.
639. orchestrator/runtime/scheduler refactor يعتبر medium risk.
640. staffing decision يجب أن يظهر في artifacts/reports.

## 23. Scheduler وwork items

641. `SwarmScheduler` ينفذ work items حسب dependencies.
642. `createInitialSwarmWorkItems` يعيش في `SwarmFanInOut.ts`.
643. work item types تشمل scout/planning/execution/review/validation/integration/report.
644. scout work يقرأ clusters من الملفات.
645. planner work يعتمد على scouts.
646. architect work يعتمد على planning.
647. executor work يعتمد على planning/architect.
648. review يعتمد على executor.
649. validation يعتمد على executor وربما review.
650. final integration يعتمد على review/validation.
651. `aggregateScoutResults` يدمج findings.
652. `createConsensusGroup` ينتج decision.
653. scheduler يستخدم leases.
654. scheduler يكتب trace entries.
655. scheduler يحترم max_parallel_agents.
656. scheduler يحترم executor_limit.
657. scheduler يستخدم DurableLockManager للwrite files.
658. worker قد يكون mock.
659. worker قد يكون provider-backed read-only.
660. artifacts تجعل run auditable.

## 24. Orchestrators التقليديون

661. `ProductOrchestrator` ينتج ProductBrief.
662. `BusinessOrchestrator` ينتج BusinessBrief.
663. `EngineeringOrchestrator` ينتج TechnicalPlan وTaskGraph.
664. هذه موجودة في `apps/agent-runtime/src/orchestrators`.
665. prompt files موجودة في `apps/agent-runtime/src/prompts`.
666. worker prompts موجودة تحت `prompts/workers`.
667. worker agents موجودة تحت `src/agents/workers`.
668. `CodebaseMapperAgent` يركز على خريطة الكود.
669. `ArchitectAgent` يركز على التصميم.
670. `RustBackendAgent` يركز على Rust/Tauri.
671. `FrontendAgent` يركز على React/UI.
672. `ToolingTerminalAgent` يركز على أوامر tooling.
673. `TestAgent` يركز على tests.
674. `SecurityAgent` يركز على المخاطر.
675. `ReviewerAgent` يراجع readiness.
676. `GenericWorkerAgent` يستخدم specs عامة.
677. `BaseWorker` يوفر execution skeleton.
678. outputs يجب أن تكون structured.
679. review agents يركزون على correctness/safety/scope/test gaps.
680. orchestrated mode في UI يعرض briefs وtask graph وworker outputs.

## 25. Desktop frontend

681. الواجهة في `apps/desktop/src`.
682. entrypoint هو `main.tsx`.
683. `main.tsx` يرندر `<App />` داخل React.StrictMode.
684. `App.tsx` هو الملف الأكبر والأكثر مركزية في الواجهة.
685. `App.tsx` يستورد أيقونات lucide-react.
686. `App.tsx` يستورد types من protocol.
687. `App.tsx` يستخدم hooks كثيرة من React.
688. `App.tsx` يستورد runtime HTTP helpers من `lib/agentRuntime`.
689. `App.tsx` يستورد Tauri invoke helpers من `lib/tauri`.
690. `App.tsx` يستورد terminal orchestrator.
691. الواجهة لديها recent workspaces.
692. الواجهة لديها recent sessions.
693. الواجهة لديها prompt history.
694. الواجهة لديها session tokens في local storage.
695. الواجهة لديها pinned/archived sessions.
696. الواجهة لديها RTL text mode.
697. الواجهة لديها sidebar width persistence.
698. الواجهة لديها settings modal للprovider.
699. الواجهة تعرض terminal/diff bottom panel.
700. الواجهة تعرض agent statuses/tasks/session metadata/git status.

```tsx
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

701. `agentRuntime.ts` يتصل بـ runtime server عبر fetch.
702. default runtime base URL هو `http://127.0.0.1:4317`.
703. `createRuntimeSession` يستدعي `/sessions`.
704. `runRuntimeTurn` يستدعي `/sessions/:id/turn`.
705. `getRuntimeSession` يستدعي `/sessions/:id`.
706. `approveRuntimePatch` يستدعي approve endpoint.
707. `rejectRuntimePatch` يستدعي reject endpoint.
708. `reportRuntimePatchApplyResult` يبلغ runtime بنتيجة Rust.
709. `reportRuntimeCommandResult` يبلغ runtime بنتيجة terminal.
710. `subscribeRuntimeEvents` يستخدم EventSource.
711. EventSource يسجل listeners لأنواع AppEvent runtime.
712. onSession يحدث state عند `runtime.session.updated`.
713. errors تذهب إلى onError.
714. `tauri.ts` يغلف كل Tauri invokes.
715. `openWorkspace` يستدعي `open_workspace`.
716. `listWorkspaceFiles` يستدعي `list_workspace_files`.
717. `runWorkspaceCommand` يستدعي `run_workspace_command`.
718. `applyRuntimePatch` يستدعي `apply_runtime_patch`.
719. `validateModelProvider` يستدعي `validate_model_provider`.
720. frontend لا يلمس filesystem مباشرة.

## 26. Rust/Tauri core

721. Rust backend في `apps/desktop/src-tauri/src`.
722. `lib.rs` يبني `AppState`.
723. `AppState` يحتوي workspace service.
724. `AppState` يحتوي database service.
725. `AppState` يحتوي git service.
726. `AppState` يحتوي terminal service.
727. `AppState` يحتوي patch service.
728. `AppState` يحتوي project index service.
729. `AppState` يحتوي model provider service.
730. `tauri::Builder` يضيف dialog plugin.
731. `manage(state)` يجعل state متاحا للcommands.
732. `invoke_handler` يسجل كل commands.
733. commands مقسمة إلى workspace/git/terminal/sessions/patch/system/model_provider.
734. Rust backend هو authority للworkspace boundaries.
735. Rust backend هو authority للterminal execution.
736. Rust backend هو authority للpatch apply.
737. Rust backend هو authority لSQLite.
738. `WorkspaceService` يحفظ workspace_path وproject_id.
739. `WorkspaceService.open_workspace` يعمل canonicalize ويتحقق من directory.
740. `ensure_inside_workspace` يمنع الخروج من workspace.
741. `ensure_command_cwd` يمنع command cwd خارج workspace.
742. `list_files` يستخدم ignore WalkBuilder.
743. `read_file` يمنع secret-like files.
744. `PatchService.apply_patch` يكتب diff مؤقت ثم يشغل `git apply`.
745. `validate_patch_paths_inside_workspace` يفحص `+++ b/` و`--- a/`.
746. يمنع parent dir وroot dir وprefix paths.
747. يفحص canonical parent داخل workspace.
748. `TerminalService.run_command` يفحص canonical workspace وcwd.
749. `CommandPolicyService` يصنف command risk.
750. dangerous commands blocked افتراضيا.

## 27. Rust patch apply flow

751. frontend يستدعي `applyRuntimePatch(sessionId, patchId)`.
752. Tauri invoke ينادي Rust command `apply_runtime_patch`.
753. Rust يأخذ workspace path من `WorkspaceService`.
754. Rust يأخذ patch payload من SQLite عبر `patch_payload_for_session`.
755. Rust يستخرج diff بـ `extract_patch_text`.
756. Rust يتحقق أن payload id يطابق patch_id.
757. Rust يتحقق أن unifiedDiff موجود.
758. Rust ينادي `validate_patch_paths_inside_workspace`.
759. Rust يلتقط before snapshot من GitService.
760. Rust يسجل event `patch.apply_started`.
761. Rust ينادي `PatchService.apply_patch`.
762. لو git apply فشل، يسجل `runtime.patch.apply_failed`.
763. لو نجح، يلتقط after snapshot.
764. Rust يسجل `runtime.patch.applied`.
765. Rust يضع provenance executionAuthority = rust_patch_service.
766. لو after snapshot غير متاح، يسجل reconciliation unavailable.
767. يرجع `PatchApplyResult`.
768. result يحتوي patch_id.
769. result يحتوي status.
770. result يحتوي authority.
771. result يحتوي reconciliation_source.
772. result يحتوي before/after snapshots.
773. result يحتوي durable_event_ids.
774. reject path يسجل `runtime.patch.rejected`.
775. reject path لا يغير ملفات.
776. patch apply authority لا تعتمد على frontend-collected git state.
777. هذا يقلل false evidence.
778. لو Git repo غير متاح، snapshot available يكون false.
779. التطبيق قد ينجح حتى لو snapshot unavailable حسب الحالة.
780. reconciliation report يوضح ذلك لاحقا.

```rust
state.patch.validate_patch_paths_inside_workspace(&patch_text, &workspace_path)?;
let before_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
state.patch.apply_patch(&patch_text, &workspace_path)?;
let after_snapshot = state.git.snapshot(&workspace_path, "rust_git_snapshot");
```

781. هذا snippet هو جوهر سلطة الباتش.
782. path validation يسبق git apply.
783. snapshot قبل وبعد يحفظ evidence.
784. git apply يحدث داخل canonical workspace.
785. temporary patch file يزال بعد التنفيذ.
786. لو patch references خارج workspace، يفشل قبل apply.
787. لو diff لا ينطبق، git apply يعيد stderr.
788. الواجهة يجب أن تعرض message للمستخدم.
789. runtime يجب أن يتلقى result endpoint.
790. post-verify يعتمد على نتيجة التطبيق والتحقق.

## 28. SQLite persistence

791. `DatabaseService` يفتح database في app data path.
792. `initialize` ينشئ الجداول إذا لم توجد.
793. جدول `projects` يحفظ projects.
794. جدول `sessions` يحفظ sessions قديمة/أساسية.
795. جدول `tasks` يحفظ tasks.
796. جدول `agent_runs` يحفظ agent runs.
797. جدول `tool_calls` يحفظ tool calls.
798. جدول `patches` يحفظ patches.
799. جدول `project_memory` يحفظ key/value memory.
800. جدول `model_provider_config` يحفظ provider config sanitized.
801. جدول `orchestration_runs` يحفظ briefs/plans/status/token hash.
802. جدول `session_events` يحفظ events bridge.
803. جدول `command_requests` يحفظ طلبات الأوامر.
804. جدول `command_results` يحفظ نتائج الأوامر.
805. جدول `background_jobs` يحفظ jobs محدودة التتبع.
806. جدول `artifacts` يحفظ artifacts runtime.
807. جدول `runtime_events` يحفظ الأحداث canonical ordered.
808. `runtime_events` له UNIQUE(session_id, sequence).
809. `add_column_if_missing` يدعم migrations بسيطة.
810. `backfill_event_metadata` يملأ metadata قديمة.
811. event authorities تشمل runtime_bridge وrust.
812. patch proposed/approved/applied/rejected events معروفة كثوابت.
813. command requested/started/completed/failed/blocked events معروفة.
814. artifacts created معروف أيضا.
815. عند debugging persistence، افصل بين `session_events` و`runtime_events`.
816. `session_events` bridge/compatibility.
817. `runtime_events` canonical event model.
818. replay يعتمد على runtime_events عندما يكفي.
819. patch payload for session يأتي من session_events.
820. هذا مهم: Rust apply يبحث proposal في SQLite وليس في memory map.

## 29. Terminal authority

821. `TerminalService` هو Rust authority للأوامر.
822. يأخذ command وcwd وworkspace وsafety settings.
823. يعمل canonicalize للworkspace.
824. يعمل canonicalize للcwd.
825. يرفض cwd خارج workspace.
826. يستخدم `CommandPolicyService::analyze`.
827. dangerous risk blocked إذا block_dangerous_commands true.
828. full access قد يسمح dangerous heuristic إذا block false.
829. network commands ترفض إذا allow_network_commands false.
830. medium commands قد تحتاج approval.
831. background commands قد تحتاج approval.
832. network commands قد تحتاج approval.
833. status `approval_required` ليس failure عادي.
834. approval_required يجب أن يرجع للruntime/واجهة كموقف آمن.
835. background command يبدأ بـ limited tracking.
836. foreground command ينفذ عبر `cmd /C` على Windows.
837. stdout/stderr قد يتم redaction حسب settings.
838. provenance يشرح source والpolicy والapproval.
839. command failure diagnosis يعطي next step.
840. لا تعتبر command verified إذا policy منع التنفيذ.
841. لو runtime يطلب command، Rust هو الذي ينفذه.
842. frontend `executeApprovedCommand` يربط approval بتنفيذ Rust.
843. terminal orchestrator في frontend يقرر auto-run commands safe.
844. لكن Rust يعيد فحص السياسة.
845. هذا defense in depth.
846. لو أمر npm install blocked، افحص allowNetworkCommands وautoRunNetworkCommands.
847. لو dev server approval_required، افحص autoRunBackgroundCommands.
848. لو cwd blocked، افحص active workspace.
849. لو dangerous blocked، راجع command policy.
850. لا توسع policy بدون سبب واضح واختبارات.

## 30. Model provider layer

851. frontend settings modal يدعم Ollama.
852. frontend settings modal يدعم OpenAI-compatible custom API.
853. frontend settings modal يدعم OpenRouter-compatible API.
854. frontend settings modal يدعم local/private OpenAI-compatible server.
855. provider config محفوظ sanitized في SQLite.
856. Rust `ModelProviderService` يتحقق من الإعدادات عبر HTTP backend-owned checks.
857. runtime `AgentRuntime` يختار Mock/Ollama/OpenAIProvider.
858. `ProviderTelemetry` يسجل الحقيقة.
859. `activeProviderSource` يوضح مصدر provider.
860. source قد يكون runtime_default.
861. source قد يكون desktop_saved_provider.
862. source قد يكون session_override.
863. source قد يكون explicit_cli.
864. source قد يكون unknown.
865. `TelemetryLlmProvider` يغلف provider.
866. telemetry يحسب request counts.
867. telemetry يحسب failures/timeouts.
868. telemetry يوضح fallbackUsed.
869. provider truth smoke test موجود.
870. عند مشاكل "لم يستخدم OpenAI"، افحص provider telemetry أولا.

## 31. Docs الموجودة

871. `docs/architecture.md` هو أفضل summary رسمي للبنية الحالية.
872. يصف Windows-first Tauri 2 app.
873. يصف React + TypeScript frontend.
874. يصف Rust backend/core.
875. يصف separate TypeScript agent runtime.
876. يصف patch proposal flow.
877. يصف inspect/explain read lanes.
878. يصف security boundaries.
879. `docs/orchestration-flow.md` يحتوي Mermaid flow.
880. flow يبدأ من User prompt.
881. ثم Product Orchestrator.
882. ثم Business Orchestrator.
883. ثم Engineering Orchestrator.
884. ثم Deterministic TaskGraph.
885. ثم FileLockManager.
886. ثم TaskScheduler.
887. ثم Specialized Workers.
888. ثم MergeController.
889. ثم SecurityAgent.
890. ثم ReviewerAgent.
891. ثم Patch proposals.
892. ثم User approval.
893. ثم Rust apply command.
894. `docs/security-model.md` يجب مراجعته عند تغيير boundaries.
895. `docs/usage/quickstart.md` مفيد للتشغيل.
896. `docs/usage/campaigns.md` مفيد للحملات.
897. `docs/architecture/internal-swarm-autopilot.md` يشرح Phase 5.
898. `docs/architecture/phase-6-swarm-autopilot-trial-lab-plan.md` يشرح trials.
899. `docs/architecture/memory-and-indexing.md` يشرح memory.
900. `docs/extension/add-agent-role.md` يشرح إضافة role.

## 32. Tests

901. اختبارات runtime موجودة في `apps/agent-runtime/src/tests`.
902. هناك 63 test files حسب index.
903. `memory-indexing.test.ts` يغطي indexing.
904. `command-policy.test.ts` يغطي command policy.
905. `orchestration.test.ts` يغطي orchestration core.
906. `swarm-autopilot.test.ts` يغطي swarm.
907. `swarm-trial-lab.test.ts` يغطي trial lab.
908. `patch-validation.test.ts` يغطي patch validation.
909. `patch-apply-sandbox.test.ts` يغطي sandbox apply.
910. `durable-lock-manager.test.ts` يغطي durable locks.
911. `replay-restore.test.ts` يغطي restore/replay.
912. `runtime-event-semantics.test.ts` يغطي event semantics.
913. `provider-truth-evidence-hygiene.test.ts` يغطي provider/evidence truth.
914. `run-to-green.test.ts` يغطي run-to-green.
915. `inspect-explain.test.ts` يغطي project explain.
916. `inspect-explain-read-lanes.test.ts` يغطي lanes.
917. `validation-semantics.test.ts` يغطي validation status aggregation.
918. Rust tests موجودة داخل services مثل workspace/patch.
919. desktop smoke test موجود في `apps/desktop/scripts/run-project-smoke.ts`.
920. عند تعديل frontend فقط، استخدم `npm run typecheck -w @hivo/desktop` وربما smoke.
921. عند تعديل protocol، شغل root typecheck.
922. عند تعديل runtime orchestration، شغل agent-runtime tests.
923. عند تعديل Rust authority، شغل cargo test/check.
924. عند تعديل memory، شغل memory:index-status وربما memory tests.
925. عند تعديل staffing heuristics، شغل `npm run agent:trial:staffing-eval`.
926. عند تعديل scheduler scale، شغل `npm run agent:trial:scheduler-scale`.
927. لا تعتبر validation ناجحة إذا الأوامر لم تنفذ فعليا.
928. سجل unverified status بوضوح إذا تعذر تشغيل tests.
929. tests جزء من architecture لأن النظام safety-first.
930. إضافة feature بدون test في هذه المناطق risk واضح.

## 33. Debugging guide سريع

931. لو الواجهة لا تفتح workspace، افحص Rust `WorkspaceService.open_workspace`.
932. لو file tree ناقص، افحص `list_files` max_depth وskip paths.
933. لو secret file لا يقرأ، هذا غالبا intentional.
934. لو runtime لا يستجيب، افحص `apps/agent-runtime/src/index.ts` والport 4317.
935. لو CORS error، افحص `server.ts` onRequest hook.
936. لو session unauthorized، افحص token header/query.
937. لو SSE لا يعمل، افحص `/sessions/:id/events`.
938. لو UI لا يتحدث، افحص EventSource listeners في `agentRuntime.ts`.
939. لو prompt لا يستخدم multi-agent، افحص `resolveExecutionMode`.
940. لو prompt توقف عند approval، افحص `nextAction`.
941. لو command approval_required، افحص Rust TerminalService safety settings.
942. لو command blocked، افحص risk classification.
943. لو patch proposed ولا يظهر، افحص runtime events والfrontend state.
944. لو patch approved ولا يطبق، افحص Rust `apply_runtime_patch`.
945. لو Rust يقول proposal not found، افحص SQLite `session_events`.
946. لو Rust يقول unifiedDiff missing، افحص PatchProposal payload.
947. لو Rust يقول path outside workspace، افحص diff file headers.
948. لو git apply failed، افحص stderr وworking tree.
949. لو post-apply evidence unavailable، افحص GitService snapshot والrepo status.
950. لو resume غريب، افحص `sessions.json` و`runtime_events`.
951. لو swarm overstaffs، افحص `SwarmStaffingPlanner` reasoning.
952. لو swarm understaffs، افحص relevant files/task complexity inference.
953. لو specialist ظهر بلا سبب، افحص SpecialistAgentFactory triggers.
954. لو artifacts ناقصة، افحص SwarmArtifactStore أو OrchestrationArtifactStore.
955. لو memory stale، شغل `npm run memory:index-refresh`.
956. لو tests لا تعثر على source mapping، افحص project_intelligence.
957. لو provider fallback happened، افحص ProviderTruthTelemetry.
958. لو mock استخدم بدل real، افحص activeProviderSource.
959. لو model validation failed، افحص Rust ModelProviderService.
960. debugging الجيد يبدأ من boundary الصحيح.

## 34. قواعد تعديل المشروع بأمان

961. اقرأ surrounding code قبل التعديل.
962. لا تعمل big-bang rewrite.
963. غير أصغر slice منطقي.
964. حافظ على behavior إلا إذا المهمة تغيره.
965. استخدم existing patterns.
966. لا تضف abstraction إلا إذا قللت تعقيدا فعليا.
967. لا تتجاوز Rust-owned patch authority.
968. لا تتجاوز command policy.
969. لا تستخدم malformed JSON من agents كمصدر تغييرات.
970. أصلح أو ارفض output يخالف schema.
971. حافظ على TypeScript strict.
972. حافظ على deterministic JSON قدر الإمكان.
973. حدث docs عند تغيير architecture أو memory format أو orchestration contract.
974. أضف tests لمناطق memory/indexing/commands/context/orchestration/verification.
975. file locks وpatch fingerprints validation logs مصادر حقيقة.
976. approval-required status توقف أمان حقيقي.
977. لا توسع edit scope لتجاوز approval.
978. dynamic specialists يجب أن تأتي من evidence.
979. لا تجعل مئات agents write-capable.
980. سجّل staffing decisions في artifacts/reports.

## 35. خريطة ownership عملية

981. مشاكل types المشتركة غالبا في `packages/protocol`.
982. مشاكل session lifecycle غالبا في `apps/agent-runtime/src/runtime`.
983. مشاكل HTTP/SSE غالبا في `apps/agent-runtime/src/server.ts`.
984. مشاكل planning التقليدي غالبا في `apps/agent-runtime/src/orchestration/Orchestrator.ts`.
985. مشاكل swarm staffing غالبا في `SwarmStaffingPlanner.ts`.
986. مشاكل swarm execution غالبا في `SwarmScheduler.ts`.
987. مشاكل artifacts غالبا في `ArtifactStore.ts` أو `SwarmArtifactStore.ts`.
988. مشاكل memory index غالبا في `RepoIndexer.ts`.
989. مشاكل command discovery غالبا في `CommandInventory.ts`.
990. مشاكل project intelligence غالبا في `ProjectIntelligence.ts`.
991. مشاكل workspace reads في Node غالبا في `WorkspaceTools.ts`.
992. مشاكل patch proposal في `PatchTools.ts`.
993. مشاكل Rust workspace في `services/workspace.rs`.
994. مشاكل Rust patch apply في `commands/patch.rs` و`services/patch.rs`.
995. مشاكل terminal في `services/terminal.rs`.
996. مشاكل database في `db/mod.rs`.
997. مشاكل frontend runtime calls في `src/lib/agentRuntime.ts`.
998. مشاكل Tauri invoke في `src/lib/tauri.ts`.
999. مشاكل UI state في `src/app/App.tsx`.
1000. مشاكل styles في `src/app/styles.css`.

## 36. خاتمة

1001. المشروع كبير، لكنه منظم حول boundaries واضحة.
1002. أهم boundary هو read/propose في Node مقابل apply/execute في Rust.
1003. أهم artifact directory هو `.agent_memory`.
1004. أهم shared contract هو `packages/protocol`.
1005. أهم runtime user-facing object هو `AgentRuntimeSession`.
1006. أهم CLI حديث هو `agent run` عبر `SwarmAutopilotRuntime`.
1007. أهم safety idea هي أن approval والتحقق والlocks ليست اختيارية.
1008. إذا فهمت flow المستخدم إلى patch apply، ستفهم معظم bugs العملية.
1009. إذا فهمت memory freshness، ستفهم لماذا بعض الإجابات قد تكون stale.
1010. إذا فهمت staffing planner، ستفهم لماذا السرب يكبر أو يصغر.
1011. إذا فهمت protocol events، ستفهم لماذا UI لا يعرض حالة معينة.
1012. إذا فهمت SQLite events، ستفهم restore والتطبيق authoritative.
1013. إذا فهمت command policy، ستفهم لماذا أوامر معينة تتوقف.
1014. إذا فهمت ToolRegistry grants، ستفهم narrow worker behavior.
1015. هذا الملف يتعمد أن يكون طويلا ومباشرا.
1016. استخدم عناوين الأقسام للبحث السريع.
1017. استخدم أرقام السطور كمرجع أثناء debugging.
1018. عند أي تعديل معماري جديد، حدّث هذا الملف أو أضف doc أدق بجانبه.
1019. الهدف النهائي هو نظام coding factory يمكن الوثوق به.
1020. الثقة هنا تأتي من architecture قابلة للتدقيق، لا من ثقة عمياء في نموذج واحد.
