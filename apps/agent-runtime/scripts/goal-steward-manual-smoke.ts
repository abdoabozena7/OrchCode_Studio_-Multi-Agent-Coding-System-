import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LlmProvider, LlmRequest } from "../src/llm/LlmProvider.js";
import {
  IntegrationManager,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  ProjectGoalSpecStore,
  createProjectGoalSpec,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../src/orchestration/index.js";

class FakeGoalProvider implements LlmProvider {
  constructor(private readonly response: unknown) {}

  async generateStructured<T>(_input: LlmRequest, _schema: unknown): Promise<T> {
    return this.response as T;
  }

  async generateText(_input: LlmRequest): Promise<string> {
    return "";
  }
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "hivo-goal-steward-smoke-"));
await mkdir(path.join(workspace, "src"), { recursive: true });
await writeFile(path.join(workspace, "src", "gameplay.ts"), "export const gravity = 0.6;\n", "utf8");

const spec = await new ProjectGoalSpecStore({ workspacePath: workspace }).saveProjectGoalSpec(createProjectGoalSpec({
  title: "Arcade Physics Goal",
  primary_goal: "The game should feel playful and arcade-like, not physically realistic.",
  non_goals: ["Do not optimize physics for real-world accuracy."],
  tradeoffs: [{ name: "physics feel", prefer: "fun low gravity", over: "realistic gravity" }],
  constraints: ["Favor playful gravity over realism."],
  accepted_examples: ["Reduce gravity to make jumps feel fun."],
  rejected_examples: ["Increase gravity to match real-world physics."],
  source_refs: [],
  version: 1,
  status: "active"
}));

const alignedRun = fakeRun("manual_goal_aligned");
const alignedTask = fakeTask(alignedRun.id, "task_arcade_gravity", "Reduce gravity to make jumps more fun.");
const alignedOutput = await acceptedOutput(workspace, alignedRun, alignedTask);
const alignedResult = await manager(workspace, {
  status: "aligned",
  rationale: "The candidate follows the arcade physics spec.",
  findings: []
}).integrate({ run: alignedRun, tasks: [alignedTask], parsedOutputs: [alignedOutput] });

const conflictRun = fakeRun("manual_goal_conflict");
const conflictTask = fakeTask(conflictRun.id, "task_realistic_gravity", "Increase gravity to match real-world physics.");
const conflictOutput = await acceptedOutput(workspace, conflictRun, conflictTask);
const conflictResult = await manager(workspace, {
  status: "conflicts_with_spec",
  rationale: "The candidate optimizes physical realism despite the arcade spec.",
  findings: [{
    candidate_id: "integration_candidate_task_realistic_gravity",
    task_id: conflictTask.id,
    finding_type: "conflicts_with_spec",
    severity: "blocking",
    rationale: "Increasing gravity for realism contradicts the active ProjectGoalSpec.",
    recommended_action: "block_integration"
  }]
}).integrate({ run: conflictRun, tasks: [conflictTask], parsedOutputs: [conflictOutput] });

assert.equal(alignedResult.status, "passed");
assert.equal(conflictResult.status, "blocked");
assert.ok(conflictResult.conflicts.some((conflict) => conflict.conflict_type === "goal_spec_conflict"));

console.log(JSON.stringify({
  workspace,
  spec_ref: spec.artifact_ref,
  aligned: {
    status: alignedResult.status,
    goal_alignment_status: alignedResult.metadata_json.goal_alignment_status,
    result_ref: alignedResult.artifact_ref
  },
  conflict: {
    status: conflictResult.status,
    conflict_types: conflictResult.conflicts.map((conflict) => conflict.conflict_type),
    goal_alignment_status: conflictResult.metadata_json.goal_alignment_status,
    review_ref: conflictResult.metadata_json.goal_steward_review_ref,
    result_ref: conflictResult.artifact_ref
  }
}, null, 2));

function manager(workspacePath: string, review: unknown) {
  return new IntegrationManager({
    workspacePath,
    artifactStore: new OrchestrationArtifactStore(workspacePath),
    config: {
      lock_ttl_ms: 60_000,
      validation_timeout: 1_000,
      max_validation_log_size: 10_000,
      safe_commands_allowlist: ["npm test"]
    },
    providerFactory: () => new FakeGoalProvider(review),
    applyMode: "safe_adapter",
    adapter: { apply: async () => ({ status: "applied", validation_status: "passed" }) }
  });
}

async function acceptedOutput(workspacePath: string, run: Run, task: Task): Promise<ParsedAgentOutput> {
  const artifactStore = new OrchestrationArtifactStore(workspacePath);
  const patchRef = await artifactStore.savePatchArtifact(run.id, `${task.id}_patch`, {
    task_id: task.id,
    proposal: { files_to_modify: task.allowed_files_to_edit },
    safety: { accepted: true, changed_files: task.allowed_files_to_edit }
  });
  const reviewRef = await artifactStore.saveReviewArtifact(run.id, `${task.id}_review`, {
    task_id: task.id,
    decision: "accept",
    summary: "accepted"
  });
  const validationRef = await artifactStore.saveValidationArtifact(run.id, `${task.id}_validation`, {
    task_id: task.id,
    status: "passed",
    result: { validation_status: "passed", passed: true },
    aggregate: { status: "passed" }
  });
  return {
    summary: task.objective,
    status: "succeeded",
    files_changed: task.allowed_files_to_edit,
    validation_results: [{ command: "npm test", status: "passed", summary: "passed", log_ref: validationRef }],
    artifacts: [patchRef, reviewRef, validationRef],
    limitations: [],
    next_recommendations: []
  };
}

function fakeRun(id: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Manual Goal Steward smoke",
    status: "integrating",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: path.join(workspace, ".agent_memory", "repo_index.json"),
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id),
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

function fakeTask(runId: string, id: string, objective: string): Task {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    run_id: runId,
    title: id,
    objective,
    role_required: "ExecutorAgent",
    status: "succeeded",
    dependencies: [],
    relevant_files: ["src/gameplay.ts"],
    allowed_files_to_edit: ["src/gameplay.ts"],
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
