import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const dryRun = process.argv.includes("--dry-run");
const reuseLaunch = process.argv.includes("--reuse") || process.env.ORCHCODE_DEV_REUSE === "1";
const freshLaunch = !reuseLaunch || process.argv.includes("--fresh") || process.env.ORCHCODE_DEV_FRESH === "1";

const runtimeArgs = ["run", "dev", "-w", "@orchcode/agent-runtime"];
const desktopArgs = ["run", "tauri:dev", "-w", "@orchcode/desktop"];
const runtimeHealthUrl = "http://127.0.0.1:4317/health";

const children = [];

if (dryRun) {
  process.stdout.write(`fresh: ${freshLaunch ? "yes" : "no"}\n`);
  process.stdout.write(`runtime: ${npmCommand} ${runtimeArgs.join(" ")}\n`);
  process.stdout.write(`desktop: ${npmCommand} ${desktopArgs.join(" ")}\n`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown(0, "SIGINT"));
process.on("SIGTERM", () => shutdown(0, "SIGTERM"));

await main();

async function main() {
  if (freshLaunch) {
    process.env.ORCHCODE_DEV_FRESH = "1";
    stopDesktopProcess();
    await stopDevProcessOnPort(4317, "runtime");
  }

  const runtimeAlreadyHealthy = await isRuntimeHealthy();
  if (runtimeAlreadyHealthy) {
    process.stdout.write("Runtime already running on 127.0.0.1:4317. Reusing it because --reuse was requested.\n");
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

function stopDesktopProcess() {
  if (isWindows) {
    spawnSync("taskkill", ["/IM", "orchcode-desktop.exe", "/F", "/T"], {
      cwd: root,
      stdio: "ignore"
    });
    return;
  }

  spawnSync("pkill", ["-f", "orchcode-desktop"], {
    cwd: root,
    stdio: "ignore"
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopDevProcessOnPort(port, name) {
  const processIds = findProcessIdsOnPort(port).filter((pid) => pid && pid !== process.pid);
  if (!processIds.length) return;
  process.stdout.write(`Fresh dev launch: stopping existing ${name} process on 127.0.0.1:${port} (${processIds.join(", ")}).\n`);
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between discovery and shutdown.
    }
  }
  await sleep(800);
  for (const pid of processIds) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore cleanup races.
    }
  }
}

function findProcessIdsOnPort(port) {
  if (isWindows) {
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
      ],
      { cwd: root, encoding: "utf8" }
    );
    return parseProcessIds(result.stdout);
  }

  const lsof = spawnSync("sh", ["-lc", `lsof -ti tcp:${port} 2>/dev/null || true`], {
    cwd: root,
    encoding: "utf8"
  });
  return parseProcessIds(lsof.stdout);
}

function parseProcessIds(value) {
  return [...new Set((value ?? "").split(/\s+/).map((entry) => Number(entry)).filter(Number.isInteger))];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
