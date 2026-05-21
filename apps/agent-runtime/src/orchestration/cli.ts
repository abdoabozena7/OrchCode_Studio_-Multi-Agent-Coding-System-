import path from "node:path";
import {
  CoreOrchestrator,
  listOrchestrationRuns,
  loadContextPackForTask,
  loadFinalRunReport,
  loadPatchHistory,
  loadRunArtifactTree,
  loadRunDetails,
  loadRunEvents,
  loadRunMetrics,
  loadTaskArtifacts,
  loadTaskDetails,
  loadValidationLogs,
  readRunArtifact,
  resumeOrchestrationRun
} from "./Orchestrator.js";
import type { ExecutionMode } from "./OrchestrationConfig.js";

type CliOptions = {
  workspace: string;
  memoryDir?: string;
  json: boolean;
  runId?: string;
  mode: ExecutionMode;
  artifactPath?: string;
};

const { command, positional, options } = parseArgs(process.argv.slice(2));

try {
  if (command === "run-agentic-task") {
    const request = positional.join(" ").trim();
    if (!request) throw new Error("run-agentic-task requires a request string");
    const result = await new CoreOrchestrator({
      workspacePath: options.workspace,
      memoryDir: options.memoryDir,
      config: { execution_mode: options.mode }
    }).runAgenticTask(request);
    print(options, {
      run_id: result.run.id,
      status: result.run.status,
      tasks: result.tasks.map((task) => ({ id: task.id, title: task.title, role: task.role_required, status: task.status })),
      final_report: result.report
    });
  } else if (command === "plan-task") {
    const request = positional.join(" ").trim();
    if (!request) throw new Error("plan-task requires a request string");
    const result = await new CoreOrchestrator({
      workspacePath: options.workspace,
      memoryDir: options.memoryDir,
      config: { execution_mode: options.mode }
    }).planOnly(request);
    print(options, {
      run_id: result.run.id,
      status: result.run.status,
      tasks: result.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        role: task.role_required,
        dependencies: task.dependencies,
        allowed_files_to_edit: task.allowed_files_to_edit
      })),
      artifacts_path: result.run.artifacts_path
    });
  } else if (command === "show-run") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-run requires a run id");
    print(options, await loadRunDetails(options.workspace, runId, options.memoryDir));
  } else if (command === "resume-run") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("resume-run requires a run id");
    print(options, await resumeOrchestrationRun(options.workspace, runId, options.memoryDir));
  } else if (command === "inspect-task") {
    const taskId = positional[0];
    if (!taskId) throw new Error("inspect-task requires a task id");
    const runId = options.runId ?? await findRunForTask(options.workspace, taskId, options.memoryDir);
    print(options, await loadTaskDetails(options.workspace, runId, taskId, options.memoryDir));
  } else if (command === "list-runs") {
    const runs = await listOrchestrationRuns(options.workspace, options.memoryDir);
    print(options, runs.map((run) => ({
      id: run.id,
      status: run.status,
      user_request: run.user_request,
      created_at: run.created_at,
      artifacts_path: run.artifacts_path
    })));
  } else if (command === "show-context-pack") {
    const taskId = positional[0];
    if (!taskId) throw new Error("show-context-pack requires a task id");
    const runId = options.runId ?? await findRunForTask(options.workspace, taskId, options.memoryDir);
    print(options, await loadContextPackForTask(options.workspace, runId, taskId, options.memoryDir));
  } else if (command === "show-run-events") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-run-events requires a run id");
    print(options, await loadRunEvents(options.workspace, runId, options.memoryDir));
  } else if (command === "show-task-artifacts") {
    const taskId = positional[0];
    if (!taskId) throw new Error("show-task-artifacts requires a task id");
    const runId = options.runId ?? await findRunForTask(options.workspace, taskId, options.memoryDir);
    print(options, await loadTaskArtifacts(options.workspace, runId, taskId, options.memoryDir));
  } else if (command === "show-validation-logs") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-validation-logs requires a run id");
    print(options, await loadValidationLogs(options.workspace, runId, options.memoryDir));
  } else if (command === "show-patch-history") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-patch-history requires a run id");
    print(options, await loadPatchHistory(options.workspace, runId, options.memoryDir));
  } else if (command === "show-report") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-report requires a run id");
    print(options, await loadFinalRunReport(options.workspace, runId, options.memoryDir));
  } else if (command === "run-metrics") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("run-metrics requires a run id");
    print(options, await loadRunMetrics(options.workspace, runId, options.memoryDir));
  } else if (command === "show-artifacts") {
    const runId = positional[0] ?? options.runId;
    if (!runId) throw new Error("show-artifacts requires a run id");
    print(options, await loadRunArtifactTree(options.workspace, runId, options.memoryDir));
  } else if (command === "show-artifact") {
    const runId = positional[0] ?? options.runId;
    const artifactPath = options.artifactPath ?? positional[1];
    if (!runId || !artifactPath) throw new Error("show-artifact requires a run id and artifact path");
    print(options, await readRunArtifact(options.workspace, runId, artifactPath, options.memoryDir));
  } else {
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(args: string[]): { command: string; positional: string[]; options: CliOptions } {
  const options: CliOptions = {
    workspace: process.cwd(),
    json: false,
    mode: "deep"
  };
  const positional: string[] = [];
  let command = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = resolveFromCwd(args[++index] ?? ".");
    } else if (arg === "--memory-dir") {
      options.memoryDir = args[++index];
    } else if (arg === "--run") {
      options.runId = args[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mode") {
      options.mode = parseMode(args[++index] ?? "deep");
    } else if (arg === "--artifact") {
      options.artifactPath = args[++index];
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!command && arg) {
      command = arg;
    } else if (arg) {
      positional.push(arg);
    }
  }
  options.workspace = path.resolve(options.workspace);
  return { command, positional, options };
}

