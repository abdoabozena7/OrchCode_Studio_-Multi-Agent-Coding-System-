import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import {
  CoreOrchestrator,
  FactoryMetadataStore,
  MultiPlanFactory,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  REQUIRED_PLAN_PERSPECTIVES,
  evaluatePlanVariants,
  generatePlanVariants,
  mergePlanVariants,
  reconstructFactoryRunTrace,
  shouldUseMultiPlanFactory,
  type Run
} from "../orchestration/index.js";

test("multi-plan models generate five required perspectives with required fields", () => {
  const run = fakeRun("run_models", "/tmp/workspace", mediumRequest());
  const input = {
    run,
    rawUserRequest: run.user_request,
    repoIndex: fixtureRepoIndex(),
    commandInventory: fixtureCommandInventory(),
    planOnly: true
  };
  const trigger = shouldUseMultiPlanFactory(input);
  const variants = generatePlanVariants(input);
  const evaluations = evaluatePlanVariants(variants, {
    trigger,
    generation_mode: "heuristic",
    validation_commands: ["npm run test", "npm run typecheck"],
    high_signal_files: ["apps/agent-runtime/src/orchestration/Orchestrator.ts"],
    risk_signals: ["validation", "trace"]
  });
  const merged = mergePlanVariants(variants, evaluations, {
    trigger,
    generation_mode: "heuristic",
    validation_commands: ["npm run test", "npm run typecheck"],
    high_signal_files: ["apps/agent-runtime/src/orchestration/Orchestrator.ts"],
    risk_signals: ["validation", "trace"]
  });

  assert.deepEqual(variants.map((variant) => variant.perspective).sort(), [...REQUIRED_PLAN_PERSPECTIVES].sort());
  for (const variant of variants) {
    assert.ok(variant.plan_id);
    assert.ok(variant.run_id);
    assert.ok(variant.title);
    assert.ok(variant.summary);
    assert.ok(Array.isArray(variant.assumptions));
    assert.ok(Array.isArray(variant.proposed_domains));
    assert.ok(Array.isArray(variant.proposed_tasks));
    assert.ok(Array.isArray(variant.dependencies));
    assert.ok(Array.isArray(variant.risks));
    assert.ok(Array.isArray(variant.unknowns));
    assert.ok(variant.validation_strategy.success_criteria.length);
    assert.ok(variant.suggested_agents.length);
    assert.equal(variant.generation_mode, "heuristic");
  }
  for (const evaluation of evaluations) {
    assert.ok(evaluation.evaluation_id);
    for (const key of ["safety", "completeness", "minimality", "testability", "architecture_quality", "implementation_speed", "integration_risk", "user_value", "confidence"] as const) {
      assert.equal(typeof evaluation.scores[key], "number");
    }
  }
  assert.ok(merged.selected_plan_ids.length > 0);
  assert.ok(merged.rejected_plan_ids.length > 0);
  assert.ok(merged.merge_rationale.length > 0);
});

test("multi-plan trigger skips tiny tasks and uses heuristic medium tasks", () => {
  const tiny = fakeRun("run_tiny", "/tmp/workspace", "Fix typo in README");
  const medium = fakeRun("run_medium", "/tmp/workspace", "Add a focused feature with tests touching several files in one module.");

  const tinyDecision = shouldUseMultiPlanFactory({ run: tiny, rawUserRequest: tiny.user_request, planOnly: true });
  const mediumDecision = shouldUseMultiPlanFactory({ run: medium, rawUserRequest: medium.user_request, planOnly: true });
  const missingComplexity = shouldUseMultiPlanFactory({ run: medium, rawUserRequest: medium.user_request });

  assert.equal(tinyDecision.use_multi_plan, false);
  assert.match(tinyDecision.reason, /single-plan|Tiny/i);
  assert.equal(mediumDecision.use_multi_plan, true);
  assert.equal(mediumDecision.inferred_complexity, "medium");
  assert.equal(missingComplexity.use_multi_plan, true);
});

