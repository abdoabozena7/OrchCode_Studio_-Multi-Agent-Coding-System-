import type {
  CommandExecutionRecord,
  CommandRequest,
  PatchProposal,
  PreviewRecommendation,
  Task,
  ToolCall
} from "./models.js";
import type {
  AgentWorkStatus,
  DelegationDecision,
  OrchestrationState,
  RunSummary,
  RuntimeProgressEvent,
  RuntimeExecutionMode,
  SessionNextAction
} from "./orchestration.js";
import type { AccessProfile, SafetySettings } from "./approvals.js";

export type AgentRuntimeMode = "mock" | "real";

export type AgentLifecycleStage =
  | "INTAKE"
  | "REPO_SCAN"
  | "PLAN"
  | "CONTEXT_GATHERING"
  | "PATCH_PROPOSAL"
  | "REVIEW_REQUEST"
  | "OPTIONAL_COMMAND_REQUEST"
  | "DONE";

export type RuntimeSessionStatus =
  | "created"
  | "running"
  | "completed"
  | "needs_approval"
  | "failed";

export type RuntimeMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type AgentPlan = {
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    detail: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  acceptanceCriteria: string[];
  risks: string[];
};

export type AgentRuntimeSession = {
  id: string;
  workspacePath: string;
  mode: AgentRuntimeMode;
  executionMode: RuntimeExecutionMode;
  resolvedExecutionMode?: Exclude<RuntimeExecutionMode, "auto_mode">;
  accessProfile: AccessProfile;
  thinkFirst: boolean;
  userPrompt: string;
  agentName: string;
  status: RuntimeSessionStatus;
  lifecycleStage: AgentLifecycleStage;
  messages: RuntimeMessage[];
  plan?: AgentPlan;
  tasks: Task[];
  toolCalls: ToolCall[];
  patchProposals: PatchProposal[];
  commandRequests: CommandRequest[];
  commandExecutions: CommandExecutionRecord[];
  reasoningSummaries: string[];
  progressEvents: RuntimeProgressEvent[];
  agentWorkStatuses: AgentWorkStatus[];
  runSummary?: RunSummary;
  delegationDecision?: DelegationDecision;
  nextAction?: SessionNextAction;
  previewRecommendation?: PreviewRecommendation;
  orchestration?: OrchestrationState;
  createdAt: string;
  updatedAt: string;
};

export type CreateRuntimeSessionRequest = {
  workspacePath: string;
  mode: AgentRuntimeMode;
  executionMode?: RuntimeExecutionMode;
  accessProfile?: AccessProfile;
  thinkFirst?: boolean;
  userPrompt: string;
  safetySettings?: Partial<SafetySettings>;
};

export type CreateRuntimeSessionResponse = {
  sessionId: string;
  status: "created";
};

export type RuntimeTurnRequest = {
  message: string;
};

export type RuntimeTurnResponse = {
  sessionId: string;
  status: RuntimeSessionStatus;
};
