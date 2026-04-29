import type { AgentRun, OrchestrationEventType, OrchestrationState, ProjectMap, TaskNode, WorkerOutput } from "@orchcode/protocol";
import { ProductOrchestrator } from "../orchestrators/ProductOrchestrator.js";
import { BusinessOrchestrator } from "../orchestrators/BusinessOrchestrator.js";
import { EngineeringOrchestrator } from "../orchestrators/EngineeringOrchestrator.js";
import { FileLockManager } from "../scheduler/FileLockManager.js";
import { MergeController } from "../scheduler/MergeController.js";
import { TaskScheduler } from "../scheduler/TaskScheduler.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { SessionManager, randomId } from "./SessionManager.js";
import { CommandExecutor } from "./CommandExecutor.js";
import {
  ArchitectAgent,
  CodebaseMapperAgent,
  FrontendAgent,
  ReviewerAgent,
  RustBackendAgent,
  SecurityAgent,
  TestAgent,
  ToolingTerminalAgent
} from "../agents/workers/index.js";

export class OrchestratedRuntime {
  private readonly commandExecutor = new CommandExecutor();

  constructor(private readonly sessionManager: SessionManager) {}

  async run(
    sessionId: string,
    message: string,
    options: {
      projectMap?: ProjectMap;
      delegationDecision?: import("@orchcode/protocol").DelegationDecision;
      thinkFirst?: boolean;
    } = {}
  ) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.orchestration) throw new Error("Orchestrated session not found");
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    await this.emit(sessionId, "orchestration.started", "Multi-agent orchestration started.");

    const tools = new ToolRegistry(session.workspacePath);
    const projectSummary = tools.workspace.getProjectSummary();
    const projectMap: ProjectMap =
      options.projectMap ?? {
        stack: Object.keys(projectSummary.languages),
        packageManagers: projectSummary.packageManagers,
        testCommands: projectSummary.testCommands,
        entryPoints: inferEntryPoints(projectSummary.importantFiles),
        importantFiles: projectSummary.importantFiles
      };

    const productBrief = new ProductOrchestrator().createBrief(message);
    await this.recordAgent(sessionId, "Product Orchestrator", "Product Orchestrator", "Create product brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.orchestration!.productBrief = productBrief;
      draft.orchestration!.projectMap = projectMap;
    });
    await this.emit(sessionId, "product_brief.created", "Product brief created.", "Product Orchestrator");

    const businessBrief = new BusinessOrchestrator().createBrief(productBrief);
    await this.recordAgent(sessionId, "Business Orchestrator", "Business Orchestrator", "Create business brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.businessBrief = businessBrief;
    });
    await this.emit(sessionId, "business_brief.created", "Business brief created.", "Business Orchestrator");

    const engineering = new EngineeringOrchestrator().createTechnicalPlan({
      sessionId,
      productBrief,
      businessBrief,
      projectMap
    });
    await this.recordAgent(sessionId, "Engineering Orchestrator", "Engineering Orchestrator", "Create task graph");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.resolvedExecutionMode = "orchestrated_mode";
      draft.agentName = "Dynamic Working Team";
      draft.delegationDecision = {
        ...(options.delegationDecision ?? engineering.delegationDecision),
        selectedAgentCount: engineering.delegationDecision.selectedAgentCount,
        selectedAgentRoles: engineering.delegationDecision.selectedAgentRoles,
        agentRoleReasons: engineering.delegationDecision.agentRoleReasons,
        rationale: engineering.delegationDecision.rationale
      };
      draft.orchestration!.technicalPlan = engineering.technicalPlan;
      draft.orchestration!.taskGraph = engineering.technicalPlan.taskGraph;
    });
    await this.emit(sessionId, "technical_plan.created", "Technical plan and task graph created.", "Engineering Orchestrator");
    for (const node of engineering.technicalPlan.taskGraph.nodes) {
      await this.emit(sessionId, "task.created", node.title, node.assignedAgent, node.id);
    }

    if (options.thinkFirst) {
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: `I planned the working team first. ${engineering.delegationDecision.rationale} Tell me to proceed when you want implementation to start.`
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = {
          kind: "confirm_plan",
          message: "Plan is ready. Want me to proceed with implementation?"
        };
      });
      return this.sessionManager.getSession(sessionId)!;
    }

    const locks = new FileLockManager();
    const scheduler = new TaskScheduler(
      engineering.technicalPlan.taskGraph,
      locks,
      session.orchestration.safetySettings.maxParallelAgents
    );
    const outputs: WorkerOutput[] = [];
    const merge = new MergeController();
    const securityAgent = new SecurityAgent();
    const reviewerAgent = new ReviewerAgent();
    let previewRecommendation: import("@orchcode/protocol").PreviewRecommendation | undefined;

    scheduler.runAll((task) => {
      const worker = createWorker(task.assignedAgent);
      const run = createAgentRun(sessionId, task.assignedAgent, task.title, "running");
      session.orchestration!.agentRuns.push(run);
      const result = worker.run(task, {
        sessionId,
        userPrompt: message,
        workspacePath: session.workspacePath,
        projectMap,
        tools
      });
      outputs.push(result.output);
      if (result.patch) session.patchProposals.push(result.patch);
      if (result.commandRequest) session.commandRequests.push(result.commandRequest);
      if (!previewRecommendation && result.previewRecommendation) {
        previewRecommendation = result.previewRecommendation;
      }
      run.status = "completed";
      run.completedAt = new Date().toISOString();
      run.lastEvent = "completed";
    });

    for (const event of scheduler.events) {
      if (event.type === "task.started") await this.emit(sessionId, "task.started", event.task.title, event.task.assignedAgent, event.task.id);
      if (event.type === "task.completed") await this.emit(sessionId, "task.completed", event.task.title, event.task.assignedAgent, event.task.id);
      if (event.type === "task.blocked") await this.emit(sessionId, "task.failed", event.reason, event.task.assignedAgent, event.task.id);
      if (event.type === "file_lock.acquired") await this.emit(sessionId, "file_lock.acquired", event.files.join(", "), event.task.assignedAgent, event.task.id);
      if (event.type === "file_lock.released") await this.emit(sessionId, "file_lock.released", event.files.join(", "), event.task.assignedAgent, event.task.id);
    }
    for (const patch of session.patchProposals) {
      await this.emit(sessionId, "patch.proposed", patch.title, patch.filesChanged[0]?.path, patch.id);
    }
    for (const command of session.commandRequests) {
      await this.emit(sessionId, "command.requested", command.command, command.risk, command.id);
    }
    if (session.orchestration.safetySettings.autoRunSafeCommands) {
      for (const command of session.commandRequests.filter((request) => request.risk === "safe")) {
        const execution = this.commandExecutor.run(sessionId, command.command, session.workspacePath, command.id);
        await this.sessionManager.addCommandExecution(sessionId, execution);
      }
    }

    const mergeSummary = merge.detectPatchConflicts(session.patchProposals);
    const securityReview = securityAgent.review(sessionId, session.patchProposals, session.commandRequests);
    const reviewerSummary = reviewerAgent.review(
      sessionId,
      session.patchProposals,
      outputs,
      mergeSummary.conflicts.map((conflict) => `Conflict on ${conflict.path}`)
    );

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "REVIEW_REQUEST";
      draft.tasks = engineering.technicalPlan.taskGraph.nodes.map((node) => ({
        id: node.id,
        sessionId,
        title: node.title,
        status: node.status === "completed" ? "done" : node.status === "running" ? "in_progress" : node.status === "failed" ? "blocked" : "todo",
        agentRole: node.assignedAgent,
        createdAt: new Date().toISOString()
      }));
      draft.orchestration!.taskGraph = engineering.technicalPlan.taskGraph;
      draft.orchestration!.workerOutputs = outputs;
      draft.orchestration!.securityReviews.push(securityReview);
      draft.orchestration!.reviewerSummaries.push(reviewerSummary);
      draft.orchestration!.lockedFiles = locks.snapshot();
      draft.previewRecommendation = previewRecommendation;
      draft.reasoningSummaries.push("Orchestrated run completed and stopped for patch approval.");
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content:
        "I ran the orchestrators and specialist subagents, collected command requests and patch proposals, and stopped before any patch apply so you can review the result."
    });

    const canAutoApply = session.orchestration.safetySettings.autoApplyValidatedPatches;
    if (canAutoApply) {
      const appliedTitles: string[] = [];
      for (const proposal of session.patchProposals) {
        const applied = tools.patch.applyProposal(proposal);
        if (applied.applied) {
          appliedTitles.push(proposal.title);
          await this.sessionManager.updateSession(sessionId, (draft) => {
            const target = draft.patchProposals.find((candidate) => candidate.id === proposal.id);
            if (target) target.status = "applied";
          });
        }
      }
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "completed";
        if (previewRecommendation) {
          draft.nextAction = {
            kind: "confirm_preview",
            message: "Done. Want me to run it now, or show you the result first?",
            preview: previewRecommendation
          };
        }
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: previewRecommendation
          ? "Done. Want me to run it now, or show you the result first?"
          : `I applied ${appliedTitles.length} patch proposal(s) automatically under the current access policy.`
      });
    }

    await this.emit(sessionId, "security.reviewed", securityReview.summary, "SecurityAgent");
    await this.emit(sessionId, "patch.reviewed", reviewerSummary.summary, "ReviewerAgent");
    await this.emit(sessionId, "orchestration.completed", "Multi-agent orchestration completed and awaits approval.");
    return this.sessionManager.getSession(sessionId)!;
  }

  private async emit(sessionId: string, type: OrchestrationEventType, message: string, agentName?: string, taskId?: string) {
    await this.sessionManager.addOrchestrationEvent(sessionId, {
      id: randomId("event"),
      sessionId,
      type,
      message,
      agentName,
      taskId,
      createdAt: new Date().toISOString()
    });
  }

  private async recordAgent(sessionId: string, agentName: string, role: AgentRun["role"], task: string) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.agentRuns.push(createAgentRun(sessionId, agentName, task, "completed", role));
    });
    await this.emit(sessionId, "agent.completed", task, agentName);
  }
}

