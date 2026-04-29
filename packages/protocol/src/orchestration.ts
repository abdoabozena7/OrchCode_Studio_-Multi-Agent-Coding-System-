import type { CommandRequest, PatchProposal, PreviewRecommendation, WorkspaceInfo } from "./models.js";
import type { AgentRun, WorkerOutput } from "./agents.js";
import type { SafetySettings } from "./approvals.js";
import type { TaskGraph } from "./task-graph.js";

export type RuntimeExecutionMode = "auto_mode" | "simple_mode" | "orchestrated_mode";

export type DelegationComplexity = "low" | "medium" | "high";

export type AgentRoleReason = {
  agentName: string;
  reason: string;
};

export type DelegationDecision = {
  resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">;
  explicitUserDirective?: string;
  requestedAgentCount?: number;
  selectedAgentCount: number;
  selectedAgentRoles: string[];
  agentRoleReasons: AgentRoleReason[];
  estimatedComplexity: DelegationComplexity;
  rationale: string;
};

export type ProductBrief = {
  goal: string;
  userIntent:
    | "new_project"
    | "modify_existing_project"
    | "bug_fix"
    | "refactor"
    | "add_feature"
    | "write_tests"
    | "explain_code";
  scope: string[];
  constraints: string[];
  successCriteria: string[];
  clarifyingQuestions: string[];
  assumptions: string[];
};

export type BusinessBrief = {
  mvpScope: string[];
  outOfScope: string[];
  userValue: string;
  businessRisks: string[];
  acceptanceCriteria: string[];
  priority: "low" | "medium" | "high";
  releaseNotesDraft: string;
};

export type TechnicalPlan = {
  summary: string;
  architectureImpact: string;
  affectedAreas: string[];
  testStrategy: string[];
  riskLevel: "low" | "medium" | "high";
  taskGraph: TaskGraph;
};

export type ProjectMap = {
  stack: string[];
  packageManagers: string[];
  testCommands: string[];
  entryPoints: string[];
  importantFiles: string[];
};

export type ReviewResult = {
  id: string;
  sessionId: string;
  reviewer: "SecurityAgent" | "ReviewerAgent";
  targetIds: string[];
  status: "passed" | "needs_changes" | "blocked";
  summary: string;
  findings: string[];
  createdAt: string;
};

export type OrchestrationEventType =
  | "orchestration.started"
  | "product_brief.created"
  | "business_brief.created"
  | "technical_plan.created"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "file_lock.acquired"
  | "file_lock.released"
  | "agent.started"
  | "agent.completed"
  | "patch.proposed"
  | "patch.reviewed"
  | "security.reviewed"
  | "command.requested"
  | "command.completed"
  | "orchestration.completed"
  | "orchestration.failed";

export type OrchestrationEvent = {
  id: string;
  sessionId: string;
  type: OrchestrationEventType;
  message: string;
  agentName?: string;
  taskId?: string;
  createdAt: string;
};

export type OrchestrationState = {
  productBrief?: ProductBrief;
  businessBrief?: BusinessBrief;
  technicalPlan?: TechnicalPlan;
  taskGraph?: TaskGraph;
  projectMap?: ProjectMap;
  agentRuns: AgentRun[];
  workerOutputs: WorkerOutput[];
  securityReviews: ReviewResult[];
  reviewerSummaries: ReviewResult[];
  orchestrationEvents: OrchestrationEvent[];
  approvalDecisions: import("./approvals.js").ApprovalRecord[];
  safetySettings: SafetySettings;
  lockedFiles: Record<string, string>;
};

export type OrchestrationRunContext = {
  sessionId: string;
  userPrompt: string;
  workspacePath: string;
  workspaceInfo?: WorkspaceInfo;
  safetySettings: SafetySettings;
  patchProposals: PatchProposal[];
  commandRequests: CommandRequest[];
};

export type SessionNextAction =
  | {
      kind: "confirm_plan";
      message: string;
    }
  | {
      kind: "confirm_preview";
      message: string;
      preview: PreviewRecommendation;
    }
  | {
      kind: "preview_ready";
      message: string;
      preview: PreviewRecommendation;
    };
