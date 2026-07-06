import { randomUUID } from "node:crypto";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type {
  OrchestratorEvent,
  ParsedAgentOutput,
  Run,
  Task
} from "./OrchestrationModels.js";
import {
  repairStructuredOutput,
  scoutResultFromParsedOutput,
  validateStructuredOutput,
  type CodePatchProposal
} from "./StructuredOutputs.js";

export class CoreStructuredOutputValidationService {
  constructor(private readonly artifactStore: OrchestrationArtifactStore) {}

  async validateParsedAgentOutput(run: Run, task: Task, output: ParsedAgentOutput): Promise<ParsedAgentOutput> {
    const validation = validateStructuredOutput("ParsedAgentOutput", output);
    if (validation.valid) {
      await this.artifactStore.appendEvent(this.event(run.id, "agent.output_parsed", `Parsed output validated for ${task.id}.`, {
        schema: "ParsedAgentOutput"
      }, task.id));
      return output;
    }
    const invalidRef = await this.artifactStore.saveRawOutput(run.id, `${task.id}_invalid_parsed_output`, {
      output,
      validation_errors: validation.errors
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_validation_failed", `Parsed output validation failed for ${task.id}.`, {
      raw_output_ref: invalidRef,
      validation_errors: validation.errors
    }, task.id));
    const repair = repairStructuredOutput<ParsedAgentOutput>("ParsedAgentOutput", output, validation.errors);
    const repairedRef = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_repaired_parsed_output`, {
      repair_prompt: repair.repair_prompt,
      repaired: repair.repaired,
      validation: repair.validation
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_repaired", `Parsed output repair ${repair.validation.valid ? "succeeded" : "failed"} for ${task.id}.`, {
      repaired_output_ref: repairedRef
    }, task.id));
    if (!repair.repaired) {
      return {
        summary: `Invalid parsed output: ${validation.errors.join("; ")}`,
        status: "failed",
        files_changed: [],
        validation_results: [],
        artifacts: [invalidRef, repairedRef],
        limitations: validation.errors,
        next_recommendations: ["Inspect raw and repaired output artifacts."]
      };
    }
    repair.repaired.artifacts.push(invalidRef, repairedRef);
    return repair.repaired;
  }

  async validateCodePatchProposal(run: Run, task: Task, proposal: CodePatchProposal): Promise<CodePatchProposal> {
    const validation = validateStructuredOutput("CodePatchProposal", proposal);
    if (validation.valid) return proposal;
    const invalidRef = await this.artifactStore.saveRawOutput(run.id, `${task.id}_invalid_patch_proposal`, {
      proposal,
      validation_errors: validation.errors
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_validation_failed", `CodePatchProposal validation failed for ${task.id}.`, {
      raw_output_ref: invalidRef,
      validation_errors: validation.errors
    }, task.id));
    const repair = repairStructuredOutput<CodePatchProposal>("CodePatchProposal", proposal, validation.errors);
    const repairedRef = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_repaired_patch_proposal`, {
      repair_prompt: repair.repair_prompt,
      repaired: repair.repaired,
      validation: repair.validation
    });
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_repaired", `CodePatchProposal repair ${repair.validation.valid ? "succeeded" : "failed"} for ${task.id}.`, {
      repaired_output_ref: repairedRef
    }, task.id));
    if (!repair.repaired) throw new Error(`CodePatchProposal validation failed: ${validation.errors.join("; ")}`);
    return repair.repaired;
  }

  async recordRoleSpecificStructuredOutput(run: Run, task: Task, output: ParsedAgentOutput) {
    if (task.role_required !== "ScoutAgent") return;
    const scout = scoutResultFromParsedOutput(output, task.relevant_files);
    const validation = validateStructuredOutput("ScoutResult", scout);
    if (!validation.valid) throw new Error(`ScoutResult validation failed: ${validation.errors.join("; ")}`);
    const ref = await this.artifactStore.saveParsedOutput(run.id, `${task.id}_scout_result`, scout);
    output.artifacts.push(ref);
    await this.artifactStore.appendEvent(this.event(run.id, "agent.output_parsed", "Validated ScoutResult.", {
      schema: "ScoutResult",
      parsed_output_ref: ref
    }, task.id));
  }

  private event(runId: string, type: OrchestratorEvent["type"], message: string, payload?: Record<string, unknown>, taskId?: string): OrchestratorEvent {
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
}
