import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { buildLargeProjectExplainReport } from "../runtime/LargeProjectContextBuilder.js";
import { answerUniversalProjectQuestion } from "../runtime/UniversalProjectQuestionEngine.js";
import { inferWorkspaceIntent } from "../runtime/WorkspaceReasoningPipeline.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

class ThrowingProvider implements LlmProvider {
  async generateStructured(): Promise<never> {
    throw new Error("provider unavailable");
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class NotFoundProvider implements LlmProvider {
  constructor(private readonly refs: string[] = []) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "I could not find that concept in the project evidence, even after checking the supplied local reference. [src/analytics.ts:1](hivo-file:src%2Fanalytics.ts:1)",
      usedEvidenceRefs: this.refs,
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class ShortDetailedProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "SVM is trained, then used for prediction. [backend/services/svm_model.py:1](hivo-file:backend%2Fservices%2Fsvm_model.py:1)",
      usedEvidenceRefs: ["backend/services/svm_model.py:1"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

class GenericPipelineProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: [
        "The flow is upstream-clustering -> training -> prediction -> explainability -> usage.",
        "[backend/services/clustering.py:1](hivo-file:backend%2Fservices%2Fclustering.py:1)"
      ].join("\n"),
      usedEvidenceRefs: ["backend/services/clustering.py:1"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

const projectMap: ProjectMap = {
  stack: ["TypeScript"],
  packageManagers: ["npm"],
  testCommands: ["npm test"],
  entryPoints: ["src/index.ts"],
  importantFiles: ["package.json", "src/index.ts"]
};

async function createWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: prefix, scripts: { test: "echo ok" } }, null, 2), "utf8");
  return workspace;
}

async function createSvmWorkspace() {
  const workspace = await createWorkspace("universal-detailed-svm");
  await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
  await writeFile(
    path.join(workspace, "backend", "services", "clustering.py"),
    [
      "from sklearn.cluster import DBSCAN",
      "import skfuzzy as fuzz",
      "import numpy as np",
      "",
      "class CustomerClusteringService:",
      "    \"\"\"Run the required DBSCAN -> FCM clustering pipeline.\"\"\"",
      "",
      "    def fit_dbscan(self, X):",
      "        dbscan_labels = DBSCAN(eps=0.35, min_samples=5).fit_predict(X)",
      "        noise_mask = dbscan_labels == -1",
      "        feature_frame = X[~noise_mask]",
      "        return dbscan_labels, feature_frame, noise_mask",
      "",
      "    def fit_fcm(self, feature_frame):",
      "        centers, memberships, *_ = fuzz.cluster.cmeans(feature_frame.T, c=4, m=2.0, error=0.005, maxiter=1000)",
      "        fcm_labels = memberships.argmax(axis=0)",
      "        return fcm_labels, memberships",
      "",
      "    def fit(self, X):",
      "        dbscan_labels, feature_frame, noise_mask = self.fit_dbscan(X)",
      "        fcm_labels, memberships = self.fit_fcm(feature_frame)",
      "        return dbscan_labels, fcm_labels, memberships, noise_mask",
      "",
      "def _training_dbscan_payload(dbscan_labels):",
      "    noise_mask = np.asarray(dbscan_labels) == -1",
      "    return {'dbscan_labels': np.asarray(dbscan_labels).tolist(), 'noise_mask': noise_mask.tolist()}",
      "",
      "def build_customer_segments(features):",
      "    service = CustomerClusteringService()",
      "    dbscan_labels, fcm_labels, memberships, noise_mask = service.fit(features)",
      "    _training_dbscan_payload(dbscan_labels)",
      "    return dbscan_labels, fcm_labels, memberships"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "svm_model.py"),
    [
      "from sklearn.svm import SVC",
      "import joblib",
      "",
      "def train_svm_state_detector(features, fcm_labels):",
      "    svm = SVC(probability=True, kernel='rbf')",
      "    svm.fit(features, fcm_labels)",
      "    joblib.dump(svm, 'artifacts/svm_state_detector.joblib')",
      "    return svm",
      "",
      "def load_svm_state_detector():",
      "    return joblib.load('artifacts/svm_state_detector.joblib')",
      "",
      "def predict_customer_state(features):",
      "    svm = load_svm_state_detector()",
      "    return svm.predict(features), svm.predict_proba(features).max(axis=1)"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "shap_explainer.py"),
    [
      "import shap",
      "from backend.services.svm_model import load_svm_state_detector",
      "",
      "def explain_svm_prediction(background, customer_features):",
      "    svm = load_svm_state_detector()",
      "    explainer = shap.KernelExplainer(svm.predict_proba, background)",
      "    return explainer.shap_values(customer_features)"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "from fastapi import FastAPI",
      "from backend.services.clustering import build_customer_segments",
      "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
      "from backend.services.shap_explainer import explain_svm_prediction",
      "",
      "app = FastAPI()",
      "",
      "@app.post('/train')",
      "def train_pipeline(payload: dict):",
      "    _, fcm_labels, _ = build_customer_segments(payload['features'])",
      "    return {'svm': str(train_svm_state_detector(payload['features'], fcm_labels))}",
      "",
      "@app.post('/predict')",
      "def predict(payload: dict):",
      "    state, confidence = predict_customer_state(payload['features'])",
      "    shap_values = explain_svm_prediction(payload['background'], payload['features'])",
      "    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'shap': str(shap_values)}"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(
    path.join(workspace, "frontend", "ClusterChart.tsx"),
    [
      "export function ClusterChart({ dbscanLabels }: { dbscanLabels: number[] }) {",
      "  const color = rgba(Number(dbscanLabels[0] ?? 0), 120, 200, 0.4);",
      "  return <span>{color}</span>;",
      "}",
      "function rgba(r: number, g: number, b: number, a: number) {",
      "  return `rgba(${r}, ${g}, ${b}, ${a})`;",
      "}"
    ].join("\n"),
    "utf8"
  );
  return workspace;
}

async function createInvestigationWorkspace() {
  const workspace = await createSvmWorkspace();
  await mkdir(path.join(workspace, "frontend"), { recursive: true });
  await writeFile(
    path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
    [
      "import { useState } from 'react';",
      "",
      "export function CustomerFeedbackPanel() {",
      "  const [feedback, setFeedback] = useState({ submitting: false, label: 'neutral', message: '' });",
      "  async function submitFeedback(label: 'positive' | 'negative' | 'neutral') {",
      "    setFeedback((state) => ({ ...state, submitting: true, label }));",
      "    await fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify({ label, message: feedback.message }) });",
      "  }",
      "  return <form onSubmit={() => submitFeedback(feedback.label as any)}><textarea value={feedback.message} /><button>Send feedback</button></form>;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "action_executor.py"),
    [
      "class ActionExecutor:",
      "    def execute(self, prediction):",
      "        low_gap = prediction.get('probability_gap', 0.0) < 0.12",
      "        if low_gap:",
      "            return {'status': 'review', 'selected_action_name': 'Human Review', 'action_type': 'manual_review', 'observed_outcome': 'awaiting_feedback'}",
      "        return {'status': 'pass', 'selected_action_name': 'Strong Offer', 'action_type': 'retention_offer', 'observed_outcome': 'awaiting_feedback'}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "services", "retraining.py"),
    [
      "import csv",
      "RETRAINING_LOG_PATH = 'logs/retraining_log.csv'",
      "",
      "def record_retraining_candidate(customer_id, feedback_label, model_state):",
      "    with open(RETRAINING_LOG_PATH, 'a', newline='') as handle:",
      "        writer = csv.DictWriter(handle, fieldnames=['customer_id', 'feedback_label', 'model_state'])",
      "        writer.writerow({'customer_id': customer_id, 'feedback_label': feedback_label, 'model_state': model_state})",
      "    return {'queued_for_retraining': True}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(workspace, "backend", "routes.py"),
    [
      "from fastapi import FastAPI",
      "import csv",
      "from backend.services.clustering import build_customer_segments",
      "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
      "from backend.services.action_executor import ActionExecutor",
      "from backend.services.retraining import record_retraining_candidate",
      "",
      "app = FastAPI()",
      "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
      "",
      "@app.post('/train')",
      "def train_pipeline(payload: dict):",
      "    _, fcm_labels, _ = build_customer_segments(payload['features'])",
      "    return {'trained': str(train_svm_state_detector(payload['features'], fcm_labels))}",
      "",
      "@app.post('/predict')",
      "def predict(payload: dict):",
      "    state, confidence = predict_customer_state(payload['features'])",
      "    action = ActionExecutor().execute({'probability_gap': payload.get('probability_gap', 0.0)})",
      "    return {'state': state.tolist(), 'confidence': confidence.tolist(), 'action': action}",
      "",
      "@app.post('/api/customer-feedback')",
      "def receive_customer_feedback(payload: dict):",
      "    label = payload.get('label')",
      "    if label not in {'positive', 'negative', 'neutral'}:",
      "        return {'status': 'rejected'}",
      "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
      "        writer = csv.DictWriter(handle, fieldnames=['label', 'message'])",
      "        writer.writerow({'label': label, 'message': payload.get('message', '')})",
      "    retraining = record_retraining_candidate(payload.get('customer_id'), label, payload.get('model_state'))",
      "    return {'status': 'accepted', 'feedback_label': label, 'retraining': retraining}"
    ].join("\n"),
    "utf8"
  );
  await mkdir(path.join(workspace, "tests"), { recursive: true });
  await writeFile(
    path.join(workspace, "tests", "test_feedback.py"),
    [
      "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
      "    response = client.post('/api/customer-feedback', json={'label': 'invalid'})",
      "    assert response.status_code in (200, 422)"
    ].join("\n"),
    "utf8"
  );
  return workspace;
}

test("UniversalProjectQuestionEngine finds evidence beyond the old searchCode file cap", async () => {
  const workspace = await createWorkspace("universal-search-cap");
  try {
    await mkdir(path.join(workspace, "aaa"), { recursive: true });
    await mkdir(path.join(workspace, "zzz", "deep"), { recursive: true });
    for (let index = 0; index < 650; index += 1) {
      await writeFile(path.join(workspace, "aaa", `filler-${index}.ts`), `export const filler${index} = ${index};\n`, "utf8");
    }
    await writeFile(
      path.join(workspace, "zzz", "deep", "payment.ts"),
      [
        "export function rarePaymentGatewayAdapter(payload: unknown) {",
        "  return { provider: 'stripe', payload };",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    assert.equal(tools.workspace.searchCode("rarePaymentGatewayAdapter", 10).length, 0);

    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is rarePaymentGatewayAdapter?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: "Where is rarePaymentGatewayAdapter?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /rarePaymentGatewayAdapter|payment\.ts/);
    assert.match(result.answerMarkdown, /hivo-file:/);
    assert.ok(result.positiveEvidence.some((item) => item.path === "zzz/deep/payment.ts"));
    assert.ok(result.openedFiles.includes("zzz/deep/payment.ts"));
    assert.equal(result.fallbackUsed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Project Investigation Kernel v1 resolves DBSCAN, feedback, outerloop, and feedback-change prompts", async () => {
  const workspace = await createInvestigationWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const reportFor = (message: string) => buildLargeProjectExplainReport({
      workspacePath: workspace,
      message,
      projectMap: {
        ...projectMap,
        stack: ["Python", "React"],
        entryPoints: ["backend/routes.py", "frontend/CustomerFeedbackPanel.tsx"],
        importantFiles: [
          "backend/routes.py",
          "backend/services/clustering.py",
          "backend/services/action_executor.py",
          "backend/services/retraining.py",
          "frontend/CustomerFeedbackPanel.tsx"
        ]
      }
    });
    const ask = (message: string) => answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: message,
      explainReport: reportFor(message)
    });

    const dbscan = await ask("ازاي الDBSCAN بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(dbscan.intent.actionMode, "answer_only");
    assert.equal(dbscan.questionUnderstanding.targetConcept, "dbscan");
    assert.equal(dbscan.conceptResolution.resolutionStatus, "direct_found");
    assert.ok(dbscan.conceptFlow.steps.some((step) => step.outputNames.includes("dbscan_labels")));
    assert.ok(dbscan.conceptFlow.steps.some((step) => step.nextConsumers.includes("fit_fcm") || step.nextConsumers.includes("X_clean")));
    assert.doesNotMatch(dbscan.answerMarkdown, /No local matches for query/i);

    const feedback = await ask("ازاي الfeedback بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(feedback.intent.actionMode, "answer_only");
    assert.equal(feedback.questionUnderstanding.targetConcept, "feedback");
    assert.equal(feedback.mechanismChain.status, "confirmed");
    assert.ok(feedback.mechanismChain.steps.some((step) => step.relation === "frontend_to_api" && step.to === "/api/customer-feedback"));
    assert.ok(feedback.mechanismChain.steps.some((step) => step.relation === "api_to_backend" && step.from === "/api/customer-feedback"));
    assert.ok(feedback.mechanismChain.steps.every((step) => step.relation !== "api_to_backend" || step.from !== "/train"));
    assert.ok(feedback.testEndpointExpectations.some((item) => item.endpoint === "/api/customer-feedback"));
    assert.equal(feedback.mechanismEvidence.apiLinkEvidence.some((item) => /tests\//.test(item.path)), false);
    assert.ok(feedback.targetScopedStorageEvidence.some((item) => item.storageTarget === "CUSTOMER_FEEDBACK_LOG_PATH" && (item.role === "log_append" || item.role === "storage_write")));
    assert.ok(feedback.mechanismChain.steps.every((step) => step.status === "proven" || step.status === "partial" || step.status === "unproven"));
    assert.doesNotMatch(feedback.answerMarkdown, /No local matches for query|ui_state|backend_route|mechanismCoverageValidation/i);

    const outerloop = await ask("ازاي الouterloop بيتطبق هنا؟ اشرح بالتفصيل");
    assert.equal(outerloop.questionUnderstanding.targetConcept, "outerloop");
    assert.notEqual(outerloop.conceptResolution.resolutionStatus, "not_found");
    assert.ok(outerloop.conceptResolution.inferredPatternName);
    assert.ok(outerloop.mechanismChain.steps.some((step) => step.relation === "decision_action_stage"));
    assert.ok(outerloop.mechanismChain.steps.some((step) => step.relation === "feedback_or_outcome_stage"));
    assert.doesNotMatch(outerloop.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction/i);
    assert.doesNotMatch(outerloop.answerMarkdown, /No local matches for query/i);

    const innerOuter = await ask("هل فيه inner loop و outer loop هنا؟ الفرق بينهم ايه؟");
    assert.equal(innerOuter.questionUnderstanding.targetConcept, "inner_outer_loop");
    assert.notEqual(innerOuter.conceptResolution.resolutionStatus, "not_found");
    assert.ok(innerOuter.mechanismChain.steps.some((step) => step.relation === "decision_action_stage" || step.relation === "inner_model_decision"));
    assert.doesNotMatch(innerOuter.answerMarkdown, /No local matches for query/i);

    const feedbackChangesPrompt = "الفيدباك بيغير ايه في السيستم بعد ما اليوزر يبعت positive او negative او neutral؟";
    const feedbackIntent = inferWorkspaceIntent(feedbackChangesPrompt);
    assert.equal(feedbackIntent.actionMode, "answer_only");
    const feedbackChanges = await ask(feedbackChangesPrompt);
    assert.equal(feedbackChanges.intent.actionMode, "answer_only");
    assert.equal(feedbackChanges.questionUnderstanding.targetConcept, "feedback");
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("positive"));
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("negative"));
    assert.ok(feedbackChanges.conceptResolution.labelsOrModifiers.includes("neutral"));
    assert.ok(feedbackChanges.mechanismChain.steps.some((step) => step.relation === "backend_to_storage"));
    assert.doesNotMatch(feedbackChanges.answerMarkdown, /No local matches for query|positive` كدليل مستقل|target concept.*positive/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine rejects not-found provider text when local evidence exists", async () => {
  const workspace = await createWorkspace("universal-not-found-override");
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "analytics.ts"),
      [
        "export class CustomerRiskScorer {",
        "  score(customer: { churnRisk: number }) {",
        "    return customer.churnRisk;",
        "  }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const tools = new ToolRegistry(workspace);
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "Where is CustomerRiskScorer?",
      projectMap
    });
    const result = await answerUniversalProjectQuestion({
      provider: new NotFoundProvider(["src/analytics.ts:1"]),
      tools,
      userPrompt: "Where is CustomerRiskScorer?",
      explainReport: report
    });

    assert.match(result.answerMarkdown, /CustomerRiskScorer|analytics\.ts/);
    assert.match(result.answerMarkdown, /hivo-file:/);
    assert.ok(result.validationErrors.length > 0);
    assert.doesNotMatch(result.answerMarkdown, /could not find/i);
    assert.equal(result.fallbackUsed, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine expands detailed SVM flow instead of accepting shallow bullets", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const detailedPrompt = "How is SVM applied here? Explain in detail with code snippets.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: detailedPrompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/svm_model.py", "backend/services/clustering.py", "backend/services/shap_explainer.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new ShortDetailedProvider(),
      tools,
      userPrompt: detailedPrompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.detailLevel, "detailed");
    assert.equal(result.questionUnderstanding.wantsCodeExamples, true);
    assert.equal(result.answerShapeValidation.valid, true);
    assert.equal(result.answerShapeValidation.tooShallow, false);
    assert.ok(result.answerShapeValidation.repairedFrom?.some((error) => /too shallow|too few sections/i.test(error)));
    assert.ok(result.answerMarkdown.length >= 900);
    assert.ok(result.answerShapeValidation.sectionCount >= 3);
    assert.match(result.answerMarkdown, /## Summary|## الخلاصة/);
    assert.match(result.answerMarkdown, /training|SVC|fit|labels/i);
    assert.match(result.answerMarkdown, /prediction|predict|predict_proba/i);
    assert.match(result.answerMarkdown, /SHAP|KernelExplainer|explainability/i);
    assert.match(result.answerMarkdown, /API|route|service flow|\/predict/i);
    assert.match(result.answerMarkdown, /joblib|persistence|load_svm_state_detector/i);
    assert.match(result.answerMarkdown, /```/);
    assert.match(result.answerMarkdown, /hivo-file:/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine explains feedback UI-only evidence without inventing backend wiring", async () => {
  const workspace = await createWorkspace("universal-feedback-ui-only");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ submitting: false, message: '' });",
        "  return <form><textarea value={feedback.message} /></form>;",
        "}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "feedback");
    assert.equal(result.mechanismChain.status, "partial");
    assert.ok(result.missingMechanismLinks.includes("frontend_to_backend_request"));
    assert.match(result.answerMarkdown, /الواجهة|state|واجهة/);
    assert.match(result.answerMarkdown, /لم أجد.*request|لم أجد.*backend|غير مثبت/);
    assert.doesNotMatch(result.answerMarkdown, /Action|Testing|section|lede|Tracks|how/);
    assert.doesNotMatch(result.answerMarkdown, /\bui_state\b|\bbackend_route\b|directMechanismEvidence/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine does not treat feedback endpoint tests as frontend flow", async () => {
  const workspace = await createWorkspace("universal-feedback-test-only");
  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "test_feedback.py"),
      [
        "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
        "    response = client.post('/api/customer-feedback', json={'label': 'invalid'})",
        "    assert response.status_code == 422"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.mechanismChain.status, "partial");
    assert.ok(result.testEndpointExpectations.some((item) => item.endpoint === "/api/customer-feedback"));
    assert.equal(result.mechanismEvidence.apiLinkEvidence.length, 0);
    assert.match(result.answerMarkdown, /الاختبارات|endpoint متوقع|لا تثبت أن الواجهة/);
    assert.doesNotMatch(result.answerMarkdown, /حلقة الربط التي تثبت أن الكود يحاول إرسال البيانات خارج الواجهة/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine rejects general storage as feedback log evidence", async () => {
  const workspace = await createWorkspace("universal-feedback-general-storage");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "data_generator.py"),
      [
        "CUSTOMERS_PATH = 'data/generated_customers.csv'",
        "",
        "def save_dataset(customers_df):",
        "    output_path = CUSTOMERS_PATH",
        "    customers_df.to_csv(output_path, index=False)",
        "    return output_path"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.notEqual(result.mechanismChain.status, "confirmed");
    assert.ok(result.generalStorageEvidence.some((item) => item.storageTarget === "CUSTOMERS_PATH"));
    assert.equal(result.targetScopedStorageEvidence.some((item) => item.storageTarget === "CUSTOMERS_PATH"), false);
    assert.doesNotMatch(result.answerMarkdown, /CUSTOMERS_PATH.*يثبت|save_dataset.*feedback storage|to_csv.*feedback/);
    assert.match(result.answerMarkdown, /تخزينًا عامًا|غير مربوط/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine narrates confirmed feedback frontend API backend log flow", async () => {
  const workspace = await createWorkspace("universal-feedback-full-flow");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ submitting: false, message: '' });",
        "  async function submitFeedback() {",
        "    await fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify(feedback) });",
        "  }",
        "  return <form onSubmit={submitFeedback}><textarea value={feedback.message} /></form>;",
        "}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "routes.py"),
      [
        "from fastapi import FastAPI",
        "import csv",
        "",
        "app = FastAPI()",
        "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
        "",
        "@app.post('/api/customer-feedback')",
        "def receive_customer_feedback(payload: dict):",
        "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
        "        writer = csv.DictWriter(handle, fieldnames=['message'])",
        "        writer.writerow({'message': payload.get('message', '')})",
        "    return {'ok': True}"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي feedback بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
    const result = await answerUniversalProjectQuestion({
      provider: new ThrowingProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.mechanismChain.status, "confirmed");
    assert.match(result.answerMarkdown, /\/api\/customer-feedback/);
    assert.match(result.answerMarkdown, /CUSTOMER_FEEDBACK_LOG_PATH|customer_feedback_log/);
    assert.match(result.answerMarkdown, /الواجهة/);
    assert.match(result.answerMarkdown, /backend|الـ backend/);
    assert.doesNotMatch(result.answerMarkdown, /\bui_state\b|\bbackend_route\b|mechanismCoverageValidation/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps detailed DBSCAN answers centered on DBSCAN implementation", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي الdbscan بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "dbscan");
    assert.ok(result.questionUnderstanding.requestedFacets.includes("parameters"));
    assert.ok(result.implementationEvidence.some((item) => item.path === "backend/services/clustering.py" && item.semanticRole === "implementation"));
    assert.ok(result.implementationEvidence.some((item) => item.ownerSymbol === "CustomerClusteringService.fit_dbscan" && item.callKind === "direct_algorithm_call"));
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "orchestration" && /self\.fit_dbscan/.test(item.snippet)));
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "artifact_preparation" && /_training_dbscan_payload/.test(item.snippet)));
    assert.ok(result.implementationEvidence.some((item) => item.path === "frontend/ClusterChart.tsx" && item.semanticRole === "visualization"));
    assert.ok(result.suppressedEvidence.some((item) => item.semanticRole === "visualization"));
    assert.ok(result.conceptFlow.steps.some((step) => /DBSCAN|dbscan/i.test(step.whatHappens)));
    assert.equal(result.conceptFlow.steps.filter((step) => step.ownerSymbol.includes("fit_dbscan")).length, 1);
    assert.ok(result.conceptFlow.steps.every((step) => step.callKind === "direct_algorithm_call"));
    assert.ok(result.artifactPreparationEvidence.some((item) => /_training_dbscan_payload/.test(item.snippet)));
    assert.equal(result.dedupeValidation.valid, true);
    assert.equal(result.outputCleanupValidation.valid, true);
    assert.equal(result.coverageValidation.valid, true);
    assert.equal(result.roleClassificationValidation.valid, true);
    assert.match(result.answerMarkdown, /DBSCAN|dbscan/);
    assert.match(result.answerMarkdown, /backend\/services\/clustering\.py/);
    assert.match(result.answerMarkdown, /features|X/);
    assert.match(result.answerMarkdown, /eps\s*=\s*0\.35|min_samples\s*=\s*5/);
    assert.match(result.answerMarkdown, /dbscan_labels|fit_predict|clusters/i);
    assert.match(result.answerMarkdown, /cmeans|Fuzzy|FCM|memberships|fcm_labels/i);
    assert.match(result.answerMarkdown, /train_svm_state_detector|svm|SVM|\/train/i);
    assert.doesNotMatch(result.answerMarkdown, /dbscan call:.*cmeans/i);
    assert.doesNotMatch(result.answerMarkdown, /self\.fit_dbscan\(X\).*تنفيذ مباشر|self\.fit_dbscan\(X\).*implementation/i);
    assert.doesNotMatch(result.answerMarkdown, /_training_dbscan_payload.*تنفيذ مباشر|_training_dbscan_payload.*implementation/i);
    assert.doesNotMatch(result.answerMarkdown, /rgba|Number|ClusterChart/);
    assert.doesNotMatch(result.answerMarkdown, /\{\s*;\s*\{/);
    assert.doesNotMatch(result.answerMarkdown, /feature_frame,\s*\n\s*noise_mask/);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
    assert.doesNotMatch(result.answerMarkdown, /No local matches for query/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine resolves DBSCAN instance calls, outputs, and downstream orchestration", async () => {
  const workspace = await createWorkspace("universal-dbscan-instance");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "clustering.py"),
      [
        "from sklearn.cluster import DBSCAN",
        "import skfuzzy as fuzz",
        "",
        "class CustomerClusteringService:",
        "    def __init__(self):",
        "        self.dbscan_model = DBSCAN(eps=0.42, min_samples=7)",
        "",
        "    def fit_dbscan(self, X, scaler):",
        "        X_scaled = scaler.transform(X)",
        "        dbscan_labels = self.dbscan_model.fit_predict(X_scaled)",
        "        clean_mask = dbscan_labels != -1",
        "        X_clean = X_scaled[clean_mask]",
        "        return {'dbscan_labels': dbscan_labels, 'X_clean': X_clean, 'clean_mask': clean_mask}",
        "",
        "    def fit_fcm(self, X_clean):",
        "        centers, memberships, *_ = fuzz.cluster.cmeans(X_clean.T, c=3, m=2.0, error=0.005, maxiter=1000)",
        "        fcm_labels = memberships.argmax(axis=0)",
        "        return {'fcm_labels': fcm_labels, 'memberships': memberships}",
        "",
        "    def fit(self, X, scaler):",
        "        dbscan_result = self.fit_dbscan(X, scaler)",
        "        fcm_result = self.fit_fcm(dbscan_result['X_clean'])",
        "        return dbscan_result, fcm_result"
      ].join("\n"),
      "utf8"
    );
    const tools = new ToolRegistry(workspace);
    const prompt = "How is DBSCAN applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: { ...projectMap, stack: ["Python"], importantFiles: ["backend/services/clustering.py"] }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.conceptResolution.resolutionStatus, "direct_found");
    assert.ok(result.implementationEvidence.some((item) => item.semanticRole === "implementation" && /self\.dbscan_model\.fit_predict/.test(item.snippet)));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("dbscan_labels")));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("clean_mask")));
    assert.ok(result.conceptFlow.steps.some((step) => step.outputNames.includes("X_clean")));
    assert.ok(result.conceptFlow.steps.some((step) => step.nextConsumers.includes("fit_fcm") || step.nextConsumers.includes("X_clean")));
    assert.doesNotMatch(result.answerMarkdown, /outputs? are not explicit|outputs? are not clear/i);
    assert.doesNotMatch(result.answerMarkdown, /downstream consumers are not explicit/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps unknown target concepts separate from general ML evidence", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "How is outerloop applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "outerloop");
    assert.equal(result.conceptResolution.resolutionStatus, "not_found");
    assert.equal(result.positiveEvidence.length, 0);
    assert.ok(result.conceptResolution.generalProjectEvidence.length > 0);
    assert.match(result.answerMarkdown, /could not prove|not prove|No direct, alias, behavioral, or architectural-pattern evidence/i);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
    assert.doesNotMatch(result.answerMarkdown, /No local matches for query "(interface|def|export|import|function|class|type)"/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine keeps FCM detail focused on cmeans and memberships", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "How is Fuzzy C-Means applied here? Explain in detail.";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "fcm");
    assert.equal(result.coverageValidation.valid, true);
    assert.ok(result.conceptFlow.steps.every((step) => step.semanticRole === "implementation"));
    assert.match(result.answerMarkdown, /cmeans|Fuzzy C-Means|FCM/i);
    assert.match(result.answerMarkdown, /memberships|fcm_labels|argmax/i);
    assert.match(result.answerMarkdown, /features\.T|c=4|m=2\.0|error=0\.005|maxiter=1000/);
    assert.doesNotMatch(result.answerMarkdown, /fcm call:.*DBSCAN/i);
    assert.doesNotMatch(result.answerMarkdown, /upstream-clustering\s*->\s*training\s*->\s*prediction\s*->\s*explainability\s*->\s*usage/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("UniversalProjectQuestionEngine preserves Arabic in concept-centric fallback", async () => {
  const workspace = await createSvmWorkspace();
  try {
    const tools = new ToolRegistry(workspace);
    const prompt = "ازاي الdbscan بيتطبق هنا؟ اشرح بالتفصيل";
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: prompt,
      projectMap: {
        ...projectMap,
        stack: ["Python"],
        entryPoints: ["backend/routes.py"],
        importantFiles: ["backend/routes.py", "backend/services/clustering.py", "backend/services/svm_model.py"]
      }
    });
    const result = await answerUniversalProjectQuestion({
      provider: new GenericPipelineProvider(),
      tools,
      userPrompt: prompt,
      explainReport: report
    });

    assert.equal(result.questionUnderstanding.targetConcept, "dbscan");
    assert.equal(result.languageValidation.valid, true);
    assert.match(result.answerMarkdown, /الخلاصة|تسلسل التنفيذ|إجابات مباشرة|مقتطفات مهمة/);
    assert.match(result.answerMarkdown, /DBSCAN/);
    assert.match(result.answerMarkdown, /هنا الكود بيشغل DBSCAN فعليًا|تنفيذ مباشر/);
    assert.doesNotMatch(result.answerMarkdown, /^## Summary/m);
    assert.doesNotMatch(result.answerMarkdown, /The code applies DBSCAN through/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
