import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MEMORY_DATABASE_FILENAME,
  SqliteMemoryStore,
  type MemoryRecordKind
} from "./SqliteMemoryStore.js";
import {
  DEFAULT_MEMORY_DIR,
  MEMORY_SCHEMA_VERSION,
  type CommandInventory,
  type DecisionRecord,
  type FailedAttemptRecord,
  type FileManifestEntry,
  type FileSummaryRecord,
  type LessonLearnedRecord,
  type MemoryPaths,
  type MemoryStatus,
  type ProjectGlossary,
  type RepoIndex,
  type SuccessfulPatternRecord,
  type SymbolIndex,
  type ArchitectureNoteRecord,
  type TaskHistoryRecord
} from "./types.js";

const MEMORY_README = `# Agent Memory

This directory stores durable local project memory and auditable artifacts for Hivo.

Committed files:

- \`README.md\`: schema and operating notes for humans and future agents.
- \`schema_version.json\`: current local memory schema marker.

SQLite source of truth:

- \`factory_metadata.sqlite\`: repository memory, durable knowledge, structured run state, ordered events, search indexes, and orchestration metadata.

Legacy import/backup files:

- \`repo_index.json\`: repository layout, language, entrypoint, and high-signal file metadata.
- \`file_manifest.json\`: deterministic file manifest with hashes/mtimes for indexed text files.
- \`symbol_index.json\`: heuristic symbol/import/export index.
- \`file_summaries.jsonl\`: lightweight per-file summaries.
- \`command_inventory.json\`: detected build, test, lint, typecheck, smoke, and run commands.
- \`decisions.jsonl\`: append-only architecture and task decisions.
- \`task_history.jsonl\`: append-only task/run notes.
- \`lessons_learned.jsonl\`: compacted lessons from prior runs.
- \`failed_attempts.jsonl\`: failed strategies and fingerprints to avoid repeating.
- \`successful_patterns.jsonl\`: accepted project patterns discovered by runs.
- \`project_glossary.json\`: durable terms and local vocabulary.
- \`architecture_notes.jsonl\`: append-only architecture facts and constraints.
- \`index_state.json\`: index freshness metadata.
- \`project_intelligence.json\`: dependency, risk, entrypoint, and test mapping hints.
- \`swarm_staffing_lessons.jsonl\`: append-only staffing fit lessons from Phase 6 experiments.
- \`swarm_tuning_history.jsonl\`: append-only tuning recommendations with confidence/evidence metadata.
- \`swarm_failure_patterns.jsonl\`: swarm trial failure patterns and avoidance notes.
- \`swarm_success_patterns.jsonl\`: swarm trial success patterns.
- \`swarm_specialist_selection_history.jsonl\`: specialist selection precision notes.
- JSON and JSONL files at the memory root are legacy migration inputs or backup exports, not normal runtime read sources.
- \`backups/\`: checkpointed SQLite backup exports and manifests.
- \`runs/\`: volatile run-specific artifacts.
- \`project_specs/\`: active and historical ProjectGoalSpec artifacts that define non-negotiable project goals for future workers.
- \`swarm_runs/\`: internal Swarm Autopilot run artifacts, staffing plans, scheduler traces, metrics, and reports.
- \`campaigns/\`: long-running campaign artifacts.
- \`evals/\`: local eval and benchmark artifacts.

Do not store secrets here. Large generated artifacts and volatile run files should stay local.

Run \`npm run memory:migrate-sqlite -- --dry-run\` before migration. Only verified migrations switch \`storage_mode\` to \`db_first\`. Backup restoration verifies the exported manifest hash before replacing the database.
`;
const initializedMemoryLayouts = new Set<string>();

