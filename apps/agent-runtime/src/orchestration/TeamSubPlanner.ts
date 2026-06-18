import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { AgentTeamManager } from "./AgentTeamManager.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { ContextPackBuilder } from "./ContextPackBuilder.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { AgentTeam, AgentTeamType } from "./AgentTeamModels.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type AgentRoleName,
  type Task
} from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig, TeamSubPlanningMode } from "./OrchestrationConfig.js";
import {
  createTeamSubPlan,
  createTeamSubPlanTaskDraft,
  type TeamSubPlan,
  type TeamSubPlanBudgetUsage,
  type TeamSubPlanDependency,
  type TeamSubPlanGenerationMode,
  type TeamSubPlanInput,
  type TeamSubPlanRisk,
  type TeamSubPlanSummary,
  type TeamSubPlanValidationResult,
  type TeamSubPlanValidationStrategy
} from "./TeamSubPlanningModels.js";

export type TeamSubPlannerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  teamManager?: AgentTeamManager;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  provider?: LlmProvider;
};

const SUPPORTED_TEAM_TYPES: AgentTeamType[] = ["domain", "feature", "review", "validation", "integration", "memory"];

export class TeamSubPlanner {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly manager: AgentTeamManager;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly provider?: LlmProvider;

  constructor(private readonly options: TeamSubPlannerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "TeamSubPlanner" });
    this.manager = options.teamManager ?? new AgentTeamManager({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "AgentTeamManager" })
    });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.provider = options.provider;
  }

  shouldSubPlanTeam(team: AgentTeam, context: { teamCount?: number; multiPlanUsed?: boolean } = {}) {
    if (!this.options.config.enable_team_sub_planning) return { should_plan: false, reason: "team_sub_planning_disabled" };
    if (this.options.config.team_sub_planning_mode === "off") return { should_plan: false, reason: "team_sub_planning_mode_off" };
    if (!SUPPORTED_TEAM_TYPES.includes(team.team_type)) return { should_plan: false, reason: team.team_type === "root" ? "root_team_aggregates_only" : "unsupported_team_type" };
    if (team.status === "blocked" || team.status === "cancelled" || team.status === "failed") return { should_plan: false, reason: `team_status_${team.status}` };
    if (!context.multiPlanUsed && this.options.config.execution_mode === "fast" && (context.teamCount ?? 0) <= 1) {
      return { should_plan: false, reason: "tiny_or_simple_run" };
    }
    return { should_plan: true, reason: "team_supported_for_read_only_sub_planning" };
  }

  async buildTeamSubPlanInput(teamId: string): Promise<TeamSubPlanInput> {
    const team = await this.manager.getTeam(teamId);
    if (!team) throw new Error(`Team not found for sub-planning: ${teamId}`);
    await this.traceWriter.write({
      run_id: team.run_id,
      team_id: team.team_id,
      event_type: "team_sub_planning_started",
      lifecycle_stage: "planning",
      summary: `Read-only team sub-planning started for ${team.team_id}.`,
      metadata_json: {
        run_id: team.run_id,
        team_id: team.team_id,
        parent_team_id: team.parent_team_id,
        team_type: team.team_type,
        domain: team.domain,
        generation_mode: this.configuredGenerationMode()
      }
    });

    const scope = await this.manager.getTeamContextScope(teamId);
    if (!scope) throw new Error(`Team context scope could not be resolved for sub-planning: ${teamId}`);
    const syntheticTask = this.syntheticPlanningTask(team, scope.allowed_files);
    const pack = await new ContextPackBuilder(this.workspacePath, {
      memoryDir: this.memoryDir,
      maxFiles: Math.min(this.options.config.max_files_per_task, 6),
      maxChars: Math.min(this.options.config.max_context_size, 8_000)
    }).build(team.run_id, syntheticTask, { team_context_scope: scope });
    const contextPackRef = await this.artifactStore.saveContextPack(pack);
    const input: TeamSubPlanInput = {
      input_id: `team_sub_plan_input_${randomUUID()}`,
      run_id: team.run_id,
      team_id: team.team_id,
      parent_team_id: team.parent_team_id,
      team,
      team_context_scope: scope,
      objective: team.objective,
      scope_summary: scope.metadata_json.scope_summary as string ?? team.memory_scope.summary,
      context_pack_ref: contextPackRef,
      context_summary: pack.team_context?.inclusion_reason_summary.join("; "),
      merged_plan_refs: await this.latestArtifactRefs(team.run_id, "factory_merged_plans", "artifact_ref", 3),
      planning_evidence_refs: uniqueStrings([...scope.evidence_refs, ...await this.latestArtifactRefs(team.run_id, "factory_planning_evidence", "artifact_ref", 12)]),
      memory_scope_refs: scope.inherited_memory_scopes,
      lock_context_refs: uniqueStrings([...scope.module_locks, ...scope.semantic_locks]),
      generation_mode: this.configuredGenerationMode(),
      created_at: new Date().toISOString(),
      metadata_json: {
        context_pack_id: pack.id,
        context_pack_ref: contextPackRef,
        team_context_scope_id: scope.team_context_scope_id,
        provider_read_only_allowed: this.options.config.allow_provider_team_sub_planning
      }
    };
    await this.traceWriter.write({
      run_id: input.run_id,
      team_id: input.team_id,
      event_type: "team_sub_plan_input_created",
      lifecycle_stage: "planning",
      summary: `Team sub-plan input created for ${input.team_id}.`,
      artifact_refs: [contextPackRef, scope.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        run_id: input.run_id,
        team_id: input.team_id,
        parent_team_id: input.parent_team_id,
        generation_mode: input.generation_mode,
        required_context_ref_count: pack.included_items?.length ?? 0,
        evidence_ref_count: input.planning_evidence_refs.length,
        memory_scope_ref_count: input.memory_scope_refs.length
      }
    });
    return input;
  }

  async generateTeamSubPlan(input: TeamSubPlanInput): Promise<TeamSubPlan> {
    const mode = this.options.config.team_sub_planning_mode;
    if (mode === "provider_read_only" || mode === "auto") {
      const providerPlan = await this.tryProviderReadOnlyPlan(input, mode);
      if (providerPlan) return this.acceptOrMark(providerPlan);
    }
    return this.acceptOrMark(this.generateDeterministicPlan(input, mode === "auto" ? "mixed" : input.generation_mode));
  }

  validateTeamSubPlan(plan: TeamSubPlan): TeamSubPlanValidationResult {
    const findings: string[] = [];
    const blocking: string[] = [];
    const allowed = asStringArray(plan.metadata_json.team_allowed_files);
    const forbidden = asStringArray(plan.metadata_json.team_forbidden_files);
    const teamBudgetMaxTasks = numberOrUndefined(plan.metadata_json.team_budget_max_tasks);
    const teamBudgetMaxDepth = numberOrUndefined(plan.metadata_json.team_budget_max_depth);
    const maxTasks = Math.min(
      this.options.config.max_team_sub_plan_tasks,
      teamBudgetMaxTasks ?? this.options.config.max_team_sub_plan_tasks
    );
    const maxDepth = Math.min(
      this.options.config.max_team_sub_plan_depth,
      teamBudgetMaxDepth ?? this.options.config.max_team_sub_plan_depth
    );

    if (plan.proposed_tasks.length > maxTasks) {
      blocking.push(`proposed task count ${plan.proposed_tasks.length} exceeds max ${maxTasks}`);
    }
    if (plan.budget_usage.planned_depth > maxDepth) {
      blocking.push(`planned depth ${plan.budget_usage.planned_depth} exceeds max ${maxDepth}`);
    }
    for (const task of plan.proposed_tasks) {
      if (!task.read_only && plan.generation_mode === "provider_read_only") {
        blocking.push(`provider_read_only task draft ${task.task_draft_id} is not read-only`);
      }
      for (const file of uniqueStrings([...task.proposed_files, ...task.allowed_write_paths])) {
        if (allowed.length && !matchesAnyScope(file, allowed)) {
          blocking.push(`task draft ${task.task_draft_id} references ${file} outside team allowed files`);
        }
      }
      for (const file of task.allowed_write_paths) {
        if (matchesAnyScope(file, forbidden)) {
          blocking.push(`task draft ${task.task_draft_id} proposes forbidden edit path ${file}`);
        }
      }
      if (!task.read_only && task.allowed_write_paths.length === 0) {
        findings.push(`task draft ${task.task_draft_id} is writable but has no explicit write paths`);
      }
    }
    if (String((plan.validation_strategy as TeamSubPlanValidationStrategy & { status?: string }).status) === "passed") {
      blocking.push("validation strategy cannot claim validation passed during read-only planning");
    }
    if (plan.generation_mode === "provider_read_only" && !this.options.config.allow_provider_team_sub_planning) {
      blocking.push("provider read-only team sub-planning is not enabled by config");
    }
    const status = blocking.length ? "invalid" : plan.status;
    return {
      valid: blocking.length === 0,
      status,
      findings,
      blocking_findings: blocking
    };
  }

  async writeTeamSubPlanArtifacts(plan: TeamSubPlan): Promise<TeamSubPlan> {
    const artifactRef = await this.artifactStore.saveTeamSubPlan(plan);
    const persisted = { ...plan, artifact_ref: artifactRef };
    const summaryRef = await this.artifactStore.saveTeamSubPlanSummary(this.summarizeTeamSubPlan(persisted), persisted);
    return { ...persisted, summary_ref: summaryRef };
  }

  async persistTeamSubPlan(plan: TeamSubPlan): Promise<TeamSubPlan> {
    const trace = await this.traceWriter.write({
      run_id: plan.run_id,
      team_id: plan.team_id,
      event_type: "team_sub_plan_persisted",
      lifecycle_stage: "planning",
      summary: `Team sub-plan persisted for ${plan.team_id}.`,
      artifact_refs: [plan.artifact_ref, plan.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        run_id: plan.run_id,
        team_id: plan.team_id,
        parent_team_id: plan.parent_team_id,
        sub_plan_id: plan.sub_plan_id,
        generation_mode: plan.generation_mode,
        status: plan.status,
        budget_usage: plan.budget_usage,
        validation_findings: plan.validation_findings
      }
    });
    const persisted = { ...plan, trace_event_id: trace.trace_event_id };
    await this.metadata.recordTeamSubPlanSaved(persisted);
    return persisted;
  }

  summarizeTeamSubPlan(plan: TeamSubPlan): TeamSubPlanSummary {
    return {
      sub_plan_id: plan.sub_plan_id,
      run_id: plan.run_id,
      team_id: plan.team_id,
      parent_team_id: plan.parent_team_id,
      status: plan.status,
      generation_mode: plan.generation_mode,
      proposed_task_count: plan.proposed_tasks.length,
      risk_count: plan.risks.length,
      dependency_count: plan.dependencies.length,
      confidence: plan.confidence,
      artifact_ref: plan.artifact_ref,
      summary_ref: plan.summary_ref
    };
  }

  private async acceptOrMark(plan: TeamSubPlan): Promise<TeamSubPlan> {
    const validation = this.validateTeamSubPlan(plan);
    const status = validation.valid ? plan.status : validation.status;
    const eventType = validation.valid
      ? plan.status === "blocked" ? "team_sub_plan_blocked" : plan.status === "skipped" ? "team_sub_plan_skipped" : "team_sub_plan_generated"
      : "team_sub_plan_invalid";
    const severity = validation.valid ? "info" : "warning";
    const checked = {
      ...plan,
      status,
      validation_findings: uniqueStrings([...plan.validation_findings, ...validation.findings, ...validation.blocking_findings])
    };
    await this.traceWriter.write({
      run_id: checked.run_id,
      team_id: checked.team_id,
      event_type: eventType,
      lifecycle_stage: "planning",
      severity,
      summary: validation.valid ? `Team sub-plan generated for ${checked.team_id}.` : `Team sub-plan invalid for ${checked.team_id}.`,
      artifact_refs: [checked.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        run_id: checked.run_id,
        team_id: checked.team_id,
        parent_team_id: checked.parent_team_id,
        sub_plan_id: checked.sub_plan_id,
        generation_mode: checked.generation_mode,
        status: checked.status,
        budget_usage: checked.budget_usage,
        validation_findings: checked.validation_findings
      }
    });
    return checked;
  }

  private async tryProviderReadOnlyPlan(input: TeamSubPlanInput, mode: TeamSubPlanningMode): Promise<TeamSubPlan | undefined> {
    if (!this.options.config.allow_provider_team_sub_planning || !this.provider) {
      if (mode === "auto") {
        await this.traceWriter.write({
          run_id: input.run_id,
          team_id: input.team_id,
          event_type: "team_sub_plan_skipped",
          lifecycle_stage: "planning",
          severity: "warning",
          summary: `Provider team sub-planning unavailable; falling back for ${input.team_id}.`,
          reason: "provider_unavailable_auto_fallback",
          metadata_json: { run_id: input.run_id, team_id: input.team_id, generation_mode: "auto" }
        });
        return undefined;
      }
      return this.blockedProviderPlan(input, "provider_read_only_team_sub_planning_unavailable");
    }
    const generated = await invokeReasoningProviderStructured<Partial<TeamSubPlan>>(this.provider, {
      systemPrompt: "You are a read-only team sub-planner. Produce metadata only. Do not propose patches, sub-runs, executor tasks, or source edits outside team scope.",
      userPrompt: `Create a read-only sub-plan for team ${input.team_id} (${input.team.team_type}/${input.team.domain}).`,
      context: {
        team: input.team,
        team_context_scope: input.team_context_scope,
        context_pack_ref: input.context_pack_ref,
        planning_evidence_refs: input.planning_evidence_refs,
        memory_scope_refs: input.memory_scope_refs,
        lock_context_refs: input.lock_context_refs,
        read_only: true
      }
    }, { type: "object", readOnly: true });
    const fallback = this.generateDeterministicPlan(input, "provider_read_only");
    return {
      ...fallback,
      ...generated,
      sub_plan_id: typeof generated.sub_plan_id === "string" ? generated.sub_plan_id : fallback.sub_plan_id,
      run_id: input.run_id,
      team_id: input.team_id,
      parent_team_id: input.parent_team_id,
      team_domain: input.team.domain,
      team_type: input.team.team_type,
      generation_mode: "provider_read_only",
      status: "generated",
      metadata_json: {
        ...fallback.metadata_json,
        ...generated.metadata_json,
        provider_read_only: true
      }
    } as TeamSubPlan;
  }

  private blockedProviderPlan(input: TeamSubPlanInput, reason: string): TeamSubPlan {
    return createTeamSubPlan({
      run_id: input.run_id,
      team_id: input.team_id,
      parent_team_id: input.parent_team_id,
      team_domain: input.team.domain,
      team_type: input.team.team_type,
      objective: input.objective,
      status: "blocked",
      scope_summary: input.scope_summary,
      assumptions: [],
      proposed_tasks: [],
      dependencies: [],
      risks: [risk("medium", `Provider read-only team sub-planning blocked: ${reason}.`, [], "Use deterministic fallback or enable provider read-only mode explicitly.", [])],
      validation_strategy: validationStrategy([], [`Blocked before validation: ${reason}.`]),
      required_context_refs: [input.context_pack_ref ?? ""].filter(Boolean),
      evidence_refs: input.planning_evidence_refs,
      memory_scope_refs: input.memory_scope_refs,
      lock_context_refs: input.lock_context_refs,
      budget_usage: this.budgetUsage(input, 0),
      unresolved_questions: [reason],
      confidence: 0.2,
      generation_mode: "provider_read_only",
      metadata_json: this.planMetadata(input, { blocked_reason: reason, provider_read_only: true })
    });
  }

  private generateDeterministicPlan(input: TeamSubPlanInput, mode: TeamSubPlanGenerationMode): TeamSubPlan {
    const team = input.team;
    const files = input.team_context_scope.allowed_files.slice(0, 8);
    const task = createTeamSubPlanTaskDraft({
      title: taskTitleForTeam(team),
      objective: taskObjectiveForTeam(team),
      role_hint: roleForTeam(team.team_type),
      read_only: readOnlyByDefault(team.team_type),
      proposed_files: files,
      allowed_write_paths: readOnlyByDefault(team.team_type) ? [] : files,
      forbidden_files: input.team_context_scope.forbidden_files,
      required_context_refs: [input.context_pack_ref ?? input.team_context_scope.artifact_ref ?? ""].filter(Boolean),
      evidence_refs: input.planning_evidence_refs.slice(0, 8),
      validation_refs: input.team_context_scope.evidence_refs.slice(0, 8),
      rationale: `Deterministic sub-plan draft for ${team.team_type} team ${team.team_id}; scoped to team context and not scheduled for execution.`,
      metadata_json: { team_type: team.team_type, generation: "deterministic_fallback" }
    });
    const tasks = [task].slice(0, Math.max(1, this.options.config.max_team_sub_plan_tasks));
    const assumptions = [
      `Team scope is bounded by ${input.team_context_scope.allowed_files.length} allowed file(s) and ${input.team_context_scope.forbidden_files.length} forbidden file guardrail(s).`,
      "Sub-plan task drafts are read-only planning records and are not executor tasks."
    ];
    const dependencies = dependenciesForInput(input);
    const risks = risksForTeam(input);
    return createTeamSubPlan({
      run_id: input.run_id,
      team_id: input.team_id,
      parent_team_id: input.parent_team_id,
      team_domain: team.domain,
      team_type: team.team_type,
      objective: team.objective,
      status: "generated",
      scope_summary: input.scope_summary,
      assumptions,
      proposed_tasks: tasks,
      dependencies,
      risks,
      validation_strategy: validationStrategy(validationCommandsForTeam(team.team_type), ["Validation is planned only; nothing has been run by sub-planning."]),
      required_context_refs: [input.context_pack_ref ?? input.team_context_scope.artifact_ref ?? ""].filter(Boolean),
      evidence_refs: input.planning_evidence_refs,
      memory_scope_refs: input.memory_scope_refs,
      lock_context_refs: input.lock_context_refs,
      budget_usage: this.budgetUsage(input, tasks.length),
      unresolved_questions: unresolvedQuestionsForTeam(input),
      confidence: confidenceForInput(input),
      generation_mode: mode,
      metadata_json: this.planMetadata(input, { deterministic_fallback: mode === "mixed" })
    });
  }

  private budgetUsage(input: TeamSubPlanInput, proposedTaskCount: number): TeamSubPlanBudgetUsage {
    const teamDepth = Number(input.team_context_scope.budget_summary.team_depth ?? input.team_context_scope.metadata_json.team_depth ?? 1);
    const maxTaskCount = Math.min(input.team.budgets.max_tasks, this.options.config.max_team_sub_plan_tasks);
    const maxDepth = Math.min(input.team.budgets.max_depth, this.options.config.max_team_sub_plan_depth);
    const warnings = [
      proposedTaskCount >= maxTaskCount ? `Proposed task count reached sub-plan maximum ${maxTaskCount}.` : "",
      teamDepth >= maxDepth ? `Team depth ${teamDepth} is at configured sub-plan maximum ${maxDepth}.` : ""
    ].filter(Boolean);
    return {
      max_task_count: maxTaskCount,
      proposed_task_count: proposedTaskCount,
      max_depth: maxDepth,
      planned_depth: teamDepth,
      max_active_writers: input.team.budgets.max_active_writers,
      provider_read_only_worker_budget: input.team.budgets.max_provider_read_only_workers,
      budget_warnings: warnings,
      metadata_json: {
        team_budget: input.team.budgets,
        config_max_team_sub_plan_tasks: this.options.config.max_team_sub_plan_tasks,
        config_max_team_sub_plan_depth: this.options.config.max_team_sub_plan_depth
      }
    };
  }

  private planMetadata(input: TeamSubPlanInput, extra: Record<string, unknown> = {}) {
    return {
      team_allowed_files: input.team_context_scope.allowed_files,
      team_forbidden_files: input.team_context_scope.forbidden_files,
      team_budget_max_tasks: input.team.budgets.max_tasks,
      team_budget_max_depth: input.team.budgets.max_depth,
      context_pack_ref: input.context_pack_ref,
      context_scope_ref: input.team_context_scope.artifact_ref,
      memory_scope: input.team_context_scope.memory_scope,
      root_read_only_recursive_planning_only: true,
      no_executor_tasks_created: true,
      ...extra
    };
  }

  private syntheticPlanningTask(team: AgentTeam, relevantFiles: string[]): Task {
    const now = new Date().toISOString();
    return {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `team_sub_plan_context_${team.team_id}`,
      run_id: team.run_id,
      title: `Team sub-planning context for ${team.domain}`,
      objective: `Collect read-only context for scoped team sub-planning: ${team.objective}`,
      role_required: roleForTeam(team.team_type) as AgentRoleName,
      status: "pending",
      dependencies: [],
      relevant_files: relevantFiles.slice(0, this.options.config.max_files_per_task),
      allowed_files_to_edit: [],
      forbidden_files: team.forbidden_files,
      expected_output_schema: "TeamSubPlan",
      validation_commands: [],
      max_attempts: 1,
      attempt_count: 0,
      artifacts: [],
      created_at: now,
      updated_at: now
    };
  }

  private configuredGenerationMode(): TeamSubPlanGenerationMode {
    const mode = this.options.config.team_sub_planning_mode;
    if (mode === "provider_read_only") return "provider_read_only";
    if (mode === "auto") return "mixed";
    return "deterministic";
  }

  private async latestArtifactRefs(runId: string, table: string, column: string, limit: number) {
    try {
      const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, databasePath, readOnly: true });
      try {
        return store.all<{ artifact_ref: string }>(
          `SELECT ${column} AS artifact_ref FROM ${table} WHERE run_id = ? AND ${column} IS NOT NULL ORDER BY created_at DESC LIMIT ?`,
          runId,
          limit
        ).map((row) => row.artifact_ref).filter(Boolean);
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }
}

