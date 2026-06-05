import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  CreateRuntimeSessionRequest,
  CreateRuntimeSessionResponse,
  ReportCommandResultRequest,
  ReportPatchApplyResultRequest,
  RunToGreenDiagnosis,
  RunSummary,
  RuntimeSessionStatus,
  RuntimeTurnResponse
} from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RuntimeConfig } from "../config.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { OllamaProvider } from "../llm/OllamaProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import {
  createProviderTelemetryRecorder,
  inferActiveProviderSource,
  TelemetryLlmProvider
} from "../llm/ProviderTelemetry.js";
import { runPatchIntentSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { SessionManager } from "./SessionManager.js";
import { createSimpleDelegationDecision, parsePromptDirective, resolveExecutionMode } from "./delegation.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import { RunEngine } from "./RunEngine.js";
import { OrchestratedRuntime } from "./OrchestratedRuntime.js";
import { CoreOrchestrator, loadPatchHistory, readRunArtifact } from "../orchestration/Orchestrator.js";
import { SwarmAutopilotRuntime } from "../orchestration/SwarmRuntime.js";
import { buildProjectIntake, classifyRunIntent } from "./ProjectIntake.js";
import {
  appendAgentJournalEntry,
  buildAttributedReviewGate,
  buildDiffAwareRunSummary
  ,buildReconciliationReport
} from "./AgentTelemetry.js";
import { summarizeModuleExecution, validatePatchAgainstModulePlan } from "./ModuleExecutionPlanning.js";
import { buildRepairPatchPrompt, collectRepairFileExcerpts, compileRepairPatchProposal, type RepairPatchIntentModel } from "./RepairPatchPlanning.js";
import {
  createDiagnosisFingerprint,
  diagnoseRunToGreenFailure,
  findAlternateRunToGreenCommand,
  getCurrentRunToGreenAttempt,
  markNextRunToGreenAttempt
} from "./RunToGreen.js";
import {
  createDirectConversationReply,
  directConversationProgressSummary,
  directConversationProgressTitle,
  type IntentDecision
} from "./IntentDecisionEngine.js";
import { createConversationUnderstanding, type ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { executionModeForConversationRoute } from "./ConversationRouter.js";

type PlanClarifyAction = {
  kind: "clarify_plan";
  message: string;
  options: Array<{
    id: string;
    label: string;
    prompt: string;
  }>;
  allowCustom?: boolean;
};

type AgentRuntimeOptions = {
  providerFactory?: (session: AgentRuntimeSession) => LlmProvider;
};

export class AgentRuntime {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly sessionManager: SessionManager,
    private readonly options: AgentRuntimeOptions = {}
  ) {}

  async createSession(input: CreateRuntimeSessionRequest): Promise<CreateRuntimeSessionResponse> {
    const mode = input.mode ?? this.config.defaultMode;
    assertProviderGate({
      mode,
      requireRealProvider: input.requireRealProvider,
      providerConfig: input.providerConfig
    });
    const session = await this.sessionManager.createSession({
      workspacePath: input.workspacePath,
      mode,
      trustProfile: input.trustProfile,
      requireRealProvider: input.requireRealProvider,
      providerConfig: input.providerConfig,
      activeProviderSource: input.activeProviderSource ?? inferActiveProviderSource(mode, input.providerConfig),
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
    const pendingAction = await this.handlePendingAction(session, message);
    if (pendingAction.handled) {
      return { sessionId, status: this.requireSession(sessionId).status };
    }
    const promptForExecution = pendingAction.resumePrompt ?? message;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "INTAKE";
      draft.nextAction = undefined;
    });
    if (!pendingAction.resumePrompt && shouldAnswerExplainEvidenceQuestion(message, session)) {
      const lastMessage = session.messages.at(-1);
      if (lastMessage?.role !== "user" || lastMessage.content !== message) {
        await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
      }
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: formatExplainEvidenceAnswer(session, message)
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = undefined;
      });
      return { sessionId, status: this.requireSession(sessionId).status };
    }

    const providerTelemetry = createProviderTelemetryRecorder({
      mode: session.mode,
      providerConfig: session.providerConfig,
      activeProviderSource: session.activeProviderSource
    });
    try {
      let provider: TelemetryLlmProvider | undefined;
      const conversationUnderstanding = pendingAction.resumePrompt
        ? undefined
        : createConversationUnderstanding(promptForExecution);
      if (conversationUnderstanding?.intentDecision.kind === "direct_conversation") {
        return this.completeDirectConversationTurn(sessionId, promptForExecution, conversationUnderstanding.intentDecision);
      }
      const tools = new ToolRegistry(session.workspacePath);
      const projectSummary = tools.workspace.getProjectSummary();
      const projectMap = {
        stack: Object.keys(projectSummary.languages),
        packageManagers: projectSummary.packageManagers,
        testCommands: projectSummary.testCommands,
        entryPoints: projectSummary.importantFiles.filter((file) => /main|index|app|server|lib\.rs/.test(file)).slice(0, 8),
        importantFiles: projectSummary.importantFiles
      };
      const parsedDirective = parsePromptDirective(promptForExecution);
      const routedExecutionMode = conversationUnderstanding
        ? executionModeForConversationRoute(conversationUnderstanding.routeDecision.route)
        : undefined;
      const modeResolution =
        session.executionMode === "auto_mode"
          ? parsedDirective.explicitMode || routedExecutionMode
            ? {
                mode: parsedDirective.explicitMode ?? routedExecutionMode!,
                directive: parsedDirective,
                complexity: createSimpleDelegationDecision({ prompt: promptForExecution, projectMap }).estimatedComplexity
              }
            : resolveExecutionMode(promptForExecution, projectMap)
          : {
              mode: session.executionMode,
              directive: parsedDirective,
              complexity: createSimpleDelegationDecision({ prompt: promptForExecution, projectMap }).estimatedComplexity
            };

      const requestedAgentCount = modeResolution.directive.requestedAgentCount ?? 0;
      if (modeResolution.mode === "orchestrated_mode" && shouldConfirmSingleFilePygamePlan(promptForExecution, requestedAgentCount)) {
        await this.sessionManager.updateSession(sessionId, (draft) => {
          draft.status = "needs_approval";
          draft.lifecycleStage = "PLAN";
          draft.resolvedExecutionMode = "orchestrated_mode";
          draft.agentName = "Dynamic Working Team";
          draft.orchestration ??= createEmptyOrchestration(draft);
          draft.delegationDecision = {
            ...createSimpleDelegationDecision({ prompt: promptForExecution, projectMap }),
            requestedAgentCount,
            selectedAgentCount: requestedAgentCount,
            rationale: "A single Python file can be built with multiple agents, but it needs explicit merge confirmation first."
          };
          draft.nextAction = {
            kind: "confirm_plan",
            message: `You asked for ${requestedAgentCount} agents to collaborate on one Python file. Confirm the merge plan before implementation starts so the workers do not collide on the same file.`
          };
          if (!draft.reasoningSummaries.some((entry) => /single python file/i.test(entry))) {
            draft.reasoningSummaries.push("Single-file Python work with multiple agents needs explicit merge confirmation before implementation.");
          }
        });
        return { sessionId, status: this.requireSession(sessionId).status };
      }

      const thinkFirst = session.thinkFirst || modeResolution.directive.thinkFirstRequested;
      if (thinkFirst) {
        const intake = buildProjectIntake({
          workspacePath: session.workspacePath,
          message: promptForExecution,
          projectMap,
          tools,
          conversationUnderstanding
        });
        const clarification = buildPlanClarification(promptForExecution, intake, conversationUnderstanding);
        if (clarification) {
          await this.sessionManager.updateSession(sessionId, (draft) => {
            draft.status = "needs_approval";
            draft.lifecycleStage = "PLAN";
            draft.projectIntake = intake;
            draft.nextAction = clarification as AgentRuntimeSession["nextAction"];
          });
          await this.sessionManager.addMessage(sessionId, {
            role: "assistant",
            content: clarification.message
          });
          return { sessionId, status: this.requireSession(sessionId).status };
        }
      }
      let updated: AgentRuntimeSession;
      if (modeResolution.mode === "orchestrated_mode" && session.mode === "real_provider") {
        provider ??= new TelemetryLlmProvider(this.getProvider(session), providerTelemetry);
        updated = await this.runProviderBackedSwarmTurn(sessionId, promptForExecution, provider, providerTelemetry, conversationUnderstanding);
      } else if (modeResolution.mode === "orchestrated_mode") {
        updated = await this.runOrchestratedTurn(sessionId, promptForExecution, projectMap, thinkFirst, conversationUnderstanding);
      } else {
        provider ??= new TelemetryLlmProvider(this.getProvider(session), providerTelemetry);
        updated = await new RunEngine(provider, this.sessionManager, { providerTelemetry }).runTurn(sessionId, promptForExecution, {
          resolvedMode: modeResolution.mode,
          projectMap,
          thinkFirst,
          conversationUnderstanding
        });
      }
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = modeResolution.mode;
      });
      return { sessionId, status: updated.status };
    } catch (error) {
      providerTelemetry.markProviderError(error);
      const providerGateFailure = isProviderGateFailure(error, session);
      if (providerGateFailure) {
        providerTelemetry.markFallback(providerGateFailure);
      }
      const failureMessage = providerGateFailure
        ? formatProviderFailureMessage(promptForExecution, error)
        : formatRunTurnFailureMessage(promptForExecution, error);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = providerGateFailure ? "failed_provider" : "failed";
        draft.lifecycleStage = "FAILED";
        draft.providerTelemetry = providerTelemetry.snapshot();
        draft.reasoningSummaries.push(formatRuntimeError(error));
        draft.runSummary = {
          status: "failed",
          summary: failureMessage.slice(0, 500),
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: draft.patchProposals.map((proposal) => proposal.id),
          commandResults: draft.commandExecutions.map((command) => command.command).slice(-5),
          gates: [{
            name: "Runtime turn",
            status: "failed",
            notes: [formatRuntimeError(error)]
          }],
          nextAction: "Fix the reported runtime/provider issue, then retry the request.",
          createdAt: new Date().toISOString()
        };
      });
      const failedSession = this.requireSession(sessionId);
      const lastAssistantMessage = failedSession.messages.filter((entry) => entry.role === "assistant").at(-1);
      if (lastAssistantMessage?.content !== failureMessage) {
        await this.sessionManager.addMessage(sessionId, { role: "assistant", content: failureMessage });
      }
      return { sessionId, status: providerGateFailure ? "failed_provider" : "failed" };
    }
  }

  private async completeDirectConversationTurn(sessionId: string, message: string, decision: IntentDecision): Promise<RuntimeTurnResponse> {
    const session = this.requireSession(sessionId);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const answer = createDirectConversationReply(decision);
    const now = new Date().toISOString();
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "completed";
      draft.lifecycleStage = "DONE";
      draft.resolvedExecutionMode = draft.executionMode === "auto_mode" ? "simple_mode" : draft.executionMode;
      draft.agentName = "Local Run";
      draft.nextAction = undefined;
      draft.runPhases = [];
    });
    await this.sessionManager.addProgressEvent(sessionId, {
      id: `progress_${randomUUID()}`,
      sessionId,
      stage: "completed",
      status: "completed",
      agentName: "IntentDecisionEngine",
      role: "Direct Conversation",
      taskTitle: directConversationProgressTitle(decision.language),
      summary: directConversationProgressSummary(decision),
      targetFiles: [],
      createdAt: now
    });
    await this.sessionManager.addMessage(sessionId, { role: "assistant", content: answer });
    await this.sessionManager.setRunSummary(sessionId, {
      status: "completed",
      summary: answer,
      filesChanged: [],
      appliedPatchIds: [],
      proposedPatchIds: [],
      commandResults: [],
      gates: [{
        name: "Pre-retrieval intent decision",
        status: "passed",
        notes: [decision.rationale]
      }],
      nextAction: "Send a project question, run request, or coding task when ready.",
      createdAt: now
    });
    return { sessionId, status: this.requireSession(sessionId).status };
  }

  getSession(sessionId: string): AgentRuntimeSession | undefined {
    return this.sessionManager.getSession(sessionId);
  }

  async approvePatch(sessionId: string, patchId: string) {
    const currentSession = this.requireSession(sessionId);
    if (currentSession.mode !== "demo_mock" && currentSession.latestScopeValidation?.verdict === "blocked") {
      throw new Error("Patch approval is blocked because the proposed changes exceed the scoped module plan.");
    }
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
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
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
    const afterPatch = this.requireSession(sessionId);
    if (result.status === "applied") {
      await this.queuePendingRunToGreenRerun(afterPatch, patchId, "Approved repair patch applied; rerun the selected command.");
    } else {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (draft.runToGreen?.pendingRepairPatchId === patchId) {
          const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
          if (attempt) {
            attempt.stopReason = "Repair patch failed to apply.";
          }
          draft.runToGreen.status = "failed";
          draft.runToGreen.finalStatus = "not_green";
          draft.runToGreen.blockerReason = "Repair patch failed to apply through Rust authority.";
          draft.runToGreen.pendingRepairPatchId = undefined;
          draft.runToGreen.pendingRerunCommand = undefined;
          draft.runToGreen.pendingRerunReason = undefined;
          draft.runToGreen.updatedAt = new Date().toISOString();
        }
      });
    }
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
      role: "assistant",
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
              : result.status === "blocked"
                ? "blocked"
                : result.status === "running" || result.status === "executing"
                  ? "running"
                  : "completed"
        });
      }
    });
    await this.advanceRunToGreenFromCommandResult(sessionId, record);
    await this.syncSessionOutcome(sessionId);
    return this.requireSession(sessionId);
  }

  private async stopRealProviderDeterministicOrchestration(sessionId: string, message: string): Promise<RuntimeTurnResponse> {
    const summary = "Orchestrated mode is currently deterministic/mock-worker based and does not call the configured LLM provider for worker understanding.";
    const content = [
      "I stopped before starting the multi-agent run.",
      "",
      summary,
      "",
      "Running it in real-provider mode would make deterministic worker output look like provider-backed understanding. Use simple mode with the real provider, or explicitly choose demo/mock orchestration."
    ].join("\n");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "failed";
      draft.lifecycleStage = "FAILED";
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.agentName = "Dynamic Working Team";
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.reasoningSummaries.push(summary);
      draft.runSummary = {
        status: "failed",
        summary,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [{
          name: "Provider-backed orchestration",
          status: "failed",
          notes: [summary]
        }],
        nextAction: "Use simple mode with the real provider, or explicitly run demo/mock orchestration.",
        createdAt: new Date().toISOString()
      };
    });
    const lastMessage = this.requireSession(sessionId).messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    await this.sessionManager.addMessage(sessionId, { role: "assistant", content });
    return { sessionId, status: this.requireSession(sessionId).status };
  }

  private getProvider(session: AgentRuntimeSession) {
    if (this.options.providerFactory) {
      const provider = this.options.providerFactory(session);
      if ((session.mode === "real_provider" || session.requireRealProvider) && provider instanceof MockLlmProvider) {
        throw new ProviderConfigurationError("provider_mock_forbidden", "MockProvider is forbidden when a real provider is required.");
      }
      return provider;
    }
    return session.mode === "real_provider"
      ? createRealProvider(session.providerConfig, this.config.providerRequestTimeoutMs)
      : new MockLlmProvider();
  }

  private async advanceRunToGreenFromCommandResult(sessionId: string, record: CommandExecutionRecord) {
    const session = this.requireSession(sessionId);
    const runToGreen = session.runToGreen;
    if (!runToGreen || runToGreen.status !== "running") {
      return;
    }

    const currentAttempt = getCurrentRunToGreenAttempt(runToGreen);
    if (!currentAttempt) {
      return;
    }

    const backgroundRunning =
      record.status === "running" ||
      record.status === "executing" ||
      record.backgroundJob?.status === "running" ||
      record.provenance?.background === true;
    const alternate = findAlternateRunToGreenCommand(runToGreen);
    const diagnosis: RunToGreenDiagnosis | undefined = backgroundRunning
      ? undefined
      : record.diagnosis
        ? {
            category: record.diagnosis.category === "not_git_repository"
              ? "not_git_repository"
              : record.diagnosis.category === "command_not_found"
                ? "command_not_found"
                : "unknown",
            confidence: record.diagnosis.category === "unknown" ? "low" : "high",
            evidence: {
              command: record.command,
              exitCode: record.exitCode,
              stdoutSummary: summarizeRuntimeOutput(record.stdout),
              stderrSummary: summarizeRuntimeOutput(record.stderr)
            },
            safeFixAvailable: false,
            requiresApproval: false,
            reason: record.diagnosis.summary
          }
      : record.status === "executed" || record.status === "completed"
        ? record.exitCode === 0
          ? undefined
          : diagnoseRunToGreenFailure({
              command: record.command,
              exitCode: record.exitCode,
              stdout: record.stdout,
              stderr: record.stderr,
              modulePlan: session.moduleExecutionPlan,
              hasAlternativeCommand: Boolean(alternate)
            })
        : diagnoseRunToGreenFailure({
            command: record.command,
            exitCode: record.exitCode,
            stdout: record.stdout,
            stderr: record.stderr,
            modulePlan: session.moduleExecutionPlan,
            hasAlternativeCommand: Boolean(alternate)
          });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const state = draft.runToGreen;
      if (!state) return;
      const attempt = state.attempts.find((entry) => entry.attemptNumber === state.currentAttempt);
      if (!attempt) return;
      attempt.completedAt = new Date().toISOString();
      attempt.exitCode = record.exitCode;
      attempt.stdoutSummary = summarizeRuntimeOutput(record.stdout);
      attempt.stderrSummary = summarizeRuntimeOutput(record.stderr);
      attempt.diagnosis = diagnosis;
      if (backgroundRunning) {
        attempt.status = "failed";
        attempt.stopReason = "Background or non-terminal command state does not count as green.";
        state.status = "blocked";
        state.finalStatus = "blocked";
        state.blockerReason = "The selected command started a background or non-terminal process, so the run-to-green loop stopped without claiming success.";
      } else if ((record.status === "executed" || record.status === "completed") && record.exitCode === 0) {
        attempt.status = "passed";
        state.status = "passed";
        state.finalStatus = "green";
        state.blockerReason = undefined;
      } else {
        attempt.status = "failed";
        state.finalStatus = "not_green";
      }
      state.updatedAt = new Date().toISOString();
    });

    const updated = this.requireSession(sessionId);
    const updatedRun = updated.runToGreen;
    const updatedAttempt = updatedRun ? getCurrentRunToGreenAttempt(updatedRun) : undefined;
    if (!updatedRun || !updatedAttempt || updatedRun.status !== "running") {
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((record.status === "executed" || record.status === "completed") && record.exitCode === 0) {
      await this.recordRunToGreenDecision(sessionId, undefined, record.command, "Selected command passed; the bounded repair loop stopped successfully.");
      return;
    }

    const previousFailedAttempt = updatedRun.attempts
      .filter((entry) => entry.attemptNumber < updatedRun.currentAttempt && entry.status === "failed")
      .at(-1);
    const repeatedFailure =
      createDiagnosisFingerprint(previousFailedAttempt?.diagnosis) !== "" &&
      createDiagnosisFingerprint(previousFailedAttempt?.diagnosis) === createDiagnosisFingerprint(diagnosis);
    if (repeatedFailure) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "The same diagnosis repeated without clear progress, so the bounded repair loop stopped.";
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if (updatedRun.currentAttempt >= updatedRun.maxAttempts) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "max_attempts_reached";
        draft.runToGreen.finalStatus = "not_green";
        draft.runToGreen.blockerReason = `Run-to-green stopped after ${draft.runToGreen.maxAttempts} attempt(s).`;
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((diagnosis?.category === "script_missing" || diagnosis?.category === "command_not_found") && alternate) {
      await this.queueRunToGreenCommandRequest(sessionId, alternate, diagnosis.reason);
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    if (!diagnosis || diagnosis.confidence === "low" || diagnosis.category === "unknown" || !diagnosis.safeFixAvailable) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = diagnosis?.category === "unknown" ? "blocked" : "not_green";
        draft.runToGreen.blockerReason = diagnosis?.reason ?? "Run-to-green could not continue safely.";
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
      return;
    }

    await this.proposeRunToGreenRepair(sessionId, record, diagnosis);
    await this.recordRunToGreenDecision(sessionId, diagnosis, record.command);
  }

  private async proposeRunToGreenRepair(sessionId: string, record: CommandExecutionRecord, diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>>) {
    const session = this.requireSession(sessionId);
    const modulePlan = session.moduleExecutionPlan;
    if (!modulePlan) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "No scoped module plan was available for a safe repair patch.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }

    const tools = new ToolRegistry(session.workspacePath);
    const provider = this.getProvider(session);
    const relevantFiles = collectRepairFileExcerpts(tools, uniqueRuntimeStrings([
      diagnosis.evidence.filePath ?? "",
      ...modulePlan.relevantFiles
    ]));
    const repairObjectiveSource = session.runToGreen?.objective ?? session.userPrompt;
    const repairUnderstanding = createConversationUnderstanding(repairObjectiveSource);
    const repairObjective = repairUnderstanding.intentDecision.kind === "direct_conversation"
      ? repairObjectiveSource
      : repairUnderstanding.workspaceMessage || repairObjectiveSource;
    const prompt = buildRepairPatchPrompt({
      objective: repairObjective,
      command: record.command,
      diagnosis,
      modulePlan,
      relevantFiles
    });
    const generated = await provider.generateStructured<Partial<RepairPatchIntentModel>>(
      { systemPrompt: "You produce strict JSON repair patch intents for small scoped fixes only. Any title field you return must be at most four words.", userPrompt: prompt },
      runPatchIntentSchema
    );
    const validation = validateStructuredOutput(generated, runPatchIntentSchema);
    if (!validation.valid || !generated.intents?.length) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "No safe scoped repair patch could be generated confidently.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }

    const patchInput = compileRepairPatchProposal(session.workspacePath, tools, generated as RepairPatchIntentModel);
    const patch = tools.patch.propose(patchInput, sessionId);
    const patchValidation = tools.patch.validate(patch);
    const scopeValidation = validatePatchAgainstModulePlan(modulePlan, patch, tools.workspace);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const state = draft.runToGreen;
      if (!state) return;
      const attempt = state.attempts.find((entry) => entry.attemptNumber === state.currentAttempt);
      if (attempt) {
        attempt.proposedFixSummary = patch.summary;
        attempt.changedFiles = patch.filesChanged.map((file) => file.path);
        attempt.scopeVerdict = scopeValidation.verdict;
      }
      draft.latestScopeValidation = scopeValidation;
      if (!patchValidation.valid || scopeValidation.verdict === "blocked") {
        state.status = "blocked";
        state.finalStatus = "blocked";
        state.blockerReason = !patchValidation.valid
          ? `Repair patch validation failed: ${patchValidation.errors.join("; ")}`
          : scopeValidation.reasons[0] ?? "Repair patch exceeded the scoped module boundary.";
        state.updatedAt = new Date().toISOString();
        return;
      }
      state.pendingRepairPatchId = patch.id;
      state.pendingRerunCommand = record.command;
      state.pendingRerunReason = `Retry ${record.command} after applying the scoped repair patch.`;
      state.updatedAt = new Date().toISOString();
      draft.reviewGate = draft.reviewGate
        ? {
            ...draft.reviewGate,
            scopeValidation,
            recommendation: scopeValidation.verdict === "needs_review" ? "caution" : draft.reviewGate.recommendation
          }
        : draft.reviewGate;
    });

    const after = this.requireSession(sessionId);
    if (after.runToGreen?.status === "blocked") {
      return;
    }

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, unifiedDiff: patch.unifiedDiff, filesChanged: patch.filesChanged },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "patch.proposed",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, diagnosis },
      status: "proposed",
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "scope.validation.requested",
      title: "Run-to-green scope validation",
      summary: `Validated ${patch.filesChanged.length} repair file(s) against the module plan.`,
      payload: { patchId: patch.id, verdict: scopeValidation.verdict, reasons: scopeValidation.reasons },
      status: scopeValidation.verdict === "blocked" ? "blocked" : "executed",
      createdAt: new Date().toISOString()
    });
  }

  private async queuePendingRunToGreenRerun(session: AgentRuntimeSession, patchId: string, reason: string) {
    if (!session.runToGreen || session.runToGreen.pendingRepairPatchId !== patchId || !session.runToGreen.pendingRerunCommand) {
      return;
    }
    const selected = session.runToGreen.selectedCommands.find((command) => command.command === session.runToGreen?.pendingRerunCommand);
    if (!selected) {
      await this.sessionManager.updateSession(session.id, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = "Repair patch applied, but the rerun command could not be recovered safely.";
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
      return;
    }
    await this.queueRunToGreenCommandRequest(session.id, selected, session.runToGreen.pendingRerunReason ?? reason);
  }

  private async queueRunToGreenCommandRequest(sessionId: string, command: { command: string; cwd: string; reason: string }, reason: string) {
    const session = this.requireSession(sessionId);
    const now = new Date().toISOString();
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (!draft.runToGreen) return;
      markNextRunToGreenAttempt(draft.runToGreen, {
        command: command.command,
        cwd: command.cwd,
        source: "project_intake_command",
        reason
      }, reason, now);
    });
    const request = buildRuntimeCommandRequest(sessionId, command.command, command.cwd, reason);
    await this.sessionManager.addCommandRequest(sessionId, request);
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "command.requested",
      title: request.command,
      summary: reason,
      payload: { commandRequestId: request.id, risk: request.risk, runToGreen: true },
      status: request.status === "blocked" ? "blocked" : "proposed",
      createdAt: now
    });
    if (request.status === "blocked") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        if (!draft.runToGreen) return;
        draft.runToGreen.status = "blocked";
        draft.runToGreen.finalStatus = "blocked";
        draft.runToGreen.blockerReason = `Selected rerun command was blocked by policy: ${request.command}`;
        const attempt = draft.runToGreen.attempts.find((entry) => entry.attemptNumber === draft.runToGreen?.currentAttempt);
        if (attempt) {
          attempt.stopReason = draft.runToGreen.blockerReason;
        }
        draft.runToGreen.updatedAt = new Date().toISOString();
      });
    }
  }

  private async recordRunToGreenDecision(sessionId: string, diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>> | undefined, command: string, successNote?: string) {
    const session = this.requireSession(sessionId);
    if (!session.runToGreen) return;
    const finding = successNote
      ? "Run-to-green attempt passed."
      : diagnosis
        ? `Run-to-green diagnosed ${diagnosis.category}.`
        : "Run-to-green updated attempt state.";
    const decision = successNote
      ? successNote
      : diagnosis?.safeFixAvailable
        ? "Attempt a narrow scoped repair or grounded rerun."
        : "Stop the bounded repair loop and ask for manual inspection.";
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.decisionLedger.push({
        id: `decision_${randomUUID()}`,
        sessionId,
        category: successNote ? "verification_note" : diagnosis?.safeFixAvailable ? "decision" : "risk",
        finding,
        decision,
        rationaleSummary: diagnosis?.reason ?? successNote ?? `Recorded command result for ${command}.`,
        evidenceRefs: [{
          type: "command",
          commandId: draft.commandRequests.at(-1)?.id ?? `unknown_${command}`
        }],
        linkedFiles: diagnosis?.evidence.filePath ? [diagnosis.evidence.filePath] : [],
        uncertainty: diagnosis?.confidence === "low" || diagnosis?.confidence === "unknown" ? diagnosis.reason : undefined,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"],
        createdAt: new Date().toISOString()
      });
    });
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error("Session not found");
    }
    return session;
  }

  private async handlePendingAction(session: AgentRuntimeSession, message: string): Promise<{ handled: boolean; resumePrompt?: string }> {
    if (!session.nextAction) return { handled: false };
    const normalized = message.trim().toLowerCase();
    const maybeClarify = session.nextAction as typeof session.nextAction | PlanClarifyAction;
    if (maybeClarify.kind === "clarify_plan") {
      const selected =
        maybeClarify.options.find((option) => option.id === normalized || option.label.toLowerCase() === normalized)
        ?? maybeClarify.options.find((option) => option.prompt.toLowerCase() === normalized);
      const clarification = (selected?.prompt ?? message).trim();
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined as AgentRuntimeSession["nextAction"];
        draft.thinkFirst = true;
        draft.userPrompt = `${draft.userPrompt}\n\nPlan mode clarification: ${clarification}`;
      });
      return { handled: false, resumePrompt: `${session.userPrompt}\n\nPlan mode clarification: ${clarification}` };
    }
    if (session.nextAction.kind === "confirm_plan") {
      if (/\b(proceed|continue|implement|go ahead|start)\b/.test(normalized)) {
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = undefined;
          draft.thinkFirst = false;
        });
        return { handled: false, resumePrompt: session.userPrompt };
      }
      await this.sessionManager.addMessage(session.id, {
        role: "assistant",
        content: "Okay. Review the plan and tell me when to proceed with implementation."
      });
      return { handled: true };
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
        return { handled: true };
      }

      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined;
      });
      await this.sessionManager.addMessage(session.id, {
        role: "assistant",
        content: "Okay. I left the result in review mode without running the preview."
      });
      return { handled: true };
    }

    return { handled: false };
  }

  private async runOrchestratedTurn(
    sessionId: string,
    message: string,
    projectMap: import("@hivo/protocol").ProjectMap,
    thinkFirst: boolean,
    conversationUnderstanding?: ConversationUnderstanding
  ) {
    const session = this.sessionManager.getSession(sessionId)!;
    const mappedMode: import("../orchestration/OrchestrationConfig.js").ExecutionMode = session.executionMode === "auto_mode" ? "deep" : session.executionMode === "simple_mode" ? "fast" : "exhaustive";
    const orchestrator = new CoreOrchestrator({
      workspacePath: session.workspacePath,
      config: { execution_mode: mappedMode },
      providerFactory: () => this.getProvider(session),
      onEvent: (event) => {
        if (event.type === "agent.invocation_started") {
          this.sessionManager.updateSession(sessionId, (draft) => {
            const currentSummary = draft.runSummary?.summary || "";
            draft.runSummary = {
              ...(draft.runSummary || { status: "pending", filesChanged: [], appliedPatchIds: [], proposedPatchIds: [], commandResults: [], gates: [], createdAt: new Date().toISOString() }),
              summary: `${currentSummary}\nAgent started: ${event.message}`.trim()
            };
          });
        }
      }
    });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "PLAN";
    });

    const orchestrationRequest = conversationUnderstanding?.workspaceMessage || message;
    const result = thinkFirst
      ? await orchestrator.planOnly(orchestrationRequest)
      : await orchestrator.runAgenticTask(orchestrationRequest);

    const patches = await loadPatchHistory(session.workspacePath, result.run.id);
    const mappedPatches: import("@hivo/protocol").PatchProposal[] = [];
    for (const patchPath of patches) {
      try {
        const text = await readRunArtifact(session.workspacePath, result.run.id, patchPath);
        const parsed = JSON.parse(text);
        mappedPatches.push({
          id: parsed.id ?? `patch_${Date.now()}_${Math.random()}`,
          sessionId,
          title: parsed.title ?? "Proposed Patch",
          summary: parsed.summary ?? "Changes from orchestration",
          riskLevel: "medium",
          filesChanged: (parsed.files_changed ?? []).map((f: any) => ({
            path: typeof f === "string" ? f : f.path,
            changeType: "modify",
            explanation: "Modified by orchestration"
          })),
          artifacts: [],
          unifiedDiff: parsed.diff ?? "",
          requiresApproval: true,
          status: "proposed",
          createdAt: new Date().toISOString()
        });
      } catch (e) {}
    }
    
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = result.run.status === "succeeded" ? "needs_approval" : result.run.status === "failed" ? "failed" : "blocked";
      draft.lifecycleStage = result.run.status === "succeeded" ? "APPROVAL" : "BLOCKED";
      
      draft.patchProposals = mappedPatches;
      
      draft.tasks = result.tasks.map(t => ({
        id: t.id,
        sessionId,
        title: t.title,
        status: t.status === "succeeded" ? "done" : t.status === "running" ? "in_progress" : t.status === "failed" ? "blocked" : "todo",
        agentRole: t.role_required,
        createdAt: new Date().toISOString()
      }));

      draft.runSummary = {
        status: result.run.status === "succeeded" ? "completed" : result.run.status === "failed" ? "failed" : "pending",
        summary: result.run.summary ?? "Run completed.",
        filesChanged: result.report.files_changed.map(f => ({ path: f, changeType: "modify" })),
        appliedPatchIds: [],
        proposedPatchIds: draft.patchProposals.map(p => p.id),
        commandResults: [],
        gates: [],
        createdAt: new Date().toISOString()
      };
      
      if (thinkFirst) {
        draft.status = "needs_approval";
        draft.nextAction = {
          kind: "confirm_plan",
          message: "Plan is ready. Want me to proceed with implementation?"
        };
      }
    });

    if (thinkFirst) {
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: `I stayed in plan mode only: I organized the team and the steps, then stopped before any edits.\n\nPlanned ${result.tasks.length} task(s).`
      });
    } else {
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: result.run.summary ?? "Orchestration run completed."
      });
    }

    return this.sessionManager.getSession(sessionId)!;
  }

  private async runProviderBackedSwarmTurn(
    sessionId: string,
    message: string,
    provider: LlmProvider,
    providerTelemetry: ReturnType<typeof createProviderTelemetryRecorder>,
    conversationUnderstanding?: ConversationUnderstanding
  ) {
    const session = this.sessionManager.getSession(sessionId)!;
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "EXECUTION_DRAFT";
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.agentName = "Provider-Backed Swarm";
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.reasoningSummaries.push("Real-provider orchestration is using provider-backed read-only swarm workers; deterministic mock workers are not accepted as the assistant answer.");
    });

    const swarmGoal = conversationUnderstanding?.workspaceMessage || message;
    const swarm = new SwarmAutopilotRuntime({
      workspacePath: session.workspacePath,
      mode: "deep",
      workerMode: "provider_read_only",
      providerFactory: () => provider,
      providerName: session.providerConfig?.providerName,
      modelName: session.providerConfig?.selectedModel
    });
    const result = await swarm.run(swarmGoal);
    const workResults = await loadSwarmWorkResults(result.workItems);
    const terminalStatus = mapSwarmRunStatus(result.run.status, providerTelemetry.snapshot().lastError);
    const completedAt = new Date().toISOString();
    const summary = formatProviderBackedSwarmAnswer({
      finalReport: result.finalReport,
      providerCallCount: providerTelemetry.snapshot().providerRequestCount,
      workerCount: result.staffingPlan.recommended_total_logical_agents,
      workResults,
      status: terminalStatus,
      providerFailures: providerTelemetry.snapshot().providerFailureCount,
      providerTimeouts: providerTelemetry.snapshot().providerTimeoutCount,
      invalidStructuredOutputs: result.metrics.invalid_structured_outputs,
      retries: result.metrics.retries
    });

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = terminalStatus;
      draft.lifecycleStage = terminalStatus === "completed" ? "DONE" : terminalStatus === "blocked" ? "BLOCKED" : "FAILED";
      draft.nextAction = undefined;
      draft.providerTelemetry = providerTelemetry.snapshot();
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.delegationDecision = {
        resolvedMode: "orchestrated_mode",
        selectedAgentCount: result.staffingPlan.recommended_total_logical_agents,
        selectedAgentRoles: Object.entries(result.staffingPlan.role_counts)
          .filter(([, count]) => count > 0)
          .map(([role, count]) => `${role} x${count}`),
        agentRoleReasons: result.staffingPlan.reasoning.map((reason, index) => ({
          agentName: `staffing_reason_${index + 1}`,
          reason
        })),
        estimatedComplexity: result.staffingPlan.task_complexity === "tiny" || result.staffingPlan.task_complexity === "small" ? "low" : result.staffingPlan.task_complexity === "medium" ? "medium" : "high",
        rationale: "Provider-backed swarm selected read-only agents automatically from repository scope, risk, and task complexity."
      };
      draft.tasks = result.workItems.map((item) => ({
        id: item.id,
        sessionId,
        title: `${item.required_role} ${item.type}`,
        status: mapSwarmWorkStatus(item.status),
        agentRole: item.required_role,
        createdAt: item.created_at
      }));
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.selectedWorkerAgents = Object.entries(result.staffingPlan.role_counts)
        .filter(([, count]) => count > 0)
        .map(([role, count]) => `${role} x${count}`);
      draft.orchestration.agentRuns = result.agentInstances.map((agent) => ({
        id: agent.id,
        sessionId,
        agentName: agent.role,
        displayName: agent.role,
        role: agent.role,
        roleTitle: agent.role,
        lifecycleStage: terminalStatus === "completed" ? "DONE" : terminalStatus === "blocked" ? "BLOCKED" : "FAILED",
        artifactJson: {
          swarmRunId: result.run.id,
          currentWorkItemId: agent.current_work_item_id,
          workerMode: "provider_read_only"
        },
        objective: `Provider-backed read-only ${agent.role} work for ${swarmGoal}`,
        currentTask: agent.current_work_item_id,
        status: mapSwarmAgentStatus(agent.status),
        lastEvent: `Completed ${agent.completed_work_item_count} work item(s); failures ${agent.failure_count}.`,
        startedAt: agent.created_at,
        completedAt
      }));
      draft.orchestration.workerOutputs = workResults.map((workResult) => ({
        id: `worker_output_${workResult.work_item_id}`,
        sessionId,
        taskId: workResult.work_item_id,
        agentName: result.workItems.find((item) => item.id === workResult.work_item_id)?.required_role ?? "SwarmWorker",
        summary: workResult.summary,
        details: [...workResult.findings, ...workResult.unknowns.map((unknown) => `Unknown: ${unknown}`)],
        patchProposalIds: [],
        commandRequestIds: [],
        risks: workResult.risks,
        status: workResult.status === "succeeded" ? "completed" : workResult.status,
        createdAt: completedAt
      }));
      draft.runSummary = {
        status: terminalStatus === "completed" ? "completed" : terminalStatus === "blocked" ? "pending" : "failed",
        summary: `Provider-backed swarm ${result.run.status}; ${result.staffingPlan.recommended_total_logical_agents} logical agent(s), ${providerTelemetry.snapshot().providerRequestCount} provider request(s).`,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [{
          name: "Provider-backed read-only swarm",
          status: terminalStatus === "completed" ? "passed" : terminalStatus === "blocked" ? "blocked" : "failed",
          notes: [
            `workerMode=provider_read_only`,
            `providerRequests=${providerTelemetry.snapshot().providerRequestCount}`,
            `providerFailures=${providerTelemetry.snapshot().providerFailureCount}`,
            `providerTimeouts=${providerTelemetry.snapshot().providerTimeoutCount}`,
            `invalidStructuredOutputs=${result.metrics.invalid_structured_outputs}`,
            `retries=${result.metrics.retries}`,
            `fallbackUsed=${providerTelemetry.snapshot().fallbackUsed ? "yes" : "no"}`
          ]
        }],
        nextAction: terminalStatus === "completed" ? "Provider-backed session update completed." : "Inspect provider and swarm worker artifacts before retrying.",
        createdAt: completedAt
      };
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: summary
    });
    return this.sessionManager.getSession(sessionId)!;
  }

  private async syncSessionOutcome(sessionId: string) {
    const before = this.requireSession(sessionId);
    const verification = buildRuntimeVerification(before);
    const reviewGate = buildReviewGateSummary(before, verification);
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reviewGate = reviewGate;
      if (draft.moduleExecutionPlan) {
        draft.moduleExecutionPlan.updatedAt = new Date().toISOString();
      }
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
      const scopeVerdict = draft.latestScopeValidation?.verdict;
      const runToGreenStatus = draft.runToGreen?.status;
      const runToGreenActive = runToGreenStatus === "running";

      if (runToGreenStatus === "passed") {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        draft.nextAction = draft.previewRecommendation
          ? {
              kind: "preview_ready",
              message: "Run-to-green command passed. The preview can be opened now.",
              preview: draft.previewRecommendation
            }
          : undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "completed", "Run-to-green completed successfully.");
        setRunPhaseState(draft, "final_report", "completed", "Final run-to-green report is ready.");
        return;
      }

      const noRunnableCommandOnly =
        runToGreenStatus === "blocked"
        && (draft.runToGreen?.currentAttempt ?? 0) === 0
        && !draft.commandExecutions.length
        && !draft.patchProposals.length;

      if (noRunnableCommandOnly) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
        setRunPhaseState(draft, "run_verification", "completed", verification.summary, verification.checks.length);
        setRunPhaseState(
          draft,
          "review_final_diff",
          "completed",
          draft.previewRecommendation
            ? "Preview is available even though no grounded run command was found."
            : "No grounded run command was found for this workspace."
        );
        setRunPhaseState(
          draft,
          "final_report",
          "completed",
          draft.previewRecommendation
            ? "The run finished with a preview recommendation."
            : "The run finished without a runnable command."
        );
        return;
      }

      if (runToGreenStatus === "blocked" || runToGreenStatus === "failed" || runToGreenStatus === "max_attempts_reached" || runToGreenStatus === "cancelled") {
        draft.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        draft.lifecycleStage = runToGreenStatus === "blocked" ? "BLOCKED" : "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = runToGreenStatus === "blocked" ? "blocked" : "failed";
        }
        setRunPhaseState(draft, "run_verification", runToGreenStatus === "blocked" ? "blocked" : "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped.");
        setRunPhaseState(draft, "final_report", runToGreenStatus === "blocked" ? "blocked" : "completed", draft.runToGreen?.blockerReason ?? "Run-to-green stopped without success.");
        return;
      }

      if (scopeVerdict === "blocked" && draft.mode !== "demo_mock") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "BLOCKED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "review_final_diff", "blocked", "Module scope validation blocked the proposed change set.", 0);
        setRunPhaseState(draft, "final_report", "blocked", "Run is blocked until the patch returns inside the scoped module boundary.");
        return;
      }

      if (hasApplyFailure || (!runToGreenActive && hasFailedCommands) || verification.status === "failed") {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "final_report", "completed", "Run failed after verification or authority errors.");
        return;
      }

      if (hasPendingPatchReview) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPROVAL";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = draft.latestScopeValidation?.verdict === "needs_review" ? "blocked" : "running";
        }
        setRunPhaseState(draft, "review_final_diff", "active", "Patch review is waiting for operator approval.");
        return;
      }

      if (hasPendingPatchApply) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "APPLY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "integrate_changes", "completed", "Patch proposal is approved and waiting for Rust apply.");
        setRunPhaseState(draft, "review_final_diff", "active", "Approved changes are waiting for Rust apply.");
        return;
      }

      if (hasAppliedPatch && hasPendingCommands) {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
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
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "running";
        }
        setRunPhaseState(draft, "run_verification", "active", "Patch applied. Reconciliation is still pending.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Post-apply reconciliation is still pending.");
        return;
      }

      if (hasAppliedPatch && (reconciliationStatus === "diverged" || reconciliationStatus === "failed")) {
        draft.status = "failed";
        draft.lifecycleStage = "FAILED";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "failed";
        }
        setRunPhaseState(draft, "run_verification", "failed", verification.summary, verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "blocked", "Post-apply reconciliation diverged from the proposed patch.");
        setRunPhaseState(draft, "final_report", "completed", "Manual inspection is required because post-apply reconciliation diverged.");
        return;
      }

      if (hasAppliedPatch && reconciliationStatus === "unavailable") {
        draft.status = "needs_approval";
        draft.lifecycleStage = "POST_VERIFY";
        draft.nextAction = undefined;
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "blocked";
        }
        setRunPhaseState(draft, "run_verification", "blocked", "Patch applied, but reconciliation data is unavailable.", verification.checks.length);
        setRunPhaseState(draft, "review_final_diff", "active", "Manual inspection is required because reconciliation data is unavailable.");
        return;
      }

      if (hasAppliedPatch) {
        draft.status = "completed";
        draft.lifecycleStage = "DONE";
        if (draft.moduleExecutionPlan) {
          draft.moduleExecutionPlan.status = "completed";
        }
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

    await this.sessionManager.updateSession(sessionId, (draft) => {
      const agent = draft.orchestration?.agentRuns.find((candidate) => candidate.id === "agent_local_codex");
      if (!agent) return;
      agent.status =
        draft.status === "completed"
          ? "completed"
          : draft.status === "failed" || draft.status === "failed_provider"
            ? "failed"
            : draft.status === "blocked"
              ? "blocked"
              : draft.status === "needs_approval"
                ? "running"
              : agent.status;
      agent.lifecycleStage = draft.lifecycleStage;
      agent.currentAction = draft.runSummary?.summary ?? draft.runToGreen?.blockerReason ?? agent.currentAction;
      agent.lastEvent = `sync:${draft.status}`;
      if ((agent.status === "completed" || agent.status === "failed" || agent.status === "blocked") && !agent.completedAt) {
        agent.completedAt = new Date().toISOString();
      }
    });

    const after = this.requireSession(sessionId);
    const moduleSummary = summarizeModuleExecution(after, verification);
    if (moduleSummary) {
      const previous = after.moduleExecutionSummaries?.find((entry) => entry.id === moduleSummary.id);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const existingIndex = draft.moduleExecutionSummaries?.findIndex((entry) => entry.id === moduleSummary.id) ?? -1;
        draft.moduleExecutionSummaries ??= [];
        if (existingIndex >= 0) {
          draft.moduleExecutionSummaries[existingIndex] = moduleSummary;
        } else {
          draft.moduleExecutionSummaries.push(moduleSummary);
        }
      });
      if (!previous || previous.status !== moduleSummary.status || previous.updatedAt !== moduleSummary.updatedAt) {
        await this.sessionManager.addArtifact(sessionId, {
          id: `artifact_${randomUUID()}`,
          sessionId,
          type: "module_execution_summary",
          title: moduleSummary.title,
          summary: moduleSummary.summary,
          payload: { moduleSummary },
          createdAt: new Date().toISOString()
        });
      }
    }
    const summary = buildRuntimeRunSummary(after, verification);
    await this.sessionManager.setRunSummary(sessionId, summary);
  }

}

