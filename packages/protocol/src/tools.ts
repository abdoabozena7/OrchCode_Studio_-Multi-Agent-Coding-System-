import type { CommandRisk } from "./models.js";

export type ToolDefinition = {
  name: string;
  description: string;
  risk: CommandRisk;
  enabled: boolean;
};

export type ToolExecutionPolicy = {
  dangerousBlocked: boolean;
  mediumRequiresApproval: boolean;
};

export type RuntimeToolName =
  | "workspace.list_files"
  | "workspace.read_file"
  | "workspace.search_code"
  | "workspace.get_project_summary"
  | "git.status"
  | "git.diff"
  | "command.request_run"
  | "patch.propose"
  | "patch.validate";

export type RuntimeToolCall = {
  id: string;
  sessionId: string;
  toolName: RuntimeToolName;
  status: "pending" | "running" | "success" | "error" | "blocked";
  inputSummary?: string;
  outputSummary?: string;
  createdAt: string;
};
