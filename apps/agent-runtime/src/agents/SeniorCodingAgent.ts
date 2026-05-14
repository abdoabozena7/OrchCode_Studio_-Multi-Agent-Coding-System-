import type {
  AgentLifecycleStage,
  AgentPlan,
  CommandExecutionRecord,
  PatchProposal,
  PreviewRecommendation,
  RunSummary,
  RuntimeProgressStage,
  Task
} from "@orchcode/protocol";
import { accessProfileDefaults } from "@orchcode/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { seniorCodingAgentPrompt } from "../prompts/seniorCodingAgentPrompt.js";
import { agentPlanSchema } from "../schemas/sessionSchemas.js";
import { patchProposalSchema } from "../schemas/patchSchemas.js";
import { inferProjectLaunch, type LaunchRecommendation } from "../runtime/ProjectLaunchInference.js";
import { randomId, SessionManager } from "../runtime/SessionManager.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

type SimpleIntent = "explain" | "inspect" | "modify" | "run_project" | "run_command" | "preview_result";

type WorkspaceScan = {
  projectSummary: ReturnType<ToolRegistry["workspace"]["getProjectSummary"]>;
  files: ReturnType<ToolRegistry["workspace"]["listFiles"]>;
  gitStatus: string;
};

export class SeniorCodingAgent {
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
    const intent = classifySimpleIntent(message);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.delegationDecision = options?.delegationDecision;
      draft.resolvedExecutionMode = "simple_mode";
      draft.agentName = "Senior Coding Agent";
      draft.status = "running";
      draft.lifecycleStage = "INTAKE";
    });

    await this.updateWorkStatus(sessionId, "Goal", "Clarify the request and choose the safest local workflow.", "running");
    await this.trace(sessionId, "planning", "Goal", `Handle this as ${intentLabel(intent)} without guessing hidden file contents.`, "completed");
    await this.trace(sessionId, "planning", "Decision", `This request maps to ${intentLabel(intent)}.`, "completed");

    const scan = await this.scanWorkspace(sessionId, tools);
    const plan = await this.createPlan(sessionId, message, scan, intent);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.plan = plan;
    });

    if (options?.thinkFirst) {
      await this.trace(sessionId, "planning", "Next decision", "The plan is ready. I am stopping before action because Think first is enabled.", "completed");
      await this.finish(
        sessionId,
        "PLAN",
        "needs_approval",
        "Plan is ready for review before implementation.",
        {
          status: "blocked",
          summary: "Prepared a plan and stopped before acting because Think first is enabled.",
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: [],
          commandResults: [],
          gates: [],
          nextAction: "Review the plan, then tell the agent to proceed.",
          createdAt: new Date().toISOString()
        },
        {
          kind: "confirm_plan",
          message: "Plan is ready. Want me to proceed with implementation?"
        },
        "I reviewed the workspace and prepared a plan first. Tell me to proceed when you want implementation to start."
      );
      return this.sessionManager.getSession(sessionId)!;
    }

    switch (intent) {
      case "run_project":
        await this.sessionManager.replaceTasks(sessionId, createTasks(sessionId, ["Inspect workspace", "Infer launch path", "Run project"]));
        await this.handleRunProject(sessionId, message, tools, scan, plan);
        break;
      case "run_command":
        await this.sessionManager.replaceTasks(sessionId, createTasks(sessionId, ["Inspect workspace", "Validate command", "Run command"]));
        await this.handleRunCommand(sessionId, message, tools, scan, plan);
        break;
      case "explain":
      case "inspect":
      case "preview_result":
        await this.sessionManager.replaceTasks(
          sessionId,
          createTasks(sessionId, ["Inspect workspace", intent === "explain" ? "Explain findings" : "Summarize findings"])
        );
        await this.handleInspectLikeIntent(sessionId, intent, message, tools, scan, plan);
        break;
      case "modify":
      default:
        await this.sessionManager.replaceTasks(sessionId, createTasks(sessionId, ["Inspect workspace", "Gather context", "Prepare patch proposal"]));
        await this.handleModify(sessionId, message, tools, scan, plan);
        break;
    }

    return this.sessionManager.getSession(sessionId)!;
  }

  private async scanWorkspace(sessionId: string, tools: ToolRegistry): Promise<WorkspaceScan> {
    await this.updateLifecycle(sessionId, "CONTEXT_GATHER");
    await this.trace(sessionId, "planning", "Decision", "Before acting, I need project shape, likely files, and git state.", "completed");

    await this.trace(sessionId, "inspecting", "Tool call", "workspace.get_project_summary", "running");
    const projectSummary = tools.workspace.getProjectSummary();
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "workspace.get_project_summary",
        inputSummary: tools.getWorkspacePath(),
        outputSummary: `${Object.keys(projectSummary.languages).join(", ") || "No languages detected"}; ${projectSummary.importantFiles.length} important files`
      })
    );
    await this.trace(
      sessionId,
      "inspecting",
      "Observed result",
      `Project summary: ${Object.keys(projectSummary.languages).join(", ") || "no detected stack"}; ${projectSummary.importantFiles.length} important file(s).`,
      "completed"
    );

    await this.trace(sessionId, "inspecting", "Tool call", "workspace.list_files (max 180)", "running");
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
    await this.trace(sessionId, "inspecting", "Observed result", `Scanned ${files.length} file entries inside the workspace boundary.`, "completed");

    await this.trace(sessionId, "inspecting", "Tool call", "git.status", "running");
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
    await this.trace(
      sessionId,
      "inspecting",
      "Observed result",
      gitStatus.trim() ? `Git status returned: ${gitStatus.trim()}.` : "Git is clean, or the workspace is not a repository.",
      "completed"
    );

    return { projectSummary, files, gitStatus };
  }

  private async createPlan(
    sessionId: string,
    message: string,
    scan: WorkspaceScan,
    intent: SimpleIntent
  ) {
    await this.updateLifecycle(sessionId, "PLAN");
    await this.trace(sessionId, "planning", "Decision", `Create a plan for ${intentLabel(intent)} using the current workspace scan.`, "completed");
    const plan = await this.llmProvider.generateStructured<AgentPlan>(
      {
        systemPrompt: seniorCodingAgentPrompt,
        userPrompt: message,
        context: {
          intent,
          projectSummary: scan.projectSummary,
          files: scan.files.slice(0, 40),
          gitStatus: scan.gitStatus
        }
      },
      agentPlanSchema
    );
    await this.trace(sessionId, "planning", "Observed result", `Plan ready with ${plan.steps.length} step(s).`, "completed");
    await this.trace(sessionId, "planning", "Next decision", nextPlanStep(intent), "completed");
    return plan;
  }

  private async handleInspectLikeIntent(
    sessionId: string,
    intent: Extract<SimpleIntent, "explain" | "inspect" | "preview_result">,
    message: string,
    tools: ToolRegistry,
    scan: WorkspaceScan,
    plan: AgentPlan
  ) {
    await this.updateLifecycle(sessionId, "CONTEXT_GATHER");
    const searchTerm = inferSearchTerm(message);
    await this.trace(sessionId, "inspecting", "Tool call", `workspace.search_code (${searchTerm})`, "running");
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
    await this.trace(sessionId, "inspecting", "Observed result", `Found ${searchMatches.length} code/search match(es) for ${searchTerm}.`, "completed");

    const readableTarget = chooseReadableFile(searchMatches, scan.files);
    let readPreview = "No relevant file selected.";
    if (readableTarget) {
      await this.trace(sessionId, "inspecting", "Tool call", `workspace.read_file (${readableTarget})`, "running", [readableTarget]);
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
      await this.trace(sessionId, "inspecting", "Observed result", `Read ${readableTarget} to anchor the summary in real code.`, "completed", [
        readableTarget
      ]);
    }

    const intro =
      intent === "explain"
        ? `I inspected the workspace to explain it, not to change it.`
        : intent === "preview_result"
          ? `I inspected the current workspace state before trying to surface a preview.`
          : `I inspected the workspace and summarized the current shape.`;
    const summaryLines = [
      intro,
      `Detected stack: ${Object.keys(scan.projectSummary.languages).join(", ") || "no primary stack detected"}.`,
      scan.projectSummary.importantFiles.length
        ? `Important files: ${scan.projectSummary.importantFiles.slice(0, 6).join(", ")}.`
        : "No important files were detected yet.",
      searchMatches.length ? `Search hits for "${searchTerm}": ${searchMatches.length}.` : `No search hits for "${searchTerm}".`,
      `Plan summary: ${plan.summary}`
    ];

    await this.finish(
      sessionId,
      "DONE",
      "completed",
      summaryLines.join(" "),
      {
        status: "completed",
        summary: intent === "explain" ? "Explained the current project state." : "Inspected the current project state.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [],
        nextAction: readableTarget ? `Most relevant file inspected: ${readableTarget}` : "No file changes were proposed.",
        createdAt: new Date().toISOString()
      },
      undefined,
      summaryLines.join("\n")
    );
  }

  private async handleRunProject(
    sessionId: string,
    message: string,
    tools: ToolRegistry,
    scan: WorkspaceScan,
    plan: AgentPlan
  ) {
    await this.updateLifecycle(sessionId, "APPROVAL");
    await this.trace(sessionId, "working", "Decision", "This is an execution request, so I will infer a launch path instead of proposing a patch.", "completed");

    const recommendation = inferProjectLaunch(tools.getWorkspacePath(), tools.workspace);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "workspace.inspect_launch",
        inputSummary: "Detect runnable project entry",
        outputSummary: recommendation?.reason ?? "No runnable entry found",
        status: recommendation ? "success" : "error"
      })
    );

    if (!recommendation) {
      await this.trace(
        sessionId,
        "blocked",
        "Observed result",
        "I did not find a runnable project shape. I checked for index.html and package.json dev/start scripts.",
        "blocked"
      );
      await this.finish(
        sessionId,
        "DONE",
        "failed",
        "I could not run this workspace because I did not find a browser entry file or a package.json dev/start script.",
        {
          status: "failed",
          summary: "No runnable project shape was detected.",
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: [],
          commandResults: [],
          gates: [],
          nextAction: "Add a runnable entry point like index.html or a package.json dev/start script.",
          createdAt: new Date().toISOString()
        },
        undefined,
        "I looked for index.html and package.json dev/start scripts, but this workspace does not expose a runnable entry point yet."
      );
      return;
    }

    await this.trace(sessionId, "working", "Observed result", `${recommendation.reason} Confidence: ${recommendation.confidence}.`, "completed");
    await this.trace(
      sessionId,
      "working",
      "Next decision",
      recommendation.command
        ? `Use ${recommendation.command} and expose ${recommendation.preview.target}.`
        : `Open ${recommendation.preview.target} directly.`,
      "completed"
    );

    const commandResult: CommandExecutionRecord | null = await this.executeLaunchRecommendation(sessionId, tools, recommendation);
    const currentSession = this.sessionManager.getSession(sessionId)!;
    const previewReady =
      commandResult?.status === "executed" || (!recommendation.command && currentSession.accessProfile === "bounded_autonomy");
    const summaryText = buildRunProjectSummary(scan, plan, recommendation, commandResult);
    const nextAction =
      previewReady
        ? recommendation.preview.type === "url"
          ? `Preview ready at ${recommendation.preview.target}`
          : `Open ${recommendation.preview.target} to inspect the result.`
        : recommendation.command
          ? `Suggested command: ${recommendation.command}`
          : `Open ${recommendation.preview.target}`;

    await this.finish(
      sessionId,
      "DONE",
      "completed",
      summaryText,
      {
        status: "completed",
        summary: "Prepared the project launch flow.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: commandResult ? [summarizeCommandExecution(commandResult)] : recommendation.command ? [recommendation.command] : [],
        gates: [],
        nextAction,
        createdAt: new Date().toISOString()
      },
      previewReady
        ? {
            kind: "preview_ready",
            message: commandResult?.message ?? "Preview is ready.",
            preview: recommendation.preview
          }
        : undefined,
      summaryText,
      recommendation.preview
    );
  }

  private async executeLaunchRecommendation(
    sessionId: string,
    tools: ToolRegistry,
    recommendation: LaunchRecommendation
  ): Promise<CommandExecutionRecord | null> {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.previewRecommendation = recommendation.preview;
    });

    if (!recommendation.command) {
      await this.trace(sessionId, "completed", "Action taken", `Prepared direct preview: ${recommendation.preview.target}.`, "completed");
      return null;
    }

    const session = this.sessionManager.getSession(sessionId)!;
    const safetySettings = session.orchestration?.safetySettings ?? accessProfileDefaults(session.accessProfile);
    const commandRequest = tools.command.requestRun(
      sessionId,
      recommendation.command,
      `Run the workspace using the inferred ${recommendation.strategy.replaceAll("_", " ")} strategy.`
    );
    await this.sessionManager.addCommandRequest(sessionId, commandRequest);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "command.request_run",
        inputSummary: recommendation.command,
        outputSummary: `${commandRequest.risk} command ${commandRequest.status}`
      })
    );
    await this.trace(sessionId, "working", "Tool call", `command.request_run (${recommendation.command})`, "completed");
    await this.trace(
      sessionId,
      commandRequest.risk === "safe" ? "working" : "blocked",
      "Observed result",
      `Command policy classified this as ${commandRequest.risk}.`,
      commandRequest.risk === "dangerous" ? "blocked" : "completed"
    );

    await this.trace(
      sessionId,
      "blocked",
      "Action taken",
      `I inferred the right launch command but left execution to Rust terminal authority under ${session.accessProfile}.`,
      "blocked"
    );
    return null;
  }

  private async handleRunCommand(
    sessionId: string,
    message: string,
    tools: ToolRegistry,
    scan: WorkspaceScan,
    plan: AgentPlan
  ) {
    await this.updateLifecycle(sessionId, "APPROVAL");
    const command = inferExplicitCommand(message);
    if (!command) {
      await this.finish(
        sessionId,
        "DONE",
        "failed",
        "I could not extract a concrete command to run from that request.",
        {
          status: "failed",
          summary: "No explicit command was found.",
          filesChanged: [],
          appliedPatchIds: [],
          proposedPatchIds: [],
          commandResults: [],
          gates: [],
          nextAction: "Say `run <command>` or `execute <command>` with the exact command text.",
          createdAt: new Date().toISOString()
        },
        undefined,
        "I need a concrete command like `run npm test` or `execute git status`."
      );
      return;
    }

    await this.trace(sessionId, "working", "Decision", `Run the explicit command instead of preparing a patch: ${command}.`, "completed");
    const request = tools.command.requestRun(sessionId, command, "User explicitly asked to run this command.");
    await this.sessionManager.addCommandRequest(sessionId, request);
    await this.sessionManager.addToolCall(
      sessionId,
      tools.createToolCall({
        sessionId,
        toolName: "command.request_run",
        inputSummary: command,
        outputSummary: `${request.risk} command ${request.status}`
      })
    );
    await this.trace(sessionId, "working", "Observed result", `Command policy classified ${command} as ${request.risk}.`, "completed");

    const session = this.sessionManager.getSession(sessionId)!;
    await this.trace(
      sessionId,
      "blocked",
      "Action taken",
      `I validated the command but left execution to Rust terminal authority under ${session.accessProfile}.`,
      "blocked"
    );

    const summaryText = [
      `I treated this as a command request, not a code-change request.`,
      `Workspace scan: ${Object.keys(scan.projectSummary.languages).join(", ") || "no primary stack detected"}.`,
      `Plan summary: ${plan.summary}`,
      `Prepared ${command} as the next action without auto-running it.`
    ].join(" ");

    await this.finish(
      sessionId,
      "DONE",
      "completed",
      summaryText,
      {
        status: "completed",
        summary: "Prepared the requested command.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [command],
        gates: [],
        nextAction: `Run ${command} when you want to continue.`,
        createdAt: new Date().toISOString()
      },
      undefined,
      summaryText
    );
  }

  private async handleModify(
    sessionId: string,
    message: string,
    tools: ToolRegistry,
    scan: WorkspaceScan,
    plan: AgentPlan
  ) {
    await this.updateLifecycle(sessionId, "CONTEXT_GATHER");
    const searchTerm = inferSearchTerm(message);
    await this.trace(sessionId, "working", "Decision", "This request needs a patch proposal, so I am gathering the narrowest relevant context first.", "completed");

    await this.trace(sessionId, "inspecting", "Tool call", `workspace.search_code (${searchTerm})`, "running");
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
    await this.trace(sessionId, "inspecting", "Observed result", `Found ${searchMatches.length} search match(es) for ${searchTerm}.`, "completed");

    const readableTarget = chooseReadableFile(searchMatches, scan.files);
    let readPreview = "No file selected for read";
    if (readableTarget) {
      await this.trace(sessionId, "inspecting", "Tool call", `workspace.read_file (${readableTarget})`, "running", [readableTarget]);
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
      await this.trace(sessionId, "inspecting", "Observed result", `Read ${readableTarget} before generating a patch.`, "completed", [readableTarget]);
    }

    await this.updateLifecycle(sessionId, "EXECUTION_DRAFT");
    await this.trace(sessionId, "working", "Next decision", "Generate a reviewable patch proposal instead of writing files directly.", "completed");
    const generatedPatch = await this.llmProvider.generateStructured<Omit<PatchProposal, "id" | "sessionId" | "createdAt">>(
      {
        systemPrompt: seniorCodingAgentPrompt,
        userPrompt: message,
        context: {
          summaryFile: "AGENT_PROPOSAL.md",
          projectSummary: scan.projectSummary,
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
    await this.trace(
      sessionId,
      validation.valid ? "patching" : "blocked",
      "Observed result",
      validation.valid ? `Patch proposal ready: ${proposal.title}.` : `Patch validation failed: ${validation.errors.join("; ")}`,
      validation.valid ? "completed" : "blocked",
      proposal.filesChanged.map((file) => file.path)
    );

    if (validation.valid) {
      await this.sessionManager.addPatchProposal(sessionId, proposal);
    }

    const session = this.sessionManager.getSession(sessionId)!;
    const safetySettings = session.orchestration?.safetySettings ?? accessProfileDefaults(session.accessProfile);
    let patchSummary = "Stopped before applying the patch because Rust patch authority must apply approved proposals.";
    await this.trace(
      sessionId,
      "blocked",
      "Action taken",
      "The patch remains review-only until Rust applies an approved proposal.",
      "blocked",
      proposal.filesChanged.map((file) => file.path)
    );

    await this.updateLifecycle(sessionId, "APPROVAL");
    const command = scan.projectSummary.testCommands[0] ?? "git diff --check";
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
    await this.trace(sessionId, "reviewing", "Tool call", `command.request_run (${command})`, "completed");
    if (commandRequest.risk === "safe" && safetySettings.autoRunSafeCommands) {
      await this.trace(sessionId, "reviewing", "Observed result", `Queued ${commandRequest.command} for Rust execution.`, "completed");
    }

    const mockOnlyProposal =
      proposal.filesChanged.length === 1 &&
      proposal.filesChanged[0]?.path === "AGENT_PROPOSAL.md" &&
      /^Mock implementation note$/i.test(proposal.title);
    const reviewMessage = mockOnlyProposal
      ? "I created a mock planning note instead of a real code patch. In mock mode, this request still needs a real provider before it can produce a credible implementation."
      : "I created a plan, inspected the workspace with controlled tools, and prepared a patch proposal. Review and approve or reject it before any file write is attempted.";

    await this.finish(
      sessionId,
      "APPROVAL",
      proposal.requiresApproval ? "needs_approval" : "completed",
      reviewMessage,
      {
        status: validation.valid ? "completed" : "blocked",
        summary: mockOnlyProposal ? "Prepared a mock-only note instead of a credible code patch." : patchSummary,
        filesChanged: [],
        appliedPatchIds: proposal.status === "applied" ? [proposal.id] : [],
        proposedPatchIds: [proposal.id],
        commandResults: [command],
        gates: [
          {
            name: "Patch validation",
            status: validation.valid ? "passed" : "failed",
            notes: validation.errors
          }
        ],
        nextAction: proposal.status === "applied" ? "Patch applied under current access policy." : "Review the patch proposal before any write occurs.",
        createdAt: new Date().toISOString()
      },
      undefined,
      reviewMessage
    );
  }

  private async finish(
    sessionId: string,
    lifecycleStage: AgentLifecycleStage,
    status: "completed" | "needs_approval" | "failed",
    summary: string,
    runSummary: RunSummary,
    nextAction?: import("@orchcode/protocol").SessionNextAction,
    assistantMessage?: string,
    previewRecommendation?: PreviewRecommendation
  ) {
    await this.updateLifecycle(sessionId, lifecycleStage, status);
    await this.updateWorkStatus(sessionId, stageLabel(lifecycleStage), summary, status === "failed" ? "failed" : "completed");
    await this.trace(
      sessionId,
      status === "failed" ? "blocked" : "completed",
      "Action taken",
      summary,
      status === "failed" ? "failed" : "completed"
    );
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = status;
      draft.lifecycleStage = lifecycleStage;
      draft.nextAction = nextAction;
      if (previewRecommendation) {
        draft.previewRecommendation = previewRecommendation;
      }
      draft.reasoningSummaries.push(summary);
    });
    await this.sessionManager.setRunSummary(sessionId, runSummary);
    if (assistantMessage) {
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: assistantMessage
      });
    }
  }

  private async updateLifecycle(
    sessionId: string,
    stage: AgentLifecycleStage,
    status: "running" | "completed" | "needs_approval" | "failed" = "running"
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.lifecycleStage = stage;
      draft.status = status;
    });
  }

  private async updateWorkStatus(
    sessionId: string,
    taskTitle: string,
    objective: string,
    status: "queued" | "running" | "completed" | "blocked" | "failed",
    targetFiles: string[] = []
  ) {
    await this.sessionManager.updateAgentWorkStatus(sessionId, {
      agentName: "Senior Coding Agent",
      role: "Senior Coding Agent",
      taskTitle,
      objective,
      status,
      targetFiles,
      summary: objective,
      updatedAt: new Date().toISOString()
    });
  }

  private async trace(
    sessionId: string,
    stage: RuntimeProgressStage,
    taskTitle: string,
    summary: string,
    status: "queued" | "running" | "completed" | "blocked" | "failed",
    targetFiles: string[] = []
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.reasoningSummaries.push(`${taskTitle}: ${summary}`);
    });
    await this.sessionManager.addProgressEvent(sessionId, {
      id: randomId("progress"),
      sessionId,
      stage,
      agentName: "Senior Coding Agent",
      role: "Senior",
      taskTitle,
      summary,
      status,
      targetFiles,
      createdAt: new Date().toISOString()
    });
  }
}

