import type {
  AgentRuntimeSession,
  CreateRuntimeSessionRequest,
  CreateRuntimeSessionResponse,
  RuntimeTurnResponse
} from "@orchcode/protocol";
import { accessProfileDefaults } from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import { SeniorCodingAgent } from "../agents/SeniorCodingAgent.js";
import { MockLlmProvider } from "../llm/MockLlmProvider.js";
import { OpenAIProvider } from "../llm/OpenAIProvider.js";
import { SessionManager } from "./SessionManager.js";
import { OrchestratedRuntime } from "./OrchestratedRuntime.js";
import { CommandExecutor } from "./CommandExecutor.js";
import { createSimpleDelegationDecision, parsePromptDirective, resolveExecutionMode } from "./delegation.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

export class AgentRuntime {
  private readonly commandExecutor = new CommandExecutor();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly sessionManager: SessionManager
  ) {}

  async createSession(input: CreateRuntimeSessionRequest): Promise<CreateRuntimeSessionResponse> {
    const mode = input.mode ?? this.config.defaultMode;
    const session = await this.sessionManager.createSession({
      workspacePath: input.workspacePath,
      mode,
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
      session.mode === "real"
        ? new OpenAIProvider(this.config.openaiApiKey, this.config.openaiBaseUrl)
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

      const updated =
        modeResolution.mode === "orchestrated_mode"
          ? await this.runOrchestrated(sessionId, message, {
              projectMap,
              delegationDecision: {
                resolvedMode: "orchestrated_mode",
                explicitUserDirective: modeResolution.directive.explicitDirectiveText,
                requestedAgentCount: modeResolution.directive.requestedAgentCount,
                selectedAgentCount: 0,
                selectedAgentRoles: [],
                agentRoleReasons: [],
                estimatedComplexity: modeResolution.complexity,
                rationale:
                  modeResolution.directive.explicitDirectiveText ??
                  "I delegated this because the task spans multiple technical concerns."
              },
              thinkFirst: session.thinkFirst || modeResolution.directive.thinkFirstRequested
            })
          : await new SeniorCodingAgent(provider, this.sessionManager).runTurn(sessionId, message, {
              thinkFirst: session.thinkFirst || modeResolution.directive.thinkFirstRequested,
              delegationDecision: createSimpleDelegationDecision({ prompt: message, projectMap })
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
    let applied = false;
    let message = "Patch approved.";
    const safetySettings = session.orchestration?.safetySettings ?? accessProfileDefaults(session.accessProfile);
    if (!safetySettings.requireApprovalForPatches || session.accessProfile === "full_access") {
      const tools = new ToolRegistry(session.workspacePath);
      const result = tools.patch.applyProposal(proposal);
      applied = result.applied;
      message = result.message;
      session = await this.sessionManager.updateSession(sessionId, (draft) => {
        const target = draft.patchProposals.find((patch) => patch.id === patchId);
        if (target && result.applied) {
          target.status = "applied";
        }
      });
    }
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration?.approvalDecisions.push({
        id: `approval_${randomUUID()}`,
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
      draft.orchestration?.approvalDecisions.push({
        id: `approval_${randomUUID()}`,
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
        let executionMessage = "Preview is ready.";
        if (preview.command) {
          const execution = preview.command.includes("dev") || preview.command.includes("http.server")
            ? this.commandExecutor.runInBackground(session.id, preview.command, session.workspacePath)
            : this.commandExecutor.run(session.id, preview.command, session.workspacePath);
          await this.sessionManager.addCommandExecution(session.id, execution);
          executionMessage = execution.message ?? executionMessage;
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

  private async runOrchestrated(
    sessionId: string,
    message: string,
    options: Parameters<OrchestratedRuntime["run"]>[2]
  ) {
    const current = this.requireSession(sessionId);
    if (!current.orchestration) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.orchestration = {
          agentRuns: [],
          workerOutputs: [],
          securityReviews: [],
          reviewerSummaries: [],
          orchestrationEvents: [],
          approvalDecisions: [],
          safetySettings: accessProfileDefaults(draft.accessProfile),
          lockedFiles: {},
          selectedWorkerAgents: [],
          mandatoryGateAgents: ["Product Orchestrator", "Business Orchestrator", "Engineering Orchestrator", "SecurityAgent", "ReviewerAgent"],
          workOrders: [],
          qualityGateResults: [],
          retryCount: 0
        };
      });
    }
    return new OrchestratedRuntime(this.sessionManager).run(sessionId, message, options);
  }
}
