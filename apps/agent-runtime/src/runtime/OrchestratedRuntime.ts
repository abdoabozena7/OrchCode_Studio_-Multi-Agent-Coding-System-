import type {
  AgentRun,
  AgentRuntimeSession,
  AgentWorkStatus,
  IntentContract,
  OrchestrationEventType,
  PatchChangeStats,
  PatchProposal,
  ProjectMap,
  QualityGateResult,
  RunSummary,
  RuntimeProgressStage,
  RuntimeProgressStatus,
  WorkerOutput
} from "@hivo/protocol";
import path from "node:path";
import { ProductOrchestrator } from "../orchestrators/ProductOrchestrator.js";
import { BusinessOrchestrator } from "../orchestrators/BusinessOrchestrator.js";
import { EngineeringOrchestrator } from "../orchestrators/EngineeringOrchestrator.js";
import { FileLockManager } from "../scheduler/FileLockManager.js";
import { MergeController } from "../scheduler/MergeController.js";
import { TaskScheduler } from "../scheduler/TaskScheduler.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { SessionManager, randomId } from "./SessionManager.js";
import { appendAgentJournalEntry, getPatchStatsFromPatch } from "./AgentTelemetry.js";
import {
  GenericWorkerAgent,
  ReviewerAgent,
  SecurityAgent,
} from "../agents/workers/index.js";
import { isThreeJsSnakePrompt, validateThreeJsSnakeProposal } from "../mock/threeJsSnake.js";
import { createLegacyIntentInputFrame, IntentHandoffGate } from "../orchestration/IntentHandoffGate.js";

export class OrchestratedRuntime {
  constructor(private readonly sessionManager: SessionManager) {}

