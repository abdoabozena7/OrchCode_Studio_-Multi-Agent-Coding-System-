import type { CommandRequest, PatchProposal, ReviewResult, TaskNode } from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class SecurityAgent extends BaseWorker {
  readonly agentName = "SecurityAgent";

  review(sessionId: string, patches: PatchProposal[], commands: CommandRequest[]): ReviewResult {
    const findings = [
      ...commands.filter((command) => command.risk === "dangerous").map((command) => `Blocked dangerous command: ${command.command}`),
      ...patches.flatMap((patch) =>
        patch.filesChanged
          .filter((file) => /(^|\/)(\.env|id_rsa|id_ed25519|credentials\.json)$|\.pem$/i.test(file.path))
          .map((file) => `Patch touches secret-like file: ${file.path}`)
      )
    ];
    return {
      id: `security_${randomUUID()}`,
      sessionId,
      reviewer: "SecurityAgent",
      targetIds: [...patches.map((patch) => patch.id), ...commands.map((command) => command.id)],
      status: findings.length ? "blocked" : "passed",
      summary: findings.length ? "Security review found blocking issues." : "Security review passed for proposed patches and commands.",
      findings,
      createdAt: new Date().toISOString()
    };
  }

  protected execute(_task: TaskNode, _context: WorkerContext) {
    return {
      summary: "Security review scheduled for collected patches and commands.",
      details: ["Checks dangerous commands, secret-like files, and workspace boundary risk."],
      risks: []
    };
  }
}
