export type Project = {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  projectId?: string;
  userPrompt: string;
  status: "mock_created" | "planning" | "running" | "blocked" | "done";
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  sessionId: string;
  title: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  agentRole?: string;
  createdAt: string;
};

export type AgentStatus = {
  id: string;
  sessionId: string;
  name: string;
  status: "idle" | "planning" | "running" | "done" | "blocked";
  detail?: string;
};

export type ToolCall = {
  id: string;
  sessionId: string;
  toolName: string;
  status: "pending" | "running" | "success" | "error" | "blocked";
  inputSummary?: string;
  outputSummary?: string;
  createdAt: string;
};

export type PatchRiskLevel = "low" | "medium" | "high";

export type PatchProposalStatus = "proposed" | "approved" | "rejected" | "applied" | "apply_failed";

export type VerificationStatus = "pending" | "passed" | "failed";
export type VerificationCheckStatus = "not_run" | "running" | "passed" | "failed" | "skipped" | "unavailable" | "pending";

export type RunMode = "quick_fix" | "normal_run" | "inspect_only" | "deep_audit" | "soak_mode" | "paranoid_mode" | "run_to_green";

export type RunPhaseId =
  | "inspect_workspace"
  | "build_repo_map"
  | "split_agents"
  | "agents_running"
  | "integrate_changes"
  | "run_verification"
  | "review_final_diff"
  | "final_report";

export type RunPhaseStatus = "pending" | "active" | "completed" | "blocked" | "failed";

export type CommandRequestStatus =
  | "requested"
  | "approved"
  | "denied"
  | "rejected"
  | "executing"
  | "running"
  | "executed"
  | "terminated"
  | "orphaned"
  | "unknown"
  | "blocked"
  | "failed";

export type CommandExecutionStatus =
  | "executing"
  | "running"
  | "executed"
  | "completed"
  | "approval_required"
  | "blocked"
  | "terminated"
  | "orphaned"
  | "unknown"
  | "failed";

export type SessionLifecycleEventType =
  | "session.created"
  | "session.restored"
  | "session.expired"
  | "session.completed"
  | "session.failed";

export type PatchLifecycleEventType =
  | "patch.proposed"
  | "patch.approved"
  | "patch.rejected"
  | "patch.applied"
  | "patch.apply_failed";

export type CommandLifecycleEventType =
  | "command.requested"
  | "command.approved"
  | "command.rejected"
  | "command.started"
  | "command.completed"
  | "command.failed"
  | "command.blocked";

export type VerificationLifecycleEventType =
  | "verification.pending"
  | "verification.running"
  | "verification.passed"
  | "verification.failed"
  | "verification.not_run"
  | "verification.skipped"
  | "verification.unavailable";

export type RuntimeLifecycleEventType =
  | SessionLifecycleEventType
  | PatchLifecycleEventType
  | CommandLifecycleEventType
  | VerificationLifecycleEventType
  | "plan.updated";

type EvidenceRefBase = {
  id?: string;
  category?: string;
  reason?: string;
  note?: string;
  linkedDecisionId?: string;
  linkedAgentId?: string;
};

export type AgentWorkJournalKind =
  | "planning"
  | "inspected_file"
  | "edited_file"
  | "proposed_patch"
  | "command_requested"
  | "command_completed"
  | "test_run"
  | "decision"
  | "evidence_added"
  | "risk_identified"
  | "blocked"
  | "completed";

export type AgentWorkJournalStatus =
  | "queued"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

export type DiffAttributionConfidence =
  | "exact"
  | "reported"
  | "owned"
  | "inferred"
  | "shared"
  | "unattributed"
  | "unknown";

export type AgentWorkJournalEntry = {
  id: string;
  agentId: string;
  timestamp: string;
  kind: AgentWorkJournalKind;
  title: string;
  summary: string;
  filePath?: string;
  command?: string;
  linkedDecisionId?: string;
  linkedEvidenceRefId?: string;
  severity?: "low" | "medium" | "high";
  status?: AgentWorkJournalStatus;
};

