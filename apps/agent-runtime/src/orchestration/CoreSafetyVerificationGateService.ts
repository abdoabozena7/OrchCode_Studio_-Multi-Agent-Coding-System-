import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { CommandInventory } from "../memory/types.js";
import { assessApprovalGate } from "./ApprovalGates.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { ProjectGoalSpecStore } from "./GoalSteward.js";
import { createRepairTask, PatchFingerprintTracker } from "./RepairLoop.js";
import {
  IntentHandoffGate,
  intentGateBlockedParsedOutput
} from "./IntentHandoffGate.js";
import type {
  OrchestratorEvent,
  ParsedAgentOutput,
  Run,
  Task
} from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import { validatePatchProposalScope } from "./PatchSafety.js";
import { runReviewLoop } from "./ReviewLoop.js";
import { SemanticConflictResolver } from "./SemanticConflictResolver.js";
import { semanticBatchBlocks } from "./SemanticConflictResolverModels.js";
import { codePatchProposalFromParsedOutput, type VerificationResult } from "./StructuredOutputs.js";
import { TaskGraphManager } from "./TaskGraphManager.js";
import { CoreStructuredOutputValidationService } from "./CoreStructuredOutputValidationService.js";
import { ValidationRunner } from "./ValidationRunner.js";
import { normalizeValidationStatus } from "./ValidationSemantics.js";

export type CoreSafetyVerificationGateInput = {
  run: Run;
  task: Task;
  output: ParsedAgentOutput;
  commandInventory: CommandInventory;
  manager: TaskGraphManager;
  fingerprintTracker: PatchFingerprintTracker;
};

export type CoreSafetyVerificationGateOptions = {
  workspacePath: string;
  memoryDir: string;
  config: OrchestrationSafetyConfig;
  artifactStore: OrchestrationArtifactStore;
  structuredOutputs?: CoreStructuredOutputValidationService;
  providerFactory?: (role: string) => LlmProvider | undefined;
  eventFactory?: (runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string) => OrchestratorEvent;
};

export class CoreSafetyVerificationGateService {
  private readonly structuredOutputs: CoreStructuredOutputValidationService;
  private readonly eventFactory: NonNullable<CoreSafetyVerificationGateOptions["eventFactory"]>;

  constructor(private readonly options: CoreSafetyVerificationGateOptions) {
    this.structuredOutputs = options.structuredOutputs ?? new CoreStructuredOutputValidationService(options.artifactStore);
    this.eventFactory = options.eventFactory ?? defaultEvent;
  }

