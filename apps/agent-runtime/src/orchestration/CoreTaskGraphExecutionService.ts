import {
  runTaskGraphManagerThroughCanonicalGraph,
  type CanonicalTaskGraphManagerExecutionResult
} from "./CanonicalTaskGraphManagerAdapter.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import {
  TaskGraphExecutionLoopService,
  type TaskGraphExecutionLoopInput,
  type TaskGraphExecutionLoopResult
} from "./TaskGraphExecutionLoopService.js";

export type CoreTaskGraphExecutionInput = TaskGraphExecutionLoopInput;

export type CoreTaskGraphExecutionResult = TaskGraphExecutionLoopResult & {
  canonical: CanonicalTaskGraphManagerExecutionResult;
};

export class CoreTaskGraphExecutionService {
  constructor(private readonly artifactStore: OrchestrationArtifactStore) {}

  async execute(input: CoreTaskGraphExecutionInput): Promise<CoreTaskGraphExecutionResult> {
    const outputs: TaskGraphExecutionLoopResult["outputs"] = [];
    let loopResult: TaskGraphExecutionLoopResult | undefined;

    const canonical = await runTaskGraphManagerThroughCanonicalGraph({
      sessionId: input.run.id,
      tasks: input.manager.listTasks(),
      executeTasks: async () => {
        loopResult = await new TaskGraphExecutionLoopService(this.artifactStore).execute(input);
        outputs.push(...loopResult.outputs);
        return loopResult.tasks;
      }
    });

    return {
      canonical,
      outputs,
      tasks: loopResult?.tasks ?? canonical.tasks
    };
  }
}