export type EvidenceRef =
  | (EvidenceRefBase & {
      type: "file";
      path: string;
      lineHint?: string;
      lineStart?: number;
      lineEnd?: number;
      symbol?: string;
      componentName?: string;
    })
  | (EvidenceRefBase & {
      type: "command";
      commandId: string;
    })
  | (EvidenceRefBase & {
      type: "artifact";
      artifactId: string;
    })
  | (EvidenceRefBase & {
      type: "test";
      testName: string;
    });

export type AgentRiskRef = {
  id: string;
  agentId?: string;
  filePath?: string;
  lifecycleArea?: string;
  severity: "low" | "medium" | "high";
  reason: string;
  mitigation?: string;
  status?: "open" | "mitigated" | "accepted";
  linkedDecisionId?: string;
  linkedEvidenceRefs?: EvidenceRef[];
};

export type DiffFileStat = {
  path: string;
  changeType: "create" | "modify" | "delete";
  additions?: number;
  deletions?: number;
};

export type FileDiffAttribution = DiffFileStat & {
  confidence: DiffAttributionConfidence;
  agentIds?: string[];
  agentNames?: string[];
  reason?: string;
};

export type GlobalDiffSummary = {
  source: "patch_unified_diff" | "run_summary" | "unknown";
  changedFiles: number;
  additions?: number;
  deletions?: number;
  files: DiffFileStat[];
};

export type ReconciliationStatus = "not_run" | "pending" | "matched" | "diverged" | "unavailable" | "failed";
export type ReconciliationConfidence = "exact" | "high" | "partial" | "unknown";
export type WorkspaceSnapshotSource = "rust_git_snapshot" | "desktop_git_snapshot_bridge" | "unknown";
export type ReconciliationEvidenceSource = WorkspaceSnapshotSource | "unavailable";

export type WorkspaceDiffSnapshot = {
  available: boolean;
  source?: WorkspaceSnapshotSource;
  isGitRepo?: boolean;
  changedFiles?: string[];
  diffText?: string;
  fileStats?: DiffFileStat[];
  statusEntries?: string[];
  dirty?: boolean;
  checkedAt?: string;
  unavailableReason?: string;
};

export type ReconciliationReport = {
  status: ReconciliationStatus;
  patchId?: string;
  sourceDiffId?: string;
  checkedAt?: string;
  checkedBy: "runtime" | "rust" | "git" | "system";
  evidenceSource?: ReconciliationEvidenceSource;
  confidence: ReconciliationConfidence;
  reason: string;
  retryable: boolean;
  proposed?: GlobalDiffSummary;
  actual?: GlobalDiffSummary;
  matchedFiles: string[];
  missingFiles: string[];
  extraFiles: string[];
  changedFilesWithDifferentStats: Array<{
    path: string;
    proposedAdditions?: number;
    proposedDeletions?: number;
    actualAdditions?: number;
    actualDeletions?: number;
  }>;
  sharedOrAmbiguousFiles: FileDiffAttribution[];
  dirtyBeforeApply?: boolean;
  dirtyAfterApply?: boolean;
  unknowns: string[];
};

export type DecisionRecord = {
  id: string;
  sessionId: string;
  category: "finding" | "decision" | "risk" | "verification_note";
  finding: string;
  decision: string;
  rationaleSummary: string;
  evidenceRefs: EvidenceRef[];
  linkedFiles: string[];
  uncertainty?: string;
  createdByAgent: string;
  createdByAgentId?: string;
  linkedAgentIds?: string[];
  createdAt: string;
};

export type RunPhase = {
  id: RunPhaseId;
  status: RunPhaseStatus;
  summary: string;
  evidenceCount?: number;
  startedAt?: string;
  completedAt?: string;
};

export type ReviewRecommendation = "ready" | "caution" | "do_not_apply";

