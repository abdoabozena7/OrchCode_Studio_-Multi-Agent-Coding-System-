import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const dryRun = process.argv.includes("--dry-run");

const runtimeArgs = ["run", "dev", "-w", "@orchcode/agent-runtime"];
const desktopArgs = ["run", "tauri:dev", "-w", "@orchcode/desktop"];
const runtimeHealthUrl = "http://127.0.0.1:4317/health";

const children = [];

if (dryRun) {
  process.stdout.write(`runtime: ${npmCommand} ${runtimeArgs.join(" ")}\n`);
  process.stdout.write(`desktop: ${npmCommand} ${desktopArgs.join(" ")}\n`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown(0, "SIGINT"));
process.on("SIGTERM", () => shutdown(0, "SIGTERM"));

await main();

async function main() {
  const runtimeAlreadyHealthy = await isRuntimeHealthy();
  if (runtimeAlreadyHealthy) {
    process.stdout.write("Runtime already running on 127.0.0.1:4317. Reusing it.\n");
  } else {
    start("runtime", runtimeArgs);
    const becameHealthy = await waitForRuntime();
    if (!becameHealthy) {
      process.stderr.write("Runtime did not become healthy on 127.0.0.1:4317.\n");
    }
  }

  if (isDesktopAlreadyRunning()) {
    process.stdout.write("OrchCode desktop is already running. Skipping duplicate launch.\n");
    return;
  }

  start("desktop", desktopArgs);
}

function start(name, args) {
  const command = `${npmCommand} ${args.join(" ")}`;
  const child = spawn(command, [], {
    cwd: root,
    stdio: "inherit",
    shell: true
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (name === "desktop") {
      shutdown(code ?? 0, signal);
    }
  });
  return child;
}

function shutdown(code = 0, signal) {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore cleanup errors during shutdown.
      }
    }
  }
  if (signal) {
    process.exitCode = code;
    return;
  }
  process.exit(code);
}

async function isRuntimeHealthy() {
  try {
    const response = await fetch(runtimeHealthUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForRuntime() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (await isRuntimeHealthy()) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

function isDesktopAlreadyRunning() {
  if (isWindows) {
    const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq orchcode-desktop.exe"], {
      cwd: root,
      encoding: "utf8"
    });
    return /orchcode-desktop\.exe/i.test(result.stdout ?? "");
  }

  const result = spawnSync("pgrep", ["-f", "orchcode-desktop"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
