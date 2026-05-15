import type {
  AgentRun,
  AgentRuntimeSession,
  AgentWorkJournalEntry,
  CommandRequest,
  DecisionRecord,
  DiffFileStat,
  FileDiffAttribution,
  PatchProposal,
  ReconciliationReport,
  ReviewGateSummary,
  RunSummary,
  VerificationResult
} from "@orchcode/protocol";
import { randomId } from "./SessionManager.js";

type VerificationLike = Pick<VerificationResult, "status" | "summary" | "checks">;

export function appendAgentJournalEntry(
  agent: AgentRun,
  input: Omit<AgentWorkJournalEntry, "id" | "agentId" | "timestamp">
) {
  const entry: AgentWorkJournalEntry = {
    id: randomId("journal"),
    agentId: agent.id,
    timestamp: new Date().toISOString(),
    ...input
  };
  agent.workJournal = [...(agent.workJournal ?? []), entry].slice(-20);
  if (input.summary) {
    agent.recentActions = [...(agent.recentActions ?? []), input.summary].slice(-8);
  }
  return entry;
}

export function collectPatchDiffStats(session: AgentRuntimeSession): DiffFileStat[] {
  const files = new Map<string, DiffFileStat>();
  for (const patch of session.patchProposals) {
    for (const stat of getPatchStatsFromPatch(patch)) {
      const existing = files.get(stat.path);
      files.set(stat.path, {
        path: stat.path,
        changeType: stat.changeType,
        additions: sumOptional(existing?.additions, stat.additions),
        deletions: sumOptional(existing?.deletions, stat.deletions)
      });
    }
  }
  return [...files.values()];
}

export function getPatchStatsFromPatch(patch: PatchProposal): DiffFileStat[] {
  const stats = new Map<string, DiffFileStat>();
  for (const file of patch.filesChanged) {
    stats.set(file.path, {
      path: file.path,
      changeType: file.changeType,
      additions: undefined,
      deletions: undefined
    });
  }

  let currentPath = patch.filesChanged[0]?.path;
  for (const line of patch.unifiedDiff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] ?? currentPath;
      if (currentPath && !stats.has(currentPath)) {
        stats.set(currentPath, {
          path: currentPath,
          changeType: "modify",
          additions: 0,
          deletions: 0
        });
      }
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      if (!stats.has(currentPath)) {
        stats.set(currentPath, {
          path: currentPath,
          changeType: "modify",
          additions: 0,
          deletions: 0
        });
      }
      continue;
    }
    if (!currentPath) continue;
    const current = stats.get(currentPath) ?? {
      path: currentPath,
      changeType: "modify" as const,
      additions: 0,
      deletions: 0
    };
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions = (current.additions ?? 0) + 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions = (current.deletions ?? 0) + 1;
    }
    stats.set(currentPath, current);
  }

  return [...stats.values()];
}

export function buildAttributedReviewGate(
  session: AgentRuntimeSession,
  verification: VerificationLike
): ReviewGateSummary {
  const fileStats = collectPatchDiffStats(session);
  const totalAdditions = sumDefined(fileStats.map((file) => file.additions));
  const totalDeletions = sumDefined(fileStats.map((file) => file.deletions));
  const attribution = attributeDiffFiles(session, fileStats);
  const riskyAreas = [
    ...session.patchProposals.filter((patch) => patch.riskLevel !== "low").map((patch) => `${patch.title} (${patch.riskLevel})`),
    ...verification.checks.filter((check) => check.status !== "passed").map((check) => check.name)
  ];
  const unresolvedBlockers = verification.checks.filter((check) => check.status !== "passed").map((check) => check.detail);
  const recommendation =
    verification.status === "failed"
      ? "do_not_apply"
      : session.reconciliationReport?.status === "diverged" || session.reconciliationReport?.status === "failed"
        ? "do_not_apply"
        : verification.status === "pending" || verification.status === "running" || session.status === "expired" || session.reconciliationReport?.status === "pending" || session.reconciliationReport?.status === "unavailable"
        ? "caution"
        : "ready";

  return {
    totalFilesChanged: fileStats.length,
    totalAdditions,
    totalDeletions,
    globalDiff: {
      source: fileStats.length ? "patch_unified_diff" : "unknown",
      changedFiles: fileStats.length,
      additions: totalAdditions,
      deletions: totalDeletions,
      files: fileStats
    },
    actualDiff: session.reconciliationReport?.actual,
    reconciliation: session.reconciliationReport,
    changesByAgent: attribution.changesByAgent,
    riskyAreas,
    verificationChecks: verification.checks.map((check) => ({ ...check, scope: "global" as const })),
    risksByAgent: createRiskSummaryByAgent(session),
    decisionsByAgent: createDecisionSummaryByAgent(session),
    sharedFiles: attribution.sharedFiles,
    unattributedFiles: attribution.unattributedFiles,
    unknownFiles: attribution.unknownFiles,
    remainingUnknowns: attribution.remainingUnknowns,
    unresolvedBlockers,
    recommendation,
    summary:
      recommendation === "do_not_apply"
        ? "Verification or risk checks failed. Do not apply yet."
        : recommendation === "caution"
          ? "The run has useful output, but authority or verification work is still pending."
          : "Patch, command, and verification state are aligned for review."
  };
}

