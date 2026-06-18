import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { memoryCache } from "./MemoryCache.js";
import type {
  CommandInventory,
  FileManifestEntry,
  FileSummaryRecord,
  ProjectGlossary,
  ProjectIntelligence,
  RepoIndex,
  RepoMemorySnapshot,
  SemanticEmbeddingRecord,
  SemanticProjectModel,
  SemanticProjectNode,
  SemanticProjectRelationship,
  SymbolIndex
} from "./types.js";

export const MEMORY_DATABASE_FILENAME = "factory_metadata.sqlite";
export const SQLITE_MEMORY_SCHEMA_VERSION = 2;
const initializedMemoryDatabases = new Set<string>();

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

export type MemoryRecordKind =
  | "decision"
  | "task_history"
  | "lesson"
  | "failed_attempt"
  | "successful_pattern"
  | "architecture_note"
  | "swarm_staffing_lesson"
  | "swarm_tuning_history"
  | "swarm_failure_pattern"
  | "swarm_success_pattern"
  | "swarm_specialist_selection";

export type StructuredEventKind = "orchestration" | "swarm" | "scheduler" | "campaign";

export type MemorySearchResult = {
  id: string;
  kind: string;
  path?: string;
  rank: number;
  payload: unknown;
};

export type MigrationResult = {
  status: "dry-run" | "migrated" | "verified";
  databasePath: string;
  importedFiles: number;
  importedRecords: number;
  importedEvents: number;
  skippedFiles: number;
  errors: string[];
};

type LegacyMemoryBundle = {
  memory: Partial<RepoMemorySnapshot> & { indexState?: unknown; projectGlossary?: ProjectGlossary };
  records: Array<{ kind: MemoryRecordKind; value: Record<string, unknown> }>;
  events: Array<Parameters<SqliteMemoryStore["appendEvent"]>[0]>;
  states: Array<Parameters<SqliteMemoryStore["saveState"]>[0]>;
  sourceHash: string;
};

export function resolveMemoryDatabasePath(workspacePath: string, memoryDir = process.env.HIVO_MEMORY_DIR ?? process.env.ORCHCODE_MEMORY_DIR ?? ".agent_memory") {
  return path.join(path.resolve(workspacePath, memoryDir), MEMORY_DATABASE_FILENAME);
}

