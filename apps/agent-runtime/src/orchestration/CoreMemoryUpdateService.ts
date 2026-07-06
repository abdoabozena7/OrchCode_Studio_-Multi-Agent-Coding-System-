import {
  appendDecision,
  appendFailedAttempt,
  appendSuccessfulPattern
} from "../memory/ProjectMemory.js";
import type {
  DecisionRecord,
  FailedAttemptRecord,
  SuccessfulPatternRecord
} from "../memory/types.js";
import type { FactoryTraceEventInput } from "./FactoryTraceEvents.js";
import type { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { FinalRunReport, Run } from "./OrchestrationModels.js";
import type { ExecutionMode } from "./OrchestrationConfig.js";

export type CoreMemoryUpdateInput = {
  workspacePath: string;
  memoryDir?: string;
  executionMode: ExecutionMode;
  run: Run;
  report: FinalRunReport;
};

export type CoreMemoryUpdateResult = {
  decision: DecisionRecord;
  successfulPattern?: SuccessfulPatternRecord;
  failedAttempt?: FailedAttemptRecord;
};

type TraceWriterDependency = Pick<FactoryTraceWriter, "write">;

export class CoreMemoryUpdateService {
  constructor(private readonly traceWriter: TraceWriterDependency) {}

  async appendRunHandoff(input: CoreMemoryUpdateInput): Promise<CoreMemoryUpdateResult> {
    await this.writeTrace({
      run_id: input.run.id,
      event_type: "memory_append_started",
      lifecycle_stage: "memory_update",
      summary: "Durable memory append started.",
      artifact_refs: [input.report.artifacts_path],
      metadata_json: { final_status: input.run.status }
    });
    const decision = await appendDecision(input.workspacePath, {
      agent: "CoreOrchestrator",
      summary: `Phase 4 run ${input.run.id} completed with status ${input.run.status}.`,
      rationale: input.report.limitations.join(" ") || "Safety-gated vertical slice completed.",
      relatedFiles: input.report.files_changed,
      tags: ["phase-4", "orchestration-run", "safety-gates", input.executionMode]
    }, input.memoryDir);
    const result: CoreMemoryUpdateResult = { decision };
    if (input.run.status === "succeeded") {
      result.successfulPattern = await appendSuccessfulPattern(input.workspacePath, {
        summary: `Run ${input.run.id} succeeded in ${input.executionMode} mode.`,
        relatedRunIds: [input.run.id],
        relatedFiles: input.report.files_changed,
        tags: ["orchestration-run", input.executionMode]
      }, input.memoryDir);
    } else {
      result.failedAttempt = await appendFailedAttempt(input.workspacePath, {
        summary: `Run ${input.run.id} finished with status ${input.run.status}.`,
        relatedRunId: input.run.id,
        evidence: [input.report.artifacts_path],
        nextAvoidance: input.report.next_recommendations[0]
      }, input.memoryDir);
    }
    await this.writeTrace({
      run_id: input.run.id,
      event_type: "memory_append_completed",
      lifecycle_stage: "memory_update",
      summary: "Durable memory append completed.",
      artifact_refs: [input.report.artifacts_path],
      metadata_json: { final_status: input.run.status }
    });
    return result;
  }

  private async writeTrace(input: FactoryTraceEventInput) {
    await this.traceWriter.write(input);
  }
}
