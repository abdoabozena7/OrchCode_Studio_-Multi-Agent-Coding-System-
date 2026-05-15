import { randomUUID } from "node:crypto";
import type { CommandExecutionRecord } from "@orchcode/protocol";
import { classifyCommandRisk, looksLikeBackgroundCommand, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";

export class CommandExecutor {
  run(sessionId: string, command: string, cwd: string, requestId?: string): CommandExecutionRecord {
    const risk = classifyCommandRisk(command, cwd);
    if (risk === "dangerous") {
      return buildRecord(sessionId, command, cwd, requestId, risk, "blocked", "Dangerous command blocked by runtime policy before execution.");
    }
    if (risk === "medium") {
      return buildRecord(
        sessionId,
        command,
        cwd,
        requestId,
        risk,
        "approval_required",
        buildDeferredExecutionMessage(command, "Medium-risk command recorded but not executed.")
      );
    }

    return buildRecord(
      sessionId,
      command,
      cwd,
      requestId,
      risk,
      "approval_required",
      buildDeferredExecutionMessage(command, "Command recorded but not executed by the Node runtime.")
    );
  }

  runInBackground(sessionId: string, command: string, cwd: string, requestId?: string): CommandExecutionRecord {
    const risk = classifyCommandRisk(command, cwd);
    if (risk !== "safe") {
      return buildRecord(
        sessionId,
        command,
        cwd,
        requestId,
        risk,
        risk === "dangerous" ? "blocked" : "approval_required",
        risk === "dangerous"
          ? "Dangerous background command blocked by runtime policy before execution."
          : buildDeferredExecutionMessage(command, "Background command recorded but not executed.")
      );
    }

    return buildRecord(
      sessionId,
      command,
      cwd,
      requestId,
      risk,
      "approval_required",
      buildDeferredExecutionMessage(command, "Background command recorded but not executed.")
    );
  }
}

function buildRecord(
  sessionId: string,
  command: string,
  cwd: string,
  requestId: string | undefined,
  risk: CommandExecutionRecord["risk"],
  status: CommandExecutionRecord["status"],
  message: string
): CommandExecutionRecord {
  return {
    id: `cmd_exec_${randomUUID()}`,
    sessionId,
    requestId,
    autoRun: false,
    command,
    cwd,
    risk,
    status,
    exitCode: undefined,
    stdout: "",
    stderr: "",
    message,
    provenance: {
      source: "agent",
      trigger: "manual",
      sessionId,
      requestId,
      requestedBy: "agent",
      approvalSource: status === "blocked" ? "denied" : "none",
      policyDecision:
        status === "blocked"
          ? "deny"
          : status === "approval_required"
            ? "require_approval"
            : "allow",
      policyReason: message,
      executionAuthority: "runtime",
      background: looksLikeBackgroundCommand(command),
      networkDetected: looksLikeNetworkCommand(command),
      backgroundDetected: looksLikeBackgroundCommand(command),
      detectionSource: "heuristic",
      networkDetectionSource: "heuristic",
      backgroundDetectionSource: "heuristic",
      backgroundTrackingLimited: looksLikeBackgroundCommand(command)
    },
    createdAt: new Date().toISOString()
  };
}

function buildDeferredExecutionMessage(command: string, summary: string) {
  const normalized = command.trim().toLowerCase();
  const notes = ["Rust terminal approval/execution is still required."];
  if (looksLikeNetworkCommand(normalized)) {
    notes.push("Network access was detected.");
  }
  if (looksLikeBackgroundCommand(normalized)) {
    notes.push("Background or long-running process behavior was detected.");
  }
  return `${summary} ${notes.join(" ")}`.trim();
}