function createWorker(name: string) {
  if (name === "CodebaseMapperAgent") return new CodebaseMapperAgent();
  if (name === "ArchitectAgent") return new ArchitectAgent();
  if (name === "FrontendAgent") return new FrontendAgent();
  if (name === "RustBackendAgent") return new RustBackendAgent();
  if (name === "ToolingTerminalAgent") return new ToolingTerminalAgent();
  if (name === "TestAgent") return new TestAgent();
  if (name === "SecurityAgent") return new SecurityAgent();
  if (name === "ReviewerAgent") return new ReviewerAgent();
  return new ToolingTerminalAgent();
}

function createAgentRun(
  sessionId: string,
  agentName: string,
  currentTask: string,
  status: AgentRun["status"],
  role: AgentRun["role"] = agentNameToRole(agentName)
): AgentRun {
  return {
    id: randomId("agent"),
    sessionId,
    agentName,
    role,
    currentTask,
    status,
    lastEvent: status,
    startedAt: new Date().toISOString(),
    completedAt: status === "completed" ? new Date().toISOString() : undefined
  };
}

function agentNameToRole(agentName: string): AgentRun["role"] {
  const role = agentName.replace("Agent", "").replace(/([a-z])([A-Z])/g, "$1 $2");
  if (role === "Codebase Mapper") return "Codebase Mapper";
  if (role === "Rust Backend") return "Rust Backend";
  if (role === "Tooling Terminal") return "Tooling Terminal";
  if (role === "Security") return "Security";
  if (role === "Reviewer") return "Reviewer";
  if (role === "Frontend") return "Frontend";
  if (role === "Architect") return "Architect";
  if (role === "Test") return "Test";
  return "Reviewer";
}

function inferEntryPoints(files: string[]) {
  return files.filter((file) => /main|index|App|lib\.rs|main\.rs/.test(file)).slice(0, 8);
}
