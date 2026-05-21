import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendJsonl, ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import type { AgentInvocation, ContextPack, FinalRunReport, OrchestratorEvent, Run, RunCheckpoint, RunMetrics, Task } from "./OrchestrationModels.js";

export type RunArtifactPaths = {
  runDir: string;
  run: string;
  tasks: string;
  events: string;
  contextPacksDir: string;
  invocationsDir: string;
  rawOutputsDir: string;
  parsedOutputsDir: string;
  reportsDir: string;
  patchesDir: string;
  reviewsDir: string;
  validationDir: string;
  integrationDir: string;
  repairsDir: string;
  locksDir: string;
  checkpointsDir: string;
  metricsDir: string;
};

export class OrchestrationArtifactStore {
  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {}

  async pathsForRun(runId: string): Promise<RunArtifactPaths> {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const runDir = path.join(memory.runsDir, runId);
    return {
      runDir,
      run: path.join(runDir, "run.json"),
      tasks: path.join(runDir, "tasks.json"),
      events: path.join(runDir, "events.jsonl"),
      contextPacksDir: path.join(runDir, "context_packs"),
      invocationsDir: path.join(runDir, "invocations"),
      rawOutputsDir: path.join(runDir, "raw_outputs"),
      parsedOutputsDir: path.join(runDir, "parsed_outputs"),
      reportsDir: path.join(runDir, "reports"),
      patchesDir: path.join(runDir, "patches"),
      reviewsDir: path.join(runDir, "reviews"),
      validationDir: path.join(runDir, "validation"),
      integrationDir: path.join(runDir, "integration"),
      repairsDir: path.join(runDir, "repairs"),
      locksDir: path.join(runDir, "locks"),
      checkpointsDir: path.join(runDir, "checkpoints"),
      metricsDir: path.join(runDir, "metrics")
    };
  }

  async ensureRunLayout(runId: string) {
    const paths = await this.pathsForRun(runId);
    await mkdir(paths.contextPacksDir, { recursive: true });
    await mkdir(paths.invocationsDir, { recursive: true });
    await mkdir(paths.rawOutputsDir, { recursive: true });
    await mkdir(paths.parsedOutputsDir, { recursive: true });
    await mkdir(paths.reportsDir, { recursive: true });
    await mkdir(paths.patchesDir, { recursive: true });
    await mkdir(paths.reviewsDir, { recursive: true });
    await mkdir(paths.validationDir, { recursive: true });
    await mkdir(paths.integrationDir, { recursive: true });
    await mkdir(paths.repairsDir, { recursive: true });
    await mkdir(paths.locksDir, { recursive: true });
    await mkdir(paths.checkpointsDir, { recursive: true });
    await mkdir(paths.metricsDir, { recursive: true });
    return paths;
  }

  async saveRun(run: Run) {
    const paths = await this.ensureRunLayout(run.id);
    await writeJson(paths.run, run);
    return paths.run;
  }

  async loadRun(runId: string): Promise<Run> {
    const paths = await this.pathsForRun(runId);
    return readJson<Run>(paths.run);
  }

  async saveTasks(runId: string, tasks: Task[]) {
    const paths = await this.ensureRunLayout(runId);
    await writeJson(paths.tasks, tasks);
    return paths.tasks;
  }

  async loadTasks(runId: string): Promise<Task[]> {
    const paths = await this.pathsForRun(runId);
    return readJson<Task[]>(paths.tasks);
  }

  async appendEvent(event: OrchestratorEvent) {
    const paths = await this.ensureRunLayout(event.run_id);
    await appendJsonl(paths.events, event);
    return paths.events;
  }

  async saveContextPack(pack: ContextPack) {
    const paths = await this.ensureRunLayout(pack.run_id);
    const filePath = path.join(paths.contextPacksDir, `${pack.task_id}.json`);
    await writeJson(filePath, pack);
    return filePath;
  }

  async loadContextPack(runId: string, taskId: string): Promise<ContextPack> {
    const paths = await this.pathsForRun(runId);
    return readJson<ContextPack>(path.join(paths.contextPacksDir, `${taskId}.json`));
  }

  async saveInvocation(invocation: AgentInvocation) {
    const paths = await this.ensureRunLayout(invocation.run_id);
    const filePath = path.join(paths.invocationsDir, `${invocation.id}.json`);
    await writeJson(filePath, invocation);
    return filePath;
  }

