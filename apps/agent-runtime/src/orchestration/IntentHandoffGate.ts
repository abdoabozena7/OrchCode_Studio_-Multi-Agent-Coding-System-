import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentIntentAlignment,
  AgentIntentInputFrame,
  AgentIntentLayer,
  AgentIntentLockedDefinition,
  AgentIntentTaskSlice,
  IntentContract,
  IntentContractRunKind,
  IntentHandoffGateResult
} from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { writeJson } from "../memory/ProjectMemory.js";
import { IntentLedgerService } from "./IntentLedgerService.js";
import type { IntentContextSnapshot, IntentRunKind, LockedIntentDefinition } from "./IntentLedgerModels.js";
import type { ContextPack, ParsedAgentOutput, Run, Task } from "./OrchestrationModels.js";
import type { SwarmRun, WorkItem, WorkItemResult } from "./SwarmModels.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";

export const INTENT_HANDOFF_SCHEMA_VERSION = 1;

export type IntentHandoffGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  provider?: LlmProvider;
  sourceComponent?: string;
};

export type LegacyIntentFrameInput = {
  sessionId: string;
  intentContract: IntentContract;
  role: string;
  taskId: string;
  objective: string;
  taskTitle?: string;
  dependencies?: string[];
  readFiles?: string[];
  writeFiles?: string[];
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  expectedOutputSchema?: string;
  validationRequirements?: string[];
  contextRefs?: string[];
};

export class IntentHandoffGate {
  private readonly traceWriter: FactoryTraceWriter;
  private readonly sourceComponent: string;

  constructor(private readonly options: IntentHandoffGateOptions) {
    this.sourceComponent = options.sourceComponent ?? "IntentHandoffGate";
    this.traceWriter = new FactoryTraceWriter({
      workspacePath: options.workspacePath,
      memoryDir: options.memoryDir,
      sourceComponent: this.sourceComponent
    });
  }

  async coreFrame(run: Run, task: Task, pack?: ContextPack): Promise<AgentIntentInputFrame> {
    const context = await this.loadContext(run.id, "core", run.artifacts_path);
    return createCoreIntentFrame({ run, task, pack, context });
  }

  async swarmFrame(run: SwarmRun, workItem: WorkItem): Promise<AgentIntentInputFrame> {
    const context = await this.loadContext(run.id, "swarm", run.artifacts_path);
    return createSwarmIntentFrame({ run, workItem, context });
  }