function taskTitleForTeam(team: AgentTeam) {
  if (team.team_type === "review") return `Review scoped plan for ${team.domain}`;
  if (team.team_type === "validation") return `Plan validation checks for ${team.domain}`;
  if (team.team_type === "integration") return `Plan integration constraints for ${team.domain}`;
  if (team.team_type === "memory") return `Plan memory updates for ${team.domain}`;
  return `Plan ${team.domain} team work`;
}

function taskObjectiveForTeam(team: AgentTeam) {
  if (team.team_type === "review") return `Identify review risks and required evidence inside ${team.domain} scope.`;
  if (team.team_type === "validation") return `Identify validation commands and artifacts needed for ${team.domain} scope.`;
  if (team.team_type === "integration") return `Identify integration ordering, lock context, and merge constraints for ${team.domain} scope.`;
  if (team.team_type === "memory") return `Identify decisions, failures, lessons, and memory refs relevant to ${team.domain} scope.`;
  return `Break down ${team.objective} into scoped, non-executing planning drafts.`;
}

function roleForTeam(teamType: AgentTeamType) {
  if (teamType === "review") return "ReviewerAgent";
  if (teamType === "validation") return "TesterAgent";
  if (teamType === "integration") return "IntegratorAgent";
  if (teamType === "memory") return "ReporterAgent";
  return "PlannerAgent";
}

