import type {
  AgentStatus,
  CommandRequest,
  CommandResult,
  GitStatus,
  ModelProviderConfig,
  PatchProposal,
  Session,
  Task,
  ToolCall,
  WorkspaceInfo
} from "./models";
import type { AgentLifecycleStage, AgentRuntimeSession } from "./agent-runtime.js";
import type { OrchestrationEvent, PatchChangeStats, RunSummary, RuntimeProgressEvent } from "./orchestration.js";

export type AppEvent =
  | { type: "workspace.updated"; workspace: WorkspaceInfo }
  | { type: "git.status.updated"; status: GitStatus }
  | { type: "command.completed"; result: CommandResult }
  | { type: "session.created"; session: Session }
  | { type: "tasks.updated"; sessionId: string; tasks: Task[] }
  | { type: "agents.updated"; sessionId: string; agents: AgentStatus[] }
  | { type: "model_provider.updated"; config?: ModelProviderConfig }
  | { type: "runtime.session.updated"; session: AgentRuntimeSession }
  | { type: "runtime.stage.changed"; sessionId: string; stage: AgentLifecycleStage }
  | { type: "runtime.tool_call.updated"; sessionId: string; toolCall: ToolCall }
  | { type: "runtime.patch.proposed"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.stats.updated"; sessionId: string; patchId: string; stats: PatchChangeStats[] }
  | { type: "runtime.command.requested"; sessionId: string; commandRequest: CommandRequest }
  | { type: "runtime.orchestration.event"; sessionId: string; event: OrchestrationEvent }
  | { type: "runtime.progress.updated"; sessionId: string; progress: RuntimeProgressEvent }
  | { type: "runtime.run.completed"; sessionId: string; summary: RunSummary };
