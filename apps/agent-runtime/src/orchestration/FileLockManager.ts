import path from "node:path";

export type LockScopeKind = "workspace" | "directory" | "file";

export type FileLockRecord = {
  path: string;
  kind: LockScopeKind;
  owner_task_id: string;
  run_id: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
};

export type LockAcquireResult = {
  acquired: boolean;
  locks: FileLockRecord[];
  conflicts: FileLockRecord[];
  requested_paths: string[];
};

export class OrchestrationFileLockManager {
  private readonly locks = new Map<string, FileLockRecord>();

  constructor(
    private readonly workspacePath: string,
    private readonly ttlMs = 5 * 60 * 1000
  ) {}

  acquire(runId: string, taskId: string, requestedScopes: string[], now = new Date()): LockAcquireResult {
    this.releaseExpired(now);
    const normalizedScopes = normalizeLockScopes(this.workspacePath, requestedScopes);
    const conflicts = this.findConflicts(normalizedScopes);
    if (conflicts.length) {
      return { acquired: false, locks: [], conflicts, requested_paths: normalizedScopes.map((scope) => scope.path) };
    }
    const acquired = normalizedScopes.map((scope) => {
      const record: FileLockRecord = {
        path: scope.path,
        kind: scope.kind,
        owner_task_id: taskId,
        run_id: runId,
        acquired_at: now.toISOString(),
        heartbeat_at: now.toISOString(),
        expires_at: new Date(now.getTime() + this.ttlMs).toISOString()
      };
      this.locks.set(lockKey(record), record);
      return record;
    });
    return { acquired: true, locks: acquired, conflicts: [], requested_paths: normalizedScopes.map((scope) => scope.path) };
  }

  releaseByTask(taskId: string) {
    const released: FileLockRecord[] = [];
    for (const [key, lock] of this.locks) {
      if (lock.owner_task_id !== taskId) continue;
      released.push(lock);
      this.locks.delete(key);
    }
    return released;
  }

  heartbeat(taskId: string, now = new Date()) {
    for (const lock of this.locks.values()) {
      if (lock.owner_task_id !== taskId) continue;
      lock.heartbeat_at = now.toISOString();
      lock.expires_at = new Date(now.getTime() + this.ttlMs).toISOString();
    }
  }

  snapshot() {
    return [...this.locks.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  canAcquire(requestedScopes: string[]) {
    const normalizedScopes = normalizeLockScopes(this.workspacePath, requestedScopes);
    return this.findConflicts(normalizedScopes).length === 0;
  }

  releaseExpired(now = new Date()) {
    const released: FileLockRecord[] = [];
    for (const [key, lock] of this.locks) {
      if (Date.parse(lock.expires_at) > now.getTime()) continue;
      released.push(lock);
      this.locks.delete(key);
    }
    return released;
  }

  private findConflicts(scopes: NormalizedLockScope[]) {
    const conflicts: FileLockRecord[] = [];
    for (const active of this.locks.values()) {
      if (scopes.some((scope) => locksConflict(scope, active))) conflicts.push(active);
    }
    return conflicts;
  }
}

export type SchedulerSelection<T extends { id: string; role_required?: string; allowed_files_to_edit?: string[] }> = {
  selected: T[];
  blocked: Array<{ task: T; conflicts: string[] }>;
};

export function selectSchedulableTasks<T extends { id: string; role_required?: string; allowed_files_to_edit?: string[] }>(
  workspacePath: string,
  tasks: T[],
  lockManager: OrchestrationFileLockManager,
  options: { maxParallelTasks: number; canEditTask?: (task: T) => boolean }
): SchedulerSelection<T> {
  const selected: T[] = [];
  const blocked: Array<{ task: T; conflicts: string[] }> = [];
  const batchLocks: NormalizedLockScope[] = [];
  const canEditTask = options.canEditTask ?? ((task: T) => task.role_required === "ExecutorAgent" || task.role_required === "IntegratorAgent");
  for (const task of tasks) {
    if (selected.length >= options.maxParallelTasks) break;
    const taskCanEdit = canEditTask(task);
    const requestedScopes = taskCanEdit ? task.allowed_files_to_edit ?? ["."] : [];
    const normalized = taskCanEdit ? normalizeLockScopes(workspacePath, requestedScopes.length ? requestedScopes : ["."]) : [];
    const batchConflicts = normalized.filter((scope) => batchLocks.some((active) => locksConflict(scope, active)));
    if (batchConflicts.length || !lockManager.canAcquire(requestedScopes)) {
      blocked.push({ task, conflicts: batchConflicts.map((scope) => scope.path) });
      continue;
    }
    selected.push(task);
    batchLocks.push(...normalized);
  }
  return { selected, blocked };
}

type NormalizedLockScope = {
  path: string;
  kind: LockScopeKind;
};

export function normalizeLockScopes(workspacePath: string, scopes: string[]): NormalizedLockScope[] {
  return scopes.map((scope) => normalizeLockScope(workspacePath, scope));
}

export function normalizeLockScope(workspacePath: string, scope: string): NormalizedLockScope {
  const raw = scope.trim().replace(/\\/g, "/");
  if (!raw || raw === "." || raw === "*") return { path: ".", kind: "workspace" };
  const isDirectory = raw.endsWith("/");
  const workspace = path.resolve(workspacePath);
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace, raw);
  const relative = path.relative(workspace, absolute);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Lock path is outside workspace: ${scope}`);
  }
  const normalized = relative.replace(/\\/g, "/");
  return {
    path: normalized,
    kind: isDirectory ? "directory" : "file"
  };
}

export function locksConflict(left: NormalizedLockScope, right: NormalizedLockScope | FileLockRecord) {
  if (left.path === "." || right.path === ".") return true;
  if (left.path === right.path) return true;
  if (left.kind === "directory" && right.path.startsWith(`${left.path}/`)) return true;
  if (right.kind === "directory" && left.path.startsWith(`${right.path}/`)) return true;
  return false;
}

function lockKey(lock: Pick<FileLockRecord, "run_id" | "owner_task_id" | "path">) {
  return `${lock.run_id}:${lock.owner_task_id}:${lock.path}`;
}