export type ReviewGateSummary = {
  totalFilesChanged: number;
  totalAdditions?: number;
  totalDeletions?: number;
  globalDiff?: GlobalDiffSummary;
  actualDiff?: GlobalDiffSummary;
  reconciliation?: ReconciliationReport;
  scopeValidation?: ModuleScopeValidation;
  changesByAgent: Array<{
    agentId?: string;
    agentName: string;
    confidence?: DiffAttributionConfidence;
    fileCount: number;
    additions?: number;
    deletions?: number;
    files: string[];
    lineTotalsKnown?: boolean;
  }>;
  riskyAreas: string[];
  verificationChecks: Array<{
    id?: string;
    label?: string;
    command?: string;
    name: string;
    status: VerificationCheckStatus;
    detail: string;
    agentId?: string;
    agentName?: string;
    scope?: "agent" | "global";
  }>;
  risksByAgent?: Array<{
    agentId?: string;
    agentName: string;
    count: number;
    risks: AgentRiskRef[];
  }>;
  decisionsByAgent?: Array<{
    agentId?: string;
    agentName: string;
    count: number;
    decisionIds: string[];
  }>;
  sharedFiles?: FileDiffAttribution[];
  unattributedFiles?: FileDiffAttribution[];
  unknownFiles?: FileDiffAttribution[];
  remainingUnknowns?: string[];
  runToGreen?: {
    status: RunToGreenStatus;
    currentAttempt: number;
    maxAttempts: number;
    lastCommand?: string;
    lastDiagnosis?: RunToGreenDiagnosis;
    blockerReason?: string;
    finalStatus: RunToGreenFinalStatus;
  };
  unresolvedBlockers: string[];
  recommendation: ReviewRecommendation;
  summary: string;
};

export type PatchFileChange = {
  path: string;
  changeType: "create" | "modify" | "delete";
  explanation: string;
};

export type PatchArtifact = {
  path: string;
  content: string;
};

export type PatchProposal = {
  id: string;
  sessionId: string;
  title: string;
  summary: string;
  riskLevel: PatchRiskLevel;
  filesChanged: PatchFileChange[];
  artifacts?: PatchArtifact[];
  unifiedDiff: string;
  requiresApproval: boolean;
  status: PatchProposalStatus;
  approvalId?: string;
  lastStatusAt?: string;
  appliedAt?: string;
  createdAt: string;
};

export type WorkspaceInfo = {
  path: string;
  name: string;
  isGitRepo: boolean;
  currentBranch?: string;
  importantFiles: string[];
  languages: Record<string, number>;
  packageManagers: string[];
  testCommands: string[];
};

export type ProjectIntakeStatus = "not_started" | "running" | "completed" | "failed" | "partial";

export type ProjectKind = "empty_project" | "existing_project" | "mid_progress_project" | "unknown";

export type ProjectIntakeConfidence = "high" | "medium" | "low" | "unknown";

export type ProjectSignalType =
  | "git_repository"
  | "package_config"
  | "source_directories"
  | "tests"
  | "docs"
  | "previous_orchcode_state"
  | "existing_todos"
  | "existing_build_scripts"
  | "current_git_changes";

export type ProjectSignal = {
  type: ProjectSignalType;
  detail?: string;
  paths?: string[];
};

export type ProjectProgressReconstruction = {
  inferred: true;
  summary: string;
  implementedAreas: string[];
  partialAreas: string[];
  missingAreas: string[];
  brokenAreas: string[];
  previousPlanEvidence: string[];
  nextSafeAction: string;
  warnings: string[];
};

export type ProjectEditGuardrails = {
  summary: string;
  rules: string[];
};

export type ProjectContextPack = {
  projectSummary: string;
  currentTaskObjective?: string;
  relevantFiles: string[];
  relatedTests: string[];
  conventionsDiscovered: string[];
  apisLikelyToPreserve: string[];
  safeToEdit: string[];
  cautionPaths: string[];
  doNotTouchCandidates: string[];
  acceptanceCriteriaDraft: string[];
  verificationCommands: string[];
  knownRisks: string[];
  unknowns: string[];
  guardrails: ProjectEditGuardrails;
};

export type ProjectExplainEvidenceRef = {
  type: "file" | "directory" | "manifest" | "test" | "entrypoint" | "search";
  path: string;
  reason: string;
  excerpt?: string;
  lineStart?: number;
  lineEnd?: number;
  symbol?: string;
  language?: string;
  snippet?: string;
};

export type ProjectExplainSection = {
  title: string;
  explanation: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  symbol?: string;
  language?: string;
  snippet: string;
  whyItMatters: string;
};

