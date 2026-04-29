export type TaskRiskLevel = "low" | "medium" | "high";

export type TaskNodeStatus =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskNode = {
  id: string;
  title: string;
  description: string;
  assignedAgent: string;
  status: TaskNodeStatus;
  dependsOn: string[];
  fileLocks: string[];
  expectedOutput: string;
  riskLevel: TaskRiskLevel;
};

export type TaskGraphEdge = {
  from: string;
  to: string;
};

export type TaskGraph = {
  sessionId: string;
  nodes: TaskNode[];
  edges: TaskGraphEdge[];
};
