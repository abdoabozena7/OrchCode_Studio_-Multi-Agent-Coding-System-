import type {
  AgentRuntimeSession,
  PatchProposal,
  RecursiveFinalReport,
  RecursiveRepairRecord
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { runPatchIntentSchema } from "../schemas/sessionSchemas.js";
import { validateStructuredOutput } from "../schemas/validators.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  collectRepairFileExcerpts,
  compileRepairPatchProposal,
  type RepairPatchIntentModel
} from "./RepairPatchPlanning.js";
import { invokeReasoningProviderStructured } from "./ReasoningKernel.js";
import type { SessionManager } from "./SessionManager.js";

export type RecursiveRepairPatchProposalServices = {
  getProvider: (session: AgentRuntimeSession) => LlmProvider;
};

export class RecursiveRepairPatchProposalService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RecursiveRepairPatchProposalServices
  ) {}

  async propose(sessionId: string, finalReport: RecursiveFinalReport, repair: RecursiveRepairRecord): Promise<RecursiveRepairRecord> {
    const session = this.requireSession(sessionId);
    const tools = new ToolRegistry(session.workspacePath);
    const relevantFiles = collectRepairFileExcerpts(tools, repair.eligibility.relatedFiles);
    if (!relevantFiles.length) {
      return markRecursiveRepairNotAttempted(repair, "No readable related file excerpt was available for a safe repair proposal.");
    }

    const generated = await invokeReasoningProviderStructured<Partial<RepairPatchIntentModel>>(
      this.services.getProvider(session),
      {
        systemPrompt: "You produce strict JSON repair patch intents for one small recursive validation failure only.",
        userPrompt: buildRecursiveRepairPatchPrompt({ finalReport, repair, relevantFiles })
      },
      runPatchIntentSchema
    );
    const validation = validateStructuredOutput(generated, runPatchIntentSchema);
    if (!validation.valid || !generated.intents?.length) {
      return markRecursiveRepairNotAttempted(repair, "No valid scoped repair patch intent was generated.");
    }

    let patchInput: Omit<PatchProposal, "id" | "sessionId" | "createdAt">;
    try {
      patchInput = compileRepairPatchProposal(session.workspacePath, tools, generated as RepairPatchIntentModel);
    } catch (error) {
      return markRecursiveRepairNotAttempted(repair, `Repair patch compile failed: ${formatRuntimeError(error)}`);
    }

    const allowedFiles = new Set(repair.eligibility.relatedFiles.map(normalizeWorkspaceRelativePath));
    const patchFiles = patchInput.filesChanged.map((file) => normalizeWorkspaceRelativePath(file.path));
    const outOfScope = patchFiles.filter((file) => !allowedFiles.has(file));
    const patch = tools.patch.propose(patchInput, sessionId);
    const patchValidation = tools.patch.validate(patch);
    if (!patchValidation.valid || outOfScope.length || patch.filesChanged.length > 3) {
      return markRecursiveRepairNotAttempted(repair, uniqueRuntimeStrings([
        ...patchValidation.errors,
        outOfScope.length ? `Repair patch touched files outside related scope: ${outOfScope.join(", ")}` : undefined,
        patch.filesChanged.length > 3 ? "Repair patch touched more than three files." : undefined
      ].filter(Boolean) as string[]).join("; ") || "Generated repair patch failed scope validation.");
    }

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        patchId: patch.id,
        repairId: repair.id,
        diagnosisId: repair.diagnosis.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false,
        unifiedDiff: patch.unifiedDiff
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.addToolIntent(sessionId, {
      id: `intent_${randomUUID()}`,
      sessionId,
      type: "patch.proposed",
      title: patch.title,
      summary: patch.summary,
      payload: { patchId: patch.id, recursiveRepairId: repair.id, diagnosis: repair.diagnosis },
      status: "proposed",
      createdAt: new Date().toISOString()
    });

    return {
      ...repair,
      status: "patch_proposed",
      attemptCount: repair.attemptCount + 1,
      repairPatchId: patch.id,
      repairPatchStatus: patch.status,
      summary: `Proposed one scoped repair patch ${patch.id}; Rust apply is required before any fix is claimed.`,
      updatedAt: new Date().toISOString()
    };
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }
}

function buildRecursiveRepairPatchPrompt(input: {
  finalReport: RecursiveFinalReport;
  repair: RecursiveRepairRecord;
  relevantFiles: Array<{ path: string; excerpt: string }>;
}) {
  return [
    "Create one reviewable recursive validation repair patch intent as strict JSON.",
    "Do not write files. Fix only the proven failure and keep the patch inside the related files.",
    "Return JSON with: title, summary, intents[{path,operation,anchorText?,preimageText?,replacementText,reason,risk}], suggestedCommands.",
    "Allowed operations: create_file, replace_range. Prefer replace_range for existing files.",
    `Failed command: ${input.repair.diagnosis.command}`,
    `Validation diagnosis: ${JSON.stringify(input.repair.diagnosis)}`,
    `Allowed related files: ${JSON.stringify(input.repair.eligibility.relatedFiles)}`,
    `Relevant file excerpts: ${JSON.stringify(input.relevantFiles)}`,
    `Final validation reason: ${input.finalReport.validationDiscovery?.statusReason ?? input.finalReport.recommendedNextStep}`
  ].join("\n");
}

function markRecursiveRepairNotAttempted(repair: RecursiveRepairRecord, reason: string): RecursiveRepairRecord {
  return {
    ...repair,
    status: "repair_not_attempted",
    eligibility: {
      ...repair.eligibility,
      status: "repair_not_attempted",
      reasons: uniqueRuntimeStrings([...repair.eligibility.reasons, reason])
    },
    summary: `Repair not attempted: ${reason}`,
    updatedAt: new Date().toISOString()
  };
}

function normalizeWorkspaceRelativePath(filePath: string) {
  return filePath.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function uniqueRuntimeStrings(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function formatRuntimeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