  async apply(input: CoreSafetyVerificationGateInput): Promise<ParsedAgentOutput> {
    const output = await this.structuredOutputs.validateParsedAgentOutput(input.run, input.task, input.output);
    const intentGate = await this.applyIntentHandoffGate(input.run, input.task, output);
    if (!intentGate.passed) {
      return intentGateBlockedParsedOutput(output, intentGate);
    }

    const semanticGate = await this.applySemanticConflictGate(input.run, input.task, output);
    if (semanticGate) return semanticGate;

    await this.structuredOutputs.recordRoleSpecificStructuredOutput(input.run, input.task, output);
    if (input.task.role_required !== "ExecutorAgent" && input.task.role_required !== "IntegratorAgent") {
      return output;
    }

    const proposal = await this.structuredOutputs.validateCodePatchProposal(input.run, input.task, codePatchProposalFromParsedOutput(input.task.id, output));
    const safety = validatePatchProposalScope({
      workspacePath: this.options.workspacePath,
      task: input.task,
      proposal,
      config: this.options.config
    });
    const patchRef = await this.options.artifactStore.savePatchArtifact(input.run.id, `${input.task.id}_patch_safety`, {
      proposal,
      safety
    });
    output.artifacts.push(patchRef);
    await this.options.artifactStore.appendEvent(this.event(input.run.id, safety.accepted ? "patch.created" : "patch.rejected", safety.accepted ? "Patch safety manifest accepted." : "Patch safety manifest rejected.", {
      patch_ref: patchRef,
      changed_files: safety.changed_files,
      fingerprint: safety.fingerprint,
      reasons: safety.reasons
    }, input.task.id));

    await this.options.artifactStore.appendEvent(this.event(input.run.id, "review.started", `Review started for ${input.task.id}.`, {
      patch_ref: patchRef
    }, input.task.id));
    const review = runReviewLoop({
      task: input.task,
      proposal,
      safety,
      config: this.options.config
    });
    const reviewRef = await this.options.artifactStore.saveReviewArtifact(input.run.id, `${input.task.id}_review`, review);
    output.artifacts.push(reviewRef);
    await this.options.artifactStore.appendEvent(this.event(input.run.id, "review.completed", `Review completed with decision ${review.decision}.`, {
      review_ref: reviewRef,
      decision: review.decision,
      required_changes: review.required_changes,
      scope_violations: review.scope_violations
    }, input.task.id));

    if (review.decision !== "accept") {
      output.status = "failed";
      output.limitations.push(`Review decision: ${review.decision}. ${review.summary}`);
      output.next_recommendations.push("Create or inspect the repair task before integrating this output.");
      await this.maybeCreateRepairTask(input, {
        reason: review.summary,
        required_changes: review.required_changes,
        validation_logs: [],
        previous_patch_fingerprint: safety.fingerprint
      });
      return output;
    }

    const approvalGate = assessApprovalGate({
      task: input.task,
      proposal,
      config: this.options.config
    });
    if (approvalGate.required) {
      const approvalRef = await this.options.artifactStore.saveReviewArtifact(input.run.id, `${input.task.id}_approval_gate`, approvalGate);
      output.artifacts.push(approvalRef);
      output.status = "blocked";
      output.limitations.push(`Human approval required: ${approvalGate.reasons.join(" ")}`);
      output.next_recommendations.push("Approve or narrow the risky task scope before validation and integration.");
      await this.options.artifactStore.appendEvent(this.event(input.run.id, "approval.required", "Human approval gate triggered before validation.", {
        approval_ref: approvalRef,
        reasons: approvalGate.reasons,
        risky_files: approvalGate.risky_files
      }, input.task.id));
      return output;
    }

    if (!safety.changed_files.length) {
      output.next_recommendations.push("No file changes were proposed, so validation commands were recorded but not required for integration.");
      return output;
    }

    const verification = await new ValidationRunner(this.options.workspacePath, this.options.artifactStore, this.options.config).runForTask({
      runId: input.run.id,
      task: input.task,
      commandInventory: input.commandInventory,
      onEvent: async (event) => {
        await this.options.artifactStore.appendEvent(this.event(event.run_id, event.type, event.message, event.payload, event.task_id));
      }
    });
    mergeVerificationIntoOutput(output, verification);
    if (!verification.passed) {
      const validationStatus = verification.validation_status ? normalizeValidationStatus(verification.validation_status) : "failed";
      output.status = validationStatus === "failed" ? "failed" : "blocked";
      output.limitations.push(verification.summary);
      if (validationStatus !== "failed") {
        output.next_recommendations.push("Resolve blocked or incomplete validation before treating this task as complete.");
        return output;
      }
      const repeated = input.fingerprintTracker.recordFailedFingerprint(input.task.id, safety.fingerprint);
      if (repeated) {
        output.limitations.push(`Repeated failed patch fingerprint: ${safety.fingerprint}`);
      } else {
        await this.maybeCreateRepairTask(input, {
          reason: verification.summary,
          required_changes: [`Address failed validation commands: ${verification.failed_commands.join(", ")}`],
          validation_logs: verification.logs_refs,
          previous_patch_fingerprint: safety.fingerprint
        });
      }
    }
    return output;
  }

  private async applyIntentHandoffGate(run: Run, task: Task, output: ParsedAgentOutput) {
    const intentGateService = new IntentHandoffGate({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      provider: this.options.providerFactory?.("IntentReviewer") ?? this.options.providerFactory?.(task.role_required),
      sourceComponent: "CoreSafetyVerificationGateService"
    });
    const intentFrame = await intentGateService.coreFrame(run, task);
    const intentGate = await intentGateService.evaluate({
      runId: run.id,
      runKind: "core",
      artifactsPath: run.artifacts_path,
      layer: "core",
      taskId: task.id,
      frame: intentFrame,
      alignment: output.intent_alignment,
      candidate: output,
      reviewedArtifactRefs: output.artifacts,
      target: "output"
    });
    output.intent_handoff_gate_ref = intentGate.artifact_ref;
    output.intent_handoff_gate_status = intentGate.status;
    return intentGate;
  }

