import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendDecision, ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { CoreOrchestrator } from "./Orchestrator.js";
import { ORCHESTRATION_SCHEMA_VERSION, type Campaign, type CampaignMetrics, type CampaignMilestone } from "./OrchestrationModels.js";
import type { ExecutionMode } from "./OrchestrationConfig.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";

export class CampaignManager {
  private readonly metadata: FactoryMetadataAdapter;

  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {
    this.metadata = new FactoryMetadataAdapter(workspacePath, memoryDir);
  }

  async create(goal: string) {
    const now = new Date().toISOString();
    const campaign: Campaign = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `campaign_${randomUUID()}`,
      title: titleFromGoal(goal),
      original_goal: goal,
      status: "created",
      created_at: now,
      updated_at: now,
      runs: [],
      milestones: [],
      risks: [],
      decisions: [],
      memory_refs: ["repo_index.json", "project_intelligence.json", "decisions.jsonl"],
      final_report_ref: undefined
    };
    await this.save(campaign);
    await this.appendEvent(campaign.id, "campaign.created", { goal });
    return campaign;
  }

  async plan(campaignId: string) {
    const campaign = await this.load(campaignId);
    const freshness = await assessIndexFreshness(this.workspacePath, this.memoryDir);
    const now = new Date().toISOString();
    campaign.status = "planning";
    campaign.updated_at = now;
    if (!campaign.milestones.length) {
      campaign.milestones = [
        createMilestone("Analyze repository and campaign risk", `Inspect repository memory, risk map, command inventory, and prior lessons for: ${campaign.original_goal}`, now),
        createMilestone("Execute first safe implementation slice", `Run the smallest safe, reviewable coding slice for: ${campaign.original_goal}`, now),
        createMilestone("Validate and summarize campaign progress", `Validate completed work and produce campaign handoff report for: ${campaign.original_goal}`, now)
      ];
    }
    campaign.risks = [
      ...campaign.risks,
      freshness.status !== "fresh" ? "Repository index is stale and should be refreshed before deep campaign execution." : "",
      "Campaigns resume only when an operator invokes the next command; no background worker is implied."
    ].filter(Boolean);
    campaign.decisions.push(`Planned ${campaign.milestones.length} milestone(s) at ${now}.`);
    await this.save(campaign);
    await appendDecision(this.workspacePath, {
      agent: "CampaignManager",
      summary: `Campaign ${campaign.id} planned ${campaign.milestones.length} milestone(s).`,
      rationale: `Index freshness: ${freshness.status}.`,
      tags: ["campaign", "phase-4"]
    }, this.memoryDir);
    await this.appendEvent(campaign.id, "campaign.planned", { milestones: campaign.milestones.length, freshness });
    return campaign;
  }

  async runNext(campaignId: string, options: { mode?: ExecutionMode; dryRun?: boolean } = {}) {
    const campaign = await this.load(campaignId);
    if (campaign.status === "paused") throw new Error(`Campaign is paused: ${campaign.id}`);
    if (!campaign.milestones.length) await this.plan(campaignId);
    const refreshed = await this.load(campaignId);
    const milestone = refreshed.milestones.find((candidate) => candidate.status === "pending" || candidate.status === "blocked");
    if (!milestone) {
      refreshed.status = refreshed.milestones.every((candidate) => candidate.status === "succeeded") ? "succeeded" : refreshed.status;
      refreshed.updated_at = new Date().toISOString();
      await this.save(refreshed);
      return { campaign: refreshed, run: undefined };
    }
    milestone.status = options.dryRun ? "blocked" : "running";
    milestone.updated_at = new Date().toISOString();
    refreshed.status = options.dryRun ? "blocked" : "running";
    await this.save(refreshed);
    await this.appendEvent(refreshed.id, "campaign.run_started", { milestone_id: milestone.id, dry_run: Boolean(options.dryRun) });
    if (options.dryRun) return { campaign: refreshed, run: undefined };

    const orchestrator = new CoreOrchestrator({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      config: { execution_mode: options.mode ?? "deep" }
    });
    const result = await orchestrator.runAgenticTask(`Campaign ${refreshed.id} milestone ${milestone.id}: ${milestone.objective}`);
    milestone.run_id = result.run.id;
    milestone.status = result.run.status === "succeeded" ? "succeeded" : "failed";
    milestone.updated_at = new Date().toISOString();
    refreshed.runs.push(result.run.id);
    refreshed.status = refreshed.milestones.some((candidate) => candidate.status === "failed") ? "blocked" : refreshed.milestones.every((candidate) => candidate.status === "succeeded") ? "succeeded" : "running";
    refreshed.updated_at = new Date().toISOString();
    refreshed.decisions.push(`Milestone ${milestone.id} completed through run ${result.run.id} with status ${result.run.status}.`);
    await this.save(refreshed);
    await this.writeReport(refreshed);
    await this.writeMetrics(refreshed);
    await this.appendEvent(refreshed.id, "campaign.run_completed", { milestone_id: milestone.id, run_id: result.run.id, status: result.run.status });
    return { campaign: refreshed, run: result };
  }

  async pause(campaignId: string) {
    const campaign = await this.load(campaignId);
    campaign.status = "paused";
    campaign.updated_at = new Date().toISOString();
    await this.save(campaign);
    await this.appendEvent(campaign.id, "campaign.paused", {});
    return campaign;
  }

  async resume(campaignId: string) {
    const campaign = await this.load(campaignId);
    campaign.status = campaign.milestones.some((milestone) => milestone.status === "failed") ? "blocked" : "running";
    campaign.updated_at = new Date().toISOString();
    await this.save(campaign);
    await this.appendEvent(campaign.id, "campaign.resumed", {});
    return campaign;
  }

  async status(campaignId: string) {
    return this.load(campaignId);
  }

  async report(campaignId: string) {
    const campaign = await this.load(campaignId);
    return this.writeReport(campaign);
  }

  async metrics(campaignId: string) {
    const campaign = await this.load(campaignId);
    return this.writeMetrics(campaign);
  }

  async load(campaignId: string): Promise<Campaign> {
    const store = await SqliteMemoryStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const campaign = store.state<Campaign>("campaign", campaignId);
      if (!campaign) throw new Error(`SQLite campaign state not found: ${campaignId}`);
      return campaign;
    } finally {
      store.close();
    }
  }

  private async save(campaign: Campaign) {
    const dir = await this.campaignDir(campaign.id);
    await mkdir(dir, { recursive: true });
    const artifactRef = path.join(dir, "campaign.json");
    const store = await SqliteMemoryStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
    try {
      store.saveState({ kind: "campaign", id: campaign.id, status: campaign.status, updatedAt: campaign.updated_at, state: campaign, artifactRef });
    } finally {
      store.close();
    }
    await writeJson(artifactRef, campaign);
    await this.metadata.recordCampaignSaved(campaign, artifactRef);
  }

  private async writeReport(campaign: Campaign) {
    const dir = await this.campaignDir(campaign.id);
    const reportsDir = path.join(dir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const report = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      campaign_id: campaign.id,
      status: campaign.status,
      original_goal: campaign.original_goal,
      runs: campaign.runs,
      milestones: campaign.milestones,
      risks: campaign.risks,
      decisions: campaign.decisions,
      next_steps: nextCampaignSteps(campaign)
    };
    const reportPath = path.join(reportsDir, "final_report.json");
    await writeJson(reportPath, report);
    await this.metadata.recordArtifactSaved({
      campaignId: campaign.id,
      kind: "campaign_report",
      artifactRef: reportPath,
      status: campaign.status,
      metadata: { run_count: campaign.runs.length, milestone_count: campaign.milestones.length }
    });
    campaign.final_report_ref = reportPath;
    await this.save(campaign);
    return report;
  }

  private async writeMetrics(campaign: Campaign): Promise<CampaignMetrics> {
    const metrics: CampaignMetrics = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      campaign_id: campaign.id,
      generated_at: new Date().toISOString(),
      runs: campaign.runs.length,
      milestones_total: campaign.milestones.length,
      milestones_completed: campaign.milestones.filter((milestone) => milestone.status === "succeeded").length,
      milestones_failed: campaign.milestones.filter((milestone) => milestone.status === "failed" || milestone.status === "blocked").length,
      status: campaign.status
    };
    const dir = await this.campaignDir(campaign.id);
    await mkdir(path.join(dir, "metrics"), { recursive: true });
    const metricsPath = path.join(dir, "metrics", "campaign_metrics.json");
    await writeJson(metricsPath, metrics);
    await this.metadata.recordCampaignMetricSaved({
      campaignId: campaign.id,
      status: campaign.status,
      generatedAt: metrics.generated_at,
      artifactRef: metricsPath,
      metadata: {
        runs: metrics.runs,
        milestones_total: metrics.milestones_total,
        milestones_completed: metrics.milestones_completed,
        milestones_failed: metrics.milestones_failed
      }
    });
    return metrics;
  }

  private async appendEvent(campaignId: string, type: string, payload: unknown) {
    const dir = await this.campaignDir(campaignId);
    await mkdir(dir, { recursive: true });
    const event = {
      id: `event_${randomUUID()}`,
      campaign_id: campaignId,
      type,
      created_at: new Date().toISOString(),
      payload
    };
    const eventsPath = path.join(dir, "events.jsonl");
    const store = await SqliteMemoryStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
    try {
      store.appendEvent({ kind: "campaign", streamId: campaignId, id: event.id, type, createdAt: event.created_at, payload: event, artifactRef: eventsPath });
    } finally {
      store.close();
    }
    await writeFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: existsSync(eventsPath) ? "a" : "w" });
    await this.metadata.recordArtifactSaved({
      campaignId,
      kind: "campaign_events",
      artifactRef: eventsPath,
      status: type,
      createdAt: event.created_at,
      updatedAt: event.created_at
    });
  }

  private async campaignDir(campaignId: string) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    return path.join(memory.campaignsDir, campaignId);
  }
}

function createMilestone(title: string, objective: string, now: string): CampaignMilestone {
  return {
    id: `milestone_${randomUUID().slice(0, 8)}`,
    title,
    objective,
    status: "pending",
    created_at: now,
    updated_at: now
  };
}

function nextCampaignSteps(campaign: Campaign) {
  if (campaign.status === "paused") return ["Run campaign resume before run-next."];
  const next = campaign.milestones.find((milestone) => milestone.status === "pending" || milestone.status === "blocked");
  if (next) return [`Run next milestone: ${next.title}.`];
  return ["Generate final campaign report and compact memory lessons."];
}

function titleFromGoal(goal: string) {
  return goal.trim().split(/\s+/).slice(0, 8).join(" ") || "Untitled campaign";
}
