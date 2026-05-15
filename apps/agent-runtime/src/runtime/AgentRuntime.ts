import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  CreateRuntimeSessionRequest,
  CreateRuntimeSessionResponse,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RunSummary,
  RuntimeSessionStatus,
  RuntimeTurnResponse
} from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { SessionManager } from "./SessionManager.js";
import { createSimpleDelegationDecision, parsePromptDirective, resolveExecutionMode } from "./delegation.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { RunEngine } from "./RunEngine.js";
import {
  appendAgentJournalEntry,
  buildAttributedReviewGate,
  buildDiffAwareRunSummary
  ,buildReconciliationReport
} from "./AgentTelemetry.js";

export class AgentRuntime {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly sessionManager: SessionManager
  ) {}

  async createSession(input: CreateRuntimeSessionRequest): Promise<CreateRuntimeSessionResponse> {
    const mode = input.mode ?? this.config.defaultMode;
    const session = await this.sessionManager.createSession({
      workspacePath: input.workspacePath,
      mode,
      trustProfile: input.trustProfile,
      providerConfig: input.providerConfig,
      sessionToken: input.sessionToken,
      sessionTokenExpiresAt: input.sessionTokenExpiresAt,
      executionMode: input.executionMode,
      accessProfile: input.accessProfile,
      thinkFirst: input.thinkFirst,
      safetySettings: input.safetySettings,
      userPrompt: input.userPrompt
    });
    return { sessionId: session.id, status: "created" };
  }

  async runTurn(sessionId: string, message: string): Promise<RuntimeTurnResponse> {
    const session = this.requireSession(sessionId);
    const confirmationHandled = await this.handlePendingAction(session, message);
    if (confirmationHandled) {
      return { sessionId, status: this.requireSession(sessionId).status };
    }

    const provider =
      session.mode === "real_provider"
        ? createRealProvider(session.providerConfig)
        : new MockLlmProvider();
    try {
      const tools = new ToolRegistry(session.workspacePath);
      const projectSummary = tools.workspace.getProjectSummary();
      const projectMap = {
        stack: Object.keys(projectSummary.languages),
        packageManagers: projectSummary.packageManagers,
        testCommands: projectSummary.testCommands,
        entryPoints: projectSummary.importantFiles.filter((file) => /main|index|app|server|lib\.rs/.test(file)).slice(0, 8),
        importantFiles: projectSummary.importantFiles
      };
      const modeResolution =
        session.executionMode === "auto_mode"
          ? resolveExecutionMode(message, projectMap)
          : {
              mode: session.executionMode,
              directive: parsePromptDirective(message),
              complexity: createSimpleDelegationDecision({ prompt: message, projectMap }).estimatedComplexity
            };

      const updated = await new RunEngine(provider, this.sessionManager).runTurn(sessionId, message, {
        resolvedMode: modeResolution.mode,
        projectMap,
        thinkFirst: session.thinkFirst || modeResolution.directive.thinkFirstRequested
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = modeResolution.mode;
      });
      return { sessionId, status: updated.status };
    } catch (error) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "failed";
        draft.reasoningSummaries.push(String(error));
      });
      return { sessionId, status: "failed" };
    }
  }

  getSession(sessionId: string): AgentRuntimeSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  async approvePatch(sessionId: string, patchId: string) {
    let session = await this.sessionManager.setPatchStatus(sessionId, patchId, "approved");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("Patch proposal not found");
    const applied = false;
    const message = "Patch approved. Apply is handled by the Rust patch authority.";
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
      applied,
      message
    };
  }

  async rejectPatch(sessionId: string, patchId: string) {
    const session = await this.sessionManager.setPatchStatus(sessionId, patchId, "rejected");
    const proposal = session.patchProposals.find((patch) => patch.id === patchId);
    if (!proposal) throw new Error("Patch proposal not found");
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
    });
    return { proposal, applied: false, message: "Patch rejected. No files were changed." };
  }

  async reportPatchApplyResult(sessionId: string, patchId: string, result: ReportPatchApplyResultRequest) {
    const status = result.status === "applied" ? "applied" : "apply_failed";
    await this.sessionManager.setPatchStatus(sessionId, patchId, status);
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
    await this.syncSessionOutcome(sessionId);
    return this.requireSession(sessionId);
  }

  async reportCommandResult(sessionId: string, requestId: string, result: ReportCommandResultRequest) {
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
              : result.status === "blocked"
                ? "blocked"
                : result.status === "running" || result.status === "executing"
                  ? "running"
                  : "completed"
        });
      }
    });
    await this.syncSessionOutcome(sessionId);
    return this.requireSession(sessionId);
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  private async handlePendingAction(session: AgentRuntimeSession, message: string) {
    if (!session.nextAction) return false;
    const normalized = message.trim().toLowerCase();
    if (session.nextAction.kind === "confirm_plan") {
      if (/\b(proceed|continue|implement|go ahead|start)\b/.test(normalized)) {
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = undefined;
          draft.thinkFirst = false;
        });
        return false;
      }
      await this.sessionManager.addMessage(session.id, {
        role: "assistant",
        content: "Okay. Review the plan and tell me when to proceed with implementation."
      });
      return true;
    }

    if (session.nextAction.kind === "confirm_preview") {
      if (/\b(run|open|yes|launch)\b/.test(normalized)) {
        const preview = session.nextAction.preview;
        let executionMessage = "Preview command approval is ready.";
        if (preview.command) {
          await this.sessionManager.addCommandRequest(session.id, {
            id: `cmd_${randomUUID()}`,
            sessionId: session.id,
            command: preview.command,
            cwd: session.workspacePath,
            risk: "safe",
            reason: "User requested preview launch; Rust terminal authority must execute it.",
            provenance: {
              source: "user",
              trigger: "manual",
              requestedBy: "user",
              reason: "Preview launch confirmation from the user."
            },
            status: "requested",
            createdAt: new Date().toISOString()
          });
        }
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = {
            kind: "preview_ready",
            message: executionMessage,
            preview
          };
        });
        await this.sessionManager.addMessage(session.id, {
          role: "assistant",
          content: `Preview is ready. Use the open button to launch ${preview.description.toLowerCase()}.`
        });
        return true;
      }

      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined;
      });
      await this.sessionManager.addMessage(session.id, {
        role: "assistant",
        content: "Okay. I left the result in review mode without running the preview."
      });
      return true;
    }

    return false;
  }

  private async syncSessionOutcome(sessionId: string) {
    const before = this.requireSession(sessionId);
    const verification = buildRuntimeVerification(before);
    const reviewGate = buildReviewGateSummary(before, verification);
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reviewGate = reviewGate;
      const hasApplyFailure = draft.patchProposals.some((proposal) => proposal.status === "apply_failed");
      const hasPendingPatchReview = draft.patchProposals.some((proposal) => proposal.status === "proposed");
      const hasPendingPatchApply = draft.patchProposals.some((proposal) => proposal.status === "approved");
      const hasAppliedPatch = draft.patchProposals.some((proposal) => proposal.status === "applied");
      const hasPendingCommands = draft.commandRequests.some(
        (request) => request.status === "requested" || request.status === "approved" || request.status === "executing" || request.status === "running"
      );
      const hasFailedCommands = draft.commandRequests.some(
        (request) => request.status === "failed" || request.status === "blocked" || request.status === "rejected" || request.status === "denied" || request.status === "orphaned" || request.status === "terminated"
      );
      const reconciliationStatus = draft.reconciliationReport?.status;

      if (hasApplyFailure || hasFailedCommands || verification.status === "failed") {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "final_report", "completed", "Run failed after verification or authority errors.");
        return;
      }

      if (hasPendingPatchReview) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "review_final_diff", "active", "Patch review is waiting for operator approval.");
        return;
      }

      if (hasPendingPatchApply) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPLY";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "integrate_changes", "completed", "Patch proposal is approved and waiting for Rust apply.");
        setRunPhaseState(draft, "review_final_diff", "active", "Approved changes are waiting for Rust apply.");
        return;
      }

      if (hasAppliedPatch && hasPendingCommands) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = {
          kind: "approve_commands",
          message: "Patch applied. Run the requested verification commands through Rust."
        };
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Verification commands are still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Verification commands are waiting for operator execution.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "pending" || reconciliationStatus === "not_run")) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Reconciliation is still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Post-apply reconciliation is still pending.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "diverged" || reconciliationStatus === "failed")) {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "blocked", "Post-apply reconciliation diverged from the proposed patch.");
        setRunPhaseState(draft, "final_report", "completed", "Manual inspection is required because post-apply reconciliation diverged.");
        return;
      }

      if (hasAppliedPatch && reconciliationStatus === "unavailable") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        setRunPhaseState(draft, "run_verification", "blocked", "Patch applied, but reconciliation data is unavailable.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Manual inspection is required because reconciliation data is unavailable.");
        return;
      }

      if (hasAppliedPatch) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Verification is complete. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Review gate is satisfied.");
        setRunPhaseState(draft, "final_report", "completed", "Final report is ready.");
      }
    });

    const after = this.requireSession(sessionId);
    const summary = buildRuntimeRunSummary(after, verification);
    await this.sessionManager.setRunSummary(sessionId, summary);
  }

}

