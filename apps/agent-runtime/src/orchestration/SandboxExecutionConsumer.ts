import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { EnqueueJobInput, QueueJob } from "./TaskQueueTypes.js";
import { SqliteTaskQueueBackend } from "./AgentTaskQueue.js";

export type SandboxExecutionRequest = {
  files: Record<string, string>;
  command: string;
  image: string;
  timeoutMs: number;
  memoryLimit: string;
  cpuLimit: number;
  requirements?: string[];
};

export type SandboxExecutionResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  containerId: string;
  timedOut: boolean;
  oomKilled: boolean;
};

export const SANDBOX_JOB_TYPE = "sandbox_execution";

export class SandboxExecutionConsumer {
  constructor(
    private readonly queue: SqliteTaskQueueBackend,
    private readonly dockerSocket?: string,
    private readonly dockerCmd: string = "docker"
  ) {}

  async pollForever(queueName: string, pollMs: number = 2000): Promise<void> {
    while (true) {
      try {
        const job = await this.queue.dequeue(queueName, pollMs);
        if (!job) continue;
        const request = JSON.parse(job.job.payload_json) as SandboxExecutionRequest;
        const result = await this.execute(request);
        await this.queue.ack(job.job.id, job.lease_id);
        await this.emitSandboxEvent(queueName, job.job, result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[SandboxExecutionConsumer] Error: ${msg}`);
      }
    }
  }

  async execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    const tempDir = path.join(tmpdir(), `sandbox_${randomUUID().slice(0, 12)}`);
    if (!existsSync(tmpdir())) await mkdir(tmpdir(), { recursive: true });
    await mkdir(tempDir, { recursive: true });

    try {
      for (const [filePath, content] of Object.entries(request.files)) {
        const fullPath = path.join(tempDir, filePath);
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) await mkdir(dir, { recursive: true });
        await writeFile(fullPath, content, "utf-8");
      }

      const containerId = randomUUID().slice(0, 12);
      const installCmd = this.buildInstallCommand(request.image, request.requirements);
      const fullCommand = installCmd
        ? `sh -c "${installCmd} 2>/dev/null; ${request.command}"`
        : `sh -c "${request.command}"`;

      const dockerArgs = [
        "run",
        "--name", containerId,
        "--rm",
        "--network", "none",
        "--read-only",
        "--memory", request.memoryLimit,
        "--cpus", String(request.cpuLimit),
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",
        "--mount", `type=bind,source=${tempDir},target=/workspace,ro`,
        "-w", "/workspace",
        request.image,
        "sh", "-c", fullCommand
      ];

      const startTime = Date.now();
      const { stdout, stderr, exitCode, timedOut } = await this.runDockerContainer(dockerArgs, request.timeoutMs);
      const durationMs = Date.now() - startTime;

      return {
        exitCode,
        stdout,
        stderr,
        durationMs,
        containerId,
        timedOut,
        oomKilled: exitCode === null && !timedOut
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runDockerContainer(
    args: string[],
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; oomKilled: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(this.dockerCmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32"
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      const timer = setTimeout(async () => {
        timedOut = true;
        try {
          await this.killContainer(args[1]);
        } catch { /* container already dead */ }
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("close", async (code) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");

        if (timedOut) {
          try {
            const { stderr: killStderr } = await this.execDockerKill(args[1]);
            resolve({ stdout, stderr: stderr + "\n" + killStderr, exitCode: null, timedOut: true, oomKilled: false });
          } catch {
            resolve({ stdout, stderr, exitCode: null, timedOut: true, oomKilled: false });
          }
          return;
        }

        if (code !== 0 && stderr.includes("OOM")) {
          resolve({ stdout, stderr, exitCode: code, timedOut: false, oomKilled: true });
          return;
        }

        resolve({ stdout, stderr, exitCode: code, timedOut: false, oomKilled: false });
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        const msg = `Docker spawn error: ${error.message}`;
        resolve({ stdout: "", stderr: msg, exitCode: null, timedOut: false, oomKilled: false });
      });
    });
  }

  private async killContainer(containerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const kill = spawn(this.dockerCmd, ["kill", containerId], { stdio: "pipe", shell: process.platform === "win32" });
      kill.on("close", (code) => code === 0 ? resolve() : reject(new Error(`docker kill exit ${code}`)));
      kill.on("error", reject);
    });
  }

  private async execDockerKill(containerId: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const kill = spawn(this.dockerCmd, ["kill", containerId], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      kill.stdout?.on("data", (c: Buffer) => out.push(c));
      kill.stderr?.on("data", (c: Buffer) => err.push(c));
      kill.on("close", () => resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
      kill.on("error", reject);
    });
  }

  private buildInstallCommand(image: string, requirements?: string[]): string {
    if (!requirements?.length) return "";
    const pkgs = requirements.join(" ");
    if (/python/i.test(image)) return `pip install -q ${pkgs} 2>/dev/null || true`;
    if (/node/i.test(image)) return `npm install --no-optional ${pkgs} 2>/dev/null || true`;
    return "";
  }

  private async emitSandboxEvent(queueName: string, job: QueueJob, result: SandboxExecutionResult): Promise<void> {
    const eventPayload = {
      job_id: job.id,
      job_type: job.job_type,
      exit_code: result.exitCode,
      stdout_size: result.stdout.length,
      stderr_size: result.stderr.length,
      duration_ms: result.durationMs,
      timed_out: result.timedOut,
      oom_killed: result.oomKilled,
      container_id: result.containerId
    };
    const status = result.exitCode === 0 ? "completed" : result.timedOut ? "timed_out" : "failed";
    console.log(`[Sandbox] ${queueName}: ${job.id} → ${status} (exit=${result.exitCode}, dur=${result.durationMs}ms)`);
  }
}
