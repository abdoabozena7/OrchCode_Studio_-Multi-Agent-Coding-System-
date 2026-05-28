import { randomUUID } from "node:crypto";
import type { AgentRoleName } from "./OrchestrationModels.js";
import type {
  AdoptedTaskProposal,
  ReadOrWriteClassification,
  TaskAdoptionStatus,
  TaskReadinessStatus
} from "./TeamTaskAdoptionModels.js";
import type { TeamSubPlanValidationStrategy } from "./TeamSubPlanningModels.js";

export type ProposedTaskGraphNodeStatus =
  | "proposed"
  | "metadata_only"
  | "read_only_ready"
  | "future_write_candidate"
  | "blocked"
  | "rejected"
  | "duplicate"
  | "superseded"
  | "needs_context"
  | "needs_validation_strategy"
  | "needs_success_criteria"
  | "needs_locks"
  | "ready_for_approval_gate";

export type ProposedTaskGraphEdgeType =
  | "depends_on"
  | "duplicates"
  | "supersedes"
  | "sibling_of"
  | "parent_child"
  | "blocks"
  | "related_to"
  | "shares_scope_with"
  | "requires_same_lock";

export type ProposedTaskGraphSourceRef = {
  source_type:
    | "adopted_task_proposal"
    | "task_adoption_decision"
    | "task_readiness_result"
    | "team_sub_plan"
    | "team_context_scope"
    | "planning_evidence"
    | "existing_task_graph";
  source_ref: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
};

