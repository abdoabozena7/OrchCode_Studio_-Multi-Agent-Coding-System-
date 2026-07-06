import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  RecursiveFailurePatchAttribution,
  RecursiveFinalReport,
  RecursivePatchProvenance,
  RecursiveRepairEligibility,
  RecursiveRepairRecord,
  RecursiveValidationAttempt,
  RecursiveValidationFailureDiagnosis,
  RecursiveValidationFailureSignals
} from "@hivo/protocol";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMemorySnapshotSync } from "../memory/SqliteMemoryStore.js";
import { resolveInsideWorkspace } from "../tools/security.js";
import { commandExecutionTruthStatus, upsertValidationAttempt } from "./RecursiveRepairStateService.js";
import type { SessionManager } from "./SessionManager.js";

export type RecursiveRepairPlanningServices = {
  proposeRepairPatch: (
    sessionId: string,
    finalReport: RecursiveFinalReport,
    repair: RecursiveRepairRecord
  ) => Promise<RecursiveRepairRecord>;
  summarizeOutput: (output?: string) => string | undefined;
};

export class RecursiveRepairPlanningService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveRepairPlanningServices
  ) {}

  async prepare(sessionId: string, finalReport: RecursiveFinalReport): Promise<RecursiveFinalReport> {
    const session = this.requireSession(sessionId);
    const existing = session.recursiveFactory?.repair;
    if (finalReport.finalValidationState !== "verified_failed") {
      return existing
        ? { ...finalReport, repair: { ...existing, finalOutcome: finalReport.finalValidationState, updatedAt: new Date().toISOString() } }
        : finalReport;
    }

    if (existing?.status === "repair_not_attempted" || existing?.status === "revalidation_requested" || existing?.status === "revalidated" || existing?.repairPatchId) {
      return { ...finalReport, repair: refreshRecursiveRepairRecord(session, finalReport, existing, this.services.summarizeOutput) };
    }

    const diagnosis = diagnoseRecursiveValidationFailure(session, finalReport, this.services.summarizeOutput);
    if (!diagnosis) return finalReport;
    const validationAttempt = buildRecursiveValidationAttempt(session, finalReport, "initial", 1, this.services.summarizeOutput);
    const eligibility = evaluateRecursiveRepairEligibility(session, diagnosis, existing?.attemptCount ?? 0);
    const now = new Date().toISOString();
    let repair: RecursiveRepairRecord = {
      id: `recursive_repair_${sessionId}`,
      sessionId,
      status: eligibility.status === "eligible" ? "diagnosed" : "repair_not_attempted",
      attemptCount: existing?.attemptCount ?? 0,
      maxAttempts: 1,
      diagnosis,
      eligibility,
      validationAttempts: validationAttempt ? [validationAttempt] : [],
      finalOutcome: finalReport.finalValidationState,
      summary: eligibility.status === "eligible"
        ? "Validation failed and is eligible for one scoped repair patch proposal."
        : `Repair not attempted: ${eligibility.reasons.join("; ")}`,
      createdAt: now,
      updatedAt: now
    };

    if (eligibility.status !== "eligible") return { ...finalReport, repair };
    repair = await this.services.proposeRepairPatch(sessionId, finalReport, repair);
    return { ...finalReport, repair };
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function diagnoseRecursiveValidationFailure(
  session: AgentRuntimeSession,
  finalReport: RecursiveFinalReport,
  summarizeOutput: (output?: string) => string | undefined
): RecursiveValidationFailureDiagnosis | undefined {
  const failedEvidence = [...(finalReport.validationDiscovery?.evidence ?? [])]
    .reverse()
    .find((entry) => entry.kind === "command" && entry.truthStatus === "verified_failed" && entry.command);
  if (!failedEvidence?.command) return undefined;
  const execution = failedEvidence.executionId
    ? session.commandExecutions.find((candidate) => candidate.id === failedEvidence.executionId)
    : session.commandExecutions.find((candidate) => normalizeRuntimeCommand(candidate.command) === normalizeRuntimeCommand(failedEvidence.command!));
  const stdout = execution?.stdout ?? failedEvidence.stdoutSummary ?? "";
  const stderr = execution?.stderr ?? failedEvidence.stderrSummary ?? "";
  const combined = `${stdout}\n${stderr}`;
  const failingTests = extractFailureLines(combined, /^(?:FAILED|ERROR)\s+(.+)$/i);
  const errors = extractFailureLines(combined, /\b(?:AssertionError|Error:|Traceback|failed|failure|panic|error)\b/i);
  const failureSignals = extractRecursiveValidationFailureSignals(session.workspacePath, failedEvidence.command, combined);
  const attribution = attributeRecursiveFailureToPatches({
    patchProvenance: finalReport.patchProvenance,
    failureSignals,
    output: combined,
    memoryFreshness: detectProjectMemoryFreshness(session.workspacePath)
  });
  const patchIds = attribution.relatedPatchIds;
  const branchIds = attribution.relatedBranchIds;
  const likelyFiles = uniqueRuntimeStrings(finalReport.patchProvenance
    .filter((provenance) => patchIds.includes(provenance.patchId))
    .flatMap((provenance) => provenance.filesChanged));
  const summary = [
    `Validation command failed: ${failedEvidence.command}`,
    typeof failedEvidence.exitCode === "number" ? `exit ${failedEvidence.exitCode}` : undefined,
    failingTests.length ? `failing tests: ${failingTests.slice(0, 3).join("; ")}` : undefined,
    `attribution=${attribution.confidence}`,
    likelyFiles.length ? `likely files: ${likelyFiles.join(", ")}` : "no related patched file could be proven"
  ].filter(Boolean).join("; ");
  return {
    id: `validation_failure_diagnosis_${session.id}`,
    sessionId: session.id,
    command: failedEvidence.command,
    cwd: failedEvidence.cwd ?? session.workspacePath,
    exitCode: failedEvidence.exitCode,
    stdoutSummary: failedEvidence.stdoutSummary ?? summarizeOutput(stdout),
    stderrSummary: failedEvidence.stderrSummary ?? summarizeOutput(stderr),
    failingTests,
    errors,
    likelyFiles,
    branchIds,
    patchIds,
    failureSignals,
    attribution,
    summary,
    createdAt: new Date().toISOString()
  };
}

export function evaluateRecursiveRepairEligibility(
  session: AgentRuntimeSession,
  diagnosis: RecursiveValidationFailureDiagnosis,
  attemptCount: number
): RecursiveRepairEligibility {
  const reasons: string[] = [];
  const maxAttempts = 1;
  const knownCommand = session.commandExecutions.some((execution) =>
    normalizeRuntimeCommand(execution.command) === normalizeRuntimeCommand(diagnosis.command)
  );
  if (!knownCommand) reasons.push("Failure was not produced by a known Rust-reported validation command.");
  if (attemptCount >= maxAttempts) reasons.push("Recursive repair attempt cap has already been reached.");
  const filesInsideWorkspace = diagnosis.likelyFiles.every((file) => isInsideWorkspacePath(session.workspacePath, file));
  if (diagnosis.attribution.confidence !== "high") {
    reasons.push(`Repair requires high failure-to-patch attribution by default; observed ${diagnosis.attribution.confidence}. ${diagnosis.attribution.reason}`);
  }
  if (!diagnosis.likelyFiles.length) reasons.push("No likely failing file could be tied to an applied recursive patch.");
  if (!filesInsideWorkspace) reasons.push("At least one diagnosed file is outside the workspace.");
  if (diagnosis.likelyFiles.length > 3) reasons.push("Diagnosis affects more than three files.");
  const relatedFiles = diagnosis.likelyFiles.filter((file) => isInsideWorkspacePath(session.workspacePath, file));
  if (!diagnosis.patchIds.length) reasons.push("Diagnosis did not map to an applied recursive patch.");
  const blockingConflicts = (session.recursiveFactory?.branchScopeConflicts ?? []).filter((conflict) => conflict.severity === "blocking");
  if (blockingConflicts.length) reasons.push("Blocking recursive scope conflicts remain unresolved.");
  return {
    status: reasons.length ? "repair_not_attempted" : "eligible",
    reasons: reasons.length ? uniqueRuntimeStrings(reasons) : ["Known validation failure is small, workspace-local, and tied to applied recursive patches."],
    attemptCount,
    maxAttempts,
    relatedFiles: uniqueRuntimeStrings(relatedFiles),
    relatedPatchIds: uniqueRuntimeStrings(diagnosis.patchIds)
  };
}

export function refreshRecursiveRepairRecord(
  session: AgentRuntimeSession,
  finalReport: RecursiveFinalReport,
  repair: RecursiveRepairRecord,
  summarizeOutput: (output?: string) => string | undefined
): RecursiveRepairRecord {
  const patch = repair.repairPatchId ? session.patchProposals.find((candidate) => candidate.id === repair.repairPatchId) : undefined;
  const latestAttempt = buildRecursiveValidationAttempt(session, finalReport, repair.revalidationRequestId ? "repair_revalidation" : "initial", repair.revalidationRequestId ? 2 : 1, summarizeOutput);
  return {
    ...repair,
    repairPatchStatus: patch?.status ?? repair.repairPatchStatus,
    validationAttempts: latestAttempt ? upsertValidationAttempt(repair.validationAttempts, latestAttempt) : repair.validationAttempts,
    finalOutcome: finalReport.finalValidationState,
    updatedAt: new Date().toISOString()
  };
}

export function buildRecursiveValidationAttempt(
  session: AgentRuntimeSession,
  finalReport: RecursiveFinalReport,
  role: RecursiveValidationAttempt["role"],
  attemptNumber: number,
  summarizeOutput: (output?: string) => string | undefined
): RecursiveValidationAttempt | undefined {
  const evidence = [...(finalReport.validationDiscovery?.evidence ?? [])]
    .reverse()
    .find((entry) => entry.kind === "command" && entry.command);
  if (!evidence?.command) return undefined;
  const execution = evidence.executionId ? session.commandExecutions.find((candidate) => candidate.id === evidence.executionId) : undefined;
  return execution
    ? buildRecursiveValidationAttemptFromExecution(execution, role, attemptNumber, summarizeOutput)
    : {
        attemptNumber,
        role,
        command: evidence.command,
        cwd: evidence.cwd ?? session.workspacePath,
        truthStatus: evidence.truthStatus,
        status: evidence.truthStatus,
        exitCode: evidence.exitCode,
        stdoutSummary: evidence.stdoutSummary,
        stderrSummary: evidence.stderrSummary,
        requestId: evidence.requestId,
        executionId: evidence.executionId,
        policyResult: evidence.policyResult,
        summary: evidence.summary,
        createdAt: new Date().toISOString()
      };
}

function buildRecursiveValidationAttemptFromExecution(
  execution: CommandExecutionRecord,
  role: RecursiveValidationAttempt["role"],
  attemptNumber: number,
  summarizeOutput: (output?: string) => string | undefined
): RecursiveValidationAttempt {
  return {
    attemptNumber,
    role,
    command: execution.command,
    cwd: execution.cwd,
    truthStatus: commandExecutionTruthStatus(execution),
    status: execution.status,
    exitCode: execution.exitCode,
    stdoutSummary: summarizeOutput(execution.stdout),
    stderrSummary: summarizeOutput(execution.stderr),
    requestId: execution.requestId,
    executionId: execution.id,
    policyResult: execution.provenance?.policyDecision,
    summary: execution.message ?? `Rust TerminalService reported ${execution.status}.`,
    createdAt: execution.createdAt
  };
}

function extractRecursiveValidationFailureSignals(workspacePath: string, command: string, output: string): RecursiveValidationFailureSignals {
  const commandType = classifyValidationCommandType(command);
  const workspaceFiles = extractWorkspaceFileRefs(workspacePath, output);
  const stackFrames = extractStackFrames(workspacePath, output);
  const failingTestFiles = uniqueRuntimeStrings(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(?:FAILED|ERROR)\s+([^\s:]+)(?:::\S+)?/i);
    return match?.[1] ? [normalizeDiagnosedFilePath(workspacePath, match[1])].filter(Boolean) as string[] : [];
  }));
  const sourceFiles = uniqueRuntimeStrings([
    ...workspaceFiles,
    ...stackFrames.map((frame) => frame.filePath).filter(Boolean) as string[]
  ].filter((file) => !failingTestFiles.includes(file)));
  const assertionMessages = extractFailureLines(output, /\b(?:AssertionError|assert |Error:|panic|failed|failure)\b/i);
  const importModules = extractImportModules(output);
  const lineNumbers = uniqueLineNumbers(stackFrames.flatMap((frame) =>
    typeof frame.line === "number" ? [{ filePath: frame.filePath, line: frame.line }] : []
  ));
  return {
    commandType,
    failingTestFiles,
    sourceFiles,
    assertionMessages,
    importModules,
    stackFrames,
    lineNumbers
  };
}

