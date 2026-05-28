import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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

This directory stores durable local project memory for Hivo.

Committed files:

- \`README.md\`: schema and operating notes for humans and future agents.
- \`schema_version.json\`: current local memory schema marker.

Generated local files:

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
- \`factory_metadata.sqlite\`: generated SQLite metadata index for orchestration artifacts; artifact contents remain in their JSON/JSONL/log files.
- \`runs/\`: volatile run-specific artifacts.
- \`swarm_runs/\`: internal Swarm Autopilot run artifacts, staffing plans, scheduler traces, metrics, and reports.
- \`campaigns/\`: long-running campaign artifacts.
- \`evals/\`: local eval and benchmark artifacts.

Do not store secrets here. Large generated artifacts and volatile run files should stay local.
`;

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
    runsDir: path.join(rootDir, "runs"),
    campaignsDir: path.join(rootDir, "campaigns"),
    evalsDir: path.join(rootDir, "evals")
  };
}

export async function ensureMemoryLayout(workspacePath: string, memoryDir?: string): Promise<MemoryPaths> {
  const paths = resolveMemoryPaths(workspacePath, memoryDir);
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.runsDir, { recursive: true });
  await mkdir(paths.campaignsDir, { recursive: true });
  await mkdir(paths.evalsDir, { recursive: true });
  if (!existsSync(paths.readme)) {
    await writeFile(paths.readme, MEMORY_README, "utf8");
  }
  if (!existsSync(paths.schemaVersion)) {
    await writeJson(paths.schemaVersion, {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      notes: "Phase 1 file-backed project memory schema."
    });
  }
  await touchJsonl(paths.decisions);
  await touchJsonl(paths.taskHistory);
  await touchJsonl(paths.lessonsLearned);
  await touchJsonl(paths.failedAttempts);
  await touchJsonl(paths.successfulPatterns);
  await touchJsonl(paths.architectureNotes);
  await touchJsonl(paths.swarmStaffingLessons);
  await touchJsonl(paths.swarmTuningHistory);
  await touchJsonl(paths.swarmFailurePatterns);
  await touchJsonl(paths.swarmSuccessPatterns);
  await touchJsonl(paths.swarmSpecialistSelectionHistory);
  if (!existsSync(paths.projectGlossary)) {
    await writeJson(paths.projectGlossary, {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      terms: []
    } satisfies ProjectGlossary);
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
}, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  if (input.repoIndex) await writeJson(paths.repoIndex, input.repoIndex);
  if (input.fileManifest) await writeJson(paths.fileManifest, input.fileManifest);
  if (input.symbolIndex) await writeJson(paths.symbolIndex, input.symbolIndex);
  if (input.fileSummaries) {
    await writeFile(paths.fileSummaries, input.fileSummaries.map((summary) => JSON.stringify(summary)).join("\n") + "\n", "utf8");
  }
  if (input.commandInventory) await writeJson(paths.commandInventory, input.commandInventory);
  return inspectMemoryStatus(paths);
}

export async function inspectMemoryStatus(paths: MemoryPaths): Promise<MemoryStatus> {
  const runs = existsSync(paths.runsDir) ? await readdir(paths.runsDir) : [];
  const campaigns = existsSync(paths.campaignsDir) ? await readdir(paths.campaignsDir) : [];
  const evals = existsSync(paths.evalsDir) ? await readdir(paths.evalsDir) : [];
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    memoryRoot: paths.rootDir,
    hasRepoIndex: existsSync(paths.repoIndex),
    hasFileManifest: existsSync(paths.fileManifest),
    hasSymbolIndex: existsSync(paths.symbolIndex),
    hasFileSummaries: existsSync(paths.fileSummaries),
    hasCommandInventory: existsSync(paths.commandInventory),
    hasDecisions: existsSync(paths.decisions),
    hasTaskHistory: existsSync(paths.taskHistory),
    hasLessonsLearned: existsSync(paths.lessonsLearned),
    hasFailedAttempts: existsSync(paths.failedAttempts),
    hasSuccessfulPatterns: existsSync(paths.successfulPatterns),
    hasProjectGlossary: existsSync(paths.projectGlossary),
    hasArchitectureNotes: existsSync(paths.architectureNotes),
    hasIndexState: existsSync(paths.indexState),
    hasProjectIntelligence: existsSync(paths.projectIntelligence),
    runArtifacts: runs.length,
    campaignArtifacts: campaigns.length,
    evalArtifacts: evals.length
  };
}

export async function inspectRepoIndex(workspacePath: string, memoryDir?: string) {
  const paths = resolveMemoryPaths(workspacePath, memoryDir);
  return {
    status: await inspectMemoryStatus(await ensureMemoryLayout(workspacePath, memoryDir)),
    repoIndex: existsSync(paths.repoIndex) ? await readJson<RepoIndex>(paths.repoIndex) : undefined,
    commandInventory: existsSync(paths.commandInventory) ? await readJson<CommandInventory>(paths.commandInventory) : undefined
  };
}

