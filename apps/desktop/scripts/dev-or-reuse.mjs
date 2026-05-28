import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const devUrl = "http://127.0.0.1:1420/";
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const freshLaunch = process.argv.includes("--fresh") || process.env.HIVO_DEV_FRESH === "1" || process.env.ORCHCODE_DEV_FRESH === "1";

if (freshLaunch) {
  await stopDevProcessOnPort(1420, "desktop dev server");
}

if (!freshLaunch && await isDevServerHealthy()) {
  process.stdout.write("Desktop dev server already running on 127.0.0.1:1420. Reusing it.\n");
  process.exit(0);
}

const child = spawn(`${npmCommand} run dev`, [], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: true
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

async function isDevServerHealthy() {
  try {
    const response = await fetch(devUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function stopDevProcessOnPort(port, name) {
  const processIds = findProcessIdsOnPort(port).filter((pid) => pid && pid !== process.pid);
  if (!processIds.length) return;
  process.stdout.write(`Fresh dev launch: stopping existing ${name} on 127.0.0.1:${port} (${processIds.join(", ")}).\n`);
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
      { encoding: "utf8" }
    );
    return parseProcessIds(result.stdout);
  }

  const lsof = spawnSync("sh", ["-lc", `lsof -ti tcp:${port} 2>/dev/null || true`], {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