  async run(
    sessionId: string,
    message: string,
    options: {
      projectMap?: ProjectMap;
      delegationDecision?: import("@hivo/protocol").DelegationDecision;
      intentContract?: IntentContract;
      thinkFirst?: boolean;
    } = {}
  ) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session?.orchestration) throw new Error("Orchestrated session not found");
    const intentContract = options.intentContract ?? session.intentContract;
    if (!intentContract || intentContract.status !== "ready") {
      throw new Error("OrchestratedRuntime requires a ready IntentContract before planning.");
    }
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const orchestrationMessage = intentContract.precise_rewrite;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.lifecycleStage = "PLAN";
    });
    await this.progress(sessionId, {
      stage: "planning",
      status: "running",
      agentName: "Product Orchestrator",
      role: "Product",
      taskTitle: "Understand the request",
      summary: "Turning your prompt into concrete goals and success criteria.",
      targetFiles: []
    });
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

    const productBrief = new ProductOrchestrator().createBrief(intentContract);
    await this.recordAgent(sessionId, "Product Orchestrator", "Product Orchestrator", "Create product brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.productBrief = productBrief;
      draft.orchestration!.projectMap = projectMap;
    });
    await this.progress(sessionId, {
      stage: "planning",
      status: "completed",
      agentName: "Product Orchestrator",
      role: "Product",
      taskTitle: "Product brief",
      summary: `Goal: ${productBrief.goal}`,
      targetFiles: []
    });
    await this.emit(sessionId, "product_brief.created", "Product brief created.", "Product Orchestrator");

    await this.progress(sessionId, {
      stage: "planning",
      status: "running",
      agentName: "Business Orchestrator",
      role: "Business",
      taskTitle: "Define MVP and acceptance criteria",
      summary: "Converting the goal into MVP scope, risks, and acceptance checks.",
      targetFiles: []
    });
    const businessBrief = new BusinessOrchestrator().createBrief(productBrief);
    await this.recordAgent(sessionId, "Business Orchestrator", "Business Orchestrator", "Create business brief");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.orchestration!.businessBrief = businessBrief;
    });
    await this.progress(sessionId, {
      stage: "planning",
      status: "completed",
      agentName: "Business Orchestrator",
      role: "Business",
      taskTitle: "Business brief",
      summary: `Acceptance criteria prepared: ${businessBrief.acceptanceCriteria.slice(0, 3).join("; ")}`,
      targetFiles: []
    });
    await this.emit(sessionId, "business_brief.created", "Business brief created.", "Business Orchestrator");

    await this.progress(sessionId, {
      stage: "assigning",
      status: "running",
      agentName: "Engineering Orchestrator",
      role: "Engineering",
      taskTitle: "Assign the working team",
      summary: "Scanning the project shape and selecting only the workers needed for this task.",
      targetFiles: projectMap.importantFiles.slice(0, 5)
    });
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
      draft.orchestration!.assignmentPlan = {
        ...engineering.assignmentPlan,
        trustProfile: draft.trustProfile
      };
      draft.orchestration!.taskGraph = engineering.technicalPlan.taskGraph;
      draft.orchestration!.selectedWorkerAgents = engineering.delegationDecision.selectedAgentRoles;
      draft.orchestration!.mandatoryGateAgents = ["Product Orchestrator", "Business Orchestrator", "Engineering Orchestrator", "SecurityAgent", "ReviewerAgent"];
      draft.orchestration!.workOrders = engineering.workOrders;
    });
    await this.progress(sessionId, {
      stage: "assigning",
      status: "completed",
      agentName: "Engineering Orchestrator",
      role: "Engineering",
      taskTitle: "Working team selected",
      summary: engineering.delegationDecision.rationale,
      targetFiles: engineering.workOrders.flatMap((order) => order.requiredArtifacts).slice(0, 8)
    });
    await this.emit(sessionId, "technical_plan.created", "Technical plan and task graph created.", "Engineering Orchestrator");
    for (const node of engineering.technicalPlan.taskGraph.nodes) {
      await this.emit(sessionId, "task.created", node.title, node.assignedAgent, node.id);
    }
    for (const order of engineering.workOrders) {
      await this.updateWorkStatus(sessionId, {
        agentName: order.agentName,
        role: order.dynamicRole,
        taskTitle: order.objective,
        objective: order.objective,
        status: "queued",
        targetFiles: order.requiredArtifacts,
        summary: "Waiting for dependencies and file locks.",
        updatedAt: new Date().toISOString()
      });
      await this.progress(sessionId, {
        stage: "assigning",
        status: "queued",
        agentName: order.agentName,
        role: order.dynamicRole,
        taskTitle: order.objective,
        summary: `Assigned work order: ${order.objective}`,
        targetFiles: order.requiredArtifacts
      });
    }

    if (options.thinkFirst) {
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: formatOrchestratedPlanModeMessage(
          {
            delegationDecision: engineering.delegationDecision,
            workOrders: engineering.workOrders,
            businessBrief,
            technicalPlan: engineering.technicalPlan
          },
          orchestrationMessage
        )
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
    const artifacts: import("@hivo/protocol").ArtifactHandoff[] = [];
    const merge = new MergeController();
    const securityAgent = new SecurityAgent();
    const reviewerAgent = new ReviewerAgent();
    let previewRecommendation: import("@hivo/protocol").PreviewRecommendation | undefined;

    await scheduler.runAllAsync(async (task, runningTaskIds) => {
      if (runningTaskIds.length >= 2) {
        await this.emit(sessionId, "parallel_execution.active", runningTaskIds.join(", "), "TaskScheduler");
      }
      const workOrder = engineering.workOrders.find((candidate) => candidate.agentName === task.assignedAgent || candidate.id === `work_${task.id}`);
      const spec = engineering.assignmentPlan.workerSpecs.find((candidate) => candidate.objective === workOrder?.objective) ?? engineering.assignmentPlan.workerSpecs[0];
      if (!spec) throw new Error("No worker spec available for task");
      const toolsForWorker = new ToolRegistry(session.workspacePath, spec.capabilityGrant);
      const intentFrame = createLegacyIntentInputFrame({
        sessionId,
        intentContract,
        role: spec.roleTitle,
        taskId: task.id,
        objective: workOrder?.objective ?? task.description,
        taskTitle: task.title,
        dependencies: task.dependsOn,
        readFiles: workOrder?.requiredArtifacts ?? task.fileLocks,
        writeFiles: task.fileLocks,
        allowedFiles: spec.capabilityGrant.allowedPaths,
        forbiddenFiles: [],
        expectedOutputSchema: "WorkerOutput",
        validationRequirements: projectMap.testCommands,
        contextRefs: artifacts.map((artifact) => artifact.id)
      });
      const worker = new GenericWorkerAgent().assign({ ...spec, intentFrame });
      const run = createAgentRun(sessionId, task.assignedAgent, task.title, "running");
      await this.updateWorkStatus(sessionId, {
        agentName: task.assignedAgent,
        role: spec.roleTitle,
        taskTitle: task.title,
        objective: workOrder?.objective ?? task.description,
        status: "running",
        targetFiles: task.fileLocks.length ? task.fileLocks : workOrder?.requiredArtifacts ?? [],
        summary: "Inspecting context and preparing output.",
        updatedAt: new Date().toISOString()
      });
      await this.progress(sessionId, {
        stage: "working",
        status: "running",
        agentName: task.assignedAgent,
        role: spec.roleTitle,
        taskTitle: task.title,
        summary: workOrder?.objective ?? task.description,
        targetFiles: task.fileLocks.length ? task.fileLocks : workOrder?.requiredArtifacts ?? []
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.orchestration!.agentRuns.push(run);
      });
      const result = await worker.execute(task, {
        sessionId,
        userPrompt: orchestrationMessage,
        workspacePath: session.workspacePath,
        projectMap,
        tools: toolsForWorker,
        previousArtifacts: artifacts,
        intentFrame
      });
      const gate = await new IntentHandoffGate({
        workspacePath: session.workspacePath,
        sourceComponent: "OrchestratedRuntime"
      }).evaluate({
        runId: sessionId,
        runKind: "runtime_session",
        artifactsPath: path.join(session.workspacePath, ".agent_memory", "runtime_intents", sessionId),
        layer: "legacy_orchestrated",
        taskId: task.id,
        frame: intentFrame,
        alignment: result.output.intentAlignment,
        candidate: result.output,
        reviewedArtifactRefs: [result.artifact.id],
        target: "output"
      });
      const output = gate.passed ? {
        ...result.output,
        intentHandoffGate: gate
      } : {
        ...result.output,
        status: "blocked" as const,
        risks: [...new Set([...result.output.risks, `Intent handoff gate blocked this output: ${gate.deterministic_errors.join("; ")}`])],
        intentHandoffGate: gate
      };
      const artifact = gate.passed ? {
        ...result.artifact,
        intentHandoffGate: gate
      } : {
        ...result.artifact,
        summary: `Blocked by intent handoff gate: ${result.artifact.summary}`,
        details: [...result.artifact.details, ...gate.deterministic_errors],
        patchProposalIds: [],
        commandRequestIds: [],
        intentHandoffGate: gate
      };
      outputs.push(output);
      artifacts.push(artifact);
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.orchestration!.workerOutputs.push(output);
        draft.orchestration!.artifactHandoffs ??= [];
        draft.orchestration!.artifactHandoffs.push(artifact);
        const targetRun = draft.orchestration!.agentRuns.find((candidate) => candidate.id === run.id);
        if (targetRun) {
          targetRun.status = gate.passed ? "completed" : "blocked";
          targetRun.lifecycleStage = gate.passed ? "DONE" : "BLOCKED";
          targetRun.artifactJson = artifact;
          targetRun.completedAt = new Date().toISOString();
          targetRun.lastEvent = gate.passed ? "completed" : "intent_handoff_blocked";
          appendAgentJournalEntry(targetRun, {
            kind: "completed",
            title: task.title,
            summary: output.summary,
            status: gate.passed ? "completed" : "blocked"
          });
        }
      });
      if (gate.passed && result.patch) {
        const patch = result.patch;
        await this.sessionManager.addPatchProposal(sessionId, result.patch);
        const patchStats = getPatchStatsFromPatch(patch).map((stat) => ({
          path: stat.path,
          added: stat.additions,
          removed: stat.deletions,
          changeType: stat.changeType
        }));
        await this.sessionManager.updateSession(sessionId, (draft) => {
          const targetRun = draft.orchestration!.agentRuns.find((candidate) => candidate.id === run.id);
          if (!targetRun) return;
          targetRun.changedFiles = [...new Set([...(targetRun.changedFiles ?? []), ...patch.filesChanged.map((file) => file.path)])];
          for (const file of patch.filesChanged) {
            appendAgentJournalEntry(targetRun, {
              kind: "proposed_patch",
              title: patch.title,
              summary: file.explanation,
              filePath: file.path,
              severity: patch.riskLevel,
              status: "completed"
            });
          }
        });
        await this.progress(sessionId, {
          stage: "patching",
          status: "completed",
          agentName: task.assignedAgent,
          role: spec.roleTitle,
          taskTitle: "Code changes proposed",
          summary: `${result.patch.title}: ${result.patch.summary}`,
          targetFiles: result.patch.filesChanged.map((file) => file.path),
          patchStats
        });
      }
      if (gate.passed && result.commandRequest) {
        await this.sessionManager.addCommandRequest(sessionId, result.commandRequest);
        await this.sessionManager.updateSession(sessionId, (draft) => {
          const targetRun = draft.orchestration!.agentRuns.find((candidate) => candidate.id === run.id);
          if (!targetRun) return;
          targetRun.commandsRun = [...new Set([...(targetRun.commandsRun ?? []), result.commandRequest!.command])];
          appendAgentJournalEntry(targetRun, {
            kind: "command_requested",
            title: result.commandRequest!.command,
            summary: result.commandRequest!.reason,
            command: result.commandRequest!.command,
            status: result.commandRequest!.status === "blocked" ? "blocked" : "queued"
          });
        });
      }
      if (gate.passed && !previewRecommendation && result.previewRecommendation) {
        previewRecommendation = result.previewRecommendation;
      }
      await this.updateWorkStatus(sessionId, {
        agentName: task.assignedAgent,
        role: spec.roleTitle,
        taskTitle: task.title,
        objective: workOrder?.objective ?? task.description,
        status: gate.passed ? "completed" : "blocked",
        targetFiles: task.fileLocks.length ? task.fileLocks : workOrder?.requiredArtifacts ?? [],
        summary: output.summary,
        selfCheck: output.selfCheck,
        updatedAt: new Date().toISOString()
      });
      await this.progress(sessionId, {
        stage: "working",
        status: gate.passed ? "completed" : "blocked",
        agentName: task.assignedAgent,
        role: spec.roleTitle,
        taskTitle: task.title,
        summary: output.summary,
        targetFiles: task.fileLocks.length ? task.fileLocks : workOrder?.requiredArtifacts ?? []
      });
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
        await this.progress(sessionId, {
          stage: "reviewing",
          status: "queued",
          agentName: "Rust Terminal Authority",
          role: "Tooling",
          taskTitle: "Safe validation command requested",
          summary: `${command.command} is queued for Rust execution.`,
          targetFiles: []
        });
      }
    }

    await this.progress(sessionId, {
      stage: "reviewing",
      status: "running",
      agentName: "SecurityAgent",
      role: "Security",
      taskTitle: "Review generated changes and commands",
      summary: "Checking for dangerous commands, secret exposure, and unsafe patch behavior.",
      targetFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path))
    });
    const mergeSummary = merge.detectPatchConflicts(session.patchProposals);
    const securityReview = securityAgent.review(sessionId, session.patchProposals, session.commandRequests);
    await this.progress(sessionId, {
      stage: "reviewing",
      status: securityReview.status === "passed" ? "completed" : "blocked",
      agentName: "SecurityAgent",
      role: "Security",
      taskTitle: "Security review",
      summary: securityReview.summary,
      targetFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path))
    });
    await this.progress(sessionId, {
      stage: "reviewing",
      status: "running",
      agentName: "ReviewerAgent",
      role: "Reviewer",
      taskTitle: "Review implementation quality",
      summary: "Checking the worker outputs against acceptance criteria before anything is considered done.",
      targetFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path))
    });
    const reviewerSummary = reviewerAgent.review(
      sessionId,
      session.patchProposals,
      outputs,
      mergeSummary.conflicts.map((conflict) => `Conflict on ${conflict.path}`)
    );
    const qualityGates = runQualityGates(sessionId, orchestrationMessage, session.patchProposals, outputs, securityReview.status === "passed", reviewerSummary.findings);
    const gatesPassed = qualityGates.every((gate) => gate.status === "passed");
    await this.progress(sessionId, {
      stage: "reviewing",
      status: gatesPassed ? "completed" : "blocked",
      agentName: "ReviewerAgent",
      role: "Reviewer",
      taskTitle: "Quality gates",
      summary: gatesPassed
        ? "Reviewer, security, and test gates passed."
        : `Quality gates blocked the run: ${qualityGates.flatMap((gate) => gate.blockingReasons).join("; ")}`,
      targetFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path))
    });

    const canAutoApply = false;

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = gatesPassed ? "needs_approval" : "failed";
      draft.lifecycleStage = gatesPassed ? "APPROVAL" : "BLOCKED";
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
      draft.orchestration!.qualityGateResults.push(...qualityGates);
      if (!gatesPassed) {
        draft.orchestration!.retryCount += 1;
      }
      draft.orchestration!.lockedFiles = locks.snapshot();
      draft.previewRecommendation = previewRecommendation;
      draft.reasoningSummaries.push(
        !gatesPassed
          ? "Quality gates blocked the generated output before any files were applied."
          : "Orchestrated run completed and stopped for Rust-mediated patch approval."
      );
    });

    const appliedTitles: string[] = [];
    if (gatesPassed) {
      await this.emit(sessionId, "validation.completed", "Validation gates passed; waiting for Rust-mediated approval/apply.");
      await this.emit(sessionId, "verification.pending", "Post-verify is pending until Rust applies approved changes.");
    }

    if (!gatesPassed) {
      await this.progress(sessionId, {
        stage: "blocked",
        status: "blocked",
        agentName: "ReviewerAgent",
        role: "Reviewer",
        taskTitle: "Run blocked",
        summary: "I stopped before applying files because one or more quality gates failed.",
        targetFiles: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => file.path))
      });
    }

    const latestSession = this.sessionManager.getSession(sessionId)!;
    const runSummary = createRunSummary(latestSession, qualityGates, gatesPassed, appliedTitles);
    await this.sessionManager.setRunSummary(sessionId, runSummary);
    await this.progress(sessionId, {
      stage: gatesPassed ? "completed" : "blocked",
      status: gatesPassed ? "completed" : "blocked",
      agentName: latestSession.agentName,
      role: "Summary",
      taskTitle: "Final summary",
      summary: runSummary.summary,
      targetFiles: runSummary.filesChanged.map((file) => file.path),
      patchStats: runSummary.filesChanged
    });
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: formatRunSummaryMessage(runSummary)
    });

    await this.emit(sessionId, "security.reviewed", securityReview.summary, "SecurityAgent");
    await this.emit(sessionId, "agent.completed", reviewerSummary.summary, "ReviewerAgent");
    await this.emit(sessionId, gatesPassed ? "orchestration.completed" : "orchestration.failed", gatesPassed ? "Multi-agent orchestration completed." : "Quality gates blocked the generated output.");
    return this.sessionManager.getSession(sessionId)!;
  }

  private async progress(
    sessionId: string,
    input: {
      stage: RuntimeProgressStage;
      status: RuntimeProgressStatus;
      agentName?: string;
      role?: string;
      taskTitle?: string;
      summary: string;
      targetFiles: string[];
      patchStats?: PatchChangeStats[];
    }
  ) {
    await this.sessionManager.addProgressEvent(sessionId, {
      id: randomId("progress"),
      sessionId,
      createdAt: new Date().toISOString(),
      ...input
    });
  }

  private async updateWorkStatus(sessionId: string, status: AgentWorkStatus) {
    await this.sessionManager.updateAgentWorkStatus(sessionId, status);
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

function formatOrchestratedPlanModeMessage(
  engineering: {
    delegationDecision: { rationale: string };
    workOrders: Array<{ objective: string; dynamicRole: string }>;
    businessBrief: { acceptanceCriteria: string[] };
    technicalPlan: { risks?: string[]; summary: string };
  },
  message: string
) {
  const arabic = /[\u0600-\u06FF]/.test(message);
  return [
    arabic
      ? "اشتغلت في Plan mode فقط: رتبت الفريق والخطوات ووقفت قبل أي تعديل."
      : "I stayed in plan mode only: I organized the team and the steps, then stopped before any edits.",
    "",
    engineering.technicalPlan.summary,
    "",
    arabic ? "## توزيع الشغل" : "## Work Breakdown",
    ...engineering.workOrders.map((order, index) => `${index + 1}. ${order.dynamicRole}: ${order.objective}`),
    "",
    arabic ? "## معايير القبول" : "## Acceptance Criteria",
    ...engineering.businessBrief.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    arabic ? "## ملاحظات الخطة" : "## Planning Notes",
    `- ${engineering.delegationDecision.rationale}`,
    ...(engineering.technicalPlan.risks?.length ? engineering.technicalPlan.risks.map((risk) => `- ${risk}`) : []),
    "",
    arabic
      ? "لو الخطة مناسبة، اختار Implement plan."
      : "If the plan looks right, choose Implement plan."
  ].join("\n");
}

function getPatchStats(patch: PatchProposal): PatchChangeStats[] {
  return getPatchStatsFromPatch(patch).map((stat) => ({
    path: stat.path,
    added: stat.additions,
    removed: stat.deletions,
    changeType: stat.changeType
  }));
}

function createRunSummary(
  session: AgentRuntimeSession,
  qualityGates: QualityGateResult[],
  gatesPassed: boolean,
  appliedTitles: string[]
): RunSummary {
  const files = new Map<string, PatchChangeStats>();
  for (const patch of session.patchProposals) {
    for (const stat of getPatchStats(patch)) {
      const existing = files.get(stat.path);
      files.set(stat.path, {
        path: stat.path,
        changeType: stat.changeType,
        added: typeof stat.added === "number" || typeof existing?.added === "number" ? (existing?.added ?? 0) + (stat.added ?? 0) : undefined,
        removed: typeof stat.removed === "number" || typeof existing?.removed === "number" ? (existing?.removed ?? 0) + (stat.removed ?? 0) : undefined
      });
    }
  }
  const filesChanged = [...files.values()];
  const appliedPatchIds = session.patchProposals.filter((patch) => patch.status === "applied").map((patch) => patch.id);
  const proposedPatchIds = session.patchProposals.filter((patch) => patch.status !== "applied").map((patch) => patch.id);
  const summary = !gatesPassed
    ? "I stopped before changing files because the review gates found blocking issues."
    : appliedPatchIds.length
      ? `I implemented the requested change across ${filesChanged.length} file(s).`
      : `I prepared ${session.patchProposals.length} code change proposal(s) for review.`;

  return {
    status: gatesPassed ? "completed" : "blocked",
    summary,
    filesChanged,
    appliedPatchIds,
    proposedPatchIds,
    commandResults: session.commandExecutions.map((command) => `${command.command}: ${command.status}`),
    gates: qualityGates.map((gate) => ({
      name: gate.gateName,
      status: gate.status,
      notes: gate.status === "passed" ? gate.reviewerNotes : gate.blockingReasons
    })),
    nextAction: session.nextAction?.message ?? (appliedTitles.length ? `Applied: ${appliedTitles.join(", ")}` : undefined),
    createdAt: new Date().toISOString()
  };
}

function formatRunSummaryMessage(summary: RunSummary) {
  const lines = [summary.summary];
  if (summary.filesChanged.length) {
    lines.push("", summary.appliedPatchIds.length ? "Files changed:" : "Files proposed:");
    lines.push(...summary.filesChanged.map((file) => `- ${file.path} +${file.added} -${file.removed}`));
  }
  if (summary.gates.length) {
    lines.push("", "Checks:");
    lines.push(...summary.gates.map((gate) => `- ${gate.name}: ${gate.status}`));
  }
  if (summary.commandResults.length) {
    lines.push("", "Commands:");
    lines.push(...summary.commandResults.map((command) => `- ${command}`));
  }
  if (summary.nextAction) {
    lines.push("", summary.nextAction);
  }
  return lines.join("\n");
}

function runQualityGates(
  sessionId: string,
  prompt: string,
  patches: import("@hivo/protocol").PatchProposal[],
  outputs: WorkerOutput[],
  securityPassed: boolean,
  reviewerFindings: string[]
): QualityGateResult[] {
  const createdAt = new Date().toISOString();
  const blockingReasons: string[] = [];
  const reviewerNotes: string[] = [];

  for (const output of outputs) {
    if (output.status !== "completed") {
      blockingReasons.push(`${output.agentName} did not complete: ${output.status}.`);
    }
    if (output.intentHandoffGate?.status !== "passed") {
      blockingReasons.push(`${output.agentName} failed intent handoff gate: ${output.intentHandoffGate?.deterministic_errors.join("; ") ?? "missing gate"}`);
    }
    if (output.selfCheck?.failedCriteria.length || output.selfCheck?.missingItems.length) {
      blockingReasons.push(`${output.agentName} failed self-check: ${[...(output.selfCheck.failedCriteria ?? []), ...(output.selfCheck.missingItems ?? [])].join(", ")}`);
    }
  }

  for (const patch of patches) {
    const artifactText = (patch.artifacts ?? []).map((artifact) => artifact.content).join("\n").toLowerCase();
    if (/mock_orchestrated|representative patch|todo|placeholder/.test(artifactText)) {
      blockingReasons.push(`${patch.title} contains placeholder or representative-only content.`);
    }
    if (isThreeJsSnakePrompt(prompt)) {
      const validation = validateThreeJsSnakeProposal(patch);
      blockingReasons.push(...validation.blockingReasons);
      reviewerNotes.push(...validation.reviewerNotes);
    }
  }

  if (!patches.length) {
    blockingReasons.push("No patch proposal was produced.");
  }
  if (!securityPassed) {
    blockingReasons.push("Security gate did not pass.");
  }
  blockingReasons.push(...reviewerFindings);

  return [
    {
      id: randomId("quality"),
      sessionId,
      gateName: "ReviewerGate",
      status: blockingReasons.length ? "failed" : "passed",
      blockingReasons,
      reviewerNotes: reviewerNotes.length ? reviewerNotes : ["Generated output passed reviewer quality checks."],
      createdAt
    },
    {
      id: randomId("quality"),
      sessionId,
      gateName: "SecurityGate",
      status: securityPassed ? "passed" : "failed",
      blockingReasons: securityPassed ? [] : ["Security review reported blocking findings."],
      reviewerNotes: [securityPassed ? "Security review passed." : "Security review failed."],
      createdAt
    },
    {
      id: randomId("quality"),
      sessionId,
      gateName: "TestGate",
      status: patches.length ? "passed" : "failed",
      blockingReasons: patches.length ? [] : ["No artifact exists to validate."],
      reviewerNotes: [patches.length ? "Patch artifacts are present for validation." : "No patch artifacts were present."],
      createdAt
    }
  ];
}

function createAgentRun(
  sessionId: string,
  agentName: string,
  currentTask: string,
  status: AgentRun["status"],
  role: AgentRun["role"] = agentNameToRole(agentName)
): AgentRun {
  const id = randomId("agent");
  const startedAt = new Date().toISOString();
  return {
    id,
    sessionId,
    agentName,
    role,
    currentTask,
    status,
    lastEvent: status,
    workJournal: [{
      id: randomId("journal"),
      agentId: id,
      timestamp: startedAt,
      kind: "planning",
      title: currentTask,
      summary: "Worker run created and waiting to execute.",
      status: status === "completed" ? "completed" : "running"
    }],
    startedAt,
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
