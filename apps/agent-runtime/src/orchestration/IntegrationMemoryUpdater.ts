import {
  appendDecision,
  appendLessonLearned,
  appendRunHistory
} from "../memory/ProjectMemory.js";
import type { ControlledIntegrationApplyResult } from "./ControlledIntegrationApplyModels.js";
import type { IntegrationApplyApproval } from "./IntegrationApplyApprovalModels.js";
import {
  createIntegrationLesson,
  createIntegrationMemoryEntry,
  type IntegrationLesson,
  type IntegrationMemoryEntry
} from "./IntegrationFinalizationModels.js";
import type { SandboxValidatedIntegrationCandidate } from "./SandboxIntegrationCandidateModels.js";

export type IntegrationMemoryUpdaterOptions = {
  workspacePath: string;
  memoryDir?: string;
  createMemoryEntries?: boolean;
  createLessons?: boolean;
};

export type IntegrationMemoryUpdateInput = {
  integration_finalization_id: string;
  result: ControlledIntegrationApplyResult;
  candidate?: SandboxValidatedIntegrationCandidate;
  approval?: IntegrationApplyApproval;
  task_id?: string;
  team_id?: string;
  report_summary_ref?: string;
};

export class IntegrationMemoryUpdater {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly createMemoryEntries: boolean;
  private readonly createLessons: boolean;

  constructor(options: IntegrationMemoryUpdaterOptions) {
    this.workspacePath = options.workspacePath;
    this.memoryDir = options.memoryDir;
    this.createMemoryEntries = options.createMemoryEntries ?? true;
    this.createLessons = options.createLessons ?? true;
  }

  async updateAfterIntegration(input: IntegrationMemoryUpdateInput): Promise<{
    memoryEntries: IntegrationMemoryEntry[];
    lessons: IntegrationLesson[];
  }> {
    const memoryEntries = this.buildMemoryEntries(input);
    const lessons = this.buildLessons(input);
    if (this.createMemoryEntries) {
      await this.persistProjectMemory(input, memoryEntries);
    }
    if (this.createLessons) {
      for (const lesson of lessons) {
        await appendLessonLearned(this.workspacePath, {
          summary: lesson.summary,
          evidence: lesson.evidence_refs,
          relatedRunIds: [input.result.run_id],
          tags: lesson.tags
        }, this.memoryDir);
      }
    }
    return {
      memoryEntries: this.createMemoryEntries ? memoryEntries : [],
      lessons: this.createLessons ? lessons : []
    };
  }

