import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  DequeueResult,
  EnqueueJobInput,
  ITaskQueueBackend,
  QueueJob,
  QueueJobStatus,
  QueueMetrics
} from "./TaskQueueTypes.js";

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

const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

export class SqliteTaskQueueBackend implements ITaskQueueBackend {
  private db: SqliteDatabase;
  private readonly dbPath: string;

  constructor(dbDir: string, dbFilename = "task_queue.sqlite") {
    const resolvedDir = path.resolve(dbDir);
    if (!existsSync(resolvedDir)) {
      throw new Error(`Task queue directory does not exist: ${resolvedDir}`);
    }
    this.dbPath = path.join(resolvedDir, dbFilename);
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
      CREATE TABLE IF NOT EXISTS agent_task_queue (
        id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        job_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 3,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
        lease_id TEXT,
        lease_expires_at TEXT,
        dead_letter_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        scheduled_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_queue_dequeue
        ON agent_task_queue(queue_name, status, priority, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_queue_status
        ON agent_task_queue(status);
    `);
  }

  async enqueue(input: EnqueueJobInput): Promise<string> {
    const id = `job_${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_task_queue (id, queue_name, job_type, payload_json, status, priority, max_attempts, created_at, updated_at, scheduled_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.queue_name,
      input.job_type,
      JSON.stringify(input.payload),
      input.priority ?? 3,
      input.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
      now,
      now,
      input.scheduled_at ?? null
    );
    return id;
  }

  async dequeue(queueName: string, pollTimeoutMs: number): Promise<DequeueResult | null> {
    const leaseId = `lease_${randomUUID()}`;
    const now = new Date().toISOString();
    const leaseExpires = new Date(Date.now() + DEFAULT_LEASE_TTL_MS).toISOString();

    const candidate = this.db.prepare(`
      SELECT id FROM agent_task_queue
      WHERE queue_name = ?
        AND status = 'queued'
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `).get(queueName, now) as { id: string } | undefined;

    if (!candidate) return null;

    this.db.prepare(`
      UPDATE agent_task_queue
      SET status = 'leased',
          lease_id = ?,
          lease_expires_at = ?,
          attempt_count = attempt_count + 1,
          updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(leaseId, leaseExpires, now, candidate.id);

    const updated = this.db.prepare(`
      SELECT * FROM agent_task_queue WHERE id = ?
    `).get(candidate.id) as QueueJob | undefined;

    if (!updated || updated.status !== "leased") return null;

    return { job: updated, lease_id: leaseId };
  }

  async ack(jobId: string, leaseId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE agent_task_queue
      SET status = 'completed',
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          completed_at = ?
      WHERE id = ? AND lease_id = ? AND status IN ('leased', 'running')
    `).run(now, now, jobId, leaseId);
    if (Number(result.changes) === 0) {
      throw new Error(`Cannot ack job ${jobId}: lease mismatch or wrong status`);
    }
  }

  async nack(jobId: string, leaseId: string, reason?: string): Promise<QueueJobStatus> {
    const now = new Date().toISOString();
    const job = this.db.prepare(`SELECT * FROM agent_task_queue WHERE id = ?`).get(jobId) as QueueJob | undefined;
    if (!job || job.lease_id !== leaseId) {
      throw new Error(`Cannot nack job ${jobId}: lease mismatch`);
    }

    if (job.attempt_count >= job.max_attempts) {
      this.db.prepare(`
        UPDATE agent_task_queue
        SET status = 'dead_letter',
            lease_id = NULL,
            lease_expires_at = NULL,
            dead_letter_reason = ?,
            updated_at = ?
        WHERE id = ?
      `).run(reason ?? `Max attempts (${job.max_attempts}) exceeded`, now, jobId);
      return "dead_letter";
    } else {
      this.db.prepare(`
        UPDATE agent_task_queue
        SET status = 'queued',
            lease_id = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, jobId);
      return "queued";
    }
  }

  async deadLetter(jobId: string, leaseId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE agent_task_queue
      SET status = 'dead_letter',
          lease_id = NULL,
          lease_expires_at = NULL,
          dead_letter_reason = ?,
          updated_at = ?
      WHERE id = ? AND lease_id = ? AND status IN ('leased', 'running')
    `).run(reason, now, jobId, leaseId);
    if (Number(result.changes) === 0) {
      throw new Error(`Cannot dead-letter job ${jobId}: lease mismatch or wrong status`);
    }
  }

  async getMetrics(queueName: string): Promise<QueueMetrics> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as count
      FROM agent_task_queue
      WHERE queue_name = ?
      GROUP BY status
    `).all(queueName) as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = row.count;

    return {
      queue_name: queueName,
      queued: counts.queued ?? 0,
      leased: counts.leased ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      dead_letter: counts.dead_letter ?? 0,
      total: rows.reduce((sum, row) => sum + row.count, 0)
    };
  }

  async listDeadLetters(queueName: string): Promise<QueueJob[]> {
    return this.db.prepare(`
      SELECT * FROM agent_task_queue
      WHERE queue_name = ? AND status = 'dead_letter'
      ORDER BY updated_at DESC
      LIMIT 100
    `).all(queueName) as QueueJob[];
  }

  async requeueDeadLetter(jobId: string): Promise<void> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE agent_task_queue
      SET status = 'queued',
          lease_id = NULL,
          lease_expires_at = NULL,
          dead_letter_reason = NULL,
          attempt_count = 0,
          updated_at = ?
      WHERE id = ? AND status = 'dead_letter'
    `).run(now, jobId);
    if (Number(result.changes) === 0) {
      throw new Error(`Cannot requeue job ${jobId}: not found or not dead_letter`);
    }
  }

  async updateStatus(jobId: string, status: QueueJobStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE agent_task_queue SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, now, jobId);
  }

  async expireStaleLeases(): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE agent_task_queue
      SET status = 'queued',
          lease_id = NULL,
          lease_expires_at = NULL,
          updated_at = ?
      WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    `).run(now, now);
    return Number(result.changes ?? 0);
  }

  close() {
    this.db.close();
  }
}