  private async applySemanticConflictGate(run: Run, task: Task, output: ParsedAgentOutput): Promise<ParsedAgentOutput | undefined> {
    const possibleConflicts = output.intent_alignment?.possible_intent_conflicts ?? [];
    if (!possibleConflicts.length || this.options.config.enable_goal_steward === false) return undefined;
    const activeSpec = await new ProjectGoalSpecStore({ workspacePath: this.options.workspacePath, memoryDir: this.options.memoryDir })
      .loadActiveProjectGoalSpec()
      .catch(() => undefined);
    const batch = await new SemanticConflictResolver({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      artifactStore: this.options.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.options.workspacePath, memoryDir: this.options.memoryDir, sourceComponent: "CoreSafetyVerificationGateService.SemanticConflictGate" }),
      provider: this.options.providerFactory?.("SemanticConflictResolver") ?? this.options.providerFactory?.("GoalSteward") ?? this.options.providerFactory?.("IntentReviewer") ?? this.options.providerFactory?.(task.role_required),
      mode: this.options.config.goal_steward_mode ?? "strict"
    }).resolve({
      runId: run.id,
      phase: "review",
      rootIntent: run.user_request,
      intentContractRef: run.intent_contract_ref,
      projectGoalSpec: activeSpec,
      sources: [{
        source_id: task.id,
        source_role: task.role_required,
        summary: output.summary,
        refs: uniqueStrings([task.id, ...output.artifacts]),
        possible_conflicts: possibleConflicts,
        metadata_json: {
          task_title: task.title,
          task_objective: task.objective,
          files_changed: output.files_changed,
          intent_handoff_gate_ref: output.intent_handoff_gate_ref
        }
      }],
      metadata_json: { source_component: "CoreSafetyVerificationGateService.applySemanticConflictGate" }
    });
    output.artifacts.push(...[batch.artifact_ref, batch.summary_ref].filter((ref): ref is string => Boolean(ref)));
    if (!semanticBatchBlocks(batch)) return undefined;
    output.status = "blocked";
    output.limitations.push(`Semantic conflict resolution blocked ${task.id}: ${batch.status}.`);
    output.limitations.push(...batch.decisions.map((decision) => `${decision.conflict}: ${decision.reason}`));
    output.next_recommendations.push("Resolve the semantic conflict or update the intent contract before patch review and integration.");
    return output;
  }

  private async maybeCreateRepairTask(input: {
    run: Run;
    task: Task;
    manager: TaskGraphManager;
  }, failure: {
    reason: string;
    required_changes: string[];
    validation_logs: string[];
    previous_patch_fingerprint?: string;
  }) {
    const repairTask = createRepairTask({
      manager: input.manager,
      originalTask: input.task,
      failure,
      config: this.options.config
    });
    if (!repairTask) {
      await this.options.artifactStore.saveRepairArtifact(input.run.id, `${input.task.id}_repair_limit`, {
        task_id: input.task.id,
        failure,
        reason: "Maximum repair rounds reached."
      });
      return undefined;
    }
    await input.manager.persist();
    const repairRef = await this.options.artifactStore.saveRepairArtifact(input.run.id, repairTask.id, {
      original_task_id: input.task.id,
      repair_task: repairTask,
      failure
    });
    repairTask.artifacts.push(repairRef);
    await this.options.artifactStore.appendEvent(this.event(input.run.id, "repair.task_created", `Repair task created: ${repairTask.id}.`, {
      original_task_id: input.task.id,
      repair_task_id: repairTask.id,
      repair_ref: repairRef
    }, repairTask.id));
    await input.manager.persist();
    return repairTask;
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
    return this.eventFactory(runId, type, message, payload, taskId);
  }
}

function mergeVerificationIntoOutput(output: ParsedAgentOutput, verification: VerificationResult) {
  output.validation_results.push(...verification.commands_run.map((run) => ({
    command: run.command,
    status: run.status,
    summary: `Validation ${run.status}${run.exit_code === undefined ? "" : ` (exit ${run.exit_code ?? "none"})`}.`
      + (run.summary ? ` ${run.summary}` : ""),
    required: run.required,
    log_ref: run.log_ref
  })));
  output.artifacts.push(...verification.logs_refs);
  if (verification.next_action === "no_validation_available") {
    output.limitations.push(verification.summary);
  }
  if (verification.next_action === "manual_review") {
    output.limitations.push(verification.summary);
    output.next_recommendations.push("Manually review blocked validation commands before integration.");
  }
}

function defaultEvent(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
  return {
    id: `event_${randomUUID()}`,
    run_id: runId,
    task_id: taskId,
    type,
    message,
    created_at: new Date().toISOString(),
    payload
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
