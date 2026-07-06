import type {
  CommandRequest,
  PatchProposal,
  QualityGateResult,
  ReviewResult,
  WorkerOutput
} from "@hivo/protocol";
import { ReviewerAgent } from "../agents/workers/ReviewerAgent.js";
import { SecurityAgent } from "../agents/workers/SecurityAgent.js";
import type { BranchBankruptcyError } from "../orchestration/CircuitBreaker.js";
import { isThreeJsSnakePrompt, validateThreeJsSnakeProposal } from "../curatedProposals/threeJsSnake.js";
import { randomId } from "./SessionManager.js";

export type SecurityReviewProvider = Pick<SecurityAgent, "review">;
export type AdversarialReviewProvider = Pick<ReviewerAgent, "reviewAdversarial">;

export type OrchestratedReviewInput = {
  sessionId: string;
  prompt: string;
  patches: PatchProposal[];
  commands: CommandRequest[];
  outputs: WorkerOutput[];
  bankruptcyErrors: BranchBankruptcyError[];
  canonicalBlockingReasons: string[];
};

export type OrchestratedReviewOutcome = {
  securityReview: ReviewResult;
  reviewerSummary: ReviewResult;
  qualityGates: QualityGateResult[];
  gatesPassed: boolean;
};

export class OrchestratedReviewService {
  constructor(
    private readonly securityAgent: SecurityReviewProvider = new SecurityAgent(),
    private readonly reviewerAgent: AdversarialReviewProvider = new ReviewerAgent()
  ) {}

  async review(input: OrchestratedReviewInput): Promise<OrchestratedReviewOutcome> {
    const securityReview = this.securityAgent.review(input.sessionId, input.patches, input.commands);
    const canonicalFindings = input.canonicalBlockingReasons.map((reason) => `Canonical graph blocked: ${reason}`);
    const conflictFindings = [
      ...input.bankruptcyErrors.map((error) => `Bankruptcy: ${error.agent_name} - ${error.last_error}`),
      ...canonicalFindings
    ];
    const reviewerSummary = await this.reviewerAgent.reviewAdversarial(
      input.sessionId,
      input.patches,
      input.outputs,
      conflictFindings
    );
    const qualityGates = runQualityGates(
      input.sessionId,
      input.prompt,
      input.patches,
      input.outputs,
      securityReview.status === "passed",
      uniqueStrings([...canonicalFindings, ...reviewerSummary.findings])
    );
    return {
      securityReview,
      reviewerSummary,
      qualityGates,
      gatesPassed: qualityGates.every((gate) => gate.status === "passed")
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function runQualityGates(
  sessionId: string,
  prompt: string,
  patches: PatchProposal[],
  outputs: WorkerOutput[],
  securityPassed: boolean,
  reviewerFindings: string[]
): QualityGateResult[] {
  const createdAt = new Date().toISOString();
  const blockingReasons: string[] = [];
  const reviewerNotes: string[] = [];

  for (const output of outputs) {
    if (output.status !== "completed") {
      blockingReasons.push(`${output.agentName} did not complete: ${output.status}.`);
    }
    if (output.intentHandoffGate?.status !== "passed") {
      blockingReasons.push(`${output.agentName} failed intent handoff gate: ${output.intentHandoffGate?.deterministic_errors.join("; ") ?? "missing gate"}`);
    }
    if (output.selfCheck?.failedCriteria.length || output.selfCheck?.missingItems.length) {
      blockingReasons.push(`${output.agentName} failed self-check: ${[...(output.selfCheck.failedCriteria ?? []), ...(output.selfCheck.missingItems ?? [])].join(", ")}`);
    }
  }

  for (const patch of patches) {
    const artifactText = (patch.artifacts ?? []).map((artifact) => artifact.content).join("\n").toLowerCase();
    if (/mock_orchestrated|representative patch|todo|placeholder/.test(artifactText)) {
      blockingReasons.push(`${patch.title} contains placeholder or representative-only content.`);
    }
    if (isThreeJsSnakePrompt(prompt)) {
      const validation = validateThreeJsSnakeProposal(patch);
      blockingReasons.push(...validation.blockingReasons);
      reviewerNotes.push(...validation.reviewerNotes);
    }
  }

  if (!patches.length) {
    blockingReasons.push("No patch proposal was produced.");
  }
  if (!securityPassed) {
    blockingReasons.push("Security gate did not pass.");
  }
  blockingReasons.push(...reviewerFindings);

  return [
    {
      id: randomId("quality"),
      sessionId,
      gateName: "ReviewerGate",
      status: blockingReasons.length ? "failed" : "passed",
      blockingReasons,
      reviewerNotes: reviewerNotes.length ? reviewerNotes : ["Generated output passed reviewer quality checks."],
      createdAt
    },
    {
      id: randomId("quality"),
      sessionId,
      gateName: "SecurityGate",
      status: securityPassed ? "passed" : "failed",
      blockingReasons: securityPassed ? [] : ["Security review reported blocking findings."],
      reviewerNotes: [securityPassed ? "Security review passed." : "Security review failed."],
      createdAt
    },
    {
      id: randomId("quality"),
      sessionId,
      gateName: "TestGate",
      status: patches.length ? "passed" : "failed",
      blockingReasons: patches.length ? [] : ["No artifact exists to validate."],
      reviewerNotes: [patches.length ? "Patch artifacts are present for validation." : "No patch artifacts were present."],
      createdAt
    }
  ];
}