export function readMemorySnapshotSync<T>(workspacePath: string, kind: string, memoryDir?: string): T | undefined {
  const databasePath = resolveMemoryDatabasePath(workspacePath, memoryDir);
  if (!existsSync(databasePath)) return undefined;
  let database: SqliteDatabase | undefined;
  try {
    const require = createRequire(import.meta.url);
    const sqlite = require("node:sqlite") as SqliteModule;
    database = normalizeSqliteBindings(new sqlite.DatabaseSync(databasePath, { readOnly: true }));
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database.prepare("SELECT payload_json FROM factory_memory_snapshots WHERE snapshot_kind = ?").get(kind);
    return typeof row?.payload_json === "string" ? JSON.parse(row.payload_json) as T : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

export async function restoreMemoryBackup(input: { workspacePath: string; backupDir: string; memoryDir?: string }) {
  const databasePath = resolveMemoryDatabasePath(input.workspacePath, input.memoryDir);
  const backupRoot = path.resolve(path.dirname(databasePath), "backups");
  const backupDir = path.resolve(input.backupDir);
  if (backupDir !== backupRoot && !backupDir.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error(`Backup must be inside ${backupRoot}`);
  }
  const sourcePath = path.join(backupDir, MEMORY_DATABASE_FILENAME);
  const manifest = JSON.parse(await readFile(path.join(backupDir, "manifest.json"), "utf8")) as { databaseHash?: string };
  const actualHash = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
  if (!manifest.databaseHash || manifest.databaseHash !== actualHash) {
    throw new Error("Backup database hash does not match its manifest.");
  }
  await mkdir(path.dirname(databasePath), { recursive: true });
  await rm(`${databasePath}-wal`, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await cp(sourcePath, databasePath);
  initializedMemoryDatabases.delete(databasePath);
  return { databasePath, backupDir, databaseHash: actualHash };
}

export class SqliteMemoryStore {
  private constructor(
    readonly databasePath: string,
    private readonly database: SqliteDatabase,
    private readonly workspacePath: string,
    private readonly memoryRoot: string
  ) {}

  static async open(input: { workspacePath: string; memoryDir?: string; readOnly?: boolean }) {
    const workspacePath = path.resolve(input.workspacePath);
    const databasePath = resolveMemoryDatabasePath(workspacePath, input.memoryDir);
    const databaseExisted = existsSync(databasePath);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const sqlite = await import("node:sqlite") as SqliteModule;
    const database = normalizeSqliteBindings(new sqlite.DatabaseSync(databasePath, { readOnly: input.readOnly }));
    const store = new SqliteMemoryStore(databasePath, database, workspacePath, path.dirname(databasePath));
    store.configure(Boolean(input.readOnly));
    if (!input.readOnly && (!databaseExisted || !initializedMemoryDatabases.has(databasePath))) {
      store.initialize();
      initializedMemoryDatabases.add(databasePath);
    }
    return store;
  }

  close() {
    this.database.close();
  }

  status() {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM factory_memory_snapshots) AS snapshots,
        (SELECT COUNT(*) FROM factory_repo_files) AS repo_files,
        (SELECT COUNT(*) FROM factory_repo_symbols) AS repo_symbols,
        (SELECT COUNT(*) FROM factory_memory_records) AS memory_records,
        (SELECT COUNT(*) FROM factory_event_stream) AS events
    `).get() ?? {};
    return {
      databasePath: this.databasePath,
      schemaVersion: SQLITE_MEMORY_SCHEMA_VERSION,
      storageMode: this.meta("storage_mode") ?? "db_first",
      cacheVersion: Number(this.meta("cache_version") ?? "0"),
      counts
    };
  }

  saveRepositoryMemory(input: Partial<RepoMemorySnapshot> & { indexState?: unknown; projectGlossary?: ProjectGlossary }) {
    this.transaction(() => {
      if (input.repoIndex) this.upsertSnapshot("repo_index", input.repoIndex, input.repoIndex.generatedAt);
      if (input.fileManifest) this.upsertSnapshot("file_manifest", input.fileManifest);
      if (input.symbolIndex) this.upsertSnapshot("symbol_index", input.symbolIndex, input.symbolIndex.generatedAt);
      if (input.fileSummaries) this.upsertSnapshot("file_summaries", input.fileSummaries);
      if (input.commandInventory) this.upsertSnapshot("command_inventory", input.commandInventory, input.commandInventory.generatedAt);
      if (input.projectIntelligence) this.upsertSnapshot("project_intelligence", input.projectIntelligence, input.projectIntelligence.generatedAt);
      if (input.semanticProjectModel) {
        this.upsertSnapshot("semantic_project_model", input.semanticProjectModel, input.semanticProjectModel.generatedAt);
        this.replaceSemanticProjectModel(input.semanticProjectModel);
      }
      if (input.indexState) this.upsertSnapshot("index_state", input.indexState);
      if (input.projectGlossary) this.upsertSnapshot("project_glossary", input.projectGlossary, input.projectGlossary.updatedAt);
      if (input.fileManifest || input.fileSummaries) {
        this.replaceRepoFiles(input.fileManifest ?? this.snapshot<FileManifestEntry[]>("file_manifest") ?? [], input.fileSummaries ?? this.snapshot<FileSummaryRecord[]>("file_summaries") ?? []);
      }
      if (input.symbolIndex) this.replaceRepoSymbols(input.symbolIndex);
      this.bumpCacheVersion();
    });
  }

  snapshot<T>(kind: string): T | undefined {
    const row = this.database.prepare("SELECT payload_json FROM factory_memory_snapshots WHERE snapshot_kind = ?").get(kind);
    return typeof row?.payload_json === "string" ? JSON.parse(row.payload_json) as T : undefined;
  }

  appendRecord(kind: MemoryRecordKind, record: { id: string; createdAt?: string; created_at?: string; summary?: string; [key: string]: unknown }) {
    this.transaction(() => {
      this.upsertRecord(kind, record);
      this.bumpCacheVersion();
    });
  }

  records<T>(kind: MemoryRecordKind): T[] {
    return this.database.prepare(
      "SELECT payload_json FROM factory_memory_records WHERE record_kind = ? ORDER BY created_at, id"
    ).all(kind).map((row) => JSON.parse(String(row.payload_json)) as T);
  }

  appendEvent(input: {
    kind: StructuredEventKind;
    streamId: string;
    id: string;
    type: string;
    createdAt: string;
    payload: unknown;
    artifactRef?: string;
  }) {
    return this.transaction(() => {
      return this.insertEvent(input);
    });
  }

  events<T>(kind: StructuredEventKind, streamId: string): T[] {
    return this.database.prepare(
      "SELECT payload_json FROM factory_event_stream WHERE stream_kind = ? AND stream_id = ? ORDER BY sequence"
    ).all(kind, streamId).map((row) => JSON.parse(String(row.payload_json)) as T);
  }

  saveState(input: {
    kind: string;
    id: string;
    parentId?: string;
    status?: string;
    updatedAt?: string;
    state: unknown;
    artifactRef?: string;
  }) {
    this.transaction(() => {
      this.upsertState(input);
    });
  }

  importLegacyBundle(input: LegacyMemoryBundle) {
    this.transaction(() => {
      const memory = input.memory;
      if (memory.repoIndex) this.upsertSnapshot("repo_index", memory.repoIndex, memory.repoIndex.generatedAt);
      if (memory.fileManifest) this.upsertSnapshot("file_manifest", memory.fileManifest);
      if (memory.symbolIndex) this.upsertSnapshot("symbol_index", memory.symbolIndex, memory.symbolIndex.generatedAt);
      if (memory.fileSummaries) this.upsertSnapshot("file_summaries", memory.fileSummaries);
      if (memory.commandInventory) this.upsertSnapshot("command_inventory", memory.commandInventory, memory.commandInventory.generatedAt);
      if (memory.projectIntelligence) this.upsertSnapshot("project_intelligence", memory.projectIntelligence, memory.projectIntelligence.generatedAt);
      if (memory.indexState) this.upsertSnapshot("index_state", memory.indexState);
      if (memory.projectGlossary) this.upsertSnapshot("project_glossary", memory.projectGlossary, memory.projectGlossary.updatedAt);
      if (memory.fileManifest || memory.fileSummaries) {
        this.replaceRepoFiles(memory.fileManifest ?? [], memory.fileSummaries ?? []);
      }
      if (memory.symbolIndex) this.replaceRepoSymbols(memory.symbolIndex);
      for (const record of input.records) {
        const id = String(record.value.id ?? `${record.kind}_${hash(record.value).slice(0, 24)}`);
        this.upsertRecord(record.kind, { id, ...record.value });
      }
      for (const event of input.events) this.insertEvent(event);
      for (const state of input.states) this.upsertState(state);
      this.database.prepare(`
        INSERT INTO factory_memory_imports(id, source_path, source_hash, imported_at, record_count, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET imported_at = excluded.imported_at, record_count = excluded.record_count, status = excluded.status
      `).run(`legacy_${input.sourceHash.slice(0, 24)}`, this.memoryRoot, input.sourceHash, new Date().toISOString(), input.records.length + input.events.length + input.states.length, "imported", json({}));
      this.setMeta("storage_mode", "migration_pending_verification");
      this.setMeta("legacy_migration_hash", input.sourceHash);
      this.bumpCacheVersion();
    });
  }

  verifyLegacyBundle(input: LegacyMemoryBundle) {
    const expectedSnapshots: Array<[string, unknown]> = [
      ["repo_index", input.memory.repoIndex],
      ["file_manifest", input.memory.fileManifest],
      ["symbol_index", input.memory.symbolIndex],
      ["file_summaries", input.memory.fileSummaries],
      ["command_inventory", input.memory.commandInventory],
      ["project_intelligence", input.memory.projectIntelligence],
      ["index_state", input.memory.indexState],
      ["project_glossary", input.memory.projectGlossary]
    ].filter((entry): entry is [string, unknown] => entry[1] !== undefined);
    const mismatches: string[] = [];
    for (const [kind, value] of expectedSnapshots) {
      const row = this.database.prepare("SELECT content_hash FROM factory_memory_snapshots WHERE snapshot_kind = ?").get(kind);
      if (row?.content_hash !== hash(value)) mismatches.push(`snapshot:${kind}`);
    }
    for (const record of input.records) {
      const id = String(record.value.id ?? `${record.kind}_${hash(record.value).slice(0, 24)}`);
      const row = this.database.prepare("SELECT content_hash FROM factory_memory_records WHERE id = ?").get(id);
      if (row?.content_hash !== hash({ id, ...record.value })) mismatches.push(`record:${id}`);
    }
    for (const event of input.events) {
      const row = this.database.prepare("SELECT content_hash FROM factory_event_stream WHERE id = ?").get(event.id);
      if (row?.content_hash !== hash(event.payload)) mismatches.push(`event:${event.id}`);
    }
    for (const state of input.states) {
      const row = this.database.prepare(
        "SELECT content_hash FROM factory_state_objects WHERE object_kind = ? AND object_id = ?"
      ).get(state.kind, state.id);
      if (row?.content_hash !== hash(state.state)) mismatches.push(`state:${state.kind}:${state.id}`);
    }
    if (mismatches.length) throw new Error(`Legacy migration verification failed: ${mismatches.slice(0, 12).join(", ")}`);
    this.transaction(() => {
      this.database.prepare("UPDATE factory_memory_imports SET status = ?, imported_at = ? WHERE id = ?")
        .run("verified", new Date().toISOString(), `legacy_${input.sourceHash.slice(0, 24)}`);
      this.setMeta("storage_mode", "db_first");
      this.setMeta("legacy_migration_hash", input.sourceHash);
      this.bumpCacheVersion();
    });
  }

  state<T>(kind: string, id: string): T | undefined {
    const row = this.database.prepare(
      "SELECT state_json FROM factory_state_objects WHERE object_kind = ? AND object_id = ?"
    ).get(kind, id);
    return typeof row?.state_json === "string" ? JSON.parse(row.state_json) as T : undefined;
  }

  states<T>(kind: string, parentId?: string): T[] {
    const rows = parentId === undefined
      ? this.database.prepare("SELECT state_json FROM factory_state_objects WHERE object_kind = ? ORDER BY updated_at DESC, object_id").all(kind)
      : this.database.prepare("SELECT state_json FROM factory_state_objects WHERE object_kind = ? AND parent_id = ? ORDER BY updated_at, object_id").all(kind, parentId);
    return rows.map((row) => JSON.parse(String(row.state_json)) as T);
  }

  search(query: string, options: { kinds?: string[]; limit?: number } = {}): MemorySearchResult[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const kinds = options.kinds?.filter(Boolean) ?? [];
    const kindSql = kinds.length ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
    return this.database.prepare(`
      SELECT id, kind, path, bm25(factory_memory_fts) AS rank, payload_json
      FROM factory_memory_fts
      WHERE factory_memory_fts MATCH ? ${kindSql}
      ORDER BY rank, id
      LIMIT ?
    `).all(match, ...kinds, options.limit ?? 20).map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      path: typeof row.path === "string" && row.path ? row.path : undefined,
      rank: Number(row.rank),
      payload: JSON.parse(String(row.payload_json))
    }));
  }

  relevantFiles(query: string, limit = 12): FileSummaryRecord[] {
    return this.search(query, { kinds: ["file_summary", "repo_symbol"], limit: Math.max(limit * 3, 20) })
      .map((result) => result.kind === "file_summary" ? result.payload as FileSummaryRecord : this.fileSummary(result.path))
      .filter((value): value is FileSummaryRecord => Boolean(value))
      .filter((value, index, values) => values.findIndex((candidate) => candidate.path === value.path) === index)
      .slice(0, limit);
  }

  semanticProjectModel(): SemanticProjectModel | undefined {
    return this.snapshot<SemanticProjectModel>("semantic_project_model");
  }

  saveSemanticEmbeddings(records: SemanticEmbeddingRecord[]) {
    this.transaction(() => {
      const statement = this.database.prepare(`
        INSERT INTO factory_semantic_embeddings(node_id, model, dimensions, vector_json, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, model) DO UPDATE SET
          dimensions = excluded.dimensions,
          vector_json = excluded.vector_json,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `);
      for (const record of records) {
        statement.run(record.nodeId, record.model, record.dimensions, json(record.vector), record.contentHash, record.updatedAt);
      }
      this.bumpCacheVersion();
    });
  }

  semanticEmbeddings(model: string): SemanticEmbeddingRecord[] {
    return this.database.prepare(`
      SELECT e.node_id, e.model, e.dimensions, e.vector_json, e.content_hash, e.updated_at
      FROM factory_semantic_embeddings e
      JOIN factory_semantic_nodes n ON n.id = e.node_id AND n.content_hash = e.content_hash
      WHERE e.model = ? AND n.freshness = 'current'
      ORDER BY e.node_id
    `).all(model).map((row) => ({
      nodeId: String(row.node_id),
      model: String(row.model),
      dimensions: Number(row.dimensions),
      vector: JSON.parse(String(row.vector_json)) as number[],
      contentHash: String(row.content_hash),
      updatedAt: String(row.updated_at)
    }));
  }

  semanticSearch(vector: number[], model: string, limit = 12): Array<{ node: SemanticProjectNode; score: number }> {
    const nodes = new Map(this.semanticNodes().map((node) => [node.id, node]));
    return this.semanticEmbeddings(model)
      .map((embedding) => ({ node: nodes.get(embedding.nodeId), score: cosineSimilarity(vector, embedding.vector) }))
      .filter((entry): entry is { node: SemanticProjectNode; score: number } => Boolean(entry.node))
      .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
      .slice(0, limit);
  }

  semanticNodes(ids?: string[]): SemanticProjectNode[] {
    const where = ids?.length ? `WHERE id IN (${ids.map(() => "?").join(", ")})` : "";
    return this.database.prepare(`SELECT payload_json FROM factory_semantic_nodes ${where} ORDER BY id`)
      .all(...(ids ?? []))
      .map((row) => JSON.parse(String(row.payload_json)) as SemanticProjectNode);
  }

  semanticRelationships(nodeIds?: string[]): SemanticProjectRelationship[] {
    const where = nodeIds?.length
      ? `WHERE from_node_id IN (${nodeIds.map(() => "?").join(", ")}) OR to_node_id IN (${nodeIds.map(() => "?").join(", ")})`
      : "";
    return this.database.prepare(`SELECT payload_json FROM factory_semantic_relationships ${where} ORDER BY id`)
      .all(...(nodeIds ?? []), ...(nodeIds ?? []))
      .map((row) => JSON.parse(String(row.payload_json)) as SemanticProjectRelationship);
  }

  setMeta(key: string, value: string) {
    this.database.prepare(`
      INSERT INTO factory_memory_meta(key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }

  async cachedSnapshot<T>(kind: string, ttlSeconds = 60): Promise<T | undefined> {
    const version = this.meta("cache_version") ?? "0";
    const key = `hivo:memory:${this.workspacePath}:${version}:snapshot:${kind}`;
    const cached = await memoryCache.get(key);
    if (cached) return JSON.parse(cached) as T;
    const value = this.snapshot<T>(kind);
    if (value !== undefined) await memoryCache.set(key, json(value), ttlSeconds);
    return value;
  }

  async exportBackup() {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const backupDir = path.join(this.memoryRoot, "backups", timestamp);
    await mkdir(backupDir, { recursive: true });
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    const databaseTarget = path.join(backupDir, MEMORY_DATABASE_FILENAME);
    await cp(this.databasePath, databaseTarget);
    const manifest = {
      id: `backup_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      databasePath: databaseTarget,
      databaseHash: createHash("sha256").update(await readFile(databaseTarget)).digest("hex"),
      status: this.status()
    };
    await writeFile(path.join(backupDir, "manifest.json"), `${json(manifest, true)}\n`, "utf8");
    this.database.prepare(`
      INSERT INTO factory_backup_exports(id, created_at, backup_path, manifest_json, content_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(manifest.id, manifest.createdAt, backupDir, json(manifest), manifest.databaseHash);
    return { backupDir, manifest };
  }

  private configure(readOnly: boolean) {
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (!readOnly) {
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA synchronous = FULL");
    }
  }

  private initialize() {
    this.database.exec(MEMORY_SCHEMA_SQL);
    this.setMeta("memory_schema_version", String(SQLITE_MEMORY_SCHEMA_VERSION));
    if (!this.meta("storage_mode")) this.setMeta("storage_mode", "db_first");
    if (!this.meta("cache_version")) this.setMeta("cache_version", "0");
  }

  private transaction<T>(operation: () => T): T {
    let attempt = 0;
    while (true) {
      try {
        this.database.exec("BEGIN IMMEDIATE");
        const result = operation();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Ignore rollback errors when BEGIN itself failed.
        }
        if (!isBusy(error) || attempt >= 4) throw error;
        sleepSync(20 * (2 ** attempt));
        attempt += 1;
      }
    }
  }

  private upsertSnapshot(kind: string, value: unknown, generatedAt?: string) {
    this.database.prepare(`
      INSERT INTO factory_memory_snapshots(snapshot_kind, schema_version, generated_at, updated_at, payload_json, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_kind) DO UPDATE SET
        schema_version = excluded.schema_version,
        generated_at = excluded.generated_at,
        updated_at = excluded.updated_at,
        payload_json = excluded.payload_json,
        content_hash = excluded.content_hash
    `).run(kind, SQLITE_MEMORY_SCHEMA_VERSION, generatedAt, new Date().toISOString(), json(value), hash(value));
  }

  private upsertRecord(kind: MemoryRecordKind, record: { id: string; createdAt?: string; created_at?: string; summary?: string; [key: string]: unknown }) {
    const createdAt = record.createdAt ?? record.created_at ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO factory_memory_records(id, record_kind, created_at, summary, payload_json, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        record_kind = excluded.record_kind,
        created_at = excluded.created_at,
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        content_hash = excluded.content_hash
    `).run(record.id, kind, createdAt, record.summary, json(record), hash(record));
    this.replaceFts(record.id, `memory_${kind}`, undefined, searchableRecordText(record), record);
  }

  private insertEvent(input: {
    kind: StructuredEventKind;
    streamId: string;
    id: string;
    type: string;
    createdAt: string;
    payload: unknown;
    artifactRef?: string;
  }) {
    const existing = this.database.prepare("SELECT sequence FROM factory_event_stream WHERE id = ?").get(input.id);
    if (existing) return Number(existing.sequence);
    const next = this.database.prepare(
      "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM factory_event_stream WHERE stream_kind = ? AND stream_id = ?"
    ).get(input.kind, input.streamId);
    const sequence = Number(next?.next_sequence ?? 1);
    this.database.prepare(`
      INSERT INTO factory_event_stream(
        id, stream_kind, stream_id, sequence, event_type, created_at,
        payload_json, artifact_ref, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.kind, input.streamId, sequence, input.type, input.createdAt, json(input.payload), input.artifactRef, hash(input.payload));
    return sequence;
  }

  private upsertState(input: {
    kind: string;
    id: string;
    parentId?: string;
    status?: string;
    updatedAt?: string;
    state: unknown;
    artifactRef?: string;
  }) {
    this.database.prepare(`
      INSERT INTO factory_state_objects(object_kind, object_id, parent_id, status, updated_at, state_json, artifact_ref, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(object_kind, object_id) DO UPDATE SET
        parent_id = excluded.parent_id,
        status = excluded.status,
        updated_at = excluded.updated_at,
        state_json = excluded.state_json,
        artifact_ref = excluded.artifact_ref,
        content_hash = excluded.content_hash
    `).run(input.kind, input.id, input.parentId, input.status, input.updatedAt ?? new Date().toISOString(), json(input.state), input.artifactRef, hash(input.state));
  }

  private replaceRepoFiles(manifest: FileManifestEntry[], summaries: FileSummaryRecord[]) {
    const summaryByPath = new Map(summaries.map((summary) => [summary.path, summary]));
    const existing = new Map(this.database.prepare("SELECT path, manifest_json, summary_json FROM factory_repo_files").all()
      .map((row) => [String(row.path), { manifest: String(row.manifest_json), summary: typeof row.summary_json === "string" ? row.summary_json : undefined }]));
    const paths = new Set(manifest.map((file) => file.path));
    for (const filePath of existing.keys()) {
      if (paths.has(filePath)) continue;
      this.database.prepare("DELETE FROM factory_repo_files WHERE path = ?").run(filePath);
      this.deleteFts(`file:${filePath}`, "file_summary");
    }
    const insert = this.database.prepare(`
      INSERT INTO factory_repo_files(path, language, size_bytes, mtime_ms, hash_sha256, roles_json, manifest_json, summary_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        language = excluded.language, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms,
        hash_sha256 = excluded.hash_sha256, roles_json = excluded.roles_json,
        manifest_json = excluded.manifest_json, summary_json = excluded.summary_json
    `);
    for (const file of manifest) {
      const summary = summaryByPath.get(file.path);
      const manifestJson = json(file);
      const summaryJson = summary ? json(summary) : undefined;
      const previous = existing.get(file.path);
      if (previous?.manifest === manifestJson && previous.summary === summaryJson) continue;
      insert.run(file.path, file.language, file.sizeBytes, file.mtimeMs, file.hashSha256, json(file.roles), manifestJson, summaryJson);
      if (summary) this.replaceFts(`file:${file.path}`, "file_summary", file.path, searchableFileText(summary), summary);
      else this.deleteFts(`file:${file.path}`, "file_summary");
    }
  }

  private replaceRepoSymbols(index: SymbolIndex) {
    const existing = new Map(this.database.prepare("SELECT id, payload_json FROM factory_repo_symbols").all()
      .map((row) => [String(row.id), String(row.payload_json)]));
    const ids = new Set(index.symbols.map((symbol) => `symbol:${symbol.path}:${symbol.line}:${symbol.kind}:${symbol.name}`));
    for (const id of existing.keys()) {
      if (ids.has(id)) continue;
      this.database.prepare("DELETE FROM factory_repo_symbols WHERE id = ?").run(id);
      this.deleteFts(id, "repo_symbol");
    }
    const insert = this.database.prepare(`
      INSERT INTO factory_repo_symbols(id, name, symbol_kind, path, line, exported, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, symbol_kind = excluded.symbol_kind, path = excluded.path,
        line = excluded.line, exported = excluded.exported, payload_json = excluded.payload_json
    `);
    for (const symbol of index.symbols) {
      const id = `symbol:${symbol.path}:${symbol.line}:${symbol.kind}:${symbol.name}`;
      const payload = json(symbol);
      if (existing.get(id) === payload) continue;
      insert.run(id, symbol.name, symbol.kind, symbol.path, symbol.line, symbol.exported ? 1 : 0, payload);
      this.replaceFts(id, "repo_symbol", symbol.path, `${symbol.name} ${symbol.kind} ${symbol.path}`, symbol);
    }
  }

  private replaceSemanticProjectModel(model: SemanticProjectModel) {
    const nodeIds = new Set(model.nodes.map((node) => node.id));
    const relationshipIds = new Set(model.relationships.map((relationship) => relationship.id));
    const existingNodes = new Map(this.database.prepare("SELECT id, content_hash FROM factory_semantic_nodes").all()
      .map((row) => [String(row.id), String(row.content_hash)]));
    const existingRelationships = new Map(this.database.prepare("SELECT id, content_hash FROM factory_semantic_relationships").all()
      .map((row) => [String(row.id), String(row.content_hash)]));
    for (const id of existingNodes.keys()) {
      if (nodeIds.has(id)) continue;
      this.database.prepare("DELETE FROM factory_semantic_nodes WHERE id = ?").run(id);
      this.database.prepare("DELETE FROM factory_semantic_embeddings WHERE node_id = ?").run(id);
      this.deleteFts(id, "semantic_node");
    }
    for (const id of existingRelationships.keys()) {
      if (!relationshipIds.has(id)) this.database.prepare("DELETE FROM factory_semantic_relationships WHERE id = ?").run(id);
    }
    const nodeStatement = this.database.prepare(`
      INSERT INTO factory_semantic_nodes(id, node_kind, name, path, line, summary, content_hash, evidence_refs_json, freshness, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_kind = excluded.node_kind, name = excluded.name, path = excluded.path, line = excluded.line,
        summary = excluded.summary, content_hash = excluded.content_hash, evidence_refs_json = excluded.evidence_refs_json,
        freshness = excluded.freshness, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `);
    for (const node of model.nodes) {
      if (existingNodes.get(node.id) === node.contentHash) continue;
      nodeStatement.run(node.id, node.kind, node.name, node.path, node.line, node.summary, node.contentHash, json(node.evidenceRefs), node.freshness, json(node), model.generatedAt);
      this.replaceFts(node.id, "semantic_node", node.path, `${node.name} ${node.summary}`, node);
      this.database.prepare("DELETE FROM factory_semantic_embeddings WHERE node_id = ? AND content_hash <> ?").run(node.id, node.contentHash);
    }
    const relationshipStatement = this.database.prepare(`
      INSERT INTO factory_semantic_relationships(id, from_node_id, to_node_id, relationship_kind, confidence, reason, evidence_refs_json, content_hash, freshness, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        from_node_id = excluded.from_node_id, to_node_id = excluded.to_node_id,
        relationship_kind = excluded.relationship_kind, confidence = excluded.confidence, reason = excluded.reason,
        evidence_refs_json = excluded.evidence_refs_json, content_hash = excluded.content_hash,
        freshness = excluded.freshness, payload_json = excluded.payload_json, updated_at = excluded.updated_at
    `);
    for (const relationship of model.relationships) {
      if (existingRelationships.get(relationship.id) === relationship.contentHash) continue;
      relationshipStatement.run(
        relationship.id, relationship.fromNodeId, relationship.toNodeId, relationship.kind, relationship.confidence,
        relationship.reason, json(relationship.evidenceRefs), relationship.contentHash, relationship.freshness, json(relationship), model.generatedAt
      );
    }
  }

  private replaceFts(id: string, kind: string, itemPath: string | undefined, content: string, payload: unknown) {
    this.deleteFts(id, kind);
    this.database.prepare(
      "INSERT INTO factory_memory_fts(id, kind, path, content, payload_json) VALUES (?, ?, ?, ?, ?)"
    ).run(id, kind, itemPath, content, json(payload));
  }

  private deleteFts(id: string, kind: string) {
    this.database.prepare("DELETE FROM factory_memory_fts WHERE id = ? AND kind = ?").run(id, kind);
  }

  private fileSummary(itemPath?: string) {
    if (!itemPath) return undefined;
    const row = this.database.prepare("SELECT summary_json FROM factory_repo_files WHERE path = ?").get(itemPath);
    return typeof row?.summary_json === "string" ? JSON.parse(row.summary_json) as FileSummaryRecord : undefined;
  }

  private meta(key: string) {
    const row = this.database.prepare("SELECT value FROM factory_memory_meta WHERE key = ?").get(key);
    return typeof row?.value === "string" ? row.value : undefined;
  }

  private bumpCacheVersion() {
    const next = Number(this.meta("cache_version") ?? "0") + 1;
    this.setMeta("cache_version", String(next));
  }
}

export async function migrateLegacyMemory(input: {
  workspacePath: string;
  memoryDir?: string;
  dryRun?: boolean;
  verify?: boolean;
}): Promise<MigrationResult> {
  const root = path.resolve(input.workspacePath, input.memoryDir ?? process.env.HIVO_MEMORY_DIR ?? process.env.ORCHCODE_MEMORY_DIR ?? ".agent_memory");
  const result: MigrationResult = {
    status: input.dryRun ? "dry-run" : input.verify ? "verified" : "migrated",
    databasePath: resolveMemoryDatabasePath(input.workspacePath, input.memoryDir),
    importedFiles: 0,
    importedRecords: 0,
    importedEvents: 0,
    skippedFiles: 0,
    errors: []
  };
  const snapshots: Record<string, unknown> = {};
  for (const [kind, file] of Object.entries(LEGACY_SNAPSHOT_FILES)) {
    const filePath = path.join(root, file);
    if (!existsSync(filePath)) {
      result.skippedFiles += 1;
      continue;
    }
    try {
      snapshots[kind] = JSON.parse(await readFile(filePath, "utf8"));
      result.importedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${message(error)}`);
    }
  }
  const fileSummariesPath = path.join(root, "file_summaries.jsonl");
  if (existsSync(fileSummariesPath)) {
    try {
      snapshots.file_summaries = parseJsonl(await readFile(fileSummariesPath, "utf8"));
      result.importedFiles += 1;
    } catch (error) {
      result.errors.push(`file_summaries.jsonl: ${message(error)}`);
    }
  }
  const records: Array<{ kind: MemoryRecordKind; value: Record<string, unknown> }> = [];
  for (const [kind, file] of Object.entries(LEGACY_RECORD_FILES) as Array<[MemoryRecordKind, string]>) {
    const filePath = path.join(root, file);
    if (!existsSync(filePath)) continue;
    try {
      for (const value of parseJsonl(await readFile(filePath, "utf8"))) records.push({ kind, value: value as Record<string, unknown> });
      result.importedFiles += 1;
    } catch (error) {
      result.errors.push(`${file}: ${message(error)}`);
    }
  }
  const structured = await collectStructuredEvents(root, result);
  const states = await collectStructuredStates(root, result);
  result.importedRecords = records.length + states.length;
  result.importedEvents = structured.length;
  if (result.errors.length || input.dryRun) return result;
  const sourceHash = hash({ snapshots, records, structured, states });
  const bundle: LegacyMemoryBundle = {
    memory: {
      repoIndex: snapshots.repo_index as RepoIndex | undefined,
      fileManifest: snapshots.file_manifest as FileManifestEntry[] | undefined,
      symbolIndex: snapshots.symbol_index as SymbolIndex | undefined,
      fileSummaries: snapshots.file_summaries as FileSummaryRecord[] | undefined,
      commandInventory: snapshots.command_inventory as CommandInventory | undefined,
      projectIntelligence: snapshots.project_intelligence as ProjectIntelligence | undefined,
      indexState: snapshots.index_state,
      projectGlossary: snapshots.project_glossary as ProjectGlossary | undefined
    },
    records,
    events: structured,
    states,
    sourceHash
  };
  const store = await SqliteMemoryStore.open({ workspacePath: input.workspacePath, memoryDir: input.memoryDir });
  try {
    store.importLegacyBundle(bundle);
    if (input.verify) store.verifyLegacyBundle(bundle);
    return result;
  } finally {
    store.close();
  }
}

async function collectStructuredStates(root: string, result: MigrationResult) {
  const states: Array<Parameters<SqliteMemoryStore["saveState"]>[0]> = [];
  for (const [directory, file, kind, nestedKind] of [
    ["runs", "run.json", "orchestration_run", undefined],
    ["runs", "tasks.json", "orchestration_tasks", undefined],
    ["swarm_runs", "swarm_run.json", "swarm_run", undefined],
    ["swarm_runs", "staffing_plan.json", "swarm_staffing_plan", undefined],
    ["swarm_runs", "agent_templates.json", "swarm_agent_templates", undefined],
    ["swarm_runs", "agent_instances.json", "swarm_agent_instances", undefined],
    ["swarm_runs", "work_items.json", "swarm_work_items", undefined],
    ["swarm_runs", "leases.json", "swarm_leases", undefined],
    ["swarm_runs", "metrics.json", "swarm_metrics", undefined],
    ["campaigns", "campaign.json", "campaign", undefined]
  ] as const) {
    const parent = path.join(root, directory);
    if (!existsSync(parent)) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(parent, entry.name, file);
      if (!existsSync(filePath)) continue;
      try {
        const state = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
        states.push({
          kind,
          id: entry.name,
          parentId: nestedKind ? entry.name : undefined,
          status: typeof state.status === "string" ? state.status : undefined,
          updatedAt: typeof state.updated_at === "string" ? state.updated_at : undefined,
          state,
          artifactRef: filePath
        });
        result.importedFiles += 1;
      } catch (error) {
        result.errors.push(`${path.relative(root, filePath)}: ${message(error)}`);
      }
    }
  }
  return states;
}

async function collectStructuredEvents(root: string, result: MigrationResult) {
  const events: Array<Parameters<SqliteMemoryStore["appendEvent"]>[0]> = [];
  for (const [directory, kind, eventFile] of [
    ["runs", "orchestration", "events.jsonl"],
    ["swarm_runs", "swarm", "events.jsonl"],
    ["swarm_runs", "scheduler", "scheduler_trace.jsonl"],
    ["campaigns", "campaign", "events.jsonl"]
  ] as const) {
    const parent = path.join(root, directory);
    if (!existsSync(parent)) continue;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(parent, entry.name, eventFile);
      if (!existsSync(filePath)) continue;
      try {
        const values = parseJsonl(await readFile(filePath, "utf8")) as Array<Record<string, unknown>>;
        for (const value of values) {
          events.push({
            kind,
            streamId: entry.name,
            id: String(value.id ?? `${kind}_${hash(value).slice(0, 24)}`),
            type: String(value.type ?? value.decision ?? kind),
            createdAt: String(value.created_at ?? new Date(0).toISOString()),
            payload: value,
            artifactRef: filePath
          });
        }
        result.importedFiles += 1;
      } catch (error) {
        result.errors.push(`${path.relative(root, filePath)}: ${message(error)}`);
      }
    }
  }
  return events;
}

const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS factory_memory_snapshots (
  snapshot_kind TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  generated_at TEXT,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_repo_files (
  path TEXT PRIMARY KEY,
  language TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  hash_sha256 TEXT,
  roles_json TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  summary_json TEXT
);
CREATE TABLE IF NOT EXISTS factory_repo_symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol_kind TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_semantic_nodes (
  id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  freshness TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_semantic_relationships (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relationship_kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  freshness TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_semantic_embeddings (
  node_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(node_id, model)
);
CREATE TABLE IF NOT EXISTS factory_memory_records (
  id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  summary TEXT,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_event_stream (
  id TEXT PRIMARY KEY,
  stream_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  artifact_ref TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE(stream_kind, stream_id, sequence)
);
CREATE TABLE IF NOT EXISTS factory_state_objects (
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  parent_id TEXT,
  status TEXT,
  updated_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  artifact_ref TEXT,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(object_kind, object_id)
);
CREATE TABLE IF NOT EXISTS factory_memory_imports (
  id TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS factory_backup_exports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS factory_memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS factory_memory_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  path UNINDEXED,
  content,
  payload_json UNINDEXED
);
CREATE INDEX IF NOT EXISTS idx_factory_repo_symbols_name ON factory_repo_symbols(name, symbol_kind);
CREATE INDEX IF NOT EXISTS idx_factory_repo_symbols_path ON factory_repo_symbols(path, line);
CREATE INDEX IF NOT EXISTS idx_factory_semantic_nodes_path ON factory_semantic_nodes(path, node_kind);
CREATE INDEX IF NOT EXISTS idx_factory_semantic_relationships_from ON factory_semantic_relationships(from_node_id, relationship_kind);
CREATE INDEX IF NOT EXISTS idx_factory_semantic_relationships_to ON factory_semantic_relationships(to_node_id, relationship_kind);
CREATE INDEX IF NOT EXISTS idx_factory_memory_records_kind ON factory_memory_records(record_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_event_stream_stream ON factory_event_stream(stream_kind, stream_id, sequence);
CREATE INDEX IF NOT EXISTS idx_factory_event_stream_type ON factory_event_stream(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_state_objects_parent ON factory_state_objects(object_kind, parent_id, updated_at);
`;

const LEGACY_SNAPSHOT_FILES: Record<string, string> = {
  repo_index: "repo_index.json",
  file_manifest: "file_manifest.json",
  symbol_index: "symbol_index.json",
  command_inventory: "command_inventory.json",
  index_state: "index_state.json",
  project_intelligence: "project_intelligence.json",
  project_glossary: "project_glossary.json"
};

const LEGACY_RECORD_FILES: Record<MemoryRecordKind, string> = {
  decision: "decisions.jsonl",
  task_history: "task_history.jsonl",
  lesson: "lessons_learned.jsonl",
  failed_attempt: "failed_attempts.jsonl",
  successful_pattern: "successful_patterns.jsonl",
  architecture_note: "architecture_notes.jsonl",
  swarm_staffing_lesson: "swarm_staffing_lessons.jsonl",
  swarm_tuning_history: "swarm_tuning_history.jsonl",
  swarm_failure_pattern: "swarm_failure_patterns.jsonl",
  swarm_success_pattern: "swarm_success_patterns.jsonl",
  swarm_specialist_selection: "swarm_specialist_selection_history.jsonl"
};

function searchableFileText(summary: FileSummaryRecord) {
  return [
    summary.path,
    summary.language ?? "",
    summary.roleGuess,
    summary.purposeGuess,
    ...summary.roles,
    ...summary.imports,
    ...summary.exports,
    ...summary.symbols.map((symbol) => `${symbol.name} ${symbol.kind}`)
  ].join(" ");
}

function searchableRecordText(record: Record<string, unknown>) {
  return Object.values(record).flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value) => typeof value === "string")
    .join(" ");
}

function ftsQuery(query: string) {
  const terms = query.toLowerCase().split(/[^a-z0-9_./-]+/i).filter((term) => term.length >= 2);
  return terms.length ? terms.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" OR ") : "";
}

function parseJsonl(raw: string): unknown[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

function hash(value: unknown) {
  return createHash("sha256").update(json(value)).digest("hex");
}

function json(value: unknown, pretty = false) {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

function isBusy(error: unknown) {
  return /SQLITE_BUSY|database is locked/i.test(message(error));
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleepSync(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function normalizeSqliteBindings(database: SqliteDatabase): SqliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    close: () => database.close(),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...params) => statement.run(...params.map(normalizeSqliteValue)),
        all: (...params) => statement.all(...params.map(normalizeSqliteValue)),
        get: (...params) => statement.get(...params.map(normalizeSqliteValue))
      };
    }
  };
}

function normalizeSqliteValue(value: unknown) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  if (!length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return dot / ((Math.sqrt(leftNorm) * Math.sqrt(rightNorm)) || 1);
}
