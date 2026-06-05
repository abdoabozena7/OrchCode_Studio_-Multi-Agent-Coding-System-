import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runInspectExplainReadLanes,
  validateAnswerAgainstReadLaneEvidence
} from "../runtime/InspectExplainReadLanes.js";
import { WorkspaceTools } from "../tools/WorkspaceTools.js";

async function createWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function runFor(workspace: string, prompt: string, targetConcept: string) {
  const tools = new WorkspaceTools(workspace);
  const filePaths = tools.listFiles(1_000).filter((file) => !file.isDir).map((file) => file.path);
  return runInspectExplainReadLanes({
    userPrompt: prompt,
    targetConcept,
    topic: "code_flow",
    filePaths,
    readFile: (relativePath) => tools.readWholeFile(relativePath)
  });
}

test("InspectExplainReadLanes builds separate artifacts for confirmed feedback flow", async () => {
  const workspace = await createWorkspace("read-lanes-feedback-full");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ label: 'neutral', message: '', submitting: false });",
        "  async function submitFeedback() {",
        "    setFeedback((state) => ({ ...state, submitting: true }));",
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
        "from backend.services.retraining import record_retraining_candidate",
        "app = FastAPI()",
        "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
        "@app.post('/api/customer-feedback')",
        "def receive_customer_feedback(payload: dict):",
        "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
        "        writer = csv.DictWriter(handle, fieldnames=['label', 'message'])",
        "        writer.writerow({'label': payload.get('label'), 'message': payload.get('message', '')})",
        "    return record_retraining_candidate(payload.get('customer_id'), payload.get('label'))"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "services", "retraining.py"),
      [
        "RETRAINING_LOG_PATH = 'logs/retraining_log.csv'",
        "def record_retraining_candidate(customer_id, feedback_label):",
        "    return {'queued_for_retraining': True, 'feedback_label': feedback_label}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "tests", "test_feedback.py"),
      "def test_feedback_endpoint(client):\n    assert client.post('/api/customer-feedback', json={'label': 'positive'}).status_code == 200\n",
      "utf8"
    );

    const run = runFor(workspace, "How is feedback applied here?", "feedback");
    const frontend = run.artifacts.find((artifact) => artifact.lane === "frontend");
    const api = run.artifacts.find((artifact) => artifact.lane === "api");
    const storage = run.artifacts.find((artifact) => artifact.lane === "storage");
    const tests = run.artifacts.find((artifact) => artifact.lane === "tests");

    assert.equal(run.artifacts.length, 6);
    assert.ok(frontend?.findings.some((finding) => finding.role === "ui_event_handler"));
    assert.ok(frontend?.findings.some((finding) => finding.role === "api_client_call" && finding.endpoint === "/api/customer-feedback"));
    assert.ok(api?.findings.some((finding) => finding.role === "backend_route" && finding.endpoint === "/api/customer-feedback"));
    assert.ok(storage?.findings.some((finding) => (finding.role === "log_append" || finding.role === "storage_write") && finding.storageTarget === "CUSTOMER_FEEDBACK_LOG_PATH"));
    assert.ok(tests?.findings.some((finding) => finding.role === "test_endpoint_expectation" && finding.endpoint === "/api/customer-feedback"));
    assert.equal(run.synthesizedGraph.status, "confirmed");
    assert.ok(run.synthesizedGraph.provenLinks.includes("frontend_to_api"));
    assert.ok(run.synthesizedGraph.provenLinks.includes("api_to_backend"));
    assert.ok(run.synthesizedGraph.provenLinks.includes("backend_to_storage"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("WorkspaceTools listFiles and project summary ignore memory/runtime artifacts", async () => {
  const workspace = await createWorkspace("workspace-tools-artifacts");
  try {
    await mkdir(path.join(workspace, ".agent_memory"), { recursive: true });
    await mkdir(path.join(workspace, ".hivo-agent-runtime"), { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(path.join(workspace, ".agent_memory", "README.md"), "# Saved memory\n", "utf8");
    await writeFile(path.join(workspace, ".hivo-agent-runtime", "sessions.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "backend", "main.py"), "print('real project')\n", "utf8");
    await writeFile(path.join(workspace, "README.md"), "# Real project\n", "utf8");

    const tools = new WorkspaceTools(workspace);
    const listed = tools.listFiles(100).map((file) => file.path);
    const summary = tools.getProjectSummary();

    assert.equal(listed.some((file) => file.startsWith(".agent_memory/")), false);
    assert.equal(listed.some((file) => file.startsWith(".hivo-agent-runtime/")), false);
    assert.equal(listed.includes("backend/main.py"), true);
    assert.equal(summary.importantFiles.includes(".agent_memory/README.md"), false);
    assert.equal(summary.importantFiles.includes("README.md"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Large project explain inventory ignores memory artifacts even for artifact questions", async () => {
  const workspace = await createWorkspace("project-explain-artifacts");
  try {
    await mkdir(path.join(workspace, ".agent_memory"), { recursive: true });
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(path.join(workspace, ".agent_memory", "README.md"), "# Saved answer\n", "utf8");
    await writeFile(
      path.join(workspace, "backend", "main.py"),
      "MODEL_PATH = 'models/model.pkl'\nLOG_PATH = 'logs/runtime.log'\n",
      "utf8"
    );

    const tools = new WorkspaceTools(workspace);
    const filePaths = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const run = runInspectExplainReadLanes({
      userPrompt: "What files produce artifacts like models/data/logs?",
      targetConcept: "artifact",
      topic: "code_flow",
      filePaths,
      readFile: (relativePath) => tools.readWholeFile(relativePath)
    });

    const artifactPaths = run.artifacts.flatMap((artifact) => [
      ...artifact.inspectedFiles,
      ...artifact.findings.map((finding) => finding.path),
      ...artifact.rejectedEvidence.map((finding) => finding.path)
    ]);
    assert.equal(filePaths.some((file) => file.startsWith(".agent_memory/")), false);
    assert.equal(artifactPaths.some((file) => file.startsWith(".agent_memory/")), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("InspectExplainReadLanes downgrades UI-only feedback instead of proving backend flow", async () => {
  const workspace = await createWorkspace("read-lanes-feedback-ui-only");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(
      path.join(workspace, "frontend", "CustomerFeedbackPanel.tsx"),
      [
        "import { useState } from 'react';",
        "export function CustomerFeedbackPanel() {",
        "  const [feedback, setFeedback] = useState({ label: 'neutral', message: '' });",
        "  return <form><textarea value={feedback.message} /></form>;",
        "}"
      ].join("\n"),
      "utf8"
    );

    const run = runFor(workspace, "How is feedback applied here?", "feedback");
    const frontend = run.artifacts.find((artifact) => artifact.lane === "frontend");
    const validation = validateAnswerAgainstReadLaneEvidence({
      answerMarkdown: "Feedback is fully wired end-to-end, submitted to the backend, and stored.",
      targetConcept: "feedback",
      readLaneRun: run
    });

    assert.equal(run.synthesizedGraph.status, "partial");
    assert.ok(frontend?.missingLinks.includes("frontend_to_backend_request"));
    assert.ok(run.synthesizedGraph.missingLinks.includes("frontend_to_backend_request"));
    assert.ok(validation.errors.some((error) => /end-to-end/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("InspectExplainReadLanes rejects tests as production frontend flow", async () => {
  const workspace = await createWorkspace("read-lanes-feedback-test-only");
  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "test_feedback.py"),
      "def test_feedback_endpoint(client):\n    response = client.post('/api/customer-feedback', json={'label': 'negative'})\n    assert response.status_code == 200\n",
      "utf8"
    );

    const run = runFor(workspace, "How is feedback applied here?", "feedback");
    const validation = validateAnswerAgainstReadLaneEvidence({
      answerMarkdown: "The frontend client submits feedback to /api/customer-feedback.",
      targetConcept: "feedback",
      readLaneRun: run
    });

    assert.equal(run.synthesizedGraph.status, "partial");
    assert.ok(run.evidenceReview.rejectedClaims.some((claim) => claim.rule === "tests_are_not_frontend_flow"));
    assert.ok(validation.errors.some((error) => /test endpoint/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("InspectExplainReadLanes rejects general storage as feedback persistence", async () => {
  const workspace = await createWorkspace("read-lanes-general-storage");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "data_generator.py"),
      [
        "CUSTOMERS_PATH = 'data/generated_customers.csv'",
        "def save_dataset(customers_df):",
        "    customers_df.to_csv(CUSTOMERS_PATH, index=False)",
        "    return CUSTOMERS_PATH"
      ].join("\n"),
      "utf8"
    );

    const run = runFor(workspace, "How is feedback applied here?", "feedback");
    const storage = run.artifacts.find((artifact) => artifact.lane === "storage");
    const validation = validateAnswerAgainstReadLaneEvidence({
      answerMarkdown: "CUSTOMERS_PATH proves feedback is stored in a log.",
      targetConcept: "feedback",
      readLaneRun: run
    });

    assert.ok(storage?.rejectedEvidence.some((finding) => finding.role === "general_storage" && finding.storageTarget === "CUSTOMERS_PATH"));
    assert.ok(run.evidenceReview.rejectedClaims.some((claim) => claim.rule === "general_storage_not_target_storage"));
    assert.ok(validation.errors.some((error) => /general storage/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("InspectExplainReadLanes rejects CSS-only page evidence", async () => {
  const workspace = await createWorkspace("read-lanes-css-page");
  try {
    await mkdir(path.join(workspace, "frontend"), { recursive: true });
    await writeFile(path.join(workspace, "frontend", "styles.css"), ".customers-page { display: grid; }\n", "utf8");

    const run = runFor(workspace, "How many pages are here?", "page");
    const frontend = run.artifacts.find((artifact) => artifact.lane === "frontend");
    const validation = validateAnswerAgainstReadLaneEvidence({
      answerMarkdown: "The CSS stylesheet defines a page/screen called customers.",
      targetConcept: "page",
      readLaneRun: run
    });

    assert.ok(frontend?.rejectedEvidence.some((finding) => finding.role === "unrelated_name_match"));
    assert.ok(run.evidenceReview.rejectedClaims.some((claim) => claim.rule === "style_is_not_page_structure"));
    assert.ok(validation.errors.some((error) => /CSS\/style\/title-only/i.test(error)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("InspectExplainReadLanes does not promote generic training routes into an outerloop", async () => {
  const workspace = await createWorkspace("read-lanes-generic-ml-not-outerloop");
  try {
    await mkdir(path.join(workspace, "backend", "services"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "services", "svm_model.py"),
      [
        "from sklearn.svm import SVC",
        "import joblib",
        "def train_svm_state_detector(features, labels):",
        "    svm = SVC(probability=True)",
        "    svm.fit(features, labels)",
        "    joblib.dump(svm, 'artifacts/svm.joblib')",
        "    return svm",
        "def predict_customer_state(features):",
        "    svm = joblib.load('artifacts/svm.joblib')",
        "    return svm.predict(features)"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "backend", "routes.py"),
      [
        "from fastapi import FastAPI",
        "from backend.services.svm_model import train_svm_state_detector, predict_customer_state",
        "app = FastAPI()",
        "@app.post('/train')",
        "def train(payload: dict):",
        "    return {'model': str(train_svm_state_detector(payload['features'], payload['labels']))}",
        "@app.post('/predict')",
        "def predict(payload: dict):",
        "    return {'state': predict_customer_state(payload['features']).tolist()}"
      ].join("\n"),
      "utf8"
    );

    const run = runFor(workspace, "How is outerloop applied here?", "outerloop");

    assert.equal(run.synthesizedGraph.status, "not_found");
    assert.equal(run.synthesizedGraph.provenLinks.includes("feedback_or_outcome_stage"), false);
    assert.equal(run.synthesizedGraph.provenLinks.includes("state_log_or_retraining_update"), false);
    assert.ok(run.synthesizedGraph.missingLinks.includes("feedback_or_outcome_stage"));
    assert.ok(run.synthesizedGraph.missingLinks.includes("state_log_or_retraining_update"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