function createTasks(sessionId: string, titles: string[]): Task[] {
  const now = new Date().toISOString();
  return titles.map((title) => ({
    id: randomId("task"),
    sessionId,
    title,
    status: "done",
    agentRole: "Senior Coding Agent",
    createdAt: now
  }));
}

function classifySimpleIntent(message: string): SimpleIntent {
  const normalized = normalize(message);
  if (/\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/.test(normalized)) return "run_project";
  if (/^\s*(run|execute)\s+.+/.test(normalized) && !/\b(project|app|preview|site|game)\b/.test(normalized)) return "run_command";
  if (/\b(open preview|show preview|preview result|open result)\b/.test(normalized)) return "preview_result";
  if (/\b(explain|what does|how does|walk me through|describe)\b/.test(normalized)) return "explain";
  if (/\b(inspect|analyze|scan|review|summarize|tell me about)\b/.test(normalized)) return "inspect";
  return "modify";
}

function inferExplicitCommand(message: string) {
  const normalized = message.trim();
  const stripped = normalized.replace(/^(please\s+)?(run|execute)\s+/i, "");
  return stripped && stripped !== normalized ? stripped.trim() : "";
}

function inferSearchTerm(message: string) {
  return (
    message
      .split(/\W+/)
      .find((part) => part.length > 4)
      ?.toLowerCase() ?? "TODO"
  );
}

