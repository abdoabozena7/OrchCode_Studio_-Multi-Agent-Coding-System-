import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import type { GoalCheckResult, GoalAlignmentStatus, MemoryEvidencePack, RecursiveSwarmNode } from "./RecursiveSwarmModels.js";

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

  async checkAlignment(node: RecursiveSwarmNode, opts?: { pack?: MemoryEvidencePack }): Promise<GoalCheckResult> {
    if (!this.provider) {
      return this.providerUnavailableCheck("provider_unavailable");
    }
    return this.providerCheck(node, opts?.pack);
  }

  shouldRecheck(lastCheck: GoalCheckResult): boolean {
    const elapsed = Date.now() - new Date(lastCheck.timestamp).getTime();
    return elapsed >= this.checkIntervalMs;
  }

  private async providerCheck(node: RecursiveSwarmNode, pack?: MemoryEvidencePack): Promise<GoalCheckResult> {
    if (!this.provider) return this.providerUnavailableCheck("provider_unavailable");
    const ctxBlock = this.formatPackForCheck(pack);
    try {
      const alignmentCheck = await invokeReasoningProviderStructured(
        this.provider,
        {
          purpose: "verify",
          reasoningStage: "verify",
          systemPrompt: `You are a Goal Keeper for a multi-agent coding system.
Your ONLY responsibility is to verify that a given agent's task remains aligned with the original project goal.
Do not evaluate code quality, correctness, or completeness.
Only check for goal drift, scope creep, or conflicting objectives.
Respond with strict JSON only.${ctxBlock ? `\n\n${ctxBlock}` : ""}`,
          userPrompt: `Compare the ORIGINAL GOAL against the CURRENT TASK and determine alignment.

ORIGINAL GOAL:
${node.goalEnvelope.originalGoal}

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
        checkpoint: "pre_execute" as const,
        aligned: parsed.aligned !== false,
        status: this.determineStatus(parsed),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return this.providerUnavailableCheck("provider_failed", error instanceof Error ? error.message : String(error));
    }
  }

  private providerUnavailableCheck(kind: "provider_unavailable" | "provider_failed", detail?: string): GoalCheckResult {
    return {
      checkpoint: "pre_execute" as const,
      aligned: false,
      status: "unknown",
      findings: [kind],
      warnings: [detail ? `GoalKeeper provider check ${kind}: ${detail}` : "GoalKeeper requires a configured provider; deterministic keyword alignment is not a runtime fallback."],
      timestamp: new Date().toISOString()
    };
  }

  private formatPackForCheck(pack?: MemoryEvidencePack): string {
    if (!pack) return "";
    const lines: string[] = ["=== Memory Evidence Pack ==="];
    if (pack.relevant_files.length) lines.push(`Relevant files: ${pack.relevant_files.slice(0, 6).join(", ")}`);
    if (pack.symbols.length) lines.push(`Symbols: ${pack.symbols.slice(0, 4).join(", ")}`);
    if (pack.warnings.length) lines.push(`Warnings: ${pack.warnings.slice(0, 2).join("; ")}`);
    lines.push(`Confidence: ${pack.confidence.toFixed(2)}, source: ${pack.context_source}`);
    if (pack.freshness_status === "stale") lines.push("WARNING: Evidence may be stale.");
    return lines.join("\n");
  }

  private determineStatus(parsed: Record<string, unknown>): GoalAlignmentStatus {
    if (parsed.status === "aligned" || parsed.aligned === true) return "aligned";
    if (parsed.status === "minor_drift") return "minor_drift";
    if (parsed.status === "major_drift") return "major_drift";
    return "unknown";
  }
}
