export const RECURSIVE_SWARM_SCHEMA_VERSION = 2;
export const DEFAULT_COMPLEXITY_THRESHOLD = 4;
export const MAX_RECURSIVE_DEPTH = 10;
export const MIN_COMPLEXITY_FOR_SPLIT = 5;
export const MAX_SWARM_AGENTS = 300;
export const MAX_WRITE_EXECUTORS = 6;

export type RecursiveSwarmNodeKind =
  | "root"
  | "task_agent"
  | "goal_keeper"
  | "collector"
  | "repair_agent";

export type RecursiveSwarmNodeStatus =
  | "created"
  | "assessing"
  | "splitting"
  | "waiting_children"
  | "executing"
  | "verifying"
  | "collecting"
  | "succeeded"
  | "failed"
  | "blocked"
  | "superseded"
  | "queued"
  | "escalated";

export type ComplexityScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type AtomicTaskAssessment = {
  isAtomic: boolean;
  score: ComplexityScore;
  rationale: string;
  failures: string[];
  recommendation: "split" | "execute" | "block" | "escalate";
};

export type RecursiveTaskClass = "small" | "medium" | "large" | "campaign" | "audit";

export type RecursiveRuntimeRunStatus =
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "completed"
  | "failed"
  | "blocked";

export type ExpandedGoalSpec = {
  originalPrompt: string;
  originalPromptHash: string;
  isAlreadyDetailed: boolean;
  expandedGoal: string;
  requirements: string[];
  acceptanceCriteria: string[];
  deliverableContract: string;
  constraints: string[];
  nonGoals: string[];
  qualityBar: string[];
  generatedBy: "provider" | "unavailable";
  warnings: string[];
};

export type RecursiveRunBudget = {
  hardMaxAgents: number;
  softMaxAgents: number;
  maxDepth: number;
  maxChildrenPerParent: number;
  maxWriteExecutors: number;
  reason: string;
  taskClass: RecursiveTaskClass;
};

export type GoalEnvelope = {
  originalGoal: string;
  expandedGoal?: string;
  expandedGoalSpec?: ExpandedGoalSpec;
  theme: string;
  constraints: string[];
  nonGoals: string[];
  acceptanceCriteria: string[];
  workspaceIdentity: string;
  localTask: string;
  version: number;
};

export function createGoalEnvelope(input: {
  originalGoal: string;
  theme?: string;
  constraints?: string[];
  nonGoals?: string[];
  acceptanceCriteria?: string[];
  expandedGoalSpec?: ExpandedGoalSpec;
  workspaceIdentity: string;
  localTask: string;
}): GoalEnvelope {
  return {
    originalGoal: input.originalGoal,
    expandedGoal: input.expandedGoalSpec?.expandedGoal,
    expandedGoalSpec: input.expandedGoalSpec,
    theme: input.theme ?? input.expandedGoalSpec?.expandedGoal.slice(0, 120) ?? input.originalGoal.slice(0, 120),
    constraints: input.constraints ?? input.expandedGoalSpec?.constraints ?? [],
    nonGoals: input.nonGoals ?? input.expandedGoalSpec?.nonGoals ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? input.expandedGoalSpec?.acceptanceCriteria ?? [],
    workspaceIdentity: input.workspaceIdentity,
    localTask: input.localTask,
    version: 1
  };
}

export type SplitSubTask = {
  id: string;
  title: string;
  taskPrompt: string;
  expectedOutput: string;
  dependencies: string[];
  canWrite?: boolean;
  acceptanceCriteria?: string[];
};

export type SplitResult = {
  subTasks: SplitSubTask[];
  rationale: string;
  shouldSplit?: boolean;
  desiredChildCount?: number;
  splitReason?: string;
  stopConditions?: string[];
  budgetDecision?: {
    requestedChildren: number;
    acceptedChildren: number;
    remainingSoftBudget: number;
    remainingHardBudget: number;
    reason: string;
  };
};

export type RecursiveSplitDecision = {
  shouldSplit: boolean;
  desiredChildCount: number;
  splitReason: string;
  childTasks: Array<{
    title: string;
    prompt: string;
    expectedOutput: string;
    dependencies: string[];
    canWrite: boolean;
    acceptanceCriteria: string[];
  }>;
  stopConditions: string[];
};

export type CollectResult = {
  childResults: Record<string, string>;
  mergedOutput: string;
  errors: string[];
  resolvedErrors: string[];
  unresolvedErrors: string[];
  confidence: number;
};

