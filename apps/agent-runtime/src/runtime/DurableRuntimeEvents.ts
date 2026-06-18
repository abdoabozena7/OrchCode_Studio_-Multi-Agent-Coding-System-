import type {
  DurableRuntimeEvent,
  DurableRuntimeEventActor,
  DurableRuntimeEventAuthority,
  DurableRuntimeEventType
} from "@hivo/protocol";
import { isDurableRuntimeEventType } from "@hivo/protocol";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { access } from "node:fs/promises";
import { randomId } from "./SessionManager.js";

export function createDurableRuntimeEvent(input: {
  sessionId: string;
  sequence: number;
  type: DurableRuntimeEventType;
  actor: DurableRuntimeEventActor;
  authority: DurableRuntimeEventAuthority;
  payload?: Record<string, unknown>;
  version?: number;
  correlationId?: string;
  causationId?: string;
  createdAt?: string;
}): DurableRuntimeEvent {
  return {
    id: randomId("runtime_event"),
    sessionId: input.sessionId,
    sequence: input.sequence,
    type: input.type,
    version: input.version ?? 1,
    actor: input.actor,
    authority: input.authority,
    createdAt: input.createdAt ?? new Date().toISOString(),
    correlationId: input.correlationId,
    causationId: input.causationId,
    payload: input.payload ?? {}
  };
}

export function mapRuntimeEventNameToDurableType(eventType: string): DurableRuntimeEventType | undefined {
  const canonical = eventType.startsWith("runtime.") ? eventType.slice("runtime.".length) : eventType;
  const compatibilityMap: Record<string, DurableRuntimeEventType> = {
    "session.created": "session.created",
    "session.restored": "session.restored",
    "session.expired": "session.expired",
    "product_spec.proposed": "product_spec.proposed",
    "product_spec.approved": "product_spec.approved",
    "technical_plan.proposed": "technical_plan.proposed",
    "technical_plan.approved": "technical_plan.approved",
    "recursive_graph.proposed": "recursive_graph.proposed",
    "recursive_graph.ready": "recursive_graph.ready",
    "recursive_graph.blocked": "recursive_graph.blocked",
    "branch_orchestrator.planned": "branch_orchestrator.planned",
    "branch_scope.conflict_detected": "branch_scope.conflict_detected",
    "branch_execution.ready": "branch_execution.ready",
    "branch_execution.started": "branch_execution.started",
    "branch_execution.patch_proposed": "branch_execution.patch_proposed",
    "branch_execution.reviewing": "branch_execution.reviewing",
    "branch_execution.validation_pending": "branch_execution.validation_pending",
    "branch_execution.completed": "branch_execution.completed",
    "branch_execution.blocked": "branch_execution.blocked",
    "branch_execution.failed": "branch_execution.failed",
    "branch_result.recorded": "branch_result.recorded",
    "recursive_fan_in.updated": "recursive_fan_in.updated",
    "recursive_final_report.created": "recursive_final_report.created",
    "knowledge_tree.created": "knowledge_tree.created",
    "knowledge_tree.refreshed": "knowledge_tree.refreshed",
    "knowledge_node.created": "knowledge_node.created",
    "edit_route.proposed": "edit_route.proposed",
    "edit_route.ready": "edit_route.ready",
    "edit_route.blocked": "edit_route.blocked",
    "knowledge_branch_targets.created": "knowledge_branch_targets.created",
    "knowledge_branch_execution.planned": "knowledge_branch_execution.planned",
    "patch.proposed": "patch.proposed",
    "patch.approved": "patch.approved",
    "patch.rejected": "patch.rejected",
    "patch.applied": "patch.applied",
    "patch.apply_failed": "patch.apply_failed",
    "command.requested": "command.requested",
    "command.approved": "command.approved",
    "command.rejected": "command.denied",
    "command.started": "command.started",
    "command.completed": "command.completed",
    "command.failed": "command.failed",
    "command.blocked": "command.failed",
    "verification.pending": "verification.started",
    "verification.running": "verification.started",
    "verification.passed": "verification.completed",
    "verification.failed": "verification.completed",
    "verification.not_run": "verification.completed",
    "verification.skipped": "verification.completed",
    "verification.unavailable": "verification.completed"
  };
  const mapped = compatibilityMap[canonical] ?? (isDurableRuntimeEventType(canonical) ? canonical : undefined);
  return mapped;
}

export async function listDurableRuntimeEventsFromSqlite(sessionId: string): Promise<DurableRuntimeEvent[]> {
  const databasePath = resolveDesktopStateDatabasePath();
  if (!databasePath) return [];
  try {
    await access(databasePath);
  } catch {
    return [];
  }

  try {
    const sqlite: {
      DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
        close(): void;
      };
    } = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true });
    try {
      const statement = database.prepare(
        "SELECT id, session_id, sequence, event_type, actor, authority, payload_json, created_at, version, correlation_id, causation_id FROM runtime_events WHERE session_id = ? ORDER BY sequence ASC"
      );
      const rows = statement.all(sessionId);
      return rows.map((row) => {
        const rawPayload = typeof row.payload_json === "string" ? row.payload_json : "{}";
        try {
          return {
            id: String(row.id),
            sessionId: String(row.session_id),
            sequence: Number(row.sequence),
            type: String(row.event_type) as DurableRuntimeEventType,
            actor: String(row.actor) as DurableRuntimeEventActor,
            authority: String(row.authority) as DurableRuntimeEventAuthority,
            createdAt: String(row.created_at),
            version: Number(row.version),
            correlationId: typeof row.correlation_id === "string" ? row.correlation_id : undefined,
            causationId: typeof row.causation_id === "string" ? row.causation_id : undefined,
            payload: JSON.parse(rawPayload) as Record<string, unknown>
          } satisfies DurableRuntimeEvent;
        } catch {
          return {
            id: String(row.id),
            sessionId: String(row.session_id),
            sequence: Number(row.sequence),
            type: String(row.event_type) as DurableRuntimeEventType,
            actor: String(row.actor) as DurableRuntimeEventActor,
            authority: String(row.authority) as DurableRuntimeEventAuthority,
            createdAt: String(row.created_at),
            version: Number(row.version),
            correlationId: typeof row.correlation_id === "string" ? row.correlation_id : undefined,
            causationId: typeof row.causation_id === "string" ? row.causation_id : undefined,
            payload: {
              __payloadMalformed: true,
              rawPayloadJson: rawPayload
            }
          } satisfies DurableRuntimeEvent;
        }
      });
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

function resolveDesktopStateDatabasePath() {
  if (process.env.HIVO_DESKTOP_STATE_DB || process.env.ORCHCODE_DESKTOP_STATE_DB) {
    return process.env.HIVO_DESKTOP_STATE_DB ?? process.env.ORCHCODE_DESKTOP_STATE_DB;
  }
  const resolveExistingOrNew = (root: string) => {
    const hivoPath = path.join(root, "HivoStudio", "state.sqlite");
    const legacyPath = path.join(root, "OrchCodeStudio", "state.sqlite");
    return !existsSync(hivoPath) && existsSync(legacyPath) ? legacyPath : hivoPath;
  };
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA;
    return root ? resolveExistingOrNew(root) : undefined;
  }
  if (process.platform === "darwin") {
    return resolveExistingOrNew(path.join(os.homedir(), "Library", "Application Support"));
  }
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return resolveExistingOrNew(dataHome);
}