  async saveRawOutput(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.rawOutputsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveParsedOutput(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.parsedOutputsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveFinalReport(report: FinalRunReport) {
    const paths = await this.ensureRunLayout(report.run_id);
    const filePath = path.join(paths.reportsDir, "final_report.json");
    await writeJson(filePath, report);
    return filePath;
  }

  async loadFinalReport(runId: string): Promise<FinalRunReport> {
    const paths = await this.pathsForRun(runId);
    return readJson<FinalRunReport>(path.join(paths.reportsDir, "final_report.json"));
  }

  async saveCheckpoint(checkpoint: RunCheckpoint) {
    const paths = await this.ensureRunLayout(checkpoint.run_id);
    const filePath = path.join(paths.checkpointsDir, `${checkpoint.created_at.replace(/[:.]/g, "-")}_${checkpoint.label}.json`);
    await writeJson(filePath, sanitizeForArtifact(checkpoint));
    return filePath;
  }

  async listCheckpoints(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.checkpointsDir);
  }

  async saveRunMetrics(metrics: RunMetrics) {
    const paths = await this.ensureRunLayout(metrics.run_id);
    const filePath = path.join(paths.metricsDir, "run_metrics.json");
    await writeJson(filePath, sanitizeForArtifact(metrics));
    return filePath;
  }

  async loadRunMetrics(runId: string): Promise<RunMetrics> {
    const paths = await this.pathsForRun(runId);
    return readJson<RunMetrics>(path.join(paths.metricsDir, "run_metrics.json"));
  }

  async savePatchArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.patchesDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveReviewArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.reviewsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveValidationArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.validationDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveValidationLog(runId: string, id: string, value: string) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.validationDir, `${id}.log`);
    await writeFile(filePath, redactSecrets(value), "utf8");
    return filePath;
  }

  async saveIntegrationArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.integrationDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveRepairArtifact(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.repairsDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async saveLockSnapshot(runId: string, id: string, value: unknown) {
    const paths = await this.ensureRunLayout(runId);
    const filePath = path.join(paths.locksDir, `${id}.json`);
    await writeJson(filePath, sanitizeForArtifact(value));
    return filePath;
  }

  async listRunEvents(runId: string): Promise<unknown[]> {
    const paths = await this.pathsForRun(runId);
    if (!existsSync(paths.events)) return [];
    const raw = await readFile(paths.events, "utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  }

  async listTaskArtifacts(runId: string, taskId: string) {
    const tasks = await this.loadTasks(runId);
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task.artifacts;
  }

  async listValidationLogs(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.validationDir);
  }

  async listPatchHistory(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return listFiles(paths.patchesDir);
  }

  async artifactTree(runId: string) {
    const paths = await this.ensureRunLayout(runId);
    return walkFiles(paths.runDir, paths.runDir);
  }

  async readArtifactText(runId: string, relativeArtifactPath: string) {
    const paths = await this.ensureRunLayout(runId);
    const target = path.resolve(paths.runDir, relativeArtifactPath);
    const relative = path.relative(paths.runDir, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact path is outside the selected run.");
    }
    return readFile(target, "utf8");
  }

  async listRuns() {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    if (!existsSync(memory.runsDir)) return [];
    const entries = await readdir(memory.runsDir, { withFileTypes: true });
    const runs: Run[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(memory.runsDir, entry.name, "run.json");
      if (!existsSync(runPath)) continue;
      try {
        runs.push(JSON.parse(await readFile(runPath, "utf8")) as Run);
      } catch {
        // Ignore malformed run dirs during listing; show-run will fail loudly.
      }
    }
    return runs.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }
}

async function listFiles(directory: string) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(directory, entry.name)).sort();
}

async function walkFiles(rootDir: string, currentDir: string): Promise<Array<{ path: string; sizeBytes: number }>> {
  if (!existsSync(currentDir)) return [];
  const entries = await readdir(currentDir, { withFileTypes: true });
  const output: Array<{ path: string; sizeBytes: number }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await walkFiles(rootDir, fullPath));
    } else if (entry.isFile()) {
      output.push({
        path: path.relative(rootDir, fullPath).replaceAll("\\", "/"),
        sizeBytes: (await stat(fullPath)).size
      });
    }
  }
  return output;
}

function sanitizeForArtifact(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeForArtifact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        /token|secret|password|api[_-]?key/i.test(key) ? "[REDACTED]" : sanitizeForArtifact(entry)
      ])
    );
  }
  return value;
}

function redactSecrets(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]");
}
