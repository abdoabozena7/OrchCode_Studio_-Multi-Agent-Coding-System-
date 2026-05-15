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

export type RunMode = "quick_fix" | "normal_run" | "deep_audit" | "soak_mode" | "paranoid_mode";

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
  | "rejected"
  | "executing"
  | "executed"
  | "blocked"
  | "failed";

export type CommandExecutionStatus =
  | "executing"
  | "executed"
  | "approval_required"
  | "blocked"
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

export type WorkspaceDiffSnapshot = {
  available: boolean;
  isGitRepo?: boolean;
  changedFiles?: string[];
  diffText?: string;
  dirty?: boolean;
  checkedAt?: string;
};

export type ReconciliationReport = {
  status: ReconciliationStatus;
  patchId?: string;
  sourceDiffId?: string;
  checkedAt?: string;
  checkedBy: "runtime" | "rust" | "git" | "system";
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

export type CommandResult = {
  command: string;
  cwd: string;
  risk: CommandRisk;
  status: CommandExecutionStatus;
  exitCode?: number;
  stdout: string;
  stderr: string;
  message?: string;
  provenance?: CommandExecutionProvenance;
};

export type CommandExecutionProvenance = {
  source: "agent" | "user" | "session_restore" | "replay";
  trigger: "manual" | "auto_approved" | "restored" | "replayed";
  requestedBy?: string;
  approvalId?: string;
  toolCallId?: string;
  replayOfExecutionId?: string;
  restoredFromSessionId?: string;
  reason?: string;
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
  createdAt: string;
};

export type CommandExecutionRecord = CommandResult & {
  id: string;
  sessionId: string;
  requestId?: string;
  autoRun: boolean;
  provenance?: CommandExecutionProvenance;
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
  | "file.read.requested"
  | "patch.proposed"
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
