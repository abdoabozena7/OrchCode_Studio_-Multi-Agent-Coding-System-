import type {
  AgentStatus,
  Artifact,
  CommandExecutionRecord,
  CommandRequest,
  CommandResult,
  GitStatus,
  ModelProviderConfig,
  PatchProposal,
  Session,
  Task,
  ToolCall,
  ToolIntent,
  VerificationResult,
  WorkspaceInfo
} from "./models.js";
import type { AgentLifecycleStage, AgentRuntimeSession } from "./agent-runtime.js";
import type { OrchestrationEvent, PatchChangeStats, RunSummary, RuntimeProgressEvent } from "./orchestration.js";

export const DURABLE_RUNTIME_EVENT_TYPES = [
  "session.created",
  "session.snapshot_persisted",
  "session.restored",
  "session.expired",
  "session.reconciliation_required",
  "run.phase_changed",
  "agent.created",
  "agent.updated",
  "decision.recorded",
  "evidence.recorded",
  "intent_contract.compiled",
  "product_spec.proposed",
  "product_spec.approved",
  "technical_plan.proposed",
  "technical_plan.approved",
  "recursive_graph.proposed",
  "recursive_graph.ready",
  "recursive_graph.blocked",
  "branch_orchestrator.planned",
  "branch_scope.conflict_detected",
  "branch_execution.ready",
  "branch_execution.started",
  "branch_execution.patch_proposed",
  "branch_execution.reviewing",
  "branch_execution.validation_pending",
  "branch_execution.completed",
  "branch_execution.blocked",
  "branch_execution.failed",
  "branch_result.recorded",
  "semantic_conflict_resolution.updated",
  "recursive_fan_in.updated",
  "recursive_final_report.created",
  "knowledge_tree.created",
  "knowledge_tree.refreshed",
  "knowledge_node.created",
  "edit_route.proposed",
  "edit_route.ready",
  "edit_route.blocked",
  "knowledge_branch_targets.created",
  "knowledge_branch_execution.planned",
  "patch.proposed",
  "patch.approved",
  "patch.rejected",
  "patch.apply_started",
  "patch.applied",
  "patch.apply_failed",
  "patch.reconciled",
  "verification.started",
  "verification.check_completed",
  "verification.completed",
  "command.requested",
  "command.approved",
  "command.denied",
  "command.started",
  "command.completed",
  "command.failed",
  "review_gate.updated"
] as const;

export type DurableRuntimeEventType = (typeof DURABLE_RUNTIME_EVENT_TYPES)[number];
export type DurableRuntimeEventActor = "runtime" | "user" | "rust" | "system" | "desktop_bridge";
export type DurableRuntimeEventAuthority = "runtime" | "rust" | "runtime_bridge" | "system";

export type DurableRuntimeEvent = {
  id: string;
  sessionId: string;
  sequence: number;
  type: DurableRuntimeEventType;
  version: number;
  actor: DurableRuntimeEventActor;
  authority: DurableRuntimeEventAuthority;
  createdAt: string;
  correlationId?: string;
  causationId?: string;
  payload: Record<string, unknown>;
};