export type GoalAlignmentStatus =
  | "aligned"
  | "minor_drift"
  | "major_drift"
  | "unknown";

export type GoalCheckResult = {
  checkpoint: "pre_split" | "pre_execute" | "post_steer" | "pre_accept";
  aligned: boolean;
  status: GoalAlignmentStatus;
  findings: string[];
  warnings: string[];
  timestamp: string;
};

export type SteeringMessage = {
  id: string;
  senderId: string;
  text: string;
  checkpoint: "pre_split" | "pre_execute" | "post_steer" | "pre_accept";
  applied: boolean;
  classification?: "question" | "task_modification" | "restart" | "resplit";
  supersededAt?: string;
  createdAt: string;
};

// ──────────────────────────────────────────────
// Typed structured outputs for recursive nodes
// ──────────────────────────────────────────────

export type RecursiveOutputKind =
  | "evidence_report"
  | "task_plan"
  | "generated_artifact"
  | "edit_intent"
  | "validation_plan"
  | "review_decision"
  | "integration_summary"
  | "final_summary";

export type EvidenceReport = {
  kind: "evidence_report";
  findings: string[];
  files: string[];
  symbols: string[];
  evidence_refs: string[];
  unknowns: string[];
  confidence: number;
};

export type TaskPlan = {
  kind: "task_plan";
  tasks: { name: string; description: string; dependencies: string[]; risk: "low" | "medium" | "high" }[];
  validation_strategy: string;
  confidence: number;
};

export type GeneratedArtifact = {
  kind: "generated_artifact";
  path: string;
  content: string;
  artifact_type: "html" | "javascript" | "css" | "json" | "markdown" | "text" | "other";
  description: string;
  validation_steps: string[];
  completeness_notes: string[];
  confidence: number;
};

export type EditIntent = {
  kind: "edit_intent";
  target_file: string;
  target_symbol_or_range: string;
  operation: "create" | "modify" | "delete" | "refactor";
  reason: string;
  expected_behavior: string;
  risk: "low" | "medium" | "high";
  evidence_refs: string[];
};

export type ValidationPlan = {
  kind: "validation_plan";
  commands: string[];
  smoke_checks: string[];
  expected_results: string[];
  blockers: string[];
};

export type SwarmReviewDecision = {
  kind: "review_decision";
  decision: "approve" | "block" | "needs_changes";
  findings: string[];
  required_changes: string[];
  risks: string[];
};

export type IntegrationSummary = {
  kind: "integration_summary";
  child_outputs_used: number;
  conflicts: string[];
  merged_findings: string[];
  unresolved_items: string[];
};

export type FinalSummary = {
  kind: "final_summary";
  summary: string;
  blockers: string[];
  edit_intents: EditIntent[];
  validation_plans: ValidationPlan[];
  confidence: number;
};

export type RecursiveNodeOutput =
  | EvidenceReport
  | TaskPlan
  | GeneratedArtifact
  | EditIntent
  | ValidationPlan
  | SwarmReviewDecision
  | IntegrationSummary
  | FinalSummary;

/** All output kind values for validation */
export const RECURSIVE_OUTPUT_KINDS: RecursiveOutputKind[] = [
  "evidence_report", "task_plan", "generated_artifact", "edit_intent", "validation_plan",
  "review_decision", "integration_summary", "final_summary"
];

/** Allowed operation values */
export const EDIT_INTENT_OPERATIONS = ["create", "modify", "delete", "refactor"] as const;

/** Allowed risk values */
export const RISK_LEVELS = ["low", "medium", "high"] as const;

/** Allowed review decision values */
export const REVIEW_DECISIONS = ["approve", "block", "needs_changes"] as const;

// ──────────────────────────────────────────────

export type RecursiveContextSource = "memory_evidence" | "partial_context" | "prompt_only_fallback";

export type MemoryEvidencePack = {
  pack_id: string;
  node_id: string;
  task_slice: string;
  context_source: RecursiveContextSource;
  intent_contract_ref?: string;
  /** Relevant files for this specific task slice */
  relevant_files: string[];
  /** File-level line ranges (path → `startLine-endLine`) */
  file_ranges: Record<string, string>;
  /** Symbol names in the relevant files */
  symbols: string[];
  /** Known commands from project intake */
  commands: string[];
  /** Allowed path prefixes */
  allowed_paths: string[];
  /** Forbidden path prefixes */
  forbidden_paths: string[];
  /** Evidence reference IDs */
  evidence_refs: string[];
  /** Unknown/unresolved questions */
  unknowns: string[];
  /** Warnings about gaps, stale data, etc. */
  warnings: string[];
  /** Confidence 0-1 */
  confidence: number;
  /** Freshness of the underlying evidence */
  freshness_status: "fresh" | "stale" | "unknown";
};

