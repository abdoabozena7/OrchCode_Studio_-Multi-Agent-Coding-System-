import type {
  CommandLifecycleEventType,
  CommandRequest,
  PatchLifecycleEventType,
  PatchProposal,
  PreviewRecommendation,
  SessionLifecycleEventType,
  VerificationLifecycleEventType,
  WorkspaceInfo
} from "./models.js";
import type { AgentRun, WorkerOutput } from "./agents.js";
import type { RunTrustProfile, SafetySettings } from "./approvals.js";
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

export type WorkOrder = {
  id: string;
  sessionId: string;
  agentName: string;
  dynamicRole: string;
  objective: string;
  acceptanceCriteria: string[];
  requiredArtifacts: string[];
  allowedTools: string[];
  dependsOn: string[];
};

export type WorkerCapabilityGrant = {
  id: string;
  workerId: string;
  sessionId: string;
  allowedPaths: string[];
  allowedTools: string[];
  allowedCommandRisks: Array<"safe" | "medium" | "dangerous">;
  canProposePatches: boolean;
  canRequestCommands: boolean;
  allowNetwork: boolean;
  expiresAt: string;
};

export type WorkerSpec = {
  id: string;
  sessionId: string;
  roleTitle: string;
  persona: string;
  objective: string;
  tasks: string[];
  acceptanceCriteria: string[];
  requiredArtifacts: string[];
  dependsOn: string[];
  targetFiles: string[];
  capabilityGrant: WorkerCapabilityGrant;
};

export type ArtifactHandoff = {
  id: string;
  sessionId: string;
  workerId: string;
  roleTitle: string;
  summary: string;
  details: string[];
  patchProposalIds: string[];
  commandRequestIds: string[];
  validationNotes: string[];
  createdAt: string;
};

export type ValidationGateResult = {
  id: string;
  sessionId: string;
  status: "passed" | "failed";
  blockingReasons: string[];
  notes: string[];
  createdAt: string;
};

export type AgentAssignmentPlan = {
  id: string;
  sessionId: string;
  trustProfile: RunTrustProfile;
  workerSpecs: WorkerSpec[];
  rationale: string;
  createdAt: string;
};

export type WorkerSelfCheck = {
  workOrderId: string;
  passedCriteria: string[];
  failedCriteria: string[];
  missingItems: string[];
  confidence: number;
};

export type QualityGateResult = {
  id: string;
  sessionId: string;
  gateName: "ReviewerGate" | "SecurityGate" | "TestGate";
  status: "passed" | "failed";
  blockingReasons: string[];
  reviewerNotes: string[];
  createdAt: string;
};

export type PatchChangeStats = {
  path: string;
  added?: number;
  removed?: number;
  changeType: "create" | "modify" | "delete";
};

export type RuntimeProgressStage =
  | "planning"
  | "inspecting"
  | "assigning"
  | "working"
  | "patching"
  | "reviewing"
  | "applying"
  | "completed"
  | "blocked";

export type RuntimeProgressStatus = "queued" | "running" | "completed" | "blocked" | "failed";

export type RuntimeProgressEvent = {
  id: string;
  sessionId: string;
  stage: RuntimeProgressStage;
  agentName?: string;
  role?: string;
  taskTitle?: string;
  summary: string;
  status: RuntimeProgressStatus;
  targetFiles: string[];
  patchStats?: PatchChangeStats[];
  createdAt: string;
};

export type AgentWorkStatus = {
  agentName: string;
  role: string;
  taskTitle: string;
  objective: string;
  status: RuntimeProgressStatus;
  targetFiles: string[];
  summary?: string;
  selfCheck?: WorkerSelfCheck;
  updatedAt: string;
};

export type RunSummary = {
  status: "pending" | "completed" | "blocked" | "failed";
  summary: string;
  filesChanged: PatchChangeStats[];
  appliedPatchIds: string[];
  proposedPatchIds: string[];
  commandResults: string[];
  gates: Array<{
    name: string;
    status: "passed" | "failed" | "blocked";
    notes: string[];
  }>;
  nextAction?: string;
  createdAt: string;
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
  projectKind?: import("./models.js").ProjectKind;
  intakeConfidence?: import("./models.js").ProjectIntakeConfidence;
  currentStateSummary?: string;
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
  | "file_lock.waiting"
  | "file_lock.conflict"
  | "file_lock.released"
  | "parallel_execution.active"
  | "lifecycle.stage.changed"
  | "validation.completed"
  | "agent.started"
  | "agent.completed"
  | PatchLifecycleEventType
  | "security.reviewed"
  | CommandLifecycleEventType
  | VerificationLifecycleEventType
  | SessionLifecycleEventType
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
  assignmentPlan?: AgentAssignmentPlan;
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
  selectedWorkerAgents: string[];
  mandatoryGateAgents: string[];
  workOrders: WorkOrder[];
  qualityGateResults: QualityGateResult[];
  validationGateResult?: ValidationGateResult;
  artifactHandoffs?: ArtifactHandoff[];
  retryCount: number;
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
      kind: "clarify_plan";
      message: string;
      options: Array<{
        id: string;
        label: string;
        prompt: string;
      }>;
      allowCustom?: boolean;
    }
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
      kind: "approve_commands";
      message: string;
    }
  | {
      kind: "preview_ready";
      message: string;
      preview: PreviewRecommendation;
    };
