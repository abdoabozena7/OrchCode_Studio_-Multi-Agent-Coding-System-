import type {
  AgentRuntimeSession,
  ProjectMap,
  RuntimeSessionStatus
} from "@hivo/protocol";
import { accessProfileDefaults } from "@hivo/protocol";
import { readFile } from "node:fs/promises";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import { SwarmAutopilotRuntime } from "../orchestration/SwarmRuntime.js";
import { classifyRunIntent } from "./ProjectIntake.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import type { RuntimeRunEngineService } from "./RuntimeRunEngineService.js";
import { detectResponseLanguage } from "./RuntimeTextUtils.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeProviderBackedSwarmInput = {
  sessionId: string;
  message: string;
  provider: LlmProvider;
  providerTelemetry: ProviderTelemetryRecorder;
  projectMap: ProjectMap;
  conversationUnderstanding?: ConversationUnderstanding;
};

export class RuntimeProviderBackedSwarmService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly runEngineService: RuntimeRunEngineService
  ) {}

  async run(input: RuntimeProviderBackedSwarmInput): Promise<AgentRuntimeSession> {
    const { sessionId, message, provider, providerTelemetry, projectMap, conversationUnderstanding } = input;
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
      draft.responseLanguage = conversationUnderstanding?.intentDecision.language === "arabic" ? "ar" : detectResponseLanguage(message);
      draft.orchestration ??= createEmptyOrchestration(draft);
      draft.reasoningSummaries.push("Real-provider orchestration is using provider-backed read-only swarm workers; deterministic mock workers are not accepted as the assistant answer.");
    });

    const swarmGoal = conversationUnderstanding?.workspaceMessage || message;
    const responseLanguage = conversationUnderstanding?.intentDecision.language === "arabic" ? "ar" : (session.responseLanguage ?? detectResponseLanguage(swarmGoal));
    const swarm = new SwarmAutopilotRuntime({
      workspacePath: session.workspacePath,
      mode: "deep",
      providerFactory: () => provider,
      providerName: session.providerConfig?.providerName,
      modelName: session.providerConfig?.selectedModel,
      responseLanguage
    });
    const result = await swarm.run(swarmGoal);
    const workResults = await loadSwarmWorkResults(result.workItems);
    const terminalStatus = mapSwarmRunStatus(result.run.status, providerTelemetry.snapshot().lastError);
    const shouldHandoffToLocalRun = shouldHandoffProviderReadOnlySwarmToLocalRun({
      prompt: swarmGoal,
      terminalStatus,
      workItems: result.workItems,
      workResults,
      conversationUnderstanding
    });
    const completedAt = new Date().toISOString();
    const summary = formatProviderBackedSwarmAnswer({
      finalReport: result.finalReport,
      debugMode: session.debugMode === true,
      providerCallCount: providerTelemetry.snapshot().providerRequestCount,
      workerCount: result.staffingPlan.recommended_total_logical_agents,
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
            "workerMode=provider_read_only",
            `providerRequests=${providerTelemetry.snapshot().providerRequestCount}`,
            `providerFailures=${providerTelemetry.snapshot().providerFailureCount}`,
            `providerTimeouts=${providerTelemetry.snapshot().providerTimeoutCount}`,
            `invalidStructuredOutputs=${result.metrics.invalid_structured_outputs}`,
            `retries=${result.metrics.retries}`,
            `finalResponseSource=${providerTelemetry.snapshot().finalResponseSource}`
          ]
        }],
        nextAction: terminalStatus === "completed" ? "Provider-backed session update completed." : "Inspect provider and swarm worker artifacts before retrying.",
        createdAt: completedAt
      };
      draft.responseLanguage = responseLanguage;
    });

    if (shouldHandoffToLocalRun) {
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.status = "running";
        draft.lifecycleStage = "EXECUTION_DRAFT";
        draft.agentName = "Provider-Backed Swarm + Local Run";
        draft.reasoningSummaries.push(
          "Provider-backed read-only swarm completed the multi-agent preflight, then handed write-capable execution to the gated local run path because provider-backed swarm workers cannot edit files."
        );
        if (draft.runSummary) {
          draft.runSummary.nextAction = "Continue through the gated local RunEngine patch proposal path.";
          draft.runSummary.gates.push({
            name: "Read-only swarm handoff",
            status: "passed",
            notes: [
              "Provider-backed swarm is read-only by design.",
              "Write-capable execution is continuing through RunEngine, patch approval, and validation gates."
            ]
          });
        }
      });
      const localRun = await this.runEngineService.run({
        sessionId,
        prompt: swarmGoal,
        provider,
        providerTelemetry,
        resolvedMode: "orchestrated_mode",
        projectMap,
        thinkFirst: false,
        conversationUnderstanding
      });
      await this.sessionManager.updateSession(sessionId, (draft) => {
        draft.resolvedExecutionMode = "orchestrated_mode";
        draft.agentName = "Provider-Backed Swarm + Local Run";
        draft.reasoningSummaries.push("Read-only swarm staffing artifacts remain available while RunEngine owns the reviewable write proposal.");
        if (draft.runSummary && !draft.runSummary.gates.some((gate) => gate.name === "Read-only swarm handoff")) {
          draft.runSummary.gates.unshift({
            name: "Read-only swarm handoff",
            status: "passed",
            notes: [
              "Provider-backed swarm is read-only by design.",
              "Write-capable execution continued through RunEngine, patch approval, and validation gates."
            ]
          });
        }
      });
      return this.sessionManager.getSession(localRun.id) ?? localRun;
    }

    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: summary
    });
    return this.sessionManager.getSession(sessionId)!;
  }
}

