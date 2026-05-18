import { spawn } from "node:child_process";
import process from "node:process";

const devUrl = "http://127.0.0.1:1420/";
const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";

if (await isDevServerHealthy()) {
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
