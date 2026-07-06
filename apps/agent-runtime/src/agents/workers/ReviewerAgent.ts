import type { PatchProposal, ReviewResult, TaskNode, WorkerOutput } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";
import { invokeReasoningProviderStructured } from "../../runtime/ReasoningKernel.js";
import { validateReadOnlySwarmOutput, normalizeReadOnlySwarmOutput } from "../../orchestration/ReadOnlySwarmWorkerSchemas.js";
import type { LlmProvider } from "../../llm/LlmProvider.js";

export const ADVERSARIAL_REVIEWER_SYSTEM_PROMPT = `You are an ADMISSIONS-LEVEL code reviewer for a compiler/test system.

RULES (non-negotiable):
1. You do not trust the developer. Assume every output has at least one bug.
2. You MUST output strict JSON matching the adversarial_reviewer_output schema.
3. Every assertion MUST cite a specific file, line range, and the exact code as evidence.
4. If you approve, you MUST list every file examined and at least 3 code quotes proving you read the code.
5. If an assertion is 'critical' or 'high', the decision MUST be 'blocked'.
6. If an assertion is 'medium', the decision MUST be 'changes_required'.
7. If you find zero issues, you MUST still provide code_quotes proving exhaustive review.
8. Generic praise like 'looks good', 'well structured', 'clean code' is FORBIDDEN without specific evidence.
9. You are FORBIDDEN from returning empty assertions + 'approved' without code_quotes.
10. If confidence < 0.7, you MUST escalate (decision='changes_required' with confidence reason).

ADVERSARIAL CHECKLIST (run this against every file):
  - Does the code handle empty/edge/null inputs?
  - Does the code leak secrets, keys, or internal paths?
  - Does the code use eval(), exec(), execSync(), or shell injection patterns?
  - Is there a TOCTOU race condition?
  - Are error paths tested, not just happy paths?
  - Does the code modify files it should not (scope check)?
  - Is there dead code, unused imports, or commented-out logic?
  - Are there hardcoded values that should be config?

OUTPUT ONLY valid JSON. No conversational text, no markdown, no explanations outside the schema.
If you cannot produce valid JSON, output: {"schema":"adversarial_reviewer_output","decision":"blocked","assertions":[{"assertion_type":"maintainability","file_path":"N/A","line_range":[0,0],"severity":"critical","description":"Reviewer failed to produce valid output","evidence":"Structured output validation failed","blocks_approval":true}],"files_examined":[],"lines_of_code_reviewed":0,"tests_checked":[],"code_quotes":[],"confidence":0.0}`;

export type ReviewerProviderInput = {
  patches: PatchProposal[];
  workerOutputs: WorkerOutput[];
  conflictFindings: string[];
  workspacePath: string;
};

export class ReviewerAgent extends BaseWorker {
  readonly agentName = "ReviewerAgent";

  constructor(private readonly llmProvider?: LlmProvider) {
    super();
  }

  async reviewAdversarial(
    sessionId: string,
    patches: PatchProposal[],
    outputs: WorkerOutput[],
    conflictFindings: string[]
  ): Promise<ReviewResult> {
    const provider = this.llmProvider;
    if (!provider) {
      return this.providerBlockedReview(sessionId, patches, outputs, conflictFindings, "No provider configured for adversarial review");
    }

    const input: ReviewerProviderInput = {
      patches,
      workerOutputs: outputs,
      conflictFindings,
      workspacePath: ""
    };

    try {
      const raw = await invokeReasoningProviderStructured<Record<string, unknown>>(provider, {
        purpose: "verify",
        systemPrompt: ADVERSARIAL_REVIEWER_SYSTEM_PROMPT,
        userPrompt: this.buildReviewPrompt(input),
        context: {
          patch_count: patches.length,
          output_count: outputs.length,
          conflict_count: conflictFindings.length
        }
      }, undefined);

      const validation = validateReadOnlySwarmOutput(raw, { name: "adversarial_reviewer_output" });
      if (!validation.valid) {
        const normalization = normalizeReadOnlySwarmOutput(raw, { name: "adversarial_reviewer_output" });
        if (!normalization.validation.valid) {
          return this.providerBlockedReview(sessionId, patches, outputs, conflictFindings,
            `Adversarial reviewer output invalid: ${normalization.validation.errors.join("; ")}`);
        }
        return this.adversarialToReviewResult(sessionId, normalization.value as Record<string, unknown>);
      }
      return this.adversarialToReviewResult(sessionId, raw as Record<string, unknown>);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return this.providerBlockedReview(sessionId, patches, outputs, conflictFindings, `Adversarial reviewer error: ${msg}`);
    }
  }