function classifyValidationCommandType(command: string): RecursiveValidationFailureSignals["commandType"] {
  const normalized = normalizeRuntimeCommand(command);
  if (/\bpytest\b/.test(normalized)) return "pytest";
  if (/\bnpm\b|\bpnpm\b|\byarn\b|node\s+--test/.test(normalized)) return "npm";
  if (/\bcargo\b/.test(normalized)) return "cargo";
  return "other";
}

function extractStackFrames(workspacePath: string, output: string): RecursiveValidationFailureSignals["stackFrames"] {
  const frames: RecursiveValidationFailureSignals["stackFrames"] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const python = line.match(/^File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(.+)$/);
    const node = line.match(/^at\s+(.+?)\s+\((.+?):(\d+):\d+\)$/);
    const simple = line.match(/^([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs)):(\d+)(?::\d+)?(?::\s*in\s*(.+))?/);
    if (python) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, python[1]!), line: Number(python[2]), functionName: python[3], raw: line });
    } else if (node) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, node[2]!), line: Number(node[3]), functionName: node[1], raw: line });
    } else if (simple) {
      frames.push({ filePath: normalizeDiagnosedFilePath(workspacePath, simple[1]!), line: Number(simple[2]), functionName: simple[3], raw: line });
    }
  }
  return frames;
}

