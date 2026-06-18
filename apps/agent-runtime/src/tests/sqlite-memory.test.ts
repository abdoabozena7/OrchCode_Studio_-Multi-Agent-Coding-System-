import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OptionalRedisMemoryCache, ReadThroughMemoryCache, type RedisLikeClient } from "../memory/MemoryCache.js";
import {
  migrateLegacyMemory,
  resolveMemoryDatabasePath,
  restoreMemoryBackup,
  SqliteMemoryStore
} from "../memory/SqliteMemoryStore.js";
import {
  appendDecision,
  getRelevantFiles,
  readMemorySnapshot,
  rebuildRepoIndex,
  resolveMemoryPaths
} from "../memory/index.js";
import { OrchestrationArtifactStore } from "../orchestration/ArtifactStore.js";
import { ORCHESTRATION_SCHEMA_VERSION, type Run } from "../orchestration/OrchestrationModels.js";

test("SQLite memory remains authoritative after legacy index files are removed", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-authority");
  try {
    await rebuildRepoIndex(workspace);
    await appendDecision(workspace, { summary: "SQLite is authoritative." });
    const paths = resolveMemoryPaths(workspace);
    for (const file of [paths.repoIndex, paths.fileManifest, paths.symbolIndex, paths.fileSummaries, paths.commandInventory]) {
      await rm(file, { force: true });
    }

    const repoIndex = await readMemorySnapshot<{ projectName: string }>(workspace, "repo_index");
    const relevant = await getRelevantFiles(workspace, "greet entrypoint");
    assert.equal(repoIndex?.projectName, path.basename(workspace));
    assert.ok(relevant.some((entry) => entry.path === "src/index.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy migration rejects malformed JSONL without partial import", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-rollback");
  try {
    const memory = resolveMemoryPaths(workspace);
    await mkdir(memory.rootDir, { recursive: true });
    await writeFile(memory.repoIndex, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), projectName: "legacy" }), "utf8");
    await writeFile(memory.decisions, "{\"id\":\"decision_ok\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"summary\":\"ok\"}\n{broken\n", "utf8");
    const existing = await SqliteMemoryStore.open({ workspacePath: workspace });
    try {
      existing.appendRecord("decision", { id: "existing", summary: "must survive failed migration" });
    } finally {
      existing.close();
    }

    const result = await migrateLegacyMemory({ workspacePath: workspace });
    assert.ok(result.errors.length > 0);
    const store = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.snapshot("repo_index"), undefined);
      assert.deepEqual(store.records<{ id: string }>("decision").map((record) => record.id), ["existing"]);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy migration is idempotent and imports structured events in order", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-migration");
  try {
    const memory = resolveMemoryPaths(workspace);
    await mkdir(path.join(memory.runsDir, "run_legacy"), { recursive: true });
    await writeFile(memory.decisions, "{\"id\":\"decision_legacy\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"summary\":\"legacy\"}\n", "utf8");
    await writeFile(path.join(memory.runsDir, "run_legacy", "events.jsonl"), [
      JSON.stringify({ id: "event_1", run_id: "run_legacy", type: "run.created", created_at: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ id: "event_2", run_id: "run_legacy", type: "run.completed", created_at: "2026-01-01T00:01:00.000Z" })
    ].join("\n") + "\n", "utf8");

    await migrateLegacyMemory({ workspacePath: workspace });
    const pending = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(pending.status().storageMode, "migration_pending_verification");
    } finally {
      pending.close();
    }
    await migrateLegacyMemory({ workspacePath: workspace, verify: true });
    const store = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.equal(store.records("decision").length, 1);
      assert.deepEqual(store.events<{ id: string }>("orchestration", "run_legacy").map((event) => event.id), ["event_1", "event_2"]);
      assert.equal(store.status().storageMode, "db_first");
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy migration dry-run validates without creating a database", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-dry-run");
  try {
    const memory = resolveMemoryPaths(workspace);
    await mkdir(memory.rootDir, { recursive: true });
    await writeFile(memory.decisions, "{\"id\":\"decision_dry\",\"createdAt\":\"2026-01-01T00:00:00.000Z\",\"summary\":\"dry\"}\n", "utf8");
    const result = await migrateLegacyMemory({ workspacePath: workspace, dryRun: true });
    assert.equal(result.status, "dry-run");
    assert.equal(result.errors.length, 0);
    assert.equal(result.importedRecords, 1);
    assert.equal(existsSync(resolveMemoryDatabasePath(workspace)), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("run state and events load from SQLite when compatibility artifacts are corrupted", async () => {
  const workspace = await fixtureWorkspace("sqlite-run-state");
  try {
    const artifacts = new OrchestrationArtifactStore(workspace);
    const run = fakeRun(workspace);
    const runRef = await artifacts.saveRun(run);
    await artifacts.appendEvent({
      id: "event_sqlite_state",
      run_id: run.id,
      type: "run.created",
      message: "created",
      created_at: run.created_at
    });
    await writeFile(runRef, "{broken", "utf8");

    assert.deepEqual(await artifacts.loadRun(run.id), run);
    assert.deepEqual((await artifacts.listRunEvents(run.id)).map((event) => (event as { id: string }).id), ["event_sqlite_state"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("SQLite event stream assigns unique ordered sequences across writers", async () => {
  const workspace = await fixtureWorkspace("sqlite-event-concurrency");
  try {
    await Promise.all(Array.from({ length: 25 }, async (_, index) => {
      const store = await SqliteMemoryStore.open({ workspacePath: workspace });
      try {
        store.appendEvent({
          kind: "orchestration",
          streamId: "run_concurrent",
          id: `event_${index}`,
          type: "test.event",
          createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
          payload: { index }
        });
      } finally {
        store.close();
      }
    }));
    const store = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      const events = store.events<{ index: number }>("orchestration", "run_concurrent");
      assert.equal(events.length, 25);
      assert.equal(new Set(events.map((event) => event.index)).size, 25);
    } finally {
      store.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("backup export and restore preserve the SQLite source of truth", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-backup");
  try {
    await rebuildRepoIndex(workspace);
    await appendDecision(workspace, { summary: "present in backup" });
    const store = await SqliteMemoryStore.open({ workspacePath: workspace });
    let backup: Awaited<ReturnType<SqliteMemoryStore["exportBackup"]>>;
    try {
      backup = await store.exportBackup();
      assert.equal(existsSync(backup.manifest.databasePath), true);
      assert.equal(existsSync(path.join(backup.backupDir, "manifest.json")), true);
    } finally {
      store.close();
    }
    await appendDecision(workspace, { summary: "created after backup" });
    await restoreMemoryBackup({ workspacePath: workspace, backupDir: backup.backupDir });
    const restored = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.deepEqual(restored.records<{ summary: string }>("decision").map((record) => record.summary), ["present in backup"]);
    } finally {
      restored.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("bounded fallback cache expires and invalidates prefixes", async () => {
  const cache = new ReadThroughMemoryCache(2);
  await cache.set("memory:a", "one", 60);
  await cache.set("memory:b", "two", 60);
  await cache.set("memory:c", "three", 60);
  assert.equal(await cache.get("memory:a"), undefined);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 61_000;
  try {
    assert.equal(await cache.get("memory:b"), undefined);
  } finally {
    Date.now = originalNow;
  }
  await cache.deletePrefix("memory:");
  assert.equal(await cache.get("memory:c"), undefined);
});

test("optional Redis cache uses Redis when available and falls back when disabled or unavailable", async () => {
  const redisValues = new Map<string, string>();
  const fakeRedis: RedisLikeClient = {
    connect: async () => undefined,
    get: async (key) => redisValues.get(key) ?? null,
    set: async (key, value) => {
      redisValues.set(key, value);
      return undefined;
    },
    del: async (key) => redisValues.delete(key),
    scanIterator: async function* ({ MATCH }) {
      const prefix = MATCH.slice(0, -1);
      for (const key of redisValues.keys()) if (key.startsWith(prefix)) yield key;
    }
  };
  const available = new OptionalRedisMemoryCache({
    redisUrl: "redis://test",
    clientLoader: async () => fakeRedis
  });
  await available.set("memory:available", "cached", 60);
  assert.equal(redisValues.get("memory:available"), "cached");
  await available.deletePrefix("memory:");
  assert.equal(redisValues.size, 0);
  await available.set("memory:secret", "authorization: Bearer secret", 60);
  assert.equal(redisValues.has("memory:secret"), false);

  const disabled = new OptionalRedisMemoryCache({ redisUrl: "" });
  await disabled.set("memory:disabled", "fallback", 60);
  assert.equal(await disabled.get("memory:disabled"), "fallback");

  const unavailable = new OptionalRedisMemoryCache({
    redisUrl: "redis://unavailable",
    clientLoader: async () => {
      throw new Error("offline");
    }
  });
  await unavailable.set("memory:unavailable", "fallback", 60);
  assert.equal(await unavailable.get("memory:unavailable"), "fallback");
});

test("snapshot cache keys invalidate after a successful memory transaction", async () => {
  const workspace = await fixtureWorkspace("sqlite-memory-cache-version");
  try {
    const writer = await SqliteMemoryStore.open({ workspacePath: workspace });
    try {
      writer.saveRepositoryMemory({ indexState: { version: 1 } });
    } finally {
      writer.close();
    }
    const firstReader = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.deepEqual(await firstReader.cachedSnapshot("index_state"), { version: 1 });
    } finally {
      firstReader.close();
    }
    const secondWriter = await SqliteMemoryStore.open({ workspacePath: workspace });
    try {
      secondWriter.saveRepositoryMemory({ indexState: { version: 2 } });
    } finally {
      secondWriter.close();
    }
    const secondReader = await SqliteMemoryStore.open({ workspacePath: workspace, readOnly: true });
    try {
      assert.deepEqual(await secondReader.cachedSnapshot("index_state"), { version: 2 });
    } finally {
      secondReader.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function fixtureWorkspace(prefix: string) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: path.basename(workspace), scripts: { test: "node --test" } }), "utf8");
  await writeFile(path.join(workspace, "src", "index.ts"), "export function greet() { return 'hello'; }\n", "utf8");
  return workspace;
}

function fakeRun(workspace: string): Run {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schema_version: ORCHESTRATION_SCHEMA_VERSION,
    id: "run_sqlite_state",
    user_request: "verify SQLite state",
    status: "created",
    created_at: now,
    updated_at: now,
    root_task_ids: [],
    memory_snapshot_ref: "sqlite:repo_index",
    config: {
      workspace_path: workspace,
      memory_dir: ".agent_memory",
      max_context_files: 8,
      max_context_chars: 12_000,
      max_task_attempts: 2,
      provider_mode: "real_provider"
    },
    artifacts_path: path.join(workspace, ".agent_memory", "runs", "run_sqlite_state")
  };
}
