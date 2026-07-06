import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  PatchProposal,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  appendAgentJournalEntry,
  buildReconciliationReport
} from "./AgentTelemetry.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimePatchApprovalResult = {
  proposal: PatchProposal;
  applied: false;
  message: string;
};

export type RuntimePatchApplyRecord = {
  session: AgentRuntimeSession;
  patchStatus: PatchProposal["status"];
  terminal: boolean;
};

export type RuntimeCommandResultRecord = {
  session: AgentRuntimeSession;
  record: CommandExecutionRecord;
};

export class RuntimeApprovalBoundaryService {
  constructor(private readonly sessionManager: SessionManager) {}

  async approvePatch(sessionId: string, patchId: string): Promise<RuntimePatchApprovalResult> {
    const currentSession = this.requireSession(sessionId);
    const currentProposal = currentSession.patchProposals.find((patch) => patch.id === patchId);
    if (!currentProposal) throw new Error("proposal_not_found: Patch proposal not found");
    if (currentProposal.status !== "proposed") {
      throw new Error(`Patch approval requires proposed status; current status is ${currentProposal.status}.`);
    }
    const preflight = new ToolRegistry(currentSession.workspacePath).patch.validate(currentProposal);
    if (!preflight.valid) {
      throw new Error(`Patch approval blocked by preflight: ${preflight.errors.join("; ")}`);
    }
    if (currentSession.latestScopeValidation?.verdict === "blocked") {
      throw new Error("Patch approval is blocked because the proposed changes exceed the scoped module plan.");
    }

    const session = await this.sessionManager.setPatchStatus(sessionId, patchId, "approved");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("proposal_not_found: Patch proposal not found");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const approvalId = `approval_${randomUUID()}`;
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPLY";
      const patch = draft.patchProposals.find((candidate) => candidate.id === patchId);
      if (patch) {
        patch.approvalId = approvalId;
        patch.lastStatusAt = new Date().toISOString();
      }
      draft.orchestration?.approvalDecisions.push({
        id: approvalId,
        sessionId,
        targetType: "patch",
        targetId: patchId,
        decision: "approved",
        reason: "User approved patch proposal in UI",
        createdAt: new Date().toISOString()
      });
    });
    return {
      proposal,
      applied: false,
      message: "Patch approved. Apply is handled by the Rust patch authority."
    };
  }

  async rejectPatch(sessionId: string, patchId: string): Promise<RuntimePatchApprovalResult> {
    const session = await this.sessionManager.setPatchStatus(sessionId, patchId, "rejected");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("proposal_not_found: Patch proposal not found");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const approvalId = `approval_${randomUUID()}`;
      draft.lifecycleStage = "BLOCKED";
      draft.nextAction = undefined;
      const patch = draft.patchProposals.find((candidate) => candidate.id === patchId);
      if (patch) {
        patch.approvalId = approvalId;
        patch.lastStatusAt = new Date().toISOString();
      }
      draft.orchestration?.approvalDecisions.push({
        id: approvalId,
        sessionId,
        targetType: "patch",
        targetId: patchId,
        decision: "rejected",
        reason: "User rejected patch proposal in UI",
        createdAt: new Date().toISOString()
      });
      if (draft.runToGreen?.pendingRepairPatchId === patchId) {
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "User rejected the proposed repair patch during the run-to-green loop.";
        draft.runToGreen.pendingRepairPatchId = undefined;
        draft.runToGreen.pendingRerunCommand = undefined;
        draft.runToGreen.pendingRerunReason = undefined;
        draft.runToGreen.updatedAt = new Date().toISOString();
      }
    });
    return { proposal, applied: false, message: "Patch rejected. No files were changed." };
  }

  async recordPatchApplyResult(
    sessionId: string,
    patchId: string,
    result: ReportPatchApplyResultRequest
  ): Promise<RuntimePatchApplyRecord> {
    const current = this.requireSession(sessionId).patchProposals.find((proposal) => proposal.id === patchId);
    if (!current) throw new Error("proposal_not_found: Patch proposal not found");
    if (result.status === "apply_started") {
      if (current.status !== "approved") {
        throw new Error(`Patch apply can only start from approved status; current status is ${current.status}.`);
      }
      await this.sessionManager.setPatchStatus(sessionId, patchId, "apply_started");
      return {
        session: this.requireSession(sessionId),
        patchStatus: "apply_started",
        terminal: false
      };
    }
    if (current.status !== "approved" && current.status !== "apply_started") {
      throw new Error(`Patch apply result requires approved or apply_started status; current status is ${current.status}.`);
    }

    const patchStatus = result.status === "applied" ? "applied" : "apply_failed";
    await this.sessionManager.setPatchStatus(sessionId, patchId, patchStatus);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "summary",
      title: result.status === "applied" ? "Patch applied" : "Patch apply failed",
      summary: result.message,
      payload: {
        patchId,
        status: result.status,
        message: result.message
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: result.status === "applied"
        ? `Applied patch ${patchId}.\n\n${result.message}`
        : `Patch ${patchId} failed to apply.\n\n${result.message}`
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (result.status === "applied") {
        draft.reconciliationReport = result.reconciliationSnapshot
          ? buildReconciliationReport(draft, patchId, result.reconciliationSnapshot)
          : {
              status: "pending",
              patchId,
              sourceDiffId: patchId,
              checkedAt: new Date().toISOString(),
              checkedBy: "runtime",
              confidence: "unknown",
              reason: "Patch apply succeeded, but post-apply reconciliation has not been reported yet.",
              retryable: true,
              matchedFiles: [],
              missingFiles: [],
              extraFiles: [],
              changedFilesWithDifferentStats: [],
              sharedOrAmbiguousFiles: draft.reviewGate?.sharedFiles ?? [],
              unknowns: ["Post-apply reconciliation snapshot was not provided."]
            };
      } else {
        draft.reconciliationReport = {
          status: "failed",
          patchId,
          sourceDiffId: patchId,
          checkedAt: new Date().toISOString(),
          checkedBy: "runtime",
          confidence: "unknown",
          reason: result.message,
          retryable: false,
          matchedFiles: [],
          missingFiles: [],
          extraFiles: [],
          changedFilesWithDifferentStats: [],
          sharedOrAmbiguousFiles: draft.reviewGate?.sharedFiles ?? [],
          unknowns: ["Patch apply failed, so reconciliation did not run."]
        };
      }
      for (const agent of draft.orchestration?.agentRuns ?? []) {
        if (!(agent.changedFiles ?? []).length) continue;
        agent.currentAction = result.status === "applied"
          ? "Rust applied the reviewable changes owned by this contract."
          : "Rust reported that applying the reviewable changes failed.";
        agent.recentActions = appendRuntimeAction(agent.recentActions, result.message);
        if (result.status === "applied") {
          agent.status = agent.status === "failed" ? "failed" : "blocked";
          appendAgentJournalEntry(agent, {
            kind: "completed",
            title: "Patch apply acknowledged",
            summary: result.message,
            filePath: agent.changedFiles?.[0],
            status: "completed"
          });
        } else {
          agent.status = "failed";
          agent.completedAt = new Date().toISOString();
          appendAgentJournalEntry(agent, {
            kind: "blocked",
            title: "Patch apply failed",
            summary: result.message,
            filePath: agent.changedFiles?.[0],
            status: "failed"
          });
        }
      }
    });
    return {
      session: this.requireSession(sessionId),
      patchStatus,
      terminal: true
    };
  }

  async recordCommandResult(
    sessionId: string,
    requestId: string,
    result: ReportCommandResultRequest
  ): Promise<RuntimeCommandResultRecord> {
    const request = this.requireSession(sessionId).commandRequests.find((candidate) => candidate.id === requestId);
    const record: CommandExecutionRecord = {
      id: `exec_${randomUUID()}`,
      sessionId,
      requestId,
      autoRun: result.autoRun ?? false,
      command: result.command,
      cwd: result.cwd,
      risk: result.risk,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      message: result.message,
      diagnosis: result.diagnosis,
      provenance: {
        source: result.provenance?.source ?? request?.provenance?.source ?? "agent",
        trigger: result.provenance?.trigger ?? (result.autoRun ? "auto_approved" : "manual"),
        requestedBy: result.provenance?.requestedBy ?? request?.provenance?.requestedBy ?? "unknown",
        approvalId: result.provenance?.approvalId ?? request?.provenance?.approvalId,
        toolCallId: result.provenance?.toolCallId ?? request?.provenance?.toolCallId,
        reason: result.provenance?.reason ?? result.message ?? request?.reason,
        sessionId,
        requestId,
        agentId: result.provenance?.agentId,
        approvalSource: result.provenance?.approvalSource,
        policyDecision: result.provenance?.policyDecision,
        policyReason: result.provenance?.policyReason,
        executionAuthority: result.provenance?.executionAuthority ?? "rust",
        background: result.provenance?.background ?? result.backgroundJob?.status === "running",
        processId: result.provenance?.processId ?? result.backgroundJob?.processId,
        networkDetected: result.provenance?.networkDetected,
        backgroundDetected: result.provenance?.backgroundDetected ?? result.backgroundJob?.status === "running",
        detectionSource: result.provenance?.detectionSource,
        networkDetectionSource: result.provenance?.networkDetectionSource,
        backgroundDetectionSource: result.provenance?.backgroundDetectionSource,
        outputSummary: result.provenance?.outputSummary,
        backgroundTrackingLimited: result.provenance?.backgroundTrackingLimited ?? Boolean(result.backgroundJob),
        jobId: result.provenance?.jobId ?? result.backgroundJob?.jobId
      },
      backgroundJob: result.backgroundJob
        ? {
            ...result.backgroundJob,
            requestId,
            sessionId
          }
        : undefined,
      createdAt: new Date().toISOString()
    };
    await this.sessionManager.addCommandExecution(sessionId, record);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "command_result",
      title: result.command,
      summary: result.message ?? `Command ${result.status}`,
      payload: {
        requestId,
        result: record
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: formatCommandResultMessage(record)
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      for (const agent of draft.orchestration?.agentRuns ?? []) {
        if (!(agent.commandsRun ?? []).includes(result.command)) continue;
        agent.commandsRun = uniqueRuntimeStrings([...(agent.commandsRun ?? []), result.command]);
        if (looksLikeTestCommand(result.command)) {
          agent.testsRun = uniqueRuntimeStrings([...(agent.testsRun ?? []), result.command]);
        }
        agent.currentAction = result.message ?? `Command recorded as ${result.status}.`;
        agent.recentActions = appendRuntimeAction(agent.recentActions, `Command result: ${result.command} (${result.status})`);
        agent.evidenceRefs = mergeRuntimeEvidenceRefs(agent.evidenceRefs, [{
          type: "command",
          commandId: requestId,
          category: "command-result",
          reason: result.message ?? `Command finished with status ${result.status}.`,
          linkedAgentId: agent.id
        }]);
        appendAgentJournalEntry(agent, {
          kind:
            result.status === "running" || result.status === "executing"
              ? "command_requested"
              : looksLikeTestCommand(result.command)
                ? "test_run"
                : "command_completed",
          title: result.command,
          summary: result.message ?? `Command recorded as ${result.status}.`,
          command: result.command,
          status:
            result.status === "failed"
              ? "failed"
              : result.status === "blocked" || result.status === "approval_required"
                ? "blocked"
                : result.status === "running" || result.status === "executing"
                  ? "running"
                  : "completed"
        });
      }
    });
    return {
      session: this.requireSession(sessionId),
      record
    };
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

