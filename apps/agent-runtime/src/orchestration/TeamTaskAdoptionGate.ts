import path from "node:path";
import { AgentTeamManager } from "./AgentTeamManager.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { TeamContextScope } from "./AgentTeamModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { Task } from "./OrchestrationModels.js";
import type { TeamSubPlan, TeamSubPlanTaskDraft } from "./TeamSubPlanningModels.js";
import {
  createAdoptedTaskProposal,
  createTaskAdoptionDecision,
  createTaskAdoptionFinding,
  createTeamTaskAdoptionRequest,
  createTeamTaskAdoptionResult,
  taskDraftSignature,
  type AdoptedTaskProposal,
  type ReadOrWriteClassification,
  type TaskAdoptionDecision,
  type TaskAdoptionFinding,
  type TaskAdoptionStatus,
  type TaskPromotionPolicy,
  type TeamTaskAdoptionContext,
  type TeamTaskAdoptionResult
} from "./TeamTaskAdoptionModels.js";
import { TeamTaskReadinessGate } from "./TeamTaskReadinessGate.js";

export type TeamTaskAdoptionGateOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  teamManager?: AgentTeamManager;
  traceWriter?: FactoryTraceWriter;
};

export class TeamTaskAdoptionGate {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly manager: AgentTeamManager;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly readinessGate = new TeamTaskReadinessGate();