  async evaluate(input: {
    runId: string;
    runKind: IntentRunKind;
    artifactsPath: string;
    layer: AgentIntentLayer;
    taskId: string;
    frame: AgentIntentInputFrame;
    alignment: AgentIntentAlignment | undefined;
    candidate: unknown;
    reviewedArtifactRefs?: string[];
    target?: "prompt" | "output" | "plan" | "final_report" | "swarm_context" | "unknown";
  }): Promise<IntentHandoffGateResult> {
    const paths = await this.paths(input.artifactsPath, input.taskId);
    await writeJson(paths.frame, input.frame);
    const deterministicErrors = [
      ...validateFrame(input.frame),
      ...validateAlignment(input.frame, input.alignment)
    ];
    let providerStatus: IntentHandoffGateResult["provider_status"];
    let providerUsed = false;
    let providerReviewRef: string | undefined;

    if (this.options.provider && deterministicErrors.length === 0) {
      const review = await new IntentLedgerService({
        workspacePath: this.options.workspacePath,
        memoryDir: this.options.memoryDir,
        sourceComponent: this.sourceComponent
      }).reviewIntent({
        runId: input.runId,
        runKind: input.runKind,
        artifactsPath: input.artifactsPath,
        stage: "final",
        target: input.target ?? "output",
        reviewedArtifactRefs: uniqueStrings([paths.frame, ...(input.reviewedArtifactRefs ?? [])]),
        parentContextRefs: input.frame.intent_ledger_refs,
        parentContext: {
          task_slice: input.frame.current_task_slice,
          intent_contract_ref: input.frame.intent_contract_ref,
          original_request_hash: input.frame.original_request_hash
        },
        candidate: {
          intent_alignment: input.alignment,
          output: input.candidate
        },
        provider: this.options.provider
      });
      providerUsed = review.provider_used;
      providerStatus = review.status;
      providerReviewRef = review.artifact_ref;
      if (review.status !== "aligned" && !isNonBlockingProviderIntentUncertainty(review.status, input.frame)) {
        deterministicErrors.push(`Provider intent review status was ${review.status}.`);
      }
    }

    const passed = deterministicErrors.length === 0;
    const result: IntentHandoffGateResult = {
      schema_version: INTENT_HANDOFF_SCHEMA_VERSION,
      gate_id: `intent_handoff_${randomUUID()}`,
      run_id: input.runId,
      task_id: input.taskId,
      layer: input.layer,
      passed,
      status: passed ? "passed" : "blocked",
      deterministic_errors: deterministicErrors,
      provider_used: providerUsed,
      provider_status: providerStatus,
      reviewed_artifact_refs: uniqueStrings([
        paths.frame,
        providerReviewRef ?? "",
        ...(input.reviewedArtifactRefs ?? [])
      ]),
      frame_ref: paths.frame,
      alignment: input.alignment,
      created_at: new Date().toISOString(),
      metadata_json: {
        source_component: this.sourceComponent,
        original_request_hash: input.frame.original_request_hash,
        intent_contract_ref: input.frame.intent_contract_ref,
        task_slice_id: input.frame.current_task_slice.task_slice_id
      }
    };
    const persisted: IntentHandoffGateResult = { ...result, artifact_ref: paths.gate };
    await writeJson(paths.gate, persisted);
    await this.traceWriter.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: passed ? "intent_handoff_gate_passed" : "intent_handoff_gate_blocked",
      lifecycle_stage: passed ? "executing" : "blocked",
      severity: passed ? "info" : "warning",
      summary: passed
        ? `Intent handoff gate passed for ${input.taskId}.`
        : `Intent handoff gate blocked ${input.taskId}.`,
      reason: deterministicErrors.join("; ") || undefined,
      artifact_refs: [paths.frame, paths.gate],
      metadata_json: {
        layer: input.layer,
        provider_used: providerUsed,
        provider_status: providerStatus,
        error_count: deterministicErrors.length
      }
    });
    return persisted;
  }

  private async loadContext(runId: string, runKind: IntentRunKind, artifactsPath: string) {
    return new IntentLedgerService({
      workspacePath: this.options.workspacePath,
      memoryDir: this.options.memoryDir,
      sourceComponent: this.sourceComponent
    }).loadContext(runId, runKind, artifactsPath);
  }

  private async paths(artifactsPath: string, taskId: string) {
    const directory = path.join(artifactsPath, "intent_handoffs", safePathSegment(taskId));
    await mkdir(directory, { recursive: true });
    return {
      frame: path.join(directory, "intent_frame.json"),
      gate: path.join(directory, "handoff_gate.json")
    };
  }
}

function isNonBlockingProviderIntentUncertainty(
  status: IntentHandoffGateResult["provider_status"],
  frame: AgentIntentInputFrame
) {
  if (status !== "insufficient_context") return false;
  if (frame.layer !== "swarm") return false;
  return frame.current_task_slice.write_files.length === 0;
}

export function createCoreIntentFrame(input: {
  run?: Run;
  runId?: string;
  task: Task;
  pack?: ContextPack;
  context: IntentContextSnapshot;
}): AgentIntentInputFrame {
  const contract = requireReadyContract(input.context.intent_contract);
  const original = input.context.original_request?.original_request ?? contract.original_user_request;
  const taskSlice = taskSliceForCore(input.task, input.pack);
  return createFrame({
    runId: input.run?.id ?? input.runId ?? input.task.run_id,
    runKind: "core",
    layer: "core",
    original,
    originalRef: input.context.original_request_ref,
    originalHash: input.context.original_request_hash,
    contract,
    contractRef: input.context.intent_contract_ref ?? contract.artifact_ref,
    intentLedgerRefs: input.context.intent_ledger_refs,
    lockedDefinitions: input.context.locked_definitions,
    taskSlice
  });
}

