export const RECURSIVE_SWARM_SCHEMA_VERSION = 1;
export const DEFAULT_COMPLEXITY_THRESHOLD = 4;
export const MAX_RECURSIVE_DEPTH = 10;
export const MIN_COMPLEXITY_FOR_SPLIT = 5;

export type RecursiveSwarmNodeKind =
  | "root"
  | "splitter"
  | "executor"
  | "goal_keeper"
  | "collector";

export type RecursiveSwarmNodeStatus =
  | "created"
  | "assessing"
  | "splitting"
  | "waiting_children"
  | "executing"
  | "collecting"
  | "succeeded"
  | "failed"
  | "blocked";

export type ComplexityScore = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type ComplexityAssessment = {
  score: ComplexityScore;
  rationale: string;
  recommendation: "split" | "execute";
};

export type SplitSubTask = {
  id: string;
  title: string;
  taskPrompt: string;
  expectedOutput: string;
  dependencies: string[];
};

export type SplitResult = {
  subTasks: SplitSubTask[];
  rationale: string;
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
  aligned: boolean;
  status: GoalAlignmentStatus;
  findings: string[];
  warnings: string[];
  timestamp: string;
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
  originalGoal: string;
  taskPrompt: string;
  depth: number;
  complexity?: ComplexityAssessment;
  splitResult?: SplitResult;
  collectResult?: CollectResult;
  goalChecks: GoalCheckResult[];
  outputSummary?: string;
  errorSummary?: string;
  children: string[];
  createdAt: string;
  updatedAt: string;
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

export type RecursiveSwarmRunOptions = {
  complexityThreshold: number;
  maxDepth: number;
  enableGoalKeeper: boolean;
  goalCheckIntervalMs: number;
  enableErrorRecovery: boolean;
  propagateGoalToAllNodes: boolean;
};

export const DEFAULT_RECURSIVE_SWARM_OPTIONS: RecursiveSwarmRunOptions = {
  complexityThreshold: DEFAULT_COMPLEXITY_THRESHOLD,
  maxDepth: MAX_RECURSIVE_DEPTH,
  enableGoalKeeper: true,
  goalCheckIntervalMs: 30_000,
  enableErrorRecovery: true,
  propagateGoalToAllNodes: true
};
