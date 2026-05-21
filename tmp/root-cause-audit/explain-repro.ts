import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '../../apps/agent-runtime/src/runtime/AgentRuntime.ts';
import { SessionManager } from '../../apps/agent-runtime/src/runtime/SessionManager.ts';
import { EventBus } from '../../apps/agent-runtime/src/runtime/EventBus.ts';
import { loadConfig } from '../../apps/agent-runtime/src/config.ts';
import { MockLlmProvider } from '../../apps/agent-runtime/src/llm/MockLlmProvider.ts';
import { ToolRegistry } from '../../apps/agent-runtime/src/tools/ToolRegistry.ts';
import { buildProjectIntake, classifyRunIntent, createProjectMapFromIntake } from '../../apps/agent-runtime/src/runtime/ProjectIntake.ts';
import { buildLargeProjectExplainReport } from '../../apps/agent-runtime/src/runtime/LargeProjectContextBuilder.ts';
import { inferWorkspaceIntent } from '../../apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts';

class CapturingMockProvider {
  inner = new MockLlmProvider();
  calls: any[] = [];
  async generateStructured(input: any, schema: any) {
    const schemaName = schema && typeof schema === 'object' && 'name' in schema ? String(schema.name) : '';
    const output = await this.inner.generateStructured(input, schema);
    this.calls.push({
      schemaName,
      systemPrompt: summarize(String(input.systemPrompt ?? ''), 700),
      userPrompt: summarize(String(input.userPrompt ?? ''), 1400),
      output: summarize(JSON.stringify(output), 1200)
    });
    return output;
  }
  async generateText(input: any) {
    this.calls.push({ schemaName: 'text', userPrompt: summarize(String(input.userPrompt ?? ''), 1000) });
    return this.inner.generateText(input);
  }
}

function summarize(value: string, limit: number) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit - 3) + '...' : compact;
}

