import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import type { CommandExecutionRecord } from "@orchcode/protocol";
import { classifyCommandRisk } from "../tools/CommandPolicy.js";

export class CommandExecutor {
  run(sessionId: string, command: string, cwd: string, requestId?: string): CommandExecutionRecord {
    const risk = classifyCommandRisk(command, cwd);
    if (risk === "dangerous") {
      return {
        id: `cmd_exec_${randomUUID()}`,
        sessionId,
        requestId,
        autoRun: true,
        command,
        cwd,
        risk,
        status: "blocked",
        exitCode: undefined,
        stdout: "",
        stderr: "",
        message: "Dangerous command blocked by runtime policy",
        createdAt: new Date().toISOString()
      };
    }
    if (risk === "medium") {
      return {
        id: `cmd_exec_${randomUUID()}`,
        sessionId,
        requestId,
        autoRun: true,
        command,
        cwd,
        risk,
        status: "approval_required",
        exitCode: undefined,
        stdout: "",
        stderr: "",
        message: "Medium-risk commands still require explicit approval.",
        createdAt: new Date().toISOString()
      };
    }

    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8"
    });

    return {
      id: `cmd_exec_${randomUUID()}`,
      sessionId,
      requestId,
      autoRun: true,
      command,
      cwd,
      risk,
      status: result.status === 0 ? "executed" : "failed",
      exitCode: result.status ?? undefined,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      message: result.error?.message,
      createdAt: new Date().toISOString()
    };
  }

  runInBackground(sessionId: string, command: string, cwd: string, requestId?: string): CommandExecutionRecord {
    const risk = classifyCommandRisk(command, cwd);
    if (risk !== "safe") {
      return {
        id: `cmd_exec_${randomUUID()}`,
        sessionId,
        requestId,
        autoRun: true,
        command,
        cwd,
        risk,
        status: risk === "dangerous" ? "blocked" : "approval_required",
        exitCode: undefined,
        stdout: "",
        stderr: "",
        message:
          risk === "dangerous"
            ? "Dangerous command blocked by runtime policy"
            : "Only safe commands can start in the background automatically.",
        createdAt: new Date().toISOString()
      };
    }

    if (process.env.ORCHCODE_DISABLE_BACKGROUND_COMMANDS === "1") {
      return {
        id: `cmd_exec_${randomUUID()}`,
        sessionId,
        requestId,
        autoRun: true,
        command,
        cwd,
        risk,
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        message: "Skipped background process launch because ORCHCODE_DISABLE_BACKGROUND_COMMANDS=1.",
        createdAt: new Date().toISOString()
      };
    }

    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    return {
      id: `cmd_exec_${randomUUID()}`,
      sessionId,
      requestId,
      autoRun: true,
      command,
      cwd,
      risk,
      status: "executed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      message: `Started background process ${child.pid ?? "unknown"}.`,
      createdAt: new Date().toISOString()
    };
  }
}
