import type {
  AgentRiskRef,
  AgentRun,
  AgentPlan,
  AgentRuntimeSession,
  Artifact,
  CommandRequest,
  DecisionRecord,
  EvidenceRef,
  EvidenceTruthReport,
  PatchFileChange,
  PatchProposal,
  ProjectMap,
  ReviewGateSummary,
  RunPatchIntent,
  RunPatchIntentModel,
  RunMode,
  RunPhase,
  RunPhaseId,
  RunPhaseStatus,
  RunSummary,
  RuntimeExecutionMode,
  RuntimeProgressStage,
  ToolIntent,
  VerificationResult
} from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { runPatchIntentSchema, runPlanSchema, runVerificationSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import { randomId, SessionManager } from "./SessionManager.js";
import { invokeReasoningProviderStructured } from "./ReasoningKernel.js";
import { inferProjectLaunch } from "./ProjectLaunchInference.js";
import {
  appendAgentJournalEntry,
  buildAttributedReviewGate,
  buildDiffAwareRunSummary
} from "./AgentTelemetry.js";
import {
  buildProjectIntake,
  classifyRunIntent,
  createProjectIntakeEvidenceRefs,
  createProjectIntakeWarnings,
  createProjectMapFromIntake,
  shouldTreatProjectAsExisting
} from "./ProjectIntake.js";
import {
  buildModuleExecutionPlan,
  summarizeModuleExecution,
  validatePatchAgainstModulePlan
} from "./ModuleExecutionPlanning.js";
import { initializeRunToGreenState } from "./RunToGreen.js";
import {
  buildLargeProjectExplainReport
} from "./LargeProjectContextBuilder.js";
import { inferWorkspaceIntent } from "./WorkspaceReasoningPipeline.js";
import { answerUniversalProjectQuestion } from "./UniversalProjectQuestionEngine.js";
import { createConversationUnderstanding, type ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { applyProjectUnderstandingDecisionPipeline, beginDecisionPipeline, finalizeAnswerDecisionPipeline } from "./DecisionPipeline.js";

type RunPlanTask = {
  id?: string;
  title: string;
  objective: string;
  roleTitle: string;
  targetFiles?: string[];
  expectedArtifact?: string;
  verification?: string;
};

type RunPlanModel = {
  summary: string;
  reasoningSummary: string;
  mode: "create_project" | "edit_project" | "inspect_only";
  tasks: RunPlanTask[];
  acceptanceCriteria: string[];
  risks: string[];
  suggestedCommands?: Array<{ command: string; reason: string }>;
  fallbackWarning?: string;
  planSource?: "provider" | "operator_supplied" | "deterministic_fallback";
};

type RunVerificationModel = {
  summary: string;
  checks: Array<{ name: string; status: "passed" | "failed" | "pending"; detail: string }>;
};

function addWorkspaceIdentityBanner(answerMarkdown: string, workspacePath: string): string {
  const trimmedAnswer = answerMarkdown.trim();
  const normalizedWorkspace = workspacePath.replaceAll("\\", "/").replace(/\/$/, "");
  const normalizedAnswer = trimmedAnswer.replaceAll("\\", "/");
  const lines: string[] = [];
  if (!normalizedWorkspace || !normalizedAnswer.includes(normalizedWorkspace)) {
    lines.push(`> Workspace used for this answer: \`${workspacePath}\``);
  }
  return lines.length ? [...lines, "", trimmedAnswer].join("\n") : trimmedAnswer;
}

function createLocalRunProgressCopy(message: string) {
  const arabic = /[\u0600-\u06ff]/.test(message);
  return {
    arabic,
    intake: arabic
      ? { title: "فهم الطلب", summary: "بفهم المطلوب وبجهز تشغيل محلي آمن من غير ما أعدل ملفات." }
      : { title: "Intake", summary: "Clarifying the request and preparing a local run." },
    workspaceSnapshot: arabic
      ? { title: "قراءة المشروع", summary: "بقرأ شكل المشروع والملفات المهمة عشان أبني الصورة من الواقع." }
      : { title: "Workspace snapshot", summary: "Inspecting workspace structure and important files." },
    questionMode: arabic
      ? { title: "تحديد نوع السؤال", summary: "ليه الخطوة دي: لازم أعرف هل المطلوب شرح، تدفق، معماريات، أو سؤال عن ميزة قبل ما أقرأ الأدلة." }
      : { title: "Question mode", summary: "Why this step: classify whether this is explain, flow, architecture, or feature understanding before reading evidence." },
    evidenceReportStart: arabic
      ? { title: "تقرير الأدلة", summary: "ليه الخطوة دي: ببني تقرير أولي من خريطة المشروع والملفات المهمة بدل رد ثابت." }
      : { title: "Evidence report", summary: "Why this step: build an initial evidence report from the project map and important files instead of using a canned answer." },
    workspaceReadingStart: arabic
      ? { title: "فتح الملفات", summary: "ليه الخطوة دي: بفتح الملفات المرشحة وبجمع إشارات من الكود الحالي قبل صياغة الرد." }
      : { title: "Workspace reading", summary: "Why this step: open candidate files and collect current-code signals before drafting the answer." },
    evidenceValidation: arabic
      ? { title: "مراجعة الأدلة", summary: "ليه الخطوة دي: براجع الاستشهادات وبستبعد الأدلة الضعيفة أو اللي مش من كود production." }
      : { title: "Evidence validation", summary: "Why this step: check citations and reject weak, generated, or non-production evidence before trusting claims." },
    answerDraft: arabic
      ? { title: "تجهيز الرد", summary: "ليه الخطوة دي: بصيغ إجابة مفهومة من الأدلة المقبولة، مش من كلام عام." }
      : { title: "Answer drafting", summary: "Why this step: draft a readable answer from accepted evidence, not generic bullets." },
    finalReport: arabic
      ? { title: "حفظ النتيجة", summary: "ليه الخطوة دي: بحفظ التقرير والرد النهائي عشان تقدر تراجع اللي حصل بعد التشغيل." }
      : { title: "Final report", summary: "Why this step: store the evidence report and final answer so the run stays auditable." }
  };
}


export class RunEngine {
  constructor(
    private readonly provider: LlmProvider,
    private readonly sessionManager: SessionManager,
    private readonly options: { providerTelemetry?: ProviderTelemetryRecorder } = {}
  ) {}

  async runTurn(
    sessionId: string,
    message: string,
    options: {
      resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">;
      projectMap: ProjectMap;
      thinkFirst?: boolean;
      conversationUnderstanding?: ConversationUnderstanding;
    }
  ): Promise<AgentRuntimeSession> {
    const session = this.requireSession(sessionId);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }
    const conversationUnderstanding = options.conversationUnderstanding ?? createConversationUnderstanding(message);
    const intentDecision = conversationUnderstanding.intentDecision;
    if (intentDecision.kind === "direct_conversation") {
      throw new Error("reasoning_kernel.direct_conversation_must_be_provider_composed");
    }
    const executionMessage = conversationUnderstanding.workspaceMessage || message;

    const requestedRunIntent = classifyRunIntent(message, conversationUnderstanding);
    const runMode = inferLocalRunMode(executionMessage, options.resolvedMode, requestedRunIntent);

    const progressCopy = createLocalRunProgressCopy(message);
    await this.updateStage(sessionId, "INTAKE", "planning", "running", progressCopy.intake.title, progressCopy.intake.summary);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.resolvedExecutionMode = options.resolvedMode;
      draft.agentName = "Local Run";
      draft.runMode = runMode;
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.runPhases = createInitialRunPhases(runMode);
      draft.reviewGate = undefined;
      upsertAgentRunRecord(draft, {
        id: "agent_local_codex",
        sessionId,
        agentName: "Local Run",
        displayName: "Coordinator",
        role: "Senior Coding Agent",
        roleTitle: "Coordinator",
        lifecycleStage: "INTAKE",
        objective: executionMessage,
        ownedPaths: ["workspace://current"],
        forbiddenPaths: ["tauri://rust-authority", "workspace://outside-current"],
        allowedActions: ["inspect_workspace", "prepare_plan", "propose_patch", "request_commands", "record_decisions"],
        stopConditions: ["Stop before writes until Rust approval/apply happens.", "Stop if work leaves the current workspace boundary."],
        integrationNotes: ["Rust remains the apply authority.", "Use runtime-owned evidence and decision records as the review source of truth."],
        currentAction: "Clarifying the request and preparing a local run.",
        recentActions: ["Session created", "Run initialized"],
        changedFiles: [],
        commandsRun: [],
        testsRun: [],
        decisionsMade: [],
        evidenceRefs: [],
        riskRefs: [],
        workJournal: [],
        riskLevel: "medium",
        blockers: [],
        diffStats: { fileCount: 0 },
        currentTask: "Prepare run",
        status: "running",
        lastEvent: "Run initialized",
        startedAt: draft.createdAt
      });
      const coordinator = draft.orchestration?.agentRuns.find((agent) => agent.id === "agent_local_codex");
      if (coordinator) {
        appendAgentJournalEntry(coordinator, {
          kind: "planning",
          title: "Run initialized",
          summary: "Coordinator created a bounded local run contract.",
          status: "running"
        });
      }
    });
    await this.updateRunPhase(sessionId, "inspect_workspace", "active", "Inspecting workspace structure and task intent.");

    const tools = new ToolRegistry(session.workspacePath);
    await this.addIntent(sessionId, "workspace.snapshot.requested", "Workspace snapshot", "Inspect project shape without changing files.", {
      workspacePath: session.workspacePath
    }, "executed");
    const intake = buildProjectIntake({
      workspacePath: session.workspacePath,
      message: executionMessage,
      projectMap: options.projectMap,
      tools,
      conversationUnderstanding
    });
    const enrichedProjectMap = createProjectMapFromIntake(options.projectMap, intake);
    const snapshot = createSnapshot(tools, enrichedProjectMap, executionMessage, intake, conversationUnderstanding);
    await this.addIntent(sessionId, "project.intake.requested", "Project intake", "Detect project continuation signals before planning edits.", {
      workspacePath: session.workspacePath,
      projectKind: intake.projectKind,
      confidence: intake.confidence,
      runIntent: intake.runIntent
    }, "executed");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.projectIntake = intake;
      draft.contextPack = intake.contextPack;
      draft.runIntent = intake.runIntent;
    });
    await this.addArtifact(sessionId, "project_intake", "Project intake", intake.currentStateSummary ?? "Project intake completed.", {
      intake
    });
    if (intake.contextPack) {
      await this.addArtifact(sessionId, "context_pack", "Context pack", intake.contextPack.projectSummary, {
        contextPack: intake.contextPack
      });
    }
    await this.addDecisionRecord(sessionId, {
      category: "finding",
      finding: "Workspace inspection completed before any write proposal.",
      decision: "Use the repo snapshot as the source of truth for planning.",
      rationaleSummary: snapshot.summary,
      evidenceRefs: createSnapshotEvidenceRefs(snapshot),
      linkedFiles: snapshot.importantFiles.slice(0, 6),
      createdByAgent: "Local Run",
      createdByAgentId: "agent_local_codex",
      linkedAgentIds: ["agent_local_codex"]
    });
    await this.addDecisionRecord(sessionId, {
      category: "decision",
      finding: `Detected ${intake.projectKind.replaceAll("_", " ")} with ${intake.confidence} confidence.`,
      decision: shouldTreatProjectAsExisting(intake.projectKind)
        ? "Treat this workspace as existing work: intake and context-pack first, then narrow edits."
        : intake.projectKind === "empty_project"
          ? "Workspace appears close to empty, so blank-project planning can proceed."
          : "Workspace classification is uncertain; keep the next step read-only and conservative.",
      rationaleSummary: intake.currentStateSummary ?? snapshot.summary,
      evidenceRefs: createProjectIntakeEvidenceRefs(intake),
      linkedFiles: intake.importantFiles.slice(0, 8),
      uncertainty: createProjectIntakeWarnings(intake)[0],
      createdByAgent: "Local Run",
      createdByAgentId: "agent_local_codex",
      linkedAgentIds: ["agent_local_codex"]
    });
    await this.updateStage(
      sessionId,
      "CONTEXT_GATHER",
      "inspecting",
      "completed",
      progressCopy.workspaceSnapshot.title,
      progressCopy.arabic ? `${progressCopy.workspaceSnapshot.summary} لقيت ${snapshot.importantFiles.length} ملف مهم.` : snapshot.summary,
      snapshot.importantFiles.slice(0, 6)
    );
    await this.updateRunPhase(sessionId, "inspect_workspace", "completed", snapshot.summary, snapshot.fileSamples.length);
    await this.updateRunPhase(
      sessionId,
      "build_repo_map",
      "completed",
      `Intake classified the workspace as ${intake.projectKind.replaceAll("_", " ")} (${intake.confidence}) and mapped ${snapshot.importantFiles.length} important file(s).`,
      snapshot.searchResults.length
    );

    await this.addIntent(sessionId, "workspace.search.requested", "Search request", "Identify likely files and project entry points.", {
      query: inferSearchQuery(executionMessage, conversationUnderstanding),
      importantFiles: snapshot.importantFiles
    }, "executed");

    if (isReadOnlyAnswerRequest(snapshot)) {
      return this.runInspectExplainTurn(sessionId, message, options.projectMap, intake, conversationUnderstanding);
    }

    if (snapshot.runIntent === "run_to_green") {
      const runToGreenPlan = await this.createPlan(session, executionMessage, snapshot, options.resolvedMode);
      const modulePlan = shouldTreatProjectAsExisting(intake.projectKind)
        ? buildModuleExecutionPlan({
            sessionId,
            workspaceRoot: session.workspacePath,
            objective: executionMessage,
            createdAt: new Date().toISOString(),
            intake,
            contextPack: intake.contextPack,
            targetFiles: runToGreenPlan.tasks.flatMap((task) => task.targetFiles ?? []),
            suggestedCommands: []
          })
        : undefined;
      await this.applyPlanState(sessionId, runToGreenPlan, modulePlan);
      await this.addArtifact(sessionId, "plan", "Run plan", runToGreenPlan.summary, {
        plan: runToGreenPlan,
        preset: options.resolvedMode
      });
      if (modulePlan) {
        await this.addIntent(sessionId, "module.plan.requested", modulePlan.title, modulePlan.rationale, {
          modulePlanId: modulePlan.id,
          ownedPaths: modulePlan.ownedPaths,
          cautionPaths: modulePlan.cautionPaths,
          forbiddenPaths: modulePlan.forbiddenPaths
        }, "executed");
        await this.addArtifact(sessionId, "module_plan", modulePlan.title, modulePlan.rationale, { modulePlan });
      }
      await this.addDecisionRecord(sessionId, {
        category: "decision",
        finding: "Run-to-green request bypassed brittle provider task planning.",
        decision: "Use deterministic run-to-green startup tasks so command selection stays on the critical path.",
        rationaleSummary: runToGreenPlan.reasoningSummary,
        evidenceRefs: createProjectIntakeEvidenceRefs(intake),
        linkedFiles: intake.importantFiles.slice(0, 6),
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
      await this.updateStage(sessionId, "PLAN", "planning", "completed", "Plan", runToGreenPlan.reasoningSummary || runToGreenPlan.summary);
      await this.updateRunPhase(sessionId, "split_agents", "completed", `Prepared ${runToGreenPlan.tasks.length} deterministic run-to-green task(s).`, runToGreenPlan.tasks.length);

      const recommendation = inferProjectLaunch(session.workspacePath, tools.workspace);
      const runToGreen = initializeRunToGreenState({
        sessionId,
        workspacePath: session.workspacePath,
        message: executionMessage,
        modulePlan,
        intake,
        contextPack: intake.contextPack,
        launchRecommendation: recommendation,
        now: new Date().toISOString()
      });
      const commandRequests = runToGreen.selectedCommands.length
        ? createCommandRequests(sessionId, session.workspacePath, [{
            command: runToGreen.selectedCommands[0]!.command,
            reason: runToGreen.selectedCommands[0]!.reason
          }], [], { fullAccess: session.accessProfile === "full_access" })
        : [];
      for (const request of commandRequests) {
        await this.addIntent(sessionId, "command.requested", request.command, request.reason, { commandRequestId: request.id, risk: request.risk }, request.status === "blocked" ? "blocked" : "proposed");
        await this.sessionManager.addCommandRequest(sessionId, request);
      }
      const verification = await this.createVerification(sessionId, commandRequests.length
        ? "Run-to-green verification is pending until Rust runs the selected command."
        : recommendation?.preview
          ? "No grounded run command was found. A preview is available instead."
          : (runToGreen.blockerReason ?? "No grounded run command was found for this workspace."), [
        { name: "Run-to-green intent", status: "passed", detail: "Bounded repair loop was initialized." },
        {
          name: "Command selection",
          status: commandRequests.length ? "passed" : "unavailable",
          detail: commandRequests[0]?.command ?? (
            recommendation?.preview
              ? "No grounded run command was selected. Preview the workspace instead."
              : (runToGreen.blockerReason ?? "No grounded command could be selected.")
          )
        },
        {
          name: "Rust command execution",
          status: commandRequests.length ? "pending" : "not_run",
          detail: commandRequests[0]?.command ?? (
            recommendation?.preview
              ? "No grounded command was selected, so Rust command execution was not started. Preview is available."
              : "No grounded command was selected, so Rust command execution was not started."
          )
        }
      ]);
      await this.addIntent(sessionId, "validation.requested", "Run-to-green verification", verification.summary, { verificationId: verification.id }, commandRequests.length ? "proposed" : "blocked");
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.runToGreen = runToGreen;
        draft.status = commandRequests.length ? "needs_approval" : "completed";
        draft.lifecycleStage = commandRequests.length ? "APPROVAL" : "DONE";
        draft.reasoningSummaries.push(runToGreenPlan.reasoningSummary);
        draft.previewRecommendation = recommendation?.preview;
        draft.nextAction = commandRequests.length
          ? { kind: "approve_commands", message: "Approve the selected run-to-green command to start the bounded repair loop through Rust." }
          : recommendation?.preview
            ? { kind: "preview_ready", message: "No grounded run command was found. Preview is available instead.", preview: recommendation.preview }
            : undefined;
        draft.reviewGate = createRunToGreenReviewGate(draft, verification, commandRequests);
        updateAgentRunRecord(draft, "agent_local_codex", (agent) => {
          agent.status = commandRequests.length ? "running" : "completed";
          agent.lifecycleStage = commandRequests.length ? "APPROVAL" : "DONE";
          agent.currentAction = commandRequests.length
            ? "Safe project command is ready for Rust execution."
            : recommendation?.preview
              ? "No grounded run command was found. Preview is available instead."
              : (runToGreen.blockerReason ?? "No grounded run command was found.");
          agent.lastEvent = commandRequests.length ? "awaiting:command-execution" : "completed:no-grounded-command";
          if (!commandRequests.length) {
            agent.completedAt = new Date().toISOString();
          }
        });
      });
      await this.addArtifact(sessionId, "run_to_green", "Run-to-green state", commandRequests.length ? "Bounded repair loop initialized." : "Run-to-green finished without a runnable command.", { runToGreen });
      await this.addDecisionRecord(sessionId, {
        category: commandRequests.length ? "decision" : "risk",
        finding: commandRequests.length
          ? "Run-to-green intent selected a grounded project command."
          : "Run-to-green intent could not find a grounded project command.",
        decision: commandRequests.length
          ? `Start the bounded repair loop with ${commandRequests[0]?.command}.`
          : "Block the repair loop instead of inventing a command.",
        rationaleSummary: commandRequests.length
          ? runToGreen.selectedCommands[0]?.reason ?? "Selected from grounded workspace signals."
          : runToGreen.blockerReason ?? "No grounded command was available.",
        evidenceRefs: createProjectIntakeEvidenceRefs(intake),
        linkedFiles: intake.importantFiles.slice(0, 4),
        uncertainty: !commandRequests.length ? runToGreen.blockerReason : undefined,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
      await this.updateRunPhase(sessionId, "agents_running", "completed", "Inspection completed and run-to-green command selection finished.");
      await this.updateRunPhase(sessionId, "run_verification", commandRequests.length ? "active" : "blocked", verification.summary, verification.checks.length);
      await this.updateRunPhase(
        sessionId,
        "review_final_diff",
        commandRequests.length ? "active" : "completed",
        commandRequests.length
          ? "Run-to-green is waiting for command execution or a repair result."
          : recommendation?.preview
            ? "No grounded run command was found. Preview is available instead."
            : "No grounded run command was found."
      );
      await this.updateRunPhase(
        sessionId,
        "final_report",
        commandRequests.length ? "active" : "completed",
        commandRequests.length
          ? "Run-to-green is waiting for the first command result."
          : recommendation?.preview
            ? "Run-to-green did not start because only a preview could be grounded safely."
            : "Run-to-green did not start because no grounded command could be selected."
      );
      await this.sessionManager.setRunSummary(sessionId, {
        status: commandRequests.length ? "pending" : "completed",
        summary: commandRequests.length
          ? `Prepared run-to-green command: ${commandRequests[0]?.command}`
          : recommendation?.preview
            ? "No grounded run command was found. Preview is available instead."
            : runToGreen.blockerReason ?? "No launch, build, start, or test command could be inferred safely.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: commandRequests.map((request) => `${request.command}: ${request.status}`),
        gates: verification.checks.map((check) => ({
          name: check.name,
          status: check.status === "failed" ? "failed" : check.status === "passed" ? "passed" : "blocked",
          notes: [check.detail]
        })),
        nextAction: commandRequests.length
          ? "Run the selected command through Rust and inspect the terminal result."
          : recommendation?.preview
            ? "Open the preview target."
            : "Open the static workspace manually or configure a run script.",
        createdAt: new Date().toISOString()
      } as RunSummary);
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: commandRequests.length
          ? `I selected a run-to-green command and prepared it for approval.\n\nCommand: \`${commandRequests[0]?.command}\`\n\nReasoning summary: ${runToGreen.selectedCommands[0]?.reason ?? "Selected from grounded workspace signals."}`
          : createNoGroundedRunCommandMessage(message, recommendation?.preview?.target, runToGreen.blockerReason)
      });
      await this.updateStage(
        sessionId,
        commandRequests.length ? "APPROVAL" : "DONE",
        "reviewing",
        commandRequests.length ? "completed" : "completed",
        "Run-to-green command",
        runToGreen.selectedCommands[0]?.reason
          ?? (recommendation?.preview ? "No grounded command was found, but a preview is available." : runToGreen.blockerReason)
          ?? "No run-to-green command inferred."
      );
      return this.requireSession(sessionId);
    }

    const plan = await this.createPlan(session, executionMessage, snapshot, options.resolvedMode);
    const modulePlan =
      shouldTreatProjectAsExisting(intake.projectKind)
        ? buildModuleExecutionPlan({
            sessionId,
            workspaceRoot: session.workspacePath,
            objective: executionMessage,
            createdAt: new Date().toISOString(),
            intake,
            contextPack: intake.contextPack,
            targetFiles: plan.tasks.flatMap((task) => task.targetFiles ?? []),
            suggestedCommands: plan.suggestedCommands?.map((item) => item.command) ?? []
          })
        : undefined;
    await this.applyPlanState(sessionId, plan, modulePlan);
    await this.addArtifact(sessionId, "plan", "Run plan", plan.summary, {
      plan,
      preset: options.resolvedMode
    });
    if (plan.planSource === "operator_supplied") {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.reasoningSummaries.push("Plan source: operator_supplied");
      });
      await this.addDecisionRecord(sessionId, {
        category: "decision",
        finding: "The user supplied an explicit structured implementation plan.",
        decision: "Use the operator-supplied plan for planning and keep provider/schema gates for patch generation.",
        rationaleSummary: plan.reasoningSummary,
        evidenceRefs: [],
        linkedFiles: plan.tasks.flatMap((task) => task.targetFiles ?? []).slice(0, 8),
        uncertainty: plan.risks[0],
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
    }
    if (plan.fallbackWarning) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.reasoningSummaries.push(plan.fallbackWarning!);
      });
      await this.addDecisionRecord(sessionId, {
        category: "risk",
        finding: "Model returned malformed structured output.",
        decision: "Use the deterministic fallback plan instead of failing the run.",
        rationaleSummary: plan.fallbackWarning,
        evidenceRefs: [],
        linkedFiles: snapshot.importantFiles.slice(0, 4),
        uncertainty: plan.fallbackWarning,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
    }
    if (modulePlan) {
      await this.addIntent(sessionId, "module.plan.requested", modulePlan.title, modulePlan.rationale, {
        modulePlanId: modulePlan.id,
        ownedPaths: modulePlan.ownedPaths,
        cautionPaths: modulePlan.cautionPaths,
        forbiddenPaths: modulePlan.forbiddenPaths
      }, "executed");
      await this.addArtifact(sessionId, "module_plan", modulePlan.title, modulePlan.rationale, {
        modulePlan
      });
      await this.addDecisionRecord(sessionId, {
        category: "decision",
        finding: "Existing-project continuation was narrowed to a scoped module execution plan.",
        decision: `Use the module plan "${modulePlan.title}" as the edit boundary before proposing changes.`,
        rationaleSummary: modulePlan.rationale,
        evidenceRefs: modulePlan.relevantFiles.slice(0, 4).map((file) => ({
          type: "file" as const,
          path: file,
          category: "module-plan",
          reason: "Scoped file selected for module continuation."
        })),
        linkedFiles: modulePlan.relevantFiles,
        uncertainty: modulePlan.unknowns[0],
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex", ...plan.tasks.map((_task, index) => `agent_task_${index + 1}`)]
      });
    }
    await this.addDecisionRecord(sessionId, {
      category: "decision",
      finding: "The request has enough local evidence to move into planning.",
      decision: `Selected ${runMode} as the local run mode and created a bounded implementation plan.`,
      rationaleSummary: plan.reasoningSummary || plan.summary,
      evidenceRefs: plan.tasks.flatMap((task, index) =>
        (task.targetFiles ?? []).slice(0, 2).map((file) => ({
          type: "file" as const,
          path: file,
          category: "ownership-contract",
          reason: `${task.roleTitle} owns this planned path during the run.`,
          linkedAgentId: `agent_task_${index + 1}`
        }))
      ),
      linkedFiles: plan.tasks.flatMap((task) => task.targetFiles ?? []).slice(0, 8),
      uncertainty: plan.risks[0],
      createdByAgent: "Local Run",
      createdByAgentId: "agent_local_codex",
      linkedAgentIds: ["agent_local_codex", ...plan.tasks.map((_task, index) => `agent_task_${index + 1}`)]
    });
    for (const [index, risk] of plan.risks.entries()) {
      await this.recordAgentRisk(sessionId, "agent_local_codex", {
        id: randomId("risk"),
        agentId: "agent_local_codex",
        lifecycleArea: "planning",
        severity: "medium",
        reason: risk,
        mitigation: "Keep the run gated and verify before apply.",
        status: "open"
      });
      await this.addDecisionRecord(sessionId, {
        category: "risk",
        finding: "A planning risk was recorded before implementation.",
        decision: "Keep the run bounded and surface the risk in the operator console.",
        rationaleSummary: risk,
        evidenceRefs: [],
        linkedFiles: [],
        uncertainty: risk,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
      if (index >= 1) break;
    }
    await this.updateStage(sessionId, "PLAN", "planning", "completed", "Plan", plan.reasoningSummary || plan.summary);
    await this.updateRunPhase(sessionId, "split_agents", "completed", `Prepared ${plan.tasks.length} work item(s) for the local run.`, plan.tasks.length);

    const singleFilePygameRequest = isSingleFilePythonPygameRequest(executionMessage, snapshot);
    const explicitAgentCount = inferExplicitAgentCount(executionMessage);
    if (singleFilePygameRequest && explicitAgentCount !== null && explicitAgentCount >= 3) {
      const confirmMessage =
        "This request targets a single Python file, but you explicitly asked for 3 agents. Running multiple agents against one file can create conflicting edits. Continue with 3 agents and merge into one file, or switch to a simpler workflow first.";
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = { kind: "confirm_plan", message: confirmMessage };
        draft.reasoningSummaries.push(
          "Single-file Python game requested with an explicit 3-agent workflow; plan confirmation is required before implementation."
        );
      });
      await this.addArtifact(sessionId, "summary", "Plan review required", confirmMessage, {
        reason: "multi_agent_single_file_conflict",
        explicitAgentCount,
        targetShape: "single_python_file"
      });
      await this.addDecisionRecord(sessionId, {
        category: "risk",
        finding: "The request asks for multiple agents to edit a single Python file.",
        decision: "Pause before implementation and require plan confirmation instead of collapsing the workflow automatically.",
        rationaleSummary: confirmMessage,
        evidenceRefs: [],
        linkedFiles: plan.tasks.flatMap((task) => task.targetFiles ?? []).slice(0, 4),
        uncertainty: "A single-file merge may create overlapping edits or regressions without operator confirmation.",
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex", ...plan.tasks.map((_task, index) => `agent_task_${index + 1}`)]
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: [
          "Plan review required before implementation.",
          "",
          "You asked for 3 agents, but the target is a single Python file for a Pygame game.",
          "",
          "Options:",
          "1. Continue with 3 agents and merge their work into one final file.",
          "2. Simplify the workflow before implementation.",
          "",
          "Tell me to continue when you want to proceed."
        ].join("\n")
      });
      await this.updateRunPhase(
        sessionId,
        "review_final_diff",
        "active",
        "Plan confirmation is required because multiple agents were requested for a single Python file."
      );
      await this.updateRunPhase(
        sessionId,
        "final_report",
        "active",
        "Waiting for plan confirmation before generating a single-file implementation."
      );
      return this.requireSession(sessionId);
    }

    if (plan.mode === "inspect_only") {
      return this.runInspectExplainTurn(sessionId, message, options.projectMap, intake, conversationUnderstanding);
    }

    if (options.thinkFirst) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = { kind: "confirm_plan", message: "Plan is ready. Want me to proceed with implementation?" };
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
          content: formatPlanModeMessage(plan, executionMessage)
      });
      await this.updateRunPhase(sessionId, "review_final_diff", "active", "Plan is waiting for operator confirmation before implementation.");
      return this.requireSession(sessionId);
    }

    await this.updateStage(sessionId, "EXECUTION_DRAFT", "working", "running", "Draft changes", "Preparing reviewable patch and command intents.");
    await this.updateRunPhase(sessionId, "agents_running", "active", "Preparing bounded edits, evidence, and verification intents.");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      if (draft.moduleExecutionPlan) {
        draft.moduleExecutionPlan.status = "running";
        draft.moduleExecutionPlan.updatedAt = new Date().toISOString();
      }
    });
    const patchIntentModel = await this.createPatchIntent(session, executionMessage, snapshot, plan);
    await this.syncProviderTelemetry(sessionId);
    if (!patchIntentModel.intents.length) {
      const summary = patchIntentModel.summary || "I could not generate a safe file change from the provider output.";
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.reasoningSummaries.push(patchIntentModel.fallbackWarning ?? summary);
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: [
          "I could not produce a file change for that request.",
          "",
          summary,
          "",
          "Try a smaller edit, name the exact target file, or switch to a stronger configured provider."
        ].join("\n")
      });
      const verification = await this.createVerification(sessionId, summary, [
        { name: "Patch intent", status: "failed", detail: patchIntentModel.fallbackWarning ?? summary }
      ]);
      await this.finish(sessionId, "failed", "FAILED", {
        status: "failed",
        summary,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: [
          ...planningProviderGatesForPlan(plan),
          ...verification.checks.map((check) => ({ name: check.name, status: "failed" as const, notes: [check.detail] }))
        ],
        nextAction: "Retry with a smaller request or name the exact file and content to write.",
        createdAt: new Date().toISOString()
      });
      return this.requireSession(sessionId);
    }
    if (patchIntentModel.fallbackWarning) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.reasoningSummaries.push(patchIntentModel.fallbackWarning!);
        draft.taskState.version += 1;
        draft.taskState.transitions.push({
          id: randomId("transition"),
          phase: "planning",
          type: "plan.updated",
          detail: patchIntentModel.fallbackWarning!,
          createdAt: new Date().toISOString()
        });
      });
      const isExplicitFileWriteFallback = patchIntentModel.fallbackKind === "simple_file_request";
      await this.addArtifact(sessionId, "summary", isExplicitFileWriteFallback ? "Explicit file write fallback" : "Patch generation fallback", patchIntentModel.fallbackWarning, {
        fallbackKind: patchIntentModel.fallbackKind ?? "generic",
        targetFiles: patchIntentModel.intents.map((intent) => intent.path)
      });
      await this.addDecisionRecord(sessionId, {
        category: "risk",
        finding: "Provider patch output was invalid for the requested implementation.",
        decision: isExplicitFileWriteFallback
          ? "Use only the exact file path and content provided by the user."
          : "Do not invent an implementation when patch generation is unavailable.",
        rationaleSummary: patchIntentModel.fallbackWarning,
        evidenceRefs: [],
        linkedFiles: patchIntentModel.intents.map((intent) => intent.path).slice(0, 4),
        uncertainty: patchIntentModel.fallbackWarning,
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
    }
    const patchInput = compilePatchProposalInput(session.workspacePath, tools, patchIntentModel);
    const patch = tools.patch.propose(patchInput, sessionId);
    const validation = tools.patch.validate(patch);
    if (!validation.valid) {
      const verification = await this.createVerification(sessionId, "Patch validation failed before approval.", [
        { name: "Patch path validation", status: "failed", detail: validation.errors.join("; ") }
      ]);
      await this.finish(sessionId, "failed", "FAILED", {
        status: "failed",
        summary: "Patch validation failed before any file was changed.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [patch.id],
        commandResults: [],
        gates: verification.checks.map((check) => ({ name: check.name, status: "failed", notes: [check.detail] })),
        createdAt: new Date().toISOString()
      });
      return this.requireSession(sessionId);
    }

    await this.addIntent(sessionId, "patch.proposed", patch.title, patch.summary, { patchId: patch.id, files: patch.filesChanged }, "proposed");
    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.addArtifact(sessionId, "diff", patch.title, patch.summary, { patchId: patch.id, unifiedDiff: patch.unifiedDiff, filesChanged: patch.filesChanged });
    const currentModulePlan = this.requireSession(sessionId).moduleExecutionPlan;
    const scopeValidation = currentModulePlan
      ? validatePatchAgainstModulePlan(currentModulePlan, patch, tools.workspace)
      : undefined;
    if (scopeValidation) {
      await this.addIntent(sessionId, "scope.validation.requested", "Module scope validation", `Validated ${patch.filesChanged.length} changed file(s) against the module plan.`, {
        patchId: patch.id,
        verdict: scopeValidation.verdict,
        reasons: scopeValidation.reasons
      }, scopeValidation.verdict === "blocked" ? "blocked" : "executed");
    }
    await this.addDecisionRecord(sessionId, {
      category: "decision",
      finding: "A reviewable patch proposal is available.",
      decision: "Stop before writing files and route the change through Rust approval/apply authority.",
      rationaleSummary: patch.summary,
      evidenceRefs: patch.filesChanged.map((file) => ({
        type: "file" as const,
        path: file.path,
        category: "patch-file",
        reason: file.explanation,
        linkedAgentId: findOwningAgentId(this.requireSession(sessionId), file.path)
      })).slice(0, 8),
      linkedFiles: patch.filesChanged.map((file) => file.path),
      uncertainty: patch.riskLevel === "high" ? "High-risk patch proposal; verify carefully before apply." : undefined,
      createdByAgent: "Local Run",
      createdByAgentId: "agent_local_codex",
      linkedAgentIds: uniqueStrings(["agent_local_codex", ...patch.filesChanged.map((file) => findOwningAgentId(this.requireSession(sessionId), file.path)).filter(Boolean) as string[]])
    });
    if (scopeValidation) {
      await this.addDecisionRecord(sessionId, {
        category: scopeValidation.verdict === "blocked" ? "risk" : "decision",
        finding: `Patch scope validation returned ${scopeValidation.verdict}.`,
        decision:
          scopeValidation.verdict === "blocked"
            ? "Do not allow apply approval until the patch is brought back inside the module scope."
            : scopeValidation.verdict === "needs_review"
              ? "Keep the patch review-gated because it touches cautionary or approval-sensitive areas."
              : "Patch changes are inside the scoped module boundary.",
        rationaleSummary: scopeValidation.reasons[0] ?? "Module scope validation completed without extra concerns.",
        evidenceRefs: patch.filesChanged.slice(0, 4).map((file) => ({
          type: "file" as const,
          path: file.path,
          category: "scope-validation",
          reason: "Validated against module execution scope."
        })),
        linkedFiles: patch.filesChanged.map((file) => file.path),
        uncertainty: scopeValidation.reasons[1],
        createdByAgent: "Local Run",
        createdByAgentId: "agent_local_codex",
        linkedAgentIds: ["agent_local_codex"]
      });
    }
    await this.updateRunPhase(sessionId, "integrate_changes", "completed", `Prepared ${patch.filesChanged.length} file change(s) for review.`, patch.filesChanged.length);

    const commandRequests = createCommandRequests(sessionId, session.workspacePath, patchIntentModel.suggestedCommands ?? plan.suggestedCommands ?? [], snapshot.testCommands, {
      fullAccess: session.accessProfile === "full_access"
    });
    for (const request of commandRequests) {
      await this.addIntent(sessionId, "command.requested", request.command, request.reason, { commandRequestId: request.id, risk: request.risk }, request.status === "blocked" ? "blocked" : "proposed");
      await this.sessionManager.addCommandRequest(sessionId, request);
    }

    const verification = await this.createVerification(sessionId, "Verification is pending until the approved patch is applied and commands run in Rust.", [
      { name: "Patch proposal", status: "passed", detail: `${patch.filesChanged.length} file(s) proposed for review.` },
      { name: "Rust apply", status: "pending", detail: "Waiting for explicit apply approval." },
      { name: "Post-verify", status: "pending", detail: commandRequests[0]?.command ?? "No validation command selected yet." }
    ]);
    await this.addIntent(sessionId, "validation.requested", "Post-verify", verification.summary, { verificationId: verification.id }, "proposed");
    await this.updateRunPhase(sessionId, "run_verification", "active", verification.summary, verification.checks.length);

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPROVAL";
      const providerTelemetry = this.options.providerTelemetry?.snapshot();
      if (providerTelemetry) draft.providerTelemetry = providerTelemetry;
      draft.reasoningSummaries.push(plan.reasoningSummary);
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.orchestration.validationGateResult = {
        id: randomId("validation_gate"),
        sessionId,
        status: "passed",
        blockingReasons: [],
        notes: ["Patch proposal passed runtime-side validation and is waiting for Rust apply."],
        createdAt: new Date().toISOString()
      };
      updateAgentRunRecord(draft, "agent_local_codex", (agent) => {
        agent.lifecycleStage = "APPROVAL";
        agent.currentAction = "Waiting for operator review before Rust applies files and runs commands.";
        agent.currentTask = patch.title;
        agent.commandsRun = commandRequests.map((request) => request.command);
        agent.evidenceRefs = mergeEvidenceRefs(agent.evidenceRefs, patch.filesChanged.map((file) => ({
          type: "file",
          path: file.path,
          category: "patch-file",
          reason: file.explanation,
          linkedAgentId: "agent_local_codex"
        })));
        appendAgentJournalEntry(agent, {
          kind: "proposed_patch",
          title: patch.title,
          summary: `Prepared ${patch.filesChanged.length} reviewable file change(s).`,
          filePath: patch.filesChanged[0]?.path,
          severity: patch.riskLevel,
          status: "completed"
        });
        for (const request of commandRequests) {
          appendAgentJournalEntry(agent, {
            kind: "command_requested",
            title: request.command,
            summary: `Queued verification command: ${request.command}`,
            command: request.command,
            status: request.status === "blocked" ? "blocked" : "queued"
          });
        }
      });
      distributePatchTelemetry(draft, patch, commandRequests);
      if (patch.riskLevel !== "low") {
        attachPatchRiskToOwningAgents(draft, patch);
      }
      draft.latestScopeValidation = scopeValidation;
      if (draft.moduleExecutionPlan) {
        draft.moduleExecutionPlan.status = scopeValidation?.verdict === "blocked" ? "blocked" : "running";
        draft.moduleExecutionPlan.updatedAt = new Date().toISOString();
      }
      draft.reviewGate = createPendingReviewGate(draft, verification, patch, commandRequests, scopeValidation);
    });

    const summary = withPlanningProviderGates(createRunSummary(this.requireSession(sessionId), verification), plan);
    await this.updateRunPhase(
      sessionId,
      "review_final_diff",
      scopeValidation?.verdict === "blocked" ? "blocked" : "active",
      scopeValidation?.verdict === "blocked"
        ? "Review gate blocked apply because the patch left the scoped module boundary."
        : "Review the proposed diff and queued verification before apply."
    );
    await this.updateRunPhase(
      sessionId,
      "final_report",
      scopeValidation?.verdict === "blocked" ? "blocked" : "active",
      scopeValidation?.verdict === "blocked"
        ? "Run is blocked on scope review before Rust authority actions."
        : "Run is waiting for review and Rust authority actions."
    );
    await this.sessionManager.setRunSummary(sessionId, summary);
    const moduleSummary = summarizeModuleExecution(this.requireSession(sessionId), verification);
    if (moduleSummary) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.moduleExecutionSummaries ??= [];
        const existingIndex = draft.moduleExecutionSummaries.findIndex((entry) => entry.id === moduleSummary.id);
        if (existingIndex >= 0) {
          draft.moduleExecutionSummaries[existingIndex] = moduleSummary;
        } else {
          draft.moduleExecutionSummaries.push(moduleSummary);
        }
      });
      await this.addArtifact(sessionId, "module_execution_summary", moduleSummary.title, moduleSummary.summary, {
        moduleSummary
      });
    }
    await this.updateStage(sessionId, "APPROVAL", "reviewing", "completed", "Approval", "Review changes, then apply through Rust.");
    return this.requireSession(sessionId);
  }

  private async runInspectExplainTurn(
    sessionId: string,
    message: string,
    projectMap: ProjectMap,
    intake: ReturnType<typeof buildProjectIntake>,
    conversationUnderstanding?: ConversationUnderstanding
  ): Promise<AgentRuntimeSession> {
    const session = this.requireSession(sessionId);
    const tools = new ToolRegistry(session.workspacePath);
    const enrichedProjectMap = createProjectMapFromIntake(projectMap, intake);
    const understanding = conversationUnderstanding ?? createConversationUnderstanding(message);
    const intent = understanding.workspaceIntent ?? inferWorkspaceIntent(message);
    const progressCopy = createLocalRunProgressCopy(message);

    await this.updateStage(sessionId, "PLAN", "planning", "running", progressCopy.questionMode.title, progressCopy.questionMode.summary);
    await this.updateStage(sessionId, "CONTEXT_GATHER", "inspecting", "running", progressCopy.evidenceReportStart.title, progressCopy.evidenceReportStart.summary, enrichedProjectMap.importantFiles.slice(0, 6));

    const explainReport = buildLargeProjectExplainReport({
      workspacePath: session.workspacePath,
      message,
      projectMap: enrichedProjectMap,
      intake,
      conversationUnderstanding: understanding
    });
    await this.updateStage(
      sessionId,
      "CONTEXT_GATHER",
      "inspecting",
      "completed",
      progressCopy.evidenceReportStart.title,
      progressCopy.arabic
        ? `ليه الخطوة دي: بنيت تقرير أدلة من ${explainReport.contextPack.inventory.scannedFiles} ملف ممسوح و${explainReport.moduleMap.length} موديول.`
        : `Why this step: built an evidence report from ${explainReport.contextPack.inventory.scannedFiles} scanned files and ${explainReport.moduleMap.length} module(s).`,
      explainReport.entryPoints.slice(0, 6)
    );

    await this.updateStage(sessionId, "CONTEXT_GATHER", "inspecting", "running", progressCopy.workspaceReadingStart.title, progressCopy.workspaceReadingStart.summary, explainReport.evidence.slice(0, 6).map((item) => item.path));

    const questionResult = await answerUniversalProjectQuestion({
      provider: this.provider,
      userPrompt: understanding.workspaceMessage || message,
      tools,
      explainReport,
      intent,
      embeddingModel: session.providerConfig?.embeddingModel
        ?? process.env.HIVO_EMBEDDING_MODEL
        ?? (session.providerConfig?.providerType === "ollama" ? process.env.OLLAMA_EMBEDDING_MODEL : process.env.OPENAI_EMBEDDING_MODEL)
    });
    await this.updateStage(
      sessionId,
      "CONTEXT_GATHER",
      "inspecting",
      "completed",
      progressCopy.workspaceReadingStart.title,
      progressCopy.arabic
        ? `ليه الخطوة دي: فتحت ${questionResult.openedFiles.length} ملف وراجعت ${questionResult.candidateFiles.length} مرشح متعلق بالسؤال.`
        : `Why this step: opened ${questionResult.openedFiles.length} file(s) and checked ${questionResult.candidateFiles.length} candidate(s) related to the question.`,
      questionResult.openedFiles.slice(0, 8)
    );
    const initialDecisionPipeline = session.latestDecisionPipeline;
    if (!initialDecisionPipeline) {
      throw new Error("reasoning_kernel.initial_decision_pipeline_required");
    }
    let decisionPipeline = await finalizeAnswerDecisionPipeline({
      state: initialDecisionPipeline,
      provider: this.provider,
      answerMarkdown: questionResult.answerMarkdown,
      evidenceRefs: questionResult.evidenceRefs,
      validationErrors: questionResult.validationErrors,
      finalAnswerSource: "provider",
      confidence: questionResult.confidence
    });
    if (questionResult.projectUnderstanding) {
      decisionPipeline = applyProjectUnderstandingDecisionPipeline(decisionPipeline, questionResult.projectUnderstanding);
    }
    if (questionResult.fallbackUsed) {
      throw new Error(`provider_only_answer_required: ${questionResult.fallbackReason ?? "local answer synthesis attempted"}`);
    }
    const answerMarkdown = addWorkspaceIdentityBanner(questionResult.answerMarkdown, session.workspacePath);
    const validationErrors = questionResult.validationErrors;
    const evidenceRefs = questionResult.evidenceRefs;
    const providerTelemetry = this.options.providerTelemetry?.snapshot();
    const evidenceReport = questionResult.evidenceReport;
    const answerContract = {
      answerStrategy: questionResult.answerStrategy,
      finalResponseSource: "provider",
      providerRequestRefs: providerTelemetry?.providerRequestRefs ?? [],
      reasoningAttempts: providerTelemetry?.reasoningAttempts ?? 0,
      repairAttempts: providerTelemetry?.repairAttempts ?? 0,
      providerTimeoutInvolved: Boolean(providerTelemetry?.providerTimeoutCount),
      providerRequestCount: providerTelemetry?.providerRequestCount ?? 0,
      providerResponseCount: providerTelemetry?.providerResponseCount ?? 0,
      finalEvidenceFilesActuallyUsed: evidenceReport.finalEvidenceFilesActuallyUsed,
      generatedArtifactsExcluded: evidenceReport.generatedEvidenceExcludedCount > 0
    };
    await this.updateStage(
      sessionId,
      "SELF_REVIEW",
      "reviewing",
      "completed",
      progressCopy.evidenceValidation.title,
      progressCopy.arabic
        ? `ليه الخطوة دي: قبلت ${evidenceReport.finalEvidenceFilesActuallyUsed.length} ملف دليل واستبعدت ${evidenceReport.generatedEvidenceExcludedCount} مرشح generated/runtime.`
        : `Why this step: accepted ${evidenceReport.finalEvidenceFilesActuallyUsed.length} evidence file(s) and excluded ${evidenceReport.generatedEvidenceExcludedCount} generated/runtime candidate(s).`,
      evidenceReport.finalEvidenceFilesActuallyUsed.slice(0, 8)
    );
    await this.updateStage(
      sessionId,
      "EXECUTION_DRAFT",
      "working",
      "completed",
      progressCopy.answerDraft.title,
      progressCopy.arabic
        ? "جهزت رد المزوّد بعد ما عدى تحقق الأدلة."
        : "Drafted the provider-authored answer after it passed evidence validation.",
      evidenceRefs.slice(0, 8).map((ref) => ref.replace(/:\d+$/, ""))
    );
    await this.updateStage(sessionId, "DONE", "completed", "running", progressCopy.finalReport.title, progressCopy.finalReport.summary, evidenceReport.finalEvidenceFilesActuallyUsed.slice(0, 8));

    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.explainReport = createSessionExplainReportSummary(questionResult.augmentedReport);
      draft.providerTelemetry = providerTelemetry;
      draft.evidenceReport = createSessionEvidenceTruthReportSummary(evidenceReport);
      draft.latestDecisionPipeline = decisionPipeline;
      draft.decisionPipelineHistory ??= [];
      const pipelineIndex = draft.decisionPipelineHistory.findIndex((entry) => entry.id === decisionPipeline.id);
      if (pipelineIndex >= 0) draft.decisionPipelineHistory[pipelineIndex] = decisionPipeline;
      else draft.decisionPipelineHistory.push(decisionPipeline);
    });

    await this.addArtifact(sessionId, "project_explain_report", "Project explain report", questionResult.augmentedReport.overview, {
      explainReport: questionResult.augmentedReport,
      intent,
      topic: questionResult.topic,
      questionUnderstanding: questionResult.questionUnderstanding,
      queryPlan: questionResult.queryPlan,
      searchIterations: questionResult.searchIterations,
      candidateFiles: questionResult.candidateFiles,
      openedFiles: questionResult.openedFiles,
      evidenceRefs,
      negativeEvidence: questionResult.negativeEvidence,
      suppressedNegativeQueries: questionResult.suppressedNegativeQueries,
      targetConcept: questionResult.questionUnderstanding.targetConcept,
      requestedFacets: questionResult.questionUnderstanding.requestedFacets,
      conceptResolution: questionResult.conceptResolution,
      evidenceBuckets: questionResult.evidenceBuckets,
      targetEvidenceValidation: questionResult.targetEvidenceValidation,
      literalSearch: questionResult.literalSearch,
      aliasSearch: questionResult.aliasSearch,
      behavioralSearch: questionResult.behavioralSearch,
      architecturalPatternSearch: questionResult.architecturalPatternSearch,
      rejectedGeneralEvidence: questionResult.rejectedGeneralEvidence,
      userVisibleNegativeEvidence: questionResult.userVisibleNegativeEvidence,
      projectIntelligenceGraphSummary: questionResult.projectIntelligenceGraphSummary,
      mechanismChain: questionResult.mechanismChain,
      mechanismEvidence: questionResult.mechanismEvidence,
      mechanismCoverageValidation: questionResult.mechanismCoverageValidation,
      statusOnlyEvidence: questionResult.statusOnlyEvidence,
      contextOnlyEvidence: questionResult.contextOnlyEvidence,
      testEndpointExpectations: questionResult.testEndpointExpectations,
      targetScopedStorageEvidence: questionResult.targetScopedStorageEvidence,
      generalStorageEvidence: questionResult.generalStorageEvidence,
      mechanismExpansionTrace: questionResult.mechanismExpansionTrace,
      rejectedMechanismEvidence: questionResult.rejectedMechanismEvidence,
      missingMechanismLinks: questionResult.missingMechanismLinks,
      graphExpansionTrace: questionResult.graphExpansionTrace,
      implementationEvidence: questionResult.implementationEvidence,
      evidenceGroups: questionResult.evidenceGroups,
      canonicalActions: questionResult.canonicalActions,
      artifactPreparationEvidence: questionResult.artifactPreparationEvidence,
      evidenceRoles: questionResult.evidenceRoles,
      semanticEvidenceRoles: questionResult.semanticEvidenceRoles,
      suppressedEvidence: questionResult.suppressedEvidence,
      conceptFlow: questionResult.conceptFlow,
      coverageValidation: questionResult.coverageValidation,
      roleClassificationValidation: questionResult.roleClassificationValidation,
      languageValidation: questionResult.languageValidation,
      dedupeValidation: questionResult.dedupeValidation,
      outputCleanupValidation: questionResult.outputCleanupValidation,
      cleanedOutputs: questionResult.cleanedOutputs,
      structuredFacts: questionResult.structuredFacts,
      detailLevel: questionResult.questionUnderstanding.detailLevel,
      wantsCodeExamples: questionResult.questionUnderstanding.wantsCodeExamples,
      wantsComparisons: questionResult.questionUnderstanding.wantsComparisons,
      answerShapeValidation: questionResult.answerShapeValidation,
      validationErrors,
      finalResponseSource: "provider",
      answerStrategy: questionResult.answerStrategy,
      confidence: questionResult.confidence,
      concept_resolution: questionResult.conceptResolution,
      investigation_graph: questionResult.projectIntelligenceGraph,
      mechanism_chain: questionResult.mechanismChain,
      evidence_tiers: questionResult.evidenceTiers,
      readLaneRun: questionResult.readLaneRun,
      readLaneArtifacts: questionResult.readLaneArtifacts,
      laneSynthesizedGraph: questionResult.laneSynthesizedGraph,
      evidenceReview: questionResult.evidenceReview,
      providerTelemetry,
      evidenceReport,
      answerContract
    });

    await this.addArtifact(sessionId, "concept_resolution", "Concept resolution", `${questionResult.questionUnderstanding.targetConcept}: ${questionResult.conceptResolution.resolutionStatus}`, {
      concept_resolution: questionResult.conceptResolution,
      investigationConceptResolution: questionResult.investigationConceptResolution
    });

    await this.addArtifact(sessionId, "investigation_graph", "Investigation graph", `${questionResult.projectIntelligenceGraph.summary.evidenceCount} evidence item(s), ${questionResult.projectIntelligenceGraph.summary.edgeCount} edge(s).`, {
      investigation_graph: questionResult.projectIntelligenceGraph,
      projectIntelligenceGraphSummary: questionResult.projectIntelligenceGraphSummary
    });

    await this.addArtifact(sessionId, "mechanism_chain", "Mechanism chain", `${questionResult.mechanismChain.status} with ${questionResult.mechanismChain.steps.length} link(s).`, {
      mechanism_chain: questionResult.mechanismChain,
      mechanismCoverageValidation: questionResult.mechanismCoverageValidation,
      missingMechanismLinks: questionResult.missingMechanismLinks
    });

    await this.addArtifact(sessionId, "evidence_tiers", "Evidence tiers", `${questionResult.evidenceTiers.directTargetEvidence.length} direct, ${questionResult.evidenceTiers.architecturalPatternEvidence.length} architectural evidence item(s).`, {
      evidence_tiers: questionResult.evidenceTiers,
      rejectedGeneralEvidence: questionResult.rejectedGeneralEvidence,
      userVisibleNegativeEvidence: questionResult.userVisibleNegativeEvidence,
      evidenceReport
    });

    if (questionResult.projectUnderstanding) {
      await this.addArtifact(sessionId, "question_decomposition", "Question decomposition", `${questionResult.projectUnderstanding.decomposition.concepts.length} concept(s) and ${questionResult.projectUnderstanding.decomposition.requiredRelationships.length} required relationship(s).`, {
        decomposition: questionResult.projectUnderstanding.decomposition
      });
      await this.addArtifact(sessionId, "claim_ledger", "Claim ledger", `${questionResult.projectUnderstanding.claimLedger.supportedMaterialClaims} supported and ${questionResult.projectUnderstanding.claimLedger.unsupportedMaterialClaims} unsupported material claim(s).`, {
        claimLedger: questionResult.projectUnderstanding.claimLedger
      });
      await this.addArtifact(sessionId, "project_understanding", "Project understanding", `${questionResult.projectUnderstanding.mode}/${questionResult.projectUnderstanding.decision}; ${questionResult.projectUnderstanding.repairIterations} repair iteration(s).`, {
        projectUnderstanding: questionResult.projectUnderstanding
      });
    }

    if (providerTelemetry) {
      await this.addArtifact(sessionId, "provider_truth", "Provider truth", describeProviderTruth(providerTelemetry), {
        providerTelemetry,
        answerContract
      });
    }

    await this.addArtifact(sessionId, "evidence_report", "Evidence report", `${evidenceReport.finalEvidenceFilesActuallyUsed.length} evidence file(s) used, ${evidenceReport.generatedEvidenceExcludedCount} generated/runtime candidate(s) excluded.`, {
      evidenceReport
    });

    await this.addArtifact(sessionId, "answer_verification", "Answer verification", `${decisionPipeline.verification?.status ?? "unavailable"}; final action ${decisionPipeline.outcome?.action ?? "REFUSE"}.`, {
      verification: decisionPipeline.verification,
      decisionPipelineId: decisionPipeline.id
    });

    await this.addArtifact(sessionId, "final_decision", "Final decision", `${decisionPipeline.outcome?.action ?? "REFUSE"}: ${decisionPipeline.outcome?.reason ?? "No decision reason recorded."}`, {
      outcome: decisionPipeline.outcome,
      decisionPipelineId: decisionPipeline.id
    });

    const verification = await this.createVerification(sessionId, "Read-only project explanation completed.", [
      { name: "Workspace inventory", status: "passed", detail: `Scanned ${questionResult.augmentedReport.contextPack.inventory.scannedFiles} file(s), ignored ${questionResult.augmentedReport.contextPack.inventory.ignoredDirectories.length} generated/vendor folder(s).` },
      { name: "Inspect read lanes", status: "passed", detail: `Ran ${questionResult.readLaneArtifacts.length} read lane(s); synthesized graph is ${questionResult.laneSynthesizedGraph.status} with ${questionResult.laneSynthesizedGraph.provenLinks.length} proven link(s) and ${questionResult.laneSynthesizedGraph.missingLinks.length} missing link(s).` },
      { name: "Universal evidence search", status: "passed", detail: `Ran ${questionResult.searchIterations.length} bounded search iteration(s), opened ${questionResult.openedFiles.length} file(s), collected ${questionResult.positiveEvidence.length} evidence item(s).` },
      { name: "Evidence hygiene", status: "passed", detail: `Used ${evidenceReport.finalEvidenceFilesActuallyUsed.length} final evidence file(s); excluded ${evidenceReport.generatedEvidenceExcludedCount} generated/runtime candidate(s).` },
      { name: "Module map", status: "passed", detail: `Mapped ${questionResult.augmentedReport.moduleMap.length} module(s) with ${questionResult.augmentedReport.contextPack.readBudget.sampledFiles} sampled file(s).` },
      { name: "Provider truth", status: "passed", detail: providerTelemetry ? describeProviderTruth(providerTelemetry) : "Provider telemetry was not attached to this RunEngine invocation." },
      { name: "Evidence-grounded answer", status: "passed", detail: "Generated by the configured provider from the evidence report." },
      { name: "Patch required", status: "passed", detail: "No patch was required for this request." }
    ]);

    await this.addArtifact(sessionId, "project_explain_answer", "Project explanation", answerMarkdown.slice(0, 500), {
      answerMarkdown,
      intent,
      topic: questionResult.topic,
      questionUnderstanding: questionResult.questionUnderstanding,
      queryPlan: questionResult.queryPlan,
      searchIterations: questionResult.searchIterations,
      candidateFiles: questionResult.candidateFiles,
      openedFiles: questionResult.openedFiles,
      evidenceRefs,
      negativeEvidence: questionResult.negativeEvidence,
      suppressedNegativeQueries: questionResult.suppressedNegativeQueries,
      targetConcept: questionResult.questionUnderstanding.targetConcept,
      requestedFacets: questionResult.questionUnderstanding.requestedFacets,
      conceptResolution: questionResult.conceptResolution,
      evidenceBuckets: questionResult.evidenceBuckets,
      targetEvidenceValidation: questionResult.targetEvidenceValidation,
      literalSearch: questionResult.literalSearch,
      aliasSearch: questionResult.aliasSearch,
      behavioralSearch: questionResult.behavioralSearch,
      architecturalPatternSearch: questionResult.architecturalPatternSearch,
      rejectedGeneralEvidence: questionResult.rejectedGeneralEvidence,
      userVisibleNegativeEvidence: questionResult.userVisibleNegativeEvidence,
      projectIntelligenceGraphSummary: questionResult.projectIntelligenceGraphSummary,
      mechanismChain: questionResult.mechanismChain,
      mechanismEvidence: questionResult.mechanismEvidence,
      mechanismCoverageValidation: questionResult.mechanismCoverageValidation,
      statusOnlyEvidence: questionResult.statusOnlyEvidence,
      contextOnlyEvidence: questionResult.contextOnlyEvidence,
      testEndpointExpectations: questionResult.testEndpointExpectations,
      targetScopedStorageEvidence: questionResult.targetScopedStorageEvidence,
      generalStorageEvidence: questionResult.generalStorageEvidence,
      mechanismExpansionTrace: questionResult.mechanismExpansionTrace,
      rejectedMechanismEvidence: questionResult.rejectedMechanismEvidence,
      missingMechanismLinks: questionResult.missingMechanismLinks,
      graphExpansionTrace: questionResult.graphExpansionTrace,
      implementationEvidence: questionResult.implementationEvidence,
      evidenceGroups: questionResult.evidenceGroups,
      canonicalActions: questionResult.canonicalActions,
      artifactPreparationEvidence: questionResult.artifactPreparationEvidence,
      evidenceRoles: questionResult.evidenceRoles,
      semanticEvidenceRoles: questionResult.semanticEvidenceRoles,
      suppressedEvidence: questionResult.suppressedEvidence,
      conceptFlow: questionResult.conceptFlow,
      coverageValidation: questionResult.coverageValidation,
      roleClassificationValidation: questionResult.roleClassificationValidation,
      languageValidation: questionResult.languageValidation,
      dedupeValidation: questionResult.dedupeValidation,
      outputCleanupValidation: questionResult.outputCleanupValidation,
      cleanedOutputs: questionResult.cleanedOutputs,
      structuredFacts: questionResult.structuredFacts,
      detailLevel: questionResult.questionUnderstanding.detailLevel,
      wantsCodeExamples: questionResult.questionUnderstanding.wantsCodeExamples,
      wantsComparisons: questionResult.questionUnderstanding.wantsComparisons,
      answerShapeValidation: questionResult.answerShapeValidation,
      validationErrors,
      finalResponseSource: "provider",
      answerStrategy: questionResult.answerStrategy,
      confidence: questionResult.confidence,
      usedEvidenceRefs: evidenceRefs,
      unsupportedOrUnclearParts: validationErrors,
      revisionCount: questionResult.revisionCount,
      validationWarnings: questionResult.validationWarnings,
      grounding: questionResult.grounding,
      concept_resolution: questionResult.conceptResolution,
      investigation_graph: questionResult.projectIntelligenceGraph,
      mechanism_chain: questionResult.mechanismChain,
      evidence_tiers: questionResult.evidenceTiers,
      readLaneRun: questionResult.readLaneRun,
      readLaneArtifacts: questionResult.readLaneArtifacts,
      laneSynthesizedGraph: questionResult.laneSynthesizedGraph,
      evidenceReview: questionResult.evidenceReview,
      providerTelemetry,
      evidenceReport,
      answerContract
    });

    await this.updateStage(
      sessionId,
      "DONE",
      "completed",
      "completed",
      progressCopy.finalReport.title,
      progressCopy.arabic
        ? "ليه الخطوة دي: حفظت تقرير الأدلة والرد النهائي في جلسة التشغيل."
        : "Why this step: saved the evidence report and final answer in the run session.",
      evidenceReport.finalEvidenceFilesActuallyUsed.slice(0, 8)
    );

    await this.finish(sessionId, "completed", "DONE", {
      status: "completed",
      summary: answerMarkdown.slice(0, 500),
      filesChanged: [],
      appliedPatchIds: [],
      proposedPatchIds: [],
      commandResults: [],
      gates: verification.checks.map((check) => ({ name: check.name, status: check.status === "failed" ? "failed" : "passed", notes: [check.detail] })),
      nextAction: "Ask for a concrete edit or creation task when you want code changes.",
      createdAt: new Date().toISOString()
    });

    await this.addDecisionRecord(sessionId, {
      category: questionResult.positiveEvidence.length || questionResult.grounding.decision !== "concept_not_found" ? "finding" : "risk",
      finding: questionResult.grounding.concept.specific
        ? `Requested concept "${questionResult.grounding.concept.label}" was ${questionResult.positiveEvidence.length ? "found by universal local search" : questionResult.grounding.conceptFound ? "found" : "not found"} in current workspace evidence.`
        : "Project answer was grounded in the current workspace evidence report and universal local search.",
      decision: "Use the provider answer because it passed current-workspace evidence validation.",
      rationaleSummary: questionResult.positiveEvidence.length
        ? `Universal search collected ${questionResult.positiveEvidence.length} evidence item(s) across ${questionResult.candidateFiles.length} candidate file(s).`
        : questionResult.grounding.foundInstead,
      evidenceRefs: evidenceRefs.slice(0, 8).map((ref) => {
        const match = ref.match(/^(.+):(\d+)$/);
        return {
          type: "file" as const,
          path: match?.[1] ?? ref,
          lineStart: match?.[2] ? Number(match[2]) : undefined,
          category: "project-explain-grounding",
          reason: "Supported the accepted project explanation."
        };
      }),
      linkedFiles: questionResult.openedFiles.slice(0, 8),
      uncertainty: questionResult.validationErrors[0] ?? questionResult.grounding.unknowns[0],
      createdByAgent: "Local Run",
      createdByAgentId: "agent_local_codex",
      linkedAgentIds: ["agent_local_codex"]
    });

    await this.updateRunPhase(sessionId, "agents_running", "completed", `Read-only explanation completed from evidence report.`);
    await this.updateRunPhase(sessionId, "final_report", "completed", "Inspection-only report is ready.");
    
    this.options.providerTelemetry?.markProviderAuthoredResponse();
    const finalTelemetry = this.options.providerTelemetry?.snapshot();
    if (finalTelemetry) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.providerTelemetry = finalTelemetry;
        if (draft.latestDecisionPipeline) {
          draft.latestDecisionPipeline.finalResponseSource = "provider";
          draft.latestDecisionPipeline.providerRequestRefs = finalTelemetry.providerRequestRefs;
          draft.latestDecisionPipeline.reasoningAttempts = finalTelemetry.reasoningAttempts;
          draft.latestDecisionPipeline.repairAttempts = finalTelemetry.repairAttempts;
        }
      });
    }
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: answerMarkdown,
      providerRequestRefs: this.options.providerTelemetry?.snapshot().providerRequestRefs ?? []
    });
    return this.requireSession(sessionId);
  }

  private async createPlan(session: AgentRuntimeSession, message: string, snapshot: RepoSnapshot, resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">): Promise<RunPlanModel> {
    const prompt = [
      "Create a concise JSON plan for a local coding agent.",
      "Do not include hidden chain-of-thought. Use reasoningSummary for a short user-visible rationale.",
      "Return JSON with: summary, reasoningSummary, mode(create_project|edit_project|inspect_only), tasks, acceptanceCriteria, risks, suggestedCommands.",
      `Runtime preset: ${resolvedMode}`,
      `User request: ${message}`,
      `Unified intent understanding: ${JSON.stringify(snapshot.intentUnderstanding)}`,
      `Workspace snapshot: ${JSON.stringify(snapshot)}`,
      `Project intake: ${JSON.stringify(snapshot.intake)}`,
      `Context pack: ${JSON.stringify(snapshot.contextPack)}`
    ].join("\n");
    const generated = await this.generateStructuredWithRepair<Partial<RunPlanModel>>(
      {
        purpose: "reason",
        systemPrompt: "You are a local coding run planner. Return strict JSON only. Any title field you return must be at most four words.",
        userPrompt: prompt
      },
      runPlanSchema,
      "implementation plan"
    );
    return normalizePlan(generated, message, snapshot);
  }

  private async applyPlanState(sessionId: string, plan: RunPlanModel, modulePlan?: ReturnType<typeof buildModuleExecutionPlan>) {
    const agentPlan = toAgentPlan(plan);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.plan = agentPlan;
      if (modulePlan) {
        draft.moduleExecutionPlan = modulePlan;
      }
      draft.tasks = plan.tasks.map((task, index) => ({
        id: task.id ?? `task_${index + 1}`,
        sessionId,
        title: task.title,
        status: "todo",
        agentRole: task.roleTitle,
        createdAt: new Date().toISOString()
      }));
      const plannedAgents = buildPlannedAgentContracts(sessionId, plan, draft.createdAt, modulePlan);
      for (const plannedAgent of plannedAgents) {
        upsertAgentRunRecord(draft, plannedAgent);
      }
      draft.taskState.phase = "planning";
      draft.taskState.version += 1;
      draft.taskState.transitions.push({
        id: randomId("transition"),
        phase: "planning",
        type: "plan.updated",
        detail: `Plan updated with ${plan.tasks.length} task(s)`,
        createdAt: new Date().toISOString()
      });
    });
  }

  private async createPatchIntent(session: AgentRuntimeSession, message: string, snapshot: RepoSnapshot, plan: RunPlanModel): Promise<RunPatchIntentModel> {
    const relevantFiles = collectRelevantFilesForPatch(snapshot, plan);
    const prompt = [
      "Create a reviewable patch intent as JSON for a local coding agent.",
      "For existing files, do not return full file contents.",
      "Return JSON with: title, summary, intents[{path,operation,anchorText?,preimageText?,replacementText,reason,risk}], suggestedCommands.",
      "Allowed operations: create_file, overwrite_file, replace_range, insert_after, insert_before, delete_range.",
      "Use create_file for new files, overwrite_file only when the user asks to replace a whole file, and focused anchor operations for existing files.",
      "When using replace_range, choose a preimageText snippet that appears exactly once in the current file excerpt.",
      "Respect the scoped module plan. Do not introduce broad edits, duplicate systems, or out-of-scope files.",
      `User request: ${message}`,
      `Unified intent understanding: ${JSON.stringify(snapshot.intentUnderstanding)}`,
      `Plan: ${JSON.stringify(plan)}`,
      `Workspace snapshot: ${JSON.stringify(snapshot)}`,
      `Module plan: ${JSON.stringify(session.moduleExecutionPlan)}`,
      `Relevant file excerpts: ${JSON.stringify(relevantFiles)}`
    ].join("\n");
    const generated = await this.generateStructuredWithRepair<Partial<RunPatchIntentModel>>(
      {
        purpose: "reason",
        systemPrompt: "You produce structured patch intents for unified diff proposals. Return strict JSON only. Any title field you return must be at most four words.",
        userPrompt: prompt
      },
      runPatchIntentSchema,
      "patch intent"
    );
    return normalizePatchIntent(generated, message);
  }

  private async generateStructuredWithRepair<T>(request: LlmRequest, schema: unknown, label: string): Promise<T> {
    let currentRequest = request;
    let errors: string[] = [];
    let lastProviderError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      let generated: T;
      try {
        generated = await invokeReasoningProviderStructured<T>(this.provider, currentRequest, schema);
      } catch (error) {
        lastProviderError = error;
        if (attempt === 3) break;
        currentRequest = {
          purpose: "repair",
          systemPrompt: `Retry the failed ${label} request. Return strict JSON matching the requested schema.`,
          userPrompt: request.userPrompt,
          context: { originalContext: request.context, priorOperationalError: formatProviderError(error) }
        };
        continue;
      }
      const validation = validateStructuredOutput(generated, schema);
      if (validation.valid) return generated;
      errors = validation.errors;
      if (attempt === 3) break;
      currentRequest = {
        purpose: "repair",
        systemPrompt: `Repair the malformed ${label}. Return strict JSON matching the requested schema. Do not replace it with prose.`,
        userPrompt: `Repair the ${label} using the validation errors.`,
        context: {
          originalRequest: request,
          invalidResult: generated,
          validationErrors: validation.errors
        }
      };
    }
    if (lastProviderError && !errors.length) {
      throw new Error(`provider_${label.replaceAll(" ", "_")}_failed_after_retries: ${formatProviderError(lastProviderError)}`);
    }
    throw new Error(`provider_${label.replaceAll(" ", "_")}_invalid_after_repairs: ${errors.join("; ")}`);
  }

  private async createVerification(sessionId: string, summary: string, checks: VerificationResult["checks"]) {
    const status =
      checks.some((check) => check.status === "failed")
        ? "failed"
        : checks.some((check) => check.status === "running" || check.status === "pending")
          ? "pending"
          : checks.some((check) => check.status === "unavailable")
            ? "unavailable"
            : checks.every((check) => check.status === "skipped" || check.status === "not_run")
              ? "skipped"
              : checks.some((check) => check.status === "skipped" || check.status === "not_run")
                ? "skipped"
                : "passed";
    const verification: VerificationResult = {
      id: randomId("verification"),
      sessionId,
      status,
      truthStatus: "unverified",
      summary,
      checks,
      createdAt: new Date().toISOString()
    };
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.addArtifact(sessionId, "verification", "Verification", summary, { verification });
    return verification;
  }

  private async syncProviderTelemetry(sessionId: string) {
    const providerTelemetry = this.options.providerTelemetry?.snapshot();
    if (!providerTelemetry) return;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.providerTelemetry = providerTelemetry;
    });
  }

  private async addIntent(
    sessionId: string,
    type: ToolIntent["type"],
    title: string,
    summary: string,
    payload: Record<string, unknown>,
    status: ToolIntent["status"]
  ) {
    await this.sessionManager.addToolIntent(sessionId, {
      id: randomId("intent"),
      sessionId,
      type,
      title,
      summary,
      payload,
      status,
      createdAt: new Date().toISOString()
    });
  }

  private async addArtifact(sessionId: string, type: Artifact["type"], title: string, summary: string, payload: Record<string, unknown>) {
    await this.sessionManager.addArtifact(sessionId, {
      id: randomId("artifact"),
      sessionId,
      type,
      title,
      summary,
      payload: createSessionArtifactPayload(payload),
      createdAt: new Date().toISOString()
    });
  }

  private async addDecisionRecord(
    sessionId: string,
    input: Omit<DecisionRecord, "id" | "sessionId" | "createdAt">
  ) {
    const decisionId = randomId("decision");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const record = {
        id: decisionId,
        sessionId,
        createdAt: new Date().toISOString(),
        ...input
      };
      draft.decisionLedger.push(record);
      if (input.createdByAgentId) {
        updateAgentRunRecord(draft, input.createdByAgentId, (agent) => {
          agent.decisionsMade = appendUnique(agent.decisionsMade, decisionId);
          agent.evidenceRefs = mergeEvidenceRefs(agent.evidenceRefs, input.evidenceRefs.map((evidence) => ({
            ...evidence,
            linkedDecisionId: evidence.linkedDecisionId ?? decisionId,
            linkedAgentId: evidence.linkedAgentId ?? input.createdByAgentId
          })));
          appendAgentJournalEntry(agent, {
            kind: "decision",
            title: input.decision,
            summary: input.finding,
            linkedDecisionId: decisionId,
            status: "completed"
          });
          if (input.evidenceRefs.length) {
            appendAgentJournalEntry(agent, {
              kind: "evidence_added",
              title: "Evidence linked",
              summary: `Linked ${input.evidenceRefs.length} evidence reference(s) to a runtime decision.`,
              linkedDecisionId: decisionId,
              linkedEvidenceRefId: input.evidenceRefs[0]?.id,
              status: "completed"
            });
          }
        });
      }
      for (const linkedAgentId of input.linkedAgentIds ?? []) {
        updateAgentRunRecord(draft, linkedAgentId, (agent) => {
          agent.decisionsMade = appendUnique(agent.decisionsMade, decisionId);
        });
      }
    });
    return decisionId;
  }

  private async recordAgentRisk(sessionId: string, agentId: string, risk: AgentRiskRef) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      updateAgentRunRecord(draft, agentId, (agent) => {
        agent.riskRefs = mergeRiskRefs(agent.riskRefs, [risk]);
        appendAgentJournalEntry(agent, {
          kind: "risk_identified",
          title: risk.reason,
          summary: risk.mitigation ?? "A runtime risk was recorded for this agent contract.",
          filePath: risk.filePath,
          severity: risk.severity,
          status: risk.status === "mitigated" ? "completed" : "blocked"
        });
      });
    });
  }

  private async updateRunPhase(
    sessionId: string,
    phaseId: RunPhaseId,
    status: RunPhaseStatus,
    summary: string,
    evidenceCount?: number
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const now = new Date().toISOString();
      draft.runPhases = updateRunPhaseRecord(draft.runPhases, phaseId, status, summary, evidenceCount, now);
      updateAgentRunRecord(draft, "agent_local_codex", (agent) => {
        agent.lastEvent = `${phaseId}:${status}`;
        agent.currentAction = summary;
        agent.recentActions = appendRecentAction(agent.recentActions, summary);
      });
    });
  }

  private async updateStage(
    sessionId: string,
    lifecycleStage: AgentRuntimeSession["lifecycleStage"],
    progressStage: RuntimeProgressStage,
    status: "queued" | "running" | "completed" | "blocked" | "failed",
    taskTitle: string,
    summary: string,
    targetFiles: string[] = []
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.lifecycleStage = lifecycleStage;
      if (status === "running") draft.status = "running";
    });
    await this.sessionManager.addProgressEvent(sessionId, {
      id: randomId("progress"),
      sessionId,
      stage: progressStage,
      status,
      agentName: "RunEngine",
      role: "Local Run",
      taskTitle,
      summary,
      targetFiles,
      createdAt: new Date().toISOString()
    });
  }

  private async finish(sessionId: string, status: AgentRuntimeSession["status"], stage: AgentRuntimeSession["lifecycleStage"], summary: RunSummary) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = status;
      draft.lifecycleStage = stage;
      updateAgentRunRecord(draft, "agent_local_codex", (agent) => {
        agent.status =
          status === "failed"
            ? "failed"
            : status === "blocked"
              ? "blocked"
              : status === "needs_approval"
                ? "running"
                : "completed";
        agent.lifecycleStage = stage;
        agent.currentAction = summary.summary;
        agent.lastEvent = `finish:${status}`;
        if (agent.status === "completed" || agent.status === "failed" || agent.status === "blocked") {
          agent.completedAt = new Date().toISOString();
        }
      });
    });
    await this.sessionManager.setRunSummary(sessionId, summary);
  }

  private requireSession(sessionId: string) {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    return session;
  }
}

