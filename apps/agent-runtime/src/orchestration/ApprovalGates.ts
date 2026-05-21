import type { Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { CodePatchProposal } from "./StructuredOutputs.js";

export type ApprovalGateResult = {
  required: boolean;
  reasons: string[];
  risky_files: string[];
};

export function assessApprovalGate(input: {
  task: Task;
  proposal: CodePatchProposal;
  config: OrchestrationSafetyConfig;
}): ApprovalGateResult {
  if (!input.config.require_human_approval_for_risky_files) {
    return { required: false, reasons: [], risky_files: [] };
  }
  const reasons: string[] = [];
  const files = uniqueStrings([...input.proposal.files_to_modify, ...input.task.allowed_files_to_edit]);
  const riskyFiles = files.filter(isRiskyFile);
  if (files.length > input.config.max_files_per_task) {
    reasons.push(`Task touches ${files.length} file(s), above max_files_per_task=${input.config.max_files_per_task}.`);
  }
  if (riskyFiles.length) {
    reasons.push("Patch scope includes risky config, security, deployment, package, or database files.");
  }
  if (/\bdeleted file mode\b|\bdelete\b/i.test(input.proposal.patch_or_diff)) {
    reasons.push("Patch appears to delete files.");
  }
  if (/\bexport\s+(?:class|function|type|interface|const)|pub\s+(?:fn|struct|enum|trait)\b/.test(input.proposal.patch_or_diff)) {
    reasons.push("Patch may change a public API surface.");
  }
  return {
    required: reasons.length > 0,
    reasons,
    risky_files: riskyFiles
  };
}

function isRiskyFile(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(\.github|ci|deploy|deployment|docker|migrations?|schema|auth|security|payment|billing)\b/.test(normalized)
    || /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig[^/]*\.json|tauri\.conf\.json|vite\.config\.[tj]s)$/.test(normalized);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
