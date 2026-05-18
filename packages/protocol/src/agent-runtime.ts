import type {
  BackgroundJobRecord,
  CommandExecutionProvenance,
  CommandExecutionRecord,
  CommandRequest,
  DecisionRecord,
  ReviewGateSummary,
  RunMode,
  RunPhase,
  RuntimeLifecycleEventType,
  Artifact,
  PatchProposal,
  PreviewRecommendation,
  Task,
  ToolIntent,
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
import type {
  AccessProfile,
  AccessProfileInput,
  DeclaredAccessPolicy,
  ResolvedAccessPolicy,
  RunTrustProfile,
  SafetySettings
} from "./approvals.js";
import type {
  ModelProviderConfig,
  ProjectContextPack,
  ProjectExplainReport,
  ProjectIntake,
  ProjectRunIntent,
  ModuleExecutionPlan,
  ModuleExecutionSummary,
  ModuleScopeValidation,
  RunToGreenState
} from "./models.js";

export type AgentRuntimeMode = "demo_mock" | "real_provider";

export type AgentLifecycleStage =
  | "INTAKE"
  | "THINK"
  | "PLAN"
  | "CONTEXT_GATHER"
  | "EXECUTION_DRAFT"
  | "SELF_REVIEW"
  | "CROSS_REVIEW"
  | "VALIDATION"
  | "APPROVAL"
  | "APPLY"
  | "POST_VERIFY"
  | "DONE"
  | "BLOCKED"
  | "FAILED";

export type RuntimeSessionStatus =
  | "created"
  | "restored"
  | "running"
  | "completed"
  | "needs_approval"
  | "blocked"
  | "failed"
  | "expired";

export type RuntimeTaskPhase =
  | "created"
  | "restored"
  | "planning"
  | "awaiting_patch_approval"
  | "awaiting_patch_apply"
  | "patch_applied"
  | "patch_apply_failed"
  | "awaiting_command_execution"
  | "verification_pending"
  | "verification_passed"
  | "verification_failed"
  | "completed"
  | "failed"
  | "expired";

export type RuntimeRestoreSource = "fresh" | "snapshot_restored" | "event_replayed";

export type RuntimeRestoreDisposition =
  | "resumable"
  | "terminal"
  | "expired"
  | "corrupt"
  | "orphaned"
  | "reconciliation_required"
  | "non_restorable";

export type RuntimeRestoreState = {
  source: RuntimeRestoreSource;
  disposition: RuntimeRestoreDisposition;
  warnings: string[];
  reason?: string;
  restoredAt?: string;
  lastEventSequence?: number;
  eventCount?: number;
};

export type RuntimeTaskTransitionType = RuntimeLifecycleEventType;

export type RuntimeTaskTransition = {
  id: string;
  phase: RuntimeTaskPhase;
  type: RuntimeTaskTransitionType;
  detail: string;
  createdAt: string;
};

export type RuntimeTaskState = {
  version: number;
  phase: RuntimeTaskPhase;
  restoreState?: RuntimeRestoreState;
  pendingPatchId?: string;
  activePatchId?: string;
  pendingCommandIds: string[];
  completedCommandIds: string[];
  failedCommandIds: string[];
  lastCommandProvenance?: CommandExecutionProvenance;
  lastVerificationStatus?: import("./models.js").VerificationResult["status"];
  finalStatus?: RuntimeSessionStatus;
  transitions: RuntimeTaskTransition[];
};

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
  trustProfile: RunTrustProfile;
  providerConfig?: SanitizedProviderConfig;
  executionMode: RuntimeExecutionMode;
  resolvedExecutionMode?: Exclude<RuntimeExecutionMode, "auto_mode">;
  accessProfile: AccessProfile;
  declaredAccess: DeclaredAccessPolicy;
  resolvedAccess?: ResolvedAccessPolicy;
  runMode?: RunMode;
  runPhases: RunPhase[];
  decisionLedger: DecisionRecord[];
  projectIntake?: ProjectIntake;
  contextPack?: ProjectContextPack;
  explainReport?: ProjectExplainReport;
  runIntent?: ProjectRunIntent;
  runToGreen?: RunToGreenState;
  moduleExecutionPlan?: ModuleExecutionPlan;
  moduleExecutionSummaries?: ModuleExecutionSummary[];
  latestScopeValidation?: ModuleScopeValidation;
  reviewGate?: ReviewGateSummary;
  reconciliationReport?: import("./models.js").ReconciliationReport;
  thinkFirst: boolean;
  userPrompt: string;
  agentName: string;
  status: RuntimeSessionStatus;
  lifecycleStage: AgentLifecycleStage;
  taskState: RuntimeTaskState;
  validationGateResult?: import("./orchestration.js").ValidationGateResult;
  messages: RuntimeMessage[];
  plan?: AgentPlan;
  tasks: Task[];
  toolCalls: ToolCall[];
  toolIntents: ToolIntent[];
  artifacts: Artifact[];
  patchProposals: PatchProposal[];
  commandRequests: CommandRequest[];
  commandExecutions: CommandExecutionRecord[];
  backgroundJobs: BackgroundJobRecord[];
  reasoningSummaries: string[];
  progressEvents: RuntimeProgressEvent[];
  agentWorkStatuses: AgentWorkStatus[];
  runSummary?: RunSummary;
  verificationResult?: import("./models.js").VerificationResult;
  delegationDecision?: DelegationDecision;
  nextAction?: SessionNextAction;
  previewRecommendation?: PreviewRecommendation;
  orchestration?: OrchestrationState;
  createdAt: string;
  updatedAt: string;
};

export type RunLifecycleStage = AgentLifecycleStage;
export type RunSession = AgentRuntimeSession;

export type CreateRuntimeSessionRequest = {
  workspacePath: string;
  mode: AgentRuntimeMode;
  trustProfile?: RunTrustProfile;
  providerConfig?: SanitizedProviderConfig;
  sessionToken?: string;
  sessionTokenExpiresAt?: string;
  executionMode?: RuntimeExecutionMode;
  accessProfile?: AccessProfileInput;
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

export type ReportPatchApplyResultRequest = {
  status: "applied" | "failed";
  message: string;
  reconciliationSnapshot?: {
    before?: import("./models.js").WorkspaceDiffSnapshot;
    after?: import("./models.js").WorkspaceDiffSnapshot;
  };
};

export type ReportCommandResultRequest = {
  command: string;
  cwd: string;
  risk: import("./models.js").CommandRisk;
  status: import("./models.js").CommandResult["status"];
  exitCode?: number;
  stdout: string;
  stderr: string;
  message?: string;
  diagnosis?: import("./models.js").CommandFailureDiagnosis;
  autoRun?: boolean;
  provenance?: import("./models.js").CommandExecutionProvenance;
  backgroundJob?: import("./models.js").BackgroundJobRecord;
};

export type SanitizedProviderConfig = Pick<
  ModelProviderConfig,
  "providerType" | "providerName" | "baseUrl" | "selectedModel" | "isValid"
>;
