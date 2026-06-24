import type { LlmProvider } from "../llm/LlmProvider.js";
import type { GoalCheckResult, GoalAlignmentStatus, RecursiveSwarmNode } from "./RecursiveSwarmModels.js";

export type GoalKeeperOptions = {
  provider?: LlmProvider;
  checkIntervalMs?: number;
};

const DEFAULT_CHECK_INTERVAL_MS = 30_000;

export class GoalKeeperAgent {
  private readonly provider?: LlmProvider;
  private readonly checkIntervalMs: number;

  constructor(options: GoalKeeperOptions = {}) {
    this.provider = options.provider;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  }

  async checkAlignment(node: RecursiveSwarmNode): Promise<GoalCheckResult> {
    const result = this.provider
      ? await this.providerCheck(node)
      : this.deterministicCheck(node);
    return result;
  }

  shouldRecheck(lastCheck: GoalCheckResult): boolean {
    const elapsed = Date.now() - new Date(lastCheck.timestamp).getTime();
    return elapsed >= this.checkIntervalMs;
  }

  private async providerCheck(node: RecursiveSwarmNode): Promise<GoalCheckResult> {
    if (!this.provider) return this.deterministicCheck(node);
    try {
      const alignmentCheck = await this.provider.generateStructured(
        {
          systemPrompt: `You are a Goal Keeper for a multi-agent coding system.
Your ONLY responsibility is to verify that a given agent's task remains aligned with the original project goal.
Do not evaluate code quality, correctness, or completeness.
Only check for goal drift, scope creep, or conflicting objectives.
Respond with strict JSON only.`,
          userPrompt: `Compare the ORIGINAL GOAL against the CURRENT TASK and determine alignment.

ORIGINAL GOAL:
${node.originalGoal}

CURRENT TASK (for agent "${node.name}"):
${node.taskPrompt}

Is the current task aligned with the original goal?`,
          responseFormat: "json",
          maxOutputTokens: 256
        },
        {
          name: "goal_check",
          type: "object",
          additionalProperties: false,
          required: ["aligned", "status", "findings", "warnings"],
          properties: {
            aligned: { type: "boolean" },
            status: { type: "string", enum: ["aligned", "minor_drift", "major_drift", "unknown"] },
            findings: { type: "array", items: { type: "string" } },
            warnings: { type: "array", items: { type: "string" } }
          }
        }
      );

      const parsed = typeof alignmentCheck === "string"
        ? JSON.parse(alignmentCheck)
        : alignmentCheck;

      return {
        aligned: parsed.aligned !== false,
        status: this.determineStatus(parsed),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        timestamp: new Date().toISOString()
      };
    } catch {
      return this.deterministicCheck(node);
    }
  }

  private deterministicCheck(node: RecursiveSwarmNode): GoalCheckResult {
    const goalKeywords = this.extractKeywords(node.originalGoal);
    const taskKeywords = this.extractKeywords(node.taskPrompt);
    const matched = goalKeywords.filter((keyword) =>
      taskKeywords.some((taskKeyword) =>
        taskKeyword.includes(keyword) || keyword.includes(taskKeyword)
      )
    );
    const matchRatio = goalKeywords.length > 0
      ? matched.length / goalKeywords.length
      : 1;
    if (matchRatio >= 0.5) {
      return {
        aligned: true,
        status: "aligned",
        findings: [],
        warnings: [],
        timestamp: new Date().toISOString()
      };
    }
    return {
      aligned: false,
      status: "minor_drift",
      findings: [`Task may have drifted from goal (keyword match: ${Math.round(matchRatio * 100)}%)`],
      warnings: ["Consider reviewing whether this sub-task still serves the original goal"],
      timestamp: new Date().toISOString()
    };
  }

  private determineStatus(parsed: Record<string, unknown>): GoalAlignmentStatus {
    if (parsed.status === "aligned" || parsed.aligned === true) return "aligned";
    if (parsed.status === "minor_drift") return "minor_drift";
    if (parsed.status === "major_drift") return "major_drift";
    return "unknown";
  }

  private extractKeywords(text: string): string[] {
    const words = text.toLowerCase()
      .replace(/[^a-zA-Z0-9\u0600-\u06FF\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3);
    return [...new Set(words)];
  }
}