function readOnlyByDefault(teamType: AgentTeamType) {
  return ["review", "validation", "integration", "memory"].includes(teamType);
}

function validationCommandsForTeam(teamType: AgentTeamType) {
  if (teamType === "validation") return ["npm test --workspace apps/agent-runtime"];
  if (teamType === "review") return ["git diff --check"];
  if (teamType === "integration") return ["git diff --check"];
  return [];
}

function dependenciesForInput(input: TeamSubPlanInput): TeamSubPlanDependency[] {
  return [
    ...input.lock_context_refs.slice(0, 4).map((ref) => ({
      dependency_id: `team_sub_plan_dependency_${randomUUID()}`,
      dependency_type: ref.startsWith("semantic:") || ref.startsWith("module:") ? "lock" as const : "context" as const,
      source_ref: input.team_id,
      target_ref: ref,
      summary: `Team sub-plan depends on lock/context ref ${ref}.`,
      metadata_json: { lock_context: true }
    })),
    ...input.planning_evidence_refs.slice(0, 4).map((ref) => ({
      dependency_id: `team_sub_plan_dependency_${randomUUID()}`,
      dependency_type: "artifact" as const,
      source_ref: input.team_id,
      target_ref: ref,
      summary: `Team sub-plan uses planning evidence ${ref}.`,
      metadata_json: { planning_evidence: true }
    }))
  ];
}

