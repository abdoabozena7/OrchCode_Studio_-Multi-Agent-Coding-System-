import path from "node:path";
import { CampaignManager } from "./CampaignManager.js";
import type { ExecutionMode } from "./OrchestrationConfig.js";

type CliOptions = {
  workspace: string;
  memoryDir?: string;
  json: boolean;
  mode: ExecutionMode;
  dryRun: boolean;
};

const { command, positional, options } = parseArgs(process.argv.slice(2));

try {
  const manager = new CampaignManager(options.workspace, options.memoryDir);
  if (command === "create") {
    const goal = positional.join(" ").trim();
    if (!goal) throw new Error("campaign create requires a goal");
    print(options, await manager.create(goal));
  } else if (command === "plan") {
    print(options, await manager.plan(requireId(positional, "campaign plan")));
  } else if (command === "run-next") {
    print(options, await manager.runNext(requireId(positional, "campaign run-next"), {
      mode: options.mode,
      dryRun: options.dryRun
    }));
  } else if (command === "status") {
    print(options, await manager.status(requireId(positional, "campaign status")));
  } else if (command === "pause") {
    print(options, await manager.pause(requireId(positional, "campaign pause")));
  } else if (command === "resume") {
    print(options, await manager.resume(requireId(positional, "campaign resume")));
  } else if (command === "report") {
    print(options, await manager.report(requireId(positional, "campaign report")));
  } else if (command === "metrics") {
    print(options, await manager.metrics(requireId(positional, "campaign metrics")));
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
    mode: "deep",
    dryRun: false
  };
  const positional: string[] = [];
  let command = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = resolveFromCwd(args[++index] ?? ".");
    } else if (arg === "--memory-dir") {
      options.memoryDir = args[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mode") {
      options.mode = parseMode(args[++index] ?? "deep");
    } else if (arg === "--dry-run") {
      options.dryRun = true;
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

function requireId(positional: string[], commandName: string) {
  const id = positional[0];
  if (!id) throw new Error(`${commandName} requires a campaign id`);
  return id;
}

function parseMode(value: string): ExecutionMode {
  if (value === "fast" || value === "deep" || value === "exhaustive") return value;
  throw new Error(`Unknown execution mode: ${value}`);
}

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function print(options: CliOptions, value: unknown) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(formatHuman(value));
  }
}

function formatHuman(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => `- ${formatHuman(entry).replace(/\n/g, "\n  ")}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => `${key}: ${entry && typeof entry === "object" ? `\n  ${formatHuman(entry).replace(/\n/g, "\n  ")}` : String(entry)}`)
      .join("\n");
  }
  return String(value);
}

function printHelp() {
  console.log(`OrchCode campaign CLI

Commands:
  create "<goal>"          Create a campaign
  plan <campaign_id>       Create milestones
  run-next <campaign_id>   Run the next milestone through the orchestrator
  status <campaign_id>     Show campaign state
  pause <campaign_id>      Pause operator-driven progress
  resume <campaign_id>     Resume a paused campaign
  report <campaign_id>     Generate/read campaign report
  metrics <campaign_id>    Generate/read campaign metrics

Options:
  --workspace <path>       Workspace root
  --memory-dir <path>      Memory directory
  --mode <fast|deep|exhaustive>
  --dry-run                Mark what would run without invoking agents
  --json                   Print JSON
`);
}
