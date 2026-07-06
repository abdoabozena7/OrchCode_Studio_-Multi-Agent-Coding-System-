import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeSession } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { CoreExecutorInvocationService } from "../orchestration/CoreExecutorInvocationService.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentInvocation,
  type ContextPack,
  type Run,
  type Task
} from "../orchestration/OrchestrationModels.js";
import type { DequeueResult, EnqueueJobInput, QueueJobStatus } from "../orchestration/TaskQueueTypes.js";
import type { SessionManager } from "../runtime/SessionManager.js";

test("CoreExecutorInvocationService acknowledges successful executor queue work", async () => {
  const fixture = createFixture();
  const queue = fakeQueue();
  const artifactStore = fakeArtifactStore();
  const service = new CoreExecutorInvocationService(
    fixture.workspace,
    artifactStore.asStore,
    { max_attempts_per_task: 2 },
    () => fakeProvider(),
    {
      createQueue: () => queue.asQueue,
      createSessionManager: () => fakeSessionManager(),
      runSeniorAgent: async () => seniorSession(["src/app.ts"])
    }
  );

  const output = await service.invoke(fixture);

  assert.equal(queue.enqueued[0]?.queue_name, `executor:${fixture.run.id}`);
  assert.equal(queue.enqueued[0]?.max_attempts, 2);
  assert.deepEqual(queue.acked, [{ jobId: "job-1", leaseId: "lease-1" }]);
  assert.deepEqual(queue.nacked, []);
  assert.equal(queue.closed, true);
  assert.equal(output.status, "succeeded");
  assert.deepEqual(output.files_changed, ["src/app.ts"]);
  assert.equal(output.validation_results.some((result) => result.command === "npm test"), true);
  assert.equal(fixture.invocation.raw_output_ref, "raw-invocation-1-2");
});

test("CoreExecutorInvocationService nacks queued executor work when provider is missing", async () => {
  const fixture = createFixture();
  const queue = fakeQueue();
  const artifactStore = fakeArtifactStore();
  const service = new CoreExecutorInvocationService(
    fixture.workspace,
    artifactStore.asStore,
    { max_attempts_per_task: 1 },
    undefined,
    {
      createQueue: () => queue.asQueue,
      createSessionManager: () => fakeSessionManager(),
      runSeniorAgent: async () => seniorSession([])
    }
  );

  await assert.rejects(() => service.invoke(fixture), /provider_required_for_executor:ExecutorAgent/);

  assert.deepEqual(queue.acked, []);
  assert.deepEqual(queue.nacked, [{ jobId: "job-1", leaseId: "lease-1", reason: "No provider available" }]);
  assert.equal(queue.closed, true);
});

test("CoreExecutorInvocationService preserves out-of-scope patch failure semantics", async () => {
  const fixture = createFixture();
  const queue = fakeQueue();
  const artifactStore = fakeArtifactStore();
  const service = new CoreExecutorInvocationService(
    fixture.workspace,
    artifactStore.asStore,
    { max_attempts_per_task: 1 },
    () => fakeProvider(),
    {
      createQueue: () => queue.asQueue,
      createSessionManager: () => fakeSessionManager(),
      runSeniorAgent: async () => seniorSession(["src/other.ts"])
    }
  );

  const output = await service.invoke(fixture);

  assert.equal(output.status, "failed");
  assert.deepEqual(output.files_changed, ["src/other.ts"]);
  assert.equal(output.limitations.some((entry) => /outside allowed scope/.test(entry)), true);
  assert.deepEqual(queue.acked, [{ jobId: "job-1", leaseId: "lease-1" }]);
});

function createFixture() {
  const workspace = "D:/fixture";
  const run = fakeRun(workspace);
  const task = fakeTask(run.id);
  const pack = fakePack(run.id, task.id);
  const invocation = fakeInvocation(run.id, task.id);
  return { workspace, run, task, pack, invocation };
}

