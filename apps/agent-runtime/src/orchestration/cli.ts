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
import {
  listSwarmRuns,
  loadSwarmFinalReport,
  loadSwarmMetrics,
  loadSwarmRunDetails,
  loadSwarmSchedulerTrace,
  loadSwarmStaffingPlan,
  SwarmAutopilotRuntime
} from "./SwarmRuntime.js";
import type { SwarmRunMode } from "./SwarmModels.js";
import { SwarmTrialLab } from "./SwarmTrialLab.js";

type CliOptions = {
  workspace: string;
  memoryDir?: string;
  json: boolean;
  runId?: string;
  mode: ExecutionMode | "auto";
  artifactPath?: string;
  agentLimit?: number;
};

const { command, positional, options } = parseArgs(process.argv.slice(2));

try {
  if (command === "agent") {
    await handleAgentCommand(positional, options);
  } else if (command === "swarm") {
    await handleSwarmCommand(positional, options);
  } else if (command === "run-agentic-task") {
    const request = positional.join(" ").trim();
    if (!request) throw new Error("run-agentic-task requires a request string");
    const result = await new CoreOrchestrator({
      workspacePath: options.workspace,
      memoryDir: options.memoryDir,
      config: { execution_mode: coreMode(options.mode) }
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
      config: { execution_mode: coreMode(options.mode) }
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
    } else if (arg === "--agent-limit") {
      options.agentLimit = parseAgentLimit(args[++index] ?? "");
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

async function handleAgentCommand(positional: string[], options: CliOptions) {
  const subcommand = positional[0];
  const rest = positional.slice(1);
  if (subcommand === "trial") {
    await handleAgentTrialCommand(rest, options);
    return;
  }
  const runtime = new SwarmAutopilotRuntime({
    workspacePath: options.workspace,
    memoryDir: options.memoryDir,
    mode: swarmMode(options.mode),
    explicitAgentLimit: options.agentLimit
  });
  if (subcommand === "run") {
    const request = rest.join(" ").trim();
    if (!request) throw new Error("agent run requires a goal string");
    const result = await runtime.run(request);
    print(options, {
      run_id: result.run.id,
      status: result.run.status,
      effective_total_logical_agents: result.run.effective_total_logical_agents,
      executor_limit: result.staffingPlan.executor_limit,
      validation_level: result.staffingPlan.validation_level,
      artifacts_path: result.run.artifacts_path,
      final_report_ref: result.run.final_report_ref
    });
  } else if (subcommand === "plan") {
    const request = rest.join(" ").trim();
    if (!request) throw new Error("agent plan requires a goal string");
    const result = await runtime.plan(request);
    print(options, {
      run_id: result.run.id,
      status: result.run.status,
      task_complexity: result.staffingPlan.task_complexity,
      repo_scope: result.staffingPlan.repo_scope,
      risk_level: result.staffingPlan.risk_level,
      recommended_total_logical_agents: result.staffingPlan.recommended_total_logical_agents,
      executor_limit: result.staffingPlan.executor_limit,
      role_counts: result.staffingPlan.role_counts,
      specialists: result.staffingPlan.specialist_agents,
      artifacts_path: result.run.artifacts_path
    });
  } else if (subcommand === "inspect-run") {
    const runId = rest[0] ?? options.runId;
    if (!runId) throw new Error("agent inspect-run requires a run id");
    print(options, await runtime.inspectRun(runId));
  } else if (subcommand === "report") {
    const runId = rest[0] ?? options.runId;
    if (!runId) throw new Error("agent report requires a run id");
    print(options, await runtime.report(runId));
  } else if (subcommand === "resume") {
    const runId = rest[0] ?? options.runId;
    if (!runId) throw new Error("agent resume requires a run id");
    print(options, await runtime.resume(runId));
  } else if (subcommand === "list-runs") {
    print(options, await runtime.listRuns());
  } else {
    throw new Error("agent command must be one of: run, plan, inspect-run, report, resume, list-runs, trial");
  }
}

async function handleAgentTrialCommand(positional: string[], options: CliOptions) {
  const subcommand = positional[0];
  const rest = positional.slice(1);
  const lab = new SwarmTrialLab({ workspacePath: options.workspace, memoryDir: options.memoryDir });
  if (subcommand === "architecture-scan") {
    print(options, summarizeTrialResult(await lab.runArchitectureScan()));
  } else if (subcommand === "test-discovery") {
    print(options, summarizeTrialResult(await lab.runTestDiscovery()));
  } else if (subcommand === "staffing-eval") {
    print(options, summarizeTrialResult(await lab.runStaffingEval()));
  } else if (subcommand === "small-safe-fix") {
    const request = rest.join(" ").trim();
    if (!request) throw new Error("agent trial small-safe-fix requires a goal string");
    print(options, summarizeTrialResult(await lab.runSmallSafeFix(request)));
  } else if (subcommand === "compare") {
    const request = rest.join(" ").trim();
    if (!request) throw new Error("agent trial compare requires a goal string");
    print(options, summarizeTrialResult(await lab.runComparison(request)));
  } else if (subcommand === "huge-readonly-scan") {
    print(options, summarizeTrialResult(await lab.runArchitectureScan()));
  } else if (subcommand === "scheduler-scale") {
    print(options, summarizeTrialResult(await lab.runSchedulerScale()));
  } else if (subcommand === "list") {
    print(options, await lab.listExperiments());
  } else {
    throw new Error("agent trial command must be one of: architecture-scan, test-discovery, staffing-eval, small-safe-fix, compare, huge-readonly-scan, scheduler-scale, list");
  }
}

async function handleSwarmCommand(positional: string[], options: CliOptions) {
  const subcommand = positional[0];
  const runId = positional[1] ?? options.runId;
  if (subcommand === "inspect") {
    if (!runId) throw new Error("swarm inspect requires a run id");
    print(options, await loadSwarmRunDetails(options.workspace, runId, options.memoryDir));
  } else if (subcommand === "staffing-plan") {
    if (!runId) throw new Error("swarm staffing-plan requires a run id");
    print(options, await loadSwarmStaffingPlan(options.workspace, runId, options.memoryDir));
  } else if (subcommand === "scheduler-trace") {
    if (!runId) throw new Error("swarm scheduler-trace requires a run id");
    print(options, await loadSwarmSchedulerTrace(options.workspace, runId, options.memoryDir));
  } else if (subcommand === "metrics") {
    if (!runId) throw new Error("swarm metrics requires a run id");
    print(options, await loadSwarmMetrics(options.workspace, runId, options.memoryDir));
  } else if (subcommand === "report") {
    if (!runId) throw new Error("swarm report requires a run id");
    print(options, await loadSwarmFinalReport(options.workspace, runId, options.memoryDir));
  } else if (subcommand === "list-runs") {
    print(options, await listSwarmRuns(options.workspace, options.memoryDir));
  } else {
    throw new Error("swarm command must be one of: inspect, staffing-plan, scheduler-trace, metrics, report, list-runs");
  }
}

function parseMode(value: string): ExecutionMode | "auto" {
  if (value === "auto") return value;
  if (value === "fast" || value === "deep" || value === "exhaustive") return value;
  throw new Error(`Unknown execution mode: ${value}`);
}

function parseAgentLimit(value: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--agent-limit must be a positive integer");
  return Math.min(parsed, 300);
}

function coreMode(value: ExecutionMode | "auto"): ExecutionMode {
  return value === "auto" ? "deep" : value;
}

function swarmMode(value: ExecutionMode | "auto"): SwarmRunMode {
  return value;
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

function summarizeTrialResult(value: Awaited<ReturnType<SwarmTrialLab["runStaffingEval"]>> | Awaited<ReturnType<SwarmTrialLab["runSchedulerScale"]>>) {
  return {
    experiment_id: value.experiment.id,
    status: value.experiment.status,
    scenario_type: value.experiment.scenario_type,
    runs: value.runs.length,
    staffing_accuracy: value.trialReport.staffing_accuracy,
    report_ref: value.experiment.report_ref,
    recommended_mode: value.tuningPolicy.recommended_mode,
    recommended_total_logical_agents: value.tuningPolicy.recommended_total_logical_agents,
    comparison_recommendation: value.comparison?.recommendation,
    scheduler_scale: "schedulerScale" in value ? {
      agent_instances: value.schedulerScale.agent_instances,
      work_items: value.schedulerScale.work_items,
      executor_peak_count: value.schedulerScale.executor_peak_count,
      trace_ref: value.schedulerScale.trace_ref
    } : undefined,
    failed_staffing_scenarios: value.staffingEvaluations
      .filter((evaluation) => evaluation.pass_fail === "fail")
      .map((evaluation) => ({ goal: evaluation.input_goal, deviations: evaluation.deviations }))
  };
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
  console.log(`Hivo Phase 4 orchestrator CLI

Commands:
  agent run "<goal>"            Run the internal Swarm Autopilot as one coding agent
  agent plan "<goal>"           Create an automatic StaffingPlan and work graph
  agent inspect-run <run_id>    Inspect a swarm run
  agent report <run_id>         Show a swarm final report
  agent resume <run_id>         Reconcile a saved swarm run
  agent trial staffing-eval     Run automatic staffing eval scenarios
  agent trial compare "<goal>"  Compare baseline, orchestrated, and autopilot modes
  agent trial scheduler-scale   Stress scheduler with 300 scripted read-only test work items
  agent trial architecture-scan Read-only architecture trial with automatic staffing
  agent trial test-discovery    Read-only source/test mapping trial
  agent trial small-safe-fix "<goal>"
                                  Run a narrow safe-fix trial without manual agent count
  agent trial huge-readonly-scan
                                  Read-only high-capacity scan when justified
  swarm inspect <run_id>        Debug/admin: inspect raw swarm artifacts
  swarm staffing-plan <run_id>  Debug/admin: show internal staffing plan
  swarm scheduler-trace <id>    Debug/admin: show scheduler decisions
  swarm metrics <run_id>        Debug/admin: show swarm metrics
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
  --mode <auto|fast|deep|exhaustive>
                                  Execution mode for run/plan
  --agent-limit <n>              Advanced override; capped at 300 and cannot bypass executor limits
  --artifact <path>              Artifact path for show-artifact
  --json                         Print JSON
`);
}