test("multi-plan generation captures MVP, architecture, risk, test, and speed priorities", () => {
  const run = fakeRun("run_generation", "/tmp/workspace", mediumRequest());
  const variants = generatePlanVariants({
    run,
    rawUserRequest: run.user_request,
    repoIndex: fixtureRepoIndex(),
    commandInventory: fixtureCommandInventory(),
    planOnly: true
  });
  const byPerspective = Object.fromEntries(variants.map((variant) => [variant.perspective, variant]));

  assert.match(byPerspective.mvp_first.summary, /Smallest useful|minimal/i);
  assert.match(byPerspective.architecture_first.summary, /module boundaries|contracts|integration/i);
  assert.ok(byPerspective.risk_first.risks.some((risk) => /safety|validation|auditability|write-capable/i.test(risk.summary)));
  assert.ok(byPerspective.test_first.validation_strategy.success_criteria.some((criterion) => /perspectives|scored|SQLite|single-plan/i.test(criterion)));
  assert.match(byPerspective.speed_first.summary, /Fastest safe|reuse|minimize/i);
  assert.equal(variants.every((variant) => variant.proposed_tasks.every((task) => task.read_only && task.allowed_write_paths.length === 0)), true);
});

test("multi-plan merge deduplicates tasks and preserves dependencies and validation", () => {
  const run = fakeRun("run_merge", "/tmp/workspace", mediumRequest());
  const trigger = shouldUseMultiPlanFactory({ run, rawUserRequest: run.user_request, planOnly: true });
  const context = {
    trigger,
    generation_mode: "heuristic" as const,
    validation_commands: ["npm run test", "npm run typecheck"],
    high_signal_files: ["apps/agent-runtime/src/orchestration/Orchestrator.ts"],
    risk_signals: ["validation"]
  };
  const variants = generatePlanVariants({
    run,
    rawUserRequest: run.user_request,
    repoIndex: fixtureRepoIndex(),
    commandInventory: fixtureCommandInventory(),
    planOnly: true
  }, context);
  variants[1].proposed_tasks.push({ ...variants[0].proposed_tasks[0], id: "draft_duplicate" });
  const evaluations = evaluatePlanVariants(variants, context);
  const merged = mergePlanVariants(variants, evaluations, context);

  const objectives = merged.merged_tasks.map((task) => task.objective.toLowerCase());
  assert.equal(new Set(objectives).size, objectives.length);
  assert.ok(merged.dependencies.length >= 1);
  assert.ok(merged.validation_strategy.required_commands.includes("npm run test"));
  assert.ok(merged.merge_rationale.some((entry) => /Deduplicated/i.test(entry)));
  assert.ok(evaluations.some((evaluation) => evaluation.weaknesses.some((weakness) => /Duplicates/i.test(weakness))));
});

