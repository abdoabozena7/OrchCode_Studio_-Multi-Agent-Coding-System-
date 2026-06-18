import { randomUUID } from "node:crypto";
import { appendMemoryRecord } from "../memory/ProjectMemory.js";
import type { SwarmTrialMemoryRecord } from "./SwarmTrialModels.js";
import { SWARM_TRIAL_SCHEMA_VERSION } from "./SwarmTrialModels.js";

export async function appendSwarmStaffingLesson(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const record = createRecord(input);
  await appendMemoryRecord(workspacePath, "swarm_staffing_lesson", record, memoryDir);
  return record;
}

export async function appendSwarmTuningHistory(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const record = createRecord(input);
  await appendMemoryRecord(workspacePath, "swarm_tuning_history", record, memoryDir);
  return record;
}

export async function appendSwarmFailurePattern(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const record = createRecord(input);
  await appendMemoryRecord(workspacePath, "swarm_failure_pattern", record, memoryDir);
  return record;
}

export async function appendSwarmSuccessPattern(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const record = createRecord(input);
  await appendMemoryRecord(workspacePath, "swarm_success_pattern", record, memoryDir);
  return record;
}

export async function appendSwarmSpecialistSelectionHistory(workspacePath: string, input: Omit<SwarmTrialMemoryRecord, "schema_version" | "id" | "created_at">, memoryDir?: string) {
  const record = createRecord(input);
  await appendMemoryRecord(workspacePath, "swarm_specialist_selection", record, memoryDir);
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