function buildPlanClarification(
  message: string,
  intake: ReturnType<typeof buildProjectIntake>,
  conversationUnderstanding?: ConversationUnderstanding
): PlanClarifyAction | null {
  const normalized = message.trim().toLowerCase();
  const genericPlanPrompt =
    normalized.length < 100 &&
    !/\b(auth|api|ui|frontend|backend|database|tests?|deploy|runtime|module|component|page|screen|schema)\b/.test(normalized) &&
    (/\b(plan|think|analyze|review|understand|explain)\b/.test(normalized) || /(خط|خطة|حلل|اشرح|راجع|افهم)/.test(normalized));
  const unknownIntent = classifyRunIntent(message, conversationUnderstanding) === "unknown";
  const manyAreas = (intake.moduleSummary?.length ?? 0) >= 4 || intake.importantFiles.length >= 8;
  if (!genericPlanPrompt && !(unknownIntent && manyAreas)) return null;

  return {
    kind: "clarify_plan",
    message:
      containsArabic(message)
        ? "قبل ما أطلع الخطة، عايز أحدد نوعها بدقة أكثر. اختار الاتجاه الأقرب، أو اكتب اختيارك بنفسك."
        : "Before I build the plan, I want to narrow the shape of it a bit. Pick the closest direction, or write your own.",
    options: containsArabic(message)
      ? [
          {
            id: "implementation",
            label: "خطة تنفيذ آمنة",
            prompt: "اعمل plan mode يركز على safe implementation plan step by step based on the current codebase."
          },
          {
            id: "architecture",
            label: "خطة فهم المعمارية",
            prompt: "اعمل plan mode يركز على architecture understanding, important modules, and data flow based on the current codebase."
          },
          {
            id: "run_setup",
            label: "خطة تشغيل وإعداد",
            prompt: "اعمل plan mode يركز على setup, environment, and how to run the current project safely."
          }
        ]
      : [
          {
            id: "implementation",
            label: "Safe implementation plan",
            prompt: "Use plan mode and focus on a safe implementation plan step by step based on the current codebase."
          },
          {
            id: "architecture",
            label: "Architecture understanding plan",
            prompt: "Use plan mode and focus on architecture understanding, important modules, and data flow based on the current codebase."
          },
          {
            id: "run_setup",
            label: "Run and setup plan",
            prompt: "Use plan mode and focus on setup, environment, and how to run the current project safely."
          }
        ],
    allowCustom: true
  };
}