export type RecursiveSwarmNode = {
  schema_version: number;
  id: string;
  parentId?: string;
  runId: string;
  kind: RecursiveSwarmNodeKind;
  status: RecursiveSwarmNodeStatus;
  name: string;
  role: string;
  goalEnvelope: GoalEnvelope;
  taskPrompt: string;
  depth: number;
  complexity?: AtomicTaskAssessment;
  splitResult?: SplitResult;
  splitJustification?: SplitResult["budgetDecision"];
  collectResult?: CollectResult;
  goalChecks: GoalCheckResult[];
  steeringQueue: SteeringMessage[];
  outputSummary?: string;
  /** Typed structured output (replaces free-text as source of truth) */
  structuredOutput?: RecursiveNodeOutput;
  errorSummary?: string;
  children: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Per-node memory evidence pack */
  evidencePack?: MemoryEvidencePack;
};

export type RecursiveSwarmTree = {
  schema_version: number;
  runId: string;
  rootGoal: string;
  rootId: string;
  nodes: Record<string, RecursiveSwarmNode>;
  maxDepth: number;
  totalNodes: number;
  status: "running" | "succeeded" | "failed" | "blocked";
  createdAt: string;
  updatedAt: string;
};

export type RecursiveSwarmRunState = {
  schema_version: number;
  runId: string;
  sessionId: string;
  goalEnvelope: GoalEnvelope;
  expandedGoalSpec?: ExpandedGoalSpec;
  budget?: RecursiveRunBudget;
  tree: RecursiveSwarmTree;
  createdAt: string;
  updatedAt: string;
  durableEvents: DurableSwarmEvent[];
  activityProjection?: RunActivityProjection;
  checkpoint?: RecursiveRunCheckpoint;
  runtimeStatus: RecursiveRuntimeRunStatus;
  /** Count of nodes per context source type */
  contextSourceCounts: Record<RecursiveContextSource, number>;
};

export type DurableActivityRow = {
  id: string;
  kind: "thought" | "split" | "command" | "file" | "artifact" | "validation" | "merge" | "blocker" | "error" | "checkpoint";
  title: string;
  summary: string;
  status: "running" | "completed" | "blocked" | "failed" | "queued";
  nodeId?: string;
  createdAt: string;
};

export type EphemeralStatus = {
  text: string;
  phase: "thinking" | "syncing" | "splitting" | "executing" | "collecting" | "backoff" | "idle";
  nodeId?: string;
  updatedAt: string;
};

export type RunActivityProjection = {
  durableRows: DurableActivityRow[];
  ephemeralStatus: EphemeralStatus | null;
  counters: {
    thoughts: number;
    filesViewed: number;
    commandsRun: number;
    agentsActive: number;
    agentsDone: number;
    agentsFailed: number;
  };
};

export type RecursiveNodeSnapshot = {
  id: string;
  parentId?: string;
  status: RecursiveSwarmNodeStatus;
  name: string;
  kind: RecursiveSwarmNodeKind;
  taskPrompt: string;
  depth: number;
  childIds: string[];
  updatedAt: string;
};

export type RecursiveRunCheckpoint = {
  sessionId: string;
  runId: string;
  originalPrompt: string;
  expandedGoalSpec?: ExpandedGoalSpec;
  budget?: RecursiveRunBudget;
  nodes: RecursiveNodeSnapshot[];
  pendingQueue: string[];
  completedNodeIds: string[];
  failedNodeIds: string[];
  generatedArtifacts: unknown[];
  durableActivityRows: DurableActivityRow[];
  lastStablePhase: string;
  resumable: boolean;
  runtimeStatus: RecursiveRuntimeRunStatus;
  /** Full state needed to hydrate the recursive runtime without replaying completed work. */
  tree?: RecursiveSwarmTree;
  goalEnvelope?: GoalEnvelope;
  durableEvents?: DurableSwarmEvent[];
  contextSourceCounts?: ContextSourceCounts;
  goalCheckHistory?: GoalCheckResult[];
  totalSplits?: number;
  totalExecutions?: number;
  createdAt: string;
};

