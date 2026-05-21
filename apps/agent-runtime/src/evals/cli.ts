import path from "node:path";
import { runPhase4Evals } from "./phase4.js";

const options = parseArgs(process.argv.slice(2));
try {
  const result = await runPhase4Evals({
    workspacePath: options.workspace,
    memoryDir: options.memoryDir
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Phase 4 evals: ${result.passed}/${result.total} passed`);
    for (const entry of result.results) {
      console.log(`- ${entry.passed ? "PASS" : "FAIL"} ${entry.title}: ${entry.summary}`);
    }
  }
  if (result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(args: string[]) {
  const options: { workspace: string; memoryDir?: string; json: boolean } = {
    workspace: process.cwd(),
    json: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = resolveFromCwd(args[++index] ?? ".");
    } else if (arg === "--memory-dir") {
      options.memoryDir = args[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  options.workspace = path.resolve(options.workspace);
  return options;
}

function resolveFromCwd(value: string) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
