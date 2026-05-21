import type { Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { PatchSafetyResult } from "./PatchSafety.js";
import type { CodePatchProposal, ReviewResult } from "./StructuredOutputs.js";
import { validateStructuredOutput } from "./StructuredOutputs.js";

export type OrchestratorReviewDecision =
  | "accept"
  | "request_repair"
  | "reject"
  | "split_task"
  | "require_human_approval";

export type ReviewLoopResult = {
  decision: OrchestratorReviewDecision;
  reviews: ReviewResult[];
  summary: string;
  required_changes: string[];
  scope_violations: string[];
};

export function runReviewLoop(input: {
  task: Task;
  proposal: CodePatchProposal;
  safety: PatchSafetyResult;
  config: Pick<OrchestrationSafetyConfig, "enable_multi_perspective_review" | "max_review_findings">;
}): ReviewLoopResult {
  const reviews = [
    runScopeReview(input.task, input.safety),
    runCodeReview(input.proposal, input.safety)
  ];
  if (shouldRunMultiPerspectiveReview(input.proposal, input.safety, input.config.enable_multi_perspective_review)) {
    reviews.push(...runMultiPerspectiveReview(input.proposal, input.safety));
  }
  for (const review of reviews) {
    const validation = validateStructuredOutput("ReviewResult", review);
    if (!validation.valid) {
      throw new Error(`ReviewResult validation failed: ${validation.errors.join("; ")}`);
    }
  }
  return consolidateReviewResults(reviews, input.config.max_review_findings);
}

export function runScopeReview(task: Task, safety: PatchSafetyResult): ReviewResult {
  const findings = [
    ...safety.reasons,
    ...safety.warnings
  ];
  if (!safety.changed_files.length) {
    findings.push("No file changes were proposed.");
  }
  if (task.role_required === "ExecutorAgent" && !task.allowed_files_to_edit.length && safety.changed_files.length) {
    findings.push("Read-only executor task proposed file changes.");
  }
  return {
    decision: safety.accepted ? "accept" : "request_changes",
    severity: safety.forbidden_violations.length ? "critical" : safety.scope_violations.length ? "high" : safety.accepted ? "low" : "medium",
    findings,
    required_changes: safety.accepted ? [] : ["Constrain the patch to the task allowed edit scope and remove forbidden file changes."],
    scope_violations: safety.scope_violations,
    confidence: 0.95
  };
}

export function runCodeReview(proposal: CodePatchProposal, safety: PatchSafetyResult): ReviewResult {
  const findings: string[] = [];
  const requiredChanges: string[] = [];
  const diff = proposal.patch_or_diff.toLowerCase();
  if (/\beval\s*\(|new function\s*\(/.test(diff)) {
    findings.push("Patch introduces dynamic code execution.");
    requiredChanges.push("Remove dynamic code execution unless explicitly approved.");
  }
  if (/process\.env|api[_-]?key|secret|password/.test(diff) && !proposal.files_to_modify.some((file) => /config|env|settings/i.test(file))) {
    findings.push("Patch appears to touch sensitive configuration or secret-like values.");
    requiredChanges.push("Avoid introducing or logging secrets.");
  }
  if (safety.patch_bytes > 80_000) {
    findings.push("Patch is large enough to deserve a split task review.");
    requiredChanges.push("Split the patch into smaller task-scoped changes.");
  }
  if (!proposal.validation_suggestions.length && safety.changed_files.length) {
    findings.push("Patch has no validation suggestions.");
    requiredChanges.push("Add targeted validation suggestions.");
  }
  return {
    decision: requiredChanges.length ? "request_changes" : "accept",
    severity: findings.some((finding) => finding.includes("dynamic code")) ? "critical" : requiredChanges.length ? "medium" : "low",
    findings,
    required_changes: requiredChanges,
    scope_violations: [],
    confidence: requiredChanges.length ? 0.75 : 0.65
  };
}

export function runMultiPerspectiveReview(proposal: CodePatchProposal, safety: PatchSafetyResult): ReviewResult[] {
  return [
    perspectiveReview("security", proposal, safety),
    perspectiveReview("performance", proposal, safety),
    perspectiveReview("maintainability", proposal, safety),
    perspectiveReview("test coverage", proposal, safety)
  ];
}

export function consolidateReviewResults(reviews: ReviewResult[], maxFindings = 20): ReviewLoopResult {
  const scopeViolations = uniqueStrings(reviews.flatMap((review) => review.scope_violations));
  const requiredChanges = uniqueStrings(reviews.flatMap((review) => review.required_changes)).slice(0, maxFindings);
  const severities = reviews.map((review) => review.severity);
  let decision: OrchestratorReviewDecision = "accept";
  if (reviews.some((review) => review.decision === "reject") || severities.includes("critical")) {
    decision = scopeViolations.length ? "reject" : "require_human_approval";
  } else if (reviews.some((review) => review.decision === "split_task")) {
    decision = "split_task";
  } else if (reviews.some((review) => review.decision === "request_changes")) {
    decision = "request_repair";
  }
  const findings = uniqueStrings(reviews.flatMap((review) => review.findings)).slice(0, maxFindings);
  return {
    decision,
    reviews,
    summary: findings.length ? findings.join(" ") : "Review accepted without findings.",
    required_changes: requiredChanges,
    scope_violations: scopeViolations
  };
}

function shouldRunMultiPerspectiveReview(proposal: CodePatchProposal, safety: PatchSafetyResult, enabled: boolean) {
  return enabled || safety.changed_files.length > 3 || safety.patch_bytes > 20_000 || proposal.risks.length > 2;
}

function perspectiveReview(perspective: "security" | "performance" | "maintainability" | "test coverage", proposal: CodePatchProposal, safety: PatchSafetyResult): ReviewResult {
  const findings: string[] = [];
  const requiredChanges: string[] = [];
  if (perspective === "security" && /token|secret|password|api[_-]?key/i.test(proposal.patch_or_diff)) {
    findings.push("Security perspective found secret-like text in the patch.");
    requiredChanges.push("Remove secret-like text and verify no credentials are stored.");
  }
  if (perspective === "performance" && safety.changed_files.length > 6) {
    findings.push("Performance perspective flags broad file coverage as risky.");
    requiredChanges.push("Narrow the patch or justify broad changes.");
  }
  if (perspective === "maintainability" && proposal.patch_or_diff.split(/\r?\n/).length > 600) {
    findings.push("Maintainability perspective flags a large patch.");
    requiredChanges.push("Split the change into smaller tasks.");
  }
  if (perspective === "test coverage" && safety.changed_files.length && !proposal.validation_suggestions.length) {
    findings.push("Test coverage perspective found no validation suggestions.");
    requiredChanges.push("Add at least one relevant validation command.");
  }
  return {
    decision: requiredChanges.length ? "request_changes" : "accept",
    severity: perspective === "security" && requiredChanges.length ? "high" : requiredChanges.length ? "medium" : "low",
    findings,
    required_changes: requiredChanges,
    scope_violations: [],
    confidence: 0.6
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