async function loadSwarmWorkResults(workItems: Array<{ result_ref?: string }>) {
  const results: Array<{
    work_item_id: string;
    status: "succeeded" | "failed" | "blocked";
    summary: string;
    relevant_files: string[];
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
        relevant_files: Array.isArray(parsed.relevant_files) ? parsed.relevant_files.filter((entry: unknown): entry is string => typeof entry === "string") : [],
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

function shouldHandoffProviderReadOnlySwarmToLocalRun(input: {
  prompt: string;
  terminalStatus: RuntimeSessionStatus;
  workItems: Array<{ type?: string; status?: string; required_role?: string }>;
  workResults: Array<{ status: string; summary: string; findings: string[]; risks: string[]; unknowns: string[] }>;
  conversationUnderstanding?: ConversationUnderstanding;
}) {
  const isFileCreation = /\b(create|build|make|write|generate|implement)\b/i.test(input.prompt)
    && /\b(file|game|app|page|html|component|feature|system|module|project)\b/i.test(input.prompt);
  if (!isFileCreation && input.terminalStatus !== "blocked") return false;
  const runIntent = classifyRunIntent(input.prompt, input.conversationUnderstanding);
  const actionKind = input.conversationUnderstanding?.intentDecision.kind;
  const wantsWriteOrRun =
    actionKind === "workspace_action" ||
    actionKind === "run_request" ||
    runIntent === "implement_module" ||
    runIntent === "run_to_green" ||
    runIntent === "run_once" ||
    /\b(build|create|implement|add|make|write|scaffold|generate|run|start|launch|serve)\b/i.test(input.prompt) ||
    /(?:\u0627\u0628\u0646|\u0627\u0628\u0646\u064a|\u0627\u0639\u0645\u0644|\u0627\u0646\u0634\u0626|\u0623\u0646\u0634\u0626|\u0646\u0641\u0630|\u0634\u063a\u0644|\u0627\u0628\u062f\u0623|\u0636\u064a\u0641|\u0627\u0643\u062a\u0628)/.test(input.prompt);
  if (!wantsWriteOrRun) return false;

  const blockedWriteWorkItem = input.workItems.some((item) =>
    item.status === "blocked" &&
    (item.type === "execute" || item.type === "integrate" || /Executor|Integrator/i.test(item.required_role ?? ""))
  );
  const readOnlyWorkerBlock = input.workResults.some((result) => {
    const text = [
      result.summary,
      ...result.findings,
      ...result.risks,
      ...result.unknowns
    ].join("\n");
    return /provider-backed read-only worker (?:rejects|cannot handle)|provider-backed worker rejects write-capable|cannot handle work items with write files/i.test(text);
  });

  if (isFileCreation) return true;
  return blockedWriteWorkItem && readOnlyWorkerBlock;
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
  debugMode: boolean;
  providerCallCount: number;
  workerCount: number;
  status: RuntimeSessionStatus;
  providerFailures: number;
  providerTimeouts: number;
  invalidStructuredOutputs: number;
  retries: number;
}) {
  const body = input.finalReport.trim() || formatDebugSwarmHeading(input.status);
  if (!input.debugMode) return body;
  return [
    formatDebugSwarmHeading(input.status),
    "",
    body,
    "",
    formatCompactRuntimeTruth(input)
  ].join("\n");
}

function formatDebugSwarmHeading(status: RuntimeSessionStatus) {
  if (status === "completed") return "Provider-backed swarm completed successfully.";
  if (status === "blocked") return "Provider-backed swarm blocked before producing an accepted answer.";
  if (status === "failed_provider") return "Provider-backed swarm failed because the model provider failed.";
  return "Provider-backed swarm failed before producing an accepted answer.";
}

function formatCompactRuntimeTruth(input: {
  providerCallCount: number;
  workerCount: number;
  providerFailures: number;
  providerTimeouts: number;
  invalidStructuredOutputs: number;
  retries: number;
}) {
  return [
    "**Runtime truth:**",
    `provider_read_only; logical agents ${input.workerCount}; provider requests ${input.providerCallCount}; failures ${input.providerFailures}; timeouts ${input.providerTimeouts}; retries ${input.retries}; invalid structured outputs ${input.invalidStructuredOutputs}; mock/fallback accepted as answer: no.`
  ].join("\n");
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