function risksForTeam(input: TeamSubPlanInput): TeamSubPlanRisk[] {
  const risks = [
    input.team_context_scope.forbidden_files.length
      ? risk("medium", "Forbidden file guardrails must remain inherited by any future executable work.", input.team_context_scope.forbidden_files.slice(0, 5), "Keep forbidden paths reference-only and validate future tasks against team scope.", input.team_context_scope.evidence_refs)
      : undefined,
    input.team_context_scope.module_locks.length || input.team_context_scope.semantic_locks.length
      ? risk("medium", "Module or semantic lock boundaries may constrain later integration.", [], "Carry lock refs into future task prompts and integration checks.", input.lock_context_refs)
      : undefined,
    input.team_context_scope.warnings.length
      ? risk("low", "Team context scope produced warnings that may lower confidence.", [], "Review team context summary before converting any draft into execution work.", input.team_context_scope.warnings.map((warning) => warning.warning_id))
      : undefined
  ].filter((entry): entry is TeamSubPlanRisk => Boolean(entry));
  return risks.length ? risks : [risk("low", "No major team-specific risk surfaced during deterministic sub-planning.", [], "Keep normal review and validation gates active.", [])];
}

function unresolvedQuestionsForTeam(input: TeamSubPlanInput) {
  return [
    input.team_context_scope.allowed_files.length ? "" : "Team has no allowed files; future executable planning may require explicit scope.",
    input.planning_evidence_refs.length ? "" : "No planning evidence refs were linked directly to this team.",
    input.memory_scope_refs.length ? "" : "No inherited memory scope refs were resolved."
  ].filter(Boolean);
}