function containsArabic(value: string) {
  return /[\u0600-\u06FF]/.test(value);
}

function setRunPhaseState(
  session: AgentRuntimeSession,
  phaseId: import("@hivo/protocol").RunPhase["id"],
  status: import("@hivo/protocol").RunPhase["status"],
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

export class ProviderConfigurationError extends Error {
  constructor(
    public readonly code:
      | "provider_missing"
      | "provider_api_key_missing"
      | "provider_validation_failed"
      | "provider_mock_forbidden",
    message: string
  ) {
    super(message);
  }
}

function assertProviderGate(input: {
  mode: AgentRuntimeSession["mode"];
  requireRealProvider?: boolean;
  providerConfig?: AgentRuntimeSession["providerConfig"];
}) {
  if (input.requireRealProvider && input.mode !== "real_provider") {
    throw new ProviderConfigurationError("provider_mock_forbidden", "MockProvider is forbidden when a real provider is required.");
  }
  if (input.mode !== "real_provider") return;
  validateRealProviderConfig(input.providerConfig);
}

function validateRealProviderConfig(config: AgentRuntimeSession["providerConfig"]): asserts config is NonNullable<AgentRuntimeSession["providerConfig"]> {
  if (!config) {
    throw new ProviderConfigurationError("provider_missing", "real_provider requires a provider configuration.");
  }
  if (!config.isValid || !config.baseUrl?.trim() || !config.selectedModel?.trim()) {
    throw new ProviderConfigurationError("provider_validation_failed", "real_provider requires a valid provider configuration.");
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    if (!process.env[apiKeyEnv]?.trim()) {
      throw new ProviderConfigurationError("provider_api_key_missing", `API key environment variable ${apiKeyEnv} is not configured.`);
    }
  }
}

function createRealProvider(config: AgentRuntimeSession["providerConfig"], timeoutMs: number) {
  validateRealProviderConfig(config);
  if (config.providerType === "ollama") {
    return new OllamaProvider(config.baseUrl, config.selectedModel, timeoutMs);
  }
  if (config.providerType === "openai_compatible") {
    const apiKeyEnv = config.apiKeyEnv?.trim() || "OPENAI_API_KEY";
    return new OpenAIProvider(process.env[apiKeyEnv], config.baseUrl, config.selectedModel, timeoutMs);
  }
  throw new ProviderConfigurationError("provider_validation_failed", `Unsupported provider type: ${config.providerType}`);
}

function formatCommandResultMessage(record: CommandExecutionRecord) {
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
  const runToGreen = session.runToGreen;
  const runToGreenActive = runToGreen?.status === "running";
  const runToGreenBlockedBeforeExecution =
    runToGreen?.status === "blocked"
    && session.commandRequests.length === 0
    && session.commandExecutions.length === 0
    && patchProposalCount === 0;
  const runToGreenTerminalFailure =
    (runToGreen?.status === "blocked" && !runToGreenBlockedBeforeExecution) ||
    runToGreen?.status === "failed" ||
    runToGreen?.status === "max_attempts_reached" ||
    runToGreen?.status === "cancelled";

  return {
    id: `verification_${randomUUID()}`,
    sessionId: session.id,
    status:
      runToGreenBlockedBeforeExecution
        ? "unavailable"
        : runToGreenTerminalFailure || applyFailed || (!runToGreenActive && commandFailed) || reconciliation?.status === "diverged" || reconciliation?.status === "failed"
        ? "failed"
        : runToGreen?.status === "running" || pendingPatchReview || pendingPatchApply || commandPending || backgroundRunning || reconciliation?.status === "pending"
          ? "pending"
        : reconciliation?.status === "unavailable"
            ? "unavailable"
          : runToGreen?.status === "blocked"
            ? "unavailable"
            : runToGreen && !commandPending && !commandExecuted.length && !patchProposalCount
              ? "skipped"
          : "passed",
    summary:
      runToGreenBlockedBeforeExecution
        ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
        : runToGreenTerminalFailure
        ? runToGreen?.blockerReason ?? "Run-to-green stopped without reaching a passing command result."
        : applyFailed
        ? "Patch apply failed."
        : !runToGreenActive && commandFailed
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
          : runToGreen?.status === "running"
            ? "Run-to-green is still waiting on a terminal command or repair result."
          : backgroundRunning
            ? "A background command is still running with limited tracking."
          : commandPending
                ? "Patch applied. Verification commands are still pending."
                : "Patch and command verification are complete.",
    checks: [
      {
        id: "run_to_green",
        label: "Run-to-green",
        name: "Run-to-green",
        status:
          runToGreen?.status === "passed"
            ? "passed"
            : runToGreenBlockedBeforeExecution
              ? "unavailable"
            : runToGreenTerminalFailure
              ? "failed"
              : runToGreen?.status === "running"
                ? "running"
                : runToGreen
                  ? "pending"
                  : "skipped",
        detail:
          runToGreen?.status === "passed"
            ? `Selected command passed on attempt ${runToGreen.currentAttempt}.`
            : runToGreenBlockedBeforeExecution
              ? (runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution.")
            : runToGreenTerminalFailure
              ? (runToGreen?.blockerReason ?? "Run-to-green stopped without reaching green.")
              : runToGreen?.status === "running"
                ? `Attempt ${runToGreen.currentAttempt}/${runToGreen.maxAttempts} is still in progress.`
                : "Run-to-green was not active for this session.",
        command: runToGreen?.attempts.at(-1)?.command,
        summary: runToGreen?.blockerReason
      },
      {
        id: "patch_proposal",
        label: "Patch proposal",
        name: "Patch proposal",
        status: patchProposalCount ? "passed" : runToGreen ? "skipped" : "pending",
        detail: patchProposalCount
          ? `${patchProposalCount} patch proposal(s) recorded.`
          : runToGreen
            ? "No patch proposal was needed before command selection."
            : "No patch proposal recorded.",
        startedAt: session.createdAt,
        completedAt: patchProposalCount ? session.updatedAt : undefined,
        summary: patchProposalCount ? "Patch proposal captured." : runToGreen ? "Patch proposal was not required." : "Patch proposal is missing."
      },
      {
        id: "rust_apply",
        label: "Rust apply",
        name: "Rust apply",
        status: applyFailed ? "failed" : appliedPatchCount ? "passed" : pendingPatchApply || pendingPatchReview ? "pending" : runToGreen ? "skipped" : "passed",
        detail: applyFailed
          ? "Rust reported a patch apply failure."
          : appliedPatchCount
            ? `${appliedPatchCount} patch(es) applied through Rust.`
            : pendingPatchApply
              ? "Waiting for Rust to apply the approved patch."
              : pendingPatchReview
                ? "Patch is waiting for approval before Rust apply."
                : runToGreen
                  ? "Rust patch apply was not started because no repair patch was proposed."
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
        id: "command_execution",
        label: "Rust command execution",
        name: "Rust command execution",
        status: runToGreenBlockedBeforeExecution ? "not_run" : !runToGreenActive && commandFailed ? "failed" : commandPending || backgroundRunning || runToGreenActive ? "pending" : commandExecuted.length ? "passed" : runToGreen ? "skipped" : "passed",
        detail: runToGreenBlockedBeforeExecution
          ? "No grounded command was selected, so Rust command execution was not started."
          : !runToGreenActive && commandFailed
          ? "At least one verification command failed or was blocked."
          : backgroundRunning
            ? "A background verification command is still running with limited tracking."
          : runToGreenActive
            ? "Run-to-green is still diagnosing, repairing, or waiting for a rerun."
          : commandPending
            ? "Waiting for verification commands to run."
            : commandExecuted.length
              ? `Executed ${commandExecuted.length} verification command(s).`
              : runToGreen
                ? "No command was executed for this run-to-green attempt."
                : "No verification command was required.",
        command: commandExecuted[0]?.command,
        startedAt: commandPending || commandExecuted.length ? session.updatedAt : undefined,
        completedAt: commandExecuted.length || commandFailed ? session.updatedAt : undefined,
        exitCode: session.commandExecutions.at(-1)?.exitCode,
        summary: commandExecuted.length ? "Verification commands completed." : runToGreenBlockedBeforeExecution ? "Rust command execution did not start." : "Verification commands are pending or not required."
      }
    ],
    createdAt: new Date().toISOString()
  } satisfies AgentRuntimeSession["verificationResult"];
}

function shouldConfirmSingleFilePygamePlan(message: string, requestedAgentCount: number) {
  if (requestedAgentCount < 3) return false;
  const normalized = message.toLowerCase();
  return /\bpython\b/.test(normalized)
    && /\bpy\s*game\b|\bpygame\b/.test(normalized)
    && /\bone python code\b|\bsingle file\b|\bone file\b/.test(normalized);
}

async function loadSwarmWorkResults(workItems: Array<{ result_ref?: string }>) {
  const results: Array<{
    work_item_id: string;
    status: "succeeded" | "failed" | "blocked";
    summary: string;
    findings: string[];
    risks: string[];
    unknowns: string[];
  }> = [];
  for (const item of workItems) {
    if (!item.result_ref) continue;
    try {
      const parsed = JSON.parse(await readFile(item.result_ref, "utf8"));
      if (typeof parsed?.work_item_id !== "string") continue;
      results.push({
        work_item_id: parsed.work_item_id,
        status: parsed.status === "succeeded" || parsed.status === "failed" || parsed.status === "blocked" ? parsed.status : "failed",
        summary: typeof parsed.summary === "string" ? parsed.summary : "Worker completed without a textual summary.",
        findings: Array.isArray(parsed.findings) ? parsed.findings.filter((entry: unknown): entry is string => typeof entry === "string") : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.filter((entry: unknown): entry is string => typeof entry === "string") : [],
        unknowns: Array.isArray(parsed.unknowns) ? parsed.unknowns.filter((entry: unknown): entry is string => typeof entry === "string") : []
      });
    } catch {}
  }
  return results;
}

function mapSwarmRunStatus(status: string, providerError?: string): RuntimeSessionStatus {
  if (status === "succeeded") return "completed";
  if (providerError) return "failed_provider";
  if (status === "blocked") return "blocked";
  return "failed";
}

function mapSwarmWorkStatus(status: string): "todo" | "in_progress" | "done" | "blocked" {
  if (status === "succeeded") return "done";
  if (status === "running" || status === "leased" || status === "ready") return "in_progress";
  if (status === "queued") return "todo";
  return "blocked";
}

function mapSwarmAgentStatus(status: string): "idle" | "running" | "completed" | "blocked" | "failed" {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "running" || status === "leased") return "running";
  return "idle";
}

function formatProviderBackedSwarmAnswer(input: {
  finalReport: string;
  providerCallCount: number;
  workerCount: number;
  workResults: Array<{ summary: string; findings: string[]; risks: string[]; unknowns: string[] }>;
  status: RuntimeSessionStatus;
  providerFailures: number;
  providerTimeouts: number;
  invalidStructuredOutputs: number;
  retries: number;
}) {
  const heading = input.status === "completed"
    ? "Provider-backed swarm completed successfully."
    : input.status === "blocked"
      ? "Provider-backed swarm blocked before producing an accepted answer."
      : input.status === "failed_provider"
        ? "Provider-backed swarm failed because the model provider failed."
        : "Provider-backed swarm failed before producing an accepted answer.";
  const workerSummaries = input.workResults
    .slice(0, 8)
    .map((result, index) => {
      const findings = result.findings.slice(0, 3).map((finding) => `  - ${finding}`).join("\n");
      return [`${index + 1}. ${result.summary}`, findings].filter(Boolean).join("\n");
    })
    .join("\n");
  const reliabilityNotes = [
    `- Logical agents selected: ${input.workerCount}`,
    `- Provider requests recorded: ${input.providerCallCount}`,
    `- Provider failures recorded: ${input.providerFailures}`,
    `- Provider timeouts recorded: ${input.providerTimeouts}`,
    `- Structured-output retries: ${input.retries}`,
    `- Invalid structured outputs: ${input.invalidStructuredOutputs}`,
    `- Worker mode: provider_read_only`,
    `- Deterministic/mock worker output accepted as final answer: no`
  ];
  return [
    heading,
    "",
    workerSummaries ? "Answer from provider worker evidence:" : "Answer from provider worker evidence: none recorded.",
    workerSummaries,
    "",
    "Runtime truth:",
    ...reliabilityNotes,
    "",
    input.finalReport
  ].filter((line) => line !== undefined).join("\n");
}

function shouldAnswerExplainEvidenceQuestion(message: string, session: AgentRuntimeSession) {
  if (!session.explainReport) return false;
  const normalized = message.toLowerCase();
  const english = /\b(came from|why these)\b/i.test(message)
    || (/\bwhere\b/i.test(message) && /\b(file|files|link|links|reference|references|source|sources|evidence)\b/i.test(message))
    || (/\b(source|sources|links?|references?)\b/i.test(message) && /\b(of|for)\s+(these|this|the)\b/i.test(message));
  const arabic = /(جبت|جاب|فين|منين|مصدر|مصادر|دليل|أدلة|ادلة|روابط|لينكات|ملفات|الملفات|اللينكات|الروابط)/.test(normalized)
    && /(ملف|ملفات|رابط|روابط|لينك|لينكات|مصدر|مصادر|دليل|أدلة|ادلة|جبت|منين)/.test(normalized);
  return english || arabic;
}

function formatExplainEvidenceAnswer(session: AgentRuntimeSession, message: string) {
  const report = session.explainReport!;
  const arabic = /[\u0600-\u06ff]/.test(message);
  const evidence = report.evidence
    .filter((entry) => entry.type !== "directory")
    .slice(0, 8)
    .map((entry) => {
      const line = entry.lineStart ?? 1;
      const label = `${entry.path}:${line}`;
      return `- [${label}](hivo-file:${encodeURIComponent(entry.path)}:${line}): ${entry.reason}`;
    });
  const ignored = report.contextPack.inventory.ignoredDirectories.slice(0, 6).join(", ") || "none";
  if (arabic) {
    return [
      "الملفات والروابط دي جاية من تقرير القراءة لنفس الـ workspace المفتوح في الجلسة، مش من بحث خارجي ولا من مشروع تاني.",
      "",
      `- Workspace: \`${session.workspacePath}\``,
      `- اتفحص ${report.contextPack.inventory.scannedFiles} ملف قابل للقراءة، واتجاهلت generated/vendor زي: ${ignored}.`,
      "- الروابط `hivo-file:` هي مراجع نسبية داخل نفس الـ workspace، والسطر جنب كل رابط هو السطر اللي اتاخد كدليل.",
      "",
      "أهم الأدلة المستخدمة:",
      ...(evidence.length ? evidence : ["- مفيش evidence file refs محفوظة في التقرير السابق."]),
      "",
      "لو عنوان المشروع أو الدومين كان مختلف عن الأدلة، فده معناه bug في استنتاج الدومين، مش إن الروابط دليل على مشروع تاني."
    ].join("\n");
  }
  return [
    "Those files and links came from the read-only explain report for this session's workspace, not from an external search or a different project.",
    "",
    `- Workspace: \`${session.workspacePath}\``,
    `- Scanned ${report.contextPack.inventory.scannedFiles} readable file(s); ignored generated/vendor folders such as: ${ignored}.`,
    "- `hivo-file:` links are relative references inside that workspace, with the linked line used as evidence.",
    "",
    "Main evidence refs:",
    ...(evidence.length ? evidence : ["- No file evidence refs were stored on the previous report."]),
    "",
    "If the project title/domain disagreed with those refs, that is a domain-inference bug, not proof that the files came from another workspace."
  ].join("\n");
}

function formatRunTurnFailureMessage(prompt: string, error: unknown) {
  const detail = formatRuntimeError(error);
  if (/[\u0600-\u06ff]/.test(prompt)) {
    return [
      "الـ run وقع قبل ما أقدر أكمل الرد.",
      "",
      `السبب: ${detail}`,
      "",
      "ماخمنتش إجابة من غير دليل. جرّب الطلب تاني بعد ما تصلح سبب الخطأ، أو استخدم Restart Latest لو كنت شغال في development mode."
    ].join("\n");
  }
  return [
    "The run failed before I could finish the response.",
    "",
    `Reason: ${detail}`,
    "",
    "I did not guess an answer without evidence. Fix the reported issue and retry, or use Restart Latest while developing."
  ].join("\n");
}

function formatProviderFailureMessage(_prompt: string, error: unknown) {
  const detail = formatRuntimeError(error);
  return [
    "The real model provider was required, but the provider gate failed before I could produce a trusted answer.",
    "",
    `Reason: ${detail}`,
    "",
    "I did not use MockProvider or a deterministic fallback as a successful assistant reply. Fix the provider configuration/runtime and retry."
  ].join("\n");
}

function isProviderGateFailure(error: unknown, session: AgentRuntimeSession) {
  if (!(session.mode === "real_provider" || session.requireRealProvider)) return undefined;
  const detail = formatRuntimeError(error);
  if (error instanceof ProviderConfigurationError) return `provider_gate_failed:${error.code}`;
  if (/MockProvider is forbidden|provider_missing|provider_validation|provider_api_key|real_provider requires|Unsupported provider type/i.test(detail)) {
    return "provider_gate_failed";
  }
  return undefined;
}

function formatRuntimeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function createEmptyOrchestration(session?: AgentRuntimeSession): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: session?.orchestration?.safetySettings ?? accessProfileDefaults(session?.accessProfile ?? "default_permissions"),
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}