export function buildDiffAwareRunSummary(
  session: AgentRuntimeSession,
  verification: VerificationLike,
  status: RunSummary["status"],
  nextAction: string
): RunSummary {
  return {
    status,
    summary: verification.summary,
    filesChanged: collectPatchDiffStats(session).map((file) => ({
      path: file.path,
      added: file.additions,
      removed: file.deletions,
      changeType: file.changeType
    })),
    appliedPatchIds: session.patchProposals.filter((patch) => patch.status === "applied").map((patch) => patch.id),
    proposedPatchIds: session.patchProposals.filter((patch) => patch.status !== "applied").map((patch) => patch.id),
    commandResults: session.commandRequests.map((request) => `${request.command}: ${request.status}`),
    gates: verification.checks.map((check) => ({
      name: check.name,
      status: check.status === "failed" ? "failed" : "passed",
      notes: [check.detail]
    })),
    nextAction,
    createdAt: new Date().toISOString()
  };
}

type ClaimedAgent = {
  id: string;
  name: string;
  source: "reported" | "owned";
};

function attributeDiffFiles(session: AgentRuntimeSession, fileStats: DiffFileStat[]) {
  const agentRuns = session.orchestration?.agentRuns ?? [];
  const changesByAgent = new Map<string, ReviewGateSummary["changesByAgent"][number]>();
  const sharedFiles: FileDiffAttribution[] = [];
  const unattributedFiles: FileDiffAttribution[] = [];
  const unknownFiles: FileDiffAttribution[] = [];
  const remainingUnknowns: string[] = [];

  for (const file of fileStats) {
    const claims = collectClaims(agentRuns, file.path);
    const uniqueIds = [...new Set(claims.map((claim) => claim.id))];
    const claimNames = uniqueIds.map((id) => claims.find((claim) => claim.id === id)?.name ?? id);
    const hasReporter = claims.some((claim) => claim.source === "reported");
    const confidence =
      uniqueIds.length === 0
        ? "unattributed"
        : uniqueIds.length > 1
          ? "shared"
          : hasReporter
            ? "reported"
            : "owned";

    if (confidence === "shared") {
      sharedFiles.push({
        ...file,
        confidence,
        agentIds: uniqueIds,
        agentNames: claimNames,
        reason: "Multiple agent contracts claimed or owned this file."
      });
      continue;
    }
    if (confidence === "unattributed") {
      unattributedFiles.push({
        ...file,
        confidence,
        reason: "No agent contract reported or owned this changed file."
      });
      continue;
    }

    const agentId = uniqueIds[0];
    const agent = agentRuns.find((candidate) => candidate.id === agentId);
    if (!agent) {
      unknownFiles.push({
        ...file,
        confidence: "unknown",
        agentIds: uniqueIds,
        agentNames: claimNames,
        reason: "A claimed agent was not available in the current session state."
      });
      continue;
    }
    const entry = changesByAgent.get(agentId) ?? {
      agentId,
      agentName: agent.displayName ?? agent.agentName,
      confidence,
      fileCount: 0,
      additions: undefined,
      deletions: undefined,
      files: [],
      lineTotalsKnown: true
    };
    entry.confidence = reduceConfidence(entry.confidence, confidence);
    entry.fileCount += 1;
    entry.files = [...new Set([...entry.files, file.path])];
    if (typeof file.additions === "number" && typeof file.deletions === "number") {
      entry.additions = (entry.additions ?? 0) + file.additions;
      entry.deletions = (entry.deletions ?? 0) + file.deletions;
    } else {
      entry.additions = undefined;
      entry.deletions = undefined;
      entry.lineTotalsKnown = false;
      remainingUnknowns.push(`Line totals are unavailable for ${file.path}.`);
    }
    changesByAgent.set(agentId, entry);
  }

  if (!fileStats.length) {
    remainingUnknowns.push("No reviewable diff stats were available.");
  }

  return {
    changesByAgent: [...changesByAgent.values()],
    sharedFiles,
    unattributedFiles,
    unknownFiles,
    remainingUnknowns: [...new Set(remainingUnknowns)]
  };
}

