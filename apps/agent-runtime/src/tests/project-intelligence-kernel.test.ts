import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProjectIntelligenceGraph, resolveMechanismChain, validateMechanismCoverage } from "../runtime/ProjectIntelligenceKernel.js";
import { WorkspaceTools } from "../tools/WorkspaceTools.js";

async function createWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

test("ProjectIntelligenceKernel treats feedback UI state as partial mechanism only", async () => {
  const workspace = await createWorkspace("intelligence-ui-feedback");
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

    const tools = new WorkspaceTools(workspace);
    const files = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const graph = buildProjectIntelligenceGraph({
      targetConcept: "feedback",
      filePaths: files,
      readFile: (file) => tools.readWholeFile(file)
    });
    const chain = resolveMechanismChain(graph, "feedback");

    assert.equal(chain.status, "partial");
    assert.ok(graph.evidence.some((item) => item.role === "ui_state"));
    assert.ok(chain.missingLinks.includes("frontend_to_backend_request"));
    assert.ok(chain.missingLinks.includes("backend_feedback_handler"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIntelligenceKernel links feedback frontend, API, backend, and log writer", async () => {
  const workspace = await createWorkspace("intelligence-full-feedback");
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
        "",
        "app = FastAPI()",
        "CUSTOMER_FEEDBACK_LOG_PATH = 'logs/customer_feedback_log.csv'",
        "RETRAINING_LOG_PATH = 'logs/retraining_log.csv'",
        "",
        "@app.post('/api/customer-feedback')",
        "def receive_customer_feedback(payload: dict):",
        "    with open(CUSTOMER_FEEDBACK_LOG_PATH, 'a', newline='') as handle:",
        "        writer = csv.DictWriter(handle, fieldnames=['message'])",
        "        writer.writerow({'message': payload.get('message', '')})",
        "    observed_outcome = 'awaiting_feedback'",
        "    return {'ok': True, 'outcome': observed_outcome}"
      ].join("\n"),
      "utf8"
    );

    const tools = new WorkspaceTools(workspace);
    const files = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const graph = buildProjectIntelligenceGraph({
      targetConcept: "feedback",
      filePaths: files,
      readFile: (file) => tools.readWholeFile(file)
    });
    const chain = resolveMechanismChain(graph, "feedback");

    assert.equal(chain.status, "confirmed");
    assert.ok(graph.evidence.some((item) => item.role === "api_client_call" && item.endpoint === "/api/customer-feedback"));
    assert.ok(graph.evidence.some((item) => item.role === "backend_route" && item.endpoint === "/api/customer-feedback"));
    assert.ok(graph.evidence.some((item) => item.role === "log_append" || item.role === "storage_write"));
    assert.ok(graph.evidence.some((item) => item.role === "lifecycle_status"));
    assert.ok(chain.steps.some((step) => step.ownerSymbol === "submitFeedback"));
    assert.ok(chain.steps.some((step) => step.to === "CUSTOMER_FEEDBACK_LOG_PATH"));
    assert.ok(!chain.missingLinks.includes("backend_feedback_handler"));
    assert.ok(graph.graphExpansionTrace.some((item) => item.includes("/api/customer-feedback")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIntelligenceKernel treats test endpoint calls as expectations, not frontend clients", async () => {
  const workspace = await createWorkspace("intelligence-feedback-test-endpoint");
  try {
    await mkdir(path.join(workspace, "tests"), { recursive: true });
    await writeFile(
      path.join(workspace, "tests", "test_feedback.py"),
      [
        "def test_customer_feedback_endpoint_rejects_invalid_label(client):",
        "    response = client.post('/api/customer-feedback', json={'label': 'bad'})",
        "    assert response.status_code == 422"
      ].join("\n"),
      "utf8"
    );

    const tools = new WorkspaceTools(workspace);
    const files = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const graph = buildProjectIntelligenceGraph({
      targetConcept: "feedback",
      filePaths: files,
      readFile: (file) => tools.readWholeFile(file)
    });
    const chain = resolveMechanismChain(graph, "feedback");

    assert.equal(chain.status, "partial");
    assert.ok(graph.evidence.some((item) => item.role === "test_endpoint_expectation" && item.endpoint === "/api/customer-feedback"));
    assert.ok(graph.evidence.every((item) => item.role !== "api_client_call"));
    assert.ok(chain.missingLinks.includes("frontend_to_backend_request"));
    assert.ok(chain.missingLinks.includes("backend_feedback_handler"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIntelligenceKernel keeps general dataset storage out of feedback storage", async () => {
  const workspace = await createWorkspace("intelligence-feedback-general-storage");
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

    const tools = new WorkspaceTools(workspace);
    const files = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const graph = buildProjectIntelligenceGraph({
      targetConcept: "feedback",
      filePaths: files,
      readFile: (file) => tools.readWholeFile(file)
    });
    const chain = resolveMechanismChain(graph, "feedback");

    assert.notEqual(chain.status, "confirmed");
    assert.ok(graph.generalStorageEvidence.some((item) => item.storageTarget === "CUSTOMERS_PATH"));
    assert.ok(graph.targetScopedStorageEvidence.every((item) => item.storageTarget !== "CUSTOMERS_PATH"));
    assert.ok(chain.missingLinks.includes("feedback_storage_or_log_usage"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectIntelligenceKernel validation rejects audit labels and status-only proof", async () => {
  const workspace = await createWorkspace("intelligence-status-feedback");
  try {
    await mkdir(path.join(workspace, "backend"), { recursive: true });
    await writeFile(
      path.join(workspace, "backend", "actions.py"),
      [
        "def plan_action():",
        "    observed_outcome = 'awaiting_feedback'",
        "    return {'status': observed_outcome}"
      ].join("\n"),
      "utf8"
    );

    const tools = new WorkspaceTools(workspace);
    const files = tools.listFiles(100).filter((file) => !file.isDir).map((file) => file.path);
    const graph = buildProjectIntelligenceGraph({
      targetConcept: "feedback",
      filePaths: files,
      readFile: (file) => tools.readWholeFile(file)
    });
    const chain = resolveMechanismChain(graph, "feedback");
    const validation = validateMechanismCoverage({
      targetConcept: "feedback",
      graph,
      mechanismChain: chain,
      answerMarkdown: "feedback is implemented through ui_state and backend_route"
    });

    assert.equal(chain.status, "partial");
    assert.ok(graph.evidence.every((item) => item.role !== "backend_route"));
    assert.ok(validation.errors.some((item) => item.includes("audit/debug")));
    assert.ok(validation.warnings.some((item) => item.includes("lifecycle/status")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
