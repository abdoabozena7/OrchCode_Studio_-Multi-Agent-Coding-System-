import type {
  AgentRun,
  AgentPlan,
  AgentRuntimeSession,
  Artifact,
  CommandRequest,
  DecisionRecord,
  PatchFileChange,
  PatchProposal,
  ProjectMap,
  ReviewGateSummary,
  RunMode,
  RunPhase,
  RunPhaseId,
  RunPhaseStatus,
  RunSummary,
  RuntimeExecutionMode,
  RuntimeProgressStage,
  ToolIntent,
  VerificationResult
} from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { runPatchIntentSchema, runPlanSchema, runVerificationSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";
import { randomId, SessionManager } from "./SessionManager.js";
import { inferProjectLaunch } from "./ProjectLaunchInference.js";

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
};

type PatchIntentOperation = "create_file" | "replace_range" | "insert_after" | "insert_before" | "delete_range";

type RunPatchIntent = {
  path: string;
  operation: PatchIntentOperation;
  anchorText?: string;
  preimageText?: string;
  replacementText: string;
  reason: string;
  risk: PatchProposal["riskLevel"];
};

type RunPatchIntentModel = {
  title: string;
  summary: string;
  intents: RunPatchIntent[];
  suggestedCommands?: Array<{ command: string; reason: string }>;
};

type RunVerificationModel = {
  summary: string;
  checks: Array<{ name: string; status: "passed" | "failed" | "pending"; detail: string }>;
};

export class RunEngine {
  constructor(
    private readonly provider: LlmProvider,
    private readonly sessionManager: SessionManager
  ) {}