function isReadOnlyAnswerRequest(snapshot: RepoSnapshot) {
  return snapshot.intentUnderstanding?.actionMode === "answer_only" || snapshot.runIntent === "inspect_only";
}

type RepoSnapshot = {
  summary: string;
  intentUnderstanding?: ReturnType<typeof inferWorkspaceIntent>;
  stack: string[];
  packageManagers: string[];
  testCommands: string[];
  importantFiles: string[];
  candidateFiles: string[];
  searchResults: Array<{ path: string; line: number; preview: string }>;
  fileSamples: Array<{ path: string; reason: string; excerpt: string }>;
  intake?: AgentRuntimeSession["projectIntake"];
  contextPack?: AgentRuntimeSession["contextPack"];
  runIntent?: AgentRuntimeSession["runIntent"];
};

function createSnapshot(
  tools: ToolRegistry,
  projectMap: ProjectMap,
  message: string,
  intake?: AgentRuntimeSession["projectIntake"],
  conversationUnderstanding?: ConversationUnderstanding
): RepoSnapshot {
  const intentUnderstanding = conversationUnderstanding?.workspaceIntent ?? inferWorkspaceIntent(message);
  const files = tools.workspace.listFiles(260);
  const candidateFiles = files
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path)
    .filter((file) => /\.(ts|tsx|js|jsx|rs|py|css|html|md|json|toml)$/i.test(file))
    .slice(0, 60);
  const searchResults = tools.workspace.searchCode(inferSearchQuery(message, conversationUnderstanding), 12);
  const normalizedMessage = message.toLowerCase();
  const matchedFiles = candidateFiles.filter((file) => normalizedMessage.includes(file.toLowerCase()) || normalizedMessage.includes(file.split("/").pop()?.toLowerCase() ?? ""));
  const samplePaths = [
    ...new Set([
      ...(intake?.contextPack?.relevantFiles ?? []),
      ...matchedFiles,
      ...searchResults.map((match) => match.path),
      ...projectMap.importantFiles,
      ...candidateFiles.slice(0, 3)
    ])
  ].slice(0, 8);
  const fileSamples = samplePaths.flatMap((filePath) => {
    try {
      const excerpt = tools.workspace.readFile(filePath).slice(0, 1_200);
      return [{ path: filePath, reason: searchResults.some((match) => match.path === filePath) ? "search-hit" : "important-file", excerpt }];
    } catch {
      return [];
    }
  });
  const stack = projectMap.stack.length ? projectMap.stack : ["Unknown"];
  return {
    summary: `${stack.join(", ")} workspace with ${candidateFiles.length} candidate source/config file(s), ${searchResults.length} search hit(s), and ${fileSamples.length} file sample(s). Intent: ${intentUnderstanding.actionMode}/${intentUnderstanding.answerGoal} for ${intentUnderstanding.topicPhrase}.${intake ? ` Intake classified it as ${intake.projectKind.replaceAll("_", " ")}.` : ""}`,
    intentUnderstanding,
    stack,
    packageManagers: projectMap.packageManagers,
    testCommands: projectMap.testCommands,
    importantFiles: projectMap.importantFiles,
    candidateFiles,
    searchResults,
    fileSamples,
    intake,
    contextPack: intake?.contextPack,
    runIntent: intake?.runIntent
  };
}

