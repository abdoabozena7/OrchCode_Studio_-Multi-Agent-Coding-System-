import { existsSync } from "node:fs";
import { readJson } from "../memory/ProjectMemory.js";
import type { AgentTeamHierarchy } from "./AgentTeamModels.js";

export async function readOptionalJson<T>(artifactRef: string): Promise<T | undefined> {
  try {
    if (!existsSync(artifactRef)) return undefined;
    return await readJson<T>(artifactRef);
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function teamHierarchySummary(hierarchy: AgentTeamHierarchy, validation: { valid: boolean; budget_warnings: string[] }): string {
  return [
    "# Agent Team Hierarchy",
    "",
    `- root_team_id: ${hierarchy.root_team_id ?? "none"}`,
    `- team_count: ${hierarchy.teams.length}`,
    `- max_depth: ${hierarchy.max_depth}`,
    `- valid: ${validation.valid}`,
    "",
    "## Teams",
    ...hierarchy.teams.map((team) => `- ${team.team_id}: ${team.team_type}/${team.domain} (${team.status})`),
    "",
    "## Budget Warnings",
    ...(validation.budget_warnings.length ? validation.budget_warnings.map((warning) => `- ${warning}`) : ["- none"])
  ].join("\n");
}
