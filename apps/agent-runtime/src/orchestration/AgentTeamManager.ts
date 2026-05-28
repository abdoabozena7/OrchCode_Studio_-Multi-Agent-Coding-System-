import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { MergedPlan, PlanningEvidenceBundle } from "./MultiPlanModels.js";
import type { Run, Task } from "./OrchestrationModels.js";
import type { AgentInstance, StaffingPlan, WorkItem } from "./SwarmModels.js";
import {
  createAgentTeam,
  domainFromTask,
  inheritedBudget,
  rootTeamRequest,
  teamDepth,
  type AgentTeam,
  type AgentTeamBudget,
  type AgentTeamCreationRequest,
  type AgentTeamCreationResult,
  type AgentTeamHierarchy,
  type AgentTeamRoleAssignments,
  type TeamContextConstraint,
  type TeamContextScope,
  type TeamContextSummary,
  type TeamContextWarning,
  type TeamMemoryScopeRef,
  type TeamTaskScopeValidationResult,
  type AgentTeamValidationFinding,
  type AgentTeamValidationResult
} from "./AgentTeamModels.js";

export type AgentTeamManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export class AgentTeamManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: AgentTeamManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "AgentTeamManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async createRootTeam(run: Run, overrides: Partial<AgentTeamCreationRequest> = {}): Promise<AgentTeamCreationResult> {
    const existing = (await this.listTeamsForRun(run.id)).find((team) => team.team_type === "root");
    if (existing) {
      return { team: existing, validation: await this.validateTeamHierarchy(run.id), artifact_ref: existing.artifact_ref };
    }
    return this.createTeam(rootTeamRequest(run, overrides));
  }

  async proposeTeamsFromMergedPlan(run: Run, mergedPlan?: MergedPlan, evidenceBundle?: PlanningEvidenceBundle): Promise<AgentTeam[]> {
    const root = (await this.createRootTeam(run)).team;
    const proposals: AgentTeam[] = [root];
    if (!mergedPlan) {
      const ref = await this.artifactStore.saveProposedAgentTeams(run.id, randomUUID(), proposals, { reason: "No merged plan; root-only fallback." });
      await this.trace("agent_team_proposed", run.id, root, "Root-only team proposal recorded.", [ref], { reason: "no_merged_plan" });
      return proposals;
    }

    const domains = unique([
      ...mergedPlan.merged_tasks.flatMap((task) => task.proposed_files.map(domainFromPath)),
      ...mergedPlan.risks.flatMap((risk) => risk.affected_domains),
      ...mergedPlan.evidence_used_summary?.top_evidence_sources ?? []
    ]).filter(Boolean).slice(0, root.budgets.max_children);

    for (const domain of domains) {
      const files = unique(mergedPlan.merged_tasks
        .filter((task) => task.proposed_files.some((file) => domainFromPath(file) === domain))
        .flatMap((task) => [...task.proposed_files, ...task.allowed_write_paths]));
      const result = await this.createChildTeam(root.team_id, {
        run_id: run.id,
        domain,
        objective: `Plan and coordinate ${domain} work for: ${run.user_request}`,
        team_type: "domain",
        status: "proposed",
        confidence: mergedPlan.confidence,
        scope: {
          summary: `Domain team proposed from merged plan ${mergedPlan.merged_plan_id}.`,
          allowed_files: files,
          forbidden_files: root.forbidden_files,
          module_locks: files.map((file) => `module:${domainFromPath(file)}`).filter(Boolean),
          semantic_locks: semanticLocksForFiles(files),
          evidence_refs: unique([mergedPlan.artifact_ref, ...(mergedPlan.evidence_item_refs ?? []), evidenceBundle?.artifact_ref ?? ""])
        },
        metadata_json: { merged_plan_id: mergedPlan.merged_plan_id }
      });
      proposals.push(result.team);
    }

    if (mergedPlan.risks.some((risk) => risk.severity === "high" || risk.severity === "critical" || risk.approval_required)) {
      proposals.push((await this.createChildTeam(root.team_id, {
        run_id: run.id,
        domain: "review",
        objective: "Review high-risk plan assumptions and scope before execution.",
        team_type: "review",
        status: "proposed",
        scope: { summary: "High-risk review team.", forbidden_files: root.forbidden_files, evidence_refs: [mergedPlan.artifact_ref] },
        metadata_json: { risk_count: mergedPlan.risks.length }
      })).team);
    }
    if (mergedPlan.validation_strategy.validation_risk === "high" || mergedPlan.validation_strategy.required_commands.length > 1) {
      proposals.push((await this.createChildTeam(root.team_id, {
        run_id: run.id,
        domain: "validation",
        objective: "Coordinate validation strategy metadata for this run.",
        team_type: "validation",
        status: "proposed",
        scope: { summary: "Validation planning team.", forbidden_files: root.forbidden_files, evidence_refs: [mergedPlan.artifact_ref] },
        metadata_json: { required_commands: mergedPlan.validation_strategy.required_commands }
      })).team);
    }
    if (mergedPlan.merged_tasks.some((task) => task.allowed_write_paths.length > 0)) {
      proposals.push((await this.createChildTeam(root.team_id, {
        run_id: run.id,
        domain: "integration",
        objective: "Track future integration requirements for accepted patch artifacts.",
        team_type: "integration",
        status: "proposed",
        scope: { summary: "Integration planning team.", forbidden_files: root.forbidden_files, evidence_refs: [mergedPlan.artifact_ref] },
        budgets: { max_active_writers: 1 },
        metadata_json: { write_task_count: mergedPlan.merged_tasks.filter((task) => task.allowed_write_paths.length > 0).length }
      })).team);
    }
    if (run.user_request.toLowerCase().includes("campaign") || Boolean(run.config.enable_internal_swarm_autopilot)) {
      proposals.push((await this.createChildTeam(root.team_id, {
        run_id: run.id,
        domain: "memory",
        objective: "Track durable memory scope for long-running planning.",
        team_type: "memory",
        status: "proposed",
        scope: { summary: "Memory metadata team.", forbidden_files: root.forbidden_files, evidence_refs: [mergedPlan.artifact_ref] }
      })).team);
    }

    const ref = await this.artifactStore.saveProposedAgentTeams(run.id, randomUUID(), proposals, {
      merged_plan_id: mergedPlan.merged_plan_id,
      evidence_bundle_ref: evidenceBundle?.artifact_ref
    });
    await this.trace("agent_team_proposed", run.id, root, `Proposed ${proposals.length} team(s) from merged plan.`, [ref], {
      merged_plan_id: mergedPlan.merged_plan_id,
      team_count: proposals.length
    });
    return proposals;
  }

  async createTeam(request: AgentTeamCreationRequest): Promise<AgentTeamCreationResult> {
    const team = createAgentTeam(request);
    const validation = await this.validateNewTeam(team);
    if (validation.findings.some((finding) => finding.severity === "blocking")) team.status = "blocked";
    const artifactRef = await this.artifactStore.saveAgentTeamArtifact(team);
    team.artifact_ref = artifactRef;
    await this.metadata.recordAgentTeamSaved({ team, artifactRef });
    await this.emitValidationTraces(team, validation);
    return { team, validation, artifact_ref: artifactRef };
  }

  async createChildTeam(parentTeamId: string, request: AgentTeamCreationRequest): Promise<AgentTeamCreationResult> {
    const parent = await this.getTeam(parentTeamId);
    if (!parent) throw new Error(`Parent team not found: ${parentTeamId}`);
    const inherited = this.computeInheritedBudgets(parent, request.budgets);
    const forbidden = unique([...(request.scope?.forbidden_files ?? []), ...parent.forbidden_files]);
    const result = await this.createTeam({
      ...request,
      run_id: parent.run_id,
      campaign_id: request.campaign_id ?? parent.campaign_id,
      parent_team_id: parent.team_id,
      budgets: inherited,
      limits: { ...inherited, ...(request.limits ?? {}) },
      scope: {
        ...(request.scope ?? {}),
        forbidden_files: forbidden
      }
    });
    await this.trace("agent_team_budget_inherited", parent.run_id, result.team, `Team ${result.team.team_id} inherited budgets from ${parent.team_id}.`, [result.team.artifact_ref].filter(Boolean) as string[], {
      parent_team_id: parent.team_id,
      inherited_budgets: inherited
    });
    return result;
  }

  async validateTeamHierarchy(runId: string): Promise<AgentTeamValidationResult> {
    const teams = await this.listTeamsForRun(runId);
    const findings: AgentTeamValidationFinding[] = [];
    const roots = teams.filter((team) => team.team_type === "root");
    if (roots.length === 0) findings.push(finding("missing_root", "warning", "No root team exists for this run."));
    if (roots.length > 1) findings.push(finding("multiple_roots", "blocking", "More than one root team exists for this run."));
    for (const team of teams) {
      const depth = teamDepth(team, teams);
      if (depth > team.budgets.max_depth) findings.push(finding("depth_exceeded", "blocking", `Team depth ${depth} exceeds max_depth ${team.budgets.max_depth}.`, team));
      const children = teams.filter((candidate) => candidate.parent_team_id === team.team_id);
      if (children.length > team.budgets.max_children) findings.push(finding("child_count_exceeded", "blocking", `Team has ${children.length} children; max_children is ${team.budgets.max_children}.`, team));
    }
    const result = validationResult(findings, teams);
    const hierarchy = await this.summarizeTeamHierarchy(runId, result);
    await this.artifactStore.saveAgentTeamHierarchy(runId, hierarchy.hierarchy_id, hierarchy);
    return result;
  }

  async getTeam(teamId: string): Promise<AgentTeam | undefined> {
    if (!await this.metadataExists()) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<Record<string, unknown>>("SELECT * FROM factory_agent_teams WHERE team_id = ?", teamId);
      return row ? teamFromRow(row) : undefined;
    } finally {
      store.close();
    }
  }

  async listTeamsForRun(runId: string): Promise<AgentTeam[]> {
    if (!await this.metadataExists()) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all<Record<string, unknown>>("SELECT * FROM factory_agent_teams WHERE run_id = ? ORDER BY created_at, team_id", runId).map(teamFromRow);
    } finally {
      store.close();
    }
  }

  async listChildTeams(teamId: string): Promise<AgentTeam[]> {
    const parent = await this.getTeam(teamId);
    if (!parent) return [];
    return (await this.listTeamsForRun(parent.run_id)).filter((team) => team.parent_team_id === teamId);
  }

  async getInheritedTeamScopes(teamId: string): Promise<AgentTeam[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const teams = await this.listTeamsForRun(team.run_id);
    const byId = new Map(teams.map((entry) => [entry.team_id, entry]));
    const lineage: AgentTeam[] = [];
    let current = team;
    const seen = new Set<string>();
    while (current.parent_team_id && !seen.has(current.team_id)) {
      seen.add(current.team_id);
      const parent = byId.get(current.parent_team_id) ?? await this.getTeam(current.parent_team_id);
      if (!parent) break;
      lineage.unshift(parent);
      current = parent;
    }
    return lineage;
  }

  async getTeamMemoryScopes(teamId: string): Promise<TeamMemoryScopeRef[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const inherited = await this.getInheritedTeamScopes(teamId);
    return [...inherited, team].map((entry) => ({
      scope_id: entry.memory_scope.scope_id,
      team_id: entry.team_id,
      run_id: entry.run_id,
      campaign_id: entry.campaign_id,
      summary: entry.memory_scope.summary,
      inherited: entry.team_id !== team.team_id,
      source_team_id: entry.team_id,
      evidence_refs: entry.memory_scope.evidence_refs,
      context_refs: entry.memory_scope.context_refs
    }));
  }

  async getTeamEffectiveAllowedFiles(teamId: string): Promise<string[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const inherited = await this.getInheritedTeamScopes(teamId);
    return unique([...inherited.flatMap((entry) => entry.allowed_files), ...team.allowed_files]);
  }

  async getTeamEffectiveForbiddenFiles(teamId: string): Promise<string[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const inherited = await this.getInheritedTeamScopes(teamId);
    return unique([...inherited.flatMap((entry) => entry.forbidden_files), ...team.forbidden_files]);
  }

  async getTeamSemanticLocks(teamId: string): Promise<string[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const inherited = await this.getInheritedTeamScopes(teamId);
    const active = await this.activeLockScopes(team.run_id, "semantic");
    return unique([...inherited.flatMap((entry) => entry.semantic_locks), ...team.semantic_locks, ...active]);
  }

  async getTeamModuleLocks(teamId: string): Promise<string[]> {
    const team = await this.getTeam(teamId);
    if (!team) return [];
    const inherited = await this.getInheritedTeamScopes(teamId);
    const active = await this.activeLockScopes(team.run_id, "module");
    return unique([...inherited.flatMap((entry) => entry.module_locks), ...team.module_locks, ...active]);
  }

  async getTeamContextScope(teamId: string): Promise<TeamContextScope | undefined> {
    const team = await this.getTeam(teamId);
    if (!team) return undefined;
    const inherited = await this.getInheritedTeamScopes(teamId);
    const memoryScopes = await this.getTeamMemoryScopes(teamId);
    const allowedFiles = await this.getTeamEffectiveAllowedFiles(teamId);
    const forbiddenFiles = await this.getTeamEffectiveForbiddenFiles(teamId);
    const moduleLocks = await this.getTeamModuleLocks(teamId);
    const semanticLocks = await this.getTeamSemanticLocks(teamId);
    const evidenceRefs = unique([
      ...memoryScopes.flatMap((scope) => scope.evidence_refs),
      ...inherited.flatMap((entry) => entry.memory_scope.evidence_refs),
      ...team.memory_scope.evidence_refs
    ]);
    const constraints = contextConstraintsForTeam(team, inherited, allowedFiles, forbiddenFiles, moduleLocks, semanticLocks);
    const warnings = budgetWarningsForTeam(team);
    const scope: TeamContextScope = {
      team_context_scope_id: `team_context_scope_${team.team_id}`,
      team_id: team.team_id,
      run_id: team.run_id,
      campaign_id: team.campaign_id,
      parent_team_id: team.parent_team_id,
      domain: team.domain,
      objective: team.objective,
      team_type: team.team_type,
      memory_scope: team.memory_scope.scope_id,
      inherited_memory_scopes: memoryScopes.filter((scopeRef) => scopeRef.inherited),
      allowed_files: allowedFiles,
      forbidden_files: forbiddenFiles,
      read_only_files: unique([...allowedFiles, ...team.memory_scope.context_refs]).filter((file) => !team.allowed_files.includes(file)),
      module_locks: moduleLocks,
      semantic_locks: semanticLocks,
      evidence_refs: evidenceRefs,
      decision_refs: stringArray(team.metadata_json.decision_refs),
      failure_refs: stringArray(team.metadata_json.failure_refs),
      budget_summary: {
        budgets: team.budgets,
        limits: team.limits,
        inherited_from_team_id: team.parent_team_id
      },
      constraints,
      warnings,
      confidence: team.confidence,
      freshness: "current",
      metadata_json: {
        team_artifact_ref: team.artifact_ref,
        inherited_team_ids: inherited.map((entry) => entry.team_id),
        status: team.status
      }
    };
    const scopeRef = await this.artifactStore.saveTeamContextScope(scope);
    scope.artifact_ref = scopeRef;
    const summary = teamContextSummary(scope);
    const summaryRef = await this.artifactStore.saveTeamContextSummary(summary);
    scope.summary_ref = summaryRef;
    const trace = await this.traceWriter.write({
      run_id: team.run_id,
      campaign_id: team.campaign_id,
      team_id: team.team_id,
      event_type: "team_context_scope_resolved",
      lifecycle_stage: "planning",
      summary: `Team context scope resolved for ${team.team_id}.`,
      artifact_refs: [scopeRef, summaryRef],
      severity: warnings.some((warning) => warning.severity === "blocking" || warning.severity === "warning") ? "warning" : "info",
      metadata_json: {
        run_id: team.run_id,
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        memory_scope: team.memory_scope.scope_id,
        source_scope: "team",
        allowed_file_count: allowedFiles.length,
        forbidden_file_count: forbiddenFiles.length,
        module_lock_count: moduleLocks.length,
        semantic_lock_count: semanticLocks.length,
        warning_count: warnings.length
      }
    });
    scope.trace_event_id = trace.trace_event_id;
    await this.metadata.recordTeamContextScopeSaved(scope);
    return scope;
  }

  async summarizeTeamForContext(teamId: string): Promise<TeamContextSummary | undefined> {
    const scope = await this.getTeamContextScope(teamId);
    return scope ? teamContextSummary(scope) : undefined;
  }

  async validateTaskWithinTeamScope(taskId: string, teamId: string): Promise<TeamTaskScopeValidationResult> {
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const scope = await this.getTeamContextScope(teamId);
    if (!scope) throw new Error(`Team context scope not found: ${teamId}`);
    const task = await this.loadTask(team.run_id, taskId);
    const checkedFiles = task ? unique([...task.allowed_files_to_edit, ...task.relevant_files]) : [];
    const outsideAllowed = scope.allowed_files.length
      ? checkedFiles.filter((file) => !matchesAnyScope(file, scope.allowed_files))
      : [];
    const forbiddenFiles = checkedFiles.filter((file) => matchesAnyScope(file, scope.forbidden_files));
    const warnings: TeamContextWarning[] = [];
    if (!task) warnings.push(warning("unknown_task_scope", `Task ${taskId} was not found in run artifacts or metadata.`, "warning", taskId));
    for (const file of outsideAllowed) warnings.push(warning("outside_team_scope", `${file} is outside team allowed scope.`, "blocking", file));
    for (const file of forbiddenFiles) warnings.push(warning("forbidden_by_team", `${file} is forbidden by team scope.`, "blocking", file));
    const valid = !warnings.some((entry) => entry.severity === "blocking");
    await this.traceWriter.write({
      run_id: team.run_id,
      task_id: taskId,
      team_id: team.team_id,
      event_type: valid ? "team_scope_validation_passed" : "team_scope_validation_failed",
      lifecycle_stage: valid ? "planning" : "blocked",
      severity: valid ? "info" : "warning",
      summary: valid ? `Task ${taskId} is within team scope.` : `Task ${taskId} is outside team scope.`,
      reason: warnings.map((entry) => entry.message).join("; ") || undefined,
      artifact_refs: [scope.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        run_id: team.run_id,
        task_id: taskId,
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        memory_scope: team.memory_scope.scope_id,
        source_scope: "team",
        warning_count: warnings.length,
        checked_files: checkedFiles
      }
    });
    return {
      valid,
      task_id: taskId,
      team_id: team.team_id,
      checked_files: checkedFiles,
      outside_allowed_files: outsideAllowed,
      forbidden_files: forbiddenFiles,
      warnings
    };
  }

  async assignTaskToTeam(taskId: string, teamId: string) {
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const assignment = {
      assignmentId: `team_assignment_task_${teamId}_${taskId}`,
      runId: team.run_id,
      teamId,
      assignmentType: "task" as const,
      targetId: taskId,
      status: "assigned",
      metadata: {}
    };
    await this.metadata.recordAgentTeamAssignmentSaved(assignment);
    const ref = await this.artifactStore.saveAgentTeamAssignments(team.run_id, randomUUID(), assignment, { team_id: teamId, task_id: taskId });
    await this.trace("agent_team_task_assigned", team.run_id, team, `Task ${taskId} assigned to team ${teamId}.`, [ref], { task_id: taskId });
    return { ...assignment, artifactRef: ref };
  }

  async assignAgentToTeam(agentId: string, teamId: string, role: keyof AgentTeamRoleAssignments | string) {
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const assignment = {
      assignmentId: `team_assignment_agent_${teamId}_${agentId}_${role}`,
      runId: team.run_id,
      teamId,
      assignmentType: "agent" as const,
      targetId: agentId,
      role,
      status: "assigned",
      metadata: {}
    };
    await this.metadata.recordAgentTeamAssignmentSaved(assignment);
    const ref = await this.artifactStore.saveAgentTeamAssignments(team.run_id, randomUUID(), assignment, { team_id: teamId, agent_id: agentId, role });
    await this.trace("agent_team_agent_assigned", team.run_id, team, `Agent ${agentId} assigned to team ${teamId}.`, [ref], { agent_id: agentId, role });
    return { ...assignment, artifactRef: ref };
  }

  computeInheritedBudgets(parent: AgentTeam, child?: Partial<AgentTeamBudget>) {
    return inheritedBudget(parent, child);
  }

  async checkTeamBudgets(teamId: string): Promise<AgentTeamValidationResult> {
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    const teams = await this.listTeamsForRun(team.run_id);
    const findings: AgentTeamValidationFinding[] = [];
    const children = teams.filter((candidate) => candidate.parent_team_id === team.team_id);
    if (children.length > team.budgets.max_children) findings.push(finding("child_count_exceeded", "blocking", "Child team budget exceeded.", team));
    const assignedTasks = await this.assignmentCount(team.run_id, team.team_id, "task");
    if (assignedTasks > team.budgets.max_tasks) findings.push(finding("task_budget_exceeded", "blocking", "Task assignment budget exceeded.", team));
    const result = validationResult(findings, teams);
    await this.emitValidationTraces(team, result);
    return result;
  }

  async summarizeTeamHierarchy(runId: string, validation?: AgentTeamValidationResult): Promise<AgentTeamHierarchy> {
    const teams = await this.listTeamsForRun(runId);
    const hierarchy: AgentTeamHierarchy = {
      hierarchy_id: `agent_team_hierarchy_${randomUUID()}`,
      run_id: runId,
      root_team_id: teams.find((team) => team.team_type === "root")?.team_id,
      teams,
      edges: teams.flatMap((team) => team.parent_team_id ? [{ parent_team_id: team.parent_team_id, child_team_id: team.team_id }] : []),
      max_depth: teams.reduce((max, team) => Math.max(max, teamDepth(team, teams)), 0),
      warnings: validation?.findings.filter((entry) => entry.severity === "warning").map((entry) => entry.message) ?? [],
      created_at: new Date().toISOString()
    };
    return hierarchy;
  }

  async assignSwarmMetadata(input: { runId: string; rootTeamId: string; staffingPlan?: StaffingPlan; agents?: AgentInstance[]; workItems?: WorkItem[] }) {
    for (const agent of input.agents ?? []) {
      await this.assignAgentToTeam(agent.id, input.rootTeamId, agent.role);
    }
    for (const item of input.workItems ?? []) {
      await this.assignTaskToTeam(item.id, input.rootTeamId);
    }
  }

  async completeTeam(teamId: string) {
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    team.status = "completed";
    team.updated_at = new Date().toISOString();
    const artifactRef = await this.artifactStore.saveAgentTeamArtifact(team);
    team.artifact_ref = artifactRef;
    await this.trace("agent_team_completed", team.run_id, team, `Team ${team.team_id} marked completed.`, [artifactRef], {});
    return team;
  }

  private async validateNewTeam(team: AgentTeam): Promise<AgentTeamValidationResult> {
    const teams = await this.listTeamsForRun(team.run_id);
    const findings: AgentTeamValidationFinding[] = [];
    if (team.team_type === "root" && teams.some((existing) => existing.team_type === "root" && existing.team_id !== team.team_id)) {
      findings.push(finding("multiple_roots", "blocking", "Exactly one root team is allowed per run.", team));
    }
    const parent = team.parent_team_id ? teams.find((existing) => existing.team_id === team.parent_team_id) ?? await this.getTeam(team.parent_team_id) : undefined;
    if (parent) {
      const depth = teamDepth(team, [...teams, team]);
      if (depth > parent.budgets.max_depth) findings.push(finding("depth_exceeded", "blocking", `Child depth ${depth} exceeds parent max_depth ${parent.budgets.max_depth}.`, team, parent));
      const siblingCount = teams.filter((existing) => existing.parent_team_id === parent.team_id).length;
      if (siblingCount + 1 > parent.budgets.max_children) findings.push(finding("child_count_exceeded", "blocking", `Parent max_children ${parent.budgets.max_children} would be exceeded.`, team, parent));
      if ((parent.status === "failed" || parent.status === "cancelled") && team.status === "active") findings.push(finding("inactive_parent", "blocking", "Failed or cancelled parent cannot create active child teams.", team, parent));
      if (team.budgets.max_active_writers > parent.budgets.max_active_writers) findings.push(finding("writer_budget_exceeded", "blocking", "Child writer budget exceeds parent budget.", team, parent));
      if (parent.allowed_files.length && !isSubset(team.allowed_files, parent.allowed_files) && !team.metadata_json.allow_scope_expansion) {
        findings.push(finding("allowed_scope_exceeded", "blocking", "Child allowed files exceed parent scope.", team, parent));
      }
      if (!isSubset(parent.forbidden_files, team.forbidden_files)) {
        findings.push(finding("forbidden_scope_not_inherited", "blocking", "Child forbidden files must include parent forbidden files.", team, parent));
      }
    }
    return validationResult(findings, [...teams, team]);
  }

  private async emitValidationTraces(team: AgentTeam, validation: AgentTeamValidationResult) {
    if (!validation.findings.length) {
      await this.trace("agent_team_scope_validated", team.run_id, team, `Team scope validated for ${team.team_id}.`, [team.artifact_ref].filter(Boolean) as string[], { validation });
      return;
    }
    for (const entry of validation.findings) {
      const eventType = entry.code.includes("budget") || entry.code.includes("count") || entry.code.includes("depth")
        ? "agent_team_budget_exceeded"
        : entry.severity === "blocking"
          ? "agent_team_scope_rejected"
          : "agent_team_scope_validated";
      await this.trace(eventType, team.run_id, team, entry.message, [team.artifact_ref].filter(Boolean) as string[], {
        finding: entry,
        validation
      }, entry.severity === "blocking" ? "warning" : "info");
    }
    if (team.status === "blocked") {
      await this.trace("agent_team_blocked", team.run_id, team, `Team ${team.team_id} blocked by validation findings.`, [team.artifact_ref].filter(Boolean) as string[], { validation }, "warning");
    }
  }

  private async assignmentCount(runId: string, teamId: string, assignmentType: "task" | "agent") {
    if (!await this.metadataExists()) return 0;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_agent_team_assignments WHERE run_id = ? AND team_id = ? AND assignment_type = ?", runId, teamId, assignmentType);
      return Number(row?.count ?? 0);
    } finally {
      store.close();
    }
  }

  private async activeLockScopes(runId: string, lockType: "module" | "semantic") {
    if (!await this.metadataExists()) return [];
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      return store.all<{ lock_scope: string | null; normalized_scope_key: string | null }>(
        "SELECT lock_scope, normalized_scope_key FROM factory_locks WHERE run_id = ? AND lock_type = ? AND status IN ('requested', 'acquired') ORDER BY created_at",
        runId,
        lockType
      ).map((row) => row.normalized_scope_key ?? row.lock_scope ?? "").filter(Boolean);
    } finally {
      store.close();
    }
  }

  private async loadTask(runId: string, taskId: string): Promise<Task | undefined> {
    if (!await this.metadataExists()) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    try {
      const row = store.get<{ artifact_ref?: string | null }>("SELECT artifact_ref FROM factory_tasks WHERE run_id = ? AND task_id = ?", runId, taskId);
      if (!row?.artifact_ref) return undefined;
      const raw = JSON.parse(await readFile(row.artifact_ref, "utf8")) as unknown;
      const tasks = Array.isArray(raw) ? raw : [];
      return tasks.find((entry): entry is Task => Boolean(entry && typeof entry === "object" && (entry as Task).id === taskId));
    } catch {
      return undefined;
    } finally {
      store.close();
    }
  }

  private async metadataExists() {
    return existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir));
  }

  private async trace(eventType: string, runId: string, team: AgentTeam, summary: string, artifactRefs: string[], metadata: Record<string, unknown>, severity: "info" | "warning" = "info") {
    await this.traceWriter.write({
      run_id: runId,
      campaign_id: team.campaign_id,
      team_id: team.team_id,
      event_type: eventType,
      lifecycle_stage: "planning",
      severity,
      summary,
      artifact_refs: artifactRefs,
      metadata_json: {
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        team_type: team.team_type,
        domain: team.domain,
        memory_scope: team.memory_scope.scope_id,
        budgets: team.budgets,
        ...metadata
      }
    });
  }
}