function normalizePlan(input: Partial<RunPlanModel>, message: string, snapshot: RepoSnapshot): RunPlanModel {
  void message;
  void snapshot;
  return {
    summary: input.summary!,
    reasoningSummary: input.reasoningSummary!,
    mode: input.mode!,
    tasks: input.tasks!.map((task, index) => ({
      ...task,
      id: task.id ?? `task_${index + 1}`
    })),
    acceptanceCriteria: input.acceptanceCriteria!,
    risks: input.risks!,
    suggestedCommands: input.suggestedCommands,
    planSource: "provider"
  };
}

function createOperatorSuppliedPlanIfPresent(
  message: string,
  snapshot: RepoSnapshot
): RunPlanModel | undefined {
  if (!isExplicitOperatorSuppliedImplementationPlan(message)) return undefined;
  const mode = inferRunMode(message, snapshot) === "create_project" ? "create_project" : "edit_project";
  const targetFiles = inferTargetFiles(message, snapshot, mode);
  const sections = extractOperatorPlanSections(message);
  const acceptanceCriteria =
    sectionLines(sections.get("acceptance") ?? sections.get("test plan"))
      .concat(sectionLines(sections.get("success criteria")))
      .slice(0, 8);
  const risks = sectionLines(sections.get("assumptions"))
    .concat(sectionLines(sections.get("risks")))
    .slice(0, 6);
  const keyChanges = sectionLines(sections.get("key changes"))
    .concat(sectionLines(sections.get("implementation changes")))
    .slice(0, 8);
  const summary = firstSectionSentence(sections.get("summary"))
    ?? "Use the operator-supplied implementation plan.";
  const verification = snapshot.testCommands[0] ?? "npm run typecheck";
  return {
    summary,
    reasoningSummary: "Plan source: operator_supplied. The user supplied a structured implementation plan, so provider run-plan generation was skipped while patch generation remains provider/schema gated.",
    mode,
    tasks: [
      {
        id: "task_1",
        title: "Implement user plan",
        objective: keyChanges.length ? keyChanges.join(" ") : "Implement the explicit operator-supplied plan.",
        roleTitle: "Implementation Worker",
        targetFiles,
        expectedArtifact: "Reviewable diff",
        verification
      },
      {
        id: "task_2",
        title: "Preserve strict gates",
        objective: "Keep provider/schema validation, patch review, and Rust authority gates active before any file apply.",
        roleTitle: "Scope Guard",
        targetFiles,
        expectedArtifact: "Validated patch intent",
        verification
      },
      {
        id: "task_3",
        title: "Verify behavior",
        objective: acceptanceCriteria.length ? acceptanceCriteria.join(" ") : "Run focused tests and report any unverified status explicitly.",
        roleTitle: "Verification Runner",
        targetFiles,
        expectedArtifact: "Verification summary",
        verification
      }
    ],
    acceptanceCriteria: acceptanceCriteria.length
      ? acceptanceCriteria
      : ["The operator-supplied plan is used for planning only.", "Provider/schema gates still control patch generation and edits."],
    risks: risks.length
      ? risks
      : ["Operator-supplied planning skips provider run-plan generation; keep later execution gates strict."],
    suggestedCommands: snapshot.testCommands.slice(0, 2).map((command) => ({ command, reason: "Verify the operator-supplied implementation plan." })),
    planSource: "operator_supplied"
  };
}