function parseMode(value: string): ExecutionMode {
  if (value === "fast" || value === "deep" || value === "exhaustive") return value;
  throw new Error(`Unknown execution mode: ${value}`);
}

async function findRunForTask(workspace: string, taskId: string, memoryDir?: string) {
  const runs = await listOrchestrationRuns(workspace, memoryDir);
  for (const run of runs) {
    const { tasks } = await loadRunDetails(workspace, run.id, memoryDir);
    if (tasks.some((task) => task.id === taskId)) return run.id;
  }
  throw new Error(`No run contains task ${taskId}`);
}

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function print(options: CliOptions, value: unknown) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(formatHuman(value));
}

function formatHuman(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => `- ${formatHuman(entry).replace(/\n/g, "\n  ")}`).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${Array.isArray(entry) || (entry && typeof entry === "object") ? `\n  ${formatHuman(entry).replace(/\n/g, "\n  ")}` : String(entry)}`)
      .join("\n");
  }
  return String(value);
}

function printHelp() {
  console.log(`OrchCode Phase 4 orchestrator CLI

Commands:
  run-agentic-task "<request>"   Run the Phase 4 safety-gated vertical slice
  plan-task "<request>"          Create a run and task graph without invoking agents
  resume-run <run_id>            Inspect/reconcile a saved run checkpoint
  show-run <run_id>              Show run and tasks
  show-report <run_id>           Show final run report
  run-metrics <run_id>           Show run metrics
  show-artifacts <run_id>        List run artifact tree
  show-artifact <run_id> <path>  Read a single run artifact
  inspect-task <task_id>         Show task details; use --run to disambiguate
  list-runs                      List saved runs
  show-context-pack <task_id>    Show a task context pack; use --run to disambiguate
  show-run-events <run_id>       Show structured run events
  show-task-artifacts <task_id>  Show artifact refs for a task; use --run to disambiguate
  show-validation-logs <run_id>  List validation artifacts/logs for a run
  show-patch-history <run_id>    List patch safety artifacts for a run

Options:
  --workspace <path>             Workspace root (default: current directory)
  --memory-dir <path>            Memory directory (default: .agent_memory)
  --run <run_id>                 Select run for task/context lookup
  --mode <fast|deep|exhaustive>  Execution mode for run/plan
  --artifact <path>              Artifact path for show-artifact
  --json                         Print JSON
`);
}