function chooseReadableFile(
  matches: Array<{ path: string }>,
  files: Array<{ path: string; isDir: boolean; isSecretCandidate: boolean }>
) {
  return (
    matches[0]?.path ??
    files.find((file) => !file.isDir && !file.isSecretCandidate && /\.(ts|tsx|rs|js|md|json|html|css)$/i.test(file.path))?.path
  );
}

function normalize(message: string) {
  return message.trim().toLowerCase();
}

function intentLabel(intent: SimpleIntent) {
  return intent.replaceAll("_", " ");
}

function nextPlanStep(intent: SimpleIntent) {
  switch (intent) {
    case "run_project":
      return "Infer the safest launch path and start it if access allows.";
    case "run_command":
      return "Validate the explicit command against command policy, then run it if allowed.";
    case "explain":
      return "Inspect likely files and explain the project without modifying it.";
    case "inspect":
    case "preview_result":
      return "Inspect the workspace and summarize the current state without changing files.";
    case "modify":
    default:
      return "Gather narrow context and prepare a reviewable patch proposal.";
  }
}

function summarizeCommandExecution(execution: CommandExecutionRecord) {
  return `${execution.command}: ${execution.status}${execution.message ? ` (${execution.message})` : ""}`;
}

function buildRunProjectSummary(
  scan: WorkspaceScan,
  plan: AgentPlan,
  recommendation: LaunchRecommendation,
  execution: CommandExecutionRecord | null
) {
  return [
    `I treated this as a run request, not a code-change request.`,
    `Detected stack: ${Object.keys(scan.projectSummary.languages).join(", ") || "no primary stack detected"}.`,
    `Plan summary: ${plan.summary}`,
    `Launch strategy: ${recommendation.strategy.replaceAll("_", " ")}.`,
    execution?.status === "executed"
      ? `Started ${recommendation.command ?? recommendation.preview.target}${recommendation.background ? " in the background" : ""}.`
      : recommendation.command
        ? `Prepared ${recommendation.command} and ${recommendation.preview.target}.`
        : `Prepared ${recommendation.preview.target} for direct preview.`
  ].join(" ");
}

function shouldRunInBackground(command: string) {
  return /\b(dev|serve|http\.server|uvicorn|vite|next dev|react-scripts start)\b/i.test(command);
}

function stageLabel(stage: AgentLifecycleStage) {
  return stage
    .toLowerCase()
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
