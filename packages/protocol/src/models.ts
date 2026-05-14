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
  | "verification.passed"
  | "verification.failed";

export type RuntimeLifecycleEventType =
  | SessionLifecycleEventType
  | PatchLifecycleEventType
  | CommandLifecycleEventType
  | VerificationLifecycleEventType
  | "plan.updated";

export type EvidenceRef =
  | {
      type: "file";
      path: string;
      lineHint?: string;
      symbol?: string;
      note?: string;
    }
  | {
      type: "command";
      commandId: string;
      note?: string;
    }
  | {
      type: "artifact";
      artifactId: string;
      note?: string;
    }
  | {
      type: "test";
      testName: string;
      note?: string;
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
  changesByAgent: Array<{
    agentName: string;
    fileCount: number;
    additions?: number;
    deletions?: number;
    files: string[];
  }>;
  riskyAreas: string[];
  verificationChecks: Array<{
    name: string;
    status: VerificationStatus;
    detail: string;
  }>;
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
  status: VerificationStatus;
  checks: Array<{
    name: string;
    status: VerificationStatus;
    detail: string;
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