export function createSwarmIntentFrame(input: {
  run: SwarmRun;
  workItem: WorkItem;
  context: IntentContextSnapshot;
}): AgentIntentInputFrame {
  const contract = requireReadyContract(input.context.intent_contract);
  const original = input.context.original_request?.original_request ?? contract.original_user_request;
  const taskSlice = taskSliceForSwarm(input.workItem);
  return createFrame({
    runId: input.run.id,
    runKind: "swarm",
    layer: "swarm",
    original,
    originalRef: input.context.original_request_ref ?? input.run.original_request_ref,
    originalHash: input.context.original_request_hash,
    contract,
    contractRef: input.context.intent_contract_ref ?? input.run.intent_contract_ref ?? contract.artifact_ref,
    intentLedgerRefs: uniqueStrings(input.context.intent_ledger_refs.length ? input.context.intent_ledger_refs : [input.run.intent_ledger_ref ?? ""]),
    lockedDefinitions: input.context.locked_definitions,
    taskSlice
  });
}

export function createLegacyIntentInputFrame(input: LegacyIntentFrameInput): AgentIntentInputFrame {
  const taskSlice: AgentIntentTaskSlice = {
    task_slice_id: stableId("intent_slice", input.sessionId, input.taskId, input.role, input.objective),
    task_id: input.taskId,
    layer: "legacy_orchestrated",
    role: input.role,
    objective: input.objective,
    task_title: input.taskTitle,
    slice_summary: `${input.role}: ${input.objective}`,
    task_type: "legacy_worker",
    read_files: input.readFiles ?? [],
    write_files: input.writeFiles ?? [],
    allowed_files: input.allowedFiles ?? [],
    forbidden_files: input.forbiddenFiles ?? [],
    dependencies: input.dependencies ?? [],
    expected_output_schema: input.expectedOutputSchema ?? "WorkerOutput",
    validation_requirements: input.validationRequirements ?? [],
    context_refs: input.contextRefs ?? [],
    metadata_json: {}
  };
  return createFrame({
    runId: input.sessionId,
    runKind: "runtime_session",
    layer: "legacy_orchestrated",
    original: input.intentContract.original_user_request,
    originalHash: sha256(input.intentContract.original_user_request),
    contract: input.intentContract,
    contractRef: input.intentContract.artifact_ref,
    intentLedgerRefs: [input.intentContract.artifact_ref ?? "", input.intentContract.summary_ref ?? ""],
    lockedDefinitions: [],
    taskSlice
  });
}

export function createAlignmentFromFrame(
  frame: AgentIntentInputFrame,
  input: {
    taskUnderstanding?: string;
    originalGoalContribution?: string;
    possibleIntentConflicts?: string[];
    assumptionsUsed?: string[];
    evidenceRefs?: string[];
  } = {}
): AgentIntentAlignment {
  return {
    schema_version: INTENT_HANDOFF_SCHEMA_VERSION,
    alignment_id: `intent_alignment_${randomUUID()}`,
    run_id: frame.run_id,
    task_id: frame.current_task_slice.task_id,
    original_request_hash: frame.original_request_hash,
    intent_contract_ref: frame.intent_contract_ref,
    intent_contract_revision: frame.intent_contract.revision,
    task_slice_id: frame.current_task_slice.task_slice_id,
    task_understanding: input.taskUnderstanding ?? frame.current_task_slice.objective,
    original_goal_contribution: input.originalGoalContribution ?? `This task serves the compiled intent: ${frame.intent_contract.precise_rewrite}`,
    possible_intent_conflicts: input.possibleIntentConflicts ?? [],
    assumptions_used: input.assumptionsUsed ?? frame.intent_contract.assumptions,
    evidence_refs: uniqueStrings(input.evidenceRefs ?? [
      frame.original_request_ref ?? "",
      frame.intent_contract_ref ?? "",
      ...frame.current_task_slice.context_refs
    ])
  };
}

