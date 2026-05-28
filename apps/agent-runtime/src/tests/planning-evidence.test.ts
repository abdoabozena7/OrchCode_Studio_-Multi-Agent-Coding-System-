import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandInventory, RepoIndex } from "../memory/types.js";
import {
  FactoryMetadataAdapter,
  FactoryMetadataStore,
  MultiPlanFactory,
  ORCHESTRATION_SCHEMA_VERSION,
  OrchestrationArtifactStore,
  PlanningEvidenceCollector,
  evaluatePlanVariants,
  generatePlanVariants,
  loadOrchestrationConfig,
  mergePlanVariants,
  reconstructFactoryRunTrace,
  shouldUseMultiPlanFactory,
  type MultiPlanEvaluationContext,
  type PlanningEvidenceBundle,
  type PlanVariant,
  type Run
} from "../orchestration/index.js";

test("PlanningEvidenceCollector collects provider outputs, rejects invalid refs, deduplicates, and marks low confidence", async () => {
  const workspace = await fixtureWorkspace("planning-evidence-collector");
  try {
    const run = fakeRun("run_evidence_collect", workspace);
    await new OrchestrationArtifactStore(workspace).saveRun(run);
    await saveProviderEvidence(workspace, run, "scout_1", "ScoutAgent", "swarm_scout_output", scoutOutput({ confidence: 0.84 }));
    await saveProviderEvidence(workspace, run, "risk_1", "RiskAnalyzerAgent", "swarm_risk_analyst_output", riskOutput({ confidence: 0.77 }));
    await saveProviderEvidence(workspace, run, "test_1", "TesterAgent", "swarm_tester_planner_output", testerOutput({ confidence: 0.31 }));
    await saveProviderEvidence(workspace, run, "test_duplicate", "TesterAgent", "swarm_tester_planner_output", testerOutput({ confidence: 0.31 }), { reuseWorkItem: "test_1" });
    await saveProviderEvidence(workspace, run, "invalid_1", "ScoutAgent", "swarm_scout_output", { nope: true }, { schemaStatus: "passed" });
    await saveProviderEvidence(workspace, run, "missing_1", "ScoutAgent", "swarm_scout_output", scoutOutput({ confidence: 0.9 }), { deleteParsed: true });

    const bundle = await new PlanningEvidenceCollector(workspace).collect({
      run,
      rawUserRequest: run.user_request,
      config: loadOrchestrationConfig(run.config),
      planOnly: true
    });

    assert.equal(bundle.items.length, 3);
    assert.equal(bundle.summary.provider_evidence_count, 3);
    assert.equal(bundle.summary.low_confidence_count, 1);
    assert.equal(bundle.rejected_items.length, 3);
    assert.ok(bundle.items.some((item) => item.source_type === "provider_scout_output" && item.extracted_findings.some((finding) => /metadata/i.test(finding))));
    assert.ok(bundle.items.some((item) => item.source_type === "provider_risk_analyst_output" && item.extracted_risks.some((risk) => /High validation risk/i.test(risk))));
    assert.ok(bundle.items.some((item) => item.source_type === "provider_tester_planner_output" && item.extracted_validation_recommendations.includes("npm run test")));
    assert.ok(bundle.artifact_ref && existsSync(bundle.artifact_ref));
    assert.ok(bundle.summary_ref && existsSync(bundle.summary_ref));

    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_item_collected"));
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_item_rejected"));
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_bundle_created"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PlanningEvidenceCollector creates an empty bundle when provider evidence is unavailable", async () => {
  const workspace = await fixtureWorkspace("planning-evidence-empty");
  try {
    const run = fakeRun("run_evidence_empty", workspace);
    await new OrchestrationArtifactStore(workspace).saveRun(run);
    const bundle = await new PlanningEvidenceCollector(workspace).collect({ run, rawUserRequest: run.user_request, config: loadOrchestrationConfig(run.config), planOnly: true });

    assert.equal(bundle.items.length, 0);
    assert.equal(bundle.summary.evidence_used, false);
    assert.ok(bundle.limitations.some((entry) => /No valid provider-backed/i.test(entry)));
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_unavailable"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("MultiPlanFactory uses evidence bundle and preserves evidence links without duplicating raw outputs", async () => {
  const workspace = await fixtureWorkspace("planning-evidence-multiplan");
  try {
    const run = fakeRun("run_evidence_multiplan", workspace);
    await new OrchestrationArtifactStore(workspace).saveRun(run);
    await saveProviderEvidence(workspace, run, "scout_1", "ScoutAgent", "swarm_scout_output", scoutOutput({ confidence: 0.84 }));
    await saveProviderEvidence(workspace, run, "risk_1", "RiskAnalyzerAgent", "swarm_risk_analyst_output", riskOutput({ confidence: 0.78 }));
    await saveProviderEvidence(workspace, run, "tester_1", "TesterAgent", "swarm_tester_planner_output", testerOutput({ confidence: 0.82 }));
    await saveProviderEvidence(workspace, run, "specialist_1", "SecuritySpecialistAgent", "swarm_specialist_output", specialistOutput({ confidence: 0.8 }));

    const result = await new MultiPlanFactory(workspace).create({
      run,
      rawUserRequest: run.user_request,
      repoIndex: fixtureRepoIndex(workspace),
      commandInventory: fixtureCommandInventory(),
      config: loadOrchestrationConfig(run.config),
      planOnly: true
    });

    assert.equal(result.used, true);
    assert.equal(result.generation_mode, "mixed");
    assert.equal(result.summary?.evidence_used, true);
    assert.equal(result.summary?.provider_evidence_count, 4);
    assert.ok(result.summary?.evidence_bundle_ref && existsSync(result.summary.evidence_bundle_ref));
    assert.ok(result.variants.find((variant) => variant.perspective === "mvp_first")?.evidence_used_summary?.some((entry) => /scout/i.test(entry)));
    assert.ok(result.variants.find((variant) => variant.perspective === "risk_first")?.risks.some((risk) => /High validation risk/i.test(risk.summary)));
    assert.ok(result.variants.find((variant) => variant.perspective === "test_first")?.validation_strategy.required_commands.includes("npm run test"));
    assert.ok(result.variants.find((variant) => variant.perspective === "architecture_first")?.evidence_used_summary?.some((entry) => /specialist|planner|reviewer/i.test(entry)));
    assert.ok(result.merged_plan?.evidence_item_refs?.length);
    assert.ok(result.merged_plan?.merge_rationale.some((entry) => /Evidence sources|planning evidence item/i.test(entry)));

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const evidenceRows = metadata.all<{ summary: string; metadata_json: string }>(
        "SELECT summary, metadata_json FROM factory_planning_evidence WHERE run_id = ?",
        run.id
      );
      const links = metadata.all<{ usage_type: string }>(
        "SELECT usage_type FROM factory_plan_evidence_links WHERE run_id = ?",
        run.id
      );
      assert.ok(evidenceRows.length >= 4);
      assert.ok(links.some((row) => row.usage_type === "informed_plan_variant"));
      assert.ok(links.some((row) => row.usage_type === "adjusted_evaluation"));
      assert.ok(links.some((row) => row.usage_type === "merged_into_plan"));
      assert.equal(evidenceRows.some((row) => row.metadata_json.includes("High validation risk")), false);
    } finally {
      metadata.close();
    }

    const bundleText = await readFile(result.summary!.evidence_bundle_ref!, "utf8");
    assert.equal(bundleText.includes("raw provider output body that should not be duplicated"), false);
    const trace = await reconstructFactoryRunTrace({ workspacePath: workspace, runId: run.id });
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_used_by_plan"));
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_used_by_evaluation"));
    assert.ok(trace.events.some((event) => event.event_type === "planning_evidence_used_by_merge"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("PlanEvaluator and PlanMerger preserve evidence penalties, conflicts, and refs", () => {
  const run = fakeRun("run_evidence_eval", "/tmp/workspace");
  const evidence = manualEvidenceBundle(run.id);
  const trigger = shouldUseMultiPlanFactory({ run, rawUserRequest: run.user_request, planOnly: true, planningEvidence: evidence });
  const context: MultiPlanEvaluationContext = {
    trigger,
    generation_mode: "mixed",
    validation_commands: ["npm run test"],
    high_signal_files: ["apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts"],
    risk_signals: ["provider_evidence_risk", "validation"],
    evidence_bundle: evidence
  };
  const variants = generatePlanVariants({ run, rawUserRequest: run.user_request, planningEvidence: evidence, planOnly: true }, context);
  const weak = {
    ...variants.find((variant) => variant.perspective === "speed_first")!,
    plan_id: "plan_weak_ignores_evidence",
    summary: "Fast path.",
    risks: [],
    proposed_tasks: variants[0].proposed_tasks.map((task) => ({ ...task, objective: "Do the fast thing." })),
    evidence_item_refs: []
  } satisfies PlanVariant;
  const evaluations = evaluatePlanVariants([...variants, weak], context);
  const weakEval = evaluations.find((evaluation) => evaluation.plan_id === weak.plan_id)!;
  assert.ok(weakEval.scores.safety < 70);
  assert.ok(weakEval.contradictions.some((entry) => /high-risk planning evidence/i.test(entry)));

  const merged = mergePlanVariants(variants, evaluations.filter((evaluation) => evaluation.plan_id !== weak.plan_id), context);
  assert.deepEqual(merged.evidence_item_refs?.sort(), evidence.items.map((item) => item.evidence_id).sort());
  assert.equal(merged.evidence_conflicts?.length, 1);
  assert.ok(merged.unresolved_questions.some((question) => /Evidence conflict/i.test(question)));
});

test("planning evidence disabled keeps deterministic multi-plan behavior", () => {
  const run = fakeRun("run_evidence_disabled", "/tmp/workspace", { use_planning_evidence: false, planning_evidence_mode: "off" });
  const variants = generatePlanVariants({
    run,
    rawUserRequest: run.user_request,
    config: loadOrchestrationConfig(run.config),
    planOnly: true
  });
  assert.equal(variants.every((variant) => !variant.evidence_item_refs?.length), true);
  assert.equal(variants.every((variant) => variant.generation_mode === "deterministic"), true);
});

async function fixtureWorkspace(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: prefix,
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  return root;
}

function fakeRun(id: string, workspace: string, config: Partial<Run["config"]> = {}): Run {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id,
    user_request: "Implement evidence-backed multi-plan inputs for provider-backed read-only swarm workers with metadata, trace, validation, and artifact refs.",
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
      enable_multi_plan_factory: true,
      use_planning_evidence: true,
      planning_evidence_mode: "available",
      max_evidence_items: 20,
      min_evidence_confidence: 0.2,
      allow_mock_evidence: false,
      ...config
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", id)
  };
}

async function saveProviderEvidence(
  workspace: string,
  run: Run,
  workItemId: string,
  role: string,
  schemaName: string,
  parsed: unknown,
  options: { schemaStatus?: string; deleteParsed?: boolean; reuseWorkItem?: string } = {}
) {
  const dir = path.join(workspace, ".agent_memory", "swarm_runs", run.id, "provider_workers", options.reuseWorkItem ?? workItemId);
  await mkdir(dir, { recursive: true });
  const parsedRef = path.join(dir, "parsed_output.json");
  const rawRef = path.join(dir, "raw_output.md");
  await writeFile(parsedRef, JSON.stringify(parsed, null, 2), "utf8");
  await writeFile(rawRef, "raw provider output body that should not be duplicated", "utf8");
  if (options.deleteParsed) await rm(parsedRef, { force: true });
  await new FactoryMetadataAdapter(workspace).recordWorkerInvocationSaved({
    workerInvocationId: `worker_invocation_${workItemId}`,
    runId: run.id,
    workItemId,
    agentId: `agent_${role}`,
    agentRole: role,
    workerMode: "provider_read_only",
    providerName: "fake",
    modelName: "fake-readonly",
    promptId: `prompt_${workItemId}`,
    promptQualityResultId: `quality_${workItemId}`,
    rawOutputRef: rawRef,
    parsedOutputRef: parsedRef,
    outputSchemaName: schemaName,
    outputSchemaStatus: options.schemaStatus ?? "passed",
    traceEventId: `trace_${workItemId}`,
    status: "succeeded",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    metadata: { fixture: true }
  });
}

function scoutOutput(input: { confidence: number }) {
  return {
    findings: ["FactoryMetadataStore and MultiPlanFactory are the highest signal files."],
    relevant_files: ["apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts", "apps/agent-runtime/src/orchestration/MultiPlanFactory.ts"],
    risks: [],
    unknowns: [],
    suggested_next_steps: ["Reuse existing artifact store and metadata adapter."],
    confidence: input.confidence
  };
}

function riskOutput(input: { confidence: number }) {
  return {
    risks: ["High validation risk if evidence refs are not preserved."],
    severity: "high",
    impacted_files_or_modules: ["apps/agent-runtime/src/orchestration/PlanEvaluator.ts"],
    mitigation: ["Link evidence refs and keep provider output advisory."],
    blockers: [],
    confidence: input.confidence
  };
}

function testerOutput(input: { confidence: number }) {
  return {
    recommended_validation: ["npm run test"],
    required_commands: ["npm run test"],
    optional_commands: ["npm run typecheck"],
    smoke_checks: ["Inspect evidence summary artifact."],
    blocked_or_missing_validation: [],
    confidence: input.confidence
  };
}

function specialistOutput(input: { confidence: number }) {
  return {
    specialty: "architecture",
    findings: ["Architecture concern: keep provider evidence as references, not execution-driving truth."],
    recommendations: ["Preserve module boundaries between collector, evaluator, and merger."],
    risks: ["Specialist risk: source role mismatch should not be trusted blindly."],
    confidence: input.confidence
  };
}

function manualEvidenceBundle(runId: string): PlanningEvidenceBundle {
  const now = new Date().toISOString();
  return {
    evidence_bundle_id: "bundle_manual",
    run_id: runId,
    generation_mode: "mixed",
    items: [
      {
        evidence_id: "evidence_high_risk",
        run_id: runId,
        source_type: "provider_risk_analyst_output",
        source_role: "RiskAnalyzerAgent",
        parsed_output_ref: "risk.json",
        confidence: "high",
        confidence_score: 0.9,
        freshness: "fresh",
        summary: "Critical evidence requires approval.",
        extracted_findings: [],
        extracted_risks: ["Critical approval risk"],
        extracted_tasks: [],
        extracted_validation_recommendations: ["npm run test"],
        extracted_dependencies: ["apps/agent-runtime/src/orchestration/PlanEvaluator.ts"],
        metadata_json: {}
      },
      {
        evidence_id: "evidence_accept_review",
        run_id: runId,
        source_type: "provider_reviewer_output",
        source_role: "ReviewerAgent",
        parsed_output_ref: "review.json",
        confidence: "medium",
        confidence_score: 0.7,
        freshness: "fresh",
        summary: "accept",
        extracted_findings: ["Looks acceptable."],
        extracted_risks: [],
        extracted_tasks: [],
        extracted_validation_recommendations: [],
        extracted_dependencies: [],
        metadata_json: {}
      }
    ],
    rejected_items: [],
    conflicts: [{
      conflict_id: "conflict_manual",
      evidence_ids: ["evidence_high_risk", "evidence_accept_review"],
      summary: "Reviewer evidence is more optimistic than risk evidence.",
      severity: "medium",
      resolution: "Preserve both."
    }],
    summary: {
      evidence_used: true,
      evidence_item_count: 2,
      provider_evidence_count: 2,
      mock_evidence_count: 0,
      low_confidence_count: 0,
      rejected_evidence_count: 0,
      evidence_conflict_count: 1,
      top_evidence_sources: ["provider_risk_analyst_output", "provider_reviewer_output"],
      limitations: []
    },
    limitations: [],
    created_at: now
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
      "apps/agent-runtime/src/orchestration/MultiPlanFactory.ts",
      "apps/agent-runtime/src/orchestration/PlanEvaluator.ts",
      "apps/agent-runtime/src/orchestration/FactoryMetadataStore.ts"
    ],
    testFiles: ["apps/agent-runtime/src/tests/planning-evidence.test.ts"],
    configFiles: ["package.json"],
    docFiles: ["docs/architecture/provider-backed-read-only-swarm-workers.md"],
    importantFiles: ["apps/agent-runtime/src/orchestration/MultiPlanFactory.ts"],
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
      smoke: [],
      dev: [],
      run: [],
      unknown: []
    }
  };
}
