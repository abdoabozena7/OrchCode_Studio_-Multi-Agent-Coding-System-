import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryLayout, writeJson } from "../memory/ProjectMemory.js";
import {
  FactoryMetadataAdapter,
  FactoryMetadataStore
} from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { ContextPack, Task } from "./OrchestrationModels.js";
import {
  FACTORY_LOCK_SCHEMA_VERSION,
  isActiveLockStatus,
  lockModeBlocks,
  moduleLocksForTask,
  semanticLocksForTask,
  type FactoryLock,
  type FactoryLockMode,
  type FactoryLockScope,
  type FactoryLockType,
  type LockAcquisitionRequest,
  type LockAcquisitionResult,
  type LockConflict,
  type LockRecoveryResult,
  type LockReleaseResult
} from "./FactoryLockModels.js";

export type DurableLockManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  ttlMs?: number;
  ownerComponent?: string;
};

export class DurableLockManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly ttlMs: number;
  private readonly ownerComponent: string;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly traceWriter: FactoryTraceWriter;

  constructor(options: DurableLockManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.ownerComponent = options.ownerComponent ?? "DurableLockManager";
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: this.ownerComponent });
  }

  async acquireLocks(request: LockAcquisitionRequest): Promise<LockAcquisitionResult> {
    const recovery = await this.recoverExpiredLocks(request.run_id);
    const requestRef = await this.writeLockArtifact(request.run_id, "lock_request", request.request_id, request);
    const requested = await this.traceWriter.write({
      run_id: request.run_id,
      task_id: request.task_id,
      agent_id: request.agent_id,
      event_type: "lock_requested",
      lifecycle_stage: "executing",
      summary: `Lock request ${request.request_id} for ${request.scopes.length} scope(s).`,
      artifact_refs: [requestRef, ...recovery.artifact_refs],
      metadata_json: traceMetadataFromRequest(request)
    });

    for (const scope of request.scopes) {
      if (scope.type === "semantic") {
        await this.traceWriter.write({
          run_id: request.run_id,
          task_id: request.task_id,
          event_type: "semantic_lock_derived",
          lifecycle_stage: "executing",
          causal_parent_event_id: requested.trace_event_id,
          summary: scope.reason,
          metadata_json: traceMetadataFromScope(request, scope)
        });
      } else if (scope.type === "module") {
        await this.traceWriter.write({
          run_id: request.run_id,
          task_id: request.task_id,
          event_type: "module_lock_derived",
          lifecycle_stage: "executing",
          causal_parent_event_id: requested.trace_event_id,
          summary: scope.reason,
          metadata_json: traceMetadataFromScope(request, scope)
        });
      } else if (scope.type === "advisory" || scope.mode === "advisory") {
        await this.traceWriter.write({
          run_id: request.run_id,
          task_id: request.task_id,
          event_type: "advisory_lock_recorded",
          lifecycle_stage: "executing",
          causal_parent_event_id: requested.trace_event_id,
          severity: "warning",
          summary: scope.reason,
          metadata_json: traceMetadataFromScope(request, scope)
        });
      }
    }

    const conflicts = await this.findConflicts(request.scopes);
    const blockingConflicts = conflicts.filter((conflict) => conflict.blocking);
    if (blockingConflicts.length) {
      const rejectedLocks = request.scopes.map((scope, index) => this.createLock(request, scope, "rejected", {
        conflict_with_lock_id: blockingConflicts[index]?.existing_lock.lock_id,
        reason: blockingConflicts[index]?.reason ?? "Lock request conflicted with active durable lock."
      }));
      const conflictRef = await this.writeLockArtifact(request.run_id, "lock_conflict", request.request_id, {
        request,
        conflicts: blockingConflicts,
        rejected_locks: rejectedLocks
      });
      const rejectedTrace = await this.traceWriter.write({
        run_id: request.run_id,
        task_id: request.task_id,
        agent_id: request.agent_id,
        event_type: "lock_conflict_detected",
        lifecycle_stage: "executing",
        severity: "warning",
        causal_parent_event_id: requested.trace_event_id,
        summary: `Lock request rejected by ${blockingConflicts.length} conflict(s).`,
        reason: blockingConflicts.map((conflict) => conflict.reason).join("; "),
        artifact_refs: [conflictRef],
        metadata_json: {
          ...traceMetadataFromRequest(request),
          conflict_lock_ids: blockingConflicts.map((conflict) => conflict.existing_lock.lock_id)
        }
      });
      await this.traceWriter.write({
        run_id: request.run_id,
        task_id: request.task_id,
        agent_id: request.agent_id,
        event_type: "lock_rejected",
        lifecycle_stage: "blocked",
        severity: "warning",
        causal_parent_event_id: rejectedTrace.trace_event_id,
        summary: "Durable lock request rejected.",
        artifact_refs: [conflictRef],
        metadata_json: {
          ...traceMetadataFromRequest(request),
          conflict_lock_ids: blockingConflicts.map((conflict) => conflict.existing_lock.lock_id)
        }
      });
      for (const lock of rejectedLocks) {
        lock.trace_event_id = rejectedTrace.trace_event_id;
        await this.metadata.recordDurableLockSaved({ lock, artifactRef: conflictRef, conflict: blockingConflicts.find((conflict) => conflict.existing_lock.lock_id === lock.conflict_with_lock_id) });
      }
      return {
        acquired: false,
        request,
        locks: rejectedLocks,
        conflicts: blockingConflicts,
        requested_paths: request.scopes.map((scope) => scope.normalized_scope_key),
        artifact_refs: [requestRef, conflictRef]
      };
    }

    const locks = request.scopes.map((scope) => this.createLock(request, scope, "acquired"));
    const snapshotRef = await this.writeLockArtifact(request.run_id, "lock_snapshot", request.request_id, locks);
    const acquiredTrace = await this.traceWriter.write({
      run_id: request.run_id,
      task_id: request.task_id,
      agent_id: request.agent_id,
      event_type: "lock_acquired",
      lifecycle_stage: "executing",
      causal_parent_event_id: requested.trace_event_id,
      summary: `Acquired ${locks.length} durable lock(s).`,
      artifact_refs: [snapshotRef],
      metadata_json: traceMetadataFromRequest(request, {
        lock_ids: locks.map((lock) => lock.lock_id)
      })
    });
    for (const lock of locks) {
      lock.trace_event_id = acquiredTrace.trace_event_id;
      await this.metadata.recordDurableLockSaved({ lock, artifactRef: snapshotRef });
    }
    return {
      acquired: true,
      request,
      locks,
      conflicts: conflicts.filter((conflict) => !conflict.blocking),
      requested_paths: request.scopes.map((scope) => scope.normalized_scope_key),
      artifact_refs: [requestRef, snapshotRef]
    };
  }

  acquire(runId: string, taskId: string, requestedScopes: string[]): Promise<LockAcquisitionResult> {
    return this.acquireLocks({
      request_id: `lock_request_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      owner_component: this.ownerComponent,
      scopes: requestedScopes.map((scope) => this.normalizeLockScope(scope, "write")),
      ttl_ms: this.ttlMs,
      reason: "Compatibility acquire call for write file locks."
    });
  }

  acquireFileLock(runId: string, taskId: string, filePath: string, mode: FactoryLockMode = "write") {
    return this.acquireLocks({
      request_id: `lock_request_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      owner_component: this.ownerComponent,
      scopes: [this.normalizeLockScope(filePath, mode)],
      ttl_ms: this.ttlMs,
      reason: `Acquire ${mode} file lock for ${filePath}.`
    });
  }

  acquireModuleLock(runId: string, taskId: string, moduleKey: string, mode: FactoryLockMode = "write") {
    return this.acquireLocks({
      request_id: `lock_request_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      owner_component: this.ownerComponent,
      scopes: [keyScope("module", mode, moduleKey, "Requested module lock.")],
      ttl_ms: this.ttlMs,
      reason: `Acquire ${mode} module lock ${moduleKey}.`
    });
  }

  acquireSemanticLock(runId: string, taskId: string, semanticKey: string, mode: FactoryLockMode = "write") {
    return this.acquireLocks({
      request_id: `lock_request_${randomUUID()}`,
      run_id: runId,
      task_id: taskId,
      owner_component: this.ownerComponent,
      scopes: [keyScope("semantic", mode, semanticKey, "Requested semantic lock.")],
      ttl_ms: this.ttlMs,
      reason: `Acquire ${mode} semantic lock ${semanticKey}.`
    });
  }

  async releaseLocks(input: { runId: string; taskId?: string; lockIds?: string[]; reason?: string }): Promise<LockReleaseResult> {
    const active = await this.activeLocks();
    const matched = active.filter((lock) => {
      if (input.lockIds?.length) return input.lockIds.includes(lock.lock_id);
      return (!input.runId || lock.run_id === input.runId) && (!input.taskId || lock.task_id === input.taskId);
    });
    const released = matched.map((lock) => ({
      ...lock,
      status: "released" as const,
      released_at: new Date().toISOString(),
      reason: input.reason ?? "Durable lock released."
    }));
    const releaseRef = await this.writeLockArtifact(input.runId, "lock_release", input.taskId ?? randomUUID(), released);
    const trace = await this.traceWriter.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: "lock_released",
      lifecycle_stage: "executing",
      summary: `Released ${released.length} durable lock(s).`,
      artifact_refs: [releaseRef],
      metadata_json: {
        lock_ids: released.map((lock) => lock.lock_id),
        reason: input.reason
      }
    });
    for (const lock of released) {
      lock.trace_event_id = trace.trace_event_id;
      await this.metadata.recordDurableLockSaved({ lock, artifactRef: releaseRef });
    }
    return {
      released,
      not_found: input.lockIds?.filter((lockId) => !released.some((lock) => lock.lock_id === lockId)) ?? [],
      artifact_refs: [releaseRef]
    };
  }

  releaseByTask(taskId: string): Promise<FactoryLock[]> {
    return this.activeLocks()
      .then((active) => active.find((lock) => lock.task_id === taskId)?.run_id ?? "")
      .then((runId) => this.releaseLocks({ runId, taskId, reason: "Compatibility release by task." }))
      .then((result) => result.released);
  }

  async heartbeatLocks(input: { runId: string; taskId?: string; lockIds?: string[] }): Promise<FactoryLock[]> {
    const active = await this.activeLocks();
    const now = new Date();
    const updated = active
      .filter((lock) => (input.lockIds?.length ? input.lockIds.includes(lock.lock_id) : lock.run_id === input.runId && (!input.taskId || lock.task_id === input.taskId)))
      .map((lock) => ({
        ...lock,
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
        reason: "Durable lock heartbeat."
      }));
    const ref = await this.writeLockArtifact(input.runId, "lock_snapshot", `heartbeat_${input.taskId ?? randomUUID()}`, updated);
    const trace = await this.traceWriter.write({
      run_id: input.runId,
      task_id: input.taskId,
      event_type: "lock_heartbeat",
      lifecycle_stage: "executing",
      summary: `Heartbeat updated ${updated.length} durable lock(s).`,
      artifact_refs: [ref],
      metadata_json: { lock_ids: updated.map((lock) => lock.lock_id) }
    });
    for (const lock of updated) {
      lock.trace_event_id = trace.trace_event_id;
      await this.metadata.recordDurableLockSaved({ lock, artifactRef: ref });
    }
    return updated;
  }

  async findConflicts(scopes: FactoryLockScope[]): Promise<LockConflict[]> {
    const active = await this.activeLocks();
    const conflicts: LockConflict[] = [];
    for (const requested of scopes) {
      for (const existing of active) {
        if (!durableLocksConflict(requested, existing)) continue;
        conflicts.push({
          conflict_id: `lock_conflict_${randomUUID()}`,
          requested_scope: requested,
          existing_lock: existing,
          reason: `Requested ${requested.mode} ${requested.normalized_scope_key} conflicts with active ${existing.lock_mode} ${existing.normalized_scope_key}.`,
          blocking: requested.mode !== "advisory" && requested.type !== "advisory"
        });
      }
    }
    return conflicts;
  }

  async recoverExpiredLocks(runId?: string, now = new Date()): Promise<LockRecoveryResult> {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
    try {
      const expired = store.listExpiredDurableLocks(now.toISOString()).filter((lock) => !runId || lock.run_id === runId);
      if (!expired.length) return { recovered: [], expired: [], artifact_refs: [] };
      const recovered = expired.map((lock) => ({
        ...lock,
        status: "expired" as const,
        reason: "Durable lock expired and was recovered before acquisition."
      }));
      const ref = await this.writeLockArtifact(runId ?? expired[0].run_id, "lock_snapshot", `recovered_${randomUUID()}`, recovered);
      const trace = await this.traceWriter.write({
        run_id: runId ?? expired[0].run_id,
        event_type: "lock_recovered",
        lifecycle_stage: "executing",
        severity: "warning",
        summary: `Recovered ${recovered.length} expired durable lock(s).`,
        artifact_refs: [ref],
        metadata_json: { lock_ids: recovered.map((lock) => lock.lock_id) }
      });
      for (const lock of recovered) {
        lock.trace_event_id = trace.trace_event_id;
        await this.metadata.recordDurableLockSaved({ lock, artifactRef: ref });
      }
      await this.traceWriter.write({
        run_id: runId ?? expired[0].run_id,
        event_type: "lock_expired",
        lifecycle_stage: "executing",
        severity: "warning",
        causal_parent_event_id: trace.trace_event_id,
        summary: "Expired durable locks marked non-active.",
        artifact_refs: [ref],
        metadata_json: { lock_ids: recovered.map((lock) => lock.lock_id) }
      });
      return { recovered, expired, artifact_refs: [ref] };
    } finally {
      store.close();
    }
  }

  async abandonRunLocks(runId: string): Promise<FactoryLock[]> {
    const active = (await this.activeLocks()).filter((lock) => lock.run_id === runId);
    const abandoned = active.map((lock) => ({
      ...lock,
      status: "abandoned" as const,
      released_at: new Date().toISOString(),
      reason: "Run ended with active lock; marked abandoned."
    }));
    const ref = await this.writeLockArtifact(runId, "lock_release", `abandoned_${randomUUID()}`, abandoned);
    for (const lock of abandoned) await this.metadata.recordDurableLockSaved({ lock, artifactRef: ref });
    return abandoned;
  }

  normalizeLockScope(scope: string, mode: FactoryLockMode = "write"): FactoryLockScope {
    const normalized = normalizePathScope(this.workspacePath, scope);
    return {
      type: normalized.kind,
      mode,
      scope,
      normalized_scope_key: `${normalized.kind}:${normalized.path}`,
      confidence: "high",
      reason: `Normalized ${normalized.kind} lock for ${normalized.path}.`
    };
  }

  deriveSemanticLocksForTask(task: Task, contextPack?: ContextPack, mode: FactoryLockMode = "write") {
    return semanticLocksForTask(task, contextPack, mode);
  }

  deriveModuleLocksForTask(task: Task, contextPack?: ContextPack, mode: FactoryLockMode = "write") {
    return moduleLocksForTask(task, contextPack, mode);
  }

  async canAcquire(requestedScopes: string[]) {
    const conflicts = await this.findConflicts(requestedScopes.map((scope) => this.normalizeLockScope(scope, "write")));
    return conflicts.every((conflict) => !conflict.blocking);
  }

  private async activeLocks() {
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
    try {
      return store.listActiveDurableLocks(new Date().toISOString()).filter((lock) => isActiveLockStatus(lock.status));
    } finally {
      store.close();
    }
  }

  private createLock(
    request: LockAcquisitionRequest,
    scope: FactoryLockScope,
    status: FactoryLock["status"],
    overrides: Partial<Pick<FactoryLock, "conflict_with_lock_id" | "reason">> = {}
  ): FactoryLock {
    const now = new Date();
    return {
      schema_version: FACTORY_LOCK_SCHEMA_VERSION,
      lock_id: `lock_${randomUUID()}`,
      run_id: request.run_id,
      task_id: request.task_id,
      agent_id: request.agent_id,
      work_item_id: request.work_item_id,
      lock_type: scope.type,
      lock_mode: scope.mode,
      lock_scope: scope.scope,
      normalized_scope_key: scope.normalized_scope_key,
      owner_component: request.owner_component,
      status,
      reason: overrides.reason ?? scope.reason,
      conflict_with_lock_id: overrides.conflict_with_lock_id,
      acquired_at: status === "acquired" ? now.toISOString() : undefined,
      expires_at: status === "acquired" ? new Date(now.getTime() + (request.ttl_ms ?? this.ttlMs)).toISOString() : undefined,
      heartbeat_at: status === "acquired" ? now.toISOString() : undefined,
      metadata_json: {
        ...scope.metadata_json,
        request_id: request.request_id,
        request_reason: request.reason,
        confidence: scope.confidence,
        ...(request.metadata_json ?? {})
      }
    };
  }

  private async writeLockArtifact(runId: string, kind: string, id: string, value: unknown) {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const directory = path.join(memory.runsDir, runId || "unknown_run", "locks");
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${kind}_${safeId(id)}.json`);
    await writeJson(filePath, value);
    return filePath;
  }
}

