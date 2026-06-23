import type {
  ArtifactHandoff,
  AgentIntentAlignment,
  AgentIntentInputFrame,
  CommandRequest,
  PatchProposal,
  PreviewRecommendation,
  ProjectMap,
  TaskNode,
  WorkerOutput,
  WorkerSpec
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { createThreeJsSnakeProposal, isThreeJsSnakePrompt } from "../../mock/threeJsSnake.js";

export type GenericWorkerContext = {
  sessionId: string;
  userPrompt: string;
  workspacePath: string;
  projectMap: ProjectMap;
  tools: ToolRegistry;
  previousArtifacts: ArtifactHandoff[];
  intentFrame?: AgentIntentInputFrame;
};

export class GenericWorkerAgent {
  private spec?: WorkerSpec;

  assign(spec: WorkerSpec) {
    this.spec = spec;
    return this;
  }

  async execute(task: TaskNode, context: GenericWorkerContext): Promise<{
    output: WorkerOutput;
    artifact: ArtifactHandoff;
    patch?: PatchProposal;
    commandRequest?: CommandRequest;
    previewRecommendation?: PreviewRecommendation;
  }> {
    if (!this.spec) throw new Error("GenericWorkerAgent requires assign(spec) before execute()");
    const spec = this.spec;
    const role = spec.roleTitle;
    const details = [
      spec.persona,
      spec.objective,
      ...spec.tasks.map((item) => `Task: ${item}`),
      context.previousArtifacts.length ? `Integrated ${context.previousArtifacts.length} prior artifact(s).` : "No upstream artifact dependency."
    ];
    const patch = maybeCreatePatch(spec, task, context);
    const commandRequest = maybeCreateCommand(spec, context);
    const intentAlignment = context.intentFrame ? alignmentFromFrame(context.intentFrame, {
      taskUnderstanding: `${role} handled ${spec.objective}`,
      originalGoalContribution: `The worker output is scoped to ${spec.objective} and remains tied to the original user request through the provided intent frame.`,
      evidenceRefs: [context.intentFrame.intent_contract_ref ?? "", ...context.previousArtifacts.map((artifact) => artifact.id)]
    }) : undefined;
    const artifact: ArtifactHandoff = {
      id: `artifact_${randomUUID()}`,
      sessionId: context.sessionId,
      workerId: spec.id,
      roleTitle: role,
      summary: `${role} completed ${spec.objective}`,
      details,
      patchProposalIds: patch ? [patch.id] : [],
      commandRequestIds: commandRequest ? [commandRequest.id] : [],
      validationNotes: spec.acceptanceCriteria.map((criterion) => `Checked: ${criterion}`),
      intentAlignment,
      createdAt: new Date().toISOString()
    };
    const output: WorkerOutput = {
      id: `worker_${randomUUID()}`,
      sessionId: context.sessionId,
      taskId: task.id,
      agentName: spec.id,
      summary: artifact.summary,
      details: artifact.details,
      patchProposalIds: artifact.patchProposalIds,
      commandRequestIds: artifact.commandRequestIds,
      risks: [],
      intentAlignment,
      selfCheck: {
        workOrderId: spec.id,
        passedCriteria: spec.acceptanceCriteria,
        failedCriteria: [],
        missingItems: [],
        confidence: 0.78
      },
      status: "completed",
      createdAt: new Date().toISOString()
    };
    return { output, artifact, patch, commandRequest };
  }
}

function alignmentFromFrame(frame: AgentIntentInputFrame, input: {
  taskUnderstanding: string;
  originalGoalContribution: string;
  evidenceRefs: string[];
}): AgentIntentAlignment {
  return {
    schema_version: 1,
    run_id: frame.run_id,
    task_id: frame.current_task_slice.task_id,
    original_request_hash: frame.original_request_hash,
    intent_contract_ref: frame.intent_contract_ref,
    intent_contract_revision: frame.intent_contract.revision,
    task_slice_id: frame.current_task_slice.task_slice_id,
    task_understanding: input.taskUnderstanding,
    original_goal_contribution: input.originalGoalContribution,
    possible_intent_conflicts: [],
    assumptions_used: frame.intent_contract.assumptions,
    evidence_refs: [...new Set(input.evidenceRefs.filter(Boolean))]
  };
}

function maybeCreatePatch(spec: WorkerSpec, task: TaskNode, context: GenericWorkerContext) {
  if (!spec.capabilityGrant.canProposePatches || !spec.targetFiles.length) return undefined;
  if (isThreeJsSnakePrompt(context.userPrompt)) {
    if (!/integration|interface|frontend/i.test(spec.roleTitle) && !spec.targetFiles.includes("index.html")) return undefined;
    return context.tools.patch.propose(createThreeJsSnakeProposal(context.userPrompt), context.sessionId);
  }
  if (!/frontend|backend|implement|integration|render|logic|patch|code/i.test(`${spec.roleTitle} ${spec.objective}`)) return undefined;
  const summaryFile = spec.targetFiles[0] ?? "AGENT_PROPOSAL.md";
  const content = [
    `# ${spec.roleTitle} Proposal`,
    "",
    `Request: ${context.userPrompt.replace(/\s+/g, " ")}`,
    `Objective: ${spec.objective}`,
    "",
    "This is a reviewable runtime patch intent. Rust must apply or reject it.",
    ""
  ].join("\n");
  return context.tools.patch.propose(
    {
      title: `${spec.roleTitle} patch intent`,
      summary: `Prepared a patch intent for ${spec.objective}`,
      riskLevel: task.riskLevel === "high" ? "high" : task.riskLevel === "medium" ? "medium" : "low",
      filesChanged: [
        {
          path: summaryFile,
          changeType: "create",
          explanation: `Artifact created by ${spec.roleTitle}`
        }
      ],
      artifacts: [{ path: summaryFile, content }],
      unifiedDiff: [
        `diff --git a/${summaryFile} b/${summaryFile}`,
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${summaryFile}`,
        "@@ -0,0 +1,6 @@",
        ...content.trimEnd().split("\n").map((line) => `+${line}`)
      ].join("\n"),
      requiresApproval: true,
      status: "proposed"
    },
    context.sessionId
  );
}

function maybeCreateCommand(spec: WorkerSpec, context: GenericWorkerContext) {
  if (!spec.capabilityGrant.canRequestCommands) return undefined;
  if (!/test|validation|verify|tool/i.test(`${spec.roleTitle} ${spec.objective}`)) return undefined;
  const command = context.projectMap.testCommands[0] ?? "git diff --check";
  return context.tools.command.requestRun(context.sessionId, command, `${spec.roleTitle} requested validation`);
}
