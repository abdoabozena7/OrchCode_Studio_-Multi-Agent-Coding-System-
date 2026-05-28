import { randomUUID } from "node:crypto";
import type { Run, Task } from "./OrchestrationModels.js";

export type AgentTeamType =
  | "root"
  | "domain"
  | "feature"
  | "review"
  | "validation"
  | "integration"
  | "memory"
  | "campaign"
  | "ad_hoc";

export type AgentTeamStatus =
  | "proposed"
  | "planned"
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentTeamBudget = {
  max_depth: number;
  max_children: number;
  max_tasks: number;
  max_active_tasks: number;
  max_active_writers: number;
  max_review_loops: number;
  max_repair_attempts: number;
  max_prompt_writer_runs: number;
  max_provider_read_only_workers: number;
  cost_budget?: number;
  time_budget?: number;
};

export type AgentTeamLimit = AgentTeamBudget;

export type AgentTeamScope = {
  summary: string;
  allowed_files: string[];
  forbidden_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  context_refs: string[];
  evidence_refs: string[];
  allow_scope_expansion?: boolean;
};

export type AgentTeamMemoryScope = {
  scope_id: string;
  run_id: string;
  campaign_id?: string;
  team_id: string;
  summary: string;
  context_refs: string[];
  evidence_refs: string[];
};

export type TeamMemoryScopeRef = {
  scope_id: string;
  team_id: string;
  run_id: string;
  campaign_id?: string;
  summary: string;
  inherited: boolean;
  source_team_id?: string;
  evidence_refs: string[];
  context_refs: string[];
};

export type TeamContextConstraint = {
  constraint_id: string;
  source: "team" | "parent_team" | "sibling_team" | "lock" | "task" | "budget" | "memory";
  source_ref: string;
  constraint_type: "allowed_file" | "forbidden_file" | "read_only_file" | "module_lock" | "semantic_lock" | "budget" | "scope_warning";
  summary: string;
  severity: "info" | "warning" | "blocking";
  metadata_json: Record<string, unknown>;
};

export type TeamContextEvidenceLink = {
  evidence_ref: string;
  source_type: string;
  source_scope: "team" | "parent" | "run" | "fallback";
  summary?: string;
  confidence?: string;
  freshness?: string;
  metadata_json?: Record<string, unknown>;
};

export type TeamContextWarning = {
  warning_id: string;
  reason:
    | "outside_team_scope"
    | "forbidden_by_team"
    | "budget_pressure"
    | "missing_team_memory"
    | "fallback_to_run_memory"
    | "low_confidence"
    | "stale_context"
    | "unknown_task_scope";
  message: string;
  severity: "info" | "warning" | "blocking";
  source_ref?: string;
  metadata_json?: Record<string, unknown>;
};

export type TeamContextScope = {
  team_context_scope_id: string;
  team_id: string;
  run_id: string;
  campaign_id?: string;
  parent_team_id?: string;
  domain: string;
  objective: string;
  team_type: AgentTeamType;
  memory_scope: string;
  inherited_memory_scopes: TeamMemoryScopeRef[];
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  evidence_refs: string[];
  decision_refs: string[];
  failure_refs: string[];
  budget_summary: Record<string, unknown>;
  constraints: TeamContextConstraint[];
  warnings: TeamContextWarning[];
  confidence: number;
  freshness: "current" | "fresh" | "possibly_stale" | "stale" | "unknown";
  artifact_ref?: string;
  summary_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
};

export type TeamContextInput = {
  run_id: string;
  task_id?: string;
  team_id?: string;
  team_context_scope?: TeamContextScope;
  source_component?: string;
  metadata_json?: Record<string, unknown>;
};

