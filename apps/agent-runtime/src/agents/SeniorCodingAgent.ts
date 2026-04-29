import type { AgentLifecycleStage, AgentPlan, PatchProposal, Task } from "@orchcode/protocol";
import { accessProfileDefaults } from "@orchcode/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { seniorCodingAgentPrompt } from "../prompts/seniorCodingAgentPrompt.js";
import { agentPlanSchema } from "../schemas/sessionSchemas.js";
import { patchProposalSchema } from "../schemas/patchSchemas.js";
import { CommandExecutor } from "../runtime/CommandExecutor.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

export class SeniorCodingAgent {
  private readonly commandExecutor = new CommandExecutor();

  constructor(
    private readonly llmProvider: LlmProvider,
    private readonly sessionManager: SessionManager
  ) {}

  async runTurn(
    sessionId: string,
    message: string,
    options?: {
      thinkFirst?: boolean;
      delegationDecision?: import("@orchcode/protocol").DelegationDecision;
    }
  ) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }

    const tools = new ToolRegistry(session.workspacePath);
    await this.setStage(sessionId, "REPO_SCAN", "Inspecting repository structure and git status.");

    const projectSummary = tools.workspace.getProjectSummary();
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "workspace.get_project_summary",
        inputSummary: session.workspacePath,
        outputSummary: `${Object.keys(projectSummary.languages).join(", ") || "No languages detected"}; ${projectSummary.importantFiles.length} important files`
      })
    );

    const files = tools.workspace.listFiles(180);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "workspace.list_files",
        inputSummary: "max 180 files",
        outputSummary: `${files.length} files/directories scanned`
      })
    );

    const gitStatus = tools.git.status();
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "git.status",
        inputSummary: "git status --short",
        outputSummary: gitStatus.trim() || "Clean or not a git repo"
      })
    );

    await this.setStage(sessionId, "PLAN", "Creating a technical plan.");
    const plan = await this.llmProvider.generateStructured<AgentPlan>(
      {
        systemPrompt: seniorCodingAgentPrompt,
        userPrompt: message,
        context: { projectSummary, files: files.slice(0, 40), gitStatus }
      },
      agentPlanSchema
    );
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.plan = plan;
      draft.delegationDecision = options?.delegationDecision;
      draft.resolvedExecutionMode = "simple_mode";
      draft.agentName = "Senior Coding Agent";
      draft.reasoningSummaries.push("Created a minimal plan after scanning workspace and git state.");
    });

    if (options?.thinkFirst) {
      await this.setStage(sessionId, "PLAN", "Plan is ready for review before implementation.");
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: "I reviewed the workspace and prepared a plan first. Tell me to proceed when you want implementation to start."
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "needs_approval";
        draft.nextAction = {
          kind: "confirm_plan",
          message: "Plan is ready. Want me to proceed with implementation?"
        };
      });
      return this.sessionManager.getSession(sessionId)!;
    }

    const tasks = createTasks(sessionId);
    await this.sessionManager.replaceTasks(sessionId, tasks);

    await this.setStage(sessionId, "CONTEXT_GATHERING", "Searching and reading likely context.");
    const searchTerm = inferSearchTerm(message);
    const searchMatches = tools.workspace.searchCode(searchTerm, 25);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "workspace.search_code",
        inputSummary: searchTerm,
        outputSummary: `${searchMatches.length} matches`
      })
    );

    const readableTarget = chooseReadableFile(searchMatches, files);
    let readPreview = "No file selected for read";
    if (readableTarget) {
      const content = tools.workspace.readFile(readableTarget);
      readPreview = `${readableTarget}: ${content.slice(0, 240).replace(/\s+/g, " ")}`;
      await this.sessionManager.addToolCall(
        sessionId,
        tools.createToolCall({
          sessionId,
          toolName: "workspace.read_file",
          inputSummary: readableTarget,
          outputSummary: readPreview
        })
      );
    }

    await this.setStage(sessionId, "PATCH_PROPOSAL", "Preparing a reviewable patch proposal.");
    const generatedPatch = await this.llmProvider.generateStructured<Omit<PatchProposal, "id" | "sessionId" | "createdAt">>(
      {
        systemPrompt: seniorCodingAgentPrompt,
        userPrompt: message,
        context: {
          summaryFile: "AGENT_PROPOSAL.md",
          projectSummary,
          searchMatches,
          readPreview
        }
      },
      patchProposalSchema
    );
    const proposal = tools.patch.propose(generatedPatch, sessionId);
    const validation = tools.patch.validate(proposal);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "patch.validate",
        inputSummary: proposal.title,
        outputSummary: validation.valid ? "Patch paths valid" : validation.errors.join("; "),
        status: validation.valid ? "success" : "error"
      })
    );
    if (validation.valid) {
      await this.sessionManager.addPatchProposal(sessionId, proposal);
    }

    const safetySettings = session.orchestration?.safetySettings ?? accessProfileDefaults(session.accessProfile);
    if (validation.valid && safetySettings.autoApplyValidatedPatches) {
      const applyResult = tools.patch.applyProposal(proposal);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        const target = draft.patchProposals.find((patch) => patch.id === proposal.id);
        if (target && applyResult.applied) {
          target.status = "applied";
        }
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: applyResult.applied
          ? "I applied the validated patch automatically under the current access policy."
          : `I prepared the patch but did not apply it: ${applyResult.message}`
      });
    }

    await this.setStage(sessionId, "OPTIONAL_COMMAND_REQUEST", "Suggesting a safe validation command.");
    const command = projectSummary.testCommands[0] ?? "git diff --check";
    const commandRequest = tools.command.requestRun(
      sessionId,
      command,
      "Validate the proposed change after approval or inspect the current diff."
    );
    await this.sessionManager.addCommandRequest(sessionId, commandRequest);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "command.request_run",
        inputSummary: command,
        outputSummary: `${commandRequest.risk} command ${commandRequest.status}`
      })
    );

    if (commandRequest.risk === "safe" && safetySettings.autoRunSafeCommands) {
      const execution = this.commandExecutor.run(sessionId, commandRequest.command, session.workspacePath, commandRequest.id);
      await this.sessionManager.addCommandExecution(sessionId, execution);
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: `I queued the safest validation command automatically: ${commandRequest.command}`
      });
    }

    await this.setStage(sessionId, "REVIEW_REQUEST", "Patch proposal is waiting for user review.");
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content:
        "I created a plan, inspected the workspace with controlled tools, and prepared a patch proposal. Review and approve or reject it before any file write is attempted."
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status =
        safetySettings.autoApplyValidatedPatches && validation.valid ? "completed" : proposal.requiresApproval ? "needs_approval" : "completed";
      draft.reasoningSummaries.push(
        safetySettings.autoApplyValidatedPatches && validation.valid
          ? "Applied the validated patch automatically under the current access policy."
          : "Stopped before applying the patch because approval is required."
      );
    });

    return this.sessionManager.getSession(sessionId)!;
  }

  private async setStage(sessionId: string, stage: AgentLifecycleStage, summary: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = stage;
      draft.reasoningSummaries.push(summary);
    });
  }
}

function createTasks(sessionId: string): Task[] {
  const now = new Date().toISOString();
  return [
    { id: "task_scan", sessionId, title: "Scan repository", status: "done", agentRole: "Senior Coding Agent", createdAt: now },
    { id: "task_plan", sessionId, title: "Create technical plan", status: "done", agentRole: "Senior Coding Agent", createdAt: now },
    { id: "task_patch", sessionId, title: "Prepare patch proposal", status: "done", agentRole: "Senior Coding Agent", createdAt: now }
  ];
}

function inferSearchTerm(message: string) {
  return message
    .split(/\W+/)
    .find((part) => part.length > 4)
    ?.toLowerCase() ?? "TODO";
}

function chooseReadableFile(
  matches: Array<{ path: string }>,
  files: Array<{ path: string; isDir: boolean; isSecretCandidate: boolean }>
) {
  return (
    matches[0]?.path ??
    files.find((file) => !file.isDir && !file.isSecretCandidate && /\.(ts|tsx|rs|js|md|json)$/i.test(file.path))?.path
  );
}
