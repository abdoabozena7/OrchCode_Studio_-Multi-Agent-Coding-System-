export type AgentRole =
  | "Product Orchestrator"
  | "Business Orchestrator"
  | "Engineering Orchestrator"
  | "Codebase Mapper"
  | "Architect"
  | "Rust Backend"
  | "Frontend"
  | "Tooling Terminal"
  | "Test"
  | "Security"
  | "Reviewer"
  | "Senior Coding Agent";

export type AgentRunStatus = "idle" | "running" | "completed" | "blocked" | "failed";

export type AgentRun = {
  id: string;
  sessionId: string;
  agentName: string;
  role: AgentRole;
  currentTask?: string;
  status: AgentRunStatus;
  lastEvent?: string;
  tokenCount?: number;
  costUsd?: number;
  startedAt: string;
  completedAt?: string;
};

export type WorkerOutput = {
  id: string;
  sessionId: string;
  taskId: string;
  agentName: string;
  summary: string;
  details: string[];
  patchProposalIds: string[];
  commandRequestIds: string[];
  risks: string[];
  status: "completed" | "blocked" | "failed";
  createdAt: string;
};