export type DurableSwarmEvent = {
  id: string;
  type:
    | "run_created"
    | "node_created"
    | "node_status_changed"
    | "complexity_assessed"
    | "task_split"
    | "goal_check"
    | "steering_message"
    | "collect_completed"
    | "repair_agent_created"
    | "node_completed"
    | "run_completed"
    | "intent_expanded"
    | "budget_planned"
    | "budget_gate"
    | "checkpoint_written"
    | "run_pausing"
    | "run_paused"
    | "run_resuming"
    | "provider_backoff"
    | "error";
  nodeId?: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type ContextSourceCounts = Record<RecursiveContextSource, number>;

export type RecursiveSwarmRunOptions = {
  complexityThreshold: number;
  maxDepth: number;
  maxAgents: number;
  softMaxAgents?: number;
  maxChildrenPerParent?: number;
  maxWriteExecutors: number;
  taskClass?: RecursiveTaskClass;
  enableGoalKeeper: boolean;
  goalCheckIntervalMs: number;
  enableErrorRecovery: boolean;
  enableParallelExecution: boolean;
};

export const DEFAULT_RECURSIVE_SWARM_OPTIONS: RecursiveSwarmRunOptions = {
  complexityThreshold: DEFAULT_COMPLEXITY_THRESHOLD,
  maxDepth: MAX_RECURSIVE_DEPTH,
  maxAgents: MAX_SWARM_AGENTS,
  maxWriteExecutors: MAX_WRITE_EXECUTORS,
  enableGoalKeeper: true,
  goalCheckIntervalMs: 30_000,
  enableErrorRecovery: true,
  enableParallelExecution: true
};

// ──────────────────────────────────────────────
// Normalization helpers
// ──────────────────────────────────────────────

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return [v];
  return [];
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  return fallback;
}

function clampConfidence(v: unknown): number {
  const n = asNumber(v, 0);
  return Math.max(0, Math.min(1, n));
}

function pickOne<T extends string>(v: unknown, valid: readonly T[], fallback: T): T {
  if (typeof v === "string" && (valid as readonly string[]).includes(v)) return v as T;
  return fallback;
}

/** Normalize a raw parsed JSON value into a valid RecursiveNodeOutput.
 *  Returns the normalized output and a human-readable summary string. */
