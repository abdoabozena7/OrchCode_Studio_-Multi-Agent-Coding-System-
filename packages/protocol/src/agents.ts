import type { WorkerSelfCheck } from "./orchestration.js";
import type { AgentLifecycleStage } from "./agent-runtime.js";

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
  | "Senior Coding Agent"
  | (string & {});

export type AgentRunStatus = "idle" | "running" | "completed" | "blocked" | "failed";

export type AgentRun = {
  id: string;
  sessionId: string;
  agentName: string;
  role: AgentRole;
  roleTitle?: string;
  lifecycleStage?: AgentLifecycleStage;
  artifactJson?: unknown;
  objective?: string;
  ownedPaths?: string[];
  forbiddenPaths?: string[];
  currentAction?: string;
  recentActions?: string[];
  changedFiles?: string[];
  commandsRun?: string[];
  riskLevel?: "low" | "medium" | "high";
  blockers?: string[];
  diffStats?: {
    additions?: number;
    deletions?: number;
    fileCount: number;
  };
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
  selfCheck?: WorkerSelfCheck;
  status: "completed" | "blocked" | "failed";
  createdAt: string;
};
