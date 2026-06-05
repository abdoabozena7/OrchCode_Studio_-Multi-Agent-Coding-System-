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

export type ActiveProviderSource =
  | "runtime_default"
  | "desktop_saved_provider"
  | "session_override"
  | "explicit_cli"
  | "env_ollama"
  | "env_openai_compatible"
  | "unknown";

export type ProviderPromptLatency = {
  requestId: string;
  requestType: "structured" | "text";
  providerName: string;
  modelName?: string;
  latencyMs: number;
  status: "success" | "failure" | "timeout";
  errorSummary?: string;
  systemPromptChars?: number;
  userPromptChars?: number;
  contextChars?: number;
  promptChars?: number;
  responseChars?: number;
};

export type ProviderTruthTelemetry = {
  providerMode: AgentRuntimeMode;
  providerName: string;
  modelName?: string;
  providerBaseUrl?: string;
  providerRequestCount: number;
  mockProviderRequestCount: number;
  realProviderRequestCount: number;
  providerResponseCount: number;
  providerFailureCount: number;
  providerTimeoutCount: number;
  totalProviderLatencyMs: number;
  totalProviderPromptChars: number;
  totalProviderResponseChars: number;
  totalProviderContextChars: number;
  perPromptProviderLatencyMs: ProviderPromptLatency[];
  fallbackUsed: boolean;
  fallbackReason?: string;
  lastError?: string;
  deterministicOnly: boolean;
  mockProviderUsed: boolean;
  realProviderUsed: boolean;
  activeProviderSource: ActiveProviderSource;
  updatedAt: string;
};

export type EvidenceFileTier =
  | "source_code"
  | "test"
  | "docs"
  | "generated"
  | "runtime_state"
  | "config";

export type EvidenceSourceType =
  | "production_source"
  | "test_source"
  | "fixture_generated_path"
  | "tmp_artifact"
  | "memory_artifact"
  | "documentation"
  | "generated_report"
  | "runtime_state"
  | "config"
  | "unknown";

export type EvidencePathVerification = {
  sourceFile: string;
  citedPath: string;
  existsOnDisk: boolean;
  safePath: boolean;
  pathTraversalRejected: boolean;
  mentionedOnly: boolean;
};

export type EvidenceConfidence = "high" | "medium" | "low";

export type EvidenceDirectness =
  | "direct_implementation"
  | "indirect_test_or_fixture"
  | "documentation_only"
  | "generated_artifact"
  | "unknown";

export type EvidenceProvenance = {
  sourceFile: string;
  citedPath: string;
  mentionedPaths: string[];
  sourceType: EvidenceSourceType;
  pathVerification: EvidencePathVerification;
  directness: EvidenceDirectness;
  confidence: EvidenceConfidence;
  reason: string;
};

export type GroundedEvidenceItem = {
  ref: string;
  sourceFile: string;
  citedPath: string;
  sourceType: EvidenceSourceType;
  existsOnDisk: boolean;
  directness: EvidenceDirectness;
  confidence: EvidenceConfidence;
  reason: string;
};

export type RejectedEvidenceItem = {
  ref: string;
  sourceFile: string;
  citedPath: string;
  sourceType: EvidenceSourceType;
  reason: string;
};

export type EvidenceTruthReport = {
  topEvidenceFiles: string[];
  evidenceFilesByTier: Record<EvidenceFileTier, string[]>;
  excludedEvidenceCandidates: string[];
  exclusionReasons: Record<string, string>;
  finalEvidenceFilesActuallyUsed: string[];
  groundedEvidence?: GroundedEvidenceItem[];
  rejectedEvidence?: RejectedEvidenceItem[];
  generatedEvidenceExcludedCount: number;
  generatedEvidenceIncludedCount: number;
  generatedEvidenceIncluded: boolean;
  allowGeneratedEvidence: boolean;
  updatedAt: string;
};

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
  | "failed_provider"
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
  requireRealProvider?: boolean;
  trustProfile: RunTrustProfile;
  providerConfig?: SanitizedProviderConfig;
  activeProviderSource?: ActiveProviderSource;
  providerTelemetry?: ProviderTruthTelemetry;
  evidenceReport?: EvidenceTruthReport;
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
  requireRealProvider?: boolean;
  trustProfile?: RunTrustProfile;
  providerConfig?: SanitizedProviderConfig;
  activeProviderSource?: ActiveProviderSource;
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
> & {
  apiKeyEnv?: string;
  apiKeyConfigured?: boolean;
};
