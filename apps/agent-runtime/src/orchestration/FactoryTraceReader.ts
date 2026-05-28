import { existsSync } from "node:fs";
import { resolveFactoryMetadataDatabasePath, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import {
  parseFactoryTraceArtifactRefs,
  parseFactoryTraceMetadata,
  summarizeFactoryTraceEvents,
  type FactoryTraceEvent,
  type FactoryTraceSummary
} from "./FactoryTraceEvents.js";

export type FactoryRunTraceReconstruction = {
  events: FactoryTraceEvent[];
  eventsByTask: Record<string, FactoryTraceEvent[]>;
  rejectedTransitions: FactoryTraceEvent[];
  failedValidations: FactoryTraceEvent[];
  blockedReasons: Array<{ event_id: string; reason: string; task_id?: string }>;
  artifactRefs: string[];
  missingExpectedTraceLinks: string[];
  summary: FactoryTraceSummary;
};

type TraceEventRow = {
  id: string;
  trace_event_id?: string;
  run_id: string;
  campaign_id?: string;
  task_id?: string;
  parent_task_id?: string;
  agent_id?: string;
  team_id?: string;
  event_type: string;
  lifecycle_stage?: string;
  previous_status?: string;
  next_status?: string;
  status?: string;
  causal_parent_event_id?: string;
  causal_chain_id?: string;
  source_component?: string;
  severity?: string;
  reason?: string;
  summary?: string;
  message?: string;
  artifact_ref?: string;
  artifact_refs_json?: string;
  created_at: string;
  metadata_json: string;
};

export async function reconstructFactoryRunTrace(input: {
  workspacePath: string;
  runId: string;
  memoryDir?: string;
}): Promise<FactoryRunTraceReconstruction> {
  const databasePath = await resolveFactoryMetadataDatabasePath(input.workspacePath, input.memoryDir);
  if (!existsSync(databasePath)) return emptyTrace();
  const store = await FactoryMetadataStore.open({
    workspacePath: input.workspacePath,
    memoryDir: input.memoryDir,
    readOnly: true
  });
  try {
    const rows = store.all<TraceEventRow>(
      "SELECT * FROM factory_trace_events WHERE run_id = ? ORDER BY created_at, id",
      input.runId
    );
    return reconstructFactoryTraceEvents(rows.map(traceEventFromRow));
  } finally {
    store.close();
  }
}

export function reconstructFactoryTraceEvents(events: FactoryTraceEvent[]): FactoryRunTraceReconstruction {
  const chronological = [...events].sort((left, right) => {
    const byTime = left.timestamp.localeCompare(right.timestamp);
    return byTime || left.trace_event_id.localeCompare(right.trace_event_id);
  });
  const eventsByTask: Record<string, FactoryTraceEvent[]> = {};
  const artifactRefs = new Set<string>();
  const eventIds = new Set(chronological.map((event) => event.trace_event_id));
  const missingExpectedTraceLinks: string[] = [];

  for (const event of chronological) {
    if (event.task_id) {
      eventsByTask[event.task_id] ??= [];
      eventsByTask[event.task_id].push(event);
    }
    for (const ref of event.artifact_refs) artifactRefs.add(ref);
    if (requiresCausalParent(event) && (!event.causal_parent_event_id || !eventIds.has(event.causal_parent_event_id))) {
      missingExpectedTraceLinks.push(`${event.trace_event_id}:${event.event_type}`);
    }
  }

  const rejectedTransitions = chronological.filter((event) => event.event_type === "run_transition_rejected");
  const failedValidations = chronological.filter((event) => event.event_type === "validation_failed" || event.event_type === "validation_partial" || event.event_type === "output_schema_failed");
  const blockedReasons = chronological
    .filter((event) => event.event_type === "run_blocked" || event.event_type === "validation_blocked" || event.next_status === "blocked")
    .map((event) => ({
      event_id: event.trace_event_id,
      reason: event.reason ?? event.summary ?? "Blocked without a recorded reason.",
      task_id: event.task_id
    }));
  return {
    events: chronological,
    eventsByTask,
    rejectedTransitions,
    failedValidations,
    blockedReasons,
    artifactRefs: [...artifactRefs].sort(),
    missingExpectedTraceLinks,
    summary: summarizeFactoryTraceEvents(chronological, missingExpectedTraceLinks.length)
  };
}

function traceEventFromRow(row: TraceEventRow): FactoryTraceEvent {
  const artifactRefs = parseFactoryTraceArtifactRefs(row.artifact_refs_json, row.artifact_ref);
  return {
    trace_event_id: row.trace_event_id ?? row.id,
    run_id: row.run_id,
    campaign_id: row.campaign_id,
    task_id: row.task_id,
    parent_task_id: row.parent_task_id,
    agent_id: row.agent_id,
    team_id: row.team_id,
    event_type: row.event_type,
    lifecycle_stage: row.lifecycle_stage,
    previous_status: row.previous_status,
    next_status: row.next_status ?? row.status,
    causal_parent_event_id: row.causal_parent_event_id,
    causal_chain_id: row.causal_chain_id ?? row.trace_event_id ?? row.id,
    source_component: row.source_component ?? "unknown",
    severity: severityFromRow(row.severity),
    timestamp: row.created_at,
    reason: row.reason,
    summary: row.summary ?? row.message,
    artifact_refs: artifactRefs,
    metadata_json: parseFactoryTraceMetadata(row.metadata_json)
  };
}

function severityFromRow(value: string | undefined): FactoryTraceEvent["severity"] {
  if (value === "debug" || value === "info" || value === "warning" || value === "error" || value === "critical") return value;
  return "info";
}

function requiresCausalParent(event: FactoryTraceEvent) {
  return [
    "agent_invocation_started",
    "agent_invocation_completed",
    "agent_invocation_failed",
    "raw_output_saved",
    "parsed_output_saved",
    "review_started",
    "review_completed",
    "validation_started",
    "validation_completed",
    "integration_completed",
    "report_completed"
  ].includes(event.event_type);
}

function emptyTrace(): FactoryRunTraceReconstruction {
  return {
    events: [],
    eventsByTask: {},
    rejectedTransitions: [],
    failedValidations: [],
    blockedReasons: [],
    artifactRefs: [],
    missingExpectedTraceLinks: [],
    summary: summarizeFactoryTraceEvents([])
  };
}
