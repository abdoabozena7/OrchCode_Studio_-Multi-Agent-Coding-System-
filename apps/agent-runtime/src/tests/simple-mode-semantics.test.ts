import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SanitizedProviderConfig } from "@hivo/protocol";
import { loadConfig } from "../config.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ScriptedProvider } from "./fixtures/ScriptedProvider.js";

const validProviderConfig: SanitizedProviderConfig = {
  providerType: "ollama",
  providerName: "Ollama",
  baseUrl: "http://127.0.0.1:11434",
  selectedModel: "test-model",
  isValid: true
};

async function createScriptedRuntime(storageDir: string): Promise<AgentRuntime> {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  return new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, {
    providerFactory: () => new ScriptedProvider()
  });
}

test("run this project completes with a preview-ready result for static module workspaces without scripts", async () => {
  process.env.HIVO_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `hivo-run-static-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run-static-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "index.html"),
    '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n',
    "utf8"
  );
  await writeFile(path.join(workspace, "styles.css"), "body { margin: 0; }\n", "utf8");
  await writeFile(path.join(workspace, "main.js"), 'import * as THREE from "https://unpkg.com/three/build/three.module.js";\n', "utf8");

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "run this project"
    });
    const turn = await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.lifecycleStage, "DONE");
    assert.equal(session?.runMode, "run_to_green");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.commandExecutions.length, 0);
    assert.equal(session?.previewRecommendation?.type, "url");
    assert.match(session?.runToGreen?.blockerReason ?? "", /No grounded run command/i);
    assert.equal(session?.verificationResult?.status, "unavailable");
    assert.equal(session?.verificationResult?.checks.find((check) => check.name === "Rust command execution")?.status, "not_run");
    assert.equal(session?.reviewGate?.recommendation, "caution");
    assert.equal(session?.runSummary?.status, "completed");
    assert.equal(session?.nextAction?.kind, "preview_ready");
    assert.equal(session?.orchestration?.agentRuns.find((agent) => agent.id === "agent_local_codex")?.status, "completed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.HIVO_DISABLE_BACKGROUND_COMMANDS;
  }
});

test("run this project prefers package manager dev scripts in package.json workspaces", async () => {
  process.env.HIVO_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `hivo-run-package-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-run-package-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { dev: "vite --port 4409" } }, null, 2),
    "utf8"
  );
  await writeFile(path.join(workspace, "README.md"), "vite test fixture\n", "utf8");

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      accessProfile: "full_access",
      userPrompt: "run this project"
    });
    await runtime.runTurn(created.sessionId, "run this project");
    const session = runtime.getSession(created.sessionId);

    assert.equal(session?.runMode, "run_to_green");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests[0]?.command, "npm run dev");
    assert.equal(session?.previewRecommendation?.target, "http://127.0.0.1:4409");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    delete process.env.HIVO_DISABLE_BACKGROUND_COMMANDS;
  }
});