function confidenceForInput(input: TeamSubPlanInput) {
  let score = input.team_context_scope.confidence;
  if (!input.team_context_scope.allowed_files.length) score -= 0.15;
  if (!input.planning_evidence_refs.length) score -= 0.1;
  if (input.team_context_scope.warnings.length) score -= 0.05;
  return Math.max(0.1, Math.min(0.95, Number(score.toFixed(2))));
}

function validationStrategy(commands: string[], notes: string[]): TeamSubPlanValidationStrategy {
  return {
    strategy_id: `team_sub_plan_validation_${randomUUID()}`,
    status: "planned",
    commands,
    required_checks: commands.length ? commands : ["Review scoped artifacts before execution planning."],
    artifact_refs: [],
    notes,
    metadata_json: { validation_not_run: true }
  };
}

function risk(severity: TeamSubPlanRisk["severity"], summary: string, affectedFiles: string[], mitigation: string, evidenceRefs: string[]): TeamSubPlanRisk {
  return {
    risk_id: `team_sub_plan_risk_${randomUUID()}`,
    severity,
    summary,
    affected_files: affectedFiles,
    mitigation,
    evidence_refs: evidenceRefs,
    metadata_json: {}
  };
}

function matchesAnyScope(file: string, scopes: string[]) {
  const normalized = normalizePath(file);
  return scopes.some((scope) => {
    const normalizedScope = normalizePath(scope);
    if (!normalizedScope) return false;
    if (normalizedScope.endsWith("/")) return normalized.startsWith(normalizedScope);
    return normalized === normalizedScope || normalized.startsWith(`${normalizedScope}/`);
  });
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