export type TeamContextSummary = {
  team_id: string;
  run_id: string;
  parent_team_id?: string;
  domain: string;
  objective: string;
  team_type: AgentTeamType;
  memory_scope: string;
  inherited_memory_scope_count: number;
  allowed_file_count: number;
  forbidden_file_count: number;
  read_only_file_count: number;
  module_lock_count: number;
  semantic_lock_count: number;
  evidence_ref_count: number;
  decision_ref_count: number;
  failure_ref_count: number;
  warning_count: number;
  confidence: number;
  freshness: TeamContextScope["freshness"];
  artifact_ref?: string;
  summary_ref?: string;
};

export type TeamScopedMemoryQuery = {
  query_id: string;
  run_id: string;
  team_id: string;
  task_id?: string;
  memory_scope: string;
  query_type: "decisions" | "failures" | "lessons" | "patterns" | "planning_evidence" | "combined";
  result_count: number;
  fallback_used: boolean;
  source_scope: "team" | "parent" | "run" | "fallback";
  result_refs: string[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type TeamContextPackExtension = {
  scope: TeamContextScope;
  summary: TeamContextSummary;
  memory_queries: TeamScopedMemoryQuery[];
  evidence_links: TeamContextEvidenceLink[];
  constraints: TeamContextConstraint[];
  warnings: TeamContextWarning[];
  inclusion_reason_summary: string[];
  fallback_used: boolean;
};

export type TeamTaskScopeValidationResult = {
  valid: boolean;
  task_id: string;
  team_id: string;
  checked_files: string[];
  outside_allowed_files: string[];
  forbidden_files: string[];
  warnings: TeamContextWarning[];
};

export type AgentTeamRoleAssignments = {
  orchestrator_agent_id?: string;
  prompt_writer_agent_ids: string[];
  worker_agent_ids: string[];
  reviewer_agent_ids: string[];
  specialist_agent_ids: string[];
};

export type AgentTeam = AgentTeamRoleAssignments & {
  team_id: string;
  run_id: string;
  campaign_id?: string;
  parent_team_id?: string;
  domain: string;
  objective: string;
  team_type: AgentTeamType;
  memory_scope: AgentTeamMemoryScope;
  allowed_files: string[];
  forbidden_files: string[];
  module_locks: string[];
  semantic_locks: string[];
  budgets: AgentTeamBudget;
  limits: AgentTeamLimit;
  status: AgentTeamStatus;
  confidence: number;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type AgentTeamCreationRequest = {
  run_id: string;
  campaign_id?: string;
  parent_team_id?: string;
  domain: string;
  objective: string;
  team_type: AgentTeamType;
  scope?: Partial<AgentTeamScope>;
  budgets?: Partial<AgentTeamBudget>;
  limits?: Partial<AgentTeamLimit>;
  role_assignments?: Partial<AgentTeamRoleAssignments>;
  status?: AgentTeamStatus;
  confidence?: number;
  metadata_json?: Record<string, unknown>;
};

export type AgentTeamCreationResult = {
  team: AgentTeam;
  validation: AgentTeamValidationResult;
  artifact_ref?: string;
};

export type AgentTeamHierarchy = {
  hierarchy_id: string;
  run_id: string;
  root_team_id?: string;
  teams: AgentTeam[];
  edges: Array<{ parent_team_id: string; child_team_id: string }>;
  max_depth: number;
  warnings: string[];
  artifact_ref?: string;
  created_at: string;
};

export type AgentTeamValidationFinding = {
  code:
    | "missing_root"
    | "multiple_roots"
    | "depth_exceeded"
    | "child_count_exceeded"
    | "allowed_scope_exceeded"
    | "forbidden_scope_not_inherited"
    | "writer_budget_exceeded"
    | "inactive_parent"
    | "task_budget_exceeded"
    | "active_task_budget_exceeded";
  severity: "warning" | "blocking";
  team_id?: string;
  parent_team_id?: string;
  message: string;
  metadata_json: Record<string, unknown>;
};

export type AgentTeamValidationResult = {
  valid: boolean;
  findings: AgentTeamValidationFinding[];
  max_depth: number;
  budget_warnings: string[];
};

export const DEFAULT_AGENT_TEAM_BUDGET: AgentTeamBudget = {
  max_depth: 2,
  max_children: 6,
  max_tasks: 20,
  max_active_tasks: 4,
  max_active_writers: 1,
  max_review_loops: 2,
  max_repair_attempts: 2,
  max_prompt_writer_runs: 1,
  max_provider_read_only_workers: 8
};

export function createAgentTeam(input: AgentTeamCreationRequest): AgentTeam {
  const now = new Date().toISOString();
  const teamId = `team_${slug(input.team_type)}_${randomUUID()}`;
  const budgets = normalizeBudget(input.budgets);
  const limits = normalizeBudget({ ...budgets, ...input.limits });
  const assignments = normalizeAssignments(input.role_assignments);
  const scope = normalizeScope(input.scope);
  return {
    team_id: teamId,
    run_id: input.run_id,
    campaign_id: input.campaign_id,
    parent_team_id: input.parent_team_id,
    domain: input.domain,
    objective: input.objective,
    team_type: input.team_type,
    ...assignments,
    memory_scope: createTeamMemoryScope(input.run_id, teamId, input.campaign_id, scope),
    allowed_files: scope.allowed_files,
    forbidden_files: scope.forbidden_files,
    module_locks: scope.module_locks,
    semantic_locks: scope.semantic_locks,
    budgets,
    limits,
    status: input.status ?? "planned",
    confidence: input.confidence ?? 0.7,
    metadata_json: input.metadata_json ?? {},
    created_at: now,
    updated_at: now
  };
}

export function rootTeamRequest(run: Run, overrides: Partial<AgentTeamCreationRequest> = {}): AgentTeamCreationRequest {
  return {
    run_id: run.id,
    campaign_id: overrides.campaign_id,
    domain: overrides.domain ?? "root",
    objective: overrides.objective ?? run.user_request,
    team_type: "root",
    scope: {
      summary: "Root team scope for the orchestration run.",
      forbidden_files: [".git/", "node_modules/", "dist/", "build/", "target/", ".agent_memory/"],
      ...(overrides.scope ?? {})
    },
    budgets: { ...DEFAULT_AGENT_TEAM_BUDGET, ...(overrides.budgets ?? {}) },
    limits: overrides.limits,
    role_assignments: overrides.role_assignments,
    status: overrides.status ?? "planned",
    confidence: overrides.confidence ?? 0.8,
    metadata_json: overrides.metadata_json
  };
}

export function createTeamMemoryScope(runId: string, teamId: string, campaignId: string | undefined, scope: AgentTeamScope): AgentTeamMemoryScope {
  const scopeId = campaignId
    ? `campaign:${campaignId}/run:${runId}/team:${teamId}`
    : `run:${runId}/team:${teamId}`;
  return {
    scope_id: scopeId,
    run_id: runId,
    campaign_id: campaignId,
    team_id: teamId,
    summary: scope.summary,
    context_refs: scope.context_refs,
    evidence_refs: scope.evidence_refs
  };
}

export function normalizeBudget(input: Partial<AgentTeamBudget> = {}): AgentTeamBudget {
  return {
    ...DEFAULT_AGENT_TEAM_BUDGET,
    ...input,
    max_depth: Math.max(0, input.max_depth ?? DEFAULT_AGENT_TEAM_BUDGET.max_depth),
    max_children: Math.max(0, input.max_children ?? DEFAULT_AGENT_TEAM_BUDGET.max_children),
    max_tasks: Math.max(0, input.max_tasks ?? DEFAULT_AGENT_TEAM_BUDGET.max_tasks),
    max_active_tasks: Math.max(0, input.max_active_tasks ?? DEFAULT_AGENT_TEAM_BUDGET.max_active_tasks),
    max_active_writers: Math.max(0, input.max_active_writers ?? DEFAULT_AGENT_TEAM_BUDGET.max_active_writers),
    max_review_loops: Math.max(0, input.max_review_loops ?? DEFAULT_AGENT_TEAM_BUDGET.max_review_loops),
    max_repair_attempts: Math.max(0, input.max_repair_attempts ?? DEFAULT_AGENT_TEAM_BUDGET.max_repair_attempts),
    max_prompt_writer_runs: Math.max(0, input.max_prompt_writer_runs ?? DEFAULT_AGENT_TEAM_BUDGET.max_prompt_writer_runs),
    max_provider_read_only_workers: Math.max(0, input.max_provider_read_only_workers ?? DEFAULT_AGENT_TEAM_BUDGET.max_provider_read_only_workers)
  };
}

export function inheritedBudget(parent: AgentTeam, child?: Partial<AgentTeamBudget>): AgentTeamBudget {
  const requested = normalizeBudget(child);
  return {
    max_depth: Math.min(parent.budgets.max_depth, requested.max_depth),
    max_children: Math.min(parent.budgets.max_children, requested.max_children),
    max_tasks: Math.min(parent.budgets.max_tasks, requested.max_tasks),
    max_active_tasks: Math.min(parent.budgets.max_active_tasks, requested.max_active_tasks),
    max_active_writers: Math.min(parent.budgets.max_active_writers, requested.max_active_writers),
    max_review_loops: Math.min(parent.budgets.max_review_loops, requested.max_review_loops),
    max_repair_attempts: Math.min(parent.budgets.max_repair_attempts, requested.max_repair_attempts),
    max_prompt_writer_runs: Math.min(parent.budgets.max_prompt_writer_runs, requested.max_prompt_writer_runs),
    max_provider_read_only_workers: Math.min(parent.budgets.max_provider_read_only_workers, requested.max_provider_read_only_workers),
    cost_budget: minOptional(parent.budgets.cost_budget, requested.cost_budget),
    time_budget: minOptional(parent.budgets.time_budget, requested.time_budget)
  };
}

export function teamDepth(team: AgentTeam, teams: AgentTeam[]): number {
  let depth = 0;
  let current = team;
  const byId = new Map(teams.map((entry) => [entry.team_id, entry]));
  const seen = new Set<string>();
  while (current.parent_team_id && !seen.has(current.team_id)) {
    seen.add(current.team_id);
    const parent = byId.get(current.parent_team_id);
    if (!parent) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function domainFromTask(task: Task): string {
  const files = [...task.allowed_files_to_edit, ...task.relevant_files];
  if (files.some((file) => file.includes("orchestration"))) return "orchestration";
  if (files.some((file) => file.includes("runtime"))) return "runtime";
  if (files.some((file) => file.includes("memory"))) return "memory";
  if (files.some((file) => file.includes("desktop"))) return "desktop";
  return task.role_required.replace(/Agent$/, "").toLowerCase();
}

function normalizeScope(scope: Partial<AgentTeamScope> = {}): AgentTeamScope {
  return {
    summary: scope.summary ?? "Bounded team scope.",
    allowed_files: unique(scope.allowed_files ?? []),
    forbidden_files: unique(scope.forbidden_files ?? []),
    module_locks: unique(scope.module_locks ?? []),
    semantic_locks: unique(scope.semantic_locks ?? []),
    context_refs: unique(scope.context_refs ?? []),
    evidence_refs: unique(scope.evidence_refs ?? []),
    allow_scope_expansion: scope.allow_scope_expansion
  };
}

function normalizeAssignments(assignments: Partial<AgentTeamRoleAssignments> = {}): AgentTeamRoleAssignments {
  return {
    orchestrator_agent_id: assignments.orchestrator_agent_id,
    prompt_writer_agent_ids: unique(assignments.prompt_writer_agent_ids ?? []),
    worker_agent_ids: unique(assignments.worker_agent_ids ?? []),
    reviewer_agent_ids: unique(assignments.reviewer_agent_ids ?? []),
    specialist_agent_ids: unique(assignments.specialist_agent_ids ?? [])
  };
}

function minOptional(left: number | undefined, right: number | undefined) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function slug(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
}