export type ProjectExplainModule = {
  id: string;
  name: string;
  root: string;
  responsibility: string;
  importantFiles: string[];
  entryPoints: string[];
  tests: string[];
  dependencies: string[];
  risksAndUnknowns: string[];
  evidence: ProjectExplainEvidenceRef[];
};

export type ProjectExplainContextPack = {
  inventory: {
    totalFiles: number;
    totalDirectories: number;
    scannedFiles: number;
    omittedFiles: number;
    ignoredDirectories: string[];
    languages: Record<string, number>;
    rootFolders: Array<{ path: string; files: number }>;
  };
  readBudget: {
    maxExplainFiles: number;
    maxModuleSamples: number;
    maxFileReadChars: number;
    sampledFiles: number;
  };
  sampledFiles: Array<{
    path: string;
    reason: string;
    charsRead: number;
    summary: string;
  }>;
};

export type ProjectExplainReport = {
  overview: string;
  architecture: string;
  sections: ProjectExplainSection[];
  findings: ProjectExplainSection[];
  moduleMap: ProjectExplainModule[];
  entryPoints: string[];
  dataFlow: string;
  importantFiles: string[];
  howToRun: string[];
  risksAndUnknowns: string[];
  suggestedNextQuestions: string[];
  evidence: ProjectExplainEvidenceRef[];
  contextPack: ProjectExplainContextPack;
};

export type ProjectRunIntent = "run_once" | "run_to_green" | "inspect_only" | "implement_module" | "unknown";

export type RunToGreenStatus =
  | "not_started"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "max_attempts_reached"
  | "cancelled";

export type RunToGreenIntent = "run_to_green";

export type RunToGreenFinalStatus = "green" | "not_green" | "blocked" | "unknown";

export type RunToGreenCommandSource =
  | "explicit_user_command"
  | "module_verification_command"
  | "project_intake_command"
  | "context_pack_command"
  | "package_script_detection"
  | "launch_inference";

export type RunToGreenSelectedCommand = {
  command: string;
  cwd: string;
  source: RunToGreenCommandSource;
  reason: string;
};

export type RunToGreenDiagnosisCategory =
  | "not_git_repository"
  | "dependency_missing"
  | "script_missing"
  | "type_error"
  | "lint_error"
  | "test_failure"
  | "import_error"
  | "config_error"
  | "runtime_exception"
  | "build_error"
  | "port_in_use"
  | "environment_error"
  | "permission_error"
  | "command_not_found"
  | "unknown";

export type RunToGreenDiagnosisConfidence = "high" | "medium" | "low" | "unknown";

export type RunToGreenDiagnosis = {
  category: RunToGreenDiagnosisCategory;
  confidence: RunToGreenDiagnosisConfidence;
  evidence: {
    command: string;
    exitCode?: number;
    stdoutSummary?: string;
    stderrSummary?: string;
    filePath?: string;
  };
  safeFixAvailable: boolean;
  requiresApproval: boolean;
  reason: string;
};

export type RunToGreenAttemptStatus = "running" | "passed" | "failed" | "skipped";

export type RunToGreenAttempt = {
  attemptNumber: number;
  command: string;
  cwd: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  status: RunToGreenAttemptStatus;
  stdoutSummary?: string;
  stderrSummary?: string;
  diagnosis?: RunToGreenDiagnosis;
  proposedFixSummary?: string;
  changedFiles: string[];
  scopeVerdict?: ScopeValidationVerdict;
  rerunReason?: string;
  stopReason?: string;
};

