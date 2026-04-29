import type { CommandRequest } from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import { classifyCommandRisk } from "./CommandPolicy.js";

export class CommandTools {
  constructor(private readonly workspacePath: string) {}

  requestRun(sessionId: string, command: string, reason: string): CommandRequest {
    const risk = classifyCommandRisk(command, this.workspacePath);
    return {
      id: `cmd_${randomUUID()}`,
      sessionId,
      command,
      cwd: this.workspacePath,
      risk,
      reason,
      status: risk === "dangerous" ? "blocked" : "requested",
      createdAt: new Date().toISOString()
    };
  }
}
