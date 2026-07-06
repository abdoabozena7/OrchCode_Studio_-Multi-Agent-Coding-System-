import type { EditIntent, MemoryEvidencePack } from "./RecursiveSwarmModels.js";
import { buildSurgicalPatch, type SurgicalPatchBuildResult } from "./SurgicalPatchBuilder.js";
import type { PatchProposal, CommandExecutionRecord } from "@hivo/protocol";

export const MAX_REPAIR_ATTEMPTS = 2;

export type RepairDiagnosis = {
  canRepair: boolean;
  repairIntent?: EditIntent;
  reason: string;
  diagnostics: string[];
};

export type RepairAttempt = {
  attemptNumber: number;
  patchCandidateId: string;
  buildResult: SurgicalPatchBuildResult;
  diagnostics: string[];
};

export type RepairLoopResult = {
  repairAttempts: RepairAttempt[];
  finalPatchCandidates: PatchProposal[];
  unresolvedBlockers: string[];
  diagnostics: string[];
};

export function diagnoseRepairNeeded(
  proposal: PatchProposal,
  commandResults: CommandExecutionRecord[],
  originalEditIntent: EditIntent,
  evidencePack: MemoryEvidencePack | undefined
): RepairDiagnosis {
  const failedCommands = commandResults.filter(
    (r) => r.status === "failed" || (r.exitCode !== undefined && r.exitCode !== 0)
  );

  if (failedCommands.length === 0) {
    return { canRepair: false, reason: "No failed validation commands", diagnostics: [] };
  }

  // Check for broad/risky repair — only allow if the failure is scoped
  if (originalEditIntent.risk === "high") {
    return {
      canRepair: false,
      reason: "High-risk edit intent failed validation — repair requires operator review",
      diagnostics: ["High-risk repair blocked"]
    };
  }

  if (originalEditIntent.operation === "refactor") {
    return {
      canRepair: false,
      reason: "Refactor operation failed validation — repair requires operator review",
      diagnostics: ["Refactor repair blocked"]
    };
  }

  // Check if the failure output gives us a scoped fix opportunity
  const allOutput = failedCommands.map((r) => `${r.stdout}\n${r.stderr}`).join("\n").toLowerCase();
  const scopedFailurePatterns = [
    "error:", "failed:", "cannot find", "type error", "undefined",
    "expected", "unexpected token", "missing", "not a function",
    "cannot read property", "is not defined"
  ];
  const hasScopedFailure = scopedFailurePatterns.some((p) => allOutput.includes(p));
  if (!hasScopedFailure) {
    return {
      canRepair: false,
      reason: "Validation failure output does not contain scoped fix patterns",
      diagnostics: ["Unscoped repair blocked"]
    };
  }

  // Extract key evidence from failure output to guide repair
  const diagnostics: string[] = [];
  for (const r of failedCommands) {
    diagnostics.push(`Command "${r.command}" exited with code ${r.exitCode ?? "unknown"}`);
    const lines = (r.stderr || r.stdout).split("\n").filter((l) => l.length > 0).slice(0, 3);
    diagnostics.push(`  Output: ${lines.join("; ").slice(0, 200)}`);
  }

  // Create a repair EditIntent — scoped to same file, higher precision
  const repairIntent: EditIntent = {
    kind: "edit_intent",
    target_file: originalEditIntent.target_file,
    target_symbol_or_range: originalEditIntent.target_symbol_or_range,
    operation: originalEditIntent.operation,
    reason: `Repair: ${originalEditIntent.reason} (validation failed: ${failedCommands.map((r) => r.command).join(", ")})`,
    expected_behavior: `Repair validation failure: ${originalEditIntent.expected_behavior}`,
    risk: "low", // Downgrade to low for repair attempts
    evidence_refs: [
      ...originalEditIntent.evidence_refs,
      ...failedCommands.map((r) => `cmd_output:${r.id}`)
    ]
  };

  return {
    canRepair: true,
    repairIntent,
    reason: `Repair needed: ${failedCommands.length} command(s) failed`,
    diagnostics
  };
}

export function runRepairLoop(
  originalProposal: PatchProposal,
  originalEditIntent: EditIntent,
  evidencePack: MemoryEvidencePack | undefined,
  commandResults: CommandExecutionRecord[],
  workspacePath: string,
  currentFileContent: string,
  allowedPaths: string[],
  forbiddenPaths: string[]
): RepairLoopResult {
  const repairAttempts: RepairAttempt[] = [];
  const diagnostics: string[] = [];

  const diagnosis = diagnoseRepairNeeded(originalProposal, commandResults, originalEditIntent, evidencePack);
  diagnostics.push(...diagnosis.diagnostics);

  if (!diagnosis.canRepair || !diagnosis.repairIntent) {
    return {
      repairAttempts: [],
      finalPatchCandidates: [],
      unresolvedBlockers: [diagnosis.reason],
      diagnostics
    };
  }

  // Run bounded repair attempts
  let currentFileContent_ = currentFileContent;
  let lastProposal = originalProposal;

  for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
    const builderResult = buildSurgicalPatch({
      editIntent: diagnosis.repairIntent,
      evidencePack,
      workspacePath,
      currentFileContent: currentFileContent_,
      allowedPaths,
      forbiddenPaths
    });

    diagnostics.push(...builderResult.diagnostics);
    repairAttempts.push({
      attemptNumber: attempt,
      patchCandidateId: builderResult.status === "real_diff" ? builderResult.patchCandidateId : "repair_failed",
      buildResult: builderResult,
      diagnostics: builderResult.diagnostics
    });

    if (builderResult.status === "real_diff") {
      const repairProposal: PatchProposal = {
        ...lastProposal,
        id: builderResult.patchCandidateId,
        unifiedDiff: builderResult.unifiedDiff,
        summary: `Repair attempt ${attempt}: ${builderResult.summary}`,
        status: "proposed",
        requiresApproval: true,
        createdAt: new Date().toISOString()
      };
      return {
        repairAttempts,
        finalPatchCandidates: [repairProposal],
        unresolvedBlockers: [],
        diagnostics
      };
    }

    if (builderResult.status === "blocked") {
      diagnostics.push(`Repair attempt ${attempt} blocked: ${builderResult.reason}`);
      break;
    }

    // needs_patch_generation — could try once more with different strategy
    if (attempt < MAX_REPAIR_ATTEMPTS) {
      diagnostics.push(`Repair attempt ${attempt} needs generation — retrying`);
    }
  }

  return {
    repairAttempts,
    finalPatchCandidates: [],
    unresolvedBlockers: [`Repair failed after ${repairAttempts.length} attempt(s)`],
    diagnostics
  };
}
