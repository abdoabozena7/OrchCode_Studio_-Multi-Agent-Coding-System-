import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type SqliteStatement = {
  run(...params: unknown[]): { changes?: number | bigint };
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

export type OrchestratorSnapshot = {
  session_id: string;
  snapshot_id: string;
  snapshot_type: "suspend" | "checkpoint" | "hydrate";
  orchestrator_name: string;
  phase: string;
  state_json: string;
  context_json: string;
  pending_job_ids: string[];
  dependent_snapshot_ids: string[];
  created_at: string;
  expires_at: string | null;
};

export type SuspendHydrateConfig = {
  snapshot_ttl_ms: number;
  auto_cleanup_threshold: number;
  max_snapshot_size_bytes: number;
};

export const DEFAULT_SUSPEND_HYDRATE_CONFIG: SuspendHydrateConfig = {
  snapshot_ttl_ms: 24 * 60 * 60 * 1000,
  auto_cleanup_threshold: 1000,
  max_snapshot_size_bytes: 10 * 1024 * 1024
};

export class SuspendHydrateManager {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;
  private readonly config: SuspendHydrateConfig;

  constructor(memoryDir: string, config?: Partial<SuspendHydrateConfig>) {
    const resolvedDir = path.resolve(memoryDir);
    if (!existsSync(resolvedDir)) {
      throw new Error(`Memory directory does not exist: ${resolvedDir}`);
    }
    this.config = { ...DEFAULT_SUSPEND_HYDRATE_CONFIG, ...config };
    this.dbPath = path.join(resolvedDir, "orchestrator_snapshots.sqlite");
    this.db = this.openDatabase();
    this.initializeSchema();
  }

  private openDatabase(): SqliteDatabase {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as SqliteModule;
    const db = new sqlite.DatabaseSync(this.dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 10000");
    return db;
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrator_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        snapshot_type TEXT NOT NULL,
        orchestrator_name TEXT NOT NULL,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        pending_job_ids TEXT NOT NULL DEFAULT '[]',
        dependent_snapshot_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        snapshot_size_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_session
        ON orchestrator_snapshots(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snapshots_expires
        ON orchestrator_snapshots(expires_at);
    `);
  }

  async suspend(input: {
    sessionId: string;
    orchestratorName: string;
    phase: string;
    state: unknown;
    context: unknown;
    pendingJobIds: string[];
    dependentSnapshotIds?: string[];
    ttlMs?: number;
  }): Promise<string> {
    const snapshotId = `snapshot_${randomUUID()}`;
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(input.state);
    const contextJson = JSON.stringify(input.context);
    const ttl = input.ttlMs ?? this.config.snapshot_ttl_ms;
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const snapshotSize = stateJson.length + contextJson.length;

    if (snapshotSize > this.config.max_snapshot_size_bytes) {
      throw new Error(
        `Snapshot size ${snapshotSize} exceeds max ${this.config.max_snapshot_size_bytes} bytes`
      );
    }

    this.db.prepare(`
      INSERT INTO orchestrator_snapshots
        (id, session_id, snapshot_type, orchestrator_name, phase,
         state_json, context_json, pending_job_ids, dependent_snapshot_ids,
         created_at, expires_at, snapshot_size_bytes)
      VALUES (?, ?, 'suspend', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      input.sessionId,
      input.orchestratorName,
      input.phase,
      stateJson,
      contextJson,
      JSON.stringify(input.pendingJobIds),
      JSON.stringify(input.dependentSnapshotIds ?? []),
      now,
      expiresAt,
      snapshotSize
    );

    return snapshotId;
  }

  async hydrate(snapshotId: string): Promise<OrchestratorSnapshot> {
    const row = this.db.prepare(`
      SELECT * FROM orchestrator_snapshots WHERE id = ?
    `).get(snapshotId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    return this.rowToSnapshot(row);
  }

  async hydrateLatest(sessionId: string, orchestratorName: string): Promise<OrchestratorSnapshot | null> {
    const row = this.db.prepare(`
      SELECT * FROM orchestrator_snapshots
      WHERE session_id = ? AND orchestrator_name = ? AND snapshot_type = 'suspend'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(sessionId, orchestratorName) as Record<string, unknown> | undefined;

    return row ? this.rowToSnapshot(row) : null;
  }

  async markHydrated(snapshotId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE orchestrator_snapshots
      SET snapshot_type = 'hydrate', expires_at = ?
      WHERE id = ?
    `).run(now, snapshotId);
  }

  async saveCheckpoint(input: {
    sessionId: string;
    orchestratorName: string;
    phase: string;
    state: unknown;
    context: unknown;
    pendingJobIds: string[];
  }): Promise<string> {
    const snapshotId = `checkpoint_${randomUUID()}`;
    const now = new Date().toISOString();
    const stateJson = JSON.stringify(input.state);
    const contextJson = JSON.stringify(input.context);

    this.db.prepare(`
      INSERT INTO orchestrator_snapshots
        (id, session_id, snapshot_type, orchestrator_name, phase,
         state_json, context_json, pending_job_ids, dependent_snapshot_ids,
         created_at, expires_at, snapshot_size_bytes)
      VALUES (?, ?, 'checkpoint', ?, ?, ?, ?, ?, '[]', ?, NULL, ?)
    `).run(
      snapshotId,
      input.sessionId,
      input.orchestratorName,
      input.phase,
      stateJson,
      contextJson,
      JSON.stringify(input.pendingJobIds),
      now,
      stateJson.length + contextJson.length
    );

    return snapshotId;
  }

  async listSnapshots(sessionId: string): Promise<OrchestratorSnapshot[]> {
    const rows = this.db.prepare(`
      SELECT * FROM orchestrator_snapshots
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToSnapshot(row));
  }

  async cleanupExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      DELETE FROM orchestrator_snapshots
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `).run(now);
    return Number(result.changes ?? 0);
  }

  private rowToSnapshot(row: Record<string, unknown>): OrchestratorSnapshot {
    return {
      session_id: row.session_id as string,
      snapshot_id: row.id as string,
      snapshot_type: row.snapshot_type as OrchestratorSnapshot["snapshot_type"],
      orchestrator_name: row.orchestrator_name as string,
      phase: row.phase as string,
      state_json: row.state_json as string,
      context_json: row.context_json as string,
      pending_job_ids: JSON.parse(row.pending_job_ids as string),
      dependent_snapshot_ids: JSON.parse(row.dependent_snapshot_ids as string),
      created_at: row.created_at as string,
      expires_at: row.expires_at as string | null
    };
  }

  close() {
    this.db.close();
  }
}

export type OrchestratorContext<TState, TContext> = {
  snapshotId: string;
  state: TState;
  context: TContext;
  pendingJobIds: string[];
};

export async function suspendOrchestrator<TState, TContext>(
  manager: SuspendHydrateManager,
  input: {
    sessionId: string;
    orchestratorName: string;
    phase: string;
    state: TState;
    context: TContext;
    pendingJobIds: string[];
    dependentSnapshotIds?: string[];
  }
): Promise<string> {
  return manager.suspend({
    ...input,
    state: input.state,
    context: input.context
  });
}

export async function resumeOrchestrator<TState, TContext>(
  manager: SuspendHydrateManager,
  snapshotId: string
): Promise<OrchestratorContext<TState, TContext>> {
  const snapshot = await manager.hydrate(snapshotId);
  await manager.markHydrated(snapshotId);
  return {
    snapshotId: snapshot.snapshot_id,
    state: JSON.parse(snapshot.state_json) as TState,
    context: JSON.parse(snapshot.context_json) as TContext,
    pendingJobIds: snapshot.pending_job_ids
  };
}