export function intentGateBlockedParsedOutput(
  output: ParsedAgentOutput,
  gate: IntentHandoffGateResult
): ParsedAgentOutput {
  return {
    ...output,
    status: "blocked",
    intent_handoff_gate_ref: gate.artifact_ref,
    intent_handoff_gate_status: gate.status,
    artifacts: uniqueStrings([...output.artifacts, gate.artifact_ref ?? "", gate.frame_ref ?? ""]),
    limitations: uniqueStrings([
      ...output.limitations,
      `Intent handoff gate blocked this output: ${gate.deterministic_errors.join("; ")}`
    ]),
    next_recommendations: uniqueStrings([
      ...output.next_recommendations,
      "Regenerate the worker output with an intent_alignment tied to the original request, intent contract, and current task slice."
    ])
  };
}

export function intentGateBlockedWorkItemResult(
  result: WorkItemResult,
  gate: IntentHandoffGateResult
): WorkItemResult {
  return {
    ...result,
    status: "blocked",
    structured_output_valid: false,
    intent_handoff_gate_ref: gate.artifact_ref,
    intent_handoff_gate_status: gate.status,
    risks: uniqueStrings([
      ...result.risks,
      `Intent handoff gate blocked this result: ${gate.deterministic_errors.join("; ")}`
    ])
  };
}

function createFrame(input: {
  runId: string;
  runKind: IntentContractRunKind;
  layer: AgentIntentLayer;
  original: string;
  originalRef?: string;
  originalHash?: string;
  contract: IntentContract;
  contractRef?: string;
  intentLedgerRefs: string[];
  lockedDefinitions: LockedIntentDefinition[] | AgentIntentLockedDefinition[];
  taskSlice: AgentIntentTaskSlice;
}): AgentIntentInputFrame {
  const originalHash = input.originalHash ?? sha256(input.original);
  return {
    schema_version: INTENT_HANDOFF_SCHEMA_VERSION,
    frame_id: stableId("intent_frame", input.runId, input.taskSlice.task_slice_id, originalHash, input.contract.contract_id, String(input.contract.revision)),
    run_id: input.runId,
    run_kind: input.runKind,
    layer: input.layer,
    original_user_request: input.original,
    original_request_hash: originalHash,
    original_request_ref: input.originalRef,
    intent_contract: input.contract,
    intent_contract_ref: input.contractRef,
    intent_contract_status: input.contract.status,
    intent_ledger_refs: uniqueStrings(input.intentLedgerRefs),
    locked_intent_definitions: input.lockedDefinitions.map(normalizeLockedDefinition),
    current_task_slice: input.taskSlice,
    created_at: new Date().toISOString(),
    metadata_json: {}
  };
}

function taskSliceForCore(task: Task, pack?: ContextPack): AgentIntentTaskSlice {
  return {
    task_slice_id: stableId("intent_slice", task.run_id, task.id, task.role_required, task.objective),
    task_id: task.id,
    parent_task_id: task.parent_id,
    layer: "core",
    role: task.role_required,
    objective: task.objective,
    task_title: task.title,
    task_type: "core_task",
    slice_summary: `${task.title}: ${task.objective}`,
    read_files: uniqueStrings([...(pack?.relevant_files ?? task.relevant_files), ...(pack?.confirmed_relevant_files ?? [])]),
    write_files: task.allowed_files_to_edit,
    allowed_files: task.allowed_files_to_edit,
    forbidden_files: task.forbidden_files,
    dependencies: task.dependencies,
    expected_output_schema: task.expected_output_schema,
    validation_requirements: pack?.validation_requirements ?? task.validation_commands,
    context_refs: uniqueStrings([
      pack?.id ? `context_pack:${pack.id}` : "",
      pack?.original_request_ref ?? "",
      pack?.intent_contract_ref ?? "",
      pack?.intent_ledger_ref ?? "",
      ...(pack?.intent_ledger_refs ?? [])
    ]),
    metadata_json: {
      context_pack_id: pack?.id,
      context_size: pack?.approximate_size
    }
  };
}