export async function getCommandInventory(workspacePath: string, memoryDir?: string): Promise<CommandInventory | undefined> {
  const paths = resolveMemoryPaths(workspacePath, memoryDir);
  if (!existsSync(paths.commandInventory)) return undefined;
  return readJson<CommandInventory>(paths.commandInventory);
}

export async function appendDecision(workspacePath: string, input: Omit<DecisionRecord, "id" | "createdAt">, memoryDir?: string): Promise<DecisionRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: DecisionRecord = {
    id: `decision_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.decisions, record);
  return record;
}

export async function appendRunHistory(workspacePath: string, input: Omit<TaskHistoryRecord, "id" | "createdAt">, memoryDir?: string): Promise<TaskHistoryRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: TaskHistoryRecord = {
    id: `task_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.taskHistory, record);
  return record;
}

export async function appendLessonLearned(workspacePath: string, input: Omit<LessonLearnedRecord, "id" | "createdAt">, memoryDir?: string): Promise<LessonLearnedRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: LessonLearnedRecord = {
    id: `lesson_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.lessonsLearned, record);
  return record;
}

export async function appendFailedAttempt(workspacePath: string, input: Omit<FailedAttemptRecord, "id" | "createdAt">, memoryDir?: string): Promise<FailedAttemptRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: FailedAttemptRecord = {
    id: `failed_attempt_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.failedAttempts, record);
  return record;
}

export async function appendSuccessfulPattern(workspacePath: string, input: Omit<SuccessfulPatternRecord, "id" | "createdAt">, memoryDir?: string): Promise<SuccessfulPatternRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: SuccessfulPatternRecord = {
    id: `successful_pattern_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.successfulPatterns, record);
  return record;
}

export async function appendArchitectureNote(workspacePath: string, input: Omit<ArchitectureNoteRecord, "id" | "createdAt">, memoryDir?: string): Promise<ArchitectureNoteRecord> {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const record: ArchitectureNoteRecord = {
    id: `architecture_note_${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...input
  };
  await appendJsonl(paths.architectureNotes, record);
  return record;
}

export async function getMemoryLessons(workspacePath: string, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  return readJsonl<LessonLearnedRecord>(paths.lessonsLearned);
}

export async function getFailedAttempts(workspacePath: string, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  return readJsonl<FailedAttemptRecord>(paths.failedAttempts);
}

export async function getDecisions(workspacePath: string, memoryDir?: string) {
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  return readJsonl<DecisionRecord>(paths.decisions);
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
  const paths = await ensureMemoryLayout(workspacePath, memoryDir);
  const history = await readJsonl<TaskHistoryRecord>(paths.taskHistory);
  const failures = await readJsonl<FailedAttemptRecord>(paths.failedAttempts);
  const lessons = await readJsonl<LessonLearnedRecord>(paths.lessonsLearned);
  return {
    taskId,
    taskHistory: history.filter((record) => record.id === taskId || record.task.includes(taskId)),
    failedAttempts: failures.filter((record) => record.relatedTaskId === taskId || record.evidence?.some((entry) => entry.includes(taskId))),
    lessons: lessons.filter((record) => record.evidence?.some((entry) => entry.includes(taskId)))
  };
}

export async function getRelevantFiles(workspacePath: string, query: string, options: { memoryDir?: string; limit?: number } = {}) {
  const paths = resolveMemoryPaths(workspacePath, options.memoryDir);
  if (!existsSync(paths.fileSummaries)) return [];
  const terms = query.toLowerCase().split(/[^a-z0-9_./-]+/i).filter((term) => term.length >= 2);
  const summaries = await readJsonl<FileSummaryRecord>(paths.fileSummaries);
  return summaries
    .map((summary) => ({ summary, score: scoreFileSummary(summary, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.summary.path.localeCompare(right.summary.path))
    .slice(0, options.limit ?? 12)
    .map((entry) => entry.summary);
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

async function touchJsonl(filePath: string) {
  if (!existsSync(filePath)) await writeFile(filePath, "", "utf8");
}

function scoreFileSummary(summary: FileSummaryRecord, terms: string[]) {
  const haystack = [
    summary.path,
    summary.language ?? "",
    summary.roleGuess,
    summary.purposeGuess,
    summary.roles.join(" "),
    summary.imports.join(" "),
    summary.exports.join(" "),
    summary.symbols.map((symbol) => symbol.name).join(" ")
  ].join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (summary.path.toLowerCase().includes(term)) score += 6;
    if (haystack.includes(term)) score += 2;
  }
  if (summary.roles.includes("entrypoint")) score += 1;
  return score;
}