  async runTurn(
    sessionId: string,
    message: string,
    options: {
      resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">;
      projectMap: ProjectMap;
      thinkFirst?: boolean;
    }
  ): Promise<AgentRuntimeSession> {
    const session = this.requireSession(sessionId);
    const runMode = inferLocalRunMode(message, options.resolvedMode);
    const lastMessage = session.messages.at(-1);
    if (lastMessage?.role !== "user" || lastMessage.content !== message) {
      await this.sessionManager.addMessage(sessionId, { role: "user", content: message });
    }

    await this.updateStage(sessionId, "INTAKE", "planning", "running", "Intake", "Clarifying the request and preparing a local run.");
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = "running";
      draft.resolvedExecutionMode = options.resolvedMode;
      draft.agentName = "Local Codex Run";
      draft.runMode = runMode;
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.runPhases = createInitialRunPhases(runMode);
      draft.reviewGate = undefined;
      upsertAgentRunRecord(draft, {
        id: "agent_local_codex",
        sessionId,
        agentName: "Local Codex Run",
        role: "Senior Coding Agent",
        roleTitle: "Coordinator",
        lifecycleStage: "INTAKE",
        objective: message,
        ownedPaths: ["workspace://current"],
        forbiddenPaths: ["tauri://rust-authority", "workspace://outside-current"],
        currentAction: "Clarifying the request and preparing a local run.",
        recentActions: ["Session created", "Run initialized"],
        changedFiles: [],
        commandsRun: [],
        riskLevel: "medium",
        blockers: [],
        diffStats: { fileCount: 0 },
        currentTask: "Prepare run",
        status: "running",
        lastEvent: "Run initialized",
        startedAt: draft.createdAt
      });
    });
    await this.updateRunPhase(sessionId, "inspect_workspace", "active", "Inspecting workspace structure and task intent.");

    const tools = new ToolRegistry(session.workspacePath);
    await this.addIntent(sessionId, "workspace.snapshot.requested", "Workspace snapshot", "Inspect project shape without changing files.", {
      workspacePath: session.workspacePath
    }, "executed");
    const snapshot = createSnapshot(tools, options.projectMap, message);
    await this.addDecisionRecord(sessionId, {
      category: "finding",
      finding: "Workspace inspection completed before any write proposal.",
      decision: "Use the repo snapshot as the source of truth for planning.",
      rationaleSummary: snapshot.summary,
      evidenceRefs: snapshot.importantFiles.slice(0, 3).map((file) => ({ type: "file" as const, path: file, note: "Important workspace file" })),
      linkedFiles: snapshot.importantFiles.slice(0, 6),
      createdByAgent: "Local Codex Run"
    });
    await this.updateStage(sessionId, "CONTEXT_GATHER", "inspecting", "completed", "Workspace snapshot", snapshot.summary);
    await this.updateRunPhase(sessionId, "inspect_workspace", "completed", snapshot.summary, snapshot.fileSamples.length);
    await this.updateRunPhase(sessionId, "build_repo_map", "completed", `Mapped ${snapshot.importantFiles.length} important file(s) and ${snapshot.searchResults.length} search hit(s).`, snapshot.searchResults.length);

    await this.addIntent(sessionId, "workspace.search.requested", "Search request", "Identify likely files and project entry points.", {
      query: inferSearchQuery(message),
      importantFiles: snapshot.importantFiles
    }, "executed");

    const plan = await this.createPlan(session, message, snapshot, options.resolvedMode);
    const agentPlan = toAgentPlan(plan);
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.plan = agentPlan;
      draft.tasks = plan.tasks.map((task, index) => ({
        id: task.id ?? `task_${index + 1}`,
        sessionId,
        title: task.title,
        status: "todo",
        agentRole: task.roleTitle,
        createdAt: new Date().toISOString()
      }));
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
    await this.addArtifact(sessionId, "plan", "Run plan", plan.summary, {
      plan,
      preset: options.resolvedMode
    });
    await this.addDecisionRecord(sessionId, {
      category: "decision",
      finding: "The request has enough local evidence to move into planning.",
      decision: `Selected ${runMode} as the local run mode and created a bounded implementation plan.`,
      rationaleSummary: plan.reasoningSummary || plan.summary,
      evidenceRefs: [],
      linkedFiles: plan.tasks.flatMap((task) => task.targetFiles ?? []).slice(0, 8),
      uncertainty: plan.risks[0],
      createdByAgent: "Local Codex Run"
    });
    await this.updateStage(sessionId, "PLAN", "planning", "completed", "Plan", plan.reasoningSummary || plan.summary);
    await this.updateRunPhase(sessionId, "split_agents", "completed", `Prepared ${plan.tasks.length} work item(s) for the local run.`, plan.tasks.length);

    if (options.thinkFirst) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "needs_approval";
        draft.lifecycleStage = "PLAN";
        draft.nextAction = { kind: "confirm_plan", message: "Plan is ready. Want me to proceed with implementation?" };
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: `I prepared the run plan and stopped before action.\n\n${plan.summary}`
      });
      await this.updateRunPhase(sessionId, "review_final_diff", "active", "Plan is waiting for operator confirmation before implementation.");
      return this.requireSession(sessionId);
    }

    if (isLaunchRequest(message)) {
      const recommendation = inferProjectLaunch(session.workspacePath, tools.workspace);
      const commandRequests = recommendation?.command
        ? createCommandRequests(sessionId, session.workspacePath, [{ command: recommendation.command, reason: recommendation.reason }], [])
        : [];
      for (const request of commandRequests) {
        await this.addIntent(sessionId, "command.requested", request.command, request.reason, { commandRequestId: request.id, risk: request.risk }, request.status === "blocked" ? "blocked" : "proposed");
        await this.sessionManager.addCommandRequest(sessionId, request);
      }
      const verification = await this.createVerification(sessionId, "Launch verification is pending until Rust runs the approved command.", [
        { name: "Launch path inferred", status: recommendation ? "passed" : "failed", detail: recommendation?.reason ?? "No launch path was found." },
        { name: "Rust command execution", status: commandRequests.length ? "pending" : "failed", detail: commandRequests[0]?.command ?? "No command to execute." }
      ]);
      await this.addIntent(sessionId, "validation.requested", "Launch verification", verification.summary, { verificationId: verification.id }, commandRequests.length ? "proposed" : "blocked");
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = commandRequests.length ? "needs_approval" : "failed";
        draft.lifecycleStage = commandRequests.length ? "APPROVAL" : "FAILED";
        draft.reasoningSummaries.push("I inferred a launch command but left execution to Rust command authority.");
        draft.previewRecommendation = recommendation?.preview;
        draft.nextAction = commandRequests.length
          ? { kind: "approve_commands", message: "Approve the launch command to run it through Rust." }
          : undefined;
      });
      await this.updateRunPhase(sessionId, "agents_running", "completed", "Inspection completed and launch path prepared.");
      await this.updateRunPhase(sessionId, "run_verification", commandRequests.length ? "active" : "failed", verification.summary, verification.checks.length);
      await this.updateRunPhase(sessionId, "review_final_diff", commandRequests.length ? "active" : "blocked", commandRequests.length ? "Command review is waiting for operator approval." : "No safe launch command was found.");
      await this.updateRunPhase(sessionId, "final_report", commandRequests.length ? "active" : "completed", commandRequests.length ? "Run is blocked on command approval." : "Launch inference failed.");
      await this.sessionManager.setRunSummary(sessionId, {
        status: commandRequests.length ? "blocked" : "failed",
        summary: recommendation ? `Prepared launch command: ${recommendation.command}` : "No launch command could be inferred.",
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: commandRequests.map((request) => `${request.command}: ${request.status}`),
        gates: verification.checks.map((check) => ({ name: check.name, status: check.status === "failed" ? "failed" : "passed", notes: [check.detail] })),
        nextAction: commandRequests.length ? "Approve the command, then inspect the command result artifact." : "Add a package script or tell me the launch command.",
        createdAt: new Date().toISOString()
      });
      await this.sessionManager.addMessage(sessionId, {
        role: "assistant",
        content: recommendation
          ? `I found a launch path and prepared it for approval.\n\nCommand: \`${recommendation.command}\`\n\nReasoning summary: ${recommendation.reason}`
          : "I inspected the workspace, but I could not infer a launch command."
      });
      await this.updateStage(sessionId, commandRequests.length ? "APPROVAL" : "FAILED", "reviewing", commandRequests.length ? "completed" : "failed", "Launch command", recommendation?.reason ?? "No launch command inferred.");
      return this.requireSession(sessionId);
    }

    if (plan.mode === "inspect_only") {
      const verification = await this.createVerification(sessionId, "No file changes requested.", [
        { name: "Workspace inspected", status: "passed", detail: snapshot.summary },
        { name: "Patch required", status: "passed", detail: "No patch was required for this request." }
      ]);
      await this.finish(sessionId, "completed", "DONE", {
        status: "completed",
        summary: plan.summary,
        filesChanged: [],
        appliedPatchIds: [],
        proposedPatchIds: [],
        commandResults: [],
        gates: verification.checks.map((check) => ({ name: check.name, status: check.status === "failed" ? "failed" : "passed", notes: [check.detail] })),
        nextAction: "Ask for a concrete edit or creation task when you want code changes.",
        createdAt: new Date().toISOString()
      });
      await this.updateRunPhase(sessionId, "agents_running", "completed", "Inspection-only run completed without file changes.");
      await this.updateRunPhase(sessionId, "final_report", "completed", "Inspection-only report is ready.");
      await this.sessionManager.addMessage(sessionId, { role: "assistant", content: `${plan.summary}\n\n${plan.reasoningSummary}` });
      return this.requireSession(sessionId);
    }

    await this.updateStage(sessionId, "EXECUTION_DRAFT", "working", "running", "Draft changes", "Preparing reviewable patch and command intents.");
    await this.updateRunPhase(sessionId, "agents_running", "active", "Preparing bounded edits, evidence, and verification intents.");
    const patchIntentModel = await this.createPatchIntent(session, message, snapshot, plan);
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
    await this.addDecisionRecord(sessionId, {
      category: "decision",
      finding: "A reviewable patch proposal is available.",
      decision: "Stop before writing files and route the change through Rust approval/apply authority.",
      rationaleSummary: patch.summary,
      evidenceRefs: patch.filesChanged.map((file) => ({ type: "file" as const, path: file.path, note: file.explanation })).slice(0, 8),
      linkedFiles: patch.filesChanged.map((file) => file.path),
      uncertainty: patch.riskLevel === "high" ? "High-risk patch proposal; verify carefully before apply." : undefined,
      createdByAgent: "Local Codex Run"
    });
    await this.updateRunPhase(sessionId, "integrate_changes", "completed", `Prepared ${patch.filesChanged.length} file change(s) for review.`, patch.filesChanged.length);

    const commandRequests = createCommandRequests(sessionId, session.workspacePath, patchIntentModel.suggestedCommands ?? plan.suggestedCommands ?? [], snapshot.testCommands);
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
      draft.reviewGate = createPendingReviewGate(draft, verification, patch, commandRequests);
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
        agent.changedFiles = patch.filesChanged.map((file) => file.path);
        agent.commandsRun = commandRequests.map((request) => request.command);
        agent.diffStats = summarizePatchStats(patch.filesChanged);
        agent.recentActions = appendRecentAction(agent.recentActions, `Prepared patch: ${patch.title}`);
        agent.recentActions = appendRecentAction(agent.recentActions, `Queued ${commandRequests.length} verification command(s)`);
      });
    });

    const summary = createRunSummary(this.requireSession(sessionId), verification);
    await this.updateRunPhase(sessionId, "review_final_diff", "active", "Review the proposed diff and queued verification before apply.");
    await this.updateRunPhase(sessionId, "final_report", "active", "Run is waiting for review and Rust authority actions.");
    await this.sessionManager.setRunSummary(sessionId, summary);
    await this.sessionManager.addMessage(sessionId, {
      role: "assistant",
      content: formatAssistantSummary(plan, patch, commandRequests)
    });
    await this.updateStage(sessionId, "APPROVAL", "reviewing", "completed", "Approval", "Review changes, then apply through Rust.");
    return this.requireSession(sessionId);
  }

  private async createPlan(session: AgentRuntimeSession, message: string, snapshot: RepoSnapshot, resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">): Promise<RunPlanModel> {
    const prompt = [
      "Create a concise JSON plan for a local coding agent.",
      "Do not include hidden chain-of-thought. Use reasoningSummary for a short user-visible rationale.",
      "Return JSON with: summary, reasoningSummary, mode(create_project|edit_project|inspect_only), tasks, acceptanceCriteria, risks, suggestedCommands.",
      `Runtime preset: ${resolvedMode}`,
      `User request: ${message}`,
      `Workspace snapshot: ${JSON.stringify(snapshot)}`
    ].join("\n");
    const generated = await this.provider.generateStructured<Partial<RunPlanModel>>(
      { systemPrompt: "You are a local coding run planner for an Ollama-backed Codex-like desktop agent.", userPrompt: prompt },
      runPlanSchema
    );
    return normalizePlan(generated, message, snapshot);
  }

  private async createPatchIntent(session: AgentRuntimeSession, message: string, snapshot: RepoSnapshot, plan: RunPlanModel): Promise<RunPatchIntentModel> {
    if (session.mode === "demo_mock") {
      return createDemoPatchIntent(message, snapshot, plan);
    }
    const relevantFiles = collectRelevantFilesForPatch(snapshot, plan);
    const prompt = [
      "Create a reviewable patch intent as JSON for a local coding agent.",
      "For existing files, do not return full file contents.",
      "Return JSON with: title, summary, intents[{path,operation,anchorText?,preimageText?,replacementText,reason,risk}], suggestedCommands.",
      "Allowed operations: create_file, replace_range, insert_after, insert_before, delete_range.",
      "For this runtime version, prefer create_file for new files and replace_range for existing files.",
      "When using replace_range, choose a preimageText snippet that appears exactly once in the current file excerpt.",
      `User request: ${message}`,
      `Plan: ${JSON.stringify(plan)}`,
      `Workspace snapshot: ${JSON.stringify(snapshot)}`,
      `Relevant file excerpts: ${JSON.stringify(relevantFiles)}`
    ].join("\n");
    const generated = await this.provider.generateStructured<Partial<RunPatchIntentModel>>(
      { systemPrompt: "You produce structured patch intents for unified diff proposals. Return strict JSON only.", userPrompt: prompt },
      runPatchIntentSchema
    );
    const validation = validateStructuredOutput(generated, runPatchIntentSchema);
    if (!validation.valid) {
      throw new Error(`Patch intent validation failed: ${validation.errors.join("; ")}`);
    }
    return normalizePatchIntent(generated, message, snapshot, plan);
  }

  private async createVerification(sessionId: string, summary: string, checks: VerificationResult["checks"]) {
    const verification: VerificationResult = {
      id: randomId("verification"),
      sessionId,
      status: checks.some((check) => check.status === "failed") ? "failed" : checks.some((check) => check.status === "pending") ? "pending" : "passed",
      summary,
      checks,
      createdAt: new Date().toISOString()
    };
    await this.sessionManager.setVerificationResult(sessionId, verification);
    await this.addArtifact(sessionId, "verification", "Verification", summary, { verification });
    return verification;
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
      payload,
      createdAt: new Date().toISOString()
    });
  }

  private async addDecisionRecord(
    sessionId: string,
    input: Omit<DecisionRecord, "id" | "sessionId" | "createdAt">
  ) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.decisionLedger.push({
        id: randomId("decision"),
        sessionId,
        createdAt: new Date().toISOString(),
        ...input
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
    summary: string
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
      role: "Local Codex",
      taskTitle,
      summary,
      targetFiles: [],
      createdAt: new Date().toISOString()
    });
  }

  private async finish(sessionId: string, status: AgentRuntimeSession["status"], stage: AgentRuntimeSession["lifecycleStage"], summary: RunSummary) {
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.status = status;
      draft.lifecycleStage = stage;
      updateAgentRunRecord(draft, "agent_local_codex", (agent) => {
        agent.status = status === "failed" ? "failed" : status === "needs_approval" ? "blocked" : "completed";
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

type RepoSnapshot = {
  summary: string;
  stack: string[];
  packageManagers: string[];
  testCommands: string[];
  importantFiles: string[];
  candidateFiles: string[];
  searchResults: Array<{ path: string; line: number; preview: string }>;
  fileSamples: Array<{ path: string; reason: string; excerpt: string }>;
};

function createSnapshot(tools: ToolRegistry, projectMap: ProjectMap, message: string): RepoSnapshot {
  const files = tools.workspace.listFiles(260);
  const candidateFiles = files
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path)
    .filter((file) => /\.(ts|tsx|js|jsx|rs|py|css|html|md|json|toml)$/i.test(file))
    .slice(0, 60);
  const searchResults = tools.workspace.searchCode(inferSearchQuery(message), 12);
  const normalizedMessage = message.toLowerCase();
  const matchedFiles = candidateFiles.filter((file) => normalizedMessage.includes(file.toLowerCase()) || normalizedMessage.includes(file.split("/").pop()?.toLowerCase() ?? ""));
  const samplePaths = [...new Set([...matchedFiles, ...searchResults.map((match) => match.path), ...projectMap.importantFiles, ...candidateFiles.slice(0, 3)])].slice(0, 6);
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
    summary: `${stack.join(", ")} workspace with ${candidateFiles.length} candidate source/config file(s), ${searchResults.length} search hit(s), and ${fileSamples.length} file sample(s).`,
    stack,
    packageManagers: projectMap.packageManagers,
    testCommands: projectMap.testCommands,
    importantFiles: projectMap.importantFiles,
    candidateFiles,
    searchResults,
    fileSamples
  };
}

function normalizePlan(input: Partial<RunPlanModel>, message: string, snapshot: RepoSnapshot): RunPlanModel {
  const mode = input.mode ?? inferRunMode(message);
  const targetFiles = inferTargetFiles(message, snapshot, mode);
  const tasks = input.tasks?.length
    ? input.tasks
    : [
        {
          title: mode === "create_project" ? "Create initial project files" : mode === "inspect_only" ? "Inspect workspace" : "Prepare focused edit",
          objective: message,
          roleTitle: mode === "create_project" ? "Project Scaffolder" : "Implementation Worker",
          targetFiles,
          expectedArtifact: mode === "inspect_only" ? "Workspace explanation" : "Reviewable diff",
          verification: snapshot.testCommands[0] ?? "git diff --check"
        }
      ];
  return {
    summary: input.summary || (mode === "create_project" ? "Create a new local project as reviewable files." : "Prepare a reviewable local code change."),
    reasoningSummary: input.reasoningSummary || "I will keep the run gated: inspect first, propose artifacts, then wait for Rust-mediated approval.",
    mode,
    tasks: tasks.map((task, index) => ({
      ...task,
      id: task.id ?? `task_${index + 1}`,
      targetFiles: task.targetFiles?.length ? task.targetFiles : targetFiles
    })),
    acceptanceCriteria: input.acceptanceCriteria?.length ? input.acceptanceCriteria : ["Changes are reviewable before apply.", "Post-verify is explicit."],
    risks: input.risks ?? [],
    suggestedCommands: input.suggestedCommands
  };
}

function normalizePatchIntent(input: Partial<RunPatchIntentModel>, message: string, snapshot: RepoSnapshot, plan: RunPlanModel): RunPatchIntentModel {
  if (input.intents?.length) {
    return {
      title: input.title || "Ollama patch intent proposal",
      summary: input.summary || `Prepared changes for: ${message}`,
      intents: input.intents,
      suggestedCommands: input.suggestedCommands
    };
  }
  return createDemoPatchIntent(message, snapshot, plan);
}

function createDemoPatchIntent(message: string, snapshot: RepoSnapshot, plan: RunPlanModel): RunPatchIntentModel {
  if (plan.mode === "create_project") {
    const base = inferProjectBaseName(message);
    return {
      title: "Create local project scaffold",
      summary: "Creates a small starter project with README, package metadata, and source entry.",
      intents: [
        { path: `${base}/README.md`, operation: "create_file", replacementText: `# ${base}\n\nGenerated starter project for: ${message}\n\n## Run\n\nnpm install\nnpm run dev\n`, reason: "Project instructions.", risk: "low" },
        { path: `${base}/package.json`, operation: "create_file", replacementText: JSON.stringify({ scripts: { dev: "vite --host 127.0.0.1", test: "echo \"No tests yet\"" }, dependencies: {}, devDependencies: { vite: "^6.0.0", typescript: "^5.8.3" } }, null, 2) + "\n", reason: "Local npm scripts.", risk: "medium" },
        { path: `${base}/index.html`, operation: "create_file", replacementText: "<!doctype html>\n<html><head><title>Local App</title></head><body><main id=\"app\"></main><script type=\"module\" src=\"./src/main.js\"></script></body></html>\n", reason: "Browser entry.", risk: "low" },
        { path: `${base}/src/main.js`, operation: "create_file", replacementText: `document.querySelector("#app").innerHTML = "<h1>${escapeHtml(message)}</h1><p>Local Ollama scaffold ready.</p>";\n`, reason: "Application entry.", risk: "low" }
      ],
      suggestedCommands: [{ command: `cd ${base} && npm install`, reason: "Install starter project dependencies after approval." }]
    };
  }
  const target = plan.tasks.flatMap((task) => task.targetFiles ?? [])[0] ?? snapshot.candidateFiles[0] ?? "AGENT_PROPOSAL.md";
  return {
    title: "Reviewable implementation note",
    summary: "Creates a concrete note artifact for the requested edit. Use real_provider for code-specific edits.",
    intents: [
      {
        path: target === "AGENT_PROPOSAL.md" ? target : "AGENT_PROPOSAL.md",
        operation: "create_file",
        replacementText: `# Agent Proposal\n\nRequest: ${message}\n\nPlan: ${plan.summary}\n\nWorkspace: ${snapshot.summary}\n\nNext: approve this artifact or rerun with a validated Ollama model for code-specific generation.\n`,
        reason: "Records the requested change as a gated artifact.",
        risk: "low"
      }
    ],
    suggestedCommands: [{ command: snapshot.testCommands[0] ?? "git diff --check", reason: "Validate the approved patch." }]
  };
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

  if (intent.operation !== "replace_range") {
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
  const updated = `${current.slice(0, match.start)}${intent.replacementText}${current.slice(match.end)}`;
  return {
    path: intent.path,
    changeType: "modify",
    explanation: intent.reason,
    content: updated,
    unifiedDiff: createReplaceRangeDiff(intent.path, current, updated, match.start, match.end)
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
  const oldStartLineIndex = lineIndexAt(before, start);
  const oldEndLineIndex = lineIndexAt(before, Math.max(start, end - 1));
  const replacementLength = after.length - before.length + (end - start);
  const newEndExclusive = start + replacementLength;
  const newStartLineIndex = lineIndexAt(after, Math.min(start, after.length));
  const newEndLineIndex = lineIndexAt(after, Math.max(start, Math.min(newEndExclusive - 1, Math.max(after.length - 1, 0))));
  const contextBeforeCount = Math.min(2, oldStartLineIndex);
  const contextAfterCount = Math.min(2, beforeLines.length - oldEndLineIndex - 1);
  const oldSliceStart = oldStartLineIndex - contextBeforeCount;
  const oldSliceEnd = oldEndLineIndex + contextAfterCount;
  const newSliceStart = Math.max(0, newStartLineIndex - contextBeforeCount);
  const newSliceEnd = Math.min(afterLines.length - 1, newEndLineIndex + contextAfterCount);
  const oldChangedCount = oldEndLineIndex - oldStartLineIndex + 1;
  const newChangedCount = newEndLineIndex - newStartLineIndex + 1;

  const hunkLines = [
    ...beforeLines.slice(oldSliceStart, oldStartLineIndex).map((line) => ` ${line}`),
    ...beforeLines.slice(oldStartLineIndex, oldStartLineIndex + oldChangedCount).map((line) => `-${line}`),
    ...afterLines.slice(newStartLineIndex, newStartLineIndex + newChangedCount).map((line) => `+${line}`),
    ...afterLines.slice(newEndLineIndex + 1, newSliceEnd + 1).map((line) => ` ${line}`)
  ];

  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldSliceStart + 1},${oldSliceEnd - oldSliceStart + 1} +${newSliceStart + 1},${newSliceEnd - newSliceStart + 1} @@`,
    ...hunkLines
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

function createCommandRequests(sessionId: string, workspacePath: string, suggested: Array<{ command: string; reason: string }>, fallbackCommands: string[]): CommandRequest[] {
  const commands = suggested.length ? suggested : fallbackCommands.slice(0, 1).map((command) => ({ command, reason: "Validate the approved change." }));
  return commands.slice(0, 3).map((item) => {
    const risk = classifyCommandRisk(item.command, workspacePath);
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
        requestedBy: "RunEngine",
        reason: item.reason
      },
      status: risk === "dangerous" ? "blocked" : "requested",
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

function createRunSummary(session: AgentRuntimeSession, verification: VerificationResult): RunSummary {
  return {
    status:
      verification.status === "failed"
        ? "failed"
        : verification.status === "pending"
          ? "blocked"
          : "completed",
    summary: verification.summary,
    filesChanged: session.patchProposals.flatMap((patch) => patch.filesChanged.map((file) => ({ path: file.path, added: 0, removed: 0, changeType: file.changeType }))),
    appliedPatchIds: session.patchProposals.filter((patch) => patch.status === "applied").map((patch) => patch.id),
    proposedPatchIds: session.patchProposals.filter((patch) => patch.status !== "applied").map((patch) => patch.id),
    commandResults: session.commandRequests.map((request) => `${request.command}: ${request.status}`),
    gates: verification.checks.map((check) => ({ name: check.name, status: check.status === "failed" ? "failed" : "passed", notes: [check.detail] })),
    nextAction: "Review changes, then apply and run verification through Rust.",
    createdAt: new Date().toISOString()
  };
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

function inferLocalRunMode(message: string, resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">): RunMode {
  const normalized = message.toLowerCase();
  if (/\b(paranoid|double check|double-check|review twice)\b/.test(normalized)) return "paranoid_mode";
  if (/\b(soak|stability|burn in|burn-in|retry a lot)\b/.test(normalized)) return "soak_mode";
  if (/\b(audit|deep|inspect thoroughly|thorough|analyze deeply)\b/.test(normalized)) return "deep_audit";
  if (resolvedMode === "simple_mode" && /\b(tiny|small|quick|minor)\b/.test(normalized)) return "quick_fix";
  return "normal_run";
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

function summarizePatchStats(files: PatchProposal["filesChanged"]) {
  return {
    fileCount: files.length
  };
}

function createPendingReviewGate(
  session: AgentRuntimeSession,
  verification: VerificationResult,
  patch: PatchProposal,
  commandRequests: CommandRequest[]
): ReviewGateSummary {
  return {
    totalFilesChanged: patch.filesChanged.length,
    changesByAgent: [],
    riskyAreas: patch.riskLevel === "low" ? [] : [`${patch.title} (${patch.riskLevel})`],
    verificationChecks: verification.checks,
    unresolvedBlockers: [
      "Rust patch apply is still pending.",
      ...(commandRequests.length ? ["Verification commands are queued but have not run yet."] : [])
    ],
    recommendation: "caution",
    summary: "Reviewable diff is ready, but Rust apply and verification have not completed yet."
  };
}

function formatAssistantSummary(plan: RunPlanModel, patch: PatchProposal, commands: CommandRequest[]) {
  const lines = [
    plan.summary,
    "",
    "Prepared artifacts:",
    `- Patch: ${patch.title} (${patch.filesChanged.length} file(s))`,
    ...commands.map((command) => `- Command: ${command.command} (${command.risk})`),
    "",
    "Review the diff before applying. Rust owns the actual file write and command execution."
  ];
  return lines.join("\n");
}

function inferRunMode(message: string): RunPlanModel["mode"] {
  const normalized = message.toLowerCase();
  if (/\b(create|new|scaffold|generate|build me|make a new)\b/.test(normalized)) return "create_project";
  if (isLaunchRequest(message)) return "inspect_only";
  if (/\b(explain|inspect|analyze|summarize)\b/.test(normalized) && !/\b(change|edit|fix|add|create)\b/.test(normalized)) return "inspect_only";
  return "edit_project";
}

function isLaunchRequest(message: string): boolean {
  return /\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/i.test(message);
}

function inferTargetFiles(message: string, snapshot: RepoSnapshot, mode: RunPlanModel["mode"]) {
  if (mode === "create_project") {
    const base = inferProjectBaseName(message);
    return [`${base}/README.md`, `${base}/package.json`, `${base}/index.html`, `${base}/src/main.js`];
  }
  const normalized = message.toLowerCase();
  const matches = snapshot.candidateFiles.filter((file) => normalized.includes(file.toLowerCase()) || normalized.includes(file.split("/").pop()?.toLowerCase() ?? ""));
  return (matches.length ? matches : snapshot.candidateFiles.slice(0, 3)).slice(0, 6);
}

function inferSearchQuery(message: string) {
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
  return (words.slice(0, 3).join("-") || "orchcode-project").replace(/^-+|-+$/g, "");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char] ?? char);
}

function createEmptyOrchestration(session: AgentRuntimeSession): NonNullable<AgentRuntimeSession["orchestration"]> {
  return {
    agentRuns: [],
    workerOutputs: [],
    securityReviews: [],
    reviewerSummaries: [],
    orchestrationEvents: [],
    approvalDecisions: [],
    safetySettings: session.orchestration?.safetySettings ?? {
      maxParallelAgents: 3,
      autoRunSafeCommands: false,
      requireApprovalForPatches: true,
      autoApplyValidatedPatches: false,
      blockDangerousCommands: true,
      redactSecrets: true,
      allowNetworkCommands: false
    },
    lockedFiles: {},
    selectedWorkerAgents: [],
    mandatoryGateAgents: [],
    workOrders: [],
    qualityGateResults: [],
    retryCount: 0
  };
}
