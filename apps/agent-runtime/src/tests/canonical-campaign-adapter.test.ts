import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignMilestonesToTaskGraph,
  runCampaignMilestoneThroughCanonicalGraph
} from "../orchestration/CanonicalCampaignAdapter.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type Campaign,
  type CampaignMilestone
} from "../orchestration/OrchestrationModels.js";

test("canonical campaign adapter maps milestones into a sequential task graph", () => {
  const campaign = fakeCampaign([
    milestone("milestone-a", "pending"),
    milestone("milestone-b", "pending"),
    milestone("milestone-c", "blocked")
  ]);

  const graph = campaignMilestonesToTaskGraph(campaign);

  assert.equal(graph.sessionId, campaign.id);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["milestone-a", "milestone-b", "milestone-c"]);
  assert.deepEqual(graph.nodes.find((node) => node.id === "milestone-b")?.dependsOn, ["milestone-a"]);
  assert.deepEqual(graph.nodes.find((node) => node.id === "milestone-c")?.status, "blocked");
  assert.deepEqual(graph.edges, [
    { from: "milestone-a", to: "milestone-b" },
    { from: "milestone-b", to: "milestone-c" }
  ]);
});

test("canonical campaign adapter executes one milestone through the shared lifecycle graph", async () => {
  const campaign = fakeCampaign([milestone("milestone-a", "running")]);
  let executed = false;

  const result = await runCampaignMilestoneThroughCanonicalGraph({
    campaign,
    milestone: campaign.milestones[0]!,
    executeMilestone: async ({ milestone, taskGraph }) => {
      executed = true;
      assert.equal(milestone.id, "milestone-a");
      assert.equal(taskGraph.nodes[0]?.id, "milestone-a");
      return { status: "succeeded", runId: "run_campaign_1" };
    }
  });

  assert.equal(executed, true);
  assert.equal(result.graph.status, "awaiting_approval");
  assert.equal(result.graph.finalStatus, "needs_approval");
  assert.equal(result.milestoneExecution?.runId, "run_campaign_1");
  assert.equal(result.taskExecution.completed, 1);
  assert.equal(result.taskExecution.failed, 0);
  assert.deepEqual(result.blockingReasons, []);
});

test("canonical campaign adapter reports failed milestones as graph review blockers", async () => {
  const campaign = fakeCampaign([milestone("milestone-a", "running")]);

  const result = await runCampaignMilestoneThroughCanonicalGraph({
    campaign,
    milestone: campaign.milestones[0]!,
    executeMilestone: async () => ({ status: "failed", runId: "run_campaign_failed" })
  });

  assert.equal(result.graph.status, "blocked");
  assert.equal(result.graph.finalStatus, "failed");
  assert.equal(result.taskExecution.completed, 0);
  assert.equal(result.taskExecution.failed, 1);
  assert.match(result.blockingReasons.join("\n"), /campaign milestone/);
});

test("canonical campaign adapter blocks malformed campaign graphs before milestone execution", async () => {
  const campaign = fakeCampaign([milestone("milestone-a", "running")]);
  campaign.milestones.push({ ...milestone("milestone-a", "pending"), title: "Duplicate milestone" });
  let executed = false;

  const result = await runCampaignMilestoneThroughCanonicalGraph({
    campaign,
    milestone: campaign.milestones[0]!,
    executeMilestone: async () => {
      executed = true;
      return { status: "succeeded" };
    }
  });

  assert.equal(executed, false);
  assert.equal(result.graph.status, "blocked");
  assert.equal(result.graph.finalStatus, "failed");
  assert.equal(result.milestoneExecution, undefined);
  assert.equal(result.taskExecution.completed, 0);
  assert.match(result.blockingReasons.join("\n"), /Duplicate task id/);
});

function fakeCampaign(milestones: CampaignMilestone[]): Campaign {
  const now = new Date().toISOString();
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "campaign_canonical_test",
    title: "Canonical campaign test",
    original_goal: "Test campaign adapter",
    status: "running",
    created_at: now,
    updated_at: now,
    runs: [],
    milestones,
    risks: [],
    decisions: [],
    memory_refs: []
  };
}

function milestone(id: string, status: CampaignMilestone["status"]): CampaignMilestone {
  const now = new Date().toISOString();
  return {
    id,
    title: `Milestone ${id}`,
    objective: `Complete ${id}`,
    status,
    created_at: now,
    updated_at: now
  };
}
