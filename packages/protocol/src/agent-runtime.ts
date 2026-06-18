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
  ProjectKnowledgeTree,
  KnowledgeRoutedEdit,
  KnowledgeBranchTarget,
  ProjectIntake,
  ProjectRunIntent,
  ModuleExecutionPlan,
  ModuleExecutionSummary,
  ModuleScopeValidation,
  RunToGreenState
} from "./models.js";

export type AgentRuntimeMode = "real_provider";

export type ActiveProviderSource =
  | "runtime_default"
  | "desktop_saved_provider"
  | "session_override"
  | "explicit_cli"
  | "env_ollama"
  | "env_openai_compatible"
  | "unknown";

export type ProviderPipelineStage =
  | "route"
  | "reason"
  | "retrieve"
  | "curate"
  | "compose"
  | "repair"
  | "verify"
  | "decide"
  | "escalate";

export type ProviderPromptLatency = {
  requestId: string;
  requestType: "structured" | "text";
  purpose?: ProviderPipelineStage;
  reasoningStage?: import("./project-understanding.js").ReasoningStage;
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
  maxOutputTokens?: number;
};

export type ProviderTruthTelemetry = {
  providerMode: AgentRuntimeMode;
  providerName: string;
  modelName?: string;
  providerBaseUrl?: string;
  providerRequestCount: number;
  realProviderRequestCount: number;
  providerResponseCount: number;
  providerFailureCount: number;
  providerTimeoutCount: number;
  totalProviderLatencyMs: number;
  totalProviderPromptChars: number;
  totalProviderResponseChars: number;
  totalProviderContextChars: number;
  perPromptProviderLatencyMs: ProviderPromptLatency[];
  lastError?: string;
  reasoningAttempts: number;
  repairAttempts: number;
  providerRequestRefs: string[];
  finalResponseSource: "provider" | "none";
  terminalFailure?: string;
  modelCertification: {
    status: "certified" | "uncertified";
    routerModel?: string;
    authorModel?: string;
    verifierModel?: string;
    corpusHash?: string;
    reportPath?: string;
    certifiedAt?: string;
    certifiedGates?: Array<"read_reasoning" | "action_reasoning">;
    reason?: string;
  };
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

export type DecisionAction = "ANSWER" | "FOLLOW_UP" | "REFUSE" | "ESCALATE";

export type QueryUnderstanding = {
  originalRequest: string;
  cleanedRequest: string;
  intentKind: "direct_conversation" | "workspace_question" | "workspace_action" | "run_request";
  route: "chat" | "inspect_explain" | "simple_run" | "orchestrated_run" | "recursive_factory" | "swarm_readonly";
  archetype: string;
  requiredFacets: string[];
  missingFacts: string[];
  risk: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  rationale: string;
  source: "provider" | "local_guard";
};

export type AnswerVerificationReport = {
  status: "verified" | "rejected" | "unavailable";
  providerVerdict?: "pass" | "fail" | "needs_more_evidence";
  supportedClaims: string[];
  unsupportedClaims: string[];
  missingFacts: string[];
  hardErrors: string[];
  repairableErrors: string[];
  evidenceRefs: string[];
  verifierSource: "provider_and_deterministic" | "deterministic_only";
  createdAt: string;
};

export type DecisionOutcome = {
  action: DecisionAction;
  reason: string;
  confidence: "high" | "medium" | "low";
  escalationTarget?: "provider_readonly_swarm" | "approval_gate";
  createdAt: string;
};

export type DecisionPipelineStageRecord = {
  stage: ProviderPipelineStage;
  status: "pending" | "running" | "completed" | "fallback" | "blocked" | "skipped";
  source: "provider" | "deterministic" | "hybrid";
  detail: string;
  updatedAt: string;
};

export type DecisionPipelineState = {
  id: string;
  version: 1 | 2;
  query: QueryUnderstanding;
  stages: DecisionPipelineStageRecord[];
  callBudget: {
    maxProviderCalls: number;
    maxRepairAttempts: number;
    maxEscalationHops: number;
  };
  verification?: AnswerVerificationReport;
  outcome?: DecisionOutcome;
  turnUnderstanding?: import("./project-understanding.js").TurnUnderstanding;
  reasoningDirective?: import("./project-understanding.js").ReasoningDirective;
  reasoningInitialStep?: import("./project-understanding.js").ReasoningStep;
  reasoningTrace?: import("./project-understanding.js").ReasoningTurnTrace;
  reasoningAttempts: number;
  repairAttempts: number;
  providerRequestRefs: string[];
  finalResponseSource: "provider" | "none";
  terminalFailure?: string;
  createdAt: string;
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
  providerRequestRefs?: string[];
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
  responseLanguage?: "ar" | "en";
  debugMode?: boolean;
  trustProfile: RunTrustProfile;
  providerConfig?: SanitizedProviderConfig;
  activeProviderSource?: ActiveProviderSource;
  providerTelemetry?: ProviderTruthTelemetry;
  latestDecisionPipeline?: DecisionPipelineState;
  decisionPipelineHistory?: DecisionPipelineState[];
  evidenceReport?: EvidenceTruthReport;
  executionMode: RuntimeExecutionMode;
  resolvedExecutionMode?: Exclude<RuntimeExecutionMode, "auto_mode">;
  recursiveFactory?: import("./orchestration.js").RecursiveFactoryState;
  accessProfile: AccessProfile;
  declaredAccess: DeclaredAccessPolicy;
  resolvedAccess?: ResolvedAccessPolicy;
  runMode?: RunMode;
  runPhases: RunPhase[];
  decisionLedger: DecisionRecord[];
  projectIntake?: ProjectIntake;
  contextPack?: ProjectContextPack;
  explainReport?: ProjectExplainReport;
  projectKnowledgeTree?: ProjectKnowledgeTree;
  latestKnowledgeRoute?: KnowledgeRoutedEdit;
  latestKnowledgeBranchTargets?: KnowledgeBranchTarget[];
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
  responseLanguage?: "ar" | "en";
  debugMode?: boolean;
  debug_mode?: boolean;
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

export type RecursiveBranchExecutionStartRequest = {
  approved: true;
  targetFile?: string;
  replacementText?: string;
  branchTargets?: Array<{
    branchId?: string;
    targetFile: string;
    replacementText: string;
    nestedSubtasks?: Array<{
      targetFile: string;
      replacementText: string;
      objective?: string;
    }>;
  }>;
};

export type ReportPatchApplyResultRequest = {
  status: "apply_started" | "applied" | "failed";
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

export type FactoryApprovalDecisionRequest = {
  decision: "approved" | "rejected" | "changes_requested";
  feedback?: string;
};

export type SanitizedProviderConfig = Pick<
  ModelProviderConfig,
  "providerType" | "providerName" | "baseUrl" | "selectedModel" | "routerModel" | "verifierModel" | "embeddingModel" | "isValid"
> & {
  apiKeyEnv?: string;
  apiKeyConfigured?: boolean;
};
