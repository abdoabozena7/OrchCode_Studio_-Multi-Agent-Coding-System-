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
        source: request?.provenance?.source ?? "agent",
        trigger: result.autoRun ? "auto_approved" : "manual",
        requestedBy: request?.provenance?.requestedBy ?? "runtime",
        approvalId: request?.provenance?.approvalId,
        toolCallId: request?.provenance?.toolCallId,
        reason: result.message ?? request?.reason
      },
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
        (request) => request.status === "requested" || request.status === "approved" || request.status === "executing"
      );
      const hasFailedCommands = draft.commandRequests.some(
        (request) => request.status === "failed" || request.status === "blocked" || request.status === "rejected"
      );

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
  const commandStatuses = session.commandRequests.map((request) => ({
    command: request.command,
    status: request.status
  }));
  const commandFailed = commandStatuses.some((command) => command.status === "failed" || command.status === "blocked");
  const commandPending = commandStatuses.some(
    (command) => command.status === "requested" || command.status === "approved" || command.status === "executing"
  );
  const commandExecuted = commandStatuses.filter((command) => command.status === "executed");

  return {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    status:
      applyFailed || commandFailed
        ? "failed"
        : pendingPatchReview || pendingPatchApply || commandPending
          ? "pending"
          : "passed",
    summary:
      applyFailed
        ? "Patch apply failed."
        : commandFailed
          ? "At least one requested command failed."
          : pendingPatchReview
            ? "Patch review is still pending."
            : pendingPatchApply
              ? "Patch was approved and is waiting for Rust apply."
              : commandPending
                ? "Patch applied. Verification commands are still pending."
                : "Patch and command verification are complete.",
    checks: [
      {
        name: "Patch proposal",
        status: patchProposalCount ? "passed" : "pending",
        detail: patchProposalCount ? `${patchProposalCount} patch proposal(s) recorded.` : "No patch proposal recorded."
      },
      {
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
                : "No patch apply was required."
      },
      {
        name: "Post-verify",
        status: commandFailed ? "failed" : commandPending ? "pending" : "passed",
        detail: commandFailed
          ? "At least one verification command failed or was blocked."
          : commandPending
            ? "Waiting for verification commands to run."
            : commandExecuted.length
              ? `Executed ${commandExecuted.length} verification command(s).`
              : "No verification command was required."
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
  return {
    status,
    summary: verification.summary,
    filesChanged: session.patchProposals.flatMap((patch) =>
      patch.filesChanged.map((file) => ({ path: file.path, added: 0, removed: 0, changeType: file.changeType }))
    ),
    appliedPatchIds: session.patchProposals.filter((patch) => patch.status === "applied").map((patch) => patch.id),
    proposedPatchIds: session.patchProposals.filter((patch) => patch.status !== "applied").map((patch) => patch.id),
    commandResults: session.commandRequests.map((request) => `${request.command}: ${request.status}`),
    gates: verification.checks.map((check) => ({
      name: check.name,
      status: check.status === "failed" ? "failed" : "passed",
      notes: [check.detail]
    })),
    nextAction:
      session.status === "needs_approval"
        ? session.nextAction?.message ?? "Review the pending runtime action."
        : session.status === "failed"
          ? "Inspect the recorded patch or command failure."
          : "Review the applied change and verification result.",
    createdAt: new Date().toISOString()
  };
}

function buildReviewGateSummary(
  session: AgentRuntimeSession,
  verification: NonNullable<AgentRuntimeSession["verificationResult"]>
): NonNullable<AgentRuntimeSession["reviewGate"]> {
  const files = session.patchProposals.flatMap((patch) => patch.filesChanged);
  const uniqueFiles = [...new Set(files.map((file) => file.path))];
  const riskyAreas = [
    ...session.patchProposals.filter((patch) => patch.riskLevel !== "low").map((patch) => `${patch.title} (${patch.riskLevel})`),
    ...verification.checks.filter((check) => check.status !== "passed").map((check) => check.name)
  ];
  const unresolvedBlockers = verification.checks.filter((check) => check.status !== "passed").map((check) => check.detail);
  const recommendation =
    verification.status === "failed"
      ? "do_not_apply"
      : verification.status === "pending" || session.status === "expired"
        ? "caution"
        : "ready";

  const agentName =
    session.orchestration?.agentRuns[0]?.agentName ??
    session.agentWorkStatuses[0]?.agentName ??
    session.agentName;

  const changesByAgent = (session.orchestration?.agentRuns ?? [])
    .filter((agent) => (agent.changedFiles?.length ?? 0) > 0)
    .map((agent) => ({
      agentName: agent.agentName,
      fileCount: agent.changedFiles?.length ?? 0,
      additions: agent.diffStats?.additions,
      deletions: agent.diffStats?.deletions,
      files: agent.changedFiles ?? []
    }));

  return {
    totalFilesChanged: uniqueFiles.length,
    changesByAgent:
      changesByAgent.length > 0
        ? changesByAgent
        : uniqueFiles.length > 0
          ? [{ agentName: `${agentName} (attribution not reported yet)`, fileCount: uniqueFiles.length, files: uniqueFiles }]
          : [],
    riskyAreas,
    verificationChecks: verification.checks,
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
