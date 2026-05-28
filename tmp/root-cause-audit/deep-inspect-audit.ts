import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectMap } from "../../packages/protocol/src/models.ts";
import type { LlmProvider, LlmRequest } from "../../apps/agent-runtime/src/llm/LlmProvider.ts";
import { buildLargeProjectExplainReport } from "../../apps/agent-runtime/src/runtime/LargeProjectContextBuilder.ts";
import { answerUniversalProjectQuestion } from "../../apps/agent-runtime/src/runtime/UniversalProjectQuestionEngine.ts";
import { inferWorkspaceIntent } from "../../apps/agent-runtime/src/runtime/WorkspaceReasoningPipeline.ts";
import { ToolRegistry } from "../../apps/agent-runtime/src/tools/ToolRegistry.ts";

class WeakProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return {
      answerMarkdown: "The project has an ML pipeline and feedback-related evidence. [backend/services/clustering.py:1](orchcode-file:backend%2Fservices%2Fclustering.py:1)",
      usedEvidenceRefs: ["backend/services/clustering.py:1"],
      unsupportedOrUnclearParts: []
    } as T;
  }

  async generateText(): Promise<string> {
    throw new Error("not used");
  }
}

async function write(root: string, relativePath: string, contents: string) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function createWorkspace() {
  const root = path.join(os.tmpdir(), `orchcode-deep-inspect-audit-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  await write(root, "package.json", JSON.stringify({ name: "audit-retention-system", scripts: { test: "pytest" } }, null, 2));
  await write(root, "frontend/CustomerFeedbackPanel.tsx", [
    "import { useState } from 'react';",
    "",
    "export function CustomerFeedbackPanel() {",
    "  const [feedback, setFeedback] = useState({ submitting: false, label: 'neutral', message: '' });",
    "  async function submitFeedback() {",
    "    setFeedback((state) => ({ ...state, submitting: true }));",
    "    await fetch('/api/customer-feedback', { method: 'POST', body: JSON.stringify(feedback) });",
    "  }",
    "  return <form onSubmit={submitFeedback}><select value={feedback.label}><option>positive</option><option>negative</option><option>neutral</option></select><textarea value={feedback.message} /></form>;",
    "}"
  ].join("\n"));
  await write(root, "backend/services/clustering.py", [
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
  ].join("\n"));
  await write(root, "backend/services/svm_model.py", [
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
    "    predicted_state = svm.predict(features)",
    "    confidence = svm.predict_proba(features).max(axis=1)",
    "    return predicted_state, confidence"
  ].join("\n"));
  await write(root, "backend/services/action_executor.py", [
    "class ActionExecutor:",
    "    low_gap = 0.18",
    "",
    "    def select_action(self, confidence_gap, shap_cosine, retention_score):",
    "        if confidence_gap < self.low_gap:",
    "            return {'status': 'review', 'selected_action_name': 'Human Review', 'action_type': 'manual_review', 'observed_outcome': 'awaiting_feedback'}",
    "        if retention_score > 0.8 and shap_cosine > 0.7:",
    "            return {'status': 'pass', 'selected_action_name': 'Strong Offer', 'action_type': 'retention_offer', 'observed_outcome': 'awaiting_feedback'}",
    "        return {'status': 'pass', 'selected_action_name': 'No Action', 'action_type': 'none'}"
  ].join("\n"));
  await write(root, "backend/services/retraining.py", [
    "import csv",
    "",
    "RETRAINING_LOG_PATH = 'logs/retraining_log.csv'",
    "",
    "def record_retraining_candidate(feedback_label, action_type):",
    "    if feedback_label in {'negative', 'positive'}:",
    "        with open(RETRAINING_LOG_PATH, 'a', newline='') as handle:",
    "            writer = csv.DictWriter(handle, fieldnames=['feedback_label', 'action_type'])",
    "            writer.writerow({'feedback_label': feedback_label, 'action_type': action_type})",
    "        return {'queued': True}",
    "    return {'queued': False}"
  ].join("\n"));
  await write(root, "backend/routes.py", [
    "from fastapi import FastAPI",
    "import csv",
    "from backend.services.clustering import CustomerClusteringService",
    "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
    "from backend.services.action_executor import ActionExecutor",
    "from backend.services.retraining import record_retraining_candidate",
    "",
    "app = FastAPI()",
    "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
    "",
    "@app.post('/train')",
    "def train(payload: dict):",
    "    dbscan_result, fcm_result = CustomerClusteringService().fit(payload['features'], payload['scaler'])",
    "    svm = train_svm_state_detector(dbscan_result['X_clean'], fcm_result['fcm_labels'])",
    "    return {'dbscan_labels': dbscan_result['dbscan_labels'].tolist(), 'svm': str(svm)}",
    "",
    "@app.post('/predict')",
    "def predict(payload: dict):",
    "    predicted_state, confidence = predict_customer_state(payload['features'])",
    "    action = ActionExecutor().select_action(payload['confidence_gap'], payload['shap_cosine'], payload['retention_score'])",
    "    return {'predicted_state': predicted_state.tolist(), 'confidence': confidence.tolist(), 'action': action}",
    "",
    "@app.post('/api/customer-feedback')",
    "def customer_feedback(payload: dict):",
    "    label = payload['label']",
    "    if label not in {'positive', 'negative', 'neutral'}:",
    "        return {'status': 'rejected'}",
    "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
    "        writer = csv.DictWriter(handle, fieldnames=['label', 'message', 'action_type'])",
    "        writer.writerow({'label': label, 'message': payload.get('message', ''), 'action_type': payload.get('action_type', '')})",
    "    retraining = record_retraining_candidate(label, payload.get('action_type', ''))",
    "    return {'status': 'accepted', 'feedback_label': label, 'retraining': retraining}",
    ""
  ].join("\n"));
  await write(root, "tests/test_feedback.py", [
    "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
    "    response = client.post('/api/customer-feedback', json={'label': 'bad'})",
    "    assert response.status_code in (200, 422)"
  ].join("\n"));
  return root;
}

function summarizeAnswer(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 900);
}

async function runPrompt(workspace: string, prompt: string) {
  const tools = new ToolRegistry(workspace);
  const projectMap: ProjectMap = {
    stack: ["Python", "TypeScript"],
    packageManagers: ["npm"],
    testCommands: ["pytest"],
    entryPoints: ["backend/routes.py", "frontend/CustomerFeedbackPanel.tsx"],
    importantFiles: [
      "backend/routes.py",
      "backend/services/clustering.py",
      "backend/services/svm_model.py",
      "backend/services/action_executor.py",
      "backend/services/retraining.py",
      "frontend/CustomerFeedbackPanel.tsx"
    ]
  };
  const report = buildLargeProjectExplainReport({ workspacePath: workspace, message: prompt, projectMap });
  const result = await answerUniversalProjectQuestion({
    provider: new WeakProvider(),
    tools,
    userPrompt: prompt,
    explainReport: report,
    intent: inferWorkspaceIntent(prompt)
  });
  return {
    prompt,
    intent: {
      actionMode: result.intent.actionMode,
      answerGoal: result.intent.answerGoal,
      topicPhrase: result.intent.topicPhrase,
      requiredFacets: result.intent.requiredFacets,
      outputShape: result.intent.outputShape,
      language: result.intent.language
    },
    targetConcept: result.questionUnderstanding.targetConcept,
    requestedFacets: result.questionUnderstanding.requestedFacets,
    literalSearch: result.literalSearch,
    aliasSearch: result.aliasSearch,
    behavioralSearch: result.behavioralSearch.slice(0, 10),
    architecturalPatternSearch: result.architecturalPatternSearch.slice(0, 10),
    openedFiles: result.openedFiles,
    candidateFiles: result.candidateFiles,
    searchIterations: result.searchIterations,
    structuredFacts: {
      inspectedFiles: result.structuredFacts.inspectedFiles,
      hasAlgorithms: Boolean(result.structuredFacts.algorithms?.items?.length),
      hasCodeFlow: Boolean(result.structuredFacts.codeFlow?.steps?.length),
      codeFlowSteps: result.structuredFacts.codeFlow?.steps?.map((step) => ({
        label: step.label,
        sourceRef: step.sourceRef,
        output: step.output,
        nextConsumers: step.nextConsumers
      })) ?? []
    },
    conceptResolution: {
      status: result.conceptResolution.resolutionStatus,
      confidence: result.conceptResolution.confidence,
      direct: result.conceptResolution.directTargetEvidence.map((item) => item.ref).slice(0, 8),
      alias: result.conceptResolution.aliasTargetEvidence.map((item) => item.ref).slice(0, 8),
      behavioral: result.conceptResolution.behavioralTargetEvidence.map((item) => item.ref).slice(0, 8),
      architectural: result.conceptResolution.architecturalPatternEvidence.map((item) => item.ref).slice(0, 8),
      generalCount: result.conceptResolution.generalProjectEvidence.length,
      negative: result.userVisibleNegativeEvidence
    },
    conceptFlow: {
      steps: result.conceptFlow.steps.map((step) => ({
        label: step.label,
        ownerSymbol: step.ownerSymbol,
        outputNames: step.outputNames,
        nextConsumers: step.nextConsumers,
        evidenceRef: step.evidenceRef
      })),
      uncertainties: result.conceptFlow.uncertainties
    },
    mechanism: {
      status: result.mechanismChain.status,
      missingLinks: result.mechanismChain.missingLinks,
      steps: result.mechanismChain.steps.map((step) => ({
        role: step.role,
        label: step.label,
        ownerSymbol: step.ownerSymbol,
        from: step.from,
        to: step.to,
        refs: step.evidenceRefs
      })),
      roles: result.projectIntelligenceGraphSummary.roles,
      expansionTrace: result.mechanismExpansionTrace,
      testEndpointExpectations: result.testEndpointExpectations.map((item) => `${item.path}:${item.line}:${item.endpoint ?? ""}`),
      targetScopedStorage: result.targetScopedStorageEvidence.map((item) => `${item.path}:${item.line}:${item.storageTarget ?? ""}:${item.role}`),
      generalStorage: result.generalStorageEvidence.map((item) => `${item.path}:${item.line}:${item.storageTarget ?? ""}:${item.role}`)
    },
    validationErrors: result.validationErrors,
    fallbackUsed: result.fallbackUsed,
    confidence: result.confidence,
    finalAnswer: summarizeAnswer(result.answerMarkdown)
  };
}

async function main() {
  const workspace = await createWorkspace();
  const prompts = [
    "ازاي الDBSCAN بيتطبق هنا؟ اشرح بالتفصيل",
    "ازاي الfeedback بيتطبق هنا؟ اشرح بالتفصيل",
    "ازاي الouterloop بيتطبق هنا؟ اشرح بالتفصيل",
    "هل فيه inner loop و outer loop هنا؟ الفرق بينهم ايه؟",
    "الفيدباك بيغير ايه في السيستم بعد ما اليوزر يبعت positive او negative او neutral؟"
  ];
  try {
    const results = [];
    for (const prompt of prompts) results.push(await runPrompt(workspace, prompt));
    console.log(JSON.stringify({ workspace, results }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