export type ProposedTaskGraphNode = {
  proposed_node_id: string;
  run_id: string;
  team_id?: string;
  sub_plan_id?: string;
  adopted_task_id?: string;
  source_task_draft_id?: string;
  parent_proposed_node_id?: string;
  title: string;
  objective: string;
  task_type: string;
  read_or_write_classification: ReadOrWriteClassification;
  proposed_role: AgentRoleName | string;
  status: ProposedTaskGraphNodeStatus;
  readiness_status: TaskReadinessStatus;
  adoption_status: TaskAdoptionStatus;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  dependencies: string[];
  validation_strategy?: TeamSubPlanValidationStrategy;
  success_criteria: string[];
  stop_conditions: string[];
  prompt_template_ref?: string;
  context_pack_ref?: string;
  evidence_refs: string[];
  risk_level: "low" | "medium" | "high" | "critical";
  non_executable_reason: string;
  source_refs: ProposedTaskGraphSourceRef[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ProposedTaskGraphEdge = {
  proposed_edge_id: string;
  run_id: string;
  graph_id?: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: ProposedTaskGraphEdgeType;
  reason: string;
  source_refs: ProposedTaskGraphSourceRef[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ProposedTaskGraph = {
  graph_id: string;
  run_id: string;
  status: "created" | "skipped" | "not_required" | "invalid" | "validated";
  nodes: ProposedTaskGraphNode[];
  edges: ProposedTaskGraphEdge[];
  validation?: ProposedTaskGraphValidationResult;
  artifact_ref?: string;
  nodes_ref?: string;
  edges_ref?: string;
  validation_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ProposedTaskGraphBuildRequest = {
  build_request_id: string;
  run_id: string;
  mode: "off" | "metadata_only" | "read_only_ready";
  max_nodes: number;
  max_edges: number;
  block_cycles: boolean;
  dedupe_proposed_nodes: boolean;
  adopted_proposals?: AdoptedTaskProposal[];
  existing_task_refs?: string[];
  requested_by: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ProposedTaskGraphValidationResult = {
  validation_id: string;
  run_id: string;
  graph_id: string;
  valid: boolean;
  cycle_count: number;
  duplicate_count: number;
  scope_overlap_count: number;
  blocked_node_count: number;
  warnings: string[];
  cycles: string[][];
  duplicate_groups: string[][];
  scope_overlaps: Array<{ node_ids: string[]; shared_refs: string[]; reason: string }>;
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ProposedTaskGraphSummary = {
  graph_id: string;
  run_id: string;
  status: ProposedTaskGraph["status"];
  proposed_node_count: number;
  proposed_edge_count: number;
  read_only_ready_count: number;
  future_write_candidate_count: number;
  blocked_count: number;
  duplicate_count: number;
  cycle_count: number;
  scope_overlap_count: number;
  graph_summary_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type ProposedTaskGraphBuildResult = {
  build_result_id: string;
  run_id: string;
  graph: ProposedTaskGraph;
  validation: ProposedTaskGraphValidationResult;
  summary: ProposedTaskGraphSummary;
  artifact_refs: string[];
  skipped: boolean;
  reason?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export function createProposedTaskGraphNode(input: Omit<ProposedTaskGraphNode, "proposed_node_id" | "created_at" | "updated_at" | "metadata_json" | "source_refs"> & {
  proposed_node_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata_json?: Record<string, unknown>;
  source_refs?: ProposedTaskGraphSourceRef[];
}): ProposedTaskGraphNode {
  const now = input.created_at ?? new Date().toISOString();
  return {
    ...input,
    proposed_node_id: input.proposed_node_id ?? `proposed_node_${randomUUID()}`,
    source_refs: input.source_refs ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: now,
    updated_at: input.updated_at ?? now
  };
}

export function createProposedTaskGraphEdge(input: Omit<ProposedTaskGraphEdge, "proposed_edge_id" | "created_at" | "metadata_json" | "source_refs"> & {
  proposed_edge_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
  source_refs?: ProposedTaskGraphSourceRef[];
}): ProposedTaskGraphEdge {
  return {
    ...input,
    proposed_edge_id: input.proposed_edge_id ?? `proposed_edge_${randomUUID()}`,
    source_refs: input.source_refs ?? [],
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createProposedTaskGraph(input: Omit<ProposedTaskGraph, "graph_id" | "created_at" | "updated_at" | "metadata_json"> & {
  graph_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProposedTaskGraph {
  const now = input.created_at ?? new Date().toISOString();
  return {
    ...input,
    graph_id: input.graph_id ?? `proposed_task_graph_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: now,
    updated_at: input.updated_at ?? now
  };
}

export function createProposedTaskGraphBuildRequest(input: Omit<ProposedTaskGraphBuildRequest, "build_request_id" | "created_at" | "metadata_json"> & {
  build_request_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProposedTaskGraphBuildRequest {
  return {
    ...input,
    build_request_id: input.build_request_id ?? `proposed_task_graph_build_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createProposedTaskGraphValidationResult(input: Omit<ProposedTaskGraphValidationResult, "validation_id" | "created_at" | "metadata_json"> & {
  validation_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProposedTaskGraphValidationResult {
  return {
    ...input,
    validation_id: input.validation_id ?? `proposed_task_graph_validation_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createProposedTaskGraphSummary(input: Omit<ProposedTaskGraphSummary, "created_at" | "metadata_json"> & {
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProposedTaskGraphSummary {
  return {
    ...input,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function createProposedTaskGraphBuildResult(input: Omit<ProposedTaskGraphBuildResult, "build_result_id" | "created_at" | "metadata_json"> & {
  build_result_id?: string;
  created_at?: string;
  metadata_json?: Record<string, unknown>;
}): ProposedTaskGraphBuildResult {
  return {
    ...input,
    build_result_id: input.build_result_id ?? `proposed_task_graph_result_${randomUUID()}`,
    metadata_json: input.metadata_json ?? {},
    created_at: input.created_at ?? new Date().toISOString()
  };
}

export function proposedNodeSignature(node: Pick<ProposedTaskGraphNode, "title" | "objective" | "team_id" | "proposed_role" | "read_only_files" | "allowed_files">) {
  return [
    node.title,
    node.objective,
    node.proposed_role,
    [...node.read_only_files, ...node.allowed_files].sort().join(",")
  ].join(":").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