function validationResult(findings: AgentTeamValidationFinding[], teams: AgentTeam[]): AgentTeamValidationResult {
  return {
    valid: !findings.some((finding) => finding.severity === "blocking"),
    findings,
    max_depth: teams.reduce((max, team) => Math.max(max, teamDepth(team, teams)), 0),
    budget_warnings: findings.filter((entry) => entry.code.includes("budget") || entry.code.includes("count") || entry.code.includes("depth")).map((entry) => entry.message)
  };
}

function finding(code: AgentTeamValidationFinding["code"], severity: AgentTeamValidationFinding["severity"], message: string, team?: AgentTeam, parent?: AgentTeam): AgentTeamValidationFinding {
  return {
    code,
    severity,
    team_id: team?.team_id,
    parent_team_id: parent?.team_id,
    message,
    metadata_json: {
      team_type: team?.team_type,
      domain: team?.domain
    }
  };
}

function teamFromRow(row: Record<string, unknown>): AgentTeam {
  const teamId = String(row.team_id);
  const runId = String(row.run_id);
  const campaignId = optionalString(row.campaign_id);
  const memoryScope = String(row.memory_scope);
  return {
    team_id: teamId,
    run_id: runId,
    campaign_id: campaignId,
    parent_team_id: optionalString(row.parent_team_id),
    domain: String(row.domain),
    objective: String(row.objective),
    team_type: String(row.team_type) as AgentTeam["team_type"],
    orchestrator_agent_id: optionalString(row.orchestrator_agent_id),
    prompt_writer_agent_ids: parseJsonArray(row.prompt_writer_agent_ids_json),
    worker_agent_ids: parseJsonArray(row.worker_agent_ids_json),
    reviewer_agent_ids: parseJsonArray(row.reviewer_agent_ids_json),
    specialist_agent_ids: parseJsonArray(row.specialist_agent_ids_json),
    memory_scope: {
      scope_id: memoryScope,
      run_id: runId,
      campaign_id: campaignId,
      team_id: teamId,
      summary: "Persisted team memory scope.",
      context_refs: [],
      evidence_refs: []
    },
    allowed_files: parseJsonArray(row.allowed_files_json),
    forbidden_files: parseJsonArray(row.forbidden_files_json),
    module_locks: parseJsonArray(row.module_locks_json),
    semantic_locks: parseJsonArray(row.semantic_locks_json),
    budgets: parseJsonRecord(row.budgets_json) as AgentTeam["budgets"],
    limits: parseJsonRecord(row.limits_json) as AgentTeam["limits"],
    status: String(row.status) as AgentTeam["status"],
    confidence: Number(row.confidence ?? 0),
    artifact_ref: optionalString(row.artifact_ref),
    metadata_json: parseJsonRecord(row.metadata_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isSubset(child: string[], parent: string[]) {
  const parentSet = new Set(parent.map(normalizePath));
  return child.every((entry) => parentSet.has(normalizePath(entry)) || parent.some((allowed) => normalizePath(entry).startsWith(`${normalizePath(allowed).replace(/\/$/, "")}/`)));
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function teamContextSummary(scope: TeamContextScope): TeamContextSummary {
  return {
    team_id: scope.team_id,
    run_id: scope.run_id,
    parent_team_id: scope.parent_team_id,
    domain: scope.domain,
    objective: scope.objective,
    team_type: scope.team_type,
    memory_scope: scope.memory_scope,
    inherited_memory_scope_count: scope.inherited_memory_scopes.length,
    allowed_file_count: scope.allowed_files.length,
    forbidden_file_count: scope.forbidden_files.length,
    read_only_file_count: scope.read_only_files.length,
    module_lock_count: scope.module_locks.length,
    semantic_lock_count: scope.semantic_locks.length,
    evidence_ref_count: scope.evidence_refs.length,
    decision_ref_count: scope.decision_refs.length,
    failure_ref_count: scope.failure_refs.length,
    warning_count: scope.warnings.length,
    confidence: scope.confidence,
    freshness: scope.freshness,
    artifact_ref: scope.artifact_ref,
    summary_ref: scope.summary_ref
  };
}

function contextConstraintsForTeam(
  team: AgentTeam,
  inherited: AgentTeam[],
  allowedFiles: string[],
  forbiddenFiles: string[],
  moduleLocks: string[],
  semanticLocks: string[]
): TeamContextConstraint[] {
  const constraints: TeamContextConstraint[] = [];
  const push = (source: TeamContextConstraint["source"], sourceRef: string, constraintType: TeamContextConstraint["constraint_type"], summary: string, severity: TeamContextConstraint["severity"], metadata: Record<string, unknown> = {}) => {
    constraints.push({
      constraint_id: `team_constraint_${sanitizeId([team.team_id, source, sourceRef, constraintType].join("_"))}`,
      source,
      source_ref: sourceRef,
      constraint_type: constraintType,
      summary,
      severity,
      metadata_json: metadata
    });
  };
  for (const file of allowedFiles) push("team", file, "allowed_file", `${file} is inside effective team allowed scope.`, "info");
  for (const file of forbiddenFiles) push(inherited.some((entry) => entry.forbidden_files.includes(file)) ? "parent_team" : "team", file, "forbidden_file", `${file} is a team forbidden-file guardrail.`, "blocking");
  for (const lock of moduleLocks) push("lock", lock, "module_lock", `${lock} is relevant module lock context.`, "warning");
  for (const lock of semanticLocks) push("lock", lock, "semantic_lock", `${lock} is relevant semantic lock context.`, "warning");
  if (team.parent_team_id) push("parent_team", team.parent_team_id, "scope_warning", "Parent team constraints are inherited by this team context.", "info", { inherited_team_ids: inherited.map((entry) => entry.team_id) });
  return constraints;
}

function budgetWarningsForTeam(team: AgentTeam): TeamContextWarning[] {
  const warnings: TeamContextWarning[] = [];
  if (team.budgets.max_active_writers <= 0) warnings.push(warning("budget_pressure", "Team has no active writer budget.", "warning", team.team_id));
  if (team.budgets.max_tasks <= 0) warnings.push(warning("budget_pressure", "Team has no task budget.", "warning", team.team_id));
  if (team.confidence < 0.5) warnings.push(warning("low_confidence", "Team confidence is below 0.5.", "warning", team.team_id));
  return warnings;
}

function warning(reason: TeamContextWarning["reason"], message: string, severity: TeamContextWarning["severity"], sourceRef?: string): TeamContextWarning {
  return {
    warning_id: `team_warning_${sanitizeId([reason, sourceRef ?? message].join("_")).slice(0, 80)}`,
    reason,
    message,
    severity,
    source_ref: sourceRef,
    metadata_json: {}
  };
}

function matchesAnyScope(file: string, scopes: string[]) {
  const normalized = normalizePath(file);
  return scopes.some((scope) => {
    const candidate = normalizePath(scope).replace(/\/$/, "");
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function domainFromPath(filePath: string) {
  const normalized = normalizePath(filePath);
  if (!normalized) return "";
  if (normalized.includes("orchestration")) return "orchestration";
  if (normalized.includes("runtime")) return "runtime";
  if (normalized.includes("memory")) return "memory";
  if (normalized.includes("desktop")) return "desktop";
  if (normalized.includes("protocol")) return "protocol";
  return normalized.split("/").find(Boolean) ?? "general";
}

function semanticLocksForFiles(files: string[]) {
  const locks = new Set<string>();
  for (const file of files.map(normalizePath)) {
    if (/package\.json|package-lock\.json|cargo\.toml|cargo\.lock|tsconfig/.test(file)) locks.add("semantic:dependency-manifest");
    if (/schema|migration|sqlite|factorymetadata/.test(file)) locks.add("semantic:database-schema");
    if (/prompt/.test(file)) locks.add("semantic:prompt-system");
    if (/validation/.test(file)) locks.add("semantic:validation-runner");
    if (/lock/.test(file)) locks.add("semantic:lock-manager");
    if (/api|protocol|\.d\.ts$/.test(file)) locks.add("semantic:public-api");
  }
  return [...locks].sort();
}
