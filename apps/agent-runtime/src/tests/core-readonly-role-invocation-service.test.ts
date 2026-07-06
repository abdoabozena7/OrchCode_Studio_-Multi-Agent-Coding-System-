import assert from "node:assert/strict";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import type { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { CoreReadOnlyRoleInvocationService, normalizeProviderReadOnlyOutput } from "../orchestration/CoreReadOnlyRoleInvocationService.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentInvocation,
  type ContextPack,
  type Run,
  type Task
} from "../orchestration/OrchestrationModels.js";

test("CoreReadOnlyRoleInvocationService uses provider output without accepting file changes", async () => {
  const fixture = createFixture();
  const artifactStore = fakeArtifactStore();
  const provider = new ReadOnlyProvider({
    summary: "Provider inspected context.",
    status: "succeeded",
    files_changed: ["src/should-not-count.ts"],
    validation_results: [{ command: "npm test", status: "not_run", summary: "not run" }],
    artifacts: ["provider-artifact.json"],
    limitations: ["limited evidence"],
    next_recommendations: ["continue"],
    intent_alignment: { task_slice_id: "slice-1" }
  });

  const output = await new CoreReadOnlyRoleInvocationService(artifactStore.asStore, () => provider)
    .invoke(fixture);

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.context && typeof provider.calls[0].context === "object", true);
  assert.equal(output.summary, "Provider inspected context.");
  assert.deepEqual(output.files_changed, []);
  assert.deepEqual(output.artifacts, ["provider-artifact.json", "raw-invocation-1"]);
  assert.equal(output.limitations.some((entry) => /Provider-backed read-only ScoutAgent/i.test(entry)), true);
  assert.equal(fixture.invocation.raw_output_ref, "raw-invocation-1");
  assert.equal(artifactStore.rawWrites.length, 1);
});

test("CoreReadOnlyRoleInvocationService rejects missing providers instead of using a local fallback", async () => {
  const fixture = createFixture();

  await assert.rejects(
    () => new CoreReadOnlyRoleInvocationService(fakeArtifactStore().asStore).invoke(fixture),
    /provider_required_for_readonly_worker:ScoutAgent/
  );
});

test("normalizeProviderReadOnlyOutput turns malformed provider output into failed structured output", () => {
  const output = normalizeProviderReadOnlyOutput("not json");

  assert.equal(output.status, "failed");
  assert.deepEqual(output.files_changed, []);
  assert.equal(output.limitations.some((entry) => /no deterministic fallback/i.test(entry)), true);
});

function createFixture() {
  const run = fakeRun();
  const task = fakeTask(run.id);
  const pack = fakePack(run.id, task.id);
  const invocation = fakeInvocation(run.id, task.id);
  return { run, task, pack, invocation };
}

function fakeRun(): Run {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run-readonly",
    user_request: "Inspect project",
    status: "executing",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_task_ids: ["task-readonly"],
    memory_snapshot_ref: ".agent_memory/repo_index.json",
    artifacts_path: ".agent_memory/runs/run-readonly",
    config: {
      workspace_path: "D:/fixture",
      memory_dir: ".agent_memory",
      max_context_files: 4,
      max_context_chars: 4000,
      max_task_attempts: 1,
      provider_mode: "real_provider"
    }
  };
}

function fakeTask(runId: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "task-readonly",
    run_id: runId,
    title: "Scout",
    objective: "Inspect project",
    role_required: "ScoutAgent",
    status: "running",
    dependencies: [],
    relevant_files: ["src/app.ts"],
    allowed_files_to_edit: [],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 1,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function fakePack(runId: string, taskId: string): ContextPack {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: `context-${taskId}`,
    run_id: runId,
    task_id: taskId,
    objective: "Inspect project",
    relevant_files: ["src/app.ts"],
    snippets: [],
    repo_index_refs: ["repo-index"],
    constraints: [],
    allowed_files_to_edit: [],
    forbidden_files: [],
    target_mechanism_chain: [],
    confirmed_relevant_files: ["src/app.ts"],
    missing_evidence_links: [],
    safe_edit_surface: [],
    previous_decisions: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_requirements: ["npm test"],
    approximate_size: 100,
    warnings: ["fixture warning"]
  };
}

function fakeInvocation(runId: string, taskId: string): AgentInvocation {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "invocation-1",
    run_id: runId,
    task_id: taskId,
    role: "ScoutAgent",
    prompt: "Inspect project",
    context_pack_ref: "context/task-readonly.json",
    started_at: new Date().toISOString(),
    status: "running"
  };
}

function fakeArtifactStore() {
  const rawWrites: unknown[] = [];
  const asStore = {
    async saveRawOutput(_runId: string, id: string, value: unknown) {
      rawWrites.push(value);
      return `raw-${id}`;
    }
  } as unknown as OrchestrationArtifactStore;
  return { asStore, rawWrites };
}

class ReadOnlyProvider implements LlmProvider {
  readonly calls: LlmRequest[] = [];

  constructor(private readonly output: unknown) {}

  async generateStructured<T>(input: LlmRequest): Promise<T> {
    this.calls.push(input);
    return this.output as T;
  }

  async generateText(): Promise<string> {
    return "";
  }
}