export function resolveMemoryPaths(
  workspacePath: string,
  memoryDir = process.env.HIVO_MEMORY_DIR ?? process.env.ORCHCODE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR
): MemoryPaths {
  const rootDir = path.resolve(workspacePath, memoryDir);
  return {
    rootDir,
    readme: path.join(rootDir, "README.md"),
    schemaVersion: path.join(rootDir, "schema_version.json"),
    repoIndex: path.join(rootDir, "repo_index.json"),
    fileManifest: path.join(rootDir, "file_manifest.json"),
    symbolIndex: path.join(rootDir, "symbol_index.json"),
    fileSummaries: path.join(rootDir, "file_summaries.jsonl"),
    commandInventory: path.join(rootDir, "command_inventory.json"),
    decisions: path.join(rootDir, "decisions.jsonl"),
    taskHistory: path.join(rootDir, "task_history.jsonl"),
    lessonsLearned: path.join(rootDir, "lessons_learned.jsonl"),
    failedAttempts: path.join(rootDir, "failed_attempts.jsonl"),
    successfulPatterns: path.join(rootDir, "successful_patterns.jsonl"),
    projectGlossary: path.join(rootDir, "project_glossary.json"),
    architectureNotes: path.join(rootDir, "architecture_notes.jsonl"),
    indexState: path.join(rootDir, "index_state.json"),
    projectIntelligence: path.join(rootDir, "project_intelligence.json"),
    swarmStaffingLessons: path.join(rootDir, "swarm_staffing_lessons.jsonl"),
    swarmTuningHistory: path.join(rootDir, "swarm_tuning_history.jsonl"),
    swarmFailurePatterns: path.join(rootDir, "swarm_failure_patterns.jsonl"),
    swarmSuccessPatterns: path.join(rootDir, "swarm_success_patterns.jsonl"),
    swarmSpecialistSelectionHistory: path.join(rootDir, "swarm_specialist_selection_history.jsonl"),
    database: path.join(rootDir, MEMORY_DATABASE_FILENAME),
    backupsDir: path.join(rootDir, "backups"),
    runsDir: path.join(rootDir, "runs"),
    projectSpecsDir: path.join(rootDir, "project_specs"),
    campaignsDir: path.join(rootDir, "campaigns"),
    evalsDir: path.join(rootDir, "evals")
  };
}

export async function ensureMemoryLayout(workspacePath: string, memoryDir?: string): Promise<MemoryPaths> {
  const paths = resolveMemoryPaths(workspacePath, memoryDir);
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(paths.projectSpecsDir, { recursive: true });
  await mkdir(paths.campaignsDir, { recursive: true });
  await mkdir(paths.evalsDir, { recursive: true });
  await mkdir(paths.backupsDir, { recursive: true });
  if (!existsSync(paths.readme)) {
    await writeFile(paths.readme, MEMORY_README, "utf8");
  }
  if (!existsSync(paths.schemaVersion)) {
    await writeJson(paths.schemaVersion, {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      notes: "SQLite-first project memory schema; root JSON/JSONL files are legacy migration inputs or backups."
    });
  }
  if (!initializedMemoryLayouts.has(paths.rootDir)) {
    const store = await SqliteMemoryStore.open({ workspacePath, memoryDir });
    try {
      if (!store.snapshot<ProjectGlossary>("project_glossary")) {
        store.saveRepositoryMemory({
          projectGlossary: {
            schemaVersion: MEMORY_SCHEMA_VERSION,
            updatedAt: new Date().toISOString(),
            terms: []
          }
        });
      }
      initializedMemoryLayouts.add(paths.rootDir);
    } finally {
      store.close();
    }
  }
  return paths;
}

export async function loadMemory(workspacePath: string, memoryDir?: string): Promise<MemoryStatus> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  return inspectMemoryStatus(paths);
}

export async function saveMemory(workspacePath: string, input: {
  repoIndex?: RepoIndex;
  fileManifest?: FileManifestEntry[];
  symbolIndex?: SymbolIndex;
  fileSummaries?: FileSummaryRecord[];
  commandInventory?: CommandInventory;
  projectIntelligence?: import("./types.js").ProjectIntelligence;
  semanticProjectModel?: import("./types.js").SemanticProjectModel;
  indexState?: import("./types.js").IndexState | Record<string, unknown>;
  projectGlossary?: ProjectGlossary;
}, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir });
  try {
    store.saveRepositoryMemory(input);
  } finally {
    store.close();
  }
  return inspectMemoryStatus(paths);
}

export async function inspectMemoryStatus(paths: MemoryPaths): Promise<MemoryStatus> {
  const runs = existsSync(paths.runsDir) ? await readdir(paths.runsDir) : [];
  const campaigns = existsSync(paths.campaignsDir) ? await readdir(paths.campaignsDir) : [];
  const evals = existsSync(paths.evalsDir) ? await readdir(paths.evalsDir) : [];
  const store = await SqliteMemoryStore.open({ workspacePath: path.dirname(paths.rootDir), memoryDir: paths.rootDir });
  try {
    const status = store.status();
    return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    memoryRoot: paths.rootDir,
    hasRepoIndex: Boolean(store.snapshot("repo_index")),
    hasFileManifest: Boolean(store.snapshot("file_manifest")),
    hasSymbolIndex: Boolean(store.snapshot("symbol_index")),
    hasFileSummaries: Boolean(store.snapshot("file_summaries")),
    hasCommandInventory: Boolean(store.snapshot("command_inventory")),
    hasDecisions: store.records("decision").length > 0,
    hasTaskHistory: store.records("task_history").length > 0,
    hasLessonsLearned: store.records("lesson").length > 0,
    hasFailedAttempts: store.records("failed_attempt").length > 0,
    hasSuccessfulPatterns: store.records("successful_pattern").length > 0,
    hasProjectGlossary: Boolean(store.snapshot("project_glossary")),
    hasArchitectureNotes: store.records("architecture_note").length > 0,
    hasIndexState: Boolean(store.snapshot("index_state")),
    hasProjectIntelligence: Boolean(store.snapshot("project_intelligence")),
    databasePath: paths.database,
    storageMode: status.storageMode,
    runArtifacts: runs.length,
    campaignArtifacts: campaigns.length,
    evalArtifacts: evals.length
  };
  } finally {
    store.close();
  }
}