function collectClaims(agentRuns: AgentRun[], filePath: string): ClaimedAgent[] {
  const claims: ClaimedAgent[] = [];
  for (const agent of agentRuns) {
    if ((agent.changedFiles ?? []).includes(filePath)) {
      claims.push({
        id: agent.id,
        name: agent.displayName ?? agent.agentName,
        source: "reported"
      });
    } else if ((agent.ownedPaths ?? []).includes(filePath)) {
      claims.push({
        id: agent.id,
        name: agent.displayName ?? agent.agentName,
        source: "owned"
      });
    }
  }
  return claims;
}

function reduceConfidence(
  current: ReviewGateSummary["changesByAgent"][number]["confidence"],
  next: ReviewGateSummary["changesByAgent"][number]["confidence"]
) {
  if (!current) return next;
  if (current === next) return current;
  if (current === "reported" && next === "owned") return "owned";
  if (current === "owned" && next === "reported") return "owned";
  return current;
}

function createRiskSummaryByAgent(session: AgentRuntimeSession) {
  return (session.orchestration?.agentRuns ?? [])
    .filter((agent) => (agent.riskRefs?.length ?? 0) > 0)
    .map((agent) => ({
      agentId: agent.id,
      agentName: agent.displayName ?? agent.agentName,
      count: agent.riskRefs?.length ?? 0,
      risks: agent.riskRefs ?? []
    }));
}

function createDecisionSummaryByAgent(session: AgentRuntimeSession) {
  const summaries = new Map<string, { agentId?: string; agentName: string; decisionIds: string[] }>();
  for (const record of session.decisionLedger ?? []) {
    const linkedAgentIds = uniqueStrings([
      record.createdByAgentId ?? "",
      ...(record.linkedAgentIds ?? [])
    ]);
    for (const agentId of linkedAgentIds) {
      const agent = session.orchestration?.agentRuns.find((candidate) => candidate.id === agentId);
      const key = agentId || record.createdByAgent;
      const current = summaries.get(key) ?? {
        agentId: agentId || undefined,
        agentName: agent?.displayName ?? agent?.agentName ?? record.createdByAgent,
        decisionIds: []
      };
      current.decisionIds = uniqueStrings([...current.decisionIds, record.id]);
      summaries.set(key, current);
    }
  }
  return [...summaries.values()].map((entry) => ({
    ...entry,
    count: entry.decisionIds.length
  }));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function sumOptional(left: number | undefined, right: number | undefined) {
  if (typeof left !== "number" && typeof right !== "number") return undefined;
  return (left ?? 0) + (right ?? 0);
}

function sumDefined(values: Array<number | undefined>) {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length === values.length ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

export function parseUnifiedDiffToStats(
  diffText: string | undefined,
  changedFiles: string[] = []
): DiffFileStat[] {
  if (!diffText?.trim()) {
    return changedFiles.map((path) => ({
      path,
      changeType: "modify",
      additions: undefined,
      deletions: undefined
    }));
  }
  const stats = new Map<string, DiffFileStat>();
  for (const path of changedFiles) {
    stats.set(path, {
      path,
      changeType: "modify",
      additions: undefined,
      deletions: undefined
    });
  }
  let currentPath: string | undefined;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentPath = match?.[2] ?? currentPath;
      if (currentPath && !stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, changeType: "modify", additions: 0, deletions: 0 });
      }
      continue;
    }
    if (line.startsWith("+++ b/")) {
      currentPath = line.slice("+++ b/".length);
      if (!stats.has(currentPath)) {
        stats.set(currentPath, { path: currentPath, changeType: "modify", additions: 0, deletions: 0 });
      }
      continue;
    }
    if (!currentPath) continue;
    const current = stats.get(currentPath) ?? { path: currentPath, changeType: "modify" as const, additions: 0, deletions: 0 };
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions = (current.additions ?? 0) + 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions = (current.deletions ?? 0) + 1;
    }
    stats.set(currentPath, current);
  }
  return [...stats.values()];
}

export function createGlobalDiffSummary(
  source: "patch_unified_diff" | "run_summary" | "unknown",
  files: DiffFileStat[]
) {
  return {
    source,
    changedFiles: files.length,
    additions: sumDefined(files.map((file) => file.additions)),
    deletions: sumDefined(files.map((file) => file.deletions)),
    files
  } as const;
}

