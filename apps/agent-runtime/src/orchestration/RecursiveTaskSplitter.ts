import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type {
  ComplexityAssessment,
  ComplexityScore,
  SplitResult,
  SplitSubTask,
  RecursiveSwarmNode,
  RecursiveSwarmRunOptions
} from "./RecursiveSwarmModels.js";
import { DEFAULT_COMPLEXITY_THRESHOLD } from "./RecursiveSwarmModels.js";

export type RecursiveTaskSplitterOptions = {
  provider?: LlmProvider;
  complexityThreshold?: number;
};

const COMPLEXITY_SYSTEM_PROMPT = `You are a Task Complexity Assessor.
Your job is to evaluate how complex a given task is and whether it should be split into smaller sub-tasks.

Rate complexity 1-10:
1-4: Simple, well-defined, can be executed directly
5-7: Moderate complexity, could be split into 2-4 sub-tasks
8-10: High complexity, should be split into multiple sub-tasks

Consider:
- Scope breadth (how many areas does it touch?)
- Ambiguity (is the expected output clear?)
- Dependencies (does it require multiple steps?)
- Domain knowledge (does it need specialized expertise?)

Respond with JSON: { "score": number, "rationale": string, "recommendation": "split" | "execute" }`;

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

  async assessComplexity(taskPrompt: string, originalGoal: string): Promise<ComplexityAssessment> {
    const result = this.provider
      ? await this.providerAssess(taskPrompt, originalGoal)
      : this.defaultAssessment(taskPrompt);
    return result;
  }

  async splitTask(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions): Promise<SplitResult> {
    const result = this.provider
      ? await this.providerSplit(node, runOptions)
      : this.defaultSplit(node, runOptions);
    return result;
  }

  private async providerAssess(taskPrompt: string, originalGoal: string): Promise<ComplexityAssessment> {
    if (!this.provider) return this.defaultAssessment(taskPrompt);
    try {
      const response = await this.provider.generateStructured(
        {
          systemPrompt: COMPLEXITY_SYSTEM_PROMPT,
          userPrompt: `TASK: ${taskPrompt}\n\nORIGINAL GOAL: ${originalGoal}`,
          responseFormat: "json",
          maxOutputTokens: 256
        },
        {
          name: "complexity_assessment",
          type: "object",
          additionalProperties: false,
          required: ["score", "rationale", "recommendation"],
          properties: {
            score: { type: "number", minimum: 1, maximum: 10 },
            rationale: { type: "string" },
            recommendation: { type: "string", enum: ["split", "execute"] }
          }
        }
      );

      const parsed = typeof response === "string"
        ? JSON.parse(response)
        : response;

      return {
        score: this.clampScore(parsed.score ?? 5),
        rationale: parsed.rationale ?? "Provider assessment completed.",
        recommendation: parsed.recommendation === "execute" ? "execute" : "split"
      };
    } catch {
      return this.defaultAssessment(taskPrompt);
    }
  }

  private async providerSplit(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions): Promise<SplitResult> {
    if (!this.provider) return this.defaultSplit(node, runOptions);
    try {
      const goalContext = runOptions.propagateGoalToAllNodes
        ? `\nORIGINAL GOAL (must be preserved in all sub-tasks): ${node.originalGoal}`
        : "";

      const response = await this.provider.generateStructured(
        {
          systemPrompt: SPLIT_SYSTEM_PROMPT,
          userPrompt: `Split the following task into smaller, executable sub-tasks.

TASK: ${node.taskPrompt}${goalContext}

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
          taskPrompt: runOptions.propagateGoalToAllNodes
            ? `[ORIGINAL GOAL: ${node.originalGoal}]\n\n${String(sub.taskPrompt ?? sub.title ?? "")}`
            : String(sub.taskPrompt ?? sub.title ?? ""),
          expectedOutput: String(sub.expectedOutput ?? "Completed work"),
          dependencies: Array.isArray(sub.dependencies)
            ? sub.dependencies.map((dep: unknown) => String(dep))
            : []
        })
      );

      return {
        subTasks: subTasks.length > 0 ? subTasks : this.defaultSubTasks(node, runOptions),
        rationale: parsed.rationale ?? "Task split by provider."
      };
    } catch {
      return this.defaultSplit(node, runOptions);
    }
  }

  private defaultAssessment(taskPrompt: string): ComplexityAssessment {
    const wordCount = taskPrompt.split(/\s+/).length;
    const hasMultipleSteps = /(first|then|next|after|finally|step\s+\d)/i.test(taskPrompt);
    const hasMultipleFiles = /\.[a-zA-Z]+\s*(,|and)/i.test(taskPrompt);
    const hasTechnicalTerms = /(implement|create|build|design|architect|database|api|endpoint|component|module|service)/i.test(taskPrompt);

    let score: ComplexityScore = 3;
    if (wordCount > 100) score = Math.min(10, Math.max(1, score + 2)) as ComplexityScore;
    if (hasMultipleSteps) score = Math.min(10, score + 2) as ComplexityScore;
    if (hasMultipleFiles) score = Math.min(10, score + 1) as ComplexityScore;
    if (hasTechnicalTerms && wordCount > 50) score = Math.min(10, score + 1) as ComplexityScore;

    return {
      score,
      rationale: `Deterministic assessment: ${wordCount} words, ${hasMultipleSteps ? "multiple steps, " : ""}${hasMultipleFiles ? "multiple files, " : ""}complexity score ${score}/10`,
      recommendation: score >= MIN_COMPLEXITY_FOR_SPLIT ? "split" : "execute"
    };
  }

  private defaultSplit(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions): SplitResult {
    return {
      subTasks: this.defaultSubTasks(node, runOptions),
      rationale: "Default split: task divided by logical sections."
    };
  }

  private defaultSubTasks(node: RecursiveSwarmNode, runOptions: RecursiveSwarmRunOptions): SplitSubTask[] {
    const sections = node.taskPrompt.split(/(?:\n\s*(?:and|also|then|finally)\s+)/i).filter(Boolean);
    if (sections.length <= 1) {
      return [{
        id: `subtask_${randomUUID().slice(0, 8)}`,
        title: `Execute: ${node.name}`,
        taskPrompt: runOptions.propagateGoalToAllNodes
          ? `[ORIGINAL GOAL: ${node.originalGoal}]\n\n${node.taskPrompt}`
          : node.taskPrompt,
        expectedOutput: "Completed task output",
        dependencies: []
      }];
    }
    return sections.map((section, index) => ({
      id: `subtask_${randomUUID().slice(0, 8)}`,
      title: `Part ${index + 1}: ${section.split(/\s+/).slice(0, 6).join(" ")}`,
      taskPrompt: runOptions.propagateGoalToAllNodes
        ? `[ORIGINAL GOAL: ${node.originalGoal}]\n\n${section.trim()}`
        : section.trim(),
      expectedOutput: `Output for part ${index + 1}`,
      dependencies: index > 0 ? [`subtask_${index - 1}`] : []
    }));
  }

  private clampScore(value: number): ComplexityScore {
    return Math.max(1, Math.min(10, Math.round(value))) as ComplexityScore;
  }
}

const MIN_COMPLEXITY_FOR_SPLIT = 5;
