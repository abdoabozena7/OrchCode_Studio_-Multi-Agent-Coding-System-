import type { CommandRequest, WorkerCapabilityGrant } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "./CommandPolicy.js";
import { assertGrantAllowsTool } from "./security.js";

export class CommandTools {
  constructor(private readonly workspacePath: string, private readonly grant?: WorkerCapabilityGrant) {}

  requestRun(sessionId: string, command: string, reason: string): CommandRequest {
    assertGrantAllowsTool(this.grant, "command.request_run");
    if (this.grant) {
      if (!this.grant.canRequestCommands) throw new Error("Capability grant does not allow command requests");
    }
    const risk = classifyCommandRisk(command, this.workspacePath);
    if (this.grant && !this.grant.allowedCommandRisks.includes(risk)) {
      throw new Error(`Capability grant does not allow ${risk} commands`);
    }
    const normalized = command.toLowerCase();
    if (this.grant && !this.grant.allowNetwork && looksLikeNetworkCommand(normalized)) {
      throw new Error("Capability grant does not allow network commands");
    }
    const provenance = [
      "Requested only; Rust terminal authority must approve and execute this command."
    ];
    if (looksLikeNetworkCommand(normalized)) {
      provenance.push("Network access detected.");
    }
    if (looksLikeBackgroundCommand(normalized)) {
      provenance.push("Long-running or background process behavior detected.");
    }
    return {
      id: `cmd_${randomUUID()}`,
      sessionId,
      command,
      cwd: this.workspacePath,
      risk,
      reason: `${reason} ${provenance.join(" ")}`.trim(),
      status: risk === "dangerous" ? "blocked" : "requested",
      createdAt: new Date().toISOString()
    };
  }
}
