import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreRunLifecycleService,
  CoreStructuredOutputValidationService,
  FactoryTraceWriter,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  loadOrchestrationConfig,
  type ParsedAgentOutput,
  type Task,
  type CodePatchProposal
} from "../orchestration/index.js";

test("CoreStructuredOutputValidationService repairs invalid parsed output and records artifacts", async () => {
  const fixture = await createFixture("structured-output-repair");
  try {
    const run = await fixture.createRun("Repair invalid parsed output.");
    const task = fakeTask(run.id, "ExecutorAgent");

    const repaired = await fixture.service.validateParsedAgentOutput(run, task, { summary: "" } as ParsedAgentOutput);

    assert.equal(repaired.status, "failed");
    assert.match(repaired.summary, /^Invalid parsed output:/);
    assert.equal(repaired.artifacts.length, 2);
    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_validation_failed"), true);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_repaired"), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreStructuredOutputValidationService records ScoutResult artifacts for ScoutAgent output", async () => {
  const fixture = await createFixture("structured-output-scout");
  try {
    const run = await fixture.createRun("Record scout output.");
    const task = fakeTask(run.id, "ScoutAgent");
    const output = fakeOutput();

    await fixture.service.recordRoleSpecificStructuredOutput(run, task, output);

    assert.equal(output.artifacts.length, 1);
    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_parsed" && isRecord(event.payload) && event.payload.schema === "ScoutResult"), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

test("CoreStructuredOutputValidationService repairs invalid patch proposals", async () => {
  const fixture = await createFixture("structured-output-patch");
  try {
    const run = await fixture.createRun("Repair patch proposal.");
    const task = fakeTask(run.id, "ExecutorAgent");

    const repaired = await fixture.service.validateCodePatchProposal(run, task, {
      task_id: task.id,
      summary: "Update auth.",
      files_to_modify: ["src/auth.ts"]
    } as CodePatchProposal);

    assert.equal(repaired.task_id, task.id);
    assert.equal(repaired.summary, "Update auth.");
    assert.deepEqual(repaired.files_to_modify, ["src/auth.ts"]);
    assert.equal(repaired.patch_or_diff, "");
    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_validation_failed"), true);
    assert.equal(events.some((event) => isRecord(event) && event.type === "agent.output_repaired"), true);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = await fixtureWorkspace(prefix);
  const store = new OrchestrationArtifactStore(workspace);
  const traceWriter = new FactoryTraceWriter({
    workspacePath: workspace,
    sourceComponent: "CoreStructuredOutputValidationServiceTest"
  });
  const lifecycle = new CoreRunLifecycleService(store, traceWriter, "CoreStructuredOutputValidationServiceTest");
  const service = new CoreStructuredOutputValidationService(store);
  return {
    workspace,
    store,
    service,
    createRun: (userRequest: string) => lifecycle.createRun({
      userRequest,
      workspacePath: workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({}),
      maxContextFiles: 4,
      maxContextChars: 4000,
      maxTaskAttempts: 2
    })
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "auth.ts"), "export const auth = true;\n", "utf8");
  return root;
}

function fakeTask(runId: string, role: Task["role_required"]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: `task_${role.toLowerCase()}`,
    run_id: runId,
    title: "Validate output",
    objective: "Validate structured output.",
    role_required: role,
    status: "pending",
    dependencies: [],
    relevant_files: ["src/auth.ts"],
    allowed_files_to_edit: role === "ExecutorAgent" ? ["src/auth.ts"] : [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 2,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function fakeOutput(): ParsedAgentOutput {
  return {
    summary: "Found auth entrypoint.",
    status: "succeeded",
    files_changed: [],
    validation_results: [{ command: "npm run test", status: "passed", summary: "Passed." }],
    artifacts: [],
    limitations: [],
    next_recommendations: ["Continue."]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
