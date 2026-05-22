import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../config.js";
import { buildServer } from "../server.js";

test("run this project completes with a preview-ready result for static module workspaces without scripts", async () => {
  process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `orchcode-run-static-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run-static-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "index.html"),
    '<!doctype html><html><body><script type="module" src="./main.js"></script></body></html>\n',
    "utf8"
  );
  await writeFile(path.join(workspace, "styles.css"), "body { margin: 0; }\n", "utf8");
  await writeFile(path.join(workspace, "main.js"), 'import * as THREE from "https://unpkg.com/three/build/three.module.js";\n', "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
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

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS;
});

test("run this project prefers package manager dev scripts in package.json workspaces", async () => {
  process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS = "1";
  const workspace = path.join(os.tmpdir(), `orchcode-run-package-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-run-package-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({ scripts: { dev: "vite --port 4409" } }, null, 2),
    "utf8"
  );
  await writeFile(path.join(workspace, "README.md"), "vite test fixture\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    accessProfile: "full_access",
    userPrompt: "run this project"
  });
  await runtime.runTurn(created.sessionId, "run this project");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.runMode, "run_to_green");
  assert.equal(session?.patchProposals.length, 0);
  assert.equal(session?.commandRequests[0]?.command, "npm run dev");
  assert.equal(session?.previewRecommendation?.target, "http://127.0.0.1:4409");

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
  delete process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS;
});

test("explain this project stays in simple mode and emits ordered progress without patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-explain-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "explain this project"
  });
  await runtime.runTurn(created.sessionId, "explain this project");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.patchProposals.length, 0);
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Intake"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Workspace snapshot"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Plan"));
  assert.ok(session?.verificationResult);
  assert.ok(session?.explainReport);
  assert.equal(session?.commandRequests.length, 0);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("arabic explain requests stay inspect-only and answer in chat", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-arabic-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-arabic-explain-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "hello project\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "اشرح المشروع"
  });
  await runtime.runTurn(created.sessionId, "اشرح المشروع");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.resolvedExecutionMode, "simple_mode");
  assert.equal(session?.patchProposals.length, 0);
  assert.ok(session?.explainReport);
  assert.equal(session?.messages.some((message) => message.role === "assistant" && message.content.length > 0), true);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("mixed Arabic dataset realtime question is inspect-only and does not create a patch proposal", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-arabic-dataset-realtime-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-arabic-dataset-realtime-storage-${Date.now()}`);
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

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: prompt
  });
  await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId);
  const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

  assert.equal(session?.status, "completed");
  assert.equal(session?.runMode, "inspect_only");
  assert.equal(session?.patchProposals.length, 0);
  assert.ok(session?.explainReport);
  assert.match(assistantMessage, /dataset realtime behavior|dataset|داتا|realtime/i);
  assert.doesNotMatch(assistantMessage, /could not find .*طفل|طفل بيقدر|بيقدر يجيب/i);

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("Arabic inspect regression prompts answer from evidence without patch proposals", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-arabic-inspect-regression-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-arabic-inspect-regression-storage-${Date.now()}`);
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

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  for (const prompt of prompts) {
    const created = await runtime.createSession({
      workspacePath: workspace,
      mode: "demo_mock",
      userPrompt: prompt.text
    });
    await runtime.runTurn(created.sessionId, prompt.text);
    const session = runtime.getSession(created.sessionId);
    const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";
    const answerArtifact = session?.artifacts.find((artifact) => artifact.type === "project_explain_answer");

    assert.equal(session?.runMode, "inspect_only");
    assert.equal(session?.patchProposals.length, 0);
    assert.equal(session?.commandRequests.length, 0);
    assert.ok(session?.explainReport);
    assert.match(assistantMessage, prompt.expected);
    assert.match(assistantMessage, /orchcode-file:/);
    assert.ok(answerArtifact?.payload && "intent" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "questionUnderstanding" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "queryPlan" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "searchIterations" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "candidateFiles" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "openedFiles" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "evidenceRefs" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "negativeEvidence" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "structuredFacts" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "fallbackUsed" in answerArtifact.payload);
    assert.ok(answerArtifact?.payload && "confidence" in answerArtifact.payload);
  }

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("modify requests still go through patch proposal flow with ordered reasoning", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-modify-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-modify-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "change me\n", "utf8");

  const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
  const created = await runtime.createSession({
    workspacePath: workspace,
    mode: "demo_mock",
    userPrompt: "add a settings page"
  });
  await runtime.runTurn(created.sessionId, "add a settings page");
  const session = runtime.getSession(created.sessionId);

  assert.equal(session?.patchProposals.length, 1);
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Draft changes"));
  assert.ok(session?.progressEvents.some((event) => event.taskTitle === "Approval"));

  await app.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});
