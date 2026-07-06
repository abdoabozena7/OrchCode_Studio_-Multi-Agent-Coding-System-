import type { TaskGraph, TaskNodeStatus } from "@hivo/protocol";
import type { Campaign, CampaignMilestone } from "./OrchestrationModels.js";
import {
  type CanonicalOrchestrationState,
  type CanonicalTaskExecutionResult
} from "./CanonicalOrchestrationGraph.js";
import { runCanonicalExecutionAdapter } from "./CanonicalExecutionAdapter.js";
import { createCanonicalTaskGraph } from "./CanonicalTaskGraphBuilder.js";

export type CanonicalCampaignMilestoneStatus = "succeeded" | "failed" | "blocked";

export type CanonicalCampaignMilestoneExecution<T = unknown> = {
  status: CanonicalCampaignMilestoneStatus;
  runId?: string;
  result?: T;
};

export type CanonicalCampaignExecutionInput<T = unknown> = {
  campaign: Campaign;
  milestone: CampaignMilestone;
  executeMilestone: (input: {
    campaign: Campaign;
    milestone: CampaignMilestone;
    taskGraph: TaskGraph;
  }) => Promise<CanonicalCampaignMilestoneExecution<T>>;
};

export type CanonicalCampaignExecutionResult<T = unknown> = {
  taskGraph: TaskGraph;
  graph: CanonicalOrchestrationState;
  milestoneExecution?: CanonicalCampaignMilestoneExecution<T>;
  taskExecution: CanonicalTaskExecutionResult;
  blockingReasons: string[];
};

export async function runCampaignMilestoneThroughCanonicalGraph<T = unknown>(
  input: CanonicalCampaignExecutionInput<T>
): Promise<CanonicalCampaignExecutionResult<T>> {
  const taskGraph = campaignMilestonesToTaskGraph(input.campaign);
  const result = await runCanonicalExecutionAdapter<CanonicalCampaignMilestoneExecution<T> | undefined>({
    sessionId: input.campaign.id,
    taskGraph,
    execute: (validatedGraph) => input.executeMilestone({
      campaign: input.campaign,
      milestone: input.milestone,
      taskGraph: validatedGraph
    }),
    taskExecutionFromOutput: campaignMilestoneExecutionToTaskExecution,
    outputWhenExecutionSkipped: () => undefined,
    missingOutputError: "Canonical campaign adapter finished without milestone execution output.",
    review: {
      missingExecutionMessage: "Campaign milestone executor did not return a result.",
      failedExecutionMessage: (failedCount) => `${failedCount} campaign milestone(s) failed or blocked.`
    }
  });

  return {
    taskGraph: result.taskGraph,
    graph: result.graph,
    milestoneExecution: result.output,
    taskExecution: result.taskExecution,
    blockingReasons: result.blockingReasons
  };
}

export function campaignMilestonesToTaskGraph(campaign: Campaign): TaskGraph {
  return createCanonicalTaskGraph({
    sessionId: campaign.id,
    nodes: campaign.milestones.map((milestone, index) => ({
      id: milestone.id,
      title: milestone.title,
      description: milestone.objective,
      assignedAgent: "CampaignManager",
      status: mapCampaignMilestoneStatus(milestone.status),
      dependsOn: index > 0 ? [campaign.milestones[index - 1]!.id] : [],
      fileLocks: [],
      expectedOutput: "Campaign milestone result",
      riskLevel: "medium"
    }))
  });
}

function campaignMilestoneExecutionToTaskExecution(
  execution: CanonicalCampaignMilestoneExecution | undefined
): CanonicalTaskExecutionResult {
  return {
    completed: execution?.status === "succeeded" ? 1 : 0,
    failed: execution?.status === "succeeded" ? 0 : 1,
    bankruptcyErrors: []
  };
}

function mapCampaignMilestoneStatus(status: CampaignMilestone["status"]): TaskNodeStatus {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "skipped") return "cancelled";
  if (status === "running") return "running";
  return "pending";
}