export function durableLocksConflict(requested: FactoryLockScope, existing: FactoryLock) {
  if (!lockModeBlocks(requested.mode, existing.lock_mode)) return false;
  if (requested.type === "advisory" || existing.lock_type === "advisory") return false;
  if (requested.type === "file" || requested.type === "directory") {
    if (existing.lock_type !== "file" && existing.lock_type !== "directory") return false;
    return pathScopesConflict(requested.normalized_scope_key, existing.normalized_scope_key);
  }
  return requested.type === existing.lock_type && requested.normalized_scope_key === existing.normalized_scope_key;
}

export function normalizePathScope(workspacePath: string, scope: string): { path: string; kind: "file" | "directory" } {
  const raw = scope.trim().replace(/\\/g, "/");
  if (!raw || raw === "." || raw === "*") return { path: ".", kind: "directory" };
  const isDirectory = raw.endsWith("/");
  const workspace = path.resolve(workspacePath);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const relative = path.relative(workspace, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Lock path is outside workspace: ${scope}`);
  }
  return {
    path: relative.replace(/\\/g, "/"),
    kind: isDirectory ? "directory" : "file"
  };
}

function pathScopesConflict(leftKey: string, rightKey: string) {
  const left = parsePathKey(leftKey);
  const right = parsePathKey(rightKey);
  if (left.path === "." || right.path === ".") return true;
  if (left.path === right.path) return true;
  if (left.kind === "directory" && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === "directory" && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function parsePathKey(key: string) {
  const index = key.indexOf(":");
  const kind = key.slice(0, index) === "directory" ? "directory" as const : "file" as const;
  const filePath = key.slice(index + 1);
  return { kind, path: filePath };
}

function keyScope(type: FactoryLockType, mode: FactoryLockMode, key: string, reason: string): FactoryLockScope {
  return {
    type,
    mode,
    scope: key,
    normalized_scope_key: key,
    confidence: "high",
    reason
  };
}

function traceMetadataFromRequest(request: LockAcquisitionRequest, extra: Record<string, unknown> = {}) {
  return {
    lock_request_id: request.request_id,
    run_id: request.run_id,
    task_id: request.task_id,
    agent_id: request.agent_id,
    work_item_id: request.work_item_id,
    owner_component: request.owner_component,
    requested_scope_count: request.scopes.length,
    normalized_scope_keys: request.scopes.map((scope) => scope.normalized_scope_key),
    lock_modes: [...new Set(request.scopes.map((scope) => scope.mode))],
    lock_types: [...new Set(request.scopes.map((scope) => scope.type))],
    expires_at: request.ttl_ms ? new Date(Date.now() + request.ttl_ms).toISOString() : undefined,
    reason: request.reason,
    ...extra
  };
}

function traceMetadataFromScope(request: LockAcquisitionRequest, scope: FactoryLockScope) {
  return {
    ...traceMetadataFromRequest(request),
    lock_type: scope.type,
    lock_mode: scope.mode,
    normalized_scope_key: scope.normalized_scope_key,
    reason: scope.reason,
    confidence: scope.confidence
  };
}

function safeId(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 160);
}