  constructor(private readonly options: TeamTaskAdoptionGateOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "TeamTaskAdoptionGate" });
    this.manager = options.teamManager ?? new AgentTeamManager({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, artifactStore: this.artifactStore });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async adoptTeamSubPlanTasks(subPlanOrPlans: TeamSubPlan | TeamSubPlan[], options: { existingTasks?: Task[] } = {}): Promise<TeamTaskAdoptionResult> {
    const subPlans = Array.isArray(subPlanOrPlans) ? subPlanOrPlans : [subPlanOrPlans];
    const runId = subPlans[0]?.run_id ?? "";
    const policy = this.policy();
    const request = createTeamTaskAdoptionRequest({
      run_id: runId,
      team_id: subPlans.length === 1 ? subPlans[0]?.team_id : undefined,
      sub_plan_ids: subPlans.map((plan) => plan.sub_plan_id),
      mode: policy.mode,
      policy,
      requested_by: "TeamTaskAdoptionGate",
      metadata_json: { sub_plan_count: subPlans.length }
    });
    const requestRef = await this.artifactStore.saveTeamTaskAdoptionRequest(request);
    request.artifact_ref = requestRef;
    await this.traceWriter.write({
      run_id: runId,
      team_id: request.team_id,
      event_type: "team_task_adoption_started",
      lifecycle_stage: "planning",
      summary: `Team task adoption started for ${subPlans.length} sub-plan(s).`,
      artifact_refs: [requestRef],
      metadata_json: {
        run_id: runId,
        team_id: request.team_id,
        sub_plan_ids: request.sub_plan_ids,
        mode: request.mode
      }
    });

    if (!this.options.config.enable_team_task_adoption || this.options.config.team_task_adoption_mode === "off") {
      await this.traceWriter.write({
        run_id: runId,
        team_id: request.team_id,
        event_type: "team_task_adoption_summary_created",
        lifecycle_stage: "planning",
        severity: "warning",
        reason: "team_task_adoption_disabled",
        summary: "Team task adoption skipped by configuration.",
        artifact_refs: [requestRef],
        metadata_json: { run_id: runId, mode: this.options.config.team_task_adoption_mode }
      });
      return createTeamTaskAdoptionResult({
        run_id: runId,
        request,
        evaluated_drafts: 0,
        proposals: [],
        decisions: [],
        readiness_results: [],
        metadata_json: { skipped: true, reason: "team_task_adoption_disabled" }
      });
    }

    const existingTaskSignatures = uniqueStrings([
      ...(options.existingTasks ?? []).map((task) => taskDraftSignature(task.title, task.objective)),
      ...await this.existingTaskSignatures(runId)
    ]);
    const alreadyAdoptedSignatures = await this.alreadyAdoptedSignatures(runId);
    const allDraftSignatures = subPlans.flatMap((plan) => plan.proposed_tasks.map((draft) => `${plan.sub_plan_id}:${draft.task_draft_id}:${taskDraftSignature(draft.title, draft.objective)}`));
    const proposals: AdoptedTaskProposal[] = [];
    const decisions: TaskAdoptionDecision[] = [];
    const readinessResults = [];
    const perTeamCounts = new Map<string, number>();
    let totalAdopted = 0;

    for (const subPlan of subPlans) {
      const scope = await this.manager.getTeamContextScope(subPlan.team_id);
      for (const draft of subPlan.proposed_tasks) {
        const siblingMatches = allDraftSignatures
          .filter((signature) => signature.endsWith(`:${taskDraftSignature(draft.title, draft.objective)}`) && !signature.startsWith(`${subPlan.sub_plan_id}:${draft.task_draft_id}:`))
          .map((signature) => signature.split(":").slice(0, 2).join(":"));
        const context = this.adoptionContext(subPlan, draft, scope, existingTaskSignatures, alreadyAdoptedSignatures, siblingMatches);
        const evaluated = await this.evaluateTaskDraftForAdoption(draft, context);
        await this.traceWriter.write({
          run_id: subPlan.run_id,
          team_id: subPlan.team_id,
          event_type: "team_task_draft_evaluated",
          lifecycle_stage: "planning",
          summary: `Team task draft evaluated: ${draft.task_draft_id}.`,
          metadata_json: {
            run_id: subPlan.run_id,
            team_id: subPlan.team_id,
            sub_plan_id: subPlan.sub_plan_id,
            task_draft_id: draft.task_draft_id,
            adoption_status: evaluated.decision.adoption_status,
            readiness_status: evaluated.readiness?.readiness_status,
            finding_count: evaluated.decision.findings.length
          }
        });
        if (totalAdopted >= policy.max_adopted_tasks_per_run || (perTeamCounts.get(subPlan.team_id) ?? 0) >= policy.max_adopted_tasks_per_team) {
          evaluated.decision = this.rejectTaskDraft(draft, context, "adopted_blocked", "Adoption budget exhausted.", evaluated.decision.findings);
        }
        if (evaluated.proposal && evaluated.readiness) {
          const proposalRef = await this.artifactStore.saveAdoptedTaskProposal(evaluated.proposal);
          const readinessRef = await this.artifactStore.saveTaskReadinessResult(evaluated.readiness);
          const proposal = { ...evaluated.proposal, artifact_ref: proposalRef, readiness_ref: readinessRef };
          const readiness = { ...evaluated.readiness, artifact_ref: readinessRef, adopted_task_id: proposal.adopted_task_id };
          const trace = await this.traceWriter.write({
            run_id: subPlan.run_id,
            team_id: subPlan.team_id,
            event_type: proposal.adoption_status === "duplicate" ? "team_task_draft_duplicate_detected" : "team_task_draft_adopted",
            lifecycle_stage: "planning",
            summary: `Team task draft ${draft.task_draft_id} adopted as ${proposal.adoption_status}.`,
            artifact_refs: [proposalRef, readinessRef],
            metadata_json: adoptionTraceMetadata(proposal, evaluated.decision, readiness.findings.length)
          });
          proposal.trace_event_id = trace.trace_event_id;
          evaluated.decision = { ...evaluated.decision, adopted_task_id: proposal.adopted_task_id, artifact_ref: proposalRef, readiness_ref: readinessRef, trace_event_id: trace.trace_event_id };
          await this.metadata.recordAdoptedTaskProposalSaved(proposal);
          await this.metadata.recordTaskReadinessResultSaved(readiness);
          proposals.push(proposal);
          readinessResults.push(readiness);
          totalAdopted += 1;
          perTeamCounts.set(subPlan.team_id, (perTeamCounts.get(subPlan.team_id) ?? 0) + 1);
          alreadyAdoptedSignatures.push(taskDraftSignature(draft.title, draft.objective));
        } else {
          const rejectedRef = await this.artifactStore.saveRejectedTaskDraft(evaluated.decision, draft);
          const trace = await this.traceWriter.write({
            run_id: subPlan.run_id,
            team_id: subPlan.team_id,
            event_type: evaluated.decision.adoption_status === "duplicate" ? "team_task_draft_duplicate_detected" : "team_task_draft_rejected",
            lifecycle_stage: "planning",
            severity: "warning",
            reason: evaluated.decision.reason,
            summary: `Team task draft ${draft.task_draft_id} was not adopted: ${evaluated.decision.adoption_status}.`,
            artifact_refs: [rejectedRef],
            metadata_json: {
              run_id: subPlan.run_id,
              team_id: subPlan.team_id,
              sub_plan_id: subPlan.sub_plan_id,
              task_draft_id: draft.task_draft_id,
              adoption_status: evaluated.decision.adoption_status,
              readiness_status: evaluated.decision.readiness_status,
              rejection_reason: evaluated.decision.reason,
              finding_count: evaluated.decision.findings.length
            }
          });
          evaluated.decision = { ...evaluated.decision, artifact_ref: rejectedRef, trace_event_id: trace.trace_event_id };
        }
        decisions.push(evaluated.decision);
        await this.metadata.recordTaskAdoptionDecisionSaved(evaluated.decision);
      }
    }

    const result = createTeamTaskAdoptionResult({
      run_id: runId,
      request,
      evaluated_drafts: decisions.length,
      proposals,
      decisions,
      readiness_results: readinessResults,
      metadata_json: { read_only_bridge_only: true, no_executor_tasks_created: true }
    });
    const summaryRefs = await this.artifactStore.saveTeamTaskAdoptionSummary(result);
    const trace = await this.traceWriter.write({
      run_id: runId,
      team_id: request.team_id,
      event_type: "team_task_adoption_summary_created",
      lifecycle_stage: "planning",
      summary: `Team task adoption summary created for ${decisions.length} draft(s).`,
      artifact_refs: [summaryRefs.summaryRef, summaryRefs.artifactRef],
      metadata_json: {
        run_id: runId,
        drafts_evaluated: result.evaluated_drafts,
        ...result.summary
      }
    });
    return { ...result, artifact_ref: summaryRefs.artifactRef, summary_ref: summaryRefs.summaryRef, trace_event_id: trace.trace_event_id };
  }

  async evaluateTaskDraftForAdoption(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext) {
    const duplicateFinding = this.duplicateFinding(draft, context);
    if (duplicateFinding) {
      return { decision: this.rejectTaskDraft(draft, context, "duplicate", duplicateFinding.message, [duplicateFinding]) };
    }
    if (this.options.config.team_task_adoption_mode === "read_only_only" && this.classifyReadWriteIntent(draft) !== "read_only") {
      return { decision: this.rejectTaskDraft(draft, context, "adopted_blocked", "Write candidates are blocked in read_only_only adoption mode.", [finding("executable_disabled", "blocking", "Read-only-only adoption mode blocks write candidates.", [draft.task_draft_id])]) };
    }
    const findings = [
      ...this.validateDraftScope(draft, context),
      ...this.validateDraftValidationStrategy(draft, context),
      ...this.validateDraftSuccessCriteria(draft, context)
    ];
    const scopeRejected = findings.some((finding) => finding.code === "out_of_scope" || finding.code === "forbidden_file_conflict");
    await this.traceWriter.write({
      run_id: context.sub_plan.run_id,
      team_id: context.sub_plan.team_id,
      event_type: scopeRejected ? "team_task_scope_rejected" : "team_task_scope_validated",
      lifecycle_stage: "planning",
      severity: scopeRejected ? "warning" : "info",
      summary: scopeRejected ? `Task draft scope rejected: ${draft.task_draft_id}.` : `Task draft scope validated: ${draft.task_draft_id}.`,
      metadata_json: {
        run_id: context.sub_plan.run_id,
        team_id: context.sub_plan.team_id,
        sub_plan_id: context.sub_plan.sub_plan_id,
        task_draft_id: draft.task_draft_id,
        finding_count: findings.length
      }
    });
    const blockingStatus = adoptionStatusFromFindings(findings);
    if (blockingStatus) {
      return { decision: this.rejectTaskDraft(draft, context, blockingStatus, findings.find((finding) => finding.severity === "blocking")?.message ?? "Draft failed adoption checks.", findings) };
    }
    const proposal = this.createAdoptedTaskProposal(draft, context);
    const readiness = this.readinessGate.checkReadiness(proposal, this.policy(), findings);
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: "team_task_readiness_checked",
      lifecycle_stage: "planning",
      summary: `Task readiness checked for ${draft.task_draft_id}.`,
      metadata_json: {
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        sub_plan_id: proposal.sub_plan_id,
        task_draft_id: proposal.source_task_draft_id,
        adopted_task_id: proposal.adopted_task_id,
        readiness_status: readiness.readiness_status,
        finding_count: readiness.findings.length
      }
    });
    await this.traceWriter.write({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      event_type: readiness.readiness_status === "blocked" ? "team_task_readiness_blocked" : "team_task_readiness_passed",
      lifecycle_stage: "planning",
      severity: readiness.readiness_status === "blocked" ? "warning" : "info",
      summary: `Task readiness ${readiness.readiness_status} for ${draft.task_draft_id}.`,
      metadata_json: {
        run_id: proposal.run_id,
        team_id: proposal.team_id,
        sub_plan_id: proposal.sub_plan_id,
        task_draft_id: proposal.source_task_draft_id,
        adopted_task_id: proposal.adopted_task_id,
        readiness_status: readiness.readiness_status
      }
    });
    proposal.readiness_status = readiness.readiness_status;
    proposal.adoption_status = adoptionStatusForReadiness(proposal, this.policy());
    const decision = createTaskAdoptionDecision({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      sub_plan_id: proposal.sub_plan_id,
      task_draft_id: proposal.source_task_draft_id,
      adopted_task_id: proposal.adopted_task_id,
      adoption_status: proposal.adoption_status,
      readiness_status: proposal.readiness_status,
      reason: `Draft adopted as ${proposal.adoption_status}; readiness=${proposal.readiness_status}.`,
      findings: readiness.findings
    });
    return { proposal, readiness, decision };
  }

  adoptTaskDraft(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext) {
    return this.evaluateTaskDraftForAdoption(draft, context);
  }

  rejectTaskDraft(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext, status: TaskAdoptionStatus, reason: string, findings: TaskAdoptionFinding[] = []): TaskAdoptionDecision {
    return createTaskAdoptionDecision({
      run_id: context.sub_plan.run_id,
      team_id: context.sub_plan.team_id,
      sub_plan_id: context.sub_plan.sub_plan_id,
      task_draft_id: draft.task_draft_id,
      adoption_status: status,
      readiness_status: "blocked",
      reason,
      findings
    });
  }

  classifyReadWriteIntent(draft: TeamSubPlanTaskDraft): ReadOrWriteClassification {
    if (/repair/i.test(`${draft.title} ${draft.objective} ${draft.role_hint}`)) return "repair_candidate";
    if (draft.read_only && draft.allowed_write_paths.length === 0) return "read_only";
    if (draft.allowed_write_paths.length > 0 || /executor|integrator/i.test(draft.role_hint)) return "write_candidate";
    return "read_only";
  }

  validateDraftScope(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext): TaskAdoptionFinding[] {
    const classification = this.classifyReadWriteIntent(draft);
    const findings: TaskAdoptionFinding[] = [];
    const referencedFiles = uniqueStrings([...draft.proposed_files, ...draft.allowed_write_paths]);
    const forbidden = referencedFiles.filter((file) => matchesAnyScope(file, context.forbidden_files));
    const outside = referencedFiles.filter((file) => context.allowed_files.length && !matchesAnyScope(file, context.allowed_files));
    if (classification !== "read_only" && draft.allowed_write_paths.length === 0) {
      findings.push(finding("allowed_files_missing", "blocking", "Write candidate has no allowed write paths.", [draft.task_draft_id]));
    }
    if (forbidden.length) {
      findings.push(finding("forbidden_file_conflict", "blocking", `Draft references forbidden file(s): ${forbidden.join(", ")}.`, forbidden));
    }
    if (outside.length) {
      findings.push(finding("out_of_scope", "blocking", `Draft references file(s) outside team scope: ${outside.join(", ")}.`, outside));
    }
    if (!forbidden.length && !outside.length) {
      findings.push(finding("scope_valid", "info", "Draft file scope is within team boundaries.", referencedFiles));
    }
    return findings;
  }

  validateDraftValidationStrategy(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext): TaskAdoptionFinding[] {
    const classification = this.classifyReadWriteIntent(draft);
    if (classification === "read_only") return [];
    const strategy = context.sub_plan.validation_strategy;
    if (!strategy.commands.length && !strategy.required_checks.length && !draft.validation_refs.length) {
      return [finding("validation_missing", "blocking", "Write candidate is missing validation strategy.", [draft.task_draft_id])];
    }
    if (strategy.status === "blocked") {
      return [finding("validation_missing", "blocking", "Sub-plan validation strategy is blocked.", [strategy.strategy_id])];
    }
    return [];
  }

  validateDraftSuccessCriteria(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext): TaskAdoptionFinding[] {
    const classification = this.classifyReadWriteIntent(draft);
    const successCriteria = stringArray(draft.metadata_json.success_criteria);
    const stopConditions = stringArray(draft.metadata_json.stop_conditions);
    const findings: TaskAdoptionFinding[] = [];
    if (classification !== "read_only" && !successCriteria.length) {
      findings.push(finding("success_criteria_missing", "blocking", "Write or repair candidate is missing explicit success criteria.", [draft.task_draft_id]));
    }
    if ((classification === "write_candidate" || classification === "repair_candidate") && !stopConditions.length) {
      findings.push(finding("stop_conditions_missing", "blocking", "Write or repair candidate is missing stop conditions.", [draft.task_draft_id]));
    }
    const locks = this.deriveRequiredLocksForDraft(draft, context);
    if (classification !== "read_only" && !locks.length) {
      findings.push(finding("locks_missing", "blocking", "Write candidate has no derivable module or semantic lock refs.", [draft.task_draft_id]));
    }
    return findings;
  }

  deriveRequiredLocksForDraft(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext) {
    const derived = draft.proposed_files.map((file) => `module:${file.split(/[\\/]/)[0]}`).filter((entry) => entry !== "module:");
    return uniqueStrings([...context.module_locks, ...context.semantic_locks, ...derived]);
  }

  createAdoptedTaskProposal(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext): AdoptedTaskProposal {
    const classification = this.classifyReadWriteIntent(draft);
    const locks = this.deriveRequiredLocksForDraft(draft, context);
    const successCriteria = stringArray(draft.metadata_json.success_criteria);
    const stopConditions = stringArray(draft.metadata_json.stop_conditions);
    return createAdoptedTaskProposal({
      run_id: context.sub_plan.run_id,
      team_id: context.sub_plan.team_id,
      sub_plan_id: context.sub_plan.sub_plan_id,
      source_task_draft_id: draft.task_draft_id,
      parent_task_id: typeof draft.metadata_json.parent_task_id === "string" ? draft.metadata_json.parent_task_id : undefined,
      title: draft.title,
      objective: draft.objective,
      task_type: String(draft.metadata_json.task_type ?? context.sub_plan.team_type),
      read_or_write_classification: classification,
      proposed_role: draft.role_hint,
      allowed_files: classification === "read_only" ? [] : uniqueStrings(draft.allowed_write_paths),
      forbidden_files: context.forbidden_files,
      read_only_files: uniqueStrings([...context.read_only_files, ...draft.proposed_files]),
      module_locks: locks.filter((lock) => lock.startsWith("module:")),
      semantic_locks: locks.filter((lock) => lock.startsWith("semantic:")),
      dependencies: context.sub_plan.dependencies.map((dependency) => dependency.target_ref),
      validation_strategy: context.sub_plan.validation_strategy,
      success_criteria: successCriteria.length ? successCriteria : [draft.objective],
      stop_conditions: stopConditions,
      prompt_template_ref: `role_prompt:${draft.role_hint}`,
      context_pack_ref: context.context_pack_ref,
      evidence_refs: uniqueStrings([...draft.evidence_refs, ...context.sub_plan.evidence_refs]),
      risk_level: riskLevelForDraft(draft, context.sub_plan),
      readiness_status: "metadata_only",
      adoption_status: "proposed",
      metadata_json: {
        source_sub_plan_ref: context.sub_plan.artifact_ref,
        source_task_draft_metadata: draft.metadata_json,
        no_executor_task_created: true,
        task_graph_status: "not_scheduled"
      }
    });
  }

  summarizeAdoptionResults(result: TeamTaskAdoptionResult) {
    return {
      evaluated_drafts: result.evaluated_drafts,
      ...result.summary,
      proposal_count: result.proposals.length,
      decision_count: result.decisions.length
    };
  }

  private adoptionContext(
    subPlan: TeamSubPlan,
    draft: TeamSubPlanTaskDraft,
    scope: TeamContextScope | undefined,
    existingTaskSignatures: string[],
    alreadyAdoptedSignatures: string[],
    siblingDraftSignatures: string[]
  ): TeamTaskAdoptionContext {
    const allowed = scope?.allowed_files.length ? scope.allowed_files : stringArray(subPlan.metadata_json.team_allowed_files);
    const forbidden = uniqueStrings([...(scope?.forbidden_files ?? []), ...stringArray(subPlan.metadata_json.team_forbidden_files), ...draft.forbidden_files]);
    return {
      sub_plan: subPlan,
      draft,
      allowed_files: allowed,
      forbidden_files: forbidden,
      read_only_files: uniqueStrings([...(scope?.read_only_files ?? []), ...draft.proposed_files]),
      module_locks: uniqueStrings([...(scope?.module_locks ?? []), ...subPlan.lock_context_refs.filter((ref) => ref.startsWith("module:"))]),
      semantic_locks: uniqueStrings([...(scope?.semantic_locks ?? []), ...subPlan.lock_context_refs.filter((ref) => ref.startsWith("semantic:"))]),
      context_pack_ref: typeof subPlan.metadata_json.context_pack_ref === "string" ? subPlan.metadata_json.context_pack_ref : subPlan.required_context_refs[0],
      existing_task_signatures: existingTaskSignatures,
      already_adopted_signatures: alreadyAdoptedSignatures,
      sibling_draft_signatures: siblingDraftSignatures
    };
  }

  private duplicateFinding(draft: TeamSubPlanTaskDraft, context: TeamTaskAdoptionContext) {
    const signature = taskDraftSignature(draft.title, draft.objective);
    if (context.sibling_draft_signatures.length || context.existing_task_signatures.includes(signature) || context.already_adopted_signatures.includes(signature)) {
      return finding("duplicate", "blocking", `Duplicate task draft detected for signature ${signature}.`, [draft.task_draft_id, ...context.sibling_draft_signatures]);
    }
    return undefined;
  }

  private policy(): TaskPromotionPolicy {
    return {
      mode: this.options.config.team_task_adoption_mode,
      allow_write_task_future_candidates: this.options.config.allow_write_task_future_candidates,
      allow_executable_adoption: this.options.config.allow_executable_adoption,
      max_adopted_tasks_per_run: this.options.config.max_adopted_tasks_per_run,
      max_adopted_tasks_per_team: this.options.config.max_adopted_tasks_per_team,
      metadata_json: { source: "orchestration_config" }
    };
  }

  private async existingTaskSignatures(runId: string) {
    try {
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        return store.all<{ title: string; objective: string }>(
          "SELECT title, objective FROM factory_tasks WHERE run_id = ?",
          runId
        ).map((row) => taskDraftSignature(row.title ?? "", row.objective ?? ""));
      } finally {
        store.close();
      }
    } catch {
      try {
        return (await this.artifactStore.loadTasks(runId)).map((task) => taskDraftSignature(task.title, task.objective));
      } catch {
        return [];
      }
    }
  }

  private async alreadyAdoptedSignatures(runId: string) {
    try {
      const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, databasePath, readOnly: true });
      try {
        return store.all<{ title: string; objective: string }>(
          "SELECT title, objective FROM factory_adopted_task_proposals WHERE run_id = ?",
          runId
        ).map((row) => taskDraftSignature(row.title ?? "", row.objective ?? ""));
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }
}