export function isExplicitOperatorSuppliedImplementationPlan(message: string) {
  const normalized = message.toLowerCase();
  const hasExplicitDirective = /\b(?:please\s+)?implement\s+this\s+plan\b/.test(normalized)
    || /\bimplement\s+the\s+following\s+plan\b/.test(normalized)
    || /نفذ\s+الخطة|طبّق\s+الخطة|طبق\s+الخطة/.test(message);
  if (!hasExplicitDirective) return false;
  const sectionHits = [
    /^#{1,3}\s*operator-supplied implementation plan\b/im,
    /^#{1,3}\s*summary\b/im,
    /^#{1,3}\s*(key changes|implementation changes)\b/im,
    /^#{1,3}\s*test plan\b/im,
    /^#{1,3}\s*assumptions\b/im
  ].filter((pattern) => pattern.test(message)).length;
  const bulletCount = (message.match(/^\s*[-*]\s+\S/gm) ?? []).length;
  return sectionHits >= 2 || (sectionHits >= 1 && bulletCount >= 3);
}

function extractOperatorPlanSections(message: string) {
  const sections = new Map<string, string>();
  const matches = [...message.matchAll(/^#{1,3}\s+(.+?)\s*$/gim)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const title = normalizeSectionTitle(match[1] ?? "");
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? message.length;
    if (title) sections.set(title, message.slice(start, end).trim());
  }
  return sections;
}

function normalizeSectionTitle(title: string) {
  return title.toLowerCase().replace(/[`*_]/g, "").replace(/[:：].*$/, "").trim();
}

function sectionLines(section: string | undefined) {
  if (!section) return [];
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/^\s*\d+[.)]\s+/, "").trim())
    .filter((line) => line.length > 0 && !/^#{1,3}\s+/.test(line))
    .slice(0, 10);
}

function firstSectionSentence(section: string | undefined) {
  const line = sectionLines(section)[0];
  if (!line) return undefined;
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function planningProviderGatesForPlan(plan: RunPlanModel): RunSummary["gates"] {
  if (plan.planSource !== "operator_supplied") return [];
  return [{
    name: "Planning provider request",
    status: "passed",
    notes: ["Skipped: operator-supplied implementation plan used; provider/schema gates remain active for patch generation."]
  }];
}

function withPlanningProviderGates(summary: RunSummary, plan: RunPlanModel): RunSummary {
  const gates = planningProviderGatesForPlan(plan);
  if (!gates.length) return summary;
  const existing = new Set(summary.gates.map((gate) => gate.name));
  return {
    ...summary,
    gates: [...gates.filter((gate) => !existing.has(gate.name)), ...summary.gates]
  };
}

function shouldForceInferredInspectOnly(message: string, snapshot: RepoSnapshot) {
  return (
    inferRunMode(message, snapshot) === "inspect_only" &&
    snapshot.intentUnderstanding?.actionMode === "answer_only"
  );
}

function normalizePatchIntent(input: Partial<RunPatchIntentModel>, message: string): RunPatchIntentModel {
  void message;
  if (input.intents?.length) {
    return {
      title: input.title!,
      summary: input.summary!,
      intents: input.intents,
      suggestedCommands: input.suggestedCommands
    };
  }
  throw new Error("provider_patch_intent_empty_after_repairs");
}

function inferExplicitAgentCount(message: string): number | null {
  const match = message.match(/\buse\s+(\d+)\s+agents?\b/i) ?? message.match(/\b(\d+)\s+agents?\b/i);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function isSingleFilePythonPygameRequest(message: string, snapshot: RepoSnapshot) {
  const normalized = message.toLowerCase();
  const mentionsPython = /\bpython\b/.test(normalized) || snapshot.stack.some((entry) => /python/i.test(entry));
  const mentionsPygame = /\bpy\s*game\b/.test(normalized) || /\bpygame\b/.test(normalized);
  const singleFile =
    /\bone python code\b/.test(normalized) ||
    /\bsingle file\b/.test(normalized) ||
    /\bone file\b/.test(normalized) ||
    /\bone python file\b/.test(normalized) ||
    /\bsingle python\b/.test(normalized);
  return mentionsPython && mentionsPygame && singleFile;
}

function compilePatchProposalInput(
  workspacePath: string,
  tools: ToolRegistry,
  patchIntent: RunPatchIntentModel
): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
  const filesChanged: Array<{ path: string; changeType: PatchFileChange["changeType"]; explanation: string }> = [];
  const artifacts: Array<{ path: string; content: string }> = [];
  const diffs: string[] = [];
  const riskLevel = highestRiskLevel(patchIntent.intents.map((intent) => intent.risk));

  for (const intent of patchIntent.intents) {
    const compiled = compileIntent(workspacePath, tools, intent);
    filesChanged.push({
      path: compiled.path,
      changeType: compiled.changeType,
      explanation: compiled.explanation
    });
    artifacts.push({ path: compiled.path, content: compiled.content });
    diffs.push(compiled.unifiedDiff);
  }

  return {
    title: patchIntent.title,
    summary: patchIntent.summary,
    riskLevel,
    filesChanged,
    artifacts,
    unifiedDiff: diffs.join("\n"),
    requiresApproval: true,
    status: "proposed"
  };
}

function compileIntent(
  workspacePath: string,
  tools: ToolRegistry,
  intent: RunPatchIntent
): {
  path: string;
  changeType: PatchFileChange["changeType"];
  explanation: string;
  content: string;
  unifiedDiff: string;
} {
  assertRelativeWorkspacePath(workspacePath, intent.path);

  if (intent.operation === "create_file") {
    if (tools.workspace.fileExists(intent.path)) {
      throw new Error(`Patch intent expected a new file, but ${intent.path} already exists`);
    }
    return {
      path: intent.path,
      changeType: "create",
      explanation: intent.reason,
      content: intent.replacementText,
      unifiedDiff: createFileDiff(intent.path, intent.replacementText)
    };
  }

  if (intent.operation === "overwrite_file") {
    const exists = tools.workspace.fileExists(intent.path);
    const current = exists ? tools.workspace.readWholeFile(intent.path) : "";
    return {
      path: intent.path,
      changeType: exists ? "modify" : "create",
      explanation: intent.reason,
      content: intent.replacementText,
      unifiedDiff: exists
        ? createWholeFileReplaceDiff(intent.path, current, intent.replacementText)
        : createFileDiff(intent.path, intent.replacementText)
    };
  }

  if (!["replace_range", "insert_after", "insert_before", "delete_range"].includes(intent.operation)) {
    throw new Error(`Unsupported patch intent operation: ${intent.operation}`);
  }

  if (!tools.workspace.fileExists(intent.path)) {
    throw new Error(`Patch intent targeted missing file: ${intent.path}`);
  }

  const current = tools.workspace.readWholeFile(intent.path);
  const anchor = intent.preimageText ?? intent.anchorText;
  if (!anchor) {
    throw new Error(`Patch intent for ${intent.path} is missing anchorText/preimageText`);
  }

  const matches = findExactMatches(current, anchor);
  if (matches.length === 0) {
    throw new Error(`Patch intent anchor was not found in ${intent.path}`);
  }
  if (matches.length > 1) {
    throw new Error(`Patch intent anchor is ambiguous in ${intent.path}`);
  }

  const match = matches[0]!;
  const start =
    intent.operation === "insert_after"
      ? match.end
      : match.start;
  const end =
    intent.operation === "insert_before"
      ? match.start
      : intent.operation === "insert_after"
        ? match.end
        : match.end;
  const replacement =
    intent.operation === "delete_range"
      ? ""
      : intent.operation === "insert_after" || intent.operation === "insert_before"
        ? intent.replacementText
        : intent.replacementText;
  const updated = `${current.slice(0, start)}${replacement}${current.slice(end)}`;
  return {
    path: intent.path,
    changeType: "modify",
    explanation: intent.reason,
    content: updated,
    unifiedDiff: createReplaceRangeDiff(intent.path, current, updated, start, end)
  };
}

function createFileDiff(filePath: string, content: string) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${countDiffLines(content)} @@`,
    ...normalizeDiffLines(content).map((line) => `+${line}`)
  ].join("\n");
}

function createReplaceRangeDiff(filePath: string, before: string, after: string, start: number, end: number) {
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  void start;
  void end;
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) suffix += 1;
  const contextBeforeCount = Math.min(2, prefix);
  const contextAfterCount = Math.min(2, suffix);
  const oldSliceStart = prefix - contextBeforeCount;
  const newSliceStart = prefix - contextBeforeCount;
  const oldChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const newChanged = afterLines.slice(prefix, afterLines.length - suffix);
  const trailingContext = beforeLines.slice(beforeLines.length - suffix, beforeLines.length - suffix + contextAfterCount);
  const oldCount = contextBeforeCount + oldChanged.length + contextAfterCount;
  const newCount = contextBeforeCount + newChanged.length + contextAfterCount;

  const hunkLines = [
    ...beforeLines.slice(oldSliceStart, prefix).map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...trailingContext.map((line) => ` ${line}`)
  ];

  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldSliceStart + 1},${oldCount} +${newSliceStart + 1},${newCount} @@`,
    ...hunkLines
  ].join("\n");
}

function createWholeFileReplaceDiff(filePath: string, before: string, after: string) {
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${Math.max(beforeLines.length, 1)} +1,${Math.max(afterLines.length, 1)} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join("\n");
}

function collectRelevantFilesForPatch(snapshot: RepoSnapshot, plan: RunPlanModel) {
  const targetFiles = plan.tasks.flatMap((task) => task.targetFiles ?? []);
  const samples = snapshot.fileSamples.filter((sample) => targetFiles.includes(sample.path));
  return samples.length ? samples : snapshot.fileSamples;
}

function findExactMatches(content: string, snippet: string) {
  const matches: Array<{ start: number; end: number }> = [];
  let startIndex = 0;
  while (startIndex <= content.length) {
    const index = content.indexOf(snippet, startIndex);
    if (index === -1) break;
    matches.push({ start: index, end: index + snippet.length });
    startIndex = index + 1;
  }
  return matches;
}

function lineIndexAt(content: string, position: number) {
  const clamped = Math.max(0, Math.min(position, content.length));
  return content.slice(0, clamped).split("\n").length - 1;
}

function splitLinesForDiff(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function normalizeDiffLines(content: string) {
  return splitLinesForDiff(content);
}

function countDiffLines(content: string) {
  return Math.max(splitLinesForDiff(content).length, 1);
}

function assertRelativeWorkspacePath(workspacePath: string, targetPath: string) {
  const normalizedTarget = targetPath.replaceAll("\\", "/");
  if (!normalizedTarget || normalizedTarget.startsWith("/") || /^[a-z]:/i.test(normalizedTarget) || normalizedTarget.includes("..")) {
    throw new Error(`Patch intent references a path outside the workspace: ${targetPath}`);
  }
  const resolved = normalizedTarget.split("/").filter(Boolean).join("/");
  if (!resolved) {
    throw new Error(`Patch intent path is invalid: ${targetPath}`);
  }
  void workspacePath;
}

function highestRiskLevel(risks: PatchProposal["riskLevel"][]) {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function createCommandRequests(
  sessionId: string,
  workspacePath: string,
  suggested: Array<{ command: string; reason: string }>,
  fallbackCommands: string[],
  options: { fullAccess?: boolean } = {}
): CommandRequest[] {
  const commands = suggested.length ? suggested : fallbackCommands.slice(0, 1).map((command) => ({ command, reason: "Validate the approved change." }));
  return commands.slice(0, 3).map((item) => {
    const risk = classifyCommandRisk(item.command, workspacePath);
    const fullAccess = options.fullAccess === true;
    const policyDecision = risk === "dangerous" && !fullAccess ? "deny" : risk === "safe" || fullAccess ? "allow" : "require_approval";
    return {
      id: `cmd_${randomUUID()}`,
      sessionId,
      command: item.command,
      cwd: workspacePath,
      risk,
      reason: item.reason,
      provenance: {
        source: "agent",
        trigger: "manual",
        requestedBy: "agent",
        agentId: "agent_local_codex",
        approvalSource: fullAccess ? "auto" : risk === "dangerous" ? "denied" : "none",
        policyDecision,
        policyReason: item.reason,
        background: looksLikeBackgroundCommand(item.command.toLowerCase()),
        networkDetected: looksLikeNetworkCommand(item.command.toLowerCase()),
        backgroundDetected: looksLikeBackgroundCommand(item.command.toLowerCase()),
        detectionSource: "heuristic",
        networkDetectionSource: "heuristic",
        backgroundDetectionSource: "heuristic",
        reason: item.reason
      },
      status: risk === "dangerous" && !fullAccess ? "blocked" : "requested",
      createdAt: new Date().toISOString()
    };
  });
}

function toAgentPlan(plan: RunPlanModel): AgentPlan {
  return {
    summary: plan.summary,
    steps: plan.tasks.map((task) => ({
      id: task.id ?? randomId("step"),
      title: task.title,
      detail: task.objective,
      status: "completed"
    })),
    acceptanceCriteria: plan.acceptanceCriteria,
    risks: plan.risks
  };
}

function describeProviderTruth(telemetry: NonNullable<AgentRuntimeSession["providerTelemetry"]>) {
  return `Provider: ${telemetry.providerName}${telemetry.modelName ? `/${telemetry.modelName}` : ""}; calls ${telemetry.providerRequestCount}/${telemetry.providerResponseCount}/${telemetry.providerFailureCount}/${telemetry.providerTimeoutCount} request/response/error/timeout; reasoning ${telemetry.reasoningAttempts}; repairs ${telemetry.repairAttempts}; final source ${telemetry.finalResponseSource}; prompt chars ${telemetry.totalProviderPromptChars ?? 0}; response chars ${telemetry.totalProviderResponseChars ?? 0}.`;
}

function createRunSummary(session: AgentRuntimeSession, verification: VerificationResult): RunSummary {
  return buildDiffAwareRunSummary(
    session,
    verification,
    verification.status === "failed"
      ? "failed"
      : verification.status === "pending"
        ? "blocked"
        : "completed",
    "Review changes, then apply and run verification through Rust."
  );
}

function formatPlanModeMessage(plan: RunPlanModel, message: string) {
  const arabic = /[\u0600-\u06FF]/.test(message);
  const intro = arabic
    ? "اشتغلت في Plan mode فقط: قريت الموجود، بنيت خطة، ووقفت قبل أي تعديل أو تشغيل."
    : "I stayed in plan mode only: I read the current project, built a plan, and stopped before any edits or commands.";
  const stepsTitle = arabic ? "## الخطة" : "## Plan";
  const criteriaTitle = arabic ? "## معايير القبول" : "## Acceptance Criteria";
  const risksTitle = arabic ? "## المخاطر أو الغموض" : "## Risks And Unknowns";
  const close = arabic
    ? "لو الخطة مناسبة، اختار Implement plan. ولو تحب نفضل في التخطيط فقط، سيبها زي ما هي أو ابعت توضيح إضافي."
    : "If the plan looks right, choose Implement plan. If you want to stay in planning only, leave it as-is or send more clarification.";
  return [
    intro,
    "",
    plan.summary,
    "",
    stepsTitle,
    ...plan.tasks.map((task, index) => `${index + 1}. ${task.title}: ${task.objective}`),
    "",
    criteriaTitle,
    ...(plan.acceptanceCriteria.length ? plan.acceptanceCriteria.map((item) => `- ${item}`) : [arabic ? "- لا توجد معايير إضافية واضحة حتى الآن." : "- No extra acceptance criteria were inferred yet."]),
    "",
    risksTitle,
    ...(plan.risks.length ? plan.risks.map((item) => `- ${item}`) : [arabic ? "- لا توجد مخاطر كبيرة واضحة من القراءة الأولية." : "- No major risks stood out from the initial read."]),
    "",
    close
  ].join("\n");
}

function createInitialRunPhases(runMode: RunMode): RunPhase[] {
  return [
    { id: "inspect_workspace", status: "pending", summary: runMode === "deep_audit" ? "Extended inspection has not started yet." : "Workspace inspection has not started yet." },
    { id: "build_repo_map", status: "pending", summary: "Repo map has not been built yet." },
    { id: "split_agents", status: "pending", summary: "Agent planning has not been prepared yet." },
    { id: "agents_running", status: "pending", summary: "No implementation work is running yet." },
    { id: "integrate_changes", status: "pending", summary: "No reviewable change set has been prepared yet." },
    { id: "run_verification", status: "pending", summary: "Verification has not started yet." },
    { id: "review_final_diff", status: "pending", summary: "Review gate is not ready yet." },
    { id: "final_report", status: "pending", summary: "Final report is not ready yet." }
  ];
}

function updateRunPhaseRecord(
  phases: RunPhase[],
  phaseId: RunPhaseId,
  status: RunPhaseStatus,
  summary: string,
  evidenceCount: number | undefined,
  now: string
) {
  return phases.map((phase) => {
    if (phase.id !== phaseId) return phase;
    return {
      ...phase,
      status,
      summary,
      evidenceCount,
      startedAt: phase.startedAt ?? now,
      completedAt: status === "completed" || status === "blocked" || status === "failed" ? now : undefined
    };
  });
}

function inferLocalRunMode(
  message: string,
  resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">,
  runIntent: ReturnType<typeof classifyRunIntent>
): RunMode {
  const normalized = message.toLowerCase();
  if (runIntent === "run_to_green") return "run_to_green" as RunMode;
  if (/\b(paranoid|double check|double-check|review twice)\b/.test(normalized)) return "paranoid_mode";
  if (/\b(soak|stability|burn in|burn-in|retry a lot)\b/.test(normalized)) return "soak_mode";
  if (/\b(audit|deep|inspect thoroughly|thorough|analyze deeply)\b/.test(normalized)) return "deep_audit";
  if (runIntent === "inspect_only") return "inspect_only" as RunMode;
  if (resolvedMode === "simple_mode" && /\b(tiny|small|quick|minor)\b/.test(normalized)) return "quick_fix";
  return "normal_run";
}

function createNoGroundedRunCommandMessage(message: string, previewTarget?: string, blockerReason?: string) {
  if (/[\u0600-\u06ff]/.test(message)) {
    const localizedReason = blockerReason && !/[A-Za-z]/.test(blockerReason)
      ? blockerReason
      : "مفيش أمر تشغيل أو build أو test متثبت من ملفات المشروع.";
    return previewTarget
      ? `راجعت المشروع، لكن مقدرتش أثبت أمر تشغيل آمن من الملفات.\n\nالمعاينة متاحة هنا: ${previewTarget}.`
      : `راجعت المشروع، لكن مقدرتش أثبت أمر تشغيل آمن من الملفات.\n\n${localizedReason}`;
  }
  return previewTarget
    ? `I inspected the workspace, but I could not infer a grounded run command.\n\nPreview is available at ${previewTarget}.`
    : `I inspected the workspace, but I could not infer a grounded run command.\n\n${blockerReason ?? "No grounded command was available."}`;
}

function createSnapshotEvidenceRefs(snapshot: RepoSnapshot): EvidenceRef[] {
  const searchEvidence = snapshot.searchResults.slice(0, 3).map((match) => ({
    type: "file" as const,
    path: match.path,
    lineStart: match.line,
    lineEnd: match.line,
    category: "search-hit",
    reason: match.preview.trim() || "Matched the request search query."
  }));
  if (searchEvidence.length) {
    return searchEvidence;
  }
  return snapshot.importantFiles.slice(0, 3).map((file) => ({
    type: "file" as const,
    path: file,
    category: "important-file",
    reason: "Important workspace file"
  }));
}

function buildPlannedAgentContracts(
  sessionId: string,
  plan: RunPlanModel,
  startedAt: string,
  modulePlan?: AgentRuntimeSession["moduleExecutionPlan"]
): AgentRun[] {
  return plan.tasks.map((task, index) => ({
    id: `agent_task_${index + 1}`,
    sessionId,
    agentName: task.roleTitle,
    displayName: `${task.roleTitle} ${index + 1}`,
    role: task.roleTitle,
    roleTitle: task.roleTitle,
    lifecycleStage: "PLAN",
    objective: task.objective,
    ownedPaths: modulePlan?.ownedPaths.length ? modulePlan.ownedPaths : task.targetFiles ?? [],
    forbiddenPaths: uniqueStrings([...(modulePlan?.forbiddenPaths ?? []), "tauri://rust-authority", "workspace://outside-current"]),
    allowedActions: ["inspect_assigned_paths", "prepare_reviewable_changes", "record_evidence", "request_verification"],
    stopConditions: [
      ...(modulePlan?.stopConditions ?? []),
      "Stop if the change requires files outside the owned paths.",
      task.verification ? `Stop when the work is ready for ${task.verification}.` : "Stop when the work is ready for review."
    ],
    integrationNotes: [
      task.expectedArtifact ? `Expected artifact: ${task.expectedArtifact}` : "Expected artifact not reported yet.",
      "Coordinator keeps the final review gate and Rust remains the apply authority.",
      ...(modulePlan?.publicContractsToPreserve.length ? [`Preserve public contracts: ${modulePlan.publicContractsToPreserve.slice(0, 3).join(", ")}`] : []),
      ...(modulePlan?.verificationCommands.length ? [`Verification commands: ${modulePlan.verificationCommands.join(" | ")}`] : [])
    ],
    currentAction: "Planned by coordinator; execution telemetry not reported yet.",
    recentActions: ["Contract prepared by coordinator."],
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    decisionsMade: [],
    evidenceRefs: (modulePlan?.relevantFiles ?? task.targetFiles ?? []).slice(0, 3).map((file) => ({
      type: "file" as const,
      path: file,
      category: "owned-path",
      reason: "Planner assigned this path to the agent contract."
    })),
    riskRefs: [],
    workJournal: [{
      id: randomId("journal"),
      agentId: `agent_task_${index + 1}`,
      timestamp: startedAt,
      kind: "planning",
      title: "Contract prepared",
      summary: modulePlan
        ? `Coordinator assigned a scoped module contract with owned paths: ${modulePlan.ownedPaths.slice(0, 3).join(", ")}.`
        : "Coordinator assigned a bounded ownership contract to this agent.",
      status: "completed"
    }],
    riskLevel: "medium",
    blockers: [],
    diffStats: undefined,
    currentTask: task.title,
    status: "idle",
    lastEvent: "planned",
    startedAt
  }));
}

function upsertAgentRunRecord(session: AgentRuntimeSession, input: AgentRun) {
  const existingIndex = session.orchestration?.agentRuns.findIndex((agent) => agent.id === input.id) ?? -1;
  if (!session.orchestration) return;
  if (existingIndex >= 0) {
    session.orchestration.agentRuns[existingIndex] = {
      ...session.orchestration.agentRuns[existingIndex],
      ...input
    };
    return;
  }
  session.orchestration.agentRuns.push(input);
}

function updateAgentRunRecord(session: AgentRuntimeSession, agentId: string, updater: (agent: AgentRun) => void) {
  const agent = session.orchestration?.agentRuns.find((candidate) => candidate.id === agentId);
  if (!agent) return;
  updater(agent);
}

function appendRecentAction(actions: string[] | undefined, next: string) {
  const merged = [...(actions ?? []), next];
  return merged.slice(-6);
}

function appendUnique(values: string[] | undefined, next: string) {
  return uniqueStrings([...(values ?? []), next]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function mergeEvidenceRefs(existing: EvidenceRef[] | undefined, next: EvidenceRef[]) {
  const merged = [...(existing ?? [])];
  for (const ref of next) {
    const fingerprint = JSON.stringify(ref);
    if (!merged.some((candidate) => JSON.stringify(candidate) === fingerprint)) {
      merged.push(ref);
    }
  }
  return merged.slice(-12);
}

function mergeRiskRefs(existing: AgentRiskRef[] | undefined, next: AgentRiskRef[]) {
  const merged = [...(existing ?? [])];
  for (const ref of next) {
    if (!merged.some((candidate) => candidate.id === ref.id || (candidate.agentId === ref.agentId && candidate.reason === ref.reason && candidate.filePath === ref.filePath))) {
      merged.push(ref);
    }
  }
  return merged.slice(-12);
}

function createSessionExplainReportSummary(report: NonNullable<AgentRuntimeSession["explainReport"]>): NonNullable<AgentRuntimeSession["explainReport"]> {
  return {
    overview: report.overview,
    architecture: report.architecture,
    sections: report.sections.slice(0, 6),
    findings: report.findings.slice(0, 8),
    moduleMap: report.moduleMap.slice(0, 12).map((module) => ({
      ...module,
      importantFiles: module.importantFiles.slice(0, 12),
      entryPoints: module.entryPoints.slice(0, 8),
      tests: module.tests.slice(0, 8),
      dependencies: module.dependencies.slice(0, 12),
      risksAndUnknowns: module.risksAndUnknowns.slice(0, 8),
      evidence: module.evidence.slice(0, 12)
    })),
    entryPoints: report.entryPoints.slice(0, 20),
    dataFlow: report.dataFlow,
    importantFiles: report.importantFiles.slice(0, 30),
    howToRun: report.howToRun.slice(0, 12),
    risksAndUnknowns: report.risksAndUnknowns.slice(0, 12),
    suggestedNextQuestions: report.suggestedNextQuestions.slice(0, 8),
    evidence: report.evidence.slice(0, 40),
    contextPack: {
      inventory: {
        ...report.contextPack.inventory,
        ignoredDirectories: report.contextPack.inventory.ignoredDirectories.slice(0, 40),
        rootFolders: report.contextPack.inventory.rootFolders.slice(0, 40)
      },
      readBudget: report.contextPack.readBudget,
      sampledFiles: report.contextPack.sampledFiles.slice(0, 30).map((file) => ({
        ...file,
        summary: truncateText(file.summary, 1_000)
      }))
    }
  };
}

function createSessionEvidenceTruthReportSummary(report: EvidenceTruthReport): EvidenceTruthReport {
  return {
    topEvidenceFiles: report.topEvidenceFiles.slice(0, 30),
    evidenceFilesByTier: Object.fromEntries(
      Object.entries(report.evidenceFilesByTier).map(([tier, files]) => [tier, files.slice(0, 40)])
    ) as EvidenceTruthReport["evidenceFilesByTier"],
    excludedEvidenceCandidates: report.excludedEvidenceCandidates.slice(0, 60),
    exclusionReasons: Object.fromEntries(Object.entries(report.exclusionReasons).slice(0, 80)),
    finalEvidenceFilesActuallyUsed: report.finalEvidenceFilesActuallyUsed.slice(0, 40),
    groundedEvidence: report.groundedEvidence?.slice(0, 40).map((item) => ({
      ...item,
      reason: truncateText(item.reason, 1_500)
    })),
    rejectedEvidence: report.rejectedEvidence?.slice(0, 40),
    generatedEvidenceExcludedCount: report.generatedEvidenceExcludedCount,
    generatedEvidenceIncludedCount: report.generatedEvidenceIncludedCount,
    generatedEvidenceIncluded: report.generatedEvidenceIncluded,
    allowGeneratedEvidence: report.allowGeneratedEvidence,
    updatedAt: report.updatedAt
  };
}

function createSessionArtifactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSessionPayloadValue(payload, 0, new WeakSet<object>()) as Record<string, unknown>;
}

function sanitizeSessionPayloadValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncateText(value, 8_000);
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= 5) return summarizePayloadContainer(value);
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = depth <= 1 ? 40 : 20;
    const items = value.slice(0, limit).map((item) => sanitizeSessionPayloadValue(item, depth + 1, seen));
    return value.length > limit
      ? [...items, { __truncated: true, omittedItems: value.length - limit }]
      : items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = depth === 0 ? 160 : depth === 1 ? 80 : 35;
  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, limit)) {
    output[key] = sanitizeSessionPayloadValue(entryValue, depth + 1, seen);
  }
  if (entries.length > limit) {
    output.__truncated = true;
    output.omittedKeys = entries.length - limit;
  }
  return output;
}

function summarizePayloadContainer(value: object) {
  if (Array.isArray(value)) return { __truncated: true, kind: "array", length: value.length };
  return { __truncated: true, kind: "object", keys: Object.keys(value).slice(0, 20) };
}

function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]` : value;
}

