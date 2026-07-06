import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { ControlledIntegrationApplyManager } from "./ControlledIntegrationApplyManager.js";
import { ExecutionPreparationPlanner } from "./ExecutionPreparationPlanner.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { IntegrationApplyApprovalGate } from "./IntegrationApplyApprovalGate.js";
import { IntegrationFinalizationManager } from "./IntegrationFinalizationManager.js";
import { OneWriterDryRunExecutor } from "./OneWriterDryRunExecutor.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { PatchApplySandboxManager } from "./PatchApplySandboxManager.js";
import { PatchProposalReviewGate } from "./PatchProposalReviewGate.js";
import { SandboxIntegrationCandidateGate } from "./SandboxIntegrationCandidateGate.js";
import { SandboxValidationRunner } from "./SandboxValidationRunner.js";
import { ValidationCandidateGate } from "./ValidationCandidateGate.js";

export type CoreOptionalExecutionPipelineOptions = {
  workspacePath: string;
  memoryDir: string;
  config: OrchestrationSafetyConfig;
  artifactStore: OrchestrationArtifactStore;
  traceWriter: FactoryTraceWriter;
};

export class CoreOptionalExecutionPipelineService {
  constructor(private readonly options: CoreOptionalExecutionPipelineOptions) {}

  async prepareExecutionIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_execution_preparation || this.options.config.execution_preparation_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "execution_preparation_batch_completed",
        lifecycle_stage: "planning",
        summary: "Execution preparation skipped by configuration.",
        reason: "execution_preparation_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.execution_preparation_mode, plan_only: planOnly, no_execution: true }
      });
      return;
    }
    const planner = new ExecutionPreparationPlanner({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await planner.prepareRunPromotionQueue(runId);
    await this.generateOneWriterDryRunIfAllowed(runId, planOnly);
  }

  async generateOneWriterDryRunIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_one_writer_dry_run || this.options.config.one_writer_dry_run_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "one_writer_dry_run_batch_completed",
        lifecycle_stage: "planning",
        summary: "One-writer dry-run skipped by configuration.",
        reason: "one_writer_dry_run_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.one_writer_dry_run_mode, plan_only: planOnly, no_patch_applied: true }
      });
      return;
    }
    const executor = new OneWriterDryRunExecutor({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await executor.generatePatchProposalBatch(runId);
    await this.reviewPatchProposalsIfAllowed(runId, planOnly);
  }

  async reviewPatchProposalsIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_patch_proposal_review_gate || this.options.config.patch_proposal_review_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "patch_proposal_review_batch_completed",
        lifecycle_stage: "planning",
        summary: "Patch proposal review gate skipped by configuration.",
        reason: "patch_proposal_review_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.patch_proposal_review_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const gate = new PatchProposalReviewGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await gate.reviewPatchProposalBatch(runId);
    await this.createValidationCandidatesIfAllowed(runId, planOnly);
  }

  async createValidationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_validation_candidate_gate || this.options.config.validation_candidate_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "validation_candidate_batch_completed",
        lifecycle_stage: "planning",
        summary: "Validation candidate gate skipped by configuration.",
        reason: "validation_candidate_gate_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.validation_candidate_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const gate = new ValidationCandidateGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await gate.createValidationCandidateBatch(runId);
    await this.createPatchApplySandboxIfAllowed(runId, planOnly);
  }

  async createPatchApplySandboxIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_patch_apply_sandbox || this.options.config.patch_apply_sandbox_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "patch_apply_sandbox_batch_completed",
        lifecycle_stage: "planning",
        summary: "Patch apply sandbox skipped by configuration.",
        reason: "patch_apply_sandbox_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.patch_apply_sandbox_mode, plan_only: planOnly, no_validation_run: true, no_patch_applied: true }
      });
      return;
    }
    const manager = new PatchApplySandboxManager({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await manager.runDryApplyBatch(runId);
    await this.runSandboxValidationIfAllowed(runId, planOnly);
  }

  async runSandboxValidationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_sandbox_validation || this.options.config.sandbox_validation_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "sandbox_validation_batch_completed",
        lifecycle_stage: "validation",
        summary: "Sandbox validation skipped by configuration.",
        reason: "sandbox_validation_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.sandbox_validation_mode, plan_only: planOnly, no_main_repo_validation: true, no_integration_created: true }
      });
      return;
    }
    const runner = new SandboxValidationRunner({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await runner.runSandboxValidationBatch(runId);
    await this.createSandboxIntegrationCandidatesIfAllowed(runId, planOnly);
  }

  async createSandboxIntegrationCandidatesIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_sandbox_integration_candidates || this.options.config.sandbox_integration_candidate_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "sandbox_integration_candidate_batch_completed",
        lifecycle_stage: "planning",
        summary: "Sandbox integration candidate gate skipped by configuration.",
        reason: "sandbox_integration_candidate_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.sandbox_integration_candidate_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const gate = new SandboxIntegrationCandidateGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await gate.createCandidateBatch(runId);
    await this.createIntegrationApplyApprovalsIfAllowed(runId, planOnly);
  }

  async createIntegrationApplyApprovalsIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_integration_apply_approval_gate || this.options.config.integration_apply_approval_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "integration_apply_approval_batch_completed",
        lifecycle_stage: "planning",
        summary: "Integration apply approval gate skipped by configuration.",
        reason: "integration_apply_approval_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.integration_apply_approval_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const gate = new IntegrationApplyApprovalGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await gate.createApplyApprovalBatch(runId);
    await this.applyControlledIntegrationIfAllowed(runId, planOnly);
  }

  async applyControlledIntegrationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_controlled_integration_apply || this.options.config.controlled_apply_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "controlled_apply_batch_completed",
        lifecycle_stage: "integrating",
        summary: "Controlled integration apply skipped by configuration.",
        reason: "controlled_integration_apply_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.controlled_apply_mode, plan_only: planOnly, no_apply: true }
      });
      return;
    }
    const manager = new ControlledIntegrationApplyManager({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await manager.applyApprovedIntegrationBatch(runId);
    await this.finalizeIntegrationIfAllowed(runId, planOnly);
  }

  async finalizeIntegrationIfAllowed(runId: string, planOnly: boolean) {
    if (!this.options.config.enable_integration_finalization || this.options.config.integration_finalization_mode === "off") {
      await this.options.traceWriter.write({
        run_id: runId,
        event_type: "integration_finalization_batch_completed",
        lifecycle_stage: "memory_update",
        summary: "Integration finalization skipped by configuration.",
        reason: "integration_finalization_disabled",
        metadata_json: { run_id: runId, mode: this.options.config.integration_finalization_mode, plan_only: planOnly, no_apply: true, no_validation_run: true, no_locks_acquired: true }
      });
      return;
    }
    const manager = new IntegrationFinalizationManager({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      config: this.options.config,
      artifactStore: this.options.artifactStore,
      traceWriter: this.options.traceWriter
    });
    await manager.finalizeControlledApplyBatch(runId);
  }
}