test("multi-plan artifacts metadata and trace are written without storing full plan text in SQLite", async () => {
  const workspace = await fixtureWorkspace("multi-plan-artifacts");
  try {
    const srcPath = path.join(workspace, "src", "index.ts");
    const before = await readFile(srcPath, "utf8");
    const run = fakeRun("run_multi_plan_artifacts", workspace, mediumRequest());
    const store = new OrchestrationArtifactStore(workspace);
    await store.saveRun(run);

    const result = await new MultiPlanFactory(workspace).create({
      run,
      rawUserRequest: run.user_request,
      repoIndex: fixtureRepoIndex(workspace),
      commandInventory: fixtureCommandInventory(),
      planOnly: true
    });

    assert.equal(result.used, true);
    assert.equal((await readFile(srcPath, "utf8")), before);
    assert.equal(existsSync(path.join(run.artifacts_path, "plans")), true);
    for (const perspective of REQUIRED_PLAN_PERSPECTIVES) {
      assert.ok(result.variants.some((variant) => variant.perspective === perspective && existsSync(variant.artifact_ref)));
    }
    assert.ok(result.evaluations.every((evaluation) => existsSync(evaluation.artifact_ref)));
    assert.ok(result.merged_plan?.artifact_ref && existsSync(result.merged_plan.artifact_ref));
    assert.equal(existsSync(path.join(run.artifacts_path, "tasks.json")), false);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const variantRows = metadata.all<{ perspective: string; metadata_json: string }>(
        "SELECT perspective, metadata_json FROM factory_plan_variants WHERE run_id = ?",
        run.id
      );
      const evaluationRows = metadata.all<{ selected: number; scores_json: string }>(
        "SELECT selected, scores_json FROM factory_plan_evaluations WHERE run_id = ?",
        run.id
      );
      const mergedRows = metadata.all<{ artifact_ref: string; selected_plan_ids_json: string }>(
        "SELECT artifact_ref, selected_plan_ids_json FROM factory_merged_plans WHERE run_id = ?",
        run.id
      );
      assert.equal(variantRows.length, 5);
      assert.equal(evaluationRows.length, 5);
      assert.equal(mergedRows.length, 1);
      assert.equal(variantRows.some((row) => row.metadata_json.includes("Smallest useful implementation path")), false);
      assert.ok(JSON.parse(evaluationRows[0].scores_json).safety >= 0);
    } finally {
      metadata.close();
    }

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    const eventTypes = new Set(trace.events.map((event) => event.event_type));
    assert.ok(eventTypes.has("multi_plan_started"));
    assert.ok(eventTypes.has("plan_variant_created"));
    assert.ok(eventTypes.has("plan_merge_completed"));
    assert.ok(eventTypes.has("merged_plan_artifact_written"));
    assert.equal(trace.missingExpectedTraceLinks.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("multi-plan skipped trace is emitted for tiny task", async () => {
  const workspace = await fixtureWorkspace("multi-plan-skip");
  try {
    const run = fakeRun("run_multi_plan_skip", workspace, "Fix typo in README");
    await new OrchestrationArtifactStore(workspace).saveRun(run);
    const result = await new MultiPlanFactory(workspace).create({ run, rawUserRequest: run.user_request, planOnly: true });
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });

    assert.equal(result.used, false);
    assert.ok(trace.events.some((event) => event.event_type === "multi_plan_skipped" && /single-plan|Tiny/i.test(event.reason ?? "")));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreOrchestrator plan-only medium task includes multi-plan artifacts while simple path still works", async () => {
  const workspace = await fixtureWorkspace("multi-plan-core");
  try {
    const medium = await new CoreOrchestrator({ workspacePath: workspace }).planOnly(mediumRequest());
    assert.equal(medium.report.multi_plan_used, true);
    assert.equal(medium.report.plan_variant_count, 5);
    assert.ok(medium.report.merged_plan_ref);
    assert.equal(existsSync(path.join(medium.run.artifacts_path, "plans")), true);
    assert.ok((await new OrchestrationArtifactStore(workspace).artifactTree(medium.run.id)).some((entry) => entry.path.startsWith("plans/merged_plan_")));

    const simple = await new CoreOrchestrator({ workspacePath: workspace }).planOnly("Explain src/index.ts without changing files.");
    assert.equal(simple.run.status, "succeeded");
    assert.equal(simple.report.multi_plan_used, false);
    assert.ok(simple.tasks.length >= 4);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\"",
      build: "node -e \"process.exit(0)\""
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function mediumRequest() {
  return "Implement a read-only multi-plan factory for the orchestration layer with artifacts, metadata, trace events, validation strategy, and CoreOrchestrator planning integration.";
}

function fakeRun(id: string, workspace: string, userRequest: string): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: userRequest,
    status: "planning",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: "repo_index.json",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 4,
      max_context_chars: 4000,
      max_task_attempts: 1,
      provider_mode: "mock",
      execution_mode: "deep",
      enable_multi_plan_factory: true
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

function fixtureRepoIndex(workspace = "/tmp/workspace"): RepoIndex {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspaceRoot: workspace,
    projectName: "fixture",
    totals: {
      indexedFiles: 80,
      sourceFiles: 40,
      testFiles: 10,
      configFiles: 4,
      docFiles: 3,
      skippedFiles: 0,
      indexedBytes: 2000
    },
    languages: { TypeScript: 50, JSON: 4 },
    extensions: { ".ts": 50, ".json": 4 },
    topLevelDirectories: [{ path: "apps", files: 60 }],
    ignoredDirectories: [],
    skippedFiles: [],
    sourceFiles: [
      "apps/agent-runtime/src/orchestration/Orchestrator.ts",
      "apps/agent-runtime/src/orchestration/ArtifactStore.ts",
      "apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts",
      "src/index.ts"
    ],
    testFiles: ["apps/agent-runtime/src/tests/orchestration.test.ts"],
    configFiles: ["package.json", "apps/agent-runtime/package.json"],
    docFiles: ["docs/orchestration-flow.md"],
    importantFiles: [
      "apps/agent-runtime/src/orchestration/Orchestrator.ts",
      "apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts"
    ],
    entrypoints: ["apps/agent-runtime/src/orchestration/index.ts"],
    packageFiles: ["package.json"],
    dependencyFiles: ["package-lock.json"],
    buildFiles: ["package.json"]
  };
}

function fixtureCommandInventory(): CommandInventory {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: now,
    packageManagers: ["npm"],
    commands: [],
    byKind: {
      test: ["npm run test"],
      lint: [],
      typecheck: ["npm run typecheck"],
      build: ["npm run build"],
      format: [],
      smoke: ["npm run smoke:inspect-provider-truth"],
      dev: [],
      run: [],
      unknown: []
    }
  };
}