function taskSliceForSwarm(workItem: WorkItem): AgentIntentTaskSlice {
  return {
    task_slice_id: stableId("intent_slice", workItem.swarm_run_id, workItem.id, workItem.required_role, workItem.type),
    task_id: workItem.id,
    parent_task_id: workItem.task_id,
    layer: "swarm",
    role: workItem.required_role,
    objective: `${workItem.required_role} ${workItem.type} work item ${workItem.id}`,
    task_title: workItem.id,
    task_type: workItem.type,
    slice_summary: `${workItem.type} assigned to ${workItem.required_role}`,
    read_files: workItem.read_files,
    write_files: workItem.write_files,
    allowed_files: workItem.write_files,
    forbidden_files: [],
    dependencies: workItem.dependencies,
    expected_output_schema: workItem.expected_output_schema,
    validation_requirements: workItem.type === "test" ? workItem.read_files.filter(looksLikeCommand) : [],
    context_refs: [workItem.context_pack_ref ?? ""].filter(Boolean),
    risk_level: workItem.risk_level,
    metadata_json: {
      team_id: workItem.team_id,
      priority: workItem.priority
    }
  };
}

function validateFrame(frame: AgentIntentInputFrame): string[] {
  const errors: string[] = [];
  if (!frame.original_user_request.trim()) errors.push("intent frame original_user_request is missing.");
  if (sha256(frame.original_user_request) !== frame.original_request_hash) errors.push("intent frame original_request_hash does not match original_user_request.");
  if (frame.intent_contract.status !== "ready") errors.push(`intent contract status is ${frame.intent_contract.status}, not ready.`);
  if (frame.intent_contract.original_user_request !== frame.original_user_request) errors.push("intent contract original_user_request does not exactly match the frame original_user_request.");
  if (!frame.current_task_slice.objective.trim()) errors.push("current task slice objective is missing.");
  if (!frame.current_task_slice.expected_output_schema.trim()) errors.push("current task slice expected_output_schema is missing.");
  return errors;
}

function validateAlignment(frame: AgentIntentInputFrame, alignment: AgentIntentAlignment | undefined): string[] {
  const errors: string[] = [];
  if (!alignment) return ["intent_alignment is required."];
  if (alignment.original_request_hash !== frame.original_request_hash) errors.push("intent_alignment original_request_hash does not match the canonical original request hash.");
  if (frame.intent_contract_ref && alignment.intent_contract_ref !== frame.intent_contract_ref) errors.push("intent_alignment intent_contract_ref does not match the frame.");
  if (alignment.intent_contract_revision !== undefined && alignment.intent_contract_revision !== frame.intent_contract.revision) errors.push("intent_alignment intent_contract_revision does not match the frame.");
  if (alignment.task_slice_id !== frame.current_task_slice.task_slice_id) errors.push("intent_alignment task_slice_id does not match the current task slice.");
  if (!alignment.task_understanding.trim()) errors.push("intent_alignment.task_understanding is required.");
  if (!alignment.original_goal_contribution.trim()) errors.push("intent_alignment.original_goal_contribution is required.");
  if (!Array.isArray(alignment.possible_intent_conflicts)) errors.push("intent_alignment.possible_intent_conflicts must be an array.");
  if (alignment.possible_intent_conflicts.length > 0) errors.push(`intent_alignment declared possible conflicts: ${alignment.possible_intent_conflicts.join("; ")}`);
  if (!Array.isArray(alignment.assumptions_used)) errors.push("intent_alignment.assumptions_used must be an array.");
  if (!Array.isArray(alignment.evidence_refs)) errors.push("intent_alignment.evidence_refs must be an array.");
  return errors;
}

function requireReadyContract(contract: IntentContextSnapshot["intent_contract"]): IntentContract {
  if (!contract) throw new Error("intent_contract_required_for_handoff");
  if (contract.status !== "ready") throw new Error(`intent_contract_not_ready_for_handoff:${contract.status}`);
  return contract;
}

function normalizeLockedDefinition(definition: LockedIntentDefinition | AgentIntentLockedDefinition): AgentIntentLockedDefinition {
  return {
    term: definition.term,
    definition: definition.definition,
    revision: definition.revision,
    source: definition.source,
    artifact_ref: "artifact_ref" in definition ? definition.artifact_ref : undefined
  };
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${sha256(parts.join("\0")).slice(0, 24)}`;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "unknown_task";
}

function looksLikeCommand(value: string) {
  return /\b(npm|node|cargo|python|pytest|vitest|tsc|eslint|pnpm|yarn)\b/.test(value);
}
