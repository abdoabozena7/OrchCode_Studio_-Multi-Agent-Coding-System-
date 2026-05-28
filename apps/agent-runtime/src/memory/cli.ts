import path from "node:path";
import {
  cleanRunArtifacts,
  compactMemory,
  explainTaskMemory,
  getCommandInventory,
  getDecisions,
  getFailedAttempts,
  getMemoryLessons,
  inspectRepoIndex,
  loadMemory,
  readJson,
  resolveMemoryPaths
} from "./ProjectMemory.js";
import { assessIndexFreshness, refreshRepoIndex } from "./IndexFreshness.js";
import { explainIndexedFile } from "./ProjectIntelligence.js";
import { rebuildRepoIndex } from "./RepoIndexer.js";
import type { ProjectIntelligence } from "./types.js";

type CliOptions = {
  workspace: string;
  memoryDir?: string;
  json: boolean;
  limit: number;
  olderThanDays?: number;
  changedOnly: boolean;
};

const args = process.argv.slice(2);
const { command, positional, options } = parseArgs(args);

try {
  if (command === "index repo" || command === "index" || command === "rebuild") {
    const snapshot = await rebuildRepoIndex(options.workspace, { memoryDir: options.memoryDir });
    print(options, {
      status: "indexed",
      workspace: options.workspace,
      memoryDir: options.memoryDir ?? ".agent_memory",
      indexedFiles: snapshot.repoIndex.totals.indexedFiles,
      sourceFiles: snapshot.repoIndex.totals.sourceFiles,
      testFiles: snapshot.repoIndex.totals.testFiles,
      symbols: snapshot.symbolIndex.symbols.length,
      commands: snapshot.commandInventory.commands.length,
      entrypoints: snapshot.repoIndex.entrypoints.slice(0, options.limit)
    });
  } else if (command === "index status") {
    print(options, await assessIndexFreshness(options.workspace, options.memoryDir));
  } else if (command === "index refresh") {
    const result = await refreshRepoIndex(options.workspace, {
      memoryDir: options.memoryDir,
      changedOnly: options.changedOnly
    });
    print(options, {
      status: "refreshed",
      mode: result.mode,
      before: result.before,
      after: result.after,
      indexedFiles: result.snapshot.repoIndex.totals.indexedFiles,
      note: result.note
    });
  } else if (command === "index explain") {
    const filePath = positional.at(-1);
    if (!filePath || filePath === "explain") throw new Error("index explain requires a file path");
    const memoryPaths = resolveMemoryPaths(options.workspace, options.memoryDir);
    const intelligence = await readJson<ProjectIntelligence>(memoryPaths.projectIntelligence);
    print(options, explainIndexedFile(filePath, intelligence));
  } else if (command === "memory inspect" || command === "inspect") {
    const inspection = await inspectRepoIndex(options.workspace, options.memoryDir);
    print(options, {
      status: inspection.status,
      repo: inspection.repoIndex
        ? {
            projectName: inspection.repoIndex.projectName,
            generatedAt: inspection.repoIndex.generatedAt,
            totals: inspection.repoIndex.totals,
            languages: inspection.repoIndex.languages,
            topLevelDirectories: inspection.repoIndex.topLevelDirectories.slice(0, options.limit),
            entrypoints: inspection.repoIndex.entrypoints.slice(0, options.limit),
            importantFiles: inspection.repoIndex.importantFiles.slice(0, options.limit)
          }
        : undefined,
      commands: inspection.commandInventory?.commands.slice(0, options.limit)
    });
  } else if (command === "memory status" || command === "status") {
    print(options, await loadMemory(options.workspace, options.memoryDir));
  } else if (command === "memory show-commands" || command === "show-commands" || command === "commands") {
    const inventory = await getCommandInventory(options.workspace, options.memoryDir);
    if (!inventory) {
      print(options, { status: "missing", message: "No command_inventory.json found. Run memory:index first." });
    } else {
      print(options, {
        generatedAt: inventory.generatedAt,
        packageManagers: inventory.packageManagers,
        byKind: inventory.byKind,
        commands: inventory.commands.slice(0, options.limit)
      });
    }
  } else if (command === "memory clean-runs" || command === "clean-runs") {
    print(options, await cleanRunArtifacts(options.workspace, {
      memoryDir: options.memoryDir,
      olderThanDays: options.olderThanDays
    }));
  } else if (command === "memory compact" || command === "compact") {
    print(options, await compactMemory(options.workspace, options.memoryDir));
  } else if (command === "memory lessons" || command === "lessons") {
    print(options, (await getMemoryLessons(options.workspace, options.memoryDir)).slice(-options.limit));
  } else if (command === "memory decisions" || command === "decisions") {
    print(options, (await getDecisions(options.workspace, options.memoryDir)).slice(-options.limit));
  } else if (command === "memory failed-attempts" || command === "failed-attempts") {
    print(options, (await getFailedAttempts(options.workspace, options.memoryDir)).slice(-options.limit));
  } else if (command === "memory explain-task" || command === "explain-task") {
    const taskId = positional.at(-1);
    if (!taskId || taskId === "explain-task") throw new Error("memory explain-task requires a task id");
    print(options, await explainTaskMemory(options.workspace, taskId, options.memoryDir));
  } else {
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(rawArgs: string[]): { command: string; positional: string[]; options: CliOptions } {
  const positional: string[] = [];
  const options: CliOptions = {
    workspace: process.cwd(),
    json: false,
    limit: 12,
    changedOnly: false
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = resolveFromCwd(rawArgs[++index] ?? ".");
    } else if (arg === "--memory-dir") {
      options.memoryDir = rawArgs[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      options.limit = Number(rawArgs[++index] ?? "12");
    } else if (arg === "--older-than-days") {
      options.olderThanDays = Number(rawArgs[++index] ?? "0");
    } else if (arg === "--changed-only") {
      options.changedOnly = true;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (arg) {
      positional.push(arg);
    }
  }
  options.workspace = path.resolve(options.workspace);
  const command = normalizeCommand(positional);
  return { command, positional, options };
}

function normalizeCommand(positional: string[]) {
  if (!positional.length) return "memory status";
  const [first, second] = positional;
  if (first === "index" && second === "repo") return "index repo";
  if (first === "index" && second === "status") return "index status";
  if (first === "index" && second === "refresh") return "index refresh";
  if (first === "index" && second === "explain") return "index explain";
  if (first === "memory" && second) return `memory ${second}`;
  return positional.join(" ");
}

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function print(options: CliOptions, value: unknown) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (isPlainObject(value)) {
    printObject(value);
    return;
  }
  console.log(String(value));
}

function printObject(value: Record<string, unknown>, indent = "") {
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry)) {
      console.log(`${indent}${key}:`);
      for (const item of entry) {
        console.log(`${indent}  - ${formatInline(item)}`);
      }
    } else if (isPlainObject(entry)) {
      console.log(`${indent}${key}:`);
      printObject(entry, `${indent}  `);
    } else {
      console.log(`${indent}${key}: ${String(entry)}`);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatInline(value: unknown) {
  if (typeof value === "string") return value;
  if (isPlainObject(value)) {
    const command = typeof value.command === "string" ? value.command : undefined;
    const kind = typeof value.kind === "string" ? value.kind : undefined;
    const pathValue = typeof value.path === "string" ? value.path : undefined;
    if (command) return kind ? `[${kind}] ${command}` : command;
    if (pathValue && typeof value.files === "number") return `${pathValue} (${value.files})`;
  }
  return JSON.stringify(value);
}

function printHelp() {
  console.log(`Hivo memory CLI

Commands:
  index repo                 Rebuild .agent_memory repository index
  memory inspect             Print index summary
  memory status              Print memory file status
  memory show-commands       Print detected command inventory
  memory clean-runs          Remove volatile files under .agent_memory/runs
  index status               Report whether repository memory is fresh/stale/missing
  index refresh              Refresh repository memory; supports --changed-only
  index explain <file>       Explain dependencies, dependents, tests, risk, and commands
  memory compact             Compact run history into lessons/patterns/failed attempts
  memory lessons             Show recent lessons learned
  memory decisions           Show recent decisions
  memory failed-attempts     Show recent failed attempts
  memory explain-task <id>   Show memory related to a task id

Options:
  --workspace <path>         Workspace to scan (default: current directory)
  --memory-dir <path>        Memory directory (default: .agent_memory or HIVO_MEMORY_DIR)
  --json                     Print JSON
  --limit <n>                Limit displayed arrays
  --older-than-days <n>      For clean-runs only
  --changed-only             For index refresh; reports changed files then performs full refresh
`);
}