export function isDurableRuntimeEventType(value: string): value is DurableRuntimeEventType {
  return (DURABLE_RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}

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
  | { type: "runtime.tool_intent.updated"; sessionId: string; intent: ToolIntent }
  | { type: "runtime.artifact.created"; sessionId: string; artifact: Artifact }
  | { type: "runtime.intent_contract.compiled"; sessionId: string; intentContract: import("./orchestration.js").IntentContract }
  | { type: "runtime.product_spec.proposed"; sessionId: string; productSpec: import("./orchestration.js").ProductSpecification }
  | { type: "runtime.product_spec.approved"; sessionId: string; productSpec: import("./orchestration.js").ProductSpecification }
  | { type: "runtime.technical_plan.proposed"; sessionId: string; technicalPlan: import("./orchestration.js").TechnicalPlan }
  | { type: "runtime.technical_plan.approved"; sessionId: string; technicalPlan: import("./orchestration.js").TechnicalPlan }
  | { type: "runtime.recursive_graph.proposed"; sessionId: string; graph: import("./orchestration.js").HierarchicalRecursiveGraph }
  | { type: "runtime.recursive_graph.ready"; sessionId: string; graph: import("./orchestration.js").HierarchicalRecursiveGraph }
  | { type: "runtime.recursive_graph.blocked"; sessionId: string; graph: import("./orchestration.js").HierarchicalRecursiveGraph }
  | { type: "runtime.branch_orchestrator.planned"; sessionId: string; branch: import("./orchestration.js").BranchOrchestratorRecord }
  | { type: "runtime.branch_scope.conflict_detected"; sessionId: string; conflict: import("./orchestration.js").BranchScopeConflict }
  | { type: "runtime.branch_execution.ready"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.started"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.patch_proposed"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.reviewing"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.validation_pending"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.completed"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.blocked"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_execution.failed"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.branch_result.recorded"; sessionId: string; branchResult: import("./orchestration.js").RecursiveBranchResultRecord }
  | { type: "runtime.semantic_conflict_resolution.updated"; sessionId: string; batch: import("./orchestration.js").SemanticConflictResolutionBatch }
  | { type: "runtime.recursive_fan_in.updated"; sessionId: string; integrationSummary: import("./orchestration.js").RecursiveIntegrationSummary }
  | { type: "runtime.recursive_final_report.created"; sessionId: string; finalReport: import("./orchestration.js").RecursiveFinalReport }
  | { type: "runtime.knowledge_tree.created"; sessionId: string; tree: import("./models.js").ProjectKnowledgeTree }
  | { type: "runtime.knowledge_tree.refreshed"; sessionId: string; tree: import("./models.js").ProjectKnowledgeTree }
  | { type: "runtime.knowledge_node.created"; sessionId: string; node: import("./models.js").ProjectKnowledgeNode }
  | { type: "runtime.edit_route.proposed"; sessionId: string; routedEdit: import("./models.js").KnowledgeRoutedEdit }
  | { type: "runtime.edit_route.ready"; sessionId: string; routedEdit: import("./models.js").KnowledgeRoutedEdit }
  | { type: "runtime.edit_route.blocked"; sessionId: string; routedEdit: import("./models.js").KnowledgeRoutedEdit }
  | { type: "runtime.knowledge_branch_targets.created"; sessionId: string; targets: import("./models.js").KnowledgeBranchTarget[] }
  | { type: "runtime.knowledge_branch_execution.planned"; sessionId: string; branchExecution: import("./orchestration.js").RecursiveBranchExecutionRecord }
  | { type: "runtime.patch.proposed"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.approved"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.apply_started"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.rejected"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.applied"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.apply_failed"; sessionId: string; proposal: PatchProposal }
  | { type: "runtime.patch.stats.updated"; sessionId: string; patchId: string; stats: PatchChangeStats[] }
  | { type: "runtime.command.requested"; sessionId: string; commandRequest: CommandRequest }
  | { type: "runtime.command.approved"; sessionId: string; commandRequest: CommandRequest }
  | { type: "runtime.command.rejected"; sessionId: string; commandRequest: CommandRequest }
  | { type: "runtime.command.started"; sessionId: string; execution: CommandExecutionRecord }
  | { type: "runtime.command.completed"; sessionId: string; execution: CommandExecutionRecord }
  | { type: "runtime.command.failed"; sessionId: string; execution: CommandExecutionRecord }
  | { type: "runtime.command.blocked"; sessionId: string; execution: CommandExecutionRecord }
  | { type: "runtime.verification.pending"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.running"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.passed"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.failed"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.not_run"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.skipped"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.verification.unavailable"; sessionId: string; verification: VerificationResult }
  | { type: "runtime.session.created"; sessionId: string; session: AgentRuntimeSession }
  | { type: "runtime.session.restored"; sessionId: string; session: AgentRuntimeSession }
  | { type: "runtime.session.expired"; sessionId: string; session: AgentRuntimeSession }
  | { type: "runtime.session.completed"; sessionId: string; session: AgentRuntimeSession }
  | { type: "runtime.session.failed"; sessionId: string; session: AgentRuntimeSession }
  | { type: "runtime.orchestration.event"; sessionId: string; event: OrchestrationEvent }
  | { type: "runtime.progress.updated"; sessionId: string; progress: RuntimeProgressEvent }
  | { type: "runtime.run.completed"; sessionId: string; summary: RunSummary };