function buildRuntimeRunSummary(session: AgentRuntimeSession, verification: NonNullable<AgentRuntimeSession["verificationResult"]>): RunSummary {
  const status = (
    session.status === "failed" || session.status === "failed_provider"
      ? "failed"
      : session.status === "blocked" || session.lifecycleStage === "BLOCKED"
        ? "blocked"
      : session.status === "completed"
        ? "completed"
        : "pending"
  ) as RunSummary["status"];
  const nextAction =
    session.runToGreen?.status === "passed"
      ? "Selected run-to-green command passed."
      : session.runToGreen?.blockerReason
        ? session.runToGreen.blockerReason
        : session.status === "needs_approval"
          ? session.nextAction?.message ?? "Review the pending runtime action."
          : session.status === "failed" || session.status === "failed_provider"
            ? "Inspect the recorded patch or command failure."
            : "Review the active run state and latest verification evidence.";
  return buildDiffAwareRunSummary(
    session,
    verification,
    status,
    nextAction
  );
}

function buildReviewGateSummary(
  session: AgentRuntimeSession,
  verification: NonNullable<AgentRuntimeSession["verificationResult"]>
): NonNullable<AgentRuntimeSession["reviewGate"]> {
  const gate = buildAttributedReviewGate(session, verification);
  const scopeValidation = session.latestScopeValidation;
  const runToGreen = session.runToGreen
    ? {
        status: session.runToGreen.status,
        currentAttempt: session.runToGreen.currentAttempt,
        maxAttempts: session.runToGreen.maxAttempts,
        lastCommand: session.runToGreen.attempts.at(-1)?.command,
        lastDiagnosis: session.runToGreen.attempts.at(-1)?.diagnosis,
        blockerReason: session.runToGreen.blockerReason,
        finalStatus: session.runToGreen.finalStatus
      }
    : undefined;
  const withRunToGreen = {
    ...gate,
    runToGreen,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...gate.unresolvedBlockers,
      ...(session.runToGreen?.status === "blocked" || session.runToGreen?.status === "max_attempts_reached"
        ? [session.runToGreen.blockerReason ?? "Run-to-green stopped without reaching green."]
        : [])
    ])
  };
  if (!scopeValidation) {
    if (session.runToGreen?.status === "blocked") {
      return {
        ...withRunToGreen,
        recommendation: "do_not_apply",
        summary: session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution.",
        unresolvedBlockers: uniqueRuntimeStrings([
          ...withRunToGreen.unresolvedBlockers,
          session.runToGreen.blockerReason ?? "Run-to-green was blocked before command execution."
        ])
      };
    }
    return withRunToGreen;
  }
  return {
    ...withRunToGreen,
    scopeValidation,
    recommendation:
      scopeValidation.verdict === "blocked"
        ? "do_not_apply"
        : scopeValidation.verdict === "needs_review"
          ? "caution"
          : gate.recommendation,
    unresolvedBlockers: uniqueRuntimeStrings([
      ...withRunToGreen.unresolvedBlockers,
      ...(scopeValidation.verdict === "blocked" ? ["Module scope validation blocked apply until the patch is narrowed."] : [])
    ]),
    summary:
      scopeValidation.verdict === "blocked"
        ? "Patch review is blocked because proposed changes exceed the scoped module plan."
        : scopeValidation.verdict === "needs_review"
          ? "Patch review needs extra attention because it touches cautionary or approval-sensitive scope."
          : withRunToGreen.summary
  };
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

function buildRuntimeCommandRequest(sessionId: string, command: string, cwd: string, reason: string) {
  const normalized = command.toLowerCase();
  const risk = classifyCommandRisk(command, cwd);
  return {
    id: `cmd_${randomUUID()}`,
    sessionId,
    command,
    cwd,
    risk,
    reason,
    provenance: {
      source: "agent" as const,
      trigger: "manual" as const,
      requestedBy: "agent" as const,
      agentId: "agent_local_codex",
      approvalSource: risk === "dangerous" ? "denied" as const : "none" as const,
      policyDecision: risk === "dangerous" ? "deny" as const : risk === "safe" ? "allow" as const : "require_approval" as const,
      policyReason: reason,
      background: looksLikeBackgroundCommand(normalized),
      networkDetected: looksLikeNetworkCommand(normalized),
      backgroundDetected: looksLikeBackgroundCommand(normalized),
      detectionSource: "heuristic" as const,
      networkDetectionSource: "heuristic" as const,
      backgroundDetectionSource: "heuristic" as const,
      reason
    },
    status: risk === "dangerous" ? "blocked" as const : "requested" as const,
    createdAt: new Date().toISOString()
  };
}

function summarizeRuntimeOutput(text: string | undefined, limit = 240) {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}
