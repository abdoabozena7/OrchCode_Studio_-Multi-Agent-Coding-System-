import type { OrchestratorEvent } from "./OrchestrationModels.js";
import type { RunTransitionRecord, RunTransitionTrigger } from "./RunStateMachine.js";
import type { SchedulerTraceEntry, SwarmEvent } from "./SwarmModels.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import {
  createFactoryTraceEvent,
  factoryTraceEventFromArtifactEvent,
  factoryTraceEventFromSchedulerTrace,
  type FactoryTraceEvent,
  type FactoryTraceEventInput,
  type FactoryTraceSourceComponent
} from "./FactoryTraceEvents.js";

type Cursor = {
  eventId: string;
  chainId: string;
};

export type FactoryTraceWriterOptions = {
  workspacePath: string;
  memoryDir?: string;
  sourceComponent?: FactoryTraceSourceComponent;
};

export class FactoryTraceWriter {
  private static readonly eventChains = new Map<string, string>();
  private static readonly lastByRun = new Map<string, Cursor>();
  private static readonly lastByTask = new Map<string, Cursor>();

  private readonly metadata: FactoryMetadataAdapter;
  private readonly sourceComponent: FactoryTraceSourceComponent;

  constructor(private readonly options: FactoryTraceWriterOptions) {
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.sourceComponent = options.sourceComponent ?? "FactoryTraceWriter";
  }

  async write(input: FactoryTraceEventInput): Promise<FactoryTraceEvent> {
    const parent = input.causal_parent_event_id
      ? undefined
      : this.cursorFor(input.run_id, input.task_id);
    const parentEventId = input.causal_parent_event_id ?? parent?.eventId;
    const parentChainId = parentEventId ? FactoryTraceWriter.eventChains.get(parentEventId) : undefined;
    const event = createFactoryTraceEvent({
      ...input,
      causal_parent_event_id: parentEventId,
      causal_chain_id: input.causal_chain_id ?? parentChainId ?? parent?.chainId,
      source_component: input.source_component ?? this.sourceComponent
    });
    await this.metadata.recordFactoryTraceEvent(event);
    this.remember(event);
    return event;
  }

  async recordArtifactEvent(event: OrchestratorEvent | SwarmEvent, artifactRef: string): Promise<FactoryTraceEvent> {
    const runId = "swarm_run_id" in event ? event.swarm_run_id : event.run_id;
    const taskId = "swarm_run_id" in event ? event.work_item_id : event.task_id;
    const parent = this.cursorFor(runId, taskId);
    const traceEvent = factoryTraceEventFromArtifactEvent({
      event,
      artifactRef,
      causalParentEventId: parent?.eventId,
      causalChainId: parent?.chainId
    });
    await this.metadata.recordFactoryTraceEvent(traceEvent);
    this.remember(traceEvent);
    return traceEvent;
  }

  async recordSchedulerTrace(entry: SchedulerTraceEntry, artifactRef: string): Promise<FactoryTraceEvent> {
    const parent = this.cursorFor(entry.swarm_run_id);
    const traceEvent = factoryTraceEventFromSchedulerTrace({
      entry,
      artifactRef,
      causalParentEventId: parent?.eventId,
      causalChainId: parent?.chainId
    });
    await this.metadata.recordFactoryTraceEvent(traceEvent);
    this.remember(traceEvent);
    return traceEvent;
  }

  async recordRunTransitionRequested(input: {
    runId: string;
    previousStatus?: string;
    nextStatus: string;
    reason: string;
    sourceComponent: FactoryTraceSourceComponent;
    taskId?: string;
    artifactRefs?: string[];
    trigger?: RunTransitionTrigger;
    mode?: string;
    timestamp?: string;
  }) {
    return this.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: "run_transition_requested",
      lifecycle_stage: input.nextStatus,
      previous_status: input.previousStatus,
      next_status: input.nextStatus,
      source_component: input.sourceComponent,
      severity: "info",
      timestamp: input.timestamp,
      reason: input.reason,
      summary: `Run transition requested: ${input.previousStatus ?? "<none>"} -> ${input.nextStatus}.`,
      artifact_refs: input.artifactRefs ?? [],
      metadata_json: {
        trigger: input.trigger ?? "automatic",
        mode: input.mode
      }
    });
  }

  async recordRunTransitionAccepted(record: RunTransitionRecord, input: {
    causalParentEventId?: string;
    summary?: string;
  } = {}) {
    return this.write({
      run_id: record.run_id,
      task_id: record.task_id,
      event_type: "run_transition_accepted",
      lifecycle_stage: record.canonical_next_status,
      previous_status: record.previous_status,
      next_status: record.next_status,
      causal_parent_event_id: input.causalParentEventId,
      source_component: record.source_component,
      severity: "info",
      timestamp: record.created_at,
      reason: record.reason,
      summary: input.summary ?? `Run transition accepted: ${record.previous_status ?? "<none>"} -> ${record.next_status}.`,
      artifact_refs: record.artifact_refs,
      metadata_json: {
        transition_record_id: record.id,
        canonical_previous_status: record.canonical_previous_status,
        canonical_next_status: record.canonical_next_status,
        trigger: record.trigger,
        ...record.metadata
      }
    });
  }

  async recordRunTransitionRejected(input: {
    runId: string;
    previousStatus?: string;
    nextStatus: string;
    reason: string;
    sourceComponent: FactoryTraceSourceComponent;
    causalParentEventId?: string;
    taskId?: string;
    artifactRefs?: string[];
    trigger?: RunTransitionTrigger;
    timestamp?: string;
  }) {
    return this.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: "run_transition_rejected",
      lifecycle_stage: input.nextStatus,
      previous_status: input.previousStatus,
      next_status: input.nextStatus,
      causal_parent_event_id: input.causalParentEventId,
      source_component: input.sourceComponent,
      severity: "error",
      timestamp: input.timestamp,
      reason: input.reason,
      summary: `Run transition rejected: ${input.previousStatus ?? "<none>"} -> ${input.nextStatus}.`,
      artifact_refs: input.artifactRefs ?? [],
      metadata_json: {
        trigger: input.trigger ?? "automatic"
      }
    });
  }

  private cursorFor(runId: string, taskId?: string): Cursor | undefined {
    if (taskId) {
      const taskCursor = FactoryTraceWriter.lastByTask.get(this.taskKey(runId, taskId));
      if (taskCursor) return taskCursor;
    }
    return FactoryTraceWriter.lastByRun.get(this.runKey(runId));
  }

  private remember(event: FactoryTraceEvent) {
    FactoryTraceWriter.eventChains.set(event.trace_event_id, event.causal_chain_id);
    FactoryTraceWriter.lastByRun.set(this.runKey(event.run_id), {
      eventId: event.trace_event_id,
      chainId: event.causal_chain_id
    });
    if (event.task_id) {
      FactoryTraceWriter.lastByTask.set(this.taskKey(event.run_id, event.task_id), {
        eventId: event.trace_event_id,
        chainId: event.causal_chain_id
      });
    }
  }

  private runKey(runId: string) {
    return `${this.options.workspacePath}\0${this.options.memoryDir ?? ""}\0${runId}`;
  }

  private taskKey(runId: string, taskId: string) {
    return `${this.runKey(runId)}\0${taskId}`;
  }
}
