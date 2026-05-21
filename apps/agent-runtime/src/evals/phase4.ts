import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureMemoryLayout, appendFailedAttempt, getFailedAttempts, writeJson } from "../memory/ProjectMemory.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { getRelevantFiles } from "../memory/ProjectMemory.js";
import { loadOrchestrationConfig } from "../orchestration/OrchestrationConfig.js";
import { CampaignManager } from "../orchestration/CampaignManager.js";
import { validatePatchProposalScope } from "../orchestration/PatchSafety.js";
import { ContextPackBuilder } from "../orchestration/ContextPackBuilder.js";
import { CoreOrchestrator } from "../orchestration/Orchestrator.js";
import type { Task } from "../orchestration/OrchestrationModels.js";

export type Phase4EvalResult = {
  id: string;
  title: string;
  passed: boolean;
  summary: string;
};

export async function runPhase4Evals(options: { workspacePath?: string; memoryDir?: string } = {}) {
  const fixture = await createFixtureRepo();
  const memoryDir = options.memoryDir ?? ".agent_memory";
  const results: Phase4EvalResult[] = [];
  results.push(await scenario("indexing", "Indexing a repo", async () => {
    const snapshot = await rebuildRepoIndex(fixture, { memoryDir });
    assert(snapshot.repoIndex.totals.indexedFiles >= 4, "expected fixture files to be indexed");
    return `Indexed ${snapshot.repoIndex.totals.indexedFiles} file(s).`;
  }));
  results.push(await scenario("planning", "Planning a small change", async () => {
    const result = await new CoreOrchestrator({ workspacePath: fixture, memoryDir, config: { execution_mode: "fast" } }).planOnly("Explain the add function without editing files.");
    assert(result.tasks.length >= 3, "expected task graph");
    return `Planned ${result.tasks.length} task(s).`;
  }));
  results.push(await scenario("context", "Context pack stays bounded", async () => {
    const task = fakeTask("run_eval", "Explain add helper", ["src/add.ts"]);
    const pack = await new ContextPackBuilder(fixture, { memoryDir, maxFiles: 2, maxChars: 1200 }).build("run_eval", task);
    assert(pack.relevant_files.includes("src/add.ts"), "expected src/add.ts in context");
    assert(pack.relevant_files.length <= 2, "expected bounded context file count");
    return `Context includes ${pack.relevant_files.join(", ")}.`;
  }));
  results.push(await scenario("forbidden-edit", "Forbidden file edit is rejected", async () => {
    const safety = validatePatchProposalScope({
      workspacePath: fixture,
      task: fakeTask("run_eval", "Modify only source", ["src/add.ts"]),
      proposal: {
        task_id: "task_eval",
        summary: "bad",
        files_to_modify: ["package.json"],
        patch_or_diff: "diff --git a/package.json b/package.json",
        risks: [],
        validation_suggestions: [],
        requires_followup: false
      },
      config: loadOrchestrationConfig({ execution_mode: "fast" })
    });
    assert(!safety.accepted, "expected scope rejection");
    return safety.reasons.join("; ");
  }));
  results.push(await scenario("failed-attempt-memory", "Memory records failed attempts", async () => {
    await appendFailedAttempt(fixture, { summary: "Eval failed validation fixture", relatedTaskId: "task_eval" }, memoryDir);
    const attempts = await getFailedAttempts(fixture, memoryDir);
    assert(attempts.some((attempt) => attempt.relatedTaskId === "task_eval"), "expected failed attempt memory");
    return "Failed attempt persisted.";
  }));
  results.push(await scenario("stale-index", "Stale index is detected", async () => {
    await rebuildRepoIndex(fixture, { memoryDir });
    await writeFile(path.join(fixture, "src", "add.ts"), "export function add(a: number, b: number) { return a + b + 0; }\n", "utf8");
    const freshness = await assessIndexFreshness(fixture, memoryDir);
    assert(freshness.status === "stale", `expected stale index, got ${freshness.status}`);
    return `Changed files: ${freshness.changedFiles.join(", ")}`;
  }));
  results.push(await scenario("campaign-pause-resume", "Campaign can pause and resume", async () => {
    const manager = new CampaignManager(fixture, memoryDir);
    const campaign = await manager.create("Improve arithmetic helpers safely");
    await manager.plan(campaign.id);
    await manager.pause(campaign.id);
    const resumed = await manager.resume(campaign.id);
    assert(resumed.status === "running" || resumed.status === "blocked", "expected resumable campaign state");
    return `Campaign ${campaign.id} resumed as ${resumed.status}.`;
  }));
  results.push(await scenario("mode-config", "Mode config changes behavior", async () => {
    const fast = loadOrchestrationConfig({ execution_mode: "fast" });
    const exhaustive = loadOrchestrationConfig({ execution_mode: "exhaustive" });
    assert(fast.max_context_size < exhaustive.max_context_size, "expected exhaustive mode to use more context");
    assert(!fast.enable_multi_perspective_review && exhaustive.enable_multi_perspective_review, "expected review behavior to differ");
    return `fast=${fast.max_context_size}, exhaustive=${exhaustive.max_context_size}`;
  }));
  results.push(await scenario("relevant-files", "Relevant file search uses memory", async () => {
    await rebuildRepoIndex(fixture, { memoryDir });
    const files = await getRelevantFiles(fixture, "add helper arithmetic", { memoryDir, limit: 3 });
    assert(files.some((file) => file.path === "src/add.ts"), "expected add source in relevant files");
    return files.map((file) => file.path).join(", ");
  }));
  results.push(await scenario("final-report", "Final report contains validation results", async () => {
    const result = await new CoreOrchestrator({ workspacePath: fixture, memoryDir, config: { execution_mode: "fast" } }).runAgenticTask("Explain src/add.ts and do not change files.");
    assert(Array.isArray(result.report.validation_results), "expected validation results array");
    return `Run ${result.run.id} ended ${result.run.status}.`;
  }));

  const passed = results.filter((result) => result.passed).length;
  const memory = await ensureMemoryLayout(options.workspacePath ?? fixture, options.memoryDir);
  const evalId = `eval_${Date.now()}`;
  const summary = {
    id: evalId,
    generated_at: new Date().toISOString(),
    passed,
    failed: results.length - passed,
    total: results.length,
    results
  };
  await writeJson(path.join(memory.evalsDir, evalId, "summary.json"), summary);
  return summary;
}

