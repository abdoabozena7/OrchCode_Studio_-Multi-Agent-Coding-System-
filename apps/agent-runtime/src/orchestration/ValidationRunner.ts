import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";
import type { CommandInventory, CommandInventoryEntry, CommandKind } from "../memory/types.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { OrchestratorEvent, Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { VerificationResult } from "./StructuredOutputs.js";
import { validateStructuredOutput } from "./StructuredOutputs.js";

export type ValidationCommandRun = {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "blocked" | "timed_out";
  exit_code?: number | null;
  risk: string;
  log_ref?: string;
  started_at: string;
  finished_at: string;
  summary: string;
};

export type ValidationRunnerEvent = Omit<OrchestratorEvent, "id" | "created_at">;

export class ValidationRunner {
  constructor(
    private readonly workspacePath: string,
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly config: Pick<OrchestrationSafetyConfig, "validation_timeout" | "max_validation_log_size" | "safe_commands_allowlist">
  ) {}

  async runForTask(input: {
    runId: string;
    task: Task;
    commandInventory?: CommandInventory;
    onEvent?: (event: ValidationRunnerEvent) => Promise<void>;
  }): Promise<VerificationResult> {
    const selected = selectValidationCommands({
      workspacePath: this.workspacePath,
      task: input.task,
      commandInventory: input.commandInventory,
      allowlist: this.config.safe_commands_allowlist
    });
    const runs: ValidationCommandRun[] = [];
    if (!selected.length) {
      const result: VerificationResult = {
        commands_run: [],
        passed: true,
        failed_commands: [],
        logs_refs: [],
        summary: "No safe validation commands were available for this task.",
        next_action: "no_validation_available"
      };
      assertVerificationResult(result);
      return result;
    }
    for (const command of selected) {
      await input.onEvent?.({
        run_id: input.runId,
        task_id: input.task.id,
        type: "validation.command_started",
        message: `Validation command started: ${command.command}`,
        payload: { command: command.command, cwd: command.cwd }
      });
      const run = command.blocked_reason
        ? await this.blockedRun(input.runId, input.task.id, command, command.blocked_reason)
        : await this.executeCommand(input.runId, input.task.id, command);
      runs.push(run);
      await input.onEvent?.({
        run_id: input.runId,
        task_id: input.task.id,
        type: "validation.command_completed",
        message: `Validation command ${run.status}: ${run.command}`,
        payload: { command: run.command, cwd: run.cwd, status: run.status, exit_code: run.exit_code, log_ref: run.log_ref }
      });
    }
    const failed = runs.filter((run) => run.status === "failed" || run.status === "timed_out");
    const blocked = runs.filter((run) => run.status === "blocked");
    const result: VerificationResult = {
      commands_run: runs.map((run) => ({
        command: run.command,
        cwd: run.cwd,
        status: run.status,
        exit_code: run.exit_code
      })),
      passed: failed.length === 0 && (blocked.length === 0 || blocked.length < runs.length),
      failed_commands: failed.map((run) => run.command),
      logs_refs: runs.flatMap((run) => run.log_ref ? [run.log_ref] : []),
      summary: failed.length
        ? `${failed.length} validation command(s) failed.`
        : blocked.length
          ? `${blocked.length} validation command(s) were blocked by safety policy; no failures were observed.`
          : `${runs.length} validation command(s) passed.`,
      next_action: failed.length ? "repair" : blocked.length ? "manual_review" : "accept"
    };
    assertVerificationResult(result);
    const artifact = await this.artifactStore.saveValidationArtifact(input.runId, `${input.task.id}_verification`, {
      task_id: input.task.id,
      result,
      runs
    });
    result.logs_refs.push(artifact);
    return result;
  }

  private async executeCommand(runId: string, taskId: string, command: SelectedValidationCommand): Promise<ValidationCommandRun> {
    const startedAt = new Date().toISOString();
    const cwd = resolveCwd(this.workspacePath, command.cwd);
    const output = await spawnWithTimeout(command.command, cwd, this.config.validation_timeout, this.config.max_validation_log_size);
    const finishedAt = new Date().toISOString();
    const log = [
      `$ ${command.command}`,
      `cwd: ${cwd}`,
      `status: ${output.timedOut ? "timed_out" : output.exitCode === 0 ? "passed" : "failed"}`,
      `exit_code: ${output.exitCode ?? ""}`,
      "",
      "stdout:",
      output.stdout,
      "",
      "stderr:",
      output.stderr
    ].join("\n");
    const logRef = await this.artifactStore.saveValidationLog(runId, `${taskId}_${safeId(`${command.cwd}_${command.command}`)}`, log);
    return {
      command: command.command,
      cwd: command.cwd,
      status: output.timedOut ? "timed_out" : output.exitCode === 0 ? "passed" : "failed",
      exit_code: output.exitCode,
      risk: command.risk,
      log_ref: logRef,
      started_at: startedAt,
      finished_at: finishedAt,
      summary: output.timedOut ? "Command timed out." : output.exitCode === 0 ? "Command passed." : "Command failed."
    };
  }