function setRunPhaseState(
  session: AgentRuntimeSession,
  phaseId: import("@orchcode/protocol").RunPhase["id"],
  status: import("@orchcode/protocol").RunPhase["status"],
  summary: string,
  evidenceCount?: number
) {
  const now = new Date().toISOString();
  session.runPhases = (session.runPhases ?? []).map((phase) =>
    phase.id === phaseId
      ? {
          ...phase,
          status,
          summary,
          evidenceCount,
          startedAt: phase.startedAt ?? now,
          completedAt: status === "completed" || status === "failed" || status === "blocked" ? now : undefined
        }
      : phase
  );
}

function createRealProvider(config: AgentRuntimeSession["providerConfig"]) {
  if (!config?.isValid || config.providerType !== "ollama") {
    throw new Error("real_provider requires a valid Ollama provider configuration.");
  }
  return new OllamaProvider(config.baseUrl, config.selectedModel);
}

function buildRuntimeVerification(session: AgentRuntimeSession) {
  const patchProposalCount = session.patchProposals.length;
  const appliedPatchCount = session.patchProposals.filter((proposal) => proposal.status === "applied").length;
  const applyFailed = session.patchProposals.some((proposal) => proposal.status === "apply_failed");
  const pendingPatchApply = session.patchProposals.some((proposal) => proposal.status === "approved");
  const pendingPatchReview = session.patchProposals.some((proposal) => proposal.status === "proposed");
  const reconciliation = session.reconciliationReport;
  const commandStatuses = session.commandRequests.map((request) => ({
    command: request.command,
    status: request.status
  }));
  const commandFailed = commandStatuses.some((command) => command.status === "failed" || command.status === "blocked" || command.status === "denied" || command.status === "orphaned" || command.status === "terminated");
  const commandPending = commandStatuses.some(
    (command) => command.status === "requested" || command.status === "approved" || command.status === "executing" || command.status === "running"
  );
  const commandExecuted = commandStatuses.filter((command) => command.status === "executed");
  const backgroundRunning = (session.backgroundJobs ?? []).some((job) => job.status === "running");

  return {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    status:
      applyFailed || commandFailed || reconciliation?.status === "diverged" || reconciliation?.status === "failed"
        ? "failed"
        : pendingPatchReview || pendingPatchApply || commandPending || backgroundRunning || reconciliation?.status === "pending"
          ? "pending"
          : reconciliation?.status === "unavailable"
            ? "unavailable"
          : "passed",
    summary:
      applyFailed
        ? "Patch apply failed."
        : commandFailed
          ? "At least one requested command failed."
          : reconciliation?.status === "diverged"
            ? "Post-apply reconciliation diverged from the proposed patch."
            : reconciliation?.status === "failed"
              ? "Post-apply reconciliation failed."
          : pendingPatchReview
            ? "Patch review is still pending."
            : pendingPatchApply
              ? "Patch was approved and is waiting for Rust apply."
              : reconciliation?.status === "pending"
                ? "Patch applied. Reconciliation is still pending."
                : reconciliation?.status === "unavailable"
                  ? "Patch applied, but reconciliation data is unavailable."
          : backgroundRunning
            ? "A background command is still running with limited tracking."
          : commandPending
                ? "Patch applied. Verification commands are still pending."
                : "Patch and command verification are complete.",
    checks: [
      {
        id: "patch_proposal",
        label: "Patch proposal",
        name: "Patch proposal",
        status: patchProposalCount ? "passed" : "pending",
        detail: patchProposalCount ? `${patchProposalCount} patch proposal(s) recorded.` : "No patch proposal recorded.",
        startedAt: session.createdAt,
        completedAt: patchProposalCount ? session.updatedAt : undefined,
        summary: patchProposalCount ? "Patch proposal captured." : "Patch proposal is missing."
      },
      {
        id: "rust_apply",
        label: "Rust apply",
        name: "Rust apply",
        status: applyFailed ? "failed" : appliedPatchCount ? "passed" : pendingPatchApply || pendingPatchReview ? "pending" : "passed",
        detail: applyFailed
          ? "Rust reported a patch apply failure."
          : appliedPatchCount
            ? `${appliedPatchCount} patch(es) applied through Rust.`
            : pendingPatchApply
              ? "Waiting for Rust to apply the approved patch."
              : pendingPatchReview
                ? "Patch is waiting for approval before Rust apply."
                : "No patch apply was required.",
        linkedPatchId: session.patchProposals.at(-1)?.id,
        startedAt: session.patchProposals.at(-1)?.createdAt,
        completedAt: appliedPatchCount || applyFailed ? session.updatedAt : undefined
      },
      {
        id: "reconciliation",
        label: "Reconciliation",
        name: "Reconciliation",
        status:
          reconciliation?.status === "matched"
            ? "passed"
            : reconciliation?.status === "diverged" || reconciliation?.status === "failed"
              ? "failed"
              : reconciliation?.status === "pending"
                ? "running"
                : reconciliation?.status === "unavailable"
                  ? "unavailable"
                  : appliedPatchCount
                    ? "not_run"
                    : "skipped",
        detail: reconciliation?.reason ?? (appliedPatchCount ? "Patch applied, but reconciliation has not been recorded yet." : "Reconciliation is skipped until a patch is applied."),
        linkedPatchId: reconciliation?.patchId ?? session.patchProposals.at(-1)?.id,
        startedAt: reconciliation?.checkedAt,
        completedAt: reconciliation && reconciliation.status !== "pending" ? reconciliation.checkedAt : undefined,
        summary: reconciliation?.reason
      },
      {
        id: "post_verify",
        label: "Post-verify",
        name: "Post-verify",
        status: commandFailed ? "failed" : commandPending || backgroundRunning ? "pending" : "passed",
        detail: commandFailed
          ? "At least one verification command failed or was blocked."
          : backgroundRunning
            ? "A background verification command is still running with limited tracking."
          : commandPending
            ? "Waiting for verification commands to run."
            : commandExecuted.length
              ? `Executed ${commandExecuted.length} verification command(s).`
              : "No verification command was required.",
        command: commandExecuted[0]?.command,
        startedAt: commandPending || commandExecuted.length ? session.updatedAt : undefined,
        completedAt: commandExecuted.length || commandFailed ? session.updatedAt : undefined,
        exitCode: session.commandExecutions.at(-1)?.exitCode,
        summary: commandExecuted.length ? "Verification commands completed." : "Verification commands are pending or not required."
      }
    ],
    createdAt: new Date().toISOString()
  } satisfies AgentRuntimeSession["verificationResult"];
}

