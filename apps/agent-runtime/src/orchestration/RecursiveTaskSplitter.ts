import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import type {
  SplitResult,
  SplitSubTask,
  MemoryEvidencePack,
  RecursiveSwarmNode,
  RecursiveSwarmRunOptions
} from "./RecursiveSwarmModels.js";
import { DEFAULT_COMPLEXITY_THRESHOLD } from "./RecursiveSwarmModels.js";

export type RecursiveTaskSplitterOptions = {
  provider?: LlmProvider;
  complexityThreshold?: number;
};

const SPLIT_SYSTEM_PROMPT = `You are a Task Decomposition Specialist.
Your job is to split a complex task into smaller, independent sub-tasks that can be executed in parallel or sequence.

Each sub-task should:
- Be small enough to be handled by a single agent
- Have a clear, unambiguous objective
- Specify its expected output
- Declare dependencies on other sub-tasks (by index)

Respond with JSON: { "subTasks": [{ "title": string, "taskPrompt": string, "expectedOutput": string, "dependencies": string[] }], "rationale": string }`;

export class RecursiveTaskSplitter {
  private readonly provider?: LlmProvider;
  private readonly complexityThreshold: number;

  constructor(options: RecursiveTaskSplitterOptions = {}) {
    this.provider = options.provider;
    this.complexityThreshold = options.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  }

  async splitTask(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions, opts?: { pack?: MemoryEvidencePack }): Promise<SplitResult> {
    if (!this.provider) {
      throw new Error("Recursive task splitting requires a configured provider; deterministic local decomposition is not a runtime fallback.");
    }
    return this.providerSplit(node, runOptions, opts?.pack);
  }

  private async providerSplit(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions, pack?: MemoryEvidencePack): Promise<SplitResult> {
    if (!this.provider) throw new Error("Recursive task splitting provider is not configured.");
    const ctxBlock = this.formatPackForSplit(pack);
    try {
      const response = await invokeReasoningProviderStructured(
        this.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          systemPrompt: SPLIT_SYSTEM_PROMPT + (ctxBlock ? `\n\n${ctxBlock}` : ""),
          userPrompt: `Split the following task into smaller, executable sub-tasks.

TASK: ${node.taskPrompt}
ORIGINAL GOAL: ${node.goalEnvelope.originalGoal}

Each sub-task must include the original goal context so agents don't lose sight of the objective.
Use "dependencies" to reference other sub-tasks by their index (e.g., ["0"] means depends on first sub-task).
Leave dependencies empty [] for tasks that can run in parallel.`,
          responseFormat: "json",
          maxOutputTokens: 1024
        },
        {
          name: "split_result",
          type: "object",
          additionalProperties: false,
          required: ["subTasks", "rationale"],
          properties: {
            subTasks: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "taskPrompt", "expectedOutput", "dependencies"],
                properties: {
                  title: { type: "string" },
                  taskPrompt: { type: "string" },
                  expectedOutput: { type: "string" },
                  dependencies: { type: "array", items: { type: "string" } }
                }
              }
            },
            rationale: { type: "string" }
          }
        }
      );

      const parsed = typeof response === "string"
        ? JSON.parse(response)
        : response;

      const subTasks: SplitSubTask[] = (Array.isArray(parsed.subTasks) ? parsed.subTasks : []).map(
        (sub: Record<string, unknown>, index: number) => ({
          id: `subtask_${randomUUID().slice(0, 8)}`,
          title: String(sub.title ?? `Sub-task ${index + 1}`),
          taskPrompt: String(sub.taskPrompt ?? sub.title ?? ""),
          expectedOutput: String(sub.expectedOutput ?? "Completed work"),
          dependencies: Array.isArray(sub.dependencies)
            ? sub.dependencies.map((dep: unknown) => String(dep))
            : []
        })
      );

      return {
        subTasks,
        rationale: parsed.rationale ?? "Task split by provider."
      };
    } catch (error) {
      throw new Error(`Provider-backed recursive split failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private formatPackForSplit(pack?: MemoryEvidencePack): string {
    if (!pack) return "";
    const lines: string[] = ["=== Memory Evidence Pack ==="];
    if (pack.relevant_files.length) lines.push(`Relevant files: ${pack.relevant_files.slice(0, 6).join(", ")}`);
    if (pack.symbols.length) lines.push(`Symbols: ${pack.symbols.slice(0, 4).join(", ")}`);
    if (pack.commands.length) lines.push(`Known commands: ${pack.commands.slice(0, 4).join(", ")}`);
    if (pack.unknowns.length) lines.push(`Unknowns: ${pack.unknowns.slice(0, 2).join("; ")}`);
    if (pack.warnings.length) lines.push(`Warnings: ${pack.warnings.slice(0, 2).join("; ")}`);
    lines.push(`Confidence: ${pack.confidence.toFixed(2)}, source: ${pack.context_source}`);
    return lines.join("\n");
  }

}