function findOwningAgentId(session: AgentRuntimeSession, filePath: string) {
  return session.orchestration?.agentRuns.find((agent) =>
    (agent.ownedPaths ?? []).some((ownedPath) => filePath === ownedPath || filePath.startsWith(`${ownedPath.replace(/\/$/, "")}/`))
  )?.id;
}

function distributePatchTelemetry(
  session: AgentRuntimeSession,
  patch: PatchProposal,
  commandRequests: CommandRequest[]
) {
  for (const agent of session.orchestration?.agentRuns ?? []) {
    const owned = new Set(agent.ownedPaths ?? []);
    const changedFiles = patch.filesChanged.filter((file) =>
      [...owned].some((ownedPath) => file.path === ownedPath || file.path.startsWith(`${ownedPath.replace(/\/$/, "")}/`))
    );
    if (!changedFiles.length) continue;
    agent.changedFiles = uniqueStrings([...(agent.changedFiles ?? []), ...changedFiles.map((file) => file.path)]);
    agent.commandsRun = uniqueStrings([...(agent.commandsRun ?? []), ...commandRequests.map((request) => request.command)]);
    agent.evidenceRefs = mergeEvidenceRefs(agent.evidenceRefs, changedFiles.map((file) => ({
      type: "file",
      path: file.path,
      category: "owned-change",
      reason: file.explanation,
      linkedAgentId: agent.id
    })));
    agent.status = "running";
    agent.currentAction = "Reviewable changes were attributed from the runtime patch proposal.";
    for (const file of changedFiles) {
      appendAgentJournalEntry(agent, {
        kind: "edited_file",
        title: file.path,
        summary: `Runtime attributed this changed file to the agent contract.`,
        filePath: file.path,
        status: "completed"
      });
    }
    for (const request of commandRequests) {
      appendAgentJournalEntry(agent, {
        kind: "command_requested",
        title: request.command,
        summary: `Verification command was attributed to this agent contract.`,
        command: request.command,
        status: request.status === "blocked" ? "blocked" : "queued"
      });
    }
  }
}