test("simple greeting short-circuits before workspace inspection or file search", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-greeting-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-greeting-storage-${Date.now()}`);
  const greeting = "\u0647\u0627\u064a";
  await mkdir(workspace, { recursive: true });
  for (let index = 0; index < 9; index += 1) {
    await writeFile(path.join(workspace, `file-${index}.md`), `${greeting} should not be searched here\n`, "utf8");
  }

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: greeting
    });
    const turn = await runtime.runTurn(created.sessionId, greeting);
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.lifecycleStage, "DONE");
    assert.equal(session?.projectIntake, undefined);
    assert.equal(session?.contextPack, undefined);
    assert.equal(session?.explainReport, undefined);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.equal(session?.artifacts.some((artifact) => artifact.type === "project_intake" || artifact.type === "project_explain_answer"), false);
    assert.equal(session?.progressEvents.every((event) => (event.targetFiles?.length ?? 0) === 0), true);
    assert.doesNotMatch(session?.progressEvents.map((event) => `${event.taskTitle}\n${event.summary}`).join("\n") ?? "", /Workspace snapshot|9 file/i);
    assert.match(assistantMessage, /[\u0600-\u06ff]/u);
    assert.doesNotMatch(assistantMessage, /Workspace used for this answer|Answer source|Mock analysis complete/i);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.patchProposals.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("direct conversation does not require an existing workspace", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-missing-greeting-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-missing-greeting-storage-${Date.now()}`);

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "hi"
    });
    const turn = await runtime.runTurn(created.sessionId, "hi");
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.projectIntake, undefined);
    assert.equal(session?.explainReport, undefined);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.equal(session?.progressEvents.every((event) => (event.targetFiles?.length ?? 0) === 0), true);
    assert.doesNotMatch(assistantMessage, /Workspace used for this answer|Answer source/i);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.patchProposals.length, 0);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("arabic run request keeps no-command response in arabic", async () => {
  process.env.HIVO_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `hivo-arabic-run-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-arabic-run-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "static fixture without runnable scripts\n", "utf8");

  const runtime = await createScriptedRuntime(storageDir);
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    userPrompt: "شغل المشروع"
  });
  await runtime.runTurn(created.sessionId, "شغل المشروع");
  const session = runtime.getSession(created.sessionId);
  const assistantMessage = session?.messages.at(-1)?.content ?? "";

  assert.equal(session?.runMode, "run_to_green");
  assert.match(assistantMessage, /راجعت المشروع|أمر تشغيل/);
  assert.doesNotMatch(assistantMessage, /I inspected the workspace/i);
  assert.doesNotMatch(assistantMessage, /No safe run|grounded command|detected scripts/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.HIVO_DISABLE_BACKGROUND_COMMANDS;
});

test("explain this project stays in simple mode and emits ordered progress without patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-explain-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");

  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: "explain this project"
    });
    const turn = await runtime.runTurn(created.sessionId, "explain this project");
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.lifecycleStage, "DONE");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.explainReport, undefined);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.equal(session?.artifacts.some((artifact) => artifact.type === "project_explain_answer"), false);
    assertOrderedTitles(session?.progressEvents.map((event) => event.taskTitle ?? event.stage) ?? [], [
      "Understanding request with provider",
      "Routing complete",
      "Reading evidence and composing answer",
      "Provider response"
    ]);
    assert.match(assistantMessage, /hivo-file:README\.md/);
    assert.doesNotMatch(assistantMessage, /Workspace used for this answer|I proposed a patch/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("arabic inspect-only progress uses actual Arabic step labels without mojibake", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-arabic-progress-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-arabic-progress-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");

  const prompt = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0628\u0628\u0633\u0627\u0637\u0629";
  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
    const progressText = session?.progressEvents.map((event) => `${event.taskTitle ?? ""} ${event.summary}`).join("\n") ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assertOrderedTitles(session?.progressEvents.map((event) => event.taskTitle ?? event.stage) ?? [], [
      "فهم الطلب عند المزوّد",
      "تحديد المسار",
      "قراءة الأدلة وتأليف الرد",
      "رد المزوّد"
    ]);
    assert.match(assistantMessage, /[\u0600-\u06ff]/u);
    assert.match(assistantMessage, /hivo-file:README\.md/);
    assert.doesNotMatch(progressText, /\uFFFD|ط§|ظ„|ظ…|أ¯|أ™|ï؟½/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

function assertOrderedTitles(actual: string[], expected: string[]) {
  let cursor = 0;
  for (const title of actual) {
    if (title === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return;
  }
  assert.fail(`Expected ordered progress titles ${expected.join(" -> ")} inside ${actual.join(" -> ")}`);
}

test("arabic explain requests stay inspect-only and answer in chat", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-arabic-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-arabic-explain-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");

  const prompt = "\u0627\u0634\u0631\u062d \u0627\u0644\u0645\u0634\u0631\u0648\u0639";
  try {
    const runtime = await createScriptedRuntime(storageDir);
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt
    });
    const turn = await runtime.runTurn(created.sessionId, prompt);
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

    assert.equal(turn.status, "completed");
    assert.equal(session?.status, "completed");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.explainReport, undefined);
    assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
    assert.match(assistantMessage, /[\u0600-\u06ff]/u);
    assert.match(assistantMessage, /hivo-file:README\.md/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("mixed Arabic dataset realtime question is inspect-only and does not create a patch proposal", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-arabic-dataset-realtime-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-arabic-dataset-realtime-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "services"), { recursive: true });
  await mkdir(path.join(workspace, "dashboard_ui", "src"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Big data dashboard\n\nReads a CSV dataset and renders snapshots.\n", "utf8");
  await writeFile(path.join(workspace, "services", "cleaning.py"), "def normalize_dataset_row(row):\n    return row\n", "utf8");
  await writeFile(
    path.join(workspace, "dashboard_ui", "src", "App.jsx"),
    "useEffect(() => {\n  const load = () => fetch('/api/snapshot').then(r => r.json());\n  const timer = setInterval(load, 5000);\n  return () => clearInterval(timer);\n}, []);\n",
    "utf8"
  );
  const prompt = "اشرح المشروع دا ل طفل ازاي بيقدر يجيب الداتا من داتا سيت كانها realtime";

  const runtime = await createScriptedRuntime(storageDir);
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    userPrompt: prompt
  });
  await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

  assert.equal(session?.status, "completed");
  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.patchProposals.length, 0);
  assert.equal(session?.commandRequests.length, 0);
  assert.equal(session?.explainReport, undefined);
  assert.ok((session?.artifacts ?? []).some((artifact) => artifact.type === "decision_pipeline"));
  assert.match(assistantMessage, /dataset realtime behavior|dataset|داتا|realtime/i);
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("Arabic inspect regression prompts answer from evidence without patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-arabic-inspect-regression-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-arabic-inspect-regression-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "frontend", "src"), { recursive: true });
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "# Retention ML Dashboard\n\nFastAPI backend and React-style frontend for customer risk scoring.\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "retention-ml-dashboard", scripts: { test: "echo ok" } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "frontend", "index.html"), [
    "<!doctype html>",
    "<html><body>",
    "<nav>",
    "<a href=\"#overview\">Overview</a>",
    "<a href=\"#customers\">Customers</a>",
    "<a href=\"#models\">Models</a>",
    "</nav>",
    "<div id=\"root\"></div>",
    "<script type=\"module\" src=\"./src/App.jsx\"></script>",
    "</body></html>"
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "frontend", "src", "App.jsx"), [
    "const VIEWS = [",
    "  { id: 'overview', title: 'Overview', description: 'Shows KPI cards, forecast trend, and model health.' },",
    "  { id: 'customers', title: 'Customers', description: 'Lists customer risk, predicted SVM state, and confidence.' },",
    "  { id: 'models', title: 'Models', description: 'Explains clustering, SVM, SARIMA, and SHAP outputs.' }",
    "];",
    "export default function App() {",
    "  return <main className=\"app-shell\">{VIEWS.map((view) => <section key={view.id} data-view={view.id}>{view.description}</section>)}</main>;",
    "}"
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "backend", "services", "clustering.py"), "from sklearn.cluster import DBSCAN\nimport skfuzzy as fuzz\n\ndef build_customer_segments(features):\n    density_clusters = DBSCAN(eps=0.35, min_samples=5).fit_predict(features)\n    centers, memberships, *_ = fuzz.cluster.cmeans(features.T, c=4, m=2.0, error=0.005, maxiter=1000)\n    fcm_labels = memberships.argmax(axis=0)\n    return density_clusters, fcm_labels, memberships\n", "utf8");
  await writeFile(path.join(workspace, "backend", "services", "svm_model.py"), "from sklearn.svm import SVC\nimport joblib\n\ndef train_svm_state_detector(features, fcm_labels):\n    svm = SVC(probability=True, kernel='rbf')\n    svm.fit(features, fcm_labels)\n    joblib.dump(svm, 'artifacts/svm_state_detector.joblib')\n    return svm\n\ndef load_svm_state_detector():\n    return joblib.load('artifacts/svm_state_detector.joblib')\n\ndef predict_customer_state(features):\n    svm = load_svm_state_detector()\n    return svm.predict(features), svm.predict_proba(features).max(axis=1)\n", "utf8");
  await writeFile(path.join(workspace, "backend", "services", "arima_model.py"), "from statsmodels.tsa.statespace.sarimax import SARIMAX\n\ndef train_sarima_forecast(history):\n    model = SARIMAX(history, order=(1, 1, 1), seasonal_order=(1, 1, 1, 12))\n    return model.fit(disp=False)\n\ndef forecast_next_period(model_result, steps=6):\n    return model_result.forecast(steps=steps)\n", "utf8");
  await writeFile(path.join(workspace, "backend", "services", "shap_explainer.py"), "import shap\nfrom backend.services.svm_model import load_svm_state_detector\n\ndef explain_svm_prediction(background, customer_features):\n    svm = load_svm_state_detector()\n    explainer = shap.KernelExplainer(svm.predict_proba, background)\n    return explainer.shap_values(customer_features)\n", "utf8");
  await writeFile(path.join(workspace, "backend", "routes.py"), "from fastapi import FastAPI\nfrom backend.services.clustering import build_customer_segments\nfrom backend.services.svm_model import train_svm_state_detector, predict_customer_state\nfrom backend.services.arima_model import train_sarima_forecast, forecast_next_period\nfrom backend.services.shap_explainer import explain_svm_prediction\n\napp = FastAPI()\n\n@app.post('/train')\ndef train_pipeline(payload: dict):\n    _, fcm_labels, memberships = build_customer_segments(payload['features'])\n    svm = train_svm_state_detector(payload['features'], fcm_labels)\n    forecast_model = train_sarima_forecast(payload['history'])\n    return {'svm': str(svm), 'forecast': forecast_next_period(forecast_model).tolist()}\n\n@app.post('/predict')\ndef predict(payload: dict):\n    state, confidence = predict_customer_state(payload['features'])\n    shap_values = explain_svm_prediction(payload['background'], payload['features'])\n    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'shap': str(shap_values)}\n", "utf8");

  const prompts = [
    { text: "عندي هنا كام صفحه ف السيستم دا وكل واحده بتعمل ايه ؟", expected: /Overview|Customers|Models/ },
    { text: "عندنا كام algorithm هنا؟ واشرحهم واحده واحده.", expected: /SVM|DBSCAN|SHAP|SARIMA/ },
    { text: "ازاي الsvm بيتطبق هنا ؟ اشرح بالتفصيل", expected: /clustering|labels|training|prediction|SHAP|SVM/i },
    { text: "هل عندي training و inference منفصلين هنا؟ كل واحد فين وبيعمل إيه؟", expected: /train_svm_state_detector|predict_customer_state|منفصل/ }
  ];

  const runtime = await createScriptedRuntime(storageDir);
  for (const prompt of prompts) {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      providerConfig: validProviderConfig,
      userPrompt: prompt.text
    });
    await runtime.runTurn(created.sessionId, prompt.text);
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
    const artifactTypes = new Set(session?.artifacts.map((artifact) => artifact.type) ?? []);

    assert.equal(session?.status, "completed");
    assert.equal(session?.resolvedExecutionMode, "simple_mode");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.equal(session?.explainReport, undefined);
    assert.match(assistantMessage, /hivo-file:/);
    assert.ok(artifactTypes.has("decision_pipeline"));
    assert.equal(artifactTypes.has("project_explain_answer"), false);
  }

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("modify requests still go through patch proposal flow with ordered reasoning", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-modify-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-modify-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "change me\n", "utf8");

  const runtime = await createScriptedRuntime(storageDir);
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    providerConfig: validProviderConfig,
    userPrompt: "add a settings page"
  });
  await runtime.runTurn(created.sessionId, "add a settings page");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.patchProposals.length, 1);
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Draft changes"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Approval"));

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});
