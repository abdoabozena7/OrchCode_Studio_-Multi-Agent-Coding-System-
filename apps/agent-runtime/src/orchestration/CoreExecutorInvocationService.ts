import path from "node:path";
import type { AgentRuntimeSession } from "@hivo/protocol";
import { SeniorCodingAgent } from "../agents/SeniorCodingAgent.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { SqliteTaskQueueBackend } from "./AgentTaskQueue.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { ITaskQueueBackend } from "./TaskQueueTypes.js";
import { createAlignmentFromFrame } from "./IntentHandoffGate.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { AgentInvocation, ContextPack, ParsedAgentOutput, Run, Task } from "./OrchestrationModels.js";

type ExecutorQueue = Pick<ITaskQueueBackend, "enqueue" | "dequeue" | "ack" | "nack"> & {
  close?: () => void;
};

export type CoreExecutorInvocationInput = {
  run: Run;
  task: Task;
  pack: ContextPack;
  invocation: AgentInvocation;
};

export type CoreExecutorInvocationDependencies = {
  createQueue?: (queueDir: string) => ExecutorQueue;
  createSessionManager?: (storageDir: string) => SessionManager;
  runSeniorAgent?: (input: {
    provider: LlmProvider;
    sessionManager: SessionManager;
    sessionId: string;
    prompt: string;
  }) => Promise<AgentRuntimeSession>;
};

export class CoreExecutorInvocationService {
  constructor(
    private readonly workspacePath: string,
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly config: Pick<OrchestrationSafetyConfig, "max_attempts_per_task">,
    private readonly providerFactory?: (role: string) => LlmProvider | undefined,
    private readonly dependencies: CoreExecutorInvocationDependencies = {}
  ) {}

  async invoke(input: CoreExecutorInvocationInput): Promise<ParsedAgentOutput> {
    const { run, task, pack, invocation } = input;
    const queue = this.createQueue();
    const queueName = `executor:${run.id}`;
    let dequeued: Awaited<ReturnType<ExecutorQueue["dequeue"]>> | null = null;
    let queueSettled = false;

    try {
      const jobId = await queue.enqueue({
        queue_name: queueName,
        job_type: "agent_task",
        payload: { run_id: run.id, task_id: task.id, invocation_id: invocation.id, prompt: invocation.prompt, role: task.role_required },
        priority: 3,
        max_attempts: this.config.max_attempts_per_task
      });
      invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, { job_id: jobId, status: "queued" });

      dequeued = await queue.dequeue(queueName, 120_000);
      if (!dequeued) {
        throw new Error(`Executor task ${task.id} timed out waiting in queue`);
      }

      const provider = this.providerFactory?.(task.role_required);
      if (!provider) {
        await queue.nack(dequeued.job.id, dequeued.lease_id, "No provider available");
        queueSettled = true;
        throw new Error(`provider_required_for_executor:${task.role_required}`);
      }

      const sessionManager = await this.createLoadedSessionManager(path.join(run.artifacts_path, "runtime_session"));
      const session = await sessionManager.createSession({
        workspacePath: this.workspacePath,
        mode: "real_provider",
        executionMode: "simple_mode",
        userPrompt: invocation.prompt,
        accessProfile: "default_permissions",
        activeProviderSource: "session_override"
      });
      const completed = await this.runSeniorAgent({
        provider,
        sessionManager,
        sessionId: session.id,
        prompt: invocation.prompt
      });
      invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, completed);
      await queue.ack(dequeued.job.id, dequeued.lease_id);
      queueSettled = true;
      return summarizeSeniorSession(completed, task, pack, invocation.raw_output_ref);
    } catch (error) {
      if (dequeued && !queueSettled) {
        await queue.nack(dequeued.job.id, dequeued.lease_id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      }
      throw error;
    } finally {
      queue.close?.();
    }
  }

  private createQueue() {
    const queueDir = path.join(this.workspacePath, ".agent_memory");
    return this.dependencies.createQueue?.(queueDir) ?? new SqliteTaskQueueBackend(queueDir);
  }

  private async createLoadedSessionManager(storageDir: string) {
    const sessionManager = this.dependencies.createSessionManager?.(storageDir)
      ?? new SessionManager(storageDir, new EventBus(), { runtimeEventLoader: async () => [] });
    await sessionManager.load();
    return sessionManager;
  }

  private async runSeniorAgent(input: {
    provider: LlmProvider;
    sessionManager: SessionManager;
    sessionId: string;
    prompt: string;
  }) {
    if (this.dependencies.runSeniorAgent) return this.dependencies.runSeniorAgent(input);
    return new SeniorCodingAgent(input.provider, input.sessionManager).runTurn(input.sessionId, input.prompt);
  }
}

export function summarizeSeniorSession(session: AgentRuntimeSession, task: Task, pack: ContextPack, rawOutputRef: string): ParsedAgentOutput {
  const patchFiles = uniqueStrings(session.patchProposals.flatMap((proposal) => proposal.filesChanged.map((file) => file.path)));
  const outsideScope = patchFiles.filter((file) => task.allowed_files_to_edit.length > 0 && !task.allowed_files_to_edit.includes(file));
  const intentFrame = pack.intent_frame;
  return {
    summary: session.runSummary?.summary ?? session.reasoningSummaries.at(-1) ?? `SeniorCodingAgent finished ${task.id}.`,
    status: session.status === "failed" || outsideScope.length ? "failed" : "succeeded",
    files_changed: patchFiles,
    validation_results: [
      ...pack.validation_requirements.map((command) => ({
        command,
        status: "not_run" as const,
        summary: "Validation selected by context pack; Phase 4 safety runner will execute only allowed safe commands."
      })),
      ...session.commandRequests.map((command) => ({
        command: command.command,
        status: "not_run" as const,
        summary: `Command request recorded with risk ${command.risk}.`
      }))
    ],
    artifacts: [rawOutputRef],
    limitations: [
      seniorSessionProviderTruthLimitation(session),
      ...outsideScope.map((file) => `Proposed file outside allowed scope: ${file}`)
    ],
    next_recommendations: [
      session.nextAction?.message ?? "Review executor output before applying any patch.",
      "Inspect Phase 4 review, validation, and patch safety artifacts before applying changes."
    ],
    intent_alignment: intentFrame ? createAlignmentFromFrame(intentFrame, {
      taskUnderstanding: `ExecutorAgent handled ${task.title}: ${task.objective}`,
      originalGoalContribution: "Executor output is a gated implementation attempt for the current task slice under the compiled intent contract.",
      possibleIntentConflicts: outsideScope.map((file) => `Proposed file outside allowed scope: ${file}`),
      evidenceRefs: [rawOutputRef, intentFrame.intent_contract_ref ?? ""]
    }) : undefined
  };
}

function seniorSessionProviderTruthLimitation(session: AgentRuntimeSession) {
  if (session.mode === "real_provider") {
    return "ExecutorAgent invoked the existing SeniorCodingAgent path with a provider-backed planner; write output remains gated by review, validation, and patch authority.";
  }
  return "ExecutorAgent requires a configured provider-backed SeniorCodingAgent path.";
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
