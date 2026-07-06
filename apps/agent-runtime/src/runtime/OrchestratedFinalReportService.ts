import type {
  AgentRuntimeSession,
  PatchChangeStats,
  QualityGateResult,
  RunSummary
} from "@hivo/protocol";
import { getPatchStatsFromPatch } from "./AgentTelemetry.js";

export type OrchestratedFinalReportInput = {
  session: AgentRuntimeSession;
  qualityGates: QualityGateResult[];
  gatesPassed: boolean;
  appliedTitles?: string[];
};

export type OrchestratedFinalReport = {
  runSummary: RunSummary;
  message: string;
};

export class OrchestratedFinalReportService {
  build(input: OrchestratedFinalReportInput): OrchestratedFinalReport {
    const runSummary = createOrchestratedRunSummary(
      input.session,
      input.qualityGates,
      input.gatesPassed,
      input.appliedTitles ?? []
    );
    return {
      runSummary,
      message: formatOrchestratedRunSummaryMessage(runSummary)
    };
  }
}

export function createOrchestratedRunSummary(
  session: AgentRuntimeSession,
  qualityGates: QualityGateResult[],
  gatesPassed: boolean,
  appliedTitles: string[]
): RunSummary {
  const files = new Map<string, PatchChangeStats>();
  for (const patch of session.patchProposals) {
    for (const stat of getPatchStats(patch)) {
      const existing = files.get(stat.path);
      files.set(stat.path, {
        path: stat.path,
        changeType: stat.changeType,
        added: typeof stat.added === "number" || typeof existing?.added === "number" ? (existing?.added ?? 0) + (stat.added ?? 0) : undefined,
        removed: typeof stat.removed === "number" || typeof existing?.removed === "number" ? (existing?.removed ?? 0) + (stat.removed ?? 0) : undefined
      });
    }
  }
  const filesChanged = [...files.values()];
  const appliedPatchIds = session.patchProposals.filter((patch) => patch.status === "applied").map((patch) => patch.id);
  const proposedPatchIds = session.patchProposals.filter((patch) => patch.status !== "applied").map((patch) => patch.id);
  const summary = !gatesPassed
    ? "I stopped before changing files because the review gates found blocking issues."
    : appliedPatchIds.length
      ? `I implemented the requested change across ${filesChanged.length} file(s).`
      : `I prepared ${session.patchProposals.length} code change proposal(s) for review.`;

  return {
    status: gatesPassed ? "completed" : "blocked",
    summary,
    filesChanged,
    appliedPatchIds,
    proposedPatchIds,
    commandResults: session.commandExecutions.map((command) => `${command.command}: ${command.status}`),
    gates: qualityGates.map((gate) => ({
      name: gate.gateName,
      status: gate.status,
      notes: gate.status === "passed" ? gate.reviewerNotes : gate.blockingReasons
    })),
    nextAction: session.nextAction?.message ?? (appliedTitles.length ? `Applied: ${appliedTitles.join(", ")}` : undefined),
    createdAt: new Date().toISOString()
  };
}

export function formatOrchestratedRunSummaryMessage(summary: RunSummary) {
  const lines = [summary.summary];
  if (summary.filesChanged.length) {
    lines.push("", summary.appliedPatchIds.length ? "Files changed:" : "Files proposed:");
    lines.push(...summary.filesChanged.map((file) => `- ${file.path} +${file.added} -${file.removed}`));
  }
  if (summary.gates.length) {
    lines.push("", "Checks:");
    lines.push(...summary.gates.map((gate) => `- ${gate.name}: ${gate.status}`));
  }
  if (summary.commandResults.length) {
    lines.push("", "Commands:");
    lines.push(...summary.commandResults.map((command) => `- ${command}`));
  }
  if (summary.nextAction) {
    lines.push("", summary.nextAction);
  }
  return lines.join("\n");
}

function getPatchStats(patch: AgentRuntimeSession["patchProposals"][number]): PatchChangeStats[] {
  return getPatchStatsFromPatch(patch).map((stat) => ({
    path: stat.path,
    added: stat.additions,
    removed: stat.deletions,
    changeType: stat.changeType
  }));
}