async function write(root: string, rel: string, content: string) {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function createWorkspace() {
  const root = path.join(os.tmpdir(), `orchcode-root-cause-audit-${Date.now()}`);
  await mkdir(root, { recursive: true });
  await write(root, 'README.md', `# Retention ML Dashboard\n\nFastAPI backend and React-style frontend for customer risk scoring.\n`);
  await write(root, 'package.json', JSON.stringify({ name: 'retention-ml-dashboard', scripts: { test: 'echo ok' }, dependencies: { '@vitejs/plugin-react': 'latest' } }, null, 2));
  await write(root, 'frontend/index.html', `<!doctype html>\n<html>\n<head><link rel="stylesheet" href="./styles.css"></head>\n<body>\n  <nav>\n    <a href="#overview">Overview</a>\n    <a href="#customers">Customers</a>\n    <a href="#models">Models</a>\n  </nav>\n  <div id="root"></div>\n  <script type="module" src="./src/App.jsx"></script>\n</body>\n</html>\n`);
  await write(root, 'frontend/src/App.jsx', `const VIEWS = [\n  { id: 'overview', title: 'Overview', description: 'Shows KPI cards, forecast trend, and model health.' },\n  { id: 'customers', title: 'Customers', description: 'Lists customer risk, predicted SVM state, and confidence.' },\n  { id: 'models', title: 'Models', description: 'Explains clustering, SVM, SARIMA, and SHAP outputs.' }\n];\n\nfunction ViewSection({ view }) {\n  return <section data-view={view.id} aria-label={view.title}>{view.description}</section>;\n}\n\nexport default function App() {\n  return <main className="app-shell">\n    {VIEWS.map((view) => <ViewSection key={view.id} view={view} />)}\n  </main>;\n}\n`);
  await write(root, 'frontend/styles.css', `:root { --bg: #10151f; }\n.overview-page { color: white; }\n.customers-screen { display: grid; }\n.models-section { border: 1px solid #ccc; }\n`);
  await write(root, 'backend/services/clustering.py', `"""Customer clustering pipeline using DBSCAN followed by Fuzzy C-Means."""\nfrom sklearn.cluster import DBSCAN\nimport skfuzzy as fuzz\n\ndef build_customer_segments(features):\n    density_clusters = DBSCAN(eps=0.35, min_samples=5).fit_predict(features)\n    centers, memberships, *_ = fuzz.cluster.cmeans(features.T, c=4, m=2.0, error=0.005, maxiter=1000)\n    fcm_labels = memberships.argmax(axis=0)\n    return density_clusters, fcm_labels, memberships\n`);
  await write(root, 'backend/services/svm_model.py', `"""SVM state detector trained on FCM-generated labels."""\nfrom sklearn.svm import SVC\nimport joblib\n\ndef train_svm_state_detector(features, fcm_labels):\n    svm = SVC(probability=True, kernel='rbf')\n    svm.fit(features, fcm_labels)\n    joblib.dump(svm, 'artifacts/svm_state_detector.joblib')\n    return svm\n\ndef load_svm_state_detector():\n    return joblib.load('artifacts/svm_state_detector.joblib')\n\ndef predict_customer_state(features):\n    svm = load_svm_state_detector()\n    predicted_state = svm.predict(features)\n    confidence = svm.predict_proba(features).max(axis=1)\n    return predicted_state, confidence\n`);
  await write(root, 'backend/services/arima_model.py', `from statsmodels.tsa.statespace.sarimax import SARIMAX\n\ndef train_sarima_forecast(history):\n    model = SARIMAX(history, order=(1, 1, 1), seasonal_order=(1, 1, 1, 12))\n    result = model.fit(disp=False)\n    return result\n\ndef forecast_next_period(model_result, steps=6):\n    return model_result.forecast(steps=steps)\n`);
  await write(root, 'backend/services/shap_explainer.py', `import shap\nfrom backend.services.svm_model import load_svm_state_detector\n\ndef explain_svm_prediction(background, customer_features):\n    svm = load_svm_state_detector()\n    explainer = shap.KernelExplainer(svm.predict_proba, background)\n    shap_values = explainer.shap_values(customer_features)\n    return shap_values\n`);
  await write(root, 'backend/routes.py', `from fastapi import FastAPI\nfrom backend.services.clustering import build_customer_segments\nfrom backend.services.svm_model import train_svm_state_detector, predict_customer_state\nfrom backend.services.arima_model import train_sarima_forecast, forecast_next_period\nfrom backend.services.shap_explainer import explain_svm_prediction\n\napp = FastAPI()\n\n@app.post('/train')\ndef train_pipeline(payload: dict):\n    features = payload['features']\n    _, fcm_labels, memberships = build_customer_segments(features)\n    svm = train_svm_state_detector(features, fcm_labels)\n    forecast_model = train_sarima_forecast(payload['history'])\n    return {'labels': fcm_labels.tolist(), 'memberships': memberships.tolist(), 'svm': str(svm), 'forecast': forecast_next_period(forecast_model).tolist()}\n\n@app.post('/predict')\ndef predict(payload: dict):\n    state, confidence = predict_customer_state(payload['features'])\n    shap_values = explain_svm_prediction(payload['background'], payload['features'])\n    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'shap': str(shap_values)}\n`);
  return root;
}

async function fileLength(root: string, rel: string) {
  try { return (await readFile(path.join(root, rel), 'utf8')).length; } catch { return -1; }
}

async function runPrompt(workspace: string, prompt: string) {
  const storageDir = path.join(os.tmpdir(), `orchcode-root-cause-audit-storage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const provider = new CapturingMockProvider();
  const eventBus = new EventBus();
  const sessionManager = new SessionManager(storageDir, eventBus);
  await sessionManager.load();
  const runtime = new AgentRuntime({ ...loadConfig(), storageDir }, sessionManager, { providerFactory: () => provider as any });
  const created = await runtime.createSession({ workspacePath: workspace, mode: 'demo_mock', accessProfile: 'full_access', userPrompt: prompt });
  await runtime.runTurn(created.sessionId, prompt);
  const session = runtime.getSession(created.sessionId)!;
  const tools = new ToolRegistry(workspace);
  const summary = tools.workspace.getProjectSummary();
  const projectMap = {
    stack: Object.keys(summary.languages),
    packageManagers: summary.packageManagers,
    testCommands: summary.testCommands,
    entryPoints: summary.importantFiles.filter((file: string) => /main|index|app|server|routes|lib\.rs/i.test(file)).slice(0, 8),
    importantFiles: summary.importantFiles
  };
  const intake = buildProjectIntake({ workspacePath: workspace, message: prompt, projectMap, tools });
  const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap: createProjectMapFromIntake(projectMap, intake), intake });
  const sampled = await Promise.all(report.contextPack.sampledFiles.map(async (sample) => ({
    path: sample.path,
    reason: sample.reason,
    charsRead: sample.charsRead,
    fileChars: await fileLength(workspace, sample.path),
    readFully: sample.charsRead >= await fileLength(workspace, sample.path)
  })));
  const answerArtifact = session.artifacts.find((a: any) => a.type === 'project_explain_answer') as any;
  const finalAnswer = session.messages.filter((m: any) => m.role === 'assistant').at(-1)?.content ?? '';
  await rm(storageDir, { recursive: true, force: true });
  return {
    prompt,
    classifyRunIntent: classifyRunIntent(prompt),
    workspaceIntent: inferWorkspaceIntent(prompt),
    runtime: {
      status: session.status,
      resolvedExecutionMode: session.resolvedExecutionMode,
      runMode: session.runMode,
      patchProposalCount: session.patchProposals.length,
      commandRequestCount: session.commandRequests.length,
      hasExplainReport: Boolean(session.explainReport),
      agentRuns: session.orchestration?.agentRuns.map((a: any) => ({ id: a.id, roleTitle: a.roleTitle, status: a.status, currentTask: a.currentTask })) ?? [],
      selectedWorkerAgents: session.orchestration?.selectedWorkerAgents ?? [],
      workerOutputCount: session.orchestration?.workerOutputs.length ?? 0,
      toolIntents: session.toolIntents.map((t: any) => ({ type: t.type, title: t.title, status: t.status, payload: t.payload })).slice(0, 8),
      verification: session.verificationResult ? { status: session.verificationResult.status, checks: session.verificationResult.checks.map((c: any) => ({ name: c.name, status: c.status, detail: c.detail })) } : undefined,
      finalAnswer: summarize(finalAnswer, 1200)
    },
    report: {
      workspaceRoot: workspace,
      scannedFiles: report.contextPack.inventory.scannedFiles,
      sampledFiles: sampled,
      filesReadFully: sampled.filter((s) => s.readFully).map((s) => s.path),
      sections: report.sections.slice(0, 18).map((s) => ({ path: s.filePath, lineStart: s.lineStart, title: s.title, snippet: summarize(s.snippet, 180) })),
      evidence: report.evidence.filter((e) => e.type !== 'directory').slice(0, 18).map((e) => ({ path: e.path, lineStart: e.lineStart, reason: summarize(e.reason, 160), snippet: summarize(e.snippet ?? e.excerpt ?? '', 180) })),
      moduleMap: report.moduleMap.map((m) => ({ root: m.root, responsibility: m.responsibility, importantFiles: m.importantFiles.slice(0, 5) }))
    },
    providerCalls: provider.calls,
    answerArtifact: answerArtifact ? {
      revisionCount: answerArtifact.payload?.revisionCount,
      usedEvidenceRefs: answerArtifact.payload?.usedEvidenceRefs,
      unsupportedOrUnclearParts: answerArtifact.payload?.unsupportedOrUnclearParts,
      validationWarnings: answerArtifact.payload?.validationWarnings,
      grounding: answerArtifact.payload?.grounding ? {
        questionKind: answerArtifact.payload.grounding.questionKind,
        decision: answerArtifact.payload.grounding.decision,
        conceptLabel: answerArtifact.payload.grounding.concept?.label,
        conceptFound: answerArtifact.payload.grounding.conceptFound,
        supportingRefs: answerArtifact.payload.grounding.supportingRefs,
        inspectedFiles: answerArtifact.payload.grounding.inspectedFiles,
        requiredFacets: answerArtifact.payload.grounding.workspaceReasoning?.intent?.requiredFacets,
        answerGoal: answerArtifact.payload.grounding.workspaceReasoning?.intent?.answerGoal,
        missingRequiredFacets: answerArtifact.payload.grounding.workspaceReasoning?.evidencePack?.missingRequiredFacets
      } : undefined
    } : undefined,
    structuredFactsPresent: answerArtifact ? {
      pageInventory: Boolean(answerArtifact.payload?.pageInventory || answerArtifact.payload?.grounding?.pageInventory),
      algorithmInventory: Boolean(answerArtifact.payload?.algorithmInventory || answerArtifact.payload?.grounding?.algorithmInventory),
      trainingInference: Boolean(answerArtifact.payload?.trainingInference || answerArtifact.payload?.grounding?.trainingInference),
      codeFlow: Boolean(answerArtifact.payload?.codeFlow || answerArtifact.payload?.grounding?.codeFlow)
    } : {}
  };
}

async function main() {
const prompts = [
  'عندي هنا كام صفحه ف السيستم دا وكل واحده بتعمل ايه ؟',
  'عندنا كام algorithm هنا؟ واشرحهم واحده واحده.',
  'ازاي الsvm بيتطبق هنا ؟ اشرح بالتفصيل',
  'هل عندي training و inference منفصلين هنا؟ كل واحد فين وبيعمل إيه؟'
];
const workspace = await createWorkspace();
const results = [] as any[];
try {
  for (const prompt of prompts) results.push(await runPrompt(workspace, prompt));
  console.log(JSON.stringify({ workspace, results }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}

}

main().catch((error) => { console.error(error); process.exit(1); });



