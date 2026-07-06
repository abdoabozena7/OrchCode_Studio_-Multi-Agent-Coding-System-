import type {
  AgentAssignmentPlan,
  AgentRun,
  AgentRuntimeSession,
  ArtifactHandoff,
  IntentContract,
  PreviewRecommendation,
  ProjectMap,
  WorkOrder,
  WorkerOutput
} from "@hivo/protocol";
import type { TaskExecutionHandler } from "../orchestration/QueueDrivenTaskScheduler.js";
import { randomId } from "./SessionManager.js";

export type OrchestratedWorkerExecutionInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  intentContract: IntentContract;
  orchestrationMessage: string;
  projectMap: ProjectMap;
  assignmentPlan: AgentAssignmentPlan;
  workOrders: WorkOrder[];
};

export type OrchestratedWorkerExecutionSnapshot = {
  outputs: WorkerOutput[];
  artifacts: ArtifactHandoff[];
  previewRecommendation?: PreviewRecommendation;
};

export type OrchestratedQueueWorkerExecution = {
  createHandler(input: OrchestratedWorkerExecutionInput): TaskExecutionHandler;
  snapshot(): OrchestratedWorkerExecutionSnapshot;
};

export function createAgentRun(
  sessionId: string,
  agentName: string,
  currentTask: string,
  status: AgentRun["status"],
  role: AgentRun["role"] = agentNameToRole(agentName)
): AgentRun {
  const id = randomId("agent");
  const startedAt = new Date().toISOString();
  return {
    id,
    sessionId,
    agentName,
    role,
    currentTask,
    status,
    lastEvent: status,
    workJournal: [{
      id: randomId("journal"),
      agentId: id,
      timestamp: startedAt,
      kind: "planning",
      title: currentTask,
      summary: "Worker run created and waiting to execute.",
      status: status === "completed" ? "completed" : "running"
    }],
    startedAt,
    completedAt: status === "completed" ? new Date().toISOString() : undefined
  };
}

function agentNameToRole(agentName: string): AgentRun["role"] {
  const role = agentName.replace("Agent", "").replace(/([a-z])([A-Z])/g, "$1 $2");
  if (role === "Codebase Mapper") return "Codebase Mapper";
  if (role === "Rust Backend") return "Rust Backend";
  if (role === "Tooling Terminal") return "Tooling Terminal";
  if (role === "Security") return "Security";
  if (role === "Reviewer") return "Reviewer";
  if (role === "Frontend") return "Frontend";
  if (role === "Architect") return "Architect";
  if (role === "Test") return "Test";
  return "Reviewer";
}