function attachPatchRiskToOwningAgents(session: AgentRuntimeSession, patch: PatchProposal) {
  const fallbackAgentIds = ["agent_local_codex"];
  const owningAgentIds = uniqueStrings(
    patch.filesChanged
      .map((file) => findOwningAgentId(session, file.path))
      .filter(Boolean) as string[]
  );
  for (const agentId of owningAgentIds.length ? owningAgentIds : fallbackAgentIds) {
    updateAgentRunRecord(session, agentId, (agent) => {
      agent.riskRefs = mergeRiskRefs(agent.riskRefs, [{
        id: randomId("risk"),
        agentId,
        filePath: patch.filesChanged[0]?.path,
        lifecycleArea: "integrate_changes",
        severity: patch.riskLevel,
        reason: `${patch.title} is marked ${patch.riskLevel} risk.`,
        mitigation: "Keep the change gated until Rust apply and verification complete.",
        status: "open"
      }]);
    });
  }
}

function summarizePatchStats(files: PatchProposal["filesChanged"]) {
  return {
    fileCount: files.length
  };
}

function createPendingReviewGate(
  session: AgentRuntimeSession,
  verification: VerificationResult,
  patch: PatchProposal,
  commandRequests: CommandRequest[],
  scopeValidation?: AgentRuntimeSession["latestScopeValidation"]
): ReviewGateSummary {
  const gate = buildAttributedReviewGate(session, verification);
  const unresolvedBlockers = [
    "Rust patch apply is still pending.",
    ...(commandRequests.length ? ["Verification commands are queued but have not run yet."] : []),
    ...(scopeValidation?.verdict === "blocked" ? ["Patch is blocked because it leaves the scoped module boundary."] : [])
  ];
  const recommendation =
    scopeValidation?.verdict === "blocked"
      ? "do_not_apply"
      : scopeValidation?.verdict === "needs_review"
        ? "caution"
        : "caution";
  return {
    ...gate,
    scopeValidation,
    riskyAreas: patch.riskLevel === "low" ? gate.riskyAreas : [...new Set([...gate.riskyAreas, `${patch.title} (${patch.riskLevel})`])],
    unresolvedBlockers,
    recommendation,
    summary:
      scopeValidation?.verdict === "blocked"
        ? "Reviewable diff is blocked because it exceeds the scoped module plan."
        : scopeValidation?.verdict === "needs_review"
          ? "Reviewable diff is ready, but scope-sensitive changes require careful review before apply."
          : "Reviewable diff is ready, but Rust apply and verification have not completed yet."
  };
}

