import type {
  AgentRuntimeSession,
  RecursiveDiscoveredValidationCommand,
  RecursiveValidationEvidence,
  RecursiveValidationStrategy
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildRecursiveValidationCommandRequest,
  discoverRecursiveValidationCommands,
  findRecursiveValidationEvidence,
  selectRecursiveValidationStrategy,
  truthFromRecursiveValidation
} from "./RecursiveValidation.js";
import { resolveInsideWorkspace } from "../tools/security.js";
import { SessionManager } from "./SessionManager.js";

export type RecursiveBranchValidationEvaluation = {
  discoveredCommands: RecursiveDiscoveredValidationCommand[];
  strategy: RecursiveValidationStrategy;
  evidence: RecursiveValidationEvidence[];
  truthStatus: import("@hivo/protocol").ValidationTruthStatus;
  summary: string;
};

export class RecursiveBranchValidationService {
  constructor(private readonly sessionManager: SessionManager) {}

  evaluateBranch(session: AgentRuntimeSession, branchId: string): RecursiveBranchValidationEvaluation {
    return evaluateRecursiveBranchValidation(session, branchId);
  }

  async prepareBranchValidation(sessionId: string, branchId: string): Promise<RecursiveBranchValidationEvaluation> {
    const session = this.requireSession(sessionId);
    const evaluation = evaluateRecursiveBranchValidation(session, branchId);
    const shouldRequest =
      evaluation.strategy.kind === "command"
      && evaluation.strategy.command
      && evaluation.strategy.classification !== "blocked"
      && !hasMatchingValidationRequestOrExecution(session, evaluation.strategy);
    if (!shouldRequest) return evaluation;

    const request = buildRecursiveValidationCommandRequest({
      sessionId,
      workspacePath: session.workspacePath,
      strategy: evaluation.strategy
    });
    if (!request) return evaluation;

    await this.sessionManager.addCommandRequest(sessionId, request);
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "validation.requested",
      title: request.command,
      summary: evaluation.strategy.reason,
      payload: {
        branchId,
        commandRequestId: request.id,
        discoveredCommands: evaluation.discoveredCommands,
        selectedStrategy: evaluation.strategy
      },
      status: request.status === "blocked" ? "blocked" : "proposed",
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_recursive_validation_${request.id}`,
      sessionId,
      type: "verification",
      title: "Recursive Validation Requested",
      summary: evaluation.strategy.reason,
      payload: {
        branchId,
        commandRequestId: request.id,
        discoveredCommands: evaluation.discoveredCommands,
        selectedStrategy: evaluation.strategy
      },
      createdAt: new Date().toISOString()
    });
    return evaluateRecursiveBranchValidation(this.requireSession(sessionId), branchId);
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function evaluateRecursiveBranchValidation(session: AgentRuntimeSession, branchId: string): RecursiveBranchValidationEvaluation {
  const patches = recursiveBranchPatches(session, branchId);
  const discoveredCommands = discoverRecursiveValidationCommands({
    workspacePath: session.workspacePath,
    projectMap: session.orchestration?.projectMap
  });
  const strategy = selectRecursiveValidationStrategy({
    discoveredCommands,
    patches,
    branchId,
    exactPatchEffectAllowed: true
  });
  const evidence = findRecursiveValidationEvidence({ session, strategy, patches });
  const truthStatus = truthFromRecursiveValidation({ strategy, evidence });
  return {
    discoveredCommands,
    strategy,
    evidence,
    truthStatus,
    summary: summarizeRecursiveValidationEvaluation(strategy, evidence, discoveredCommands)
  };
}

function recursiveBranchPatches(session: AgentRuntimeSession, branchId: string) {
  const branch = session.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
  if (!branch) return [];
  const patchIds = uniqueStrings([
    branch.proposedPatchId,
    ...(branch.nestedSubtasks ?? []).map((subtask) => subtask.proposedPatchId)
  ].filter(Boolean) as string[]);
  return session.patchProposals.filter((patch) => patchIds.includes(patch.id));
}

function hasMatchingValidationRequestOrExecution(session: AgentRuntimeSession, strategy: RecursiveValidationStrategy) {
  if (strategy.kind !== "command" || !strategy.command) return false;
  const targetCwd = path.resolve(resolveInsideWorkspace(session.workspacePath, strategy.cwd ?? "."));
  return session.commandRequests.some((request) =>
    normalizeCommand(request.command) === normalizeCommand(strategy.command!)
    && path.resolve(request.cwd) === targetCwd
  ) || session.commandExecutions.some((execution) =>
    normalizeCommand(execution.command) === normalizeCommand(strategy.command!)
    && path.resolve(execution.cwd) === targetCwd
  );
}

function summarizeRecursiveValidationEvaluation(
  strategy: RecursiveValidationStrategy,
  evidence: RecursiveValidationEvidence[],
  discoveredCommands: RecursiveDiscoveredValidationCommand[]
) {
  const latest = evidence.at(-1);
  if (latest) {
    const outputSummary = [
      latest.policyResult ? `policy=${latest.policyResult}` : undefined,
      typeof latest.exitCode === "number" ? `exit=${latest.exitCode}` : undefined,
      latest.stdoutSummary ? `stdout=${latest.stdoutSummary}` : undefined,
      latest.stderrSummary ? `stderr=${latest.stderrSummary}` : undefined
    ].filter(Boolean).join("; ");
    return outputSummary ? `${latest.summary} (${outputSummary})` : latest.summary;
  }
  if (strategy.kind === "command") {
    return `Discovered ${discoveredCommands.length} validation command(s). Selected ${strategy.command}; status is ${strategy.classification}, so no verified pass is claimed until Rust reports a passing terminal result.`;
  }
  if (strategy.kind === "patch_effect") {
    return "Selected exact patch-effect validation, but no matching patch-effect evidence has been recorded.";
  }
  return strategy.reason;
}

function normalizeCommand(command: string) {
  return command.replace(/\s+/g, " ").trim().toLowerCase();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