  private adversarialToReviewResult(sessionId: string, output: Record<string, unknown>): ReviewResult {
    const decision = String(output.decision ?? "blocked");
    const assertions = Array.isArray(output.assertions) ? output.assertions : [];
    const criticalOrHigh = assertions.filter((a: Record<string, unknown>) =>
      a.severity === "critical" || a.severity === "high"
    );
    const medium = assertions.filter((a: Record<string, unknown>) =>
      a.severity === "medium"
    );
    const codeQuotes = Array.isArray(output.code_quotes) ? output.code_quotes as Record<string, unknown>[] : [];

    let status: ReviewResult["status"];
    const allFindings: string[] = assertions.map((a: Record<string, unknown>) =>
      `[${a.severity}] ${a.assertion_type}: ${a.description} (${a.file_path}:${Array.isArray(a.line_range) ? a.line_range.join("-") : "?"})`
    );

    if (criticalOrHigh.length > 0) {
      status = "blocked";
    } else if (medium.length > 0 || decision === "changes_required" || decision === "blocked") {
      status = "needs_changes";
    } else {
      if (codeQuotes.length < 3) {
        status = "needs_changes";
        allFindings.push("Approved without sufficient code evidence (need 3+ code_quotes)");
      } else {
        status = "passed";
      }
    }

    return {
      id: `reviewer_${randomUUID()}`,
      sessionId,
      reviewer: "ReviewerAgent",
      targetIds: [],
      status,
      summary: status === "blocked"
        ? `BLOCKED by adversarial reviewer: ${criticalOrHigh.length} critical/high assertion(s)`
        : status === "needs_changes"
          ? `Changes required: ${allFindings.length} issue(s) found`
          : `Passed adversarial review: ${assertions.length} assertion(s) checked, ${codeQuotes.length} code quotes verified`,
      findings: allFindings,
      createdAt: new Date().toISOString()
    };
  }

  private buildReviewPrompt(input: ReviewerProviderInput): string {
    const sections: string[] = [];

    sections.push("=== PATCHES TO REVIEW ===");
    for (const patch of input.patches) {
      sections.push(`Patch: ${patch.id} - ${patch.title}`);
      sections.push(`  Risk: ${patch.riskLevel}`);
      sections.push(`  Files: ${patch.filesChanged.map((f) => f.path).join(", ")}`);
      sections.push(`  Summary: ${patch.summary}`);
      const artifactContent = (patch.artifacts ?? []).map((a) => a.content).join("\n");
      if (artifactContent) sections.push(`  Content:\n${artifactContent.slice(0, 4000)}`);
    }

    sections.push("\n=== WORKER OUTPUTS ===");
    for (const output of input.workerOutputs) {
      sections.push(`Worker: ${output.agentName} (${output.status})`);
      sections.push(`  Summary: ${output.summary}`);
      sections.push(`  Risks: ${output.risks.join("; ")}`);
      if (output.selfCheck) {
        const failed = output.selfCheck.failedCriteria ?? [];
        const missing = output.selfCheck.missingItems ?? [];
        if (failed.length || missing.length) {
          sections.push(`  Self-check failures: ${[...failed, ...missing].join("; ")}`);
        }
      }
    }

    if (input.conflictFindings.length) {
      sections.push("\n=== CONFLICT FINDINGS ===");
      sections.push(input.conflictFindings.join("\n"));
    }

    sections.push("\n=== ADVERSARIAL REVIEW INSTRUCTIONS ===");
    sections.push("Run the adversarial checklist against EVERY patch file.");
    sections.push("Output strict adversarial_reviewer_output JSON.");
    sections.push("If you find nothing, prove it with code_quotes.");

    return sections.join("\n");
  }

  private providerBlockedReview(
    sessionId: string,
    patches: PatchProposal[],
    outputs: WorkerOutput[],
    conflictFindings: string[],
    reason: string
  ): ReviewResult {
    const findings: string[] = [reason];
    for (const output of outputs) {
      if (output.selfCheck) {
        for (const criterion of output.selfCheck.failedCriteria ?? []) {
          findings.push(`${output.agentName} failed criterion: ${criterion}`);
        }
        for (const item of output.selfCheck.missingItems ?? []) {
          findings.push(`${output.agentName} missing item: ${item}`);
        }
      }
    }
    findings.push(...conflictFindings);
    return {
      id: `reviewer_${randomUUID()}`,
      sessionId,
      reviewer: "ReviewerAgent",
      targetIds: [...patches.map((p) => p.id), ...outputs.map((o) => o.id)],
      status: "blocked",
      summary: `Provider adversarial review blocked: ${reason}`,
      findings,
      createdAt: new Date().toISOString()
    };
  }

  protected execute(_task: TaskNode, _context: WorkerContext) {
    return {
      summary: "Adversarial review prepared.",
      details: ["Provider-backed adversarial code review with strict JSON assertions."],
      risks: []
    };
  }
}
