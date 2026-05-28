import type { ExecutionPreparationPlan } from "./ExecutionPreparationModels.js";
import {
  createPatchProposalFinding,
  createPatchProposalScopeCheck,
  type PatchProposal,
  type PatchProposalFinding,
  type PatchProposalScopeCheck
} from "./PatchProposalModels.js";

export type PatchProposalScopeCheckInput = {
  proposalId: string;
  patchProposal: PatchProposal;
  preparationPlan: ExecutionPreparationPlan;
};

export function checkPatchProposalScope(input: PatchProposalScopeCheckInput): PatchProposalScopeCheck {
  const allowed = new Set(input.preparationPlan.allowed_files.map(normalizePath));
  const forbidden = new Set(input.preparationPlan.forbidden_files.map(normalizePath));
  const findings: PatchProposalFinding[] = [];
  const changed = unique(input.patchProposal.changed_files.map(normalizePath));
  const fileChanges = input.patchProposal.file_changes;
  const explicitDelete = explicitApproval(input.preparationPlan, "delete");
  const explicitRename = explicitApproval(input.preparationPlan, "rename");
  const explicitSensitive = explicitApproval(input.preparationPlan, "sensitive_scope");

  for (const file of changed) {
    if (!allowed.has(file)) {
      findings.push(finding(input.proposalId, "out_of_scope_file", "blocking", `Changed file is outside approved allowed_files: ${file}.`, file));
    } else {
      findings.push(finding(input.proposalId, "allowed_file", "info", `Changed file is inside allowed_files: ${file}.`, file));
    }
    if (forbidden.has(file)) {
      findings.push(finding(input.proposalId, "forbidden_file", "blocking", `Changed file is explicitly forbidden: ${file}.`, file));
    }
    if (isSensitivePath(file) && !explicitSensitive) {
      findings.push(finding(input.proposalId, "sensitive_file_requires_explicit_approval", "blocking", `Sensitive file requires explicit approval scope: ${file}.`, file));
    }
  }

  for (const change of fileChanges) {
    const file = normalizePath(change.path);
    if ((change.change_type === "modify" || change.change_type === "create") && !String(change.proposed_diff ?? "").trim() && !String(change.replacement_snippet_ref ?? "").trim()) {
      findings.push(finding(input.proposalId, "missing_diff", "blocking", `Patch proposal change is missing proposed_diff or replacement_snippet_ref: ${file}.`, file));
    }
    if (change.change_type === "delete" && !explicitDelete) {
      findings.push(finding(input.proposalId, "delete_requires_explicit_approval", "blocking", `Delete proposal requires explicit approval scope: ${file}.`, file));
    }
    if (change.change_type === "rename" && !explicitRename) {
      findings.push(finding(input.proposalId, "rename_requires_explicit_approval", "blocking", `Rename proposal requires explicit approval scope: ${file}.`, file));
    }
    if (isBroadDiff(change.proposed_diff)) {
      findings.push(finding(input.proposalId, "broad_change", "blocking", `Proposed diff looks broad or unbounded: ${file}.`, file));
    }
  }

  const claimText = [
    input.patchProposal.summary,
    ...input.patchProposal.risks,
    ...input.patchProposal.assumptions,
    ...input.patchProposal.validation_recommendations,
    ...input.patchProposal.review_notes
  ].join("\n");
  if (/\b(validation|tests?)\s+(passed|succeeded|green|completed)\b/i.test(claimText)) {
    findings.push(finding(input.proposalId, "claims_validation_passed", "blocking", "Patch proposal claims validation passed even though dry-run validation was not executed."));
  }
  if (/\b(applied|integrated|merged|committed)\b/i.test(claimText)) {
    findings.push(finding(input.proposalId, "claims_patch_applied", "blocking", "Patch proposal claims the patch was applied or integrated."));
  }

  const forbiddenFileViolations = unique(findings.filter((entry) => entry.finding_type === "forbidden_file" && entry.path).map((entry) => entry.path as string));
  const outOfScopeChanges = unique(findings.filter((entry) => entry.finding_type === "out_of_scope_file" && entry.path).map((entry) => entry.path as string));
  const blocking = findings.some((entry) => entry.severity === "blocking");
  return createPatchProposalScopeCheck({
    proposal_id: input.proposalId,
    status: blocking ? "failed" : "passed",
    changed_files: changed,
    allowed_files: [...allowed],
    forbidden_files: [...forbidden],
    forbidden_file_violations: forbiddenFileViolations,
    out_of_scope_changes: outOfScopeChanges,
    findings,
    review_candidate_allowed: !blocking,
    metadata_json: {
      no_patch_applied: true,
      no_integration_candidate_created: true
    }
  });
}

function explicitApproval(plan: ExecutionPreparationPlan, key: "delete" | "rename" | "sensitive_scope") {
  const metadata = plan.metadata_json ?? {};
  const approved = Array.isArray(metadata.explicit_approval_scope) ? metadata.explicit_approval_scope.map(String) : [];
  if (key === "delete") return Boolean(metadata.allow_delete_changes) || approved.includes("delete");
  if (key === "rename") return Boolean(metadata.allow_rename_changes) || approved.includes("rename");
  return Boolean(metadata.allow_sensitive_file_changes) || approved.includes("sensitive_scope");
}

function finding(
  proposalId: string,
  findingType: PatchProposalFinding["finding_type"],
  severity: PatchProposalFinding["severity"],
  message: string,
  path?: string
) {
  return createPatchProposalFinding({
    proposal_id: proposalId,
    finding_type: findingType,
    severity,
    message,
    path,
    refs: path ? [path] : []
  });
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function isSensitivePath(file: string) {
  return /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.toml|Cargo\.lock|Dockerfile|docker-compose\.ya?ml|\.github\/workflows\/|migrations?\/|schema\/|schemas\/|openapi|api\/|security\/|auth\/|\.env)/i.test(file);
}

function isBroadDiff(diff?: string) {
  if (!diff) return false;
  if (/\b(entire repo|all files|global rewrite|replace everything)\b/i.test(diff)) return true;
  const changedLines = diff.split(/\r?\n/).filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;
  return changedLines > 800;
}
