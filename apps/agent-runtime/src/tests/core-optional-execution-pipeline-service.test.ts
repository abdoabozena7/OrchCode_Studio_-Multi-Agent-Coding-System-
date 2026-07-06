import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CoreOptionalExecutionPipelineService,
  FactoryMetadataStore,
  FactoryTraceWriter,
  OrchestrationArtifactStore,
  loadOrchestrationConfig
} from "../orchestration/index.js";

test("CoreOptionalExecutionPipelineService records disabled optional pipeline stages without executing them", async () => {
  const workspace = await fixtureWorkspace("optional-execution-pipeline-disabled");
  try {
    const service = new CoreOptionalExecutionPipelineService({
      workspacePath: workspace,
      memoryDir: ".agent_memory",
      config: loadOrchestrationConfig({
        enable_execution_preparation: false,
        enable_one_writer_dry_run: false,
        enable_patch_proposal_review_gate: false,
        enable_validation_candidate_gate: false,
        enable_patch_apply_sandbox: false,
        enable_sandbox_validation: false,
        enable_sandbox_integration_candidates: false,
        enable_integration_apply_approval_gate: false,
        enable_controlled_integration_apply: false,
        enable_integration_finalization: false
      }),
      artifactStore: new OrchestrationArtifactStore(workspace, ".agent_memory"),
      traceWriter: new FactoryTraceWriter({
        workspacePath: workspace,
        memoryDir: ".agent_memory",
        sourceComponent: "CoreOptionalExecutionPipelineServiceTest"
      })
    });
    const runId = "run_optional_pipeline";

    await service.prepareExecutionIfAllowed(runId, true);
    await service.generateOneWriterDryRunIfAllowed(runId, true);
    await service.createIntegrationApplyApprovalsIfAllowed(runId, true);
    await service.applyControlledIntegrationIfAllowed(runId, true);
    await service.finalizeIntegrationIfAllowed(runId, true);

    const metadata = await FactoryMetadataStore.open({ workspacePath: workspace, memoryDir: ".agent_memory", readOnly: true });
    try {
      const rows = metadata.all<{ event_type: string; reason: string | null }>(
        "SELECT event_type, reason FROM factory_trace_events WHERE run_id = ? ORDER BY created_at",
        runId
      );
      assert.deepEqual(rows.map((row) => row.event_type), [
        "execution_preparation_batch_completed",
        "one_writer_dry_run_batch_completed",
        "integration_apply_approval_batch_completed",
        "controlled_apply_batch_completed",
        "integration_finalization_batch_completed"
      ]);
      assert.deepEqual(rows.map((row) => row.reason), [
        "execution_preparation_disabled",
        "one_writer_dry_run_disabled",
        "integration_apply_approval_disabled",
        "controlled_integration_apply_disabled",
        "integration_finalization_disabled"
      ]);
    } finally {
      metadata.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}