function fakeRun(workspace: string): Run {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run-1",
    user_request: "Implement feature",
    status: "executing",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    root_task_ids: ["task-1"],
    memory_snapshot_ref: `${workspace}/.agent_memory/repo_index.json`,
    artifacts_path: `${workspace}/.agent_memory/runs/run-1`,
    config: {
      workspace_path: workspace,
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
    id: "task-1",
    run_id: runId,
    title: "Implement feature",
    objective: "Implement feature",
    role_required: "ExecutorAgent",
    status: "running",
    dependencies: [],
    relevant_files: ["src/app.ts"],
    allowed_files_to_edit: ["src/app.ts"],
    forbidden_files: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: ["npm test"],
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
    objective: "Implement feature",
    relevant_files: ["src/app.ts"],
    snippets: [],
    repo_index_refs: [],
    constraints: [],
    allowed_files_to_edit: ["src/app.ts"],
    forbidden_files: [],
    target_mechanism_chain: [],
    confirmed_relevant_files: ["src/app.ts"],
    missing_evidence_links: [],
    safe_edit_surface: ["src/app.ts"],
    previous_decisions: [],
    expected_output_schema: "ParsedAgentOutput",
    validation_requirements: ["npm test"],
    approximate_size: 120,
    warnings: []
  };
}

function fakeInvocation(runId: string, taskId: string): AgentInvocation {
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "invocation-1",
    run_id: runId,
    task_id: taskId,
    role: "ExecutorAgent",
    prompt: "Implement feature",
    context_pack_ref: "context/task-1.json",
    started_at: new Date().toISOString(),
    status: "running"
  };
}

function fakeArtifactStore() {
  let rawWrites = 0;
  const asStore = {
    async saveRawOutput(_runId: string, id: string) {
      rawWrites += 1;
      return `raw-${id}-${rawWrites}`;
    }
  } as unknown as OrchestrationArtifactStore;
  return { asStore };
}

function fakeQueue() {
  const enqueued: EnqueueJobInput[] = [];
  const acked: Array<{ jobId: string; leaseId: string }> = [];
  const nacked: Array<{ jobId: string; leaseId: string; reason?: string }> = [];
  let closed = false;
  const asQueue = {
    async enqueue(input: EnqueueJobInput) {
      enqueued.push(input);
      return "job-1";
    },
    async dequeue(): Promise<DequeueResult> {
      return {
        job: {
          id: "job-1",
          queue_name: "executor:run-1",
          job_type: "agent_task",
          payload_json: "{}",
          status: "leased",
          priority: 3,
          attempt_count: 1,
          max_attempts: 1,
          lease_id: "lease-1",
          lease_expires_at: null,
          dead_letter_reason: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          scheduled_at: null,
          completed_at: null
        },
        lease_id: "lease-1"
      };
    },
    async ack(jobId: string, leaseId: string) {
      acked.push({ jobId, leaseId });
    },
    async nack(jobId: string, leaseId: string, reason?: string): Promise<QueueJobStatus> {
      nacked.push({ jobId, leaseId, reason });
      return "queued";
    },
    close() {
      closed = true;
    }
  };
  return {
    asQueue,
    enqueued,
    acked,
    nacked,
    get closed() {
      return closed;
    }
  };
}

function fakeSessionManager() {
  return {
    async load() {
      return undefined;
    },
    async createSession() {
      return { id: "nested-session" };
    }
  } as unknown as SessionManager;
}

function fakeProvider(): LlmProvider {
  return {
    async generateStructured<T>() {
      return {} as T;
    },
    async generateText() {
      return "";
    }
  };
}

function seniorSession(filesChanged: string[]): AgentRuntimeSession {
  return {
    id: "nested-session",
    mode: "real_provider",
    status: "idle",
    patchProposals: filesChanged.map((file) => ({
      id: `patch-${file}`,
      filesChanged: [{ path: file }]
    })),
    commandRequests: [{ command: "npm test", risk: "low" }],
    reasoningSummaries: ["Implemented feature"],
    runSummary: { summary: "Implemented feature" },
    nextAction: { message: "Review executor output" }
  } as unknown as AgentRuntimeSession;
}
