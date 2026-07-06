import type {
  AgentRuntimeSession,
  CommandExecutionRecord,
  RunToGreenDiagnosis
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { runPatchIntentSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { validatePatchAgainstModulePlan } from "./ModuleExecutionPlanning.js";
import {
  buildRepairPatchPrompt,
  collectRepairFileExcerpts,
  compileRepairPatchProposal,
  type RepairPatchIntentModel
} from "./RepairPatchPlanning.js";
import {
  createDiagnosisFingerprint,
  diagnoseRunToGreenFailure,
  findAlternateRunToGreenCommand,
  getCurrentRunToGreenAttempt,
  markNextRunToGreenAttempt
} from "./RunToGreen.js";
import { createConversationUnderstanding } from "./ConversationUnderstanding.js";
import { invokeReasoningProviderStructured } from "./ReasoningKernel.js";
import { summarizeRuntimeOutput } from "./RuntimeTextUtils.js";
import { SessionManager } from "./SessionManager.js";

export class RuntimeRunToGreenService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly getProvider: (session: AgentRuntimeSession) => LlmProvider
  ) {}

  async advanceFromCommandResult(sessionId: string, record: CommandExecutionRecord) {
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
      await this.recordDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((record.status === "executed" || record.status === "completed") && record.exitCode === 0) {
      await this.recordDecision(sessionId, undefined, record.command, "Selected command passed; the bounded repair loop stopped successfully.");
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
      await this.recordDecision(sessionId, diagnosis, record.command);
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
      await this.recordDecision(sessionId, diagnosis, record.command);
      return;
    }

    if ((diagnosis?.category === "script_missing" || diagnosis?.category === "command_not_found") && alternate) {
      await this.queueCommandRequest(sessionId, alternate, diagnosis.reason);
      await this.recordDecision(sessionId, diagnosis, record.command);
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
      await this.recordDecision(sessionId, diagnosis, record.command);
      return;
    }

    await this.proposeRepair(sessionId, record, diagnosis);
    await this.recordDecision(sessionId, diagnosis, record.command);
  }

  async queuePendingRerun(session: AgentRuntimeSession, patchId: string, reason: string) {
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
    await this.queueCommandRequest(session.id, selected, session.runToGreen.pendingRerunReason ?? reason);
  }

  async recordPatchApplyFailure(sessionId: string, patchId: string) {
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

  private async proposeRepair(sessionId: string, record: CommandExecutionRecord, diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>>) {
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
    const generated = await invokeReasoningProviderStructured<Partial<RepairPatchIntentModel>>(
      provider,
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

  private async queueCommandRequest(sessionId: string, command: { command: string; cwd: string; reason: string }, reason: string) {
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

  private async recordDecision(
    sessionId: string,
    diagnosis: NonNullable<ReturnType<typeof diagnoseRunToGreenFailure>> | undefined,
    command: string,
    successNote?: string
  ) {
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

function uniqueRuntimeStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