function extractImportModules(output: string) {
  const modules = new Set<string>();
  const patterns = [
    /ModuleNotFoundError:\s+No module named ['"]([^'"]+)['"]/g,
    /ImportError:\s+.*?from ['"]?([A-Za-z0-9_.-]+)['"]?/g,
    /^\s*(?:from|import)\s+([A-Za-z0-9_.-]+)/gm,
    /Cannot find module ['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const moduleName = match[1]?.replace(/^\.+/, "").split(".").filter(Boolean).join(".");
      if (moduleName) modules.add(moduleName);
    }
  }
  return [...modules];
}

function uniqueLineNumbers(lines: Array<{ filePath?: string; line: number }>) {
  const seen = new Set<string>();
  return lines.filter((entry) => {
    const key = `${entry.filePath ?? ""}:${entry.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectProjectMemoryFreshness(workspacePath: string): RecursiveFailurePatchAttribution["memoryFreshness"] {
  const state = readMemorySnapshotSync<{
    stale?: boolean;
    fresh?: boolean;
    status?: string;
    freshness?: string;
    updatedAt?: string;
    lastIndexedAt?: string;
  }>(workspacePath, "index_state");
  if (!state) return "unknown";
  if (state.stale || state.status === "stale" || state.freshness === "stale") return "stale";
  if (state.fresh === true || state.status === "fresh" || state.freshness === "fresh") return "fresh";
  const timestamp = Date.parse(state.updatedAt ?? state.lastIndexedAt ?? "");
  if (Number.isFinite(timestamp) && Date.now() - timestamp < 24 * 60 * 60 * 1000) return "fresh";
  if (Number.isFinite(timestamp)) return "stale";
  return "unknown";
}

function attributeRecursiveFailureToPatches(input: {
  patchProvenance: RecursivePatchProvenance[];
  failureSignals: RecursiveValidationFailureSignals;
  output: string;
  memoryFreshness: RecursiveFailurePatchAttribution["memoryFreshness"];
}): RecursiveFailurePatchAttribution {
  const outputLower = input.output.toLowerCase();
  const tracebackFiles = new Set([
    ...input.failureSignals.sourceFiles,
    ...input.failureSignals.stackFrames.map((frame) => frame.filePath).filter(Boolean) as string[]
  ].map(normalizeWorkspaceRelativePath));
  const evidence: string[] = [];
  const relatedPatchIds = new Set<string>();
  const relatedBranchIds = new Set<string>();
  let confidence: RecursiveFailurePatchAttribution["confidence"] = "none";

  const promote = (next: RecursiveFailurePatchAttribution["confidence"]) => {
    const order: RecursiveFailurePatchAttribution["confidence"][] = ["none", "low", "medium", "high"];
    if (order.indexOf(next) > order.indexOf(confidence)) confidence = next;
  };
  const relate = (provenance: RecursivePatchProvenance, reason: string, next: RecursiveFailurePatchAttribution["confidence"]) => {
    relatedPatchIds.add(provenance.patchId);
    if (provenance.branchId) relatedBranchIds.add(provenance.branchId);
    evidence.push(reason);
    promote(next);
  };

  for (const provenance of input.patchProvenance) {
    const changedFiles = provenance.filesChanged.map(normalizeWorkspaceRelativePath);
    const directChangedFile = changedFiles.find((file) => tracebackFiles.has(file));
    if (directChangedFile) {
      relate(provenance, `Changed file ${directChangedFile} appears in traceback/stack frame.`, "high");
      continue;
    }
    const changedSymbol = provenance.touchedSymbols.find((symbol) =>
      symbol.kind !== "module"
      && symbol.name.length > 2
      && new RegExp(`\\b${escapeRegExp(symbol.name)}\\b`).test(input.output)
    );
    if (changedSymbol) {
      const symbolFrameMatch = input.failureSignals.stackFrames.some((frame) => frame.functionName === changedSymbol.name);
      relate(
        provenance,
        `Changed ${changedSymbol.kind} ${changedSymbol.name} is referenced in validation output${symbolFrameMatch ? " stack frames" : ""}.`,
        symbolFrameMatch ? "high" : "medium"
      );
      continue;
    }
    const moduleMatch = provenance.touchedSymbols.find((symbol) =>
      symbol.kind === "module"
      && input.failureSignals.importModules.some((moduleName) => moduleNamesMatch(moduleName, symbol.name))
    );
    if (moduleMatch) {
      relate(provenance, `Failing test output imports changed module ${moduleMatch.name}.`, "medium");
      continue;
    }
    const basenameMention = changedFiles.find((file) => {
      const basename = path.basename(file, path.extname(file)).toLowerCase();
      return basename.length > 3 && outputLower.includes(basename);
    });
    if (basenameMention) {
      evidence.push(`Changed file basename ${path.basename(basenameMention)} appears in output, but no traceback/import relation was proven.`);
      promote("low");
    }
  }

  if (input.memoryFreshness === "stale" && confidence !== "none") {
    confidence = confidence === "high" || confidence === "medium" ? confidence : "low";
  }
  if (!relatedPatchIds.size || confidence === "low" || confidence === "none") {
    return {
      relatedPatchIds: [],
      relatedBranchIds: [],
      confidence: relatedPatchIds.size ? confidence : "none",
      evidence: uniqueRuntimeStrings(evidence),
      reason: evidence.length
        ? "Only weak or non-relational evidence was found; no patch relationship is claimed."
        : "Validation output did not mention changed files, changed symbols, or imports of changed modules.",
      memoryFreshness: input.memoryFreshness
    };
  }
  return {
    relatedPatchIds: [...relatedPatchIds],
    relatedBranchIds: [...relatedBranchIds],
    confidence,
    evidence: uniqueRuntimeStrings(evidence),
    reason: `Attribution confidence is ${confidence} from deterministic validation-output evidence.`,
    memoryFreshness: input.memoryFreshness
  };
}

function extractFailureLines(output: string, pattern: RegExp) {
  return uniqueRuntimeStrings(output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .slice(0, 12));
}

function extractWorkspaceFileRefs(workspacePath: string, output: string) {
  const refs = new Set<string>();
  const patterns = [
    /(file:\/\/\/[^\s)]+?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g,
    /([A-Za-z0-9_.\-\/\\]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g,
    /([A-Za-z]:[^\s:]+?\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|json|md|txt|toml|yaml|yml))(?::\d+)?/g
  ];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const normalized = normalizeDiagnosedFilePath(workspacePath, raw);
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

function normalizeDiagnosedFilePath(workspacePath: string, filePath: string) {
  let stripped = filePath.replace(/^["'`]+|["'`,.;)]+$/g, "").replaceAll("\\", "/");
  if (/^file:\/\//i.test(stripped)) {
    try {
      stripped = fileURLToPath(stripped);
    } catch {
      return undefined;
    }
  }
  const absolute = /^[a-z]:/i.test(stripped) || stripped.startsWith("/")
    ? path.resolve(stripped)
    : path.resolve(workspacePath, stripped);
  const relative = path.relative(workspacePath, absolute).replaceAll("\\", "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return normalizeWorkspaceRelativePath(relative);
}

function isInsideWorkspacePath(workspacePath: string, filePath: string) {
  try {
    resolveInsideWorkspace(workspacePath, filePath);
    return !normalizeWorkspaceRelativePath(filePath).startsWith("..");
  } catch {
    return false;
  }
}

function moduleNamesMatch(observed: string, changed: string) {
  const normalizedObserved = observed.replaceAll("/", ".").replaceAll("\\", ".").toLowerCase();
  const normalizedChanged = changed.replaceAll("/", ".").replaceAll("\\", ".").toLowerCase();
  return normalizedObserved === normalizedChanged
    || normalizedObserved.endsWith(`.${normalizedChanged}`)
    || normalizedChanged.endsWith(`.${normalizedObserved}`);
}

function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeRuntimeCommand(command: string) {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
