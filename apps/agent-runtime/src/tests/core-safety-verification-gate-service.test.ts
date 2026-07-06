import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import type { CommandInventory } from "../memory/types.js";
import {
  CoreRunLifecycleService,
  CoreSafetyVerificationGateService,
  FactoryTraceWriter,
  IntentHandoffGate,
  IntentLedgerService,
  OrchestrationArtifactStore,
  PatchFingerprintTracker,
  createAlignmentFromFrame,
  loadOrchestrationConfig,
  type ParsedAgentOutput,
  type Run,
  type Task
} from "../orchestration/index.js";
import { TaskGraphManager } from "../orchestration/TaskGraphManager.js";

test("CoreSafetyVerificationGateService records executor patch and review artifacts without validation for no-change output", async () => {
  const fixture = await createFixture("safety-verification-no-change");
  try {
    const run = await fixture.createRun("Inspect profile without changing files.");
    const manager = new TaskGraphManager(run.id, fixture.workspace, fixture.store);
    const task = manager.createTask({
      id: "task_executor",
      run_id: run.id,
      title: "Inspect profile",
      objective: "Inspect profile without changing files.",
      role_required: "ExecutorAgent",
      dependencies: [],
      relevant_files: ["src/profile.ts"],
      allowed_files_to_edit: ["src/profile.ts"],
      forbidden_files: [],
      expected_output_schema: "ParsedAgentOutput",
      validation_commands: ["npm run test"],
      max_attempts: 2
    });
    await manager.persist();

    const output = await executorOutputWithIntent(fixture.workspace, run, task);
    const gated = await fixture.service.apply({
      run,
      task,
      output,
      commandInventory: emptyCommandInventory(),
      manager,
      fingerprintTracker: new PatchFingerprintTracker()
    });

    assert.equal(gated.status, "succeeded");
    assert.equal(gated.validation_results.length, 0);
    assert.equal(gated.artifacts.some((ref) => ref.includes("_patch_safety")), true);
    assert.equal(gated.artifacts.some((ref) => ref.includes("_review")), true);
    assert.equal(gated.next_recommendations.some((entry) => /No file changes were proposed/.test(entry)), true);

    const events = await fixture.store.listRunEvents(run.id);
    assert.equal(events.some((event) => isRecord(event) && event.type === "patch.created"), true);
    assert.equal(events.some((event) => isRecord(event) && event.type === "review.completed"), true);
    assert.equal(events.some((event) => isRecord(event) && event.type === "validation.command_finished"), false);
  } finally {
    await rm(fixture.workspace, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const workspace = await fixtureWorkspace(prefix);
  const store = new OrchestrationArtifactStore(workspace);
  const traceWriter = new FactoryTraceWriter({
    workspacePath: workspace,
    sourceComponent: "CoreSafetyVerificationGateServiceTest"
  });
  const lifecycle = new CoreRunLifecycleService(store, traceWriter, "CoreSafetyVerificationGateServiceTest");
  const config = loadOrchestrationConfig({
    enable_goal_steward: false
  });
  const service = new CoreSafetyVerificationGateService({
    workspacePath: workspace,
    memoryDir: ".agent_memory",
    config,
    artifactStore: store
  });
  return {
    workspace,
    store,
    service,
    createRun: async (userRequest: string) => {
      const run = await lifecycle.createRun({
        userRequest,
        workspacePath: workspace,
        memoryDir: ".agent_memory",
        config,
        maxContextFiles: 4,
        maxContextChars: 4000,
        maxTaskAttempts: 2
      });
      const contract = await new IntentLedgerService({
        workspacePath: workspace,
        memoryDir: ".agent_memory",
        sourceComponent: "CoreSafetyVerificationGateServiceTest"
      }).saveIntentContract({
        runId: run.id,
        runKind: "core",
        artifactsPath: run.artifacts_path,
        contract: readyContract(run.id, userRequest)
      });
      run.intent_contract_ref = contract.artifact_ref;
      run.intent_contract_status = contract.status;
      await store.saveRun(run);
      return run;
    }
  };
}

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "profile.ts"), "export const profile = true;\n", "utf8");
  return root;
}

async function executorOutputWithIntent(workspace: string, run: Run, task: Task): Promise<ParsedAgentOutput> {
  const frame = await new IntentHandoffGate({
    workspacePath: workspace,
    memoryDir: ".agent_memory",
    sourceComponent: "CoreSafetyVerificationGateServiceTest"
  }).coreFrame(run, task);
  return {
    summary: "Profile inspected; no changes needed.",
    status: "succeeded",
    files_changed: [],
    validation_results: [],
    artifacts: [],
    limitations: [],
    next_recommendations: ["Continue."],
    intent_alignment: createAlignmentFromFrame(frame, {
      taskUnderstanding: "Inspect profile without changing files.",
      originalGoalContribution: "Confirmed the requested inspection did not require edits.",
      possibleIntentConflicts: [],
      assumptionsUsed: [],
      evidenceRefs: ["src/profile.ts"]
    })
  };
}

function emptyCommandInventory(): CommandInventory {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageManagers: [],
    commands: [],
    byKind: {
      test: [],
      lint: [],
      typecheck: [],
      build: [],
      format: [],
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}

function readyContract(runId: string, userRequest: string): IntentContract {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    contract_id: `intent_contract_${runId}`,
    run_id: runId,
    run_kind: "core",
    revision: 0,
    original_user_request: userRequest,
    precise_rewrite: userRequest,
    assumptions: [],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 0.5, rationale: "Neutral test priority." },
      quality: { score: 0.8, rationale: "Preserve gate behavior." },
      realism: { score: 0.5, rationale: "Neutral test priority." },
      fun: { score: 0.1, rationale: "Not relevant." },
      security: { score: 0.7, rationale: "Respect safety gates." },
      cost: { score: 0.5, rationale: "Neutral test priority." }
    },
    definition_of_done: ["Gate output preserves no-change executor behavior."],
    non_goals: [],
    conflict_rules: [],
    status: "ready",
    created_at: now,
    metadata_json: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
