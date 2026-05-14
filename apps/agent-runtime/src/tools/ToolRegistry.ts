import type { ToolCall, WorkerCapabilityGrant } from "@orchcode/protocol";
import { randomUUID } from "node:crypto";
import { GitTools } from "./GitTools.js";
import { WorkspaceTools } from "./WorkspaceTools.js";
import { CommandTools } from "./CommandTools.js";
import { PatchTools } from "./PatchTools.js";

export class ToolRegistry {
  readonly workspace: WorkspaceTools;
  readonly git: GitTools;
  readonly command: CommandTools;
  readonly patch: PatchTools;

  constructor(private readonly workspacePath: string, private readonly grant?: WorkerCapabilityGrant) {
    this.workspace = new WorkspaceTools(workspacePath, grant);
    this.git = new GitTools(workspacePath);
    this.command = new CommandTools(workspacePath, grant);
    this.patch = new PatchTools(workspacePath, grant);
  }

  createToolCall(input: {
    sessionId: string;
    toolName: ToolCall["toolName"];
    status?: ToolCall["status"];
    inputSummary?: string;
    outputSummary?: string;
  }): ToolCall {
    return {
      id: `tool_${randomUUID()}`,
      sessionId: input.sessionId,
      toolName: input.toolName,
      status: input.status ?? "success",
      inputSummary: input.inputSummary,
      outputSummary: input.outputSummary,
      createdAt: new Date().toISOString()
    };
  }

  getWorkspacePath() {
    return this.workspacePath;
  }
}
