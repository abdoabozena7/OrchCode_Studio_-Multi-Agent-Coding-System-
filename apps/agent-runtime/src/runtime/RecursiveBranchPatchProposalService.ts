import type {
  AgentRuntimeSession,
  PatchProposal,
  RecursiveBranchExecutionRecord,
  RecursiveNestedSubtaskRollup
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { SessionManager } from "./SessionManager.js";

export type NestedRollupBuilder = (
  branch: RecursiveBranchExecutionRecord,
  patches: PatchProposal[]
) => RecursiveNestedSubtaskRollup;

export class RecursiveBranchPatchProposalService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly buildNestedRollup: NestedRollupBuilder
  ) {}

  async proposeNestedSubtaskPatch(sessionId: string, branchId: string, subtaskId: string) {
    const current = this.requireSession(sessionId);
    const branch = current.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
    const subtask = branch?.nestedSubtasks?.find((candidate) => candidate.subtaskId === subtaskId);
    if (!branch || !subtask || subtask.proposedPatchId || !subtask.plannedPatch) return;

    const patchTarget = subtask.plannedPatch.targetFile;
    const replacementText = subtask.plannedPatch.replacementText;
    const tools = new ToolRegistry(current.workspacePath);
    const patch = createRuntimePatchProposal({
      tools,
      sessionId,
      patchTarget,
      replacementText,
      title: `Nested subtask patch: ${subtask.objective}`,
      summary: `Nested sub-orchestrator subtask ${subtask.subtaskId} proposed a patch for ${patchTarget}. Runtime did not write files.`,
      explanation: `Nested subtask ${subtask.subtaskId} may only propose this patch; Rust apply authority must change disk.`
    });

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        branchId,
        subtaskId,
        patchId: patch.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false,
        nestedDepth: 1
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const scheduledBranch = draft.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
      const scheduledSubtask = scheduledBranch?.nestedSubtasks?.find((candidate) => candidate.subtaskId === subtaskId);
      if (!scheduledBranch || !scheduledSubtask) return;
      const now = new Date().toISOString();
      scheduledBranch.status = "running";
      scheduledBranch.active = true;
      scheduledBranch.blockedReason = "Parent branch is waiting for required nested subtasks.";
      scheduledSubtask.status = "patch_proposed";
      scheduledSubtask.proposedPatchId = patch.id;
      scheduledSubtask.active = true;
      scheduledSubtask.updatedAt = now;
      scheduledBranch.nestedRollup = this.buildNestedRollup(scheduledBranch, draft.patchProposals);
      scheduledBranch.updatedAt = now;
      draft.recursiveFactory!.phase = "branch_execution_running";
      draft.recursiveFactory!.executionStarted = true;
      draft.recursiveFactory!.activeBranchId = branchId;
      draft.recursiveFactory!.updatedAt = now;
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPROVAL";
      draft.nextAction = {
        kind: "approve_patch",
        patchId: patch.id,
        message: "Nested subtask patch proposed. Review and approve it before Rust apply."
      };
      draft.reasoningSummaries.push(`Nested subtask ${subtaskId} proposed patch ${patch.id}; no runtime file write occurred.`);
    });

    const updatedBranch = this.findBranchExecution(sessionId, branchId);
    if (updatedBranch) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.patch_proposed", sessionId, branchExecution: updatedBranch });
    }
    await this.sessionManager.addMessage(sessionId, {
      role: "system",
      content: [
        `Nested subtask execution started for ${subtask.objective}.`,
        "",
        `Patch proposed: ${patch.id}`,
        "Execution has not directly written files. Rust apply authority must apply the approved patch."
      ].join("\n")
    });
  }

  async proposeScheduledBranchPatch(sessionId: string, branchId: string) {
    const current = this.requireSession(sessionId);
    const branch = current.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
    if (!branch || branch.proposedPatchId) return;
    if (!branch.executionContext.fileScopes.length) return;

    this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.started", sessionId, branchExecution: branch });
    const patchTarget = branch.plannedPatch?.targetFile ?? branch.executionContext.fileScopes[0]!;
    const replacementText = branch.plannedPatch?.replacementText ?? `Recursive branch execution marker for ${sessionId}/${branch.branchId}\n`;
    const tools = new ToolRegistry(current.workspacePath);
    const patch = createRuntimePatchProposal({
      tools,
      sessionId,
      patchTarget,
      replacementText,
      title: `Branch patch: ${branch.title}`,
      summary: `Controlled branch execution proposed a patch for ${patchTarget}. Runtime did not write files.`,
      explanation: `Branch ${branch.branchId} may only propose this patch; Rust apply authority must change disk.`
    });

    await this.sessionManager.addPatchProposal(sessionId, patch);
    await this.sessionManager.addArtifact(sessionId, {
      id: `artifact_${randomUUID()}`,
      sessionId,
      type: "diff",
      title: patch.title,
      summary: patch.summary,
      payload: {
        branchId,
        patchId: patch.id,
        filesChanged: patch.filesChanged,
        directRuntimeWrite: false
      },
      createdAt: new Date().toISOString()
    });
    await this.sessionManager.updateSession(sessionId, (draft) => {
      const scheduled = draft.recursiveFactory?.branchExecutions?.find((candidate) => candidate.branchId === branchId);
      if (!scheduled) return;
      scheduled.status = "patch_proposed";
      scheduled.reviewStatus = "pending";
      scheduled.proposedPatchId = patch.id;
      scheduled.active = true;
      scheduled.updatedAt = new Date().toISOString();
      draft.recursiveFactory!.phase = "branch_execution_running";
      draft.recursiveFactory!.executionStarted = true;
      draft.recursiveFactory!.activeBranchId = branchId;
      draft.recursiveFactory!.updatedAt = scheduled.updatedAt;
      const planned = draft.recursiveFactory!.branchOrchestrators?.find((candidate) => candidate.branchId === branchId);
      if (planned) {
        planned.status = scheduled.status;
        planned.updatedAt = scheduled.updatedAt;
      }
      draft.status = "needs_approval";
      draft.lifecycleStage = "APPROVAL";
      draft.nextAction = {
        kind: "approve_patch",
        patchId: patch.id,
        message: "Branch patch proposed. Review and approve it before Rust apply."
      };
      draft.reasoningSummaries.push(`Branch ${branchId} proposed patch ${patch.id}; no runtime file write occurred.`);
    });

    const proposedBranch = this.findBranchExecution(sessionId, branchId);
    if (proposedBranch) {
      this.sessionManager.publishFactoryEvent({ type: "runtime.branch_execution.patch_proposed", sessionId, branchExecution: proposedBranch });
      await this.sessionManager.addMessage(sessionId, {
        role: "system",
        content: [
          `Branch execution started for ${proposedBranch.title}.`,
          "",
          `Patch proposed: ${patch.id}`,
          "Execution has not directly written files. Rust apply authority must apply the approved patch."
        ].join("\n")
      });
    }
  }

  private requireSession(sessionId: string): AgentRuntimeSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private findBranchExecution(sessionId: string, branchId: string) {
    return this.requireSession(sessionId).recursiveFactory?.branchExecutions?.find((branch) => branch.branchId === branchId);
  }
}