async function scenario(id: string, title: string, fn: () => Promise<string>): Promise<Phase4EvalResult> {
  try {
    return { id, title, passed: true, summary: await fn() };
  } catch (error) {
    return { id, title, passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}

async function createFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "orchcode-phase4-eval-"));
  await writeJson(path.join(root, "package.json"), {
    scripts: {
      test: "node -e \"process.exit(0)\"",
      typecheck: "node -e \"process.exit(0)\""
    },
    dependencies: {}
  });
  await writeFile(path.join(root, "README.md"), "# Fixture\n\nArithmetic helper fixture.\n", "utf8");
  await writeFile(path.join(root, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}\n", "utf8");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "add.ts"), "export function add(a: number, b: number) { return a + b; }\n", "utf8");
  await writeFile(path.join(root, "src", "add.test.ts"), "import { add } from './add';\nadd(1, 2);\n", "utf8");
  return root;
}

function fakeTask(runId: string, objective: string, allowed: string[]): Task {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    id: "task_eval",
    run_id: runId,
    title: "Eval task",
    objective,
    role_required: "ExecutorAgent",
    status: "ready",
    dependencies: [],
    relevant_files: allowed,
    allowed_files_to_edit: allowed,
    forbidden_files: [".agent_memory/"],
    expected_output_schema: "ParsedAgentOutput",
    validation_commands: [],
    max_attempts: 1,
    attempt_count: 0,
    artifacts: [],
    created_at: now,
    updated_at: now
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
