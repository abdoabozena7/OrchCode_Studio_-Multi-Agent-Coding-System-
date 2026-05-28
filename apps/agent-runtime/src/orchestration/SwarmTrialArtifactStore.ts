import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import type {
  ComparisonResult,
  ExperimentRun,
  StaffingEvaluationResult,
  SwarmExperiment,
  SwarmTrialReport,
  SwarmTuningPolicy
} from "./SwarmTrialModels.js";

export type SwarmTrialArtifactPaths = {
  experimentDir: string;
  experiment: string;
  runs: string;
  staffingEvaluations: string;
  comparisonResult: string;
  tuningPolicy: string;
  trialReportJson: string;
  trialReportMarkdown: string;
};

export class SwarmTrialArtifactStore {
  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {}

  async pathsForExperiment(experimentId: string): Promise<SwarmTrialArtifactPaths> {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const experimentDir = path.join(memory.rootDir, "swarm_trials", experimentId);
    return {
      experimentDir,
      experiment: path.join(experimentDir, "experiment.json"),
      runs: path.join(experimentDir, "runs.json"),
      staffingEvaluations: path.join(experimentDir, "staffing_evaluations.json"),
      comparisonResult: path.join(experimentDir, "comparison_result.json"),
      tuningPolicy: path.join(experimentDir, "tuning_policy.json"),
      trialReportJson: path.join(experimentDir, "trial_report.json"),
      trialReportMarkdown: path.join(experimentDir, "trial_report.md")
    };
  }

  async ensureExperimentLayout(experimentId: string) {
    const paths = await this.pathsForExperiment(experimentId);
    await mkdir(paths.experimentDir, { recursive: true });
    return paths;
  }

  async saveExperiment(experiment: SwarmExperiment) {
    const paths = await this.ensureExperimentLayout(experiment.id);
    await writeJson(paths.experiment, experiment);
    return paths.experiment;
  }

  async loadExperiment(experimentId: string) {
    const paths = await this.pathsForExperiment(experimentId);
    return readJson<SwarmExperiment>(paths.experiment);
  }

  async saveRuns(experimentId: string, runs: ExperimentRun[]) {
    const paths = await this.ensureExperimentLayout(experimentId);
    await writeJson(paths.runs, runs);
    return paths.runs;
  }

  async saveStaffingEvaluations(experimentId: string, evaluations: StaffingEvaluationResult[]) {
    const paths = await this.ensureExperimentLayout(experimentId);
    await writeJson(paths.staffingEvaluations, evaluations);
    return paths.staffingEvaluations;
  }

  async saveComparisonResult(experimentId: string, comparison: ComparisonResult) {
    const paths = await this.ensureExperimentLayout(experimentId);
    await writeJson(paths.comparisonResult, comparison);
    return paths.comparisonResult;
  }

  async saveTuningPolicy(experimentId: string, tuningPolicy: SwarmTuningPolicy) {
    const paths = await this.ensureExperimentLayout(experimentId);
    await writeJson(paths.tuningPolicy, tuningPolicy);
    return paths.tuningPolicy;
  }

  async saveTrialReport(experimentId: string, report: SwarmTrialReport, markdown: string) {
    const paths = await this.ensureExperimentLayout(experimentId);
    await writeJson(paths.trialReportJson, report);
    await writeFile(paths.trialReportMarkdown, markdown, "utf8");
    return {
      json: paths.trialReportJson,
      markdown: paths.trialReportMarkdown
    };
  }

  async artifactTree(experimentId: string) {
    const paths = await this.ensureExperimentLayout(experimentId);
    return walkFiles(paths.experimentDir, paths.experimentDir);
  }

  async listExperiments() {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const trialsDir = path.join(memory.rootDir, "swarm_trials");
    if (!existsSync(trialsDir)) return [];
    const entries = await readdir(trialsDir, { withFileTypes: true });
    const experiments: SwarmExperiment[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const experimentPath = path.join(trialsDir, entry.name, "experiment.json");
      if (!existsSync(experimentPath)) continue;
      try {
        experiments.push(JSON.parse(await readFile(experimentPath, "utf8")) as SwarmExperiment);
      } catch {
        // Keep listing resilient; direct load commands can fail loudly.
      }
    }
    return experiments.sort((left, right) => right.created_at.localeCompare(left.created_at));
  }
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