export function formatCommandResultMessage(record: CommandExecutionRecord) {
  const statusLine = typeof record.exitCode === "number"
    ? `${record.status} (exit ${record.exitCode})`
    : record.status;
  const output = [record.message, record.stdout, record.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return [
    `Command finished: \`${record.command}\``,
    "",
    `Status: ${statusLine}`,
    output ? `\n${truncateCommandOutput(output)}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function truncateCommandOutput(output: string, max = 1800) {
  return output.length > max ? `${output.slice(0, max)}\n...output truncated...` : output;
}

function appendRuntimeAction(actions: string[] | undefined, next: string) {
  const trimmed = next.trim();
  if (!trimmed) return actions ?? [];
  return [...(actions ?? []), trimmed].slice(-12);
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function looksLikeTestCommand(command: string) {
  return /\b(test|vitest|jest|cargo test|npm test|pnpm test|yarn test|diff --check|tsc)\b/i.test(command);
}

function mergeRuntimeEvidenceRefs(
  existing: NonNullable<NonNullable<AgentRuntimeSession["orchestration"]>["agentRuns"]>[number]["evidenceRefs"] | undefined,
  next: import("@hivo/protocol").EvidenceRef[]
) {
  const merged = [...(existing ?? [])];
  for (const ref of next) {
    const fingerprint = JSON.stringify(ref);
    if (!merged.some((candidate) => JSON.stringify(candidate) === fingerprint)) {
      merged.push(ref);
    }
  }
  return merged.slice(-12);
}