export function buildReconciliationReport(
  session: AgentRuntimeSession,
  patchId: string,
  snapshot?: {
    before?: import("@orchcode/protocol").WorkspaceDiffSnapshot;
    after?: import("@orchcode/protocol").WorkspaceDiffSnapshot;
  }
): ReconciliationReport {
  const patch = session.patchProposals.find((candidate) => candidate.id === patchId);
  const evidenceSource = snapshot?.after?.source ?? snapshot?.before?.source ?? "unknown";
  const checkedBy = evidenceSource === "rust_git_snapshot" ? "rust" : evidenceSource === "desktop_git_snapshot_bridge" ? "git" : "runtime";
  if (!patch) {
    return {
      status: "failed",
      patchId,
      sourceDiffId: patchId,
      checkedAt: new Date().toISOString(),
      checkedBy,
      evidenceSource,
      confidence: "unknown",
      reason: "Patch proposal was not found for reconciliation.",
      retryable: false,
      matchedFiles: [],
      missingFiles: [],
      extraFiles: [],
      changedFilesWithDifferentStats: [],
      sharedOrAmbiguousFiles: session.reviewGate?.sharedFiles ?? [],
      unknowns: ["Patch proposal was unavailable during reconciliation."]
    };
  }

  const proposedFiles = getPatchStatsFromPatch(patch);
  const proposed = createGlobalDiffSummary("patch_unified_diff", proposedFiles);
  const after = snapshot?.after;
  const before = snapshot?.before;
  if (!after?.available || after.isGitRepo === false) {
    return {
      status: "unavailable",
      patchId,
      sourceDiffId: patchId,
      checkedAt: new Date().toISOString(),
      checkedBy,
      evidenceSource: after?.available === false ? "unavailable" : evidenceSource,
      confidence: "unknown",
      reason: after?.unavailableReason ?? "Post-apply git diff data was unavailable.",
      retryable: true,
      proposed,
      matchedFiles: [],
      missingFiles: [],
      extraFiles: [],
      changedFilesWithDifferentStats: [],
      sharedOrAmbiguousFiles: session.reviewGate?.sharedFiles ?? [],
      dirtyBeforeApply: before?.dirty,
      dirtyAfterApply: after?.dirty,
      unknowns: ["Git diff or status could not be read after apply."]
    };
  }

  const actualFiles = after.fileStats?.length ? after.fileStats : parseUnifiedDiffToStats(after.diffText, after.changedFiles ?? []);
  const actual = createGlobalDiffSummary("patch_unified_diff", actualFiles);
  const proposedMap = new Map(proposedFiles.map((file) => [file.path, file]));
  const actualMap = new Map(actualFiles.map((file) => [file.path, file]));
  const matchedFiles: string[] = [];
  const missingFiles: string[] = [];
  const extraFiles: string[] = [];
  const changedFilesWithDifferentStats: ReconciliationReport["changedFilesWithDifferentStats"] = [];
  const unknowns: string[] = [];

  for (const file of proposedFiles) {
    const actualFile = actualMap.get(file.path);
    if (!actualFile) {
      missingFiles.push(file.path);
      continue;
    }
    if (
      typeof file.additions === "number" &&
      typeof file.deletions === "number" &&
      typeof actualFile.additions === "number" &&
      typeof actualFile.deletions === "number"
    ) {
      if (file.additions === actualFile.additions && file.deletions === actualFile.deletions) {
        matchedFiles.push(file.path);
      } else {
        changedFilesWithDifferentStats.push({
          path: file.path,
          proposedAdditions: file.additions,
          proposedDeletions: file.deletions,
          actualAdditions: actualFile.additions,
          actualDeletions: actualFile.deletions
        });
      }
    } else {
      matchedFiles.push(file.path);
      unknowns.push(`Line totals for ${file.path} could not be fully compared.`);
    }
  }

  for (const actualFile of actualFiles) {
    if (!proposedMap.has(actualFile.path)) {
      extraFiles.push(actualFile.path);
    }
  }

  const status =
    missingFiles.length || extraFiles.length || changedFilesWithDifferentStats.length
      ? "diverged"
      : unknowns.length
        ? "matched"
        : "matched";

  return {
    status,
    patchId,
    sourceDiffId: patch.id,
    checkedAt: after.checkedAt ?? new Date().toISOString(),
    checkedBy,
    evidenceSource,
    confidence:
      missingFiles.length || extraFiles.length || changedFilesWithDifferentStats.length
        ? "partial"
        : unknowns.length
          ? "high"
          : "exact",
    reason:
      status === "diverged"
        ? "Actual post-apply working tree diverged from the proposed patch."
        : unknowns.length
          ? "Patch and working tree matched on files, but some line totals were unavailable."
          : "Actual post-apply working tree matched the proposed patch.",
    retryable: status !== "matched",
    proposed,
    actual,
    matchedFiles,
    missingFiles,
    extraFiles,
    changedFilesWithDifferentStats,
    sharedOrAmbiguousFiles: session.reviewGate?.sharedFiles ?? [],
    dirtyBeforeApply: before?.dirty,
    dirtyAfterApply: after?.dirty,
    unknowns
  };
}
