import {
  createPatchProposalReviewFinding,
  type PatchProposalReviewDecision,
  type PatchProposalReviewFinding,
  type ReviewCategory,
  type ReviewSeverity
} from "./PatchProposalReviewModels.js";

export type ParsedPatchProposalReviewOutput = {
  decision: PatchProposalReviewDecision;
  findings: PatchProposalReviewFinding[];
  required_changes: string[];
  validation_recommendations: string[];
  integration_risks: string[];
  security_risks: string[];
  performance_risks: string[];
  test_coverage_risks: string[];
  confidence: number;
};

const DECISIONS: PatchProposalReviewDecision[] = [
  "accept_for_validation_candidate",
  "request_changes",
  "reject",
  "block",
  "split_further",
  "require_human_approval"
];

const CATEGORIES: ReviewCategory[] = [
  "correctness",
  "scope",
  "architecture",
  "security",
  "performance",
  "validation",
  "test_coverage",
  "integration",
  "maintainability",
  "style",
  "risk",
  "unknown"
];

const SEVERITIES: ReviewSeverity[] = ["info", "low", "medium", "high", "critical"];

export function parsePatchProposalReviewOutput(raw: string, reviewId: string): ParsedPatchProposalReviewOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Review output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePatchProposalReviewOutput(value, reviewId);
}

export function validatePatchProposalReviewOutput(value: unknown, reviewId: string): ParsedPatchProposalReviewOutput {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) throw new Error("Review output must be an object.");
  const decision = String(record.decision ?? "");
  if (!DECISIONS.includes(decision as PatchProposalReviewDecision)) throw new Error("Review output decision is invalid.");
  for (const key of ["findings", "required_changes", "validation_recommendations", "integration_risks", "security_risks", "performance_risks", "test_coverage_risks"]) {
    if (!Array.isArray(record[key])) throw new Error(`Review output missing array ${key}.`);
  }
  const confidence = Number(record.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Review output confidence must be a number between 0 and 1.");
  const findings = (record.findings as unknown[]).map((entry, index) => parseFinding(entry, reviewId, index));
  return {
    decision: decision as PatchProposalReviewDecision,
    findings,
    required_changes: (record.required_changes as unknown[]).map(String),
    validation_recommendations: (record.validation_recommendations as unknown[]).map(String),
    integration_risks: (record.integration_risks as unknown[]).map(String),
    security_risks: (record.security_risks as unknown[]).map(String),
    performance_risks: (record.performance_risks as unknown[]).map(String),
    test_coverage_risks: (record.test_coverage_risks as unknown[]).map(String),
    confidence
  };
}

function parseFinding(value: unknown, reviewId: string, index: number) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!record) throw new Error(`findings[${index}] must be an object.`);
  const category = String(record.category ?? "unknown");
  const severity = String(record.severity ?? "");
  if (!CATEGORIES.includes(category as ReviewCategory)) throw new Error(`findings[${index}].category is invalid.`);
  if (!SEVERITIES.includes(severity as ReviewSeverity)) throw new Error(`findings[${index}].severity is invalid.`);
  if (typeof record.message !== "string" || !record.message.trim()) throw new Error(`findings[${index}].message is required.`);
  if (typeof record.blocking !== "boolean") throw new Error(`findings[${index}].blocking is required.`);
  return createPatchProposalReviewFinding({
    review_id: reviewId,
    category: category as ReviewCategory,
    severity: severity as ReviewSeverity,
    message: record.message,
    file: typeof record.file === "string" ? record.file : undefined,
    suggested_change: typeof record.suggested_change === "string" ? record.suggested_change : undefined,
    blocking: record.blocking,
    evidence_ref: typeof record.evidence_ref === "string" ? record.evidence_ref : undefined
  });
}