function adoptionStatusFromFindings(findings: TaskAdoptionFinding[]): TaskAdoptionStatus | undefined {
  const blocking = findings.find((finding) => finding.severity === "blocking");
  if (!blocking) return undefined;
  if (blocking.code === "out_of_scope") return "out_of_scope";
  if (blocking.code === "forbidden_file_conflict") return "unsafe_write_scope";
  if (blocking.code === "validation_missing") return "missing_validation";
  if (blocking.code === "success_criteria_missing") return "missing_success_criteria";
  if (blocking.code === "locks_missing") return "missing_locks";
  return "adopted_blocked";
}

function adoptionStatusForReadiness(proposal: AdoptedTaskProposal, policy: TaskPromotionPolicy): TaskAdoptionStatus {
  if (proposal.readiness_status === "read_only_ready") return "adopted_read_only";
  if (proposal.readiness_status === "future_write_candidate") return "ready_for_future_gate";
  if (proposal.readiness_status === "executable_ready" && policy.allow_executable_adoption) return "ready_for_future_gate";
  return "adopted_metadata_only";
}

function adoptionTraceMetadata(proposal: AdoptedTaskProposal, decision: TaskAdoptionDecision, findingCount: number) {
  return {
    run_id: proposal.run_id,
    team_id: proposal.team_id,
    sub_plan_id: proposal.sub_plan_id,
    task_draft_id: proposal.source_task_draft_id,
    adopted_task_id: proposal.adopted_task_id,
    adoption_status: proposal.adoption_status,
    readiness_status: proposal.readiness_status,
    finding_count: findingCount,
    dependency_refs: proposal.dependencies,
    lock_refs: [...proposal.module_locks, ...proposal.semantic_locks],
    rejection_reason: decision.reason
  };
}

function finding(code: TaskAdoptionFinding["code"], severity: TaskAdoptionFinding["severity"], message: string, refs: string[]) {
  return createTaskAdoptionFinding({ code, severity, message, refs });
}

function riskLevelForDraft(draft: TeamSubPlanTaskDraft, subPlan: TeamSubPlan): AdoptedTaskProposal["risk_level"] {
  const risks = subPlan.risks;
  if (risks.some((risk) => risk.severity === "critical")) return "critical";
  if (risks.some((risk) => risk.severity === "high")) return "high";
  if (draft.allowed_write_paths.length || risks.some((risk) => risk.severity === "medium")) return "medium";
  return "low";
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}
