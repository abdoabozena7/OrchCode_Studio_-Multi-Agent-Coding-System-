import type {
  AgentAssignmentPlan,
  AgentRuntimeSession,
  IntentContract,
  PreviewRecommendation,
  ProjectMap,
  TaskGraph,
  WorkOrder,
  WorkerOutput
} from "@hivo/protocol";
import path from "node:path";
import type { CanonicalTaskExecutionResult } from "../orchestration/CanonicalOrchestrationGraph.js";
import {
  runQueueSchedulerThroughCanonicalGraph,
  type CanonicalQueueExecutionResult
} from "../orchestration/CanonicalQueueAdapter.js";
import {
  QueueDrivenTaskScheduler
} from "../orchestration/QueueDrivenTaskScheduler.js";
import { OrchestratedSessionRecorder } from "./OrchestratedSessionRecorder.js";
import {
  type OrchestratedQueueWorkerExecution,
  type OrchestratedWorkerExecutionSnapshot
} from "./OrchestratedWorkerExecutionContracts.js";
import { SessionManager } from "./SessionManager.js";

export type OrchestratedQueueExecutionInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  intentContract: IntentContract;
  orchestrationMessage: string;
  projectMap: ProjectMap;
  assignmentPlan: AgentAssignmentPlan;
  workOrders: WorkOrder[];
  taskGraph: TaskGraph;
};

export type OrchestratedQueueExecutionResult = {
  canonicalResult: CanonicalQueueExecutionResult;
  taskExecution: CanonicalTaskExecutionResult;
  outputs: WorkerOutput[];
  previewRecommendation?: PreviewRecommendation;
  lockedFiles: Record<string, string>;
};

type OrchestratedQueueExecutionDependencies = {
  createWorkerExecution?: (sessionManager: SessionManager) => OrchestratedQueueWorkerExecution;
  createScheduler?: (input: OrchestratedQueueExecutionInput) => QueueDrivenTaskScheduler;
  runQueue?: typeof runQueueSchedulerThroughCanonicalGraph;
};

export class OrchestratedQueueExecutionService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recorder = new OrchestratedSessionRecorder(sessionManager),
    private readonly dependencies: OrchestratedQueueExecutionDependencies = {}
  ) {}

  async run(input: OrchestratedQueueExecutionInput): Promise<OrchestratedQueueExecutionResult> {
    const workerExecution = this.dependencies.createWorkerExecution?.(this.sessionManager)
      ?? createUnconfiguredWorkerExecution();
    const scheduler = this.dependencies.createScheduler?.(input)
      ?? createOrchestratedQueueScheduler(input);

    try {
      const handler = workerExecution.createHandler({
        sessionId: input.sessionId,
        session: input.session,
        intentContract: input.intentContract,
        orchestrationMessage: input.orchestrationMessage,
        projectMap: input.projectMap,
        assignmentPlan: input.assignmentPlan,
        workOrders: input.workOrders
      });
      const canonicalResult = await (this.dependencies.runQueue ?? runQueueSchedulerThroughCanonicalGraph)({
        sessionId: input.sessionId,
        taskGraph: input.taskGraph,
        scheduler,
        handler
      });
      const taskExecution = canonicalResult.taskExecution;
      const { outputs, previewRecommendation } = workerExecution.snapshot();
      const lockedFiles = scheduler.lockSnapshot();

      await this.recorder.replayQueueEvents(input.sessionId, scheduler.events);
      for (const bankrupt of taskExecution.bankruptcyErrors) {
        await this.recorder.emit(input.sessionId, "task.failed", `Bankrupt: ${bankrupt.last_error}`, bankrupt.agent_name, bankrupt.branch_id);
      }
      await this.recorder.replayPatchAndCommandRequests(input.sessionId, input.session);

      return {
        canonicalResult,
        taskExecution,
        outputs,
        previewRecommendation,
        lockedFiles
      };
    } finally {
      scheduler.close();
    }
  }
}

export function createOrchestratedQueueScheduler(input: OrchestratedQueueExecutionInput) {
  return new QueueDrivenTaskScheduler(
    {
      queueDir: path.join(input.session.workspacePath, ".agent_memory"),
      workspacePath: input.session.workspacePath,
      sessionId: input.sessionId,
      orchestratorName: "OrchestratedRuntime",
      maxParallelTasks: input.session.orchestration?.safetySettings.maxParallelAgents ?? 1,
      taskQueuePollMs: 5000
    },
    {
      enable_task_queue: true,
      enable_suspend_hydrate: input.session.orchestration?.safetySettings.autoRunSafeCommands ?? false,
      enable_circuit_breaker: true,
      task_queue_max_attempts: 3,
      max_bankruptcy_attempts: 5,
      max_circuit_breaker_duplicate_outputs: 2,
      max_circuit_breaker_stagnant_rounds: 3
    }
  );
}

function createUnconfiguredWorkerExecution(): OrchestratedQueueWorkerExecution {
  return {
    createHandler: () => {
      let attempt = 0;
      return async (task) => {
        attempt += 1;
        return {
          status: "failed",
          outputSummary: `Worker execution is not configured for task ${task.id}.`,
          error: "OrchestratedQueueExecutionService requires an injected provider-backed worker execution service.",
          fingerprint: `worker_unconfigured:${task.id}:${attempt}`
        };
      };
    },
    snapshot: (): OrchestratedWorkerExecutionSnapshot => ({
      outputs: [],
      artifacts: []
    })
  };
}