  buildMemoryEntries(input: IntegrationMemoryUpdateInput): IntegrationMemoryEntry[] {
    const { result } = input;
    const base = baseEntry(input);
    const scope = input.task_id ? "task" : input.team_id ? "team" : "run";
    const sourceRefs = sourceRefsFor(input);
    const entries: IntegrationMemoryEntry[] = [
      createIntegrationMemoryEntry({
        ...base,
        scope,
        entry_type: "integration",
        summary: result.status === "post_validation_passed"
          ? `Controlled apply ${result.controlled_apply_id} finalized ${result.applied_files.length} file(s) for proposal ${result.proposal_id}.`
          : `Controlled apply ${result.controlled_apply_id} ended as ${result.status} for proposal ${result.proposal_id}; integration was not marked complete.`,
        source_refs: sourceRefs,
        tags: ["integration-finalization", "controlled-apply", "metadata-only"]
      }),
      createIntegrationMemoryEntry({
        ...base,
        scope,
        entry_type: "validation",
        summary: `Post-apply validation for ${result.controlled_apply_id} ended with strict status ${result.strict_validation_status}.`,
        source_refs: [result.post_validation_result_ref, result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        tags: ["integration-finalization", "validation", result.strict_validation_status]
      }),
      createIntegrationMemoryEntry({
        ...base,
        scope,
        entry_type: "file_summary",
        summary: `Controlled integration affected ${result.changed_files.length} file(s): ${result.changed_files.join(", ") || "none"}.`,
        source_refs: [result.patch_artifact_ref, result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        tags: ["integration-finalization", "changed-files"]
      }),
      createIntegrationMemoryEntry({
        ...base,
        scope,
        entry_type: result.rollback_result_ref ? "failure" : "decision",
        summary: result.rollback_result_ref
          ? `Rollback state recorded for controlled apply ${result.controlled_apply_id}; integration was not marked complete.`
          : `Integration decision recorded as finalized after approved controlled apply and passed strict validation.`,
        source_refs: [result.rollback_result_ref, input.approval?.artifact_ref, result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        tags: ["integration-finalization", result.rollback_result_ref ? "rollback" : "decision"]
      })
    ];
    return entries;
  }

  buildLessons(input: IntegrationMemoryUpdateInput): IntegrationLesson[] {
    const { result } = input;
    const base = {
      integration_finalization_id: input.integration_finalization_id,
      run_id: result.run_id,
      controlled_apply_id: result.controlled_apply_id,
      integration_candidate_id: result.integration_candidate_id
    };
    const lessons = [
      createIntegrationLesson({
        ...base,
        lesson_type: "validation",
        summary: `Keep post-apply validation as the final success proof for controlled apply ${result.controlled_apply_id}.`,
        evidence_refs: [result.post_validation_result_ref, result.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        tags: ["integration-finalization", "validation"]
      }),
      createIntegrationLesson({
        ...base,
        lesson_type: "scope",
        summary: `The controlled apply scope was limited to ${result.changed_files.length} changed file(s).`,
        evidence_refs: [input.candidate?.artifact_ref, input.approval?.artifact_ref].filter((ref): ref is string => Boolean(ref)),
        tags: ["integration-finalization", "scope"]
      }),
      createIntegrationLesson({
        ...base,
        lesson_type: "integration",
        summary: "Finalize integration by recording metadata, memory, and report refs only after strict validation passes.",
        evidence_refs: sourceRefsFor(input),
        tags: ["integration-finalization", "metadata-only"]
      })
    ];
    if (result.rollback_result_ref) {
      lessons.push(createIntegrationLesson({
        ...base,
        lesson_type: "rollback",
        summary: `Rollback was recorded for controlled apply ${result.controlled_apply_id}; do not mark the task integrated.`,
        evidence_refs: [result.rollback_result_ref],
        tags: ["integration-finalization", "rollback"]
      }));
    }
    return lessons;
  }

  private async persistProjectMemory(input: IntegrationMemoryUpdateInput, entries: IntegrationMemoryEntry[]) {
    const { result } = input;
    await appendDecision(this.workspacePath, {
      agent: "IntegrationFinalizationManager",
      summary: `Controlled apply ${result.controlled_apply_id} finalized with strict validation ${result.strict_validation_status}.`,
      rationale: "Finalization consumes approved controlled apply metadata and already-recorded post-apply validation only.",
      relatedFiles: result.changed_files,
      tags: ["integration-finalization", "controlled-apply", result.strict_validation_status]
    }, this.memoryDir);
    await appendRunHistory(this.workspacePath, {
      task: input.task_id ?? result.proposal_id,
      status: result.strict_validation_status === "passed" && result.status === "post_validation_passed" ? "completed" : "blocked",
      summary: entries.map((entry) => entry.summary).join(" "),
      relatedFiles: result.changed_files,
      commands: []
    }, this.memoryDir);
  }
}

function baseEntry(input: IntegrationMemoryUpdateInput) {
  return {
    integration_finalization_id: input.integration_finalization_id,
    run_id: input.result.run_id,
    controlled_apply_id: input.result.controlled_apply_id,
    integration_candidate_id: input.result.integration_candidate_id,
    confidence: 0.95,
    freshness: "fresh" as const,
    artifact_ref: input.report_summary_ref,
    metadata_json: {
      proposal_id: input.result.proposal_id,
      task_id: input.task_id,
      team_id: input.team_id,
      no_provider_writer: true,
      no_patch_generation: true,
      no_validation_run: true
    }
  };
}

function sourceRefsFor(input: IntegrationMemoryUpdateInput) {
  return [
    input.result.artifact_ref,
    input.result.patch_artifact_ref,
    input.result.post_validation_result_ref,
    input.candidate?.artifact_ref,
    input.approval?.artifact_ref,
    input.report_summary_ref
  ].filter((ref): ref is string => Boolean(ref));
}