function createRunToGreenReviewGate(
  session: AgentRuntimeSession,
  verification: VerificationResult,
  commandRequests: CommandRequest[]
): ReviewGateSummary {
  const gate = buildAttributedReviewGate(session, verification);
  const unresolvedBlockers = commandRequests.length
    ? ["Rust command execution is pending approval or result reporting."]
    : [session.runToGreen?.blockerReason ?? "No grounded run command was found."];
  return {
    ...gate,
    runToGreen: session.runToGreen
      ? {
          status: session.runToGreen.status,
          currentAttempt: session.runToGreen.currentAttempt,
          maxAttempts: session.runToGreen.maxAttempts,
          lastCommand: session.runToGreen.attempts.at(-1)?.command,
          lastDiagnosis: session.runToGreen.attempts.at(-1)?.diagnosis,
          blockerReason: session.runToGreen.blockerReason,
          finalStatus: session.runToGreen.finalStatus
        }
      : undefined,
    unresolvedBlockers,
    recommendation: commandRequests.length ? "caution" : session.previewRecommendation ? "caution" : "do_not_apply",
    summary: commandRequests.length
      ? "Run-to-green is initialized and waiting for command execution results."
      : session.previewRecommendation
        ? "No grounded run command was found, but a preview is available."
        : session.runToGreen?.blockerReason ?? "Run-to-green was blocked before command execution."
  };
}