export type RunToGreenState = {
  id: string;
  sessionId: string;
  status: RunToGreenStatus;
  intent: RunToGreenIntent;
  objective: string;
  selectedCommands: RunToGreenSelectedCommand[];
  currentAttempt: number;
  maxAttempts: number;
  attempts: RunToGreenAttempt[];
  finalStatus: RunToGreenFinalStatus;
  blockerReason?: string;
  pendingRepairPatchId?: string;
  pendingRerunCommand?: string;
  pendingRerunReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type ModulePlanSource =
  | "user_requested"
  | "inferred_from_intake"
  | "inferred_from_progress"
  | "resumed_from_project_state"
  | "unknown";

export type ModuleExecutionPlanStatus =
  | "draft"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ModuleExecutionPlan = {
  id: string;
  sessionId: string;
  projectId?: string;
  workspaceRoot: string;
  source: ModulePlanSource;
  status: ModuleExecutionPlanStatus;
  title: string;
  objective: string;
  rationale: string;
  linkedIntakeId?: string;
  linkedContextPackId?: string;
  targetModuleName?: string;
  relevantFiles: string[];
  ownedPaths: string[];
  allowedPaths: string[];
  cautionPaths: string[];
  forbiddenPaths: string[];
  expectedNewFiles: string[];
  disallowedNewFiles: string[];
  requiredExistingPatterns: string[];
  publicContractsToPreserve: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  risks: string[];
  unknowns: string[];
  stopConditions: string[];
  approvalRequiredReasons: string[];
  createdAt: string;
  updatedAt: string;
};

export type ScopeValidationVerdict = "in_scope" | "needs_review" | "blocked";

export type ModuleScopeValidation = {
  allowedChanges: string[];
  cautionChanges: string[];
  forbiddenChanges: string[];
  unexpectedNewFiles: string[];
  deletionOrRenameConcerns: string[];
  dependencyConcerns: string[];
  publicContractConcerns: string[];
  verdict: ScopeValidationVerdict;
  reasons: string[];
};

export type ModuleExecutionSummaryStatus = "complete" | "partial" | "blocked" | "failed" | "needs_follow_up";

export type ModuleExecutionSummary = {
  id: string;
  sessionId: string;
  modulePlanId: string;
  title: string;
  status: ModuleExecutionSummaryStatus;
  completedAcceptanceCriteria: string[];
  failedAcceptanceCriteria: string[];
  changedFiles: string[];
  verificationResults: Array<{
    name: string;
    status: VerificationCheckStatus;
    detail: string;
  }>;
  remainingRisks: string[];
  nextRecommendedAction?: string;
  scopeVerdict?: ScopeValidationVerdict;
  runToGreenStatus?: RunToGreenStatus;
  runToGreenAttempts?: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectIntake = {
  projectId?: string;
  workspaceRoot: string;
  detectedProjectName?: string;
  intakeStatus: ProjectIntakeStatus;
  projectKind: ProjectKind;
  confidence: ProjectIntakeConfidence;
  detectedSignals: ProjectSignal[];
  architectureSummary?: string;
  moduleSummary: string[];
  knownEntryPoints: string[];
  knownCommands: string[];
  testCommands: string[];
  buildCommands: string[];
  importantFiles: string[];
  riskyFiles: string[];
  doNotTouchCandidates: string[];
  currentStateSummary?: string;
  nextActionRecommendation?: string;
  unknowns: string[];
  warnings: string[];
  progressReconstruction?: ProjectProgressReconstruction;
  contextPack?: ProjectContextPack;
  runIntent?: ProjectRunIntent;
  guardrails: ProjectEditGuardrails;
};

export type FileEntry = {
  path: string;
  name: string;
  isDir: boolean;
  isSecretCandidate: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  branch?: string;
  statusText: string;
  changedFiles: string[];
};

export type CommandRisk = "safe" | "medium" | "dangerous";

export type CommandRequestedBy = "agent" | "user" | "system" | "unknown";
export type CommandApprovalSource = "manual" | "policy" | "auto" | "denied" | "none" | "unknown";
export type CommandPolicyDecision = "allow" | "require_approval" | "deny" | "unavailable";
export type CommandDetectionSource = "heuristic" | "policy" | "user" | "system" | "unknown";
export type BackgroundJobStatus = "running" | "completed" | "failed" | "terminated" | "orphaned" | "unknown";

export type BackgroundJobRecord = {
  jobId: string;
  requestId?: string;
  sessionId: string;
  command: string;
  cwd: string;
  processId?: number;
  startedAt: string;
  completedAt?: string;
  status: BackgroundJobStatus;
  lastKnownAt: string;
  exitCode?: number;
  outputSummary?: string;
  detectionSource: CommandDetectionSource;
};

export type CommandResult = {
  command: string;
  cwd: string;
  risk: CommandRisk;
  status: CommandExecutionStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  message?: string;
  diagnosis?: CommandFailureDiagnosis;
  provenance?: CommandExecutionProvenance;
  backgroundJob?: BackgroundJobRecord;
};

export type CommandFailureDiagnosisCategory =
  | "not_git_repository"
  | "command_not_found"
  | "outside_workspace"
  | "approval_required"
  | "policy_blocked"
  | "network_blocked"
  | "background_command"
  | "unknown";

export type CommandFailureDiagnosisSeverity = "informative" | "warning" | "error";

export type CommandFailureDiagnosis = {
  category: CommandFailureDiagnosisCategory;
  severity: CommandFailureDiagnosisSeverity;
  summary: string;
  nextStep?: string;
};

export type CommandExecutionProvenance = {
  source: "agent" | "user" | "session_restore" | "replay";
  trigger: "manual" | "auto_approved" | "restored" | "replayed";
  approvalId?: string;
  toolCallId?: string;
  replayOfExecutionId?: string;
  restoredFromSessionId?: string;
  reason?: string;
  sessionId?: string;
  requestId?: string;
  agentId?: string;
  requestedBy?: CommandRequestedBy;
  approvalSource?: CommandApprovalSource;
  policyDecision?: CommandPolicyDecision;
  policyReason?: string;
  executionAuthority?: "runtime" | "rust" | "system" | "unknown";
  background?: boolean;
  processId?: number;
  networkDetected?: boolean;
  backgroundDetected?: boolean;
  detectionSource?: CommandDetectionSource;
  networkDetectionSource?: CommandDetectionSource;
  backgroundDetectionSource?: CommandDetectionSource;
  outputSummary?: string;
  backgroundTrackingLimited?: boolean;
  jobId?: string;
};

export type CommandRequest = {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
  status: CommandRequestStatus;
  provenance?: CommandExecutionProvenance;
  backgroundJob?: BackgroundJobRecord;
  createdAt: string;
};

export type CommandExecutionRecord = CommandResult & {
  id: string;
  sessionId: string;
  requestId?: string;
  autoRun: boolean;
  provenance?: CommandExecutionProvenance;
  backgroundJob?: BackgroundJobRecord;
  createdAt: string;
};

export type PreviewRecommendation = {
  type: "url" | "file";
  target: string;
  description: string;
  command?: string;
};

export type ToolIntentType =
  | "workspace.snapshot.requested"
  | "workspace.search.requested"
  | "project.intake.requested"
  | "module.plan.requested"
  | "file.read.requested"
  | "patch.proposed"
  | "scope.validation.requested"
  | "command.requested"
  | "validation.requested";

export type ToolIntent = {
  id: string;
  sessionId: string;
  type: ToolIntentType;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  status: "proposed" | "approved" | "rejected" | "executed" | "blocked";
  createdAt: string;
};

export type ArtifactType =
  | "plan"
  | "diff"
  | "command_result"
  | "file_tree"
  | "project_intake"
  | "project_explain_report"
  | "context_pack"
  | "module_plan"
  | "module_execution_summary"
  | "run_to_green"
  | "preview"
  | "readme"
  | "verification"
  | "summary";

export type Artifact = {
  id: string;
  sessionId: string;
  type: ArtifactType;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type VerificationResult = {
  id: string;
  sessionId: string;
  status: VerificationCheckStatus;
  checks: Array<{
    id?: string;
    label?: string;
    command?: string;
    name: string;
    status: VerificationCheckStatus;
    detail: string;
    startedAt?: string;
    completedAt?: string;
    exitCode?: number;
    summary?: string;
    linkedAgentId?: string;
    linkedPatchId?: string;
  }>;
  summary: string;
  createdAt: string;
  updatedAt?: string;
};

export type ModelProviderType = "ollama" | "openai_compatible";

export type ModelProviderConfig = {
  id: string;
  providerType: ModelProviderType;
  providerName: string;
  baseUrl: string;
  selectedModel: string;
  apiKeyConfigured: boolean;
  isValid: boolean;
  lastValidatedAt?: string;
  lastValidationError?: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  providerId: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  isLocal: boolean;
};
