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
  status: "proposed" | "approved" | "rejected" | "applied";
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
  status: "executed" | "approval_required" | "blocked" | "failed";
  exitCode?: number;
  stdout: string;
  stderr: string;
  message?: string;
};

export type CommandRequest = {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  risk: CommandRisk;
  reason: string;
  status: "requested" | "approved" | "rejected" | "executed" | "blocked";
  createdAt: string;
};

export type CommandExecutionRecord = CommandResult & {
  id: string;
  sessionId: string;
  requestId?: string;
  autoRun: boolean;
  createdAt: string;
};

export type PreviewRecommendation = {
  type: "url" | "file";
  target: string;
  description: string;
  command?: string;
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