function buildRuntimeRunSummary(session: AgentRuntimeSession, verification: NonNullable<AgentRuntimeSession["verificationResult"]>): RunSummary {
  const status: RunSummary["status"] =
    session.status === "failed"
      ? "failed"
      : session.status === "completed"
        ? "completed"
        : "blocked";
  return buildDiffAwareRunSummary(
    session,
    verification,
    status,
    session.status === "needs_approval"
      ? session.nextAction?.message ?? "Review the pending runtime action."
      : session.status === "failed"
        ? "Inspect the recorded patch or command failure."
        : "Review the applied change and verification result."
  );
}

function buildReviewGateSummary(
  session: AgentRuntimeSession,
  verification: NonNullable<AgentRuntimeSession["verificationResult"]>
): NonNullable<AgentRuntimeSession["reviewGate"]> {
  return buildAttributedReviewGate(session, verification);
}

function appendRuntimeAction(actions: string[] | undefined, next: string) {
  return [...(actions ?? []), next].slice(-8);
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function looksLikeTestCommand(command: string) {
  return /\b(test|vitest|jest|cargo test|npm test|pnpm test|yarn test|diff --check|tsc)\b/i.test(command);
}

function mergeRuntimeEvidenceRefs(
  existing: NonNullable<NonNullable<AgentRuntimeSession["orchestration"]>["agentRuns"]>[number]["evidenceRefs"] | undefined,
  next: import("@orchcode/protocol").EvidenceRef[]
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