function createDecisionSummaryByAgent(session: AgentRuntimeSession) {
  const summaries = new Map<string, { agentId?: string; agentName: string; decisionIds: string[] }>();
  for (const record of session.decisionLedger ?? []) {
    const linkedAgentIds = uniqueStrings([
      record.createdByAgentId ?? "",
      ...(record.linkedAgentIds ?? [])
    ]);
    for (const agentId of linkedAgentIds) {
      const agent = session.orchestration?.agentRuns.find((candidate) => candidate.id === agentId);
      const key = agentId || record.createdByAgent;
      const current = summaries.get(key) ?? {
        agentId: agentId || undefined,
        agentName: agent?.displayName ?? agent?.agentName ?? record.createdByAgent,
        decisionIds: []
      };
      current.decisionIds = uniqueStrings([...current.decisionIds, record.id]);
      summaries.set(key, current);
    }
  }
  return [...summaries.values()].map((entry) => ({
    ...entry,
    count: entry.decisionIds.length
  }));
}

function inferRunMode(message: string, snapshot: RepoSnapshot): RunPlanModel["mode"] {
  const normalized = message.toLowerCase();
  const workspaceIntent = snapshot.intentUnderstanding ?? inferWorkspaceIntent(message);
  const explicitEditPattern =
    /\b(change|changing|edit|fix|add|implement|update|wire|build|make|write|replace|rename|delete|remove|modify)\b/;
  const arabicEditPattern = /(غيّر|غير|عدّل|عدل|صلح|أصلح|اضف|أضف|نفذ|اكتب|اعمل|أنشئ|انشئ|ابني|امسح|احذف)/;
  const explainPattern = /\b(explain|inspect|analyze|summarize)\b/.test(normalized) || /(اشرح|حلل|افهم|لخص|راجع)/.test(normalized);
  if (
    (/\b(create|new|scaffold|generate|build me|make a new)\b/.test(normalized) || /(أنشئ|انشئ|اعمل|اكتب).*(مشروع|تطبيق|app|project)/.test(normalized)) &&
    snapshot.intake?.projectKind === "empty_project"
  ) {
    return "create_project";
  }
  if (workspaceIntent.actionMode === "answer_only") {
    return "inspect_only";
  }
  if (
    snapshot.intake?.projectKind === "unknown" &&
    !explicitEditPattern.test(normalized) &&
    !arabicEditPattern.test(normalized)
  ) {
    return "inspect_only";
  }
  if (isLaunchRequest(message)) return "inspect_only";
  if (explainPattern && !explicitEditPattern.test(normalized) && !arabicEditPattern.test(normalized)) return "inspect_only";
  return "edit_project";
}

function isLaunchRequest(message: string): boolean {
  return /\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/i.test(message)
    || /(شغل|ثبت|نزل|افتح).*(المشروع|التطبيق|اللعبة|السيرفر|البروجكت|الأبلكيشن|الابلكيشن)/i.test(message);
}

function inferTargetFiles(message: string, snapshot: RepoSnapshot, mode: RunPlanModel["mode"]) {
  if (mode === "create_project") {
    const base = inferProjectBaseName(message);
    return [`${base}/README.md`, `${base}/package.json`, `${base}/index.html`, `${base}/src/main.js`];
  }
  const normalized = message.toLowerCase();
  const matches = snapshot.candidateFiles.filter((file) => normalized.includes(file.toLowerCase()) || normalized.includes(file.split("/").pop()?.toLowerCase() ?? ""));
  const curated = snapshot.contextPack?.relevantFiles ?? [];
  return (matches.length ? matches : curated.length ? curated : snapshot.candidateFiles.slice(0, 3)).slice(0, 6);
}

function inferSearchQuery(message: string, conversationUnderstanding?: ConversationUnderstanding) {
  const intent = conversationUnderstanding?.workspaceIntent ?? inferWorkspaceIntent(message);
  if (intent.topicTerms.length) {
    return intent.topicTerms.slice(0, 5).join(" ");
  }
  return message
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 5)
    .join(" ") || "project";
}

function inferProjectBaseName(message: string) {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !["create", "new", "make", "build", "project", "app", "with", "for"].includes(word));
  return (words.slice(0, 3).join("-") || "hivo-project").replace(/^-+|-+$/g, "");
}

function inferSimpleFileWriteRequest(message: string): { path: string; content: string } | null {
  const normalized = message.trim();
  const patterns = [
    /\b(?:write|create|make)\s+(?:a\s+)?file\s+([^\s]+)\s+(?:with|containing|that says)\s+([\s\S]+)$/i,
    /\b(?:write|create|make)\s+([^\s]+\.[a-z0-9_-]+)\s+(?:with|containing|that says)\s+([\s\S]+)$/i,
    /(?:اكتب|اعمل|أنشئ|انشئ|اخلق)\s+(?:ملف\s+)?([^\s]+)\s+(?:فيه|به|محتواه|يحتوي(?:\s+على)?)\s+([\s\S]+)$/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1] || !match?.[2]) continue;
    const targetPath = match[1].replace(/^["'`]+|["'`،,؛;]+$/g, "");
    if (!/\.[a-z0-9_-]+$/i.test(targetPath)) continue;
    const content = match[2].replace(/^["'`]+|["'`]+$/g, "");
    return {
      path: targetPath.replaceAll("\\", "/"),
      content: content.endsWith("\n") ? content : `${content}\n`
    };
  }
  return null;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

function formatProviderError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createEmptyOrchestration(session: AgentRuntimeSession): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: session.orchestration?.safetySettings ?? accessProfileDefaults(session.accessProfile),
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}
