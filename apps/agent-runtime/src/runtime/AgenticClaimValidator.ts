import { createEvidenceProvenance } from "./EvidenceHygiene.js";
import type {
  AgenticClaim,
  AgenticClaimStatus,
  AgenticEvidenceGraph,
  AgenticFinalOutput,
  AgenticOutputDraft,
  AgenticTaskIntent
} from "./AgenticTaskModels.js";

const HIVO_REF_RE = /\[[^\]]+\]\(hivo-file:([^)\s]+):(\d+)\)/g;
const PLAIN_REF_RE = /\b((?:[A-Za-z0-9_.-]+\/){1,}[A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)\b/g;

export function extractAgenticClaims(text: string): AgenticClaim[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+-\s+|\n\d+\.\s+/)
    .map((sentence) => sentence.replace(/^#+\s*/, "").trim())
    .filter((sentence) => sentence.length > 24)
    .slice(0, 40);
  return sentences.map((sentence, index) => ({
    id: `claim_${index + 1}`,
    text: sentence,
    status: "unknown",
    support: [],
    material: !/\b(I think|likely|probably|opinion|risk|unknown|unclear)\b/i.test(sentence)
  }));
}

export function validateAgenticOutput(input: {
  draft: AgenticOutputDraft;
  intent: AgenticTaskIntent;
  evidenceGraph: AgenticEvidenceGraph;
  fileExists: (relativePath: string) => boolean;
  claimValidationRequired: boolean;
}): AgenticFinalOutput {
  const warnings: string[] = [];
  const claims = input.draft.claims.length ? input.draft.claims : extractAgenticClaims(input.draft.text);
  const validatedClaims = claims.map((claim) => validateClaim(claim, input.evidenceGraph, input.intent));
  let markdown = removeOrQualifyUnsupportedClaims(input.draft.text, validatedClaims, input.intent);
  const citationGuard = validateCitations(markdown, input.intent, input.fileExists);
  markdown = citationGuard.markdown;
  warnings.push(...citationGuard.warnings);
  const unsupportedMaterial = validatedClaims.filter((claim) => claim.material && (claim.status === "unsupported" || claim.status === "contradicted"));
  if (unsupportedMaterial.length) warnings.push(...unsupportedMaterial.map((claim) => `Unsupported material claim removed or qualified: ${claim.text.slice(0, 120)}`));
  const validationStatus = unsupportedMaterial.length
    ? input.claimValidationRequired
      ? "qualified"
      : "valid"
    : citationGuard.blocked
      ? "blocked"
      : "valid";
  return {
    markdown,
    claims: validatedClaims,
    validationStatus,
    warnings: uniqueStrings(warnings),
    citations: citationGuard.citations
  };
}

function validateClaim(claim: AgenticClaim, graph: AgenticEvidenceGraph, intent: AgenticTaskIntent): AgenticClaim {
  if (/\b(opinion|assessment|risk|likely|probably|seems|could|may|weak|reasonable)\b/i.test(claim.text)) {
    return { ...claim, status: "opinion" };
  }
  const claimTokens = meaningfulTokens(claim.text);
  const supports = graph.items
    .map((item) => {
      const overlap = tokenOverlap(claimTokens, meaningfulTokens(`${item.path} ${item.symbol ?? ""} ${item.snippet}`));
      return { item, overlap };
    })
    .filter((entry) => entry.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, 4);
  if (!supports.length) return { ...claim, status: "unsupported", support: [] };
  const productionSupport = supports.filter((entry) => entry.item.canSupportProductionBehavior && entry.item.provenanceStatus === "accepted");
  const best = productionSupport[0] ?? supports[0];
  const status: AgenticClaimStatus = productionSupport.length
    ? "supported"
    : intent.requiresProductionEvidence
      ? "partially_supported"
      : best.overlap >= 2
        ? "supported"
        : "partially_supported";
  return {
    ...claim,
    status,
    support: supports.map((entry) => ({
      evidenceId: entry.item.id,
      ref: `${entry.item.path}:${entry.item.lineStart ?? 1}`,
      status,
      reason: entry.item.relevanceReason
    }))
  };
}

function removeOrQualifyUnsupportedClaims(text: string, claims: AgenticClaim[], intent: AgenticTaskIntent) {
  let result = text;
  for (const claim of claims) {
    if (!claim.material || (claim.status !== "unsupported" && claim.status !== "contradicted")) continue;
    if (!result.includes(claim.text)) continue;
    const replacement = intent.language === "arabic"
      ? "\u0627\u0644\u0623\u062f\u0644\u0629 \u0627\u0644\u0645\u0641\u062a\u0648\u062d\u0629 \u0645\u0634 \u0643\u0627\u0641\u064a\u0629 \u0644\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0646\u0642\u0637\u0629 \u062f\u064a."
      : "The opened evidence is not enough to confirm this point.";
    result = result.replace(claim.text, replacement);
  }
  return result;
}

function validateCitations(markdown: string, intent: AgenticTaskIntent, fileExists: (relativePath: string) => boolean) {
  const warnings: string[] = [];
  const citations: string[] = [];
  let blocked = false;
  const check = (filePath: string, line: string) => {
    const decoded = safeDecode(filePath);
    const provenance = createEvidenceProvenance({ sourceFile: decoded, citedPath: decoded, prompt: intent.topic, fileExists });
    const ref = `${decoded}:${line}`;
    if (!provenance.pathVerification.safePath || !provenance.pathVerification.existsOnDisk) {
      warnings.push(`Rejected fake or missing citation: ${ref}`);
      blocked = true;
      return false;
    }
    if (provenance.sourceType === "fixture_generated_path" && intent.requiresProductionEvidence) {
      warnings.push(`Downgraded fixture-only citation for production claim: ${ref}`);
      return false;
    }
    citations.push(ref);
    return true;
  };
  let result = markdown.replace(HIVO_REF_RE, (full, encodedPath: string, line: string) => {
    return check(encodedPath, line) ? full : `\`${safeDecode(encodedPath)}\``;
  });
  result = result.replace(PLAIN_REF_RE, (full, path: string, line: string) => {
    return check(path, line) ? full : `\`${path}\``;
  });
  return { markdown: result, warnings, citations: uniqueStrings(citations), blocked };
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    return value.replaceAll("\\", "/");
  }
}

function meaningfulTokens(text: string) {
  return uniqueStrings(text.toLowerCase().match(/[a-z0-9_]{3,}|[\u0600-\u06ff]{3,}/g) ?? [])
    .filter((token) => !["the", "and", "this", "that", "with", "from", "project", "code", "here"].includes(token));
}

function tokenOverlap(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.filter((token) => rightSet.has(token)).length;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