export async function inspectRepoIndex(workspacePath: string, memoryDir?: string) {
  const paths = resolveMemoryPaths(workspacePath, memoryDir);
  return {
    status: await inspectMemoryStatus(await ensureMemoryLayout(workspacePath, memoryDir)),
    repoIndex: await readMemorySnapshot<RepoIndex>(workspacePath, "repo_index", memoryDir),
    commandInventory: await readMemorySnapshot<CommandInventory>(workspacePath, "command_inventory", memoryDir)
  };
}

export async function getCommandInventory(workspacePath: string, memoryDir?: string): Promise<CommandInventory | undefined> {
  return readMemorySnapshot<CommandInventory>(workspacePath, "command_inventory", memoryDir);
}

export async function appendDecision(workspacePath: string, input: Omit<DecisionRecord, "id" | "createdAt">, memoryDir?: string): Promise<DecisionRecord> {
  const record: DecisionRecord = {
    id: `decision_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "decision", record, memoryDir);
  return record;
}

export async function appendRunHistory(workspacePath: string, input: Omit<TaskHistoryRecord, "id" | "createdAt">, memoryDir?: string): Promise<TaskHistoryRecord> {
  const record: TaskHistoryRecord = {
    id: `task_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "task_history", record, memoryDir);
  return record;
}

export async function appendLessonLearned(workspacePath: string, input: Omit<LessonLearnedRecord, "id" | "createdAt">, memoryDir?: string): Promise<LessonLearnedRecord> {
  const record: LessonLearnedRecord = {
    id: `lesson_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "lesson", record, memoryDir);
  return record;
}

export async function appendFailedAttempt(workspacePath: string, input: Omit<FailedAttemptRecord, "id" | "createdAt">, memoryDir?: string): Promise<FailedAttemptRecord> {
  const record: FailedAttemptRecord = {
    id: `failed_attempt_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "failed_attempt", record, memoryDir);
  return record;
}