export function normalizeRecursiveNodeOutput(raw: unknown): { output: RecursiveNodeOutput; summary: string } {
  if (!raw || typeof raw !== "object") {
    return wrapTextFallback(asString(raw, "No structured output produced."));
  }
  const obj = raw as Record<string, unknown>;
  const kind = asString(obj.kind, "");

  if (kind === "evidence_report") {
    const output: EvidenceReport = {
      kind: "evidence_report",
      findings: asArray(obj.findings),
      files: asArray(obj.files),
      symbols: asArray(obj.symbols),
      evidence_refs: asArray(obj.evidence_refs),
      unknowns: asArray(obj.unknowns),
      confidence: clampConfidence(obj.confidence)
    };
    return { output, summary: output.findings.length > 0 ? `Evidence: ${output.findings.join("; ")}` : "Evidence report (no findings)." };
  }

  if (kind === "task_plan") {
    const tasksRaw = Array.isArray(obj.tasks) ? obj.tasks : [];
    const tasks = tasksRaw.map((t: unknown) => {
      const tt = (t && typeof t === "object") ? t as Record<string, unknown> : {};
      return {
        name: asString(tt.name, "Unnamed"),
        description: asString(tt.description, ""),
        dependencies: asArray(tt.dependencies),
        risk: pickOne(tt.risk, RISK_LEVELS as unknown as ("low" | "medium" | "high")[], "medium")
      };
    });
    const output: TaskPlan = {
      kind: "task_plan",
      tasks,
      validation_strategy: asString(obj.validation_strategy, "None provided"),
      confidence: clampConfidence(obj.confidence)
    };
    return { output, summary: `Plan with ${tasks.length} task(s).` };
  }

  if (kind === "generated_artifact") {
    const output: GeneratedArtifact = {
      kind: "generated_artifact",
      path: asString(obj.path, "generated.html"),
      content: asString(obj.content, ""),
      artifact_type: pickOne(
        obj.artifact_type,
        ["html", "javascript", "css", "json", "markdown", "text", "other"] as const,
        "other"
      ),
      description: asString(obj.description, "Generated artifact."),
      validation_steps: asArray(obj.validation_steps),
      completeness_notes: asArray(obj.completeness_notes),
      confidence: clampConfidence(obj.confidence)
    };
    return {
      output,
      summary: `Generated artifact ${output.path} (${output.content.length} character(s)): ${output.description.slice(0, 160)}`
    };
  }

  if (kind === "edit_intent") {
    const output: EditIntent = {
      kind: "edit_intent",
      target_file: asString(obj.target_file, "unknown"),
      target_symbol_or_range: asString(obj.target_symbol_or_range, ""),
      operation: pickOne(obj.operation, EDIT_INTENT_OPERATIONS as unknown as EditIntent["operation"][], "modify"),
      reason: asString(obj.reason, ""),
      expected_behavior: asString(obj.expected_behavior, ""),
      risk: pickOne(obj.risk, RISK_LEVELS as unknown as ("low"|"medium"|"high")[], "medium"),
      evidence_refs: asArray(obj.evidence_refs)
    };
    return { output, summary: `Edit ${output.operation} ${output.target_file} (${output.risk} risk): ${output.reason.slice(0, 80)}` };
  }

  if (kind === "validation_plan") {
    const output: ValidationPlan = {
      kind: "validation_plan",
      commands: asArray(obj.commands),
      smoke_checks: asArray(obj.smoke_checks),
      expected_results: asArray(obj.expected_results),
      blockers: asArray(obj.blockers)
    };
    return { output, summary: `Validation: ${output.commands.length} command(s), ${output.blockers.length} blocker(s).` };
  }

  if (kind === "review_decision") {
    const output: SwarmReviewDecision = {
      kind: "review_decision",
      decision: pickOne(obj.decision, REVIEW_DECISIONS as unknown as SwarmReviewDecision["decision"][], "needs_changes"),
      findings: asArray(obj.findings),
      required_changes: asArray(obj.required_changes),
      risks: asArray(obj.risks)
    };
    return { output, summary: `Review: ${output.decision}. ${output.findings.length} finding(s).` };
  }

  if (kind === "integration_summary") {
    const output: IntegrationSummary = {
      kind: "integration_summary",
      child_outputs_used: Math.max(0, Math.floor(asNumber(obj.child_outputs_used, 0))),
      conflicts: asArray(obj.conflicts),
      merged_findings: asArray(obj.merged_findings),
      unresolved_items: asArray(obj.unresolved_items)
    };
    return { output, summary: `Integration: ${output.child_outputs_used} child output(s), ${output.conflicts.length} conflict(s), ${output.unresolved_items.length} unresolved.` };
  }

  if (kind === "final_summary") {
    const editIntentsRaw = Array.isArray(obj.edit_intents) ? obj.edit_intents : [];
    const editIntents: EditIntent[] = editIntentsRaw.map((e: unknown) => {
      const ee = (e && typeof e === "object") ? e as Record<string, unknown> : {};
      return {
        kind: "edit_intent",
        target_file: asString(ee.target_file, "unknown"),
        target_symbol_or_range: asString(ee.target_symbol_or_range, ""),
        operation: pickOne(ee.operation, EDIT_INTENT_OPERATIONS as unknown as EditIntent["operation"][], "modify"),
        reason: asString(ee.reason, ""),
        expected_behavior: asString(ee.expected_behavior, ""),
        risk: pickOne(ee.risk, RISK_LEVELS as unknown as ("low"|"medium"|"high")[], "medium"),
        evidence_refs: asArray(ee.evidence_refs)
      };
    });
    const valPlansRaw = Array.isArray(obj.validation_plans) ? obj.validation_plans : [];
    const validationPlans: ValidationPlan[] = valPlansRaw.map((v: unknown) => {
      const vv = (v && typeof v === "object") ? v as Record<string, unknown> : {};
      return {
        kind: "validation_plan",
        commands: asArray(vv.commands),
        smoke_checks: asArray(vv.smoke_checks),
        expected_results: asArray(vv.expected_results),
        blockers: asArray(vv.blockers)
      };
    });
    const output: FinalSummary = {
      kind: "final_summary",
      summary: asString(obj.summary, "No summary provided."),
      blockers: asArray(obj.blockers),
      edit_intents: editIntents,
      validation_plans: validationPlans,
      confidence: clampConfidence(obj.confidence)
    };
    return { output, summary: output.summary };
  }

  // Unknown kind — wrap as text fallback
  return wrapTextFallback(JSON.stringify(raw, null, 2));
}

/** Wrap raw text into a FinalSummary with prompt_only fallback. */
export function wrapTextFallback(text: string): { output: FinalSummary; summary: string } {
  const output: FinalSummary = {
    kind: "final_summary",
    summary: text,
    blockers: [],
    edit_intents: [],
    validation_plans: [],
    confidence: 0.1
  };
  return { output, summary: text };
}