function createRuntimePatchProposal(input: {
  tools: ToolRegistry;
  sessionId: string;
  patchTarget: string;
  replacementText: string;
  title: string;
  summary: string;
  explanation: string;
}) {
  const exists = input.tools.workspace.fileExists(input.patchTarget);
  const currentContent = exists ? input.tools.workspace.readWholeFile(input.patchTarget) : "";
  const patchInput: Omit<PatchProposal, "id" | "sessionId" | "createdAt"> = {
    title: input.title,
    summary: input.summary,
    riskLevel: "low",
    filesChanged: [{
      path: input.patchTarget,
      changeType: exists ? "modify" : "create",
      explanation: input.explanation
    }],
    artifacts: [{ path: input.patchTarget, content: input.replacementText }],
    unifiedDiff: exists
      ? createWholeFileReplaceDiff(input.patchTarget, currentContent, input.replacementText)
      : createFileDiff(input.patchTarget, input.replacementText),
    requiresApproval: true,
    status: "proposed"
  };
  return input.tools.patch.propose(patchInput, input.sessionId);
}

function createFileDiff(filePath: string, content: string) {
  const newLines = toUnifiedDiffLines(content);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${newLines.length} @@`,
    ...newLines.map((line) => `+${line}`)
  ].join("\n") + "\n";
}

function createWholeFileReplaceDiff(filePath: string, currentContent: string, replacementText: string) {
  const oldLines = toUnifiedDiffLines(currentContent);
  const newLines = toUnifiedDiffLines(replacementText);
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n") + "\n";
}

function toUnifiedDiffLines(content: string) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalNewline.length ? withoutFinalNewline.split("\n") : [];
}
