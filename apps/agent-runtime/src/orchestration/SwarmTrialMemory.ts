import { randomUUID } from "node:crypto";
import { appendJsonl, ensureMemoryLayout } from "../memory/ProjectMemory.js";
import type { SwarmTrialMemoryRecord } from "./SwarmTrialModels.js";
import { SWARM_TRIAL_SCHEMA_VERSION } from "./SwarmTrialModels.js";

export async function appendSwarmStaffingLesson(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record = createRecord(input);
  await appendJsonl(paths.swarmStaffingLessons, record);
  return record;
}

export async function appendSwarmTuningHistory(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record = createRecord(input);
  await appendJsonl(paths.swarmTuningHistory, record);
  return record;
}

export async function appendSwarmFailurePattern(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record = createRecord(input);
  await appendJsonl(paths.swarmFailurePatterns, record);
  return record;
}

export async function appendSwarmSuccessPattern(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record = createRecord(input);
  await appendJsonl(paths.swarmSuccessPatterns, record);
  return record;
}

export async function appendSwarmSpecialistSelectionHistory(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record = createRecord(input);
  await appendJsonl(paths.swarmSpecialistSelectionHistory, record);
  return record;
}

function createRecord(input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">): SwarmTrialMemoryRecord {
  return {
    schema_version: SWARM_TRIAL_SCHEMA_VERSION,
    id: `swarm_trial_memory_${randomUUID()}`,
    created_at: new Date().toISOString(),
    ...input
  };
}