export async function appendSuccessfulPattern(workspacePath: string, input: Omit<SuccessfulPatternRecord, "id" | "createdAt">, memoryDir?: string): Promise<SuccessfulPatternRecord> {
  const record: SuccessfulPatternRecord = {
    id: `successful_pattern_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "successful_pattern", record, memoryDir);
  return record;
}

export async function appendArchitectureNote(workspacePath: string, input: Omit<ArchitectureNoteRecord, "id" | "createdAt">, memoryDir?: string): Promise<ArchitectureNoteRecord> {
  const record: ArchitectureNoteRecord = {
    id: `architecture_note_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendMemoryRecord(workspacePath, "architecture_note", record, memoryDir);
  return record;
}

export async function getMemoryLessons(workspacePath: string, memoryDir?: string) {
  return readMemoryRecords<LessonLearnedRecord>(workspacePath, "lesson", memoryDir);
}

export async function getFailedAttempts(workspacePath: string, memoryDir?: string) {
  return readMemoryRecords<FailedAttemptRecord>(workspacePath, "failed_attempt", memoryDir);
}

export async function getDecisions(workspacePath: string, memoryDir?: string) {
  return readMemoryRecords<DecisionRecord>(workspacePath, "decision", memoryDir);
}

export async function compactMemory(workspacePath: string, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const runDirs = existsSync(paths.runsDir) ? await readdir(paths.runsDir, { withFileTypes: true }) : [];
  let lessons = 0;
  let failures = 0;
  let successes = 0;
  for (const entry of runDirs.filter((candidate) => candidate.isDirectory())) {
    const reportPath = path.join(paths.runsDir, entry.name, "reports", "final_report.json");
    if (!existsSync(reportPath)) continue;
    try {
      const report = await readJson<{
        run_id: string;
        status: string;
        limitations?: string[];
        validation_results?: Array<{ status: string; command: string; summary?: string }>;
        files_changed?: string[];
        next_recommendations?: string[];
      }>(reportPath);
      if (report.status === "failed" || report.validation_results?.some((result) => result.status === "failed")) {
        await appendFailedAttempt(workspacePath, {
          summary: `Run ${report.run_id} ended with status ${report.status}.`,
          relatedRunId: report.run_id,
          evidence: [reportPath, ...(report.limitations ?? []).slice(0, 3)],
          nextAvoidance: report.next_recommendations?.[0] ?? "Inspect validation and review artifacts before retrying."
        }, memoryDir);
        failures += 1;
      } else if (report.status === "succeeded") {
        await appendSuccessfulPattern(workspacePath, {
          summary: `Run ${report.run_id} completed successfully with ${report.files_changed?.length ?? 0} changed file(s).`,
          relatedRunIds: [report.run_id],
          relatedFiles: report.files_changed ?? [],
          tags: ["compacted-run", "success"]
        }, memoryDir);
        successes += 1;
      }
      if (report.limitations?.length) {
        await appendLessonLearned(workspacePath, {
          summary: report.limitations[0] ?? `Run ${report.run_id} produced a limitation.`,
          evidence: [reportPath],
          relatedRunIds: [report.run_id],
          tags: ["compacted-run"]
        }, memoryDir);
        lessons += 1;
      }
    } catch {
      // Ignore malformed run reports; direct inspection commands can fail loudly.
    }
  }
  return {
    status: "compacted",
    runsScanned: runDirs.filter((entry) => entry.isDirectory()).length,
    lessonsAdded: lessons,
    failedAttemptsAdded: failures,
    successfulPatternsAdded: successes
  };
}

export async function explainTaskMemory(workspacePath: string, taskId: string, memoryDir?: string) {
  const history = await readMemoryRecords<TaskHistoryRecord>(workspacePath, "task_history", memoryDir);
  const failures = await readMemoryRecords<FailedAttemptRecord>(workspacePath, "failed_attempt", memoryDir);
  const lessons = await readMemoryRecords<LessonLearnedRecord>(workspacePath, "lesson", memoryDir);
  return {
    taskId,
    taskHistory: history.filter((record) => record.id === taskId || record.task.includes(taskId)),
    failedAttempts: failures.filter((record) => record.relatedTaskId === taskId || record.evidence?.some((entry) => entry.includes(taskId))),
    lessons: lessons.filter((record) => record.evidence?.some((entry) => entry.includes(taskId)))
  };
}

export async function getRelevantFiles(workspacePath: string, query: string, options: { memoryDir?: string; limit?: number } = {}) {
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir: options.memoryDir, readOnly: true });
  try {
    return store.relevantFiles(query, options.limit ?? 12);
  } finally {
    store.close();
  }
}

export async function readMemorySnapshot<T>(workspacePath: string, kind: string, memoryDir?: string): Promise<T | undefined> {
  await ensureMemoryLayout(workspacePath, memoryDir);
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir, readOnly: true });
  try {
    return await store.cachedSnapshot<T>(kind);
  } finally {
    store.close();
  }
}

export async function readMemoryRecords<T>(workspacePath: string, kind: MemoryRecordKind, memoryDir?: string): Promise<T[]> {
  await ensureMemoryLayout(workspacePath, memoryDir);
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir, readOnly: true });
  try {
    return store.records<T>(kind);
  } finally {
    store.close();
  }
}

export async function appendMemoryRecord(
  workspacePath: string,
  kind: MemoryRecordKind,
  record: { id: string; createdAt?: string; created_at?: string; summary?: string; [key: string]: unknown },
  memoryDir?: string
) {
  await ensureMemoryLayout(workspacePath, memoryDir);
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir });
  try {
    store.appendRecord(kind, record);
  } finally {
    store.close();
  }
}

export async function searchMemory(workspacePath: string, query: string, options: { memoryDir?: string; limit?: number; kinds?: string[] } = {}) {
  await ensureMemoryLayout(workspacePath, options.memoryDir);
  const store = await SqliteMemoryStore.open({ workspacePath, memoryDir: options.memoryDir, readOnly: true });
  try {
    return store.search(query, options);
  } finally {
    store.close();
  }
}

export async function cleanRunArtifacts(workspacePath: string, options: { memoryDir?: string; olderThanDays?: number } = {}) {
  const paths = await ensureMemoryLayout(workspacePath, options.memoryDir);
  const cutoff = options.olderThanDays ? Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000 : 0;
  let removed = 0;
  for (const entry of await readdir(paths.runsDir, { withFileTypes: true })) {
    const target = path.join(paths.runsDir, entry.name);
    const resolvedTarget = path.resolve(target);
    const relativeTarget = path.relative(path.resolve(paths.runsDir), resolvedTarget);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      continue;
    }
    if (cutoff) {
      const info = await stat(resolvedTarget);
      if (info.mtimeMs > cutoff) continue;
    }
    await rm(resolvedTarget, { recursive: true, force: true });
    removed += 1;
  }
  return { removed, runsDir: paths.runsDir };
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function appendJsonl(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}
