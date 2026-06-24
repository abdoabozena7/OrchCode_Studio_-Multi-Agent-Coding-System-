import type { LlmProvider } from "../llm/LlmProvider.js";
import type {
  CollectResult,
  RecursiveSwarmNode
} from "./RecursiveSwarmModels.js";

export type HierarchicalCollectorOptions = {
  provider?: LlmProvider;
  enableErrorRecovery?: boolean;
};

export class HierarchicalCollector {
  private readonly provider?: LlmProvider;
  private readonly enableErrorRecovery: boolean;

  constructor(options: HierarchicalCollectorOptions = {}) {
    this.provider = options.provider;
    this.enableErrorRecovery = options.enableErrorRecovery ?? true;
  }

  async collect(children: RecursiveSwarmNode[], parentGoal: string): Promise<CollectResult> {
    const childResults: Record<string, string> = {};
    const errors: string[] = [];
    const resolvedErrors: string[] = [];
    const unresolvedErrors: string[] = [];

    for (const child of children) {
      if (child.outputSummary) {
        childResults[child.id] = child.outputSummary;
      }
      if (child.errorSummary) {
        errors.push(`[${child.name}] ${child.errorSummary}`);
      }
      if (child.status === "failed") {
        errors.push(`[${child.name}] Failed with status: failed`);
      }
      if (child.collectResult?.unresolvedErrors) {
        unresolvedErrors.push(...child.collectResult.unresolvedErrors);
      }
    }

    for (const error of errors) {
      if (this.enableErrorRecovery) {
        const resolution = await this.tryResolveError(error, parentGoal);
        if (resolution) {
          resolvedErrors.push(`${error} -> ${resolution}`);
        } else {
          unresolvedErrors.push(error);
        }
      } else {
        unresolvedErrors.push(error);
      }
    }

    const mergedOutput = this.provider
      ? await this.providerMerge(childResults, parentGoal)
      : this.defaultMerge(childResults);

    const totalChildren = children.length;
    const successCount = children.filter(
      (child) => child.status === "succeeded" && !child.errorSummary
    ).length;

    return {
      childResults,
      mergedOutput,
      errors,
      resolvedErrors,
      unresolvedErrors,
      confidence: totalChildren > 0 ? successCount / totalChildren : 0
    };
  }

  private async providerMerge(
    childResults: Record<string, string>,
    parentGoal: string
  ): Promise<string> {
    if (!this.provider) return this.defaultMerge(childResults);
    try {
      const entries = Object.entries(childResults);
      if (!entries.length) return "No child results to merge.";

      const resultsText = entries
        .map(([id, output], index) => `--- Result ${index + 1} (${id}) ---\n${output}`)
        .join("\n\n");

      const response = await this.provider.generateText({
        systemPrompt: `You are a Result Merger for a hierarchical multi-agent system.
Your job is to merge multiple result fragments into a coherent, non-redundant summary.
Preserve all important details while removing duplication.
Keep the result aligned with the original goal.`,
        userPrompt: `Original Goal: ${parentGoal}

Results to merge:
${resultsText}

Merge these results into a coherent summary that preserves all key information and stays aligned with the original goal.`,
        maxOutputTokens: 2048
      });

      return typeof response === "string" ? response : "Provider merge completed.";
    } catch {
      return this.defaultMerge(childResults);
    }
  }

  private defaultMerge(childResults: Record<string, string>): string {
    const entries = Object.entries(childResults);
    if (!entries.length) return "No results to merge.";

    return entries
      .map(([, output], index) => `[Part ${index + 1}]\n${output}`)
      .join("\n\n");
  }

  private async tryResolveError(error: string, parentGoal: string): Promise<string | null> {
    if (!this.provider) {
      if (error.includes("Failed")) {
        return "Marked as non-blocking failure for continuation.";
      }
      return null;
    }

    try {
      const response = await this.provider.generateText({
        systemPrompt: `You are an Error Resolver for a multi-agent system.
Given an error from a sub-agent, determine if it can be safely ignored, worked around, or needs human intervention.
Respond with a resolution strategy.`,
        userPrompt: `Parent Goal: ${parentGoal}

Error: ${error}

Can this error be resolved automatically? If yes, describe the resolution. If not, say "UNRESOLVABLE".`,
        maxOutputTokens: 256
      });

      const text = typeof response === "string" ? response : String(response);
      if (text.includes("UNRESOLVABLE")) return null;
      return text.slice(0, 200);
    } catch {
      return null;
    }
  }
}