  private async blockedRun(runId: string, taskId: string, command: SelectedValidationCommand, reason: string): Promise<ValidationCommandRun> {
    const now = new Date().toISOString();
    const logRef = await this.artifactStore.saveValidationLog(runId, `${taskId}_${safeId(`${command.cwd}_${command.command}`)}_blocked`, [
      `$ ${command.command}`,
      `cwd: ${command.cwd}`,
      "status: blocked",
      `reason: ${reason}`
    ].join("\n"));
    return {
      command: command.command,
      cwd: command.cwd,
      status: "blocked",
      risk: command.risk,
      log_ref: logRef,
      started_at: now,
      finished_at: now,
      summary: reason
    };
  }
}

export type SelectedValidationCommand = {
  command: string;
  cwd: string;
  kind: CommandKind | "fallback";
  risk: string;
  blocked_reason?: string;
};

export function selectValidationCommands(input: {
  workspacePath: string;
  task: Task;
  commandInventory?: CommandInventory;
  allowlist: string[];
}): SelectedValidationCommand[] {
  const inventoryEntries = input.commandInventory?.commands ?? [];
  const requested = new Set(input.task.validation_commands);
  const candidates = inventoryEntries
    .filter((entry) => !requested.size || requested.has(entry.command))
    .filter((entry) => ["test", "lint", "typecheck", "build", "smoke"].includes(entry.kind))
    .sort((left, right) => priority(left.kind) - priority(right.kind) || left.command.localeCompare(right.command))
    .slice(0, 2)
    .map((entry) => selectedFromEntry(input.workspacePath, entry, input.allowlist));
  if (existsSync(path.join(input.workspacePath, ".git"))) {
    candidates.unshift(selectedFromEntry(input.workspacePath, {
      id: "cmd_git_diff_check",
      kind: "smoke",
      command: "git diff --check",
      cwd: ".",
      sourceFile: ".git",
      source: "ci",
      confidence: "high"
    }, input.allowlist));
  }
  return dedupeSelected(candidates);
}

function selectedFromEntry(workspacePath: string, entry: CommandInventoryEntry, allowlist: string[]): SelectedValidationCommand {
  const risk = classifyCommandRisk(entry.command, workspacePath);
  const allowed = risk === "safe" && commandAllowed(entry.command, allowlist);
  return {
    command: entry.command,
    cwd: entry.cwd || ".",
    kind: entry.kind,
    risk,
    blocked_reason: allowed ? undefined : `Command is not allowed for automatic validation (risk=${risk}).`
  };
}

function commandAllowed(command: string, allowlist: string[]) {
  const normalized = command.trim().toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return normalized === allowed || normalized.startsWith(`${allowed} `);
  });
}

function priority(kind: CommandKind) {
  return kind === "test" ? 0 : kind === "typecheck" ? 1 : kind === "lint" ? 2 : kind === "build" ? 3 : 4;
}

function dedupeSelected(commands: SelectedValidationCommand[]) {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.cwd}:${command.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveCwd(workspacePath: string, cwd: string) {
  const workspace = path.resolve(workspacePath);
  const resolved = path.resolve(workspace, cwd);
  const relative = path.relative(workspace, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Validation cwd outside workspace: ${cwd}`);
  return resolved;
}

function spawnWithTimeout(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (exitCode: number | null, timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: truncate(stdout, maxOutputBytes),
        stderr: truncate(stderr, maxOutputBytes),
        timedOut
      });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, true);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = truncate(stdout + chunk.toString("utf8"), maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = truncate(stderr + chunk.toString("utf8"), maxOutputBytes);
    });
    child.on("error", (error) => {
      stderr = truncate(`${stderr}\n${error.message}`, maxOutputBytes);
      finish(1, false);
    });
    child.on("close", (code) => finish(code, false));
  });
}

function truncate(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return `${value.slice(0, maxBytes)}\n[truncated]`;
}

function assertVerificationResult(result: VerificationResult) {
  const validation = validateStructuredOutput("VerificationResult", result);
  if (!validation.valid) throw new Error(`VerificationResult validation failed: ${validation.errors.join("; ")}`);
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "command";
}
