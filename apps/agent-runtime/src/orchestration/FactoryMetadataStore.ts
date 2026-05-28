import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ensureMemoryLayout } from "../memory/ProjectMemory.js";
import type {
  AgentInvocation,
  Campaign,
  ContextPack,
  ContextPackInclusionRecord,
  FinalRunReport,
  OrchestratorEvent,
  Run,
  RunMetrics,
  Task
} from "./OrchestrationModels.js";
import type {
  AgentInstance,
  AgentTemplate,
  ConsensusGroup,
  SchedulerTraceEntry,
  StaffingPlan,
  SwarmEvent,
  SwarmMetrics,
  SwarmRun,
  WorkItem,
  WorkItemResult
} from "./SwarmModels.js";
import type { RunTransitionRecord } from "./RunStateMachine.js";
import {
  factoryTraceEventFromArtifactEvent,
  factoryTraceEventFromSchedulerTrace,
  type FactoryTraceEvent
} from "./FactoryTraceEvents.js";
import type { PromptArtifactMetadata } from "./PromptSystem.js";
import type { PromptQualityResult } from "./PromptQualityGate.js";
import type { PromptWriterAdoptionDecision, PromptWriterMode } from "./PromptWriterModels.js";
import type { FactoryLock, LockConflict } from "./FactoryLockModels.js";
import type {
  AgentTeam,
  AgentTeamBudget,
  AgentTeamRoleAssignments,
  TeamContextScope,
  TeamScopedMemoryQuery
} from "./AgentTeamModels.js";
import type {
  IntegrationCandidate,
  IntegrationConflict,
  IntegrationPlan,
  IntegrationResult
} from "./IntegrationModels.js";
import type {
  MergedPlan,
  PlanEvaluation,
  PlanVariant,
  PlanningEvidenceItem,
  PlanningEvidenceUsage
} from "./MultiPlanModels.js";
import type { TeamSubPlan, TeamSubPlanAggregation } from "./TeamSubPlanningModels.js";
import type { AdoptedTaskProposal, TaskAdoptionDecision, TaskReadinessProfile } from "./TeamTaskAdoptionModels.js";
import type {
  ProposedTaskGraph,
  ProposedTaskGraphEdge,
  ProposedTaskGraphNode,
  ProposedTaskGraphValidationResult
} from "./ProposedTaskGraphModels.js";
import type {
  ExecutionReadinessBatch,
  ExecutionReadinessDecision,
  ExecutionReadinessRequirement,
  HumanApprovalRequirement
} from "./ExecutionReadinessModels.js";
import type {
  ApprovalConstraint,
  ExecutionPromotionRequest,
  HumanApprovalRecord,
  PromotionQueueItem
} from "./ExecutionApprovalModels.js";
import type {
  ExecutionPreparationBatch,
  ExecutionPreparationBlocker,
  ExecutionPreparationPlan,
  ExecutionPreparationWarning
} from "./ExecutionPreparationModels.js";
import type {
  OneWriterDryRunBatch,
  OneWriterDryRunProposal
} from "./OneWriterDryRunModels.js";
import type {
  PatchProposalFileChange,
  PatchProposalScopeCheck
} from "./PatchProposalModels.js";
import type {
  PatchProposalReview,
  PatchProposalReviewBatch,
  PatchProposalReviewFinding
} from "./PatchProposalReviewModels.js";
import type {
  ValidationCandidate,
  ValidationCandidateBatch,
  ValidationCommandPreflight,
  ValidationEnvironmentReadiness
} from "./ValidationCandidateModels.js";
import type {
  PatchApplySandboxResult,
  PatchDryApplyConflict,
  PatchSandboxBatch
} from "./PatchApplySandboxModels.js";
import type {
  SandboxValidationBatch,
  SandboxValidationCommandResult,
  SandboxValidationResult
} from "./SandboxValidationModels.js";
import type {
  IntegrationCandidateBatch,
  IntegrationCandidateBlocker,
  SandboxValidatedIntegrationCandidate
} from "./SandboxIntegrationCandidateModels.js";

export const FACTORY_METADATA_SCHEMA_VERSION = 23;
export const FACTORY_METADATA_DATABASE_FILENAME = "factory_metadata.sqlite";

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
};

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

export type FactoryArtifactRecordInput = {
  runId?: string;
  taskId?: string;
  campaignId?: string;
  kind: string;
  artifactRef: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryOutputRecordInput = {
  runId: string;
  taskId?: string;
  sourceId: string;
  kind: string;
  status?: string;
  artifactRef: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryReviewRecordInput = {
  runId: string;
  taskId?: string;
  sourceId: string;
  kind: string;
  status?: string;
  decision?: string;
  artifactRef: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryValidationRecordInput = {
  runId: string;
  taskId?: string;
  sourceId: string;
  kind: string;
  status?: string;
  artifactRef: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryIntegrationCandidateRecordInput = {
  candidate: IntegrationCandidate;
  artifactRef?: string;
};

export type FactoryIntegrationPlanRecordInput = {
  plan: IntegrationPlan;
  artifactRef?: string;
};

export type FactoryIntegrationConflictRecordInput = {
  conflict: IntegrationConflict;
  artifactRef?: string;
};

export type FactoryIntegrationResultRecordInput = {
  result: IntegrationResult;
  artifactRef?: string;
};

export type FactoryAgentTeamRecordInput = {
  team: AgentTeam;
  artifactRef?: string;
};

export type FactoryAgentTeamAssignmentRecordInput = {
  assignmentId: string;
  runId: string;
  teamId: string;
  assignmentType: "task" | "agent";
  targetId: string;
  role?: keyof AgentTeamRoleAssignments | string;
  status?: string;
  artifactRef?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryAgentTeamBudgetRecordInput = {
  teamId: string;
  runId: string;
  budget: AgentTeamBudget;
  inheritedFromTeamId?: string;
  artifactRef?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryTeamContextItemRecordInput = {
  contextItem: ContextPackInclusionRecord;
  contextPackId: string;
  teamId: string;
  runId: string;
  taskId?: string;
  artifactRef: string;
  createdAt?: string;
};

export type FactoryTeamSubPlanRecordInput = {
  plan: TeamSubPlan;
  artifactRef?: string;
};

export type FactoryTeamSubPlanAggregationRecordInput = {
  aggregation: TeamSubPlanAggregation;
  artifactRef?: string;
};

export type FactoryAdoptedTaskProposalRecordInput = {
  proposal: AdoptedTaskProposal;
  artifactRef?: string;
};

export type FactoryTaskAdoptionDecisionRecordInput = {
  decision: TaskAdoptionDecision;
  artifactRef?: string;
};

export type FactoryTaskReadinessResultRecordInput = {
  readiness: TaskReadinessProfile;
  artifactRef?: string;
};

export type FactoryProposedTaskGraphRecordInput = {
  graph: ProposedTaskGraph;
  artifactRef?: string;
};

export type FactoryProposedTaskNodeRecordInput = {
  graphId: string;
  node: ProposedTaskGraphNode;
  artifactRef?: string;
};

export type FactoryProposedTaskEdgeRecordInput = {
  graphId: string;
  edge: ProposedTaskGraphEdge;
  artifactRef?: string;
};

export type FactoryProposedTaskGraphValidationRecordInput = {
  validation: ProposedTaskGraphValidationResult;
  artifactRef?: string;
};

export type FactoryExecutionReadinessDecisionRecordInput = {
  decision: ExecutionReadinessDecision;
  artifactRef?: string;
};

export type FactoryExecutionReadinessRequirementRecordInput = {
  decisionId: string;
  decision: ExecutionReadinessDecision;
  requirement: ExecutionReadinessRequirement;
  artifactRef?: string;
};

export type FactoryExecutionApprovalRequirementRecordInput = {
  approval: HumanApprovalRequirement;
  artifactRef?: string;
};

export type FactoryExecutionReadinessBatchRecordInput = {
  batch: ExecutionReadinessBatch;
  artifactRef?: string;
};

export type FactoryExecutionPromotionRequestRecordInput = {
  request: ExecutionPromotionRequest;
  artifactRef?: string;
};

export type FactoryHumanApprovalRecordInput = {
  approval: HumanApprovalRecord;
  artifactRef?: string;
};

export type FactoryPromotionQueueItemRecordInput = {
  item: PromotionQueueItem;
  artifactRef?: string;
};

export type FactoryExecutionPreparationPlanRecordInput = {
  plan: ExecutionPreparationPlan;
  artifactRef?: string;
};

export type FactoryExecutionPreparationBatchRecordInput = {
  batch: ExecutionPreparationBatch;
  artifactRef?: string;
};

export type FactoryExecutionPreparationBlockerRecordInput = {
  blocker: ExecutionPreparationBlocker;
  runId: string;
  queueItemId: string;
  artifactRef?: string;
};

export type FactoryExecutionPreparationWarningRecordInput = {
  warning: ExecutionPreparationWarning;
  runId: string;
  queueItemId: string;
  artifactRef?: string;
};

export type FactoryOneWriterDryRunProposalRecordInput = {
  proposal: OneWriterDryRunProposal;
  artifactRef?: string;
};

export type FactoryPatchProposalFileRecordInput = {
  proposal: OneWriterDryRunProposal;
  fileChange: PatchProposalFileChange;
};

export type FactoryPatchProposalScopeCheckRecordInput = {
  proposal: OneWriterDryRunProposal;
  scopeCheck: PatchProposalScopeCheck;
};

export type FactoryDryRunWriterBatchRecordInput = {
  batch: OneWriterDryRunBatch;
  artifactRef?: string;
};

export type FactoryPatchProposalReviewRecordInput = {
  review: PatchProposalReview;
  artifactRef?: string;
};

export type FactoryPatchReviewFindingRecordInput = {
  review: PatchProposalReview;
  finding: PatchProposalReviewFinding;
};

export type FactoryPatchReviewBatchRecordInput = {
  batch: PatchProposalReviewBatch;
  artifactRef?: string;
};

export type FactoryValidationCandidateRecordInput = {
  candidate: ValidationCandidate;
  artifactRef?: string;
};

export type FactoryValidationCommandPreflightRecordInput = {
  candidate: ValidationCandidate;
  commandPreflight: ValidationCommandPreflight;
};

export type FactoryValidationEnvironmentPreflightRecordInput = {
  candidate: ValidationCandidate;
  environmentReadiness: ValidationEnvironmentReadiness;
};

export type FactoryValidationCandidateBatchRecordInput = {
  batch: ValidationCandidateBatch;
  artifactRef?: string;
};

export type FactoryPatchApplySandboxResultRecordInput = {
  result: PatchApplySandboxResult;
  artifactRef?: string;
};

export type FactoryPatchApplyConflictRecordInput = {
  result: PatchApplySandboxResult;
  conflict: PatchDryApplyConflict;
};

export type FactoryPatchApplySandboxBatchRecordInput = {
  batch: PatchSandboxBatch;
  artifactRef?: string;
};

export type FactorySandboxValidationResultRecordInput = {
  result: SandboxValidationResult;
  artifactRef?: string;
};

export type FactorySandboxValidationCommandRecordInput = {
  result: SandboxValidationResult;
  commandResult: SandboxValidationCommandResult;
};

export type FactorySandboxValidationBatchRecordInput = {
  batch: SandboxValidationBatch;
  artifactRef?: string;
};

export type FactorySandboxIntegrationCandidateRecordInput = {
  candidate: SandboxValidatedIntegrationCandidate;
  artifactRef?: string;
};

export type FactorySandboxIntegrationCandidateBlockerRecordInput = {
  candidate: SandboxValidatedIntegrationCandidate;
  blocker: IntegrationCandidateBlocker;
};

export type FactorySandboxIntegrationCandidateBatchRecordInput = {
  batch: IntegrationCandidateBatch;
  artifactRef?: string;
};

export type FactoryApprovalScopeConstraintRecordInput = {
  runId: string;
  sourceId: string;
  sourceType: "promotion_request" | "human_approval" | "promotion_queue_item";
  constraint: ApprovalConstraint;
  artifactRef?: string;
  createdAt?: string;
};

export type FactoryWorkerInvocationRecordInput = {
  workerInvocationId: string;
  runId: string;
  taskId?: string;
  workItemId?: string;
  agentId?: string;
  agentRole: string;
  workerMode: string;
  providerName?: string;
  modelName?: string;
  promptId?: string;
  promptQualityResultId?: string;
  rawOutputRef?: string;
  parsedOutputRef?: string;
  outputSchemaName?: string;
  outputSchemaStatus?: string;
  traceEventId?: string;
  status: string;
  errorSummary?: string;
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryPlanningEvidenceLinkInput = {
  linkId: string;
  runId: string;
  evidenceId: string;
  planId?: string;
  mergedPlanId?: string;
  usageType: PlanningEvidenceUsage;
  influenceSummary: string;
  createdAt?: string;
};

export type FactoryPromptWriterOutputRecordInput = {
  outputId: string;
  runId: string;
  taskId: string;
  targetAgentRole: string;
  targetPromptType: string;
  mode: PromptWriterMode;
  providerMode: string;
  templateId: string;
  templateVersion: string;
  promptWriterArtifactRef?: string;
  candidatePromptArtifactRef?: string;
  candidatePromptQualityResultId?: string;
  outputSchemaStatus: string;
  confidence?: number;
  adoptionRecommendation?: string;
  status: string;
  traceEventId?: string;
  metadata?: Record<string, unknown>;
};

export type FactoryPromptWriterAdoptionDecisionRecordInput = {
  decision: PromptWriterAdoptionDecision;
  metadata?: Record<string, unknown>;
};

export type FactoryLockRecordInput = {
  lock: FactoryLock;
  artifactRef: string;
  conflict?: LockConflict;
};

export async function resolveFactoryMetadataDatabasePath(workspacePath: string, memoryDir?: string) {
  const memory = await ensureMemoryLayout(workspacePath, memoryDir);
  return path.join(memory.rootDir, FACTORY_METADATA_DATABASE_FILENAME);
}

export class FactoryMetadataStore {
  private constructor(
    readonly databasePath: string,
    private readonly database: SqliteDatabase,
    private readonly memoryRoot: string
  ) {}

  static async open(input: { workspacePath: string; memoryDir?: string; databasePath?: string; readOnly?: boolean }) {
    const databasePath = input.databasePath ?? await resolveFactoryMetadataDatabasePath(input.workspacePath, input.memoryDir);
    await mkdir(path.dirname(databasePath), { recursive: true });
    const sqlite = await import("node:sqlite") as SqliteModule;
    const rawDatabase = new sqlite.DatabaseSync(databasePath, { readOnly: input.readOnly });
    const database = normalizeSqliteBindings(rawDatabase);
    const store = new FactoryMetadataStore(databasePath, database, path.dirname(databasePath));
    if (!input.readOnly) store.initializeSchema();
    return store;
  }

  initializeSchema() {
    this.database.exec(FACTORY_METADATA_SCHEMA_SQL);
    this.migrateTraceEventSchema();
    this.migratePromptSchema();
    this.migrateLockSchema();
    this.database.prepare(
      "INSERT INTO factory_schema_versions(id, schema_version, applied_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET schema_version = excluded.schema_version, applied_at = excluded.applied_at"
    ).run("factory_metadata", FACTORY_METADATA_SCHEMA_VERSION, nowIso());
  }

  close() {
    this.database.close();
  }

  all<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.database.prepare(sql).all(...params).map(plainRow) as T[];
  }

  get<T extends Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.database.prepare(sql).get(...params);
    return row ? plainRow(row) as T : undefined;
  }

  tableNames() {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'factory_%' ORDER BY name"
    ).map((row) => row.name);
  }

  recordFactoryTraceEvent(event: FactoryTraceEvent) {
    const artifactRef = event.artifact_refs[0];
    this.database.prepare(`
      INSERT INTO factory_trace_events (
        id, trace_event_id, run_id, campaign_id, task_id, parent_task_id, agent_id,
        team_id, event_type, lifecycle_stage, previous_status, next_status,
        status, source_component, severity, causal_parent_event_id,
        causal_chain_id, reason, summary, message, artifact_ref,
        artifact_refs_json, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        trace_event_id = excluded.trace_event_id,
        campaign_id = COALESCE(excluded.campaign_id, factory_trace_events.campaign_id),
        task_id = COALESCE(excluded.task_id, factory_trace_events.task_id),
        parent_task_id = COALESCE(excluded.parent_task_id, factory_trace_events.parent_task_id),
        agent_id = COALESCE(excluded.agent_id, factory_trace_events.agent_id),
        team_id = COALESCE(excluded.team_id, factory_trace_events.team_id),
        event_type = excluded.event_type,
        lifecycle_stage = COALESCE(excluded.lifecycle_stage, factory_trace_events.lifecycle_stage),
        previous_status = COALESCE(excluded.previous_status, factory_trace_events.previous_status),
        next_status = COALESCE(excluded.next_status, factory_trace_events.next_status),
        status = COALESCE(excluded.status, factory_trace_events.status),
        source_component = excluded.source_component,
        severity = excluded.severity,
        causal_parent_event_id = COALESCE(excluded.causal_parent_event_id, factory_trace_events.causal_parent_event_id),
        causal_chain_id = excluded.causal_chain_id,
        reason = COALESCE(excluded.reason, factory_trace_events.reason),
        summary = COALESCE(excluded.summary, factory_trace_events.summary),
        message = COALESCE(excluded.message, factory_trace_events.message),
        artifact_ref = COALESCE(excluded.artifact_ref, factory_trace_events.artifact_ref),
        artifact_refs_json = excluded.artifact_refs_json,
        metadata_json = excluded.metadata_json
    `).run(
      event.trace_event_id,
      event.trace_event_id,
      event.run_id,
      event.campaign_id,
      event.task_id,
      event.parent_task_id,
      event.agent_id,
      event.team_id,
      event.event_type,
      event.lifecycle_stage,
      event.previous_status,
      event.next_status,
      event.next_status ?? event.previous_status,
      event.source_component,
      event.severity,
      event.causal_parent_event_id,
      event.causal_chain_id,
      event.reason,
      event.summary,
      event.summary,
      artifactRef,
      JSON.stringify(event.artifact_refs),
      event.timestamp,
      jsonMetadata(event.metadata_json)
    );
    if (artifactRef) {
      this.recordArtifact({
        runId: event.run_id,
        taskId: event.task_id,
        campaignId: event.campaign_id,
        kind: "trace_events",
        artifactRef,
        status: event.next_status ?? event.previous_status ?? event.event_type,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
        metadata: {
          trace_event_id: event.trace_event_id,
          event_type: event.event_type
        }
      });
    }
  }

  recordRunTransition(record: RunTransitionRecord) {
    this.database.prepare(`
      INSERT INTO factory_run_transitions (
        id, run_id, previous_status, next_status, canonical_previous_status,
        canonical_next_status, created_at, reason, source_component, task_id,
        artifact_refs_json, transition_trigger, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        previous_status = excluded.previous_status,
        next_status = excluded.next_status,
        canonical_previous_status = excluded.canonical_previous_status,
        canonical_next_status = excluded.canonical_next_status,
        reason = excluded.reason,
        source_component = excluded.source_component,
        task_id = excluded.task_id,
        artifact_refs_json = excluded.artifact_refs_json,
        transition_trigger = excluded.transition_trigger,
        metadata_json = excluded.metadata_json
    `).run(
      record.id,
      record.run_id,
      record.previous_status,
      record.next_status,
      record.canonical_previous_status,
      record.canonical_next_status,
      record.created_at,
      record.reason,
      record.source_component,
      record.task_id,
      JSON.stringify(record.artifact_refs),
      record.trigger,
      jsonMetadata(record.metadata)
    );
  }

  recordPlanVariant(variant: PlanVariant) {
    this.database.prepare(`
      INSERT INTO factory_plan_variants (
        id, plan_id, run_id, task_id, perspective, generation_mode, status,
        confidence, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET
        task_id = excluded.task_id,
        perspective = excluded.perspective,
        generation_mode = excluded.generation_mode,
        status = excluded.status,
        confidence = excluded.confidence,
        artifact_ref = excluded.artifact_ref,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("plan_variant", [variant.run_id, variant.plan_id]),
      variant.plan_id,
      variant.run_id,
      variant.task_id,
      variant.perspective,
      variant.generation_mode,
      "created",
      variant.confidence,
      variant.artifact_ref,
      variant.created_at,
      jsonMetadata({
        proposed_domain_count: variant.proposed_domains.length,
        proposed_task_count: variant.proposed_tasks.length,
        dependency_count: variant.dependencies.length,
        risk_count: variant.risks.length,
        unknown_count: variant.unknowns.length,
        prompt_ref: variant.prompt_ref,
        prompt_used: Boolean(variant.prompt_ref),
        no_model_prompt_used: !variant.prompt_ref,
        evidence_bundle_ref: variant.evidence_bundle_ref,
        evidence_item_count: variant.evidence_item_refs?.length ?? 0
      })
    );
  }

  recordPlanEvaluation(evaluation: PlanEvaluation) {
    this.database.prepare(`
      INSERT INTO factory_plan_evaluations (
        id, evaluation_id, run_id, task_id, plan_id, perspective, scores_json,
        selected, rejected_reason, confidence, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evaluation_id) DO UPDATE SET
        scores_json = excluded.scores_json,
        selected = excluded.selected,
        rejected_reason = excluded.rejected_reason,
        confidence = excluded.confidence,
        artifact_ref = excluded.artifact_ref,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("plan_evaluation", [evaluation.run_id, evaluation.evaluation_id]),
      evaluation.evaluation_id,
      evaluation.run_id,
      undefined,
      evaluation.plan_id,
      evaluation.perspective,
      JSON.stringify(evaluation.scores),
      evaluation.selected ? 1 : 0,
      evaluation.rejected_reason,
      evaluation.confidence,
      evaluation.artifact_ref,
      evaluation.created_at,
      jsonMetadata({
        strength_count: evaluation.strengths.length,
        weakness_count: evaluation.weaknesses.length,
        contradiction_count: evaluation.contradictions.length,
        risky_assumption_count: evaluation.risky_assumptions.length,
        evidence_item_count: evaluation.evidence_item_refs?.length ?? 0,
        evidence_influence_note_count: evaluation.evidence_influence_notes?.length ?? 0
      })
    );
  }

  recordMergedPlan(plan: MergedPlan) {
    this.database.prepare(`
      INSERT INTO factory_merged_plans (
        id, merged_plan_id, run_id, task_id, generation_mode, selected_plan_ids_json,
        rejected_plan_ids_json, confidence, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(merged_plan_id) DO UPDATE SET
        generation_mode = excluded.generation_mode,
        selected_plan_ids_json = excluded.selected_plan_ids_json,
        rejected_plan_ids_json = excluded.rejected_plan_ids_json,
        confidence = excluded.confidence,
        artifact_ref = excluded.artifact_ref,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("merged_plan", [plan.run_id, plan.merged_plan_id]),
      plan.merged_plan_id,
      plan.run_id,
      plan.task_id,
      plan.generation_mode,
      JSON.stringify(plan.selected_plan_ids),
      JSON.stringify(plan.rejected_plan_ids),
      plan.confidence,
      plan.artifact_ref,
      plan.created_at,
      jsonMetadata({
        merged_task_count: plan.merged_tasks.length,
        dependency_count: plan.dependencies.length,
        risk_count: plan.risks.length,
        assumption_count: plan.assumptions.length,
        unresolved_question_count: plan.unresolved_questions.length,
        chosen_strategy: plan.chosen_strategy,
        evidence_bundle_ref: plan.evidence_bundle_ref,
        evidence_item_count: plan.evidence_item_refs?.length ?? 0,
        evidence_conflict_count: plan.evidence_conflicts?.length ?? 0
      })
    );
  }

  recordWorkerInvocation(input: FactoryWorkerInvocationRecordInput) {
    this.database.prepare(`
      INSERT INTO factory_worker_invocations (
        id, worker_invocation_id, run_id, task_id, work_item_id, agent_id,
        agent_role, worker_mode, provider_name, model_name, prompt_id,
        prompt_quality_result_id, raw_output_ref, parsed_output_ref,
        output_schema_name, output_schema_status, trace_event_id, status,
        error_summary, created_at, completed_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_invocation_id) DO UPDATE SET
        prompt_quality_result_id = COALESCE(excluded.prompt_quality_result_id, factory_worker_invocations.prompt_quality_result_id),
        raw_output_ref = COALESCE(excluded.raw_output_ref, factory_worker_invocations.raw_output_ref),
        parsed_output_ref = COALESCE(excluded.parsed_output_ref, factory_worker_invocations.parsed_output_ref),
        output_schema_status = COALESCE(excluded.output_schema_status, factory_worker_invocations.output_schema_status),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_worker_invocations.trace_event_id),
        status = excluded.status,
        error_summary = COALESCE(excluded.error_summary, factory_worker_invocations.error_summary),
        completed_at = COALESCE(excluded.completed_at, factory_worker_invocations.completed_at),
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("worker_invocation", [input.runId, input.workerInvocationId]),
      input.workerInvocationId,
      input.runId,
      input.taskId,
      input.workItemId,
      input.agentId,
      input.agentRole,
      input.workerMode,
      input.providerName,
      input.modelName,
      input.promptId,
      input.promptQualityResultId,
      input.rawOutputRef,
      input.parsedOutputRef,
      input.outputSchemaName,
      input.outputSchemaStatus,
      input.traceEventId,
      input.status,
      input.errorSummary,
      input.createdAt,
      input.completedAt,
      jsonMetadata(input.metadata ?? {})
    );
  }

  recordPlanningEvidence(item: PlanningEvidenceItem) {
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO factory_planning_evidence (
        id, evidence_id, run_id, task_id, work_item_id, source_type,
        source_role, artifact_ref, parsed_output_ref, trace_event_id,
        confidence, freshness, summary, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        task_id = excluded.task_id,
        work_item_id = excluded.work_item_id,
        source_type = excluded.source_type,
        source_role = excluded.source_role,
        artifact_ref = excluded.artifact_ref,
        parsed_output_ref = excluded.parsed_output_ref,
        trace_event_id = excluded.trace_event_id,
        confidence = excluded.confidence,
        freshness = excluded.freshness,
        summary = excluded.summary,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("planning_evidence", [item.run_id, item.evidence_id]),
      item.evidence_id,
      item.run_id,
      item.task_id,
      item.work_item_id,
      item.source_type,
      item.source_role,
      item.artifact_ref,
      item.parsed_output_ref,
      item.trace_event_id,
      item.confidence,
      item.freshness,
      item.summary,
      jsonMetadata({
        ...item.metadata_json,
        confidence_score: item.confidence_score,
        finding_count: item.extracted_findings.length,
        risk_count: item.extracted_risks.length,
        task_count: item.extracted_tasks.length,
        validation_recommendation_count: item.extracted_validation_recommendations.length,
        dependency_count: item.extracted_dependencies.length
      }),
      createdAt
    );
  }

  recordPlanEvidenceLink(input: FactoryPlanningEvidenceLinkInput) {
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO factory_plan_evidence_links (
        id, link_id, run_id, evidence_id, plan_id, merged_plan_id,
        usage_type, influence_summary, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(link_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        merged_plan_id = excluded.merged_plan_id,
        usage_type = excluded.usage_type,
        influence_summary = excluded.influence_summary
    `).run(
      factoryMetadataStableId("plan_evidence_link", [input.runId, input.linkId]),
      input.linkId,
      input.runId,
      input.evidenceId,
      input.planId,
      input.mergedPlanId,
      input.usageType,
      input.influenceSummary,
      createdAt
    );
  }

  recordPromptWriterOutput(input: FactoryPromptWriterOutputRecordInput) {
    const createdAt = nowIso();
    this.database.prepare(`
      INSERT INTO factory_prompt_writer_outputs (
        id, prompt_writer_output_id, run_id, task_id, target_agent_role,
        target_prompt_type, mode, provider_mode, template_id, template_version,
        prompt_writer_artifact_ref, candidate_prompt_artifact_ref,
        candidate_prompt_quality_result_id, output_schema_status,
        confidence, adoption_recommendation, status, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prompt_writer_output_id) DO UPDATE SET
        prompt_writer_artifact_ref = COALESCE(excluded.prompt_writer_artifact_ref, factory_prompt_writer_outputs.prompt_writer_artifact_ref),
        candidate_prompt_artifact_ref = COALESCE(excluded.candidate_prompt_artifact_ref, factory_prompt_writer_outputs.candidate_prompt_artifact_ref),
        candidate_prompt_quality_result_id = COALESCE(excluded.candidate_prompt_quality_result_id, factory_prompt_writer_outputs.candidate_prompt_quality_result_id),
        output_schema_status = excluded.output_schema_status,
        confidence = COALESCE(excluded.confidence, factory_prompt_writer_outputs.confidence),
        adoption_recommendation = COALESCE(excluded.adoption_recommendation, factory_prompt_writer_outputs.adoption_recommendation),
        status = excluded.status,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_prompt_writer_outputs.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("prompt_writer_output", [input.runId, input.outputId]),
      input.outputId,
      input.runId,
      input.taskId,
      input.targetAgentRole,
      input.targetPromptType,
      input.mode,
      input.providerMode,
      input.templateId,
      input.templateVersion,
      input.promptWriterArtifactRef,
      input.candidatePromptArtifactRef,
      input.candidatePromptQualityResultId,
      input.outputSchemaStatus,
      input.confidence,
      input.adoptionRecommendation,
      input.status,
      input.traceEventId,
      jsonMetadata(input.metadata ?? {}),
      createdAt
    );
  }

  recordPromptWriterAdoptionDecision(input: FactoryPromptWriterAdoptionDecisionRecordInput) {
    const decision = input.decision;
    this.database.prepare(`
      INSERT INTO factory_prompt_writer_adoption_decisions (
        id, adoption_decision_id, run_id, task_id, prompt_writer_output_id,
        candidate_prompt_id, original_prompt_id, mode, decision, reason,
        quality_status, adopted, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adoption_decision_id) DO UPDATE SET
        decision = excluded.decision,
        reason = excluded.reason,
        quality_status = excluded.quality_status,
        adopted = excluded.adopted,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_prompt_writer_adoption_decisions.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("prompt_writer_adoption", [decision.run_id, decision.adoption_decision_id]),
      decision.adoption_decision_id,
      decision.run_id,
      decision.task_id,
      decision.prompt_writer_output_id,
      decision.candidate_prompt_id,
      decision.original_prompt_id,
      decision.mode,
      decision.decision,
      decision.reason,
      decision.quality_status,
      decision.adopted ? 1 : 0,
      decision.trace_event_id,
      jsonMetadata({
        ...decision.metadata_json,
        ...(input.metadata ?? {}),
        artifact_ref: decision.artifact_ref
      }),
      decision.created_at
    );
  }

  recordRun(run: Run, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_runs (
        id, run_kind, campaign_id, parent_run_id, status, mode, user_request,
        workspace_path, memory_dir, artifacts_path, run_artifact_ref,
        schema_version, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_kind = excluded.run_kind,
        campaign_id = excluded.campaign_id,
        parent_run_id = excluded.parent_run_id,
        status = excluded.status,
        mode = excluded.mode,
        user_request = excluded.user_request,
        workspace_path = excluded.workspace_path,
        memory_dir = excluded.memory_dir,
        artifacts_path = excluded.artifacts_path,
        run_artifact_ref = excluded.run_artifact_ref,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      run.id,
      "orchestration",
      undefined,
      undefined,
      run.status,
      run.config.execution_mode,
      run.user_request,
      run.config.workspace_path,
      run.config.memory_dir,
      run.artifacts_path,
      artifactRef,
      run.schema_version,
      run.created_at,
      run.updated_at,
      jsonMetadata({ root_task_count: run.root_task_ids.length, summary_present: Boolean(run.summary) })
    );
    this.recordArtifact({
      runId: run.id,
      kind: "run",
      artifactRef,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    });
  }

  recordSwarmRun(run: SwarmRun, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_runs (
        id, run_kind, campaign_id, parent_run_id, status, mode, user_request,
        workspace_path, memory_dir, artifacts_path, run_artifact_ref,
        schema_version, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_kind = excluded.run_kind,
        campaign_id = excluded.campaign_id,
        parent_run_id = excluded.parent_run_id,
        status = excluded.status,
        mode = excluded.mode,
        user_request = excluded.user_request,
        artifacts_path = excluded.artifacts_path,
        run_artifact_ref = excluded.run_artifact_ref,
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      run.id,
      "swarm",
      run.campaign_id,
      run.parent_run_id,
      run.status,
      run.mode,
      run.user_goal,
      undefined,
      undefined,
      run.artifacts_path,
      artifactRef,
      run.schema_version,
      run.created_at,
      run.updated_at,
      jsonMetadata({
        effective_total_logical_agents: run.effective_total_logical_agents,
        active_agent_count: run.active_agent_count,
        max_supported_logical_agents: run.max_supported_logical_agents
      })
    );
    this.recordArtifact({
      runId: run.id,
      campaignId: run.campaign_id,
      kind: "swarm_run",
      artifactRef,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at
    });
  }

  recordTasks(runId: string, tasks: Task[], artifactRef: string) {
    this.recordArtifact({ runId, kind: "tasks", artifactRef });
    for (const task of tasks) {
      this.recordTask(task, artifactRef);
    }
  }

  recordTask(task: Task, artifactRef?: string) {
    const recordId = factoryMetadataStableId("task", [task.run_id, task.id]);
    this.database.prepare(`
      INSERT INTO factory_tasks (
        id, run_id, task_id, parent_task_id, task_kind, title, objective, role,
        status, priority, artifact_ref, schema_version, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_task_id = excluded.parent_task_id,
        task_kind = excluded.task_kind,
        title = excluded.title,
        objective = excluded.objective,
        role = excluded.role,
        status = excluded.status,
        priority = excluded.priority,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_tasks.artifact_ref),
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      recordId,
      task.run_id,
      task.id,
      task.parent_id,
      "orchestration_task",
      task.title,
      task.objective,
      task.role_required,
      task.status,
      undefined,
      artifactRef,
      task.schema_version,
      task.created_at,
      task.updated_at,
      jsonMetadata({
        dependency_count: task.dependencies.length,
        artifact_count: task.artifacts.length,
        validation_command_count: task.validation_commands.length,
        attempt_count: task.attempt_count
      })
    );
    this.replaceTaskDependencies(task.run_id, task.id, task.dependencies, artifactRef, task.updated_at);
  }

  recordWorkItems(runId: string, workItems: WorkItem[], artifactRef: string) {
    this.recordArtifact({ runId, kind: "swarm_work_items", artifactRef });
    for (const item of workItems) {
      this.recordWorkItem(item, artifactRef);
    }
  }

  recordWorkItem(item: WorkItem, artifactRef?: string) {
    const recordId = factoryMetadataStableId("task", [item.swarm_run_id, item.id]);
    this.database.prepare(`
      INSERT INTO factory_tasks (
        id, run_id, task_id, parent_task_id, task_kind, title, objective, role,
        status, priority, artifact_ref, schema_version, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_task_id = excluded.parent_task_id,
        task_kind = excluded.task_kind,
        title = excluded.title,
        objective = excluded.objective,
        role = excluded.role,
        status = excluded.status,
        priority = excluded.priority,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_tasks.artifact_ref),
        schema_version = excluded.schema_version,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      recordId,
      item.swarm_run_id,
      item.id,
      item.task_id,
      `swarm_${item.type}`,
      item.type,
      item.expected_output_schema,
      item.required_role,
      item.status,
      item.priority,
      artifactRef,
      item.schema_version,
      item.created_at,
      item.updated_at,
      jsonMetadata({
        dependency_count: item.dependencies.length,
        read_file_count: item.read_files.length,
        write_file_count: item.write_files.length,
        attempt_count: item.attempt_count,
        risk_level: item.risk_level
      })
    );
    this.replaceTaskDependencies(item.swarm_run_id, item.id, item.dependencies, artifactRef, item.updated_at);
  }

  recordPromptFromInvocation(invocation: AgentInvocation, artifactRef: string) {
    if (invocation.prompt_metadata?.prompt_artifact_ref) {
      this.recordArtifact({
        runId: invocation.run_id,
        taskId: invocation.task_id,
        kind: "invocation",
        artifactRef,
        status: invocation.status,
        createdAt: invocation.started_at,
        updatedAt: invocation.finished_at ?? invocation.started_at
      });
      return;
    }
    this.database.prepare(`
      INSERT INTO factory_prompts (
        id, prompt_id, run_id, task_id, invocation_id, role, agent_role, prompt_kind,
        prompt_type, status, prompt_hash, rendered_prompt_hash, prompt_chars,
        context_pack_ref, artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        role = excluded.role,
        agent_role = excluded.agent_role,
        status = excluded.status,
        prompt_hash = excluded.prompt_hash,
        rendered_prompt_hash = excluded.rendered_prompt_hash,
        prompt_chars = excluded.prompt_chars,
        context_pack_ref = excluded.context_pack_ref,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      invocation.id,
      invocation.id,
      invocation.run_id,
      invocation.task_id,
      invocation.id,
      invocation.role,
      invocation.role,
      "agent_invocation",
      "agent_invocation",
      invocation.status,
      sha256(invocation.prompt),
      sha256(invocation.prompt),
      invocation.prompt.length,
      invocation.context_pack_ref,
      artifactRef,
      invocation.started_at,
      invocation.finished_at ?? invocation.started_at,
      jsonMetadata({ context_pack_ref: invocation.context_pack_ref, has_error: Boolean(invocation.error) })
    );
    this.recordArtifact({
      runId: invocation.run_id,
      taskId: invocation.task_id,
      kind: "invocation",
      artifactRef,
      status: invocation.status,
      createdAt: invocation.started_at,
      updatedAt: invocation.finished_at ?? invocation.started_at
    });
    if (invocation.raw_output_ref) {
      this.recordOutput({
        runId: invocation.run_id,
        taskId: invocation.task_id,
        sourceId: invocation.id,
        kind: "raw_output",
        status: invocation.status,
        artifactRef: invocation.raw_output_ref,
        createdAt: invocation.started_at,
        updatedAt: invocation.finished_at ?? invocation.started_at
      });
    }
    if (invocation.parsed_output_ref) {
      this.recordOutput({
        runId: invocation.run_id,
        taskId: invocation.task_id,
        sourceId: invocation.id,
        kind: "parsed_output",
        status: invocation.status,
        artifactRef: invocation.parsed_output_ref,
        createdAt: invocation.started_at,
        updatedAt: invocation.finished_at ?? invocation.started_at
      });
    }
  }

  recordPromptMetadata(input: PromptArtifactMetadata) {
    this.database.prepare(`
      INSERT INTO factory_prompts (
        id, prompt_id, run_id, task_id, agent_id, role, agent_role,
        prompt_kind, prompt_type, status, template_id, template_version,
        renderer_version, template_input_schema_version, input_hash,
        rendered_prompt_hash, prompt_hash, prompt_chars, context_pack_ref,
        output_schema_name, artifact_ref, source_component, created_at,
        updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        agent_id = COALESCE(excluded.agent_id, factory_prompts.agent_id),
        role = excluded.role,
        agent_role = excluded.agent_role,
        prompt_kind = excluded.prompt_kind,
        prompt_type = excluded.prompt_type,
        status = excluded.status,
        template_id = excluded.template_id,
        template_version = excluded.template_version,
        renderer_version = excluded.renderer_version,
        template_input_schema_version = excluded.template_input_schema_version,
        input_hash = excluded.input_hash,
        rendered_prompt_hash = excluded.rendered_prompt_hash,
        prompt_hash = excluded.prompt_hash,
        prompt_chars = excluded.prompt_chars,
        context_pack_ref = excluded.context_pack_ref,
        output_schema_name = excluded.output_schema_name,
        artifact_ref = excluded.artifact_ref,
        source_component = excluded.source_component,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      input.prompt_id,
      input.prompt_id,
      input.run_id,
      input.task_id,
      input.agent_id,
      input.agent_role,
      input.agent_role,
      input.prompt_type,
      input.prompt_type,
      "rendered",
      input.template_id,
      input.template_version,
      input.renderer_version,
      input.template_input_schema_version,
      input.input_hash,
      input.rendered_prompt_hash,
      input.rendered_prompt_hash,
      undefined,
      input.context_pack_ref,
      input.output_schema_name,
      input.artifact_ref,
      input.source_component,
      input.created_at,
      input.created_at,
      jsonMetadata(input.metadata_json)
    );
    this.recordArtifact({
      runId: input.run_id,
      taskId: input.task_id,
      kind: "prompt",
      artifactRef: input.artifact_ref,
      status: "rendered",
      createdAt: input.created_at,
      updatedAt: input.created_at,
      metadata: {
        prompt_id: input.prompt_id,
        template_id: input.template_id,
        template_version: input.template_version,
        rendered_prompt_hash: input.rendered_prompt_hash
      }
    });
  }

  recordPromptQualityResult(result: PromptQualityResult, artifactRef: string, traceEventId?: string) {
    this.database.prepare(`
      INSERT INTO factory_prompt_quality_results (
        id, quality_result_id, prompt_id, run_id, task_id, agent_id, agent_role,
        status, blocking, role_profile, checks_passed_count, warnings_count,
        failures_count, blocked_count, findings_json, artifact_ref, trace_event_id,
        created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        blocking = excluded.blocking,
        role_profile = excluded.role_profile,
        checks_passed_count = excluded.checks_passed_count,
        warnings_count = excluded.warnings_count,
        failures_count = excluded.failures_count,
        blocked_count = excluded.blocked_count,
        findings_json = excluded.findings_json,
        artifact_ref = excluded.artifact_ref,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_prompt_quality_results.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      result.quality_result_id,
      result.quality_result_id,
      result.prompt_id,
      result.run_id,
      result.task_id,
      result.agent_id,
      result.agent_role,
      result.status,
      result.blocking ? 1 : 0,
      result.role_profile,
      result.checks_passed_count,
      result.warnings_count,
      result.failures_count,
      result.blocked_count,
      JSON.stringify(result.findings),
      artifactRef,
      traceEventId ?? result.trace_event_id,
      result.created_at,
      jsonMetadata({
        ...result.metadata_json,
        unsafe_pattern_hits: result.unsafe_pattern_hits,
        consistency_checks: result.consistency_checks,
        suggested_remediation: result.suggested_remediation,
        checked_metadata_keys: Object.keys(result.checked_metadata).sort()
      })
    );
    this.recordArtifact({
      runId: result.run_id,
      taskId: result.task_id,
      kind: "prompt_quality",
      artifactRef,
      status: result.status,
      createdAt: result.created_at,
      updatedAt: result.created_at,
      metadata: {
        prompt_id: result.prompt_id,
        quality_result_id: result.quality_result_id,
        blocking: result.blocking,
        role_profile: result.role_profile
      }
    });
  }

  recordOutput(input: FactoryOutputRecordInput) {
    const recordId = factoryMetadataStableId("output", [input.runId, input.kind, input.sourceId]);
    this.database.prepare(`
      INSERT INTO factory_outputs (
        id, run_id, task_id, source_id, output_kind, status, artifact_ref,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = COALESCE(excluded.task_id, factory_outputs.task_id),
        status = COALESCE(excluded.status, factory_outputs.status),
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      recordId,
      input.runId,
      input.taskId,
      input.sourceId,
      input.kind,
      input.status,
      input.artifactRef,
      input.createdAt ?? nowIso(),
      input.updatedAt ?? input.createdAt ?? nowIso(),
      jsonMetadata(input.metadata ?? {})
    );
    this.recordArtifact({
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      artifactRef: input.artifactRef,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
  }

  recordReview(input: FactoryReviewRecordInput) {
    const recordId = factoryMetadataStableId("review", [input.runId, input.kind, input.sourceId]);
    this.database.prepare(`
      INSERT INTO factory_reviews (
        id, run_id, task_id, source_id, review_kind, status, decision,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = COALESCE(excluded.task_id, factory_reviews.task_id),
        status = COALESCE(excluded.status, factory_reviews.status),
        decision = COALESCE(excluded.decision, factory_reviews.decision),
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      recordId,
      input.runId,
      input.taskId,
      input.sourceId,
      input.kind,
      input.status,
      input.decision,
      input.artifactRef,
      input.createdAt ?? nowIso(),
      input.updatedAt ?? input.createdAt ?? nowIso(),
      jsonMetadata(input.metadata ?? {})
    );
    this.recordArtifact({
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      artifactRef: input.artifactRef,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
  }

  recordValidation(input: FactoryValidationRecordInput) {
    const recordId = factoryMetadataStableId("validation", [input.runId, input.kind, input.sourceId]);
    this.database.prepare(`
      INSERT INTO factory_validations (
        id, run_id, task_id, source_id, validation_kind, status,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = COALESCE(excluded.task_id, factory_validations.task_id),
        status = COALESCE(excluded.status, factory_validations.status),
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      recordId,
      input.runId,
      input.taskId,
      input.sourceId,
      input.kind,
      input.status,
      input.artifactRef,
      input.createdAt ?? nowIso(),
      input.updatedAt ?? input.createdAt ?? nowIso(),
      jsonMetadata(input.metadata ?? {})
    );
    this.recordArtifact({
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      artifactRef: input.artifactRef,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
  }

  recordIntegrationCandidate(input: FactoryIntegrationCandidateRecordInput) {
    const candidate = input.candidate;
    this.database.prepare(`
      INSERT INTO factory_integration_candidates (
        candidate_id, run_id, task_id, patch_ref, change_artifact_ref, review_ref,
        validation_ref, changed_files_json, module_locks_json, semantic_locks_json,
        dependencies_json, status, risk_level, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET
        patch_ref = excluded.patch_ref,
        change_artifact_ref = excluded.change_artifact_ref,
        review_ref = excluded.review_ref,
        validation_ref = excluded.validation_ref,
        changed_files_json = excluded.changed_files_json,
        module_locks_json = excluded.module_locks_json,
        semantic_locks_json = excluded.semantic_locks_json,
        dependencies_json = excluded.dependencies_json,
        status = excluded.status,
        risk_level = excluded.risk_level,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_integration_candidates.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      candidate.candidate_id,
      candidate.run_id,
      candidate.task_id,
      candidate.patch_ref,
      candidate.change_artifact_ref,
      candidate.review_ref,
      candidate.validation_ref,
      JSON.stringify(candidate.changed_files),
      JSON.stringify(candidate.module_locks),
      JSON.stringify(candidate.semantic_locks),
      JSON.stringify(candidate.dependencies),
      candidate.status,
      candidate.risk_level,
      input.artifactRef,
      nowIso(),
      jsonMetadata({
        ...candidate.metadata_json,
        review_decision: candidate.review_decision,
        validation_status: candidate.validation_status,
        rejection_reasons: candidate.rejection_reasons
      })
    );
    if (input.artifactRef) {
      this.recordArtifact({
        runId: candidate.run_id,
        taskId: candidate.task_id,
        kind: "integration_candidate",
        artifactRef: input.artifactRef,
        status: candidate.status,
        metadata: { candidate_id: candidate.candidate_id, risk_level: candidate.risk_level }
      });
    }
  }

  recordIntegrationPlan(input: FactoryIntegrationPlanRecordInput) {
    const plan = input.plan;
    this.database.prepare(`
      INSERT INTO factory_integration_plans (
        integration_plan_id, run_id, dependency_order_json, conflict_count,
        required_locks_json, validation_plan_json, rollback_plan_ref,
        artifact_ref, status, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_plan_id) DO UPDATE SET
        dependency_order_json = excluded.dependency_order_json,
        conflict_count = excluded.conflict_count,
        required_locks_json = excluded.required_locks_json,
        validation_plan_json = excluded.validation_plan_json,
        rollback_plan_ref = excluded.rollback_plan_ref,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_integration_plans.artifact_ref),
        status = excluded.status,
        metadata_json = excluded.metadata_json
    `).run(
      plan.integration_plan_id,
      plan.run_id,
      JSON.stringify(plan.dependency_order),
      plan.conflict_checks.length,
      JSON.stringify(plan.required_locks),
      JSON.stringify({
        status: plan.validation_plan.status,
        commands: plan.validation_plan.commands,
        impacted_files: plan.validation_plan.impacted_files,
        validation_refs: plan.validation_plan.validation_refs
      }),
      plan.rollback_plan.artifact_ref,
      input.artifactRef,
      plan.conflict_checks.some((conflict) => conflict.severity === "blocking") ? "blocked" : "planned",
      plan.created_at,
      jsonMetadata({
        candidate_count: plan.candidates.length,
        batch_count: plan.batches.length,
        warnings: plan.warnings,
        artifact_ref: input.artifactRef
      })
    );
    if (input.artifactRef) {
      this.recordArtifact({
        runId: plan.run_id,
        kind: "integration_plan",
        artifactRef: input.artifactRef,
        status: plan.conflict_checks.some((conflict) => conflict.severity === "blocking") ? "blocked" : "planned",
        createdAt: plan.created_at,
        updatedAt: plan.created_at,
        metadata: { integration_plan_id: plan.integration_plan_id, candidate_count: plan.candidates.length }
      });
    }
  }

  recordIntegrationConflict(input: FactoryIntegrationConflictRecordInput) {
    const conflict = input.conflict;
    this.database.prepare(`
      INSERT INTO factory_integration_conflicts (
        conflict_id, run_id, candidate_ids_json, conflict_type, changed_files_json,
        lock_refs_json, severity, reason, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conflict_id) DO UPDATE SET
        candidate_ids_json = excluded.candidate_ids_json,
        conflict_type = excluded.conflict_type,
        changed_files_json = excluded.changed_files_json,
        lock_refs_json = excluded.lock_refs_json,
        severity = excluded.severity,
        reason = excluded.reason,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_integration_conflicts.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      conflict.conflict_id,
      conflict.run_id,
      JSON.stringify(conflict.candidate_ids),
      conflict.conflict_type,
      JSON.stringify(conflict.changed_files),
      JSON.stringify(conflict.lock_refs),
      conflict.severity,
      conflict.reason,
      input.artifactRef ?? conflict.artifact_ref,
      conflict.created_at,
      jsonMetadata(conflict.metadata_json)
    );
  }

  recordIntegrationResult(input: FactoryIntegrationResultRecordInput) {
    const result = input.result;
    this.database.prepare(`
      INSERT INTO factory_integration_results (
        integration_result_id, run_id, status, applied_candidates_json,
        rejected_candidates_json, blocked_candidates_json, conflicts_count,
        validation_status, validation_refs_json, rollback_refs_json, changed_files_json,
        artifact_ref, trace_event_id, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_result_id) DO UPDATE SET
        status = excluded.status,
        applied_candidates_json = excluded.applied_candidates_json,
        rejected_candidates_json = excluded.rejected_candidates_json,
        blocked_candidates_json = excluded.blocked_candidates_json,
        conflicts_count = excluded.conflicts_count,
        validation_status = excluded.validation_status,
        validation_refs_json = excluded.validation_refs_json,
        rollback_refs_json = excluded.rollback_refs_json,
        changed_files_json = excluded.changed_files_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_integration_results.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_integration_results.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      result.integration_result_id,
      result.run_id,
      result.status,
      JSON.stringify(result.applied_candidates),
      JSON.stringify(result.rejected_candidates),
      JSON.stringify(result.blocked_candidates),
      result.conflicts.length,
      result.validation_status,
      JSON.stringify(result.validation_refs),
      JSON.stringify(result.rollback_refs),
      JSON.stringify(result.changed_files),
      input.artifactRef ?? result.artifact_ref,
      result.trace_event_id,
      result.created_at,
      jsonMetadata({
        ...result.metadata_json,
        blocked_reason: result.blocked_reason,
        apply_mode: result.apply_mode,
        rollback_available: result.rollback_available
      })
    );
    if (input.artifactRef ?? result.artifact_ref) {
      this.recordArtifact({
        runId: result.run_id,
        kind: "integration_result",
        artifactRef: input.artifactRef ?? result.artifact_ref ?? "",
        status: result.status,
        createdAt: result.created_at,
        updatedAt: result.created_at,
        metadata: {
          integration_result_id: result.integration_result_id,
          validation_status: result.validation_status,
          conflicts_count: result.conflicts.length
        }
      });
    }
  }

  recordAgentTeam(input: FactoryAgentTeamRecordInput) {
    const team = input.team;
    this.database.prepare(`
      INSERT INTO factory_agent_teams (
        team_id, run_id, campaign_id, parent_team_id, domain, objective, team_type,
        orchestrator_agent_id, prompt_writer_agent_ids_json, worker_agent_ids_json,
        reviewer_agent_ids_json, specialist_agent_ids_json, memory_scope,
        allowed_files_json, forbidden_files_json, module_locks_json, semantic_locks_json,
        budgets_json, limits_json, status, confidence, artifact_ref,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET
        campaign_id = COALESCE(excluded.campaign_id, factory_agent_teams.campaign_id),
        parent_team_id = COALESCE(excluded.parent_team_id, factory_agent_teams.parent_team_id),
        domain = excluded.domain,
        objective = excluded.objective,
        team_type = excluded.team_type,
        orchestrator_agent_id = excluded.orchestrator_agent_id,
        prompt_writer_agent_ids_json = excluded.prompt_writer_agent_ids_json,
        worker_agent_ids_json = excluded.worker_agent_ids_json,
        reviewer_agent_ids_json = excluded.reviewer_agent_ids_json,
        specialist_agent_ids_json = excluded.specialist_agent_ids_json,
        memory_scope = excluded.memory_scope,
        allowed_files_json = excluded.allowed_files_json,
        forbidden_files_json = excluded.forbidden_files_json,
        module_locks_json = excluded.module_locks_json,
        semantic_locks_json = excluded.semantic_locks_json,
        budgets_json = excluded.budgets_json,
        limits_json = excluded.limits_json,
        status = excluded.status,
        confidence = excluded.confidence,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_agent_teams.artifact_ref),
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      team.team_id,
      team.run_id,
      team.campaign_id,
      team.parent_team_id,
      team.domain,
      team.objective,
      team.team_type,
      team.orchestrator_agent_id,
      JSON.stringify(team.prompt_writer_agent_ids),
      JSON.stringify(team.worker_agent_ids),
      JSON.stringify(team.reviewer_agent_ids),
      JSON.stringify(team.specialist_agent_ids),
      team.memory_scope.scope_id,
      JSON.stringify(team.allowed_files),
      JSON.stringify(team.forbidden_files),
      JSON.stringify(team.module_locks),
      JSON.stringify(team.semantic_locks),
      JSON.stringify(team.budgets),
      JSON.stringify(team.limits),
      team.status,
      team.confidence,
      input.artifactRef ?? team.artifact_ref,
      team.created_at,
      team.updated_at,
      jsonMetadata(team.metadata_json)
    );
    if (team.parent_team_id) {
      this.recordAgentTeamEdge(team.run_id, team.parent_team_id, team.team_id, input.artifactRef ?? team.artifact_ref);
    }
    this.recordAgentTeamBudget({
      teamId: team.team_id,
      runId: team.run_id,
      budget: team.budgets,
      inheritedFromTeamId: team.parent_team_id,
      artifactRef: input.artifactRef ?? team.artifact_ref,
      createdAt: team.created_at,
      metadata: { limits: team.limits }
    });
    if (input.artifactRef ?? team.artifact_ref) {
      this.recordArtifact({
        runId: team.run_id,
        campaignId: team.campaign_id,
        kind: "agent_team",
        artifactRef: input.artifactRef ?? team.artifact_ref ?? "",
        status: team.status,
        createdAt: team.created_at,
        updatedAt: team.updated_at,
        metadata: {
          team_id: team.team_id,
          parent_team_id: team.parent_team_id,
          team_type: team.team_type,
          domain: team.domain
        }
      });
    }
  }

  recordAgentTeamEdge(runId: string, parentTeamId: string, childTeamId: string, artifactRef?: string) {
    this.database.prepare(`
      INSERT INTO factory_agent_team_edges (
        id, run_id, parent_team_id, child_team_id, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        artifact_ref = COALESCE(excluded.artifact_ref, factory_agent_team_edges.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("agent_team_edge", [runId, parentTeamId, childTeamId]),
      runId,
      parentTeamId,
      childTeamId,
      artifactRef,
      nowIso(),
      jsonMetadata({})
    );
  }

  recordAgentTeamAssignment(input: FactoryAgentTeamAssignmentRecordInput) {
    this.database.prepare(`
      INSERT INTO factory_agent_team_assignments (
        assignment_id, run_id, team_id, assignment_type, target_id, role,
        status, artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(assignment_id) DO UPDATE SET
        team_id = excluded.team_id,
        role = COALESCE(excluded.role, factory_agent_team_assignments.role),
        status = COALESCE(excluded.status, factory_agent_team_assignments.status),
        artifact_ref = COALESCE(excluded.artifact_ref, factory_agent_team_assignments.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      input.assignmentId,
      input.runId,
      input.teamId,
      input.assignmentType,
      input.targetId,
      input.role,
      input.status ?? "assigned",
      input.artifactRef,
      input.createdAt ?? nowIso(),
      jsonMetadata(input.metadata ?? {})
    );
  }

  recordAgentTeamBudget(input: FactoryAgentTeamBudgetRecordInput) {
    this.database.prepare(`
      INSERT INTO factory_agent_team_budgets (
        id, team_id, run_id, inherited_from_team_id, budgets_json,
        artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        inherited_from_team_id = COALESCE(excluded.inherited_from_team_id, factory_agent_team_budgets.inherited_from_team_id),
        budgets_json = excluded.budgets_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_agent_team_budgets.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("agent_team_budget", [input.runId, input.teamId]),
      input.teamId,
      input.runId,
      input.inheritedFromTeamId,
      JSON.stringify(input.budget),
      input.artifactRef,
      input.createdAt ?? nowIso(),
      jsonMetadata(input.metadata ?? {})
    );
  }

  recordArtifact(input: FactoryArtifactRecordInput) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    this.database.prepare(`
      INSERT INTO factory_artifacts (
        id, run_id, task_id, campaign_id, artifact_kind, status, artifact_ref,
        relative_artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        run_id = COALESCE(excluded.run_id, factory_artifacts.run_id),
        task_id = COALESCE(excluded.task_id, factory_artifacts.task_id),
        campaign_id = COALESCE(excluded.campaign_id, factory_artifacts.campaign_id),
        artifact_kind = excluded.artifact_kind,
        status = COALESCE(excluded.status, factory_artifacts.status),
        artifact_ref = excluded.artifact_ref,
        relative_artifact_ref = excluded.relative_artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("artifact", [input.artifactRef]),
      input.runId,
      input.taskId,
      input.campaignId,
      input.kind,
      input.status,
      input.artifactRef,
      this.relativeArtifactRef(input.artifactRef),
      createdAt,
      updatedAt,
      jsonMetadata(input.metadata ?? {})
    );
  }

  recordTraceEvent(event: OrchestratorEvent | SwarmEvent, artifactRef: string) {
    this.recordFactoryTraceEvent(factoryTraceEventFromArtifactEvent({ event, artifactRef }));
  }

  recordSchedulerTrace(entry: SchedulerTraceEntry, artifactRef: string) {
    this.recordFactoryTraceEvent(factoryTraceEventFromSchedulerTrace({ entry, artifactRef }));
  }

  recordMemoryChunk(pack: ContextPack, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_memory_chunks (
        id, run_id, task_id, chunk_kind, status, artifact_ref,
        source_path, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        artifact_ref = excluded.artifact_ref,
        source_path = excluded.source_path,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      pack.id,
      pack.run_id,
      pack.task_id,
      "context_pack",
      pack.warnings.length ? "warning" : "ready",
      artifactRef,
      undefined,
      nowIso(),
      nowIso(),
      jsonMetadata({
        approximate_size: pack.approximate_size,
        snippet_count: pack.snippets.length,
        relevant_file_count: pack.relevant_files.length,
        repo_index_ref_count: pack.repo_index_refs.length
      })
    );
    this.recordArtifact({
      runId: pack.run_id,
      taskId: pack.task_id,
      kind: "context_pack",
      artifactRef,
      status: pack.warnings.length ? "warning" : "ready"
    });
  }

  recordContextItems(pack: ContextPack, artifactRef: string) {
    const createdAt = nowIso();
    for (const item of [...pack.included_items ?? [], ...pack.excluded_items ?? []]) {
      this.recordContextItem(item, pack.id, artifactRef, createdAt);
      const teamId = teamIdForContextItem(pack, item);
      if (teamId) {
        this.recordTeamContextItem({
          contextItem: item,
          contextPackId: pack.id,
          teamId,
          runId: pack.run_id,
          taskId: pack.task_id,
          artifactRef,
          createdAt
        });
      }
    }
  }

  private recordContextItem(item: ContextPackInclusionRecord, contextPackId: string, artifactRef: string, createdAt: string) {
    this.database.prepare(`
      INSERT INTO factory_context_items (
        id, context_item_id, context_pack_id, run_id, task_id, agent_id, agent_role,
        item_type, source_type, source_ref, source_path, access_mode, inclusion_reason,
        relevance_score, confidence, freshness, evidence_refs_json, trace_event_id,
        artifact_ref, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        agent_role = excluded.agent_role,
        item_type = excluded.item_type,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        source_path = COALESCE(excluded.source_path, factory_context_items.source_path),
        access_mode = excluded.access_mode,
        inclusion_reason = excluded.inclusion_reason,
        relevance_score = excluded.relevance_score,
        confidence = excluded.confidence,
        freshness = excluded.freshness,
        evidence_refs_json = excluded.evidence_refs_json,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_context_items.trace_event_id),
        artifact_ref = excluded.artifact_ref,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("context_item", [contextPackId, item.item_id]),
      item.item_id,
      contextPackId,
      item.run_id,
      item.task_id,
      undefined,
      item.agent_role,
      item.item_type,
      item.source_type,
      item.source_ref,
      item.source_path,
      item.access_mode,
      item.inclusion_reason,
      item.relevance_score,
      item.confidence,
      item.freshness,
      JSON.stringify(item.evidence_refs),
      item.trace_event_ref,
      artifactRef,
      createdAt,
      jsonMetadata({
        ...item.metadata_json,
        warning_count: item.warnings.length,
        evidence_count: item.evidence_refs.length
      })
    );
  }

  recordTeamContextScope(scope: TeamContextScope) {
    this.database.prepare(`
      INSERT INTO factory_team_context_scopes (
        team_context_scope_id, run_id, team_id, parent_team_id, memory_scope,
        allowed_files_json, forbidden_files_json, module_locks_json, semantic_locks_json,
        evidence_refs_json, decision_refs_json, failure_refs_json, artifact_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_context_scope_id) DO UPDATE SET
        parent_team_id = COALESCE(excluded.parent_team_id, factory_team_context_scopes.parent_team_id),
        memory_scope = excluded.memory_scope,
        allowed_files_json = excluded.allowed_files_json,
        forbidden_files_json = excluded.forbidden_files_json,
        module_locks_json = excluded.module_locks_json,
        semantic_locks_json = excluded.semantic_locks_json,
        evidence_refs_json = excluded.evidence_refs_json,
        decision_refs_json = excluded.decision_refs_json,
        failure_refs_json = excluded.failure_refs_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_team_context_scopes.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_team_context_scopes.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      scope.team_context_scope_id,
      scope.run_id,
      scope.team_id,
      scope.parent_team_id,
      scope.memory_scope,
      JSON.stringify(scope.allowed_files),
      JSON.stringify(scope.forbidden_files),
      JSON.stringify(scope.module_locks),
      JSON.stringify(scope.semantic_locks),
      JSON.stringify(scope.evidence_refs),
      JSON.stringify(scope.decision_refs),
      JSON.stringify(scope.failure_refs),
      scope.artifact_ref,
      scope.trace_event_id,
      jsonMetadata({
        ...scope.metadata_json,
        campaign_id: scope.campaign_id,
        domain: scope.domain,
        objective: scope.objective,
        team_type: scope.team_type,
        inherited_memory_scopes: scope.inherited_memory_scopes,
        read_only_files: scope.read_only_files,
        constraints: scope.constraints,
        warnings: scope.warnings,
        budget_summary: scope.budget_summary,
        confidence: scope.confidence,
        freshness: scope.freshness,
        summary_ref: scope.summary_ref
      }),
      nowIso()
    );
  }

  recordTeamContextItem(input: FactoryTeamContextItemRecordInput) {
    const item = input.contextItem;
    this.database.prepare(`
      INSERT INTO factory_team_context_items (
        context_item_id, run_id, task_id, team_id, context_pack_id, source_type,
        source_ref, inclusion_reason, access_mode, confidence, freshness,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_item_id, context_pack_id, team_id) DO UPDATE SET
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        inclusion_reason = excluded.inclusion_reason,
        access_mode = excluded.access_mode,
        confidence = excluded.confidence,
        freshness = excluded.freshness,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_team_context_items.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      item.item_id,
      input.runId,
      input.taskId ?? item.task_id,
      input.teamId,
      input.contextPackId,
      item.source_type,
      item.source_ref,
      item.inclusion_reason,
      item.access_mode,
      item.confidence,
      item.freshness,
      item.trace_event_ref,
      jsonMetadata({
        source_path: item.source_path,
        item_type: item.item_type,
        relevance_score: item.relevance_score,
        evidence_refs: item.evidence_refs,
        warning_count: item.warnings.length,
        artifact_ref: input.artifactRef,
        ...item.metadata_json
      }),
      input.createdAt ?? nowIso()
    );
  }

  recordTeamMemoryQuery(query: TeamScopedMemoryQuery) {
    this.database.prepare(`
      INSERT INTO factory_team_memory_queries (
        query_id, run_id, team_id, memory_scope, query_type, result_count,
        fallback_used, artifact_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(query_id) DO UPDATE SET
        result_count = excluded.result_count,
        fallback_used = excluded.fallback_used,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_team_memory_queries.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_team_memory_queries.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      query.query_id,
      query.run_id,
      query.team_id,
      query.memory_scope,
      query.query_type,
      query.result_count,
      query.fallback_used ? 1 : 0,
      query.artifact_ref,
      query.trace_event_id,
      jsonMetadata({
        ...query.metadata_json,
        task_id: query.task_id,
        source_scope: query.source_scope,
        result_refs: query.result_refs
      }),
      query.created_at
    );
  }

  recordTeamSubPlan(input: FactoryTeamSubPlanRecordInput) {
    const plan = input.plan;
    const artifactRef = input.artifactRef ?? plan.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_team_sub_plans (
        sub_plan_id, run_id, team_id, parent_team_id, team_domain, team_type,
        status, generation_mode, confidence, artifact_ref, summary_ref,
        trace_event_id, created_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sub_plan_id) DO UPDATE SET
        status = excluded.status,
        generation_mode = excluded.generation_mode,
        confidence = excluded.confidence,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_team_sub_plans.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_team_sub_plans.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_team_sub_plans.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      plan.sub_plan_id,
      plan.run_id,
      plan.team_id,
      plan.parent_team_id,
      plan.team_domain,
      plan.team_type,
      plan.status,
      plan.generation_mode,
      plan.confidence,
      artifactRef,
      plan.summary_ref,
      plan.trace_event_id,
      plan.created_at,
      jsonMetadata({
        objective: plan.objective,
        scope_summary: plan.scope_summary,
        assumption_count: plan.assumptions.length,
        proposed_task_count: plan.proposed_tasks.length,
        dependency_count: plan.dependencies.length,
        risk_count: plan.risks.length,
        required_context_refs: plan.required_context_refs,
        evidence_refs: plan.evidence_refs,
        memory_scope_ref_count: plan.memory_scope_refs.length,
        lock_context_refs: plan.lock_context_refs,
        budget_usage: plan.budget_usage,
        unresolved_question_count: plan.unresolved_questions.length,
        validation_status: plan.validation_strategy.status,
        validation_command_count: plan.validation_strategy.commands.length,
        validation_findings: plan.validation_findings,
        ...plan.metadata_json
      })
    );
    for (const task of plan.proposed_tasks) {
      this.database.prepare(`
        INSERT INTO factory_team_sub_plan_tasks (
          task_draft_id, sub_plan_id, run_id, team_id, title, role_hint,
          read_only, proposed_files_json, allowed_write_paths_json,
          forbidden_files_json, source_refs_json, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_draft_id, sub_plan_id) DO UPDATE SET
          title = excluded.title,
          role_hint = excluded.role_hint,
          read_only = excluded.read_only,
          proposed_files_json = excluded.proposed_files_json,
          allowed_write_paths_json = excluded.allowed_write_paths_json,
          forbidden_files_json = excluded.forbidden_files_json,
          source_refs_json = excluded.source_refs_json,
          metadata_json = excluded.metadata_json
      `).run(
        task.task_draft_id,
        plan.sub_plan_id,
        plan.run_id,
        plan.team_id,
        task.title,
        task.role_hint,
        task.read_only ? 1 : 0,
        JSON.stringify(task.proposed_files),
        JSON.stringify(task.allowed_write_paths),
        JSON.stringify(task.forbidden_files),
        JSON.stringify([...task.required_context_refs, ...task.evidence_refs, ...task.validation_refs]),
        jsonMetadata({
          rationale: task.rationale,
          objective_chars: task.objective.length,
          ...task.metadata_json
        }),
        plan.created_at
      );
    }
    for (const dependency of plan.dependencies) {
      this.database.prepare(`
        INSERT INTO factory_team_sub_plan_dependencies (
          dependency_id, sub_plan_id, run_id, team_id, depends_on_sub_plan_id,
          depends_on_team_id, dependency_type, source_ref, target_ref,
          artifact_ref, metadata_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dependency_id) DO UPDATE SET
          depends_on_sub_plan_id = COALESCE(excluded.depends_on_sub_plan_id, factory_team_sub_plan_dependencies.depends_on_sub_plan_id),
          depends_on_team_id = COALESCE(excluded.depends_on_team_id, factory_team_sub_plan_dependencies.depends_on_team_id),
          dependency_type = excluded.dependency_type,
          source_ref = excluded.source_ref,
          target_ref = excluded.target_ref,
          artifact_ref = COALESCE(excluded.artifact_ref, factory_team_sub_plan_dependencies.artifact_ref),
          metadata_json = excluded.metadata_json
      `).run(
        dependency.dependency_id,
        plan.sub_plan_id,
        plan.run_id,
        plan.team_id,
        dependency.depends_on_sub_plan_id,
        dependency.depends_on_team_id,
        dependency.dependency_type,
        dependency.source_ref,
        dependency.target_ref,
        artifactRef,
        jsonMetadata({
          summary: dependency.summary,
          ...dependency.metadata_json
        }),
        plan.created_at
      );
    }
    if (artifactRef) {
      this.recordArtifact({
        runId: plan.run_id,
        kind: "team_sub_plan",
        artifactRef,
        status: plan.status,
        createdAt: plan.created_at,
        updatedAt: plan.created_at,
        metadata: {
          sub_plan_id: plan.sub_plan_id,
          team_id: plan.team_id,
          generation_mode: plan.generation_mode
        }
      });
    }
  }

  recordTeamSubPlanAggregation(input: FactoryTeamSubPlanAggregationRecordInput) {
    const aggregation = input.aggregation;
    const artifactRef = input.artifactRef ?? aggregation.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_team_sub_plan_aggregations (
        aggregation_id, run_id, status, teams_planned_json, teams_skipped_json,
        accepted_sub_plan_ids_json, invalid_sub_plan_ids_json,
        cross_team_dependencies_json, duplicate_task_groups_json,
        scope_conflicts_json, top_risks_json, artifact_ref, summary_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(aggregation_id) DO UPDATE SET
        status = excluded.status,
        teams_planned_json = excluded.teams_planned_json,
        teams_skipped_json = excluded.teams_skipped_json,
        accepted_sub_plan_ids_json = excluded.accepted_sub_plan_ids_json,
        invalid_sub_plan_ids_json = excluded.invalid_sub_plan_ids_json,
        cross_team_dependencies_json = excluded.cross_team_dependencies_json,
        duplicate_task_groups_json = excluded.duplicate_task_groups_json,
        scope_conflicts_json = excluded.scope_conflicts_json,
        top_risks_json = excluded.top_risks_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_team_sub_plan_aggregations.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_team_sub_plan_aggregations.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_team_sub_plan_aggregations.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      aggregation.aggregation_id,
      aggregation.run_id,
      aggregation.status,
      JSON.stringify(aggregation.teams_planned),
      JSON.stringify(aggregation.teams_skipped),
      JSON.stringify(aggregation.accepted_sub_plans),
      JSON.stringify(aggregation.invalid_sub_plans),
      JSON.stringify(aggregation.cross_team_dependencies),
      JSON.stringify(aggregation.duplicate_task_groups),
      JSON.stringify(aggregation.scope_conflicts),
      JSON.stringify(aggregation.top_risks.map((risk) => ({ risk_id: risk.risk_id, severity: risk.severity, summary: risk.summary }))),
      artifactRef,
      aggregation.summary_ref,
      aggregation.trace_event_id,
      jsonMetadata({
        validation_strategy_summary: aggregation.validation_strategy_summary,
        unresolved_questions: aggregation.unresolved_questions,
        recommended_next_step: aggregation.recommended_next_step,
        ...aggregation.metadata_json
      }),
      aggregation.created_at
    );
    if (artifactRef) {
      this.recordArtifact({
        runId: aggregation.run_id,
        kind: "team_sub_plan_aggregation",
        artifactRef,
        status: aggregation.status,
        createdAt: aggregation.created_at,
        updatedAt: aggregation.created_at,
        metadata: {
          aggregation_id: aggregation.aggregation_id,
          accepted_sub_plan_count: aggregation.accepted_sub_plans.length,
          invalid_sub_plan_count: aggregation.invalid_sub_plans.length
        }
      });
    }
  }

  recordAdoptedTaskProposal(input: FactoryAdoptedTaskProposalRecordInput) {
    const proposal = input.proposal;
    const artifactRef = input.artifactRef ?? proposal.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_adopted_task_proposals (
        adopted_task_id, run_id, team_id, sub_plan_id, source_task_draft_id,
        parent_task_id, title, objective, task_type, read_or_write_classification,
        proposed_role, adoption_status, readiness_status, risk_level,
        allowed_files_json, forbidden_files_json, read_only_files_json,
        module_locks_json, semantic_locks_json, dependencies_json,
        validation_refs_json, success_criteria_json, stop_conditions_json,
        prompt_template_ref, context_pack_ref, evidence_refs_json,
        artifact_ref, readiness_ref, decision_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adopted_task_id) DO UPDATE SET
        adoption_status = excluded.adoption_status,
        readiness_status = excluded.readiness_status,
        risk_level = excluded.risk_level,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_adopted_task_proposals.artifact_ref),
        readiness_ref = COALESCE(excluded.readiness_ref, factory_adopted_task_proposals.readiness_ref),
        decision_ref = COALESCE(excluded.decision_ref, factory_adopted_task_proposals.decision_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_adopted_task_proposals.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      proposal.adopted_task_id,
      proposal.run_id,
      proposal.team_id,
      proposal.sub_plan_id,
      proposal.source_task_draft_id,
      proposal.parent_task_id,
      proposal.title,
      proposal.objective,
      proposal.task_type,
      proposal.read_or_write_classification,
      proposal.proposed_role,
      proposal.adoption_status,
      proposal.readiness_status,
      proposal.risk_level,
      JSON.stringify(proposal.allowed_files),
      JSON.stringify(proposal.forbidden_files),
      JSON.stringify(proposal.read_only_files),
      JSON.stringify(proposal.module_locks),
      JSON.stringify(proposal.semantic_locks),
      JSON.stringify(proposal.dependencies),
      JSON.stringify([...proposal.validation_strategy.commands, ...proposal.validation_strategy.required_checks, ...proposal.validation_strategy.artifact_refs]),
      JSON.stringify(proposal.success_criteria),
      JSON.stringify(proposal.stop_conditions),
      proposal.prompt_template_ref,
      proposal.context_pack_ref,
      JSON.stringify(proposal.evidence_refs),
      artifactRef,
      proposal.readiness_ref,
      proposal.decision_ref,
      proposal.trace_event_id,
      jsonMetadata({
        validation_status: proposal.validation_strategy.status,
        no_executor_task_created: true,
        ...proposal.metadata_json
      }),
      proposal.created_at
    );
    if (artifactRef) {
      this.recordArtifact({
        runId: proposal.run_id,
        kind: "adopted_task_proposal",
        artifactRef,
        status: proposal.adoption_status,
        createdAt: proposal.created_at,
        updatedAt: proposal.created_at,
        metadata: {
          adopted_task_id: proposal.adopted_task_id,
          team_id: proposal.team_id,
          sub_plan_id: proposal.sub_plan_id,
          readiness_status: proposal.readiness_status
        }
      });
    }
  }

  recordTaskAdoptionDecision(input: FactoryTaskAdoptionDecisionRecordInput) {
    const decision = input.decision;
    const artifactRef = input.artifactRef ?? decision.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_task_adoption_decisions (
        adoption_decision_id, run_id, team_id, sub_plan_id, task_draft_id,
        adopted_task_id, adoption_status, readiness_status, reason,
        artifact_ref, readiness_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adoption_decision_id) DO UPDATE SET
        adopted_task_id = COALESCE(excluded.adopted_task_id, factory_task_adoption_decisions.adopted_task_id),
        adoption_status = excluded.adoption_status,
        readiness_status = excluded.readiness_status,
        reason = excluded.reason,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_task_adoption_decisions.artifact_ref),
        readiness_ref = COALESCE(excluded.readiness_ref, factory_task_adoption_decisions.readiness_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_task_adoption_decisions.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      decision.adoption_decision_id,
      decision.run_id,
      decision.team_id,
      decision.sub_plan_id,
      decision.task_draft_id,
      decision.adopted_task_id,
      decision.adoption_status,
      decision.readiness_status,
      decision.reason,
      artifactRef,
      decision.readiness_ref,
      decision.trace_event_id,
      jsonMetadata({
        finding_count: decision.findings.length,
        findings: decision.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          refs: finding.refs
        })),
        ...decision.metadata_json
      }),
      decision.created_at
    );
  }

  recordTaskReadinessResult(input: FactoryTaskReadinessResultRecordInput) {
    const readiness = input.readiness;
    const artifactRef = input.artifactRef ?? readiness.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_task_readiness_results (
        readiness_id, run_id, team_id, sub_plan_id, task_draft_id,
        adopted_task_id, readiness_status, executable_allowed,
        requirements_json, finding_count, artifact_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(readiness_id) DO UPDATE SET
        adopted_task_id = COALESCE(excluded.adopted_task_id, factory_task_readiness_results.adopted_task_id),
        readiness_status = excluded.readiness_status,
        executable_allowed = excluded.executable_allowed,
        requirements_json = excluded.requirements_json,
        finding_count = excluded.finding_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_task_readiness_results.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_task_readiness_results.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      readiness.readiness_id,
      readiness.run_id,
      readiness.team_id,
      readiness.sub_plan_id,
      readiness.task_draft_id,
      readiness.adopted_task_id,
      readiness.readiness_status,
      readiness.executable_allowed ? 1 : 0,
      JSON.stringify(readiness.requirements.map((requirement) => ({
        requirement_type: requirement.requirement_type,
        status: requirement.status,
        refs: requirement.refs
      }))),
      readiness.findings.length,
      artifactRef,
      readiness.trace_event_id,
      jsonMetadata({
        findings: readiness.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          refs: finding.refs
        })),
        ...readiness.metadata_json
      }),
      readiness.created_at
    );
  }

  recordProposedTaskGraph(input: FactoryProposedTaskGraphRecordInput) {
    const graph = input.graph;
    const artifactRef = input.artifactRef ?? graph.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_proposed_task_graphs (
        graph_id, run_id, status, node_count, edge_count, artifact_ref,
        nodes_ref, edges_ref, validation_ref, summary_ref, trace_event_id,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(graph_id) DO UPDATE SET
        status = excluded.status,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_proposed_task_graphs.artifact_ref),
        nodes_ref = COALESCE(excluded.nodes_ref, factory_proposed_task_graphs.nodes_ref),
        edges_ref = COALESCE(excluded.edges_ref, factory_proposed_task_graphs.edges_ref),
        validation_ref = COALESCE(excluded.validation_ref, factory_proposed_task_graphs.validation_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_proposed_task_graphs.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_proposed_task_graphs.trace_event_id),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      graph.graph_id,
      graph.run_id,
      graph.status,
      graph.nodes.length,
      graph.edges.length,
      artifactRef,
      graph.nodes_ref,
      graph.edges_ref,
      graph.validation_ref,
      graph.summary_ref,
      graph.trace_event_id,
      jsonMetadata({
        non_executable: true,
        validation_id: graph.validation?.validation_id,
        ...graph.metadata_json
      }),
      graph.created_at,
      graph.updated_at
    );
  }

  recordProposedTaskNode(input: FactoryProposedTaskNodeRecordInput) {
    const node = input.node;
    this.database.prepare(`
      INSERT INTO factory_proposed_task_nodes (
        proposed_node_id, graph_id, run_id, team_id, sub_plan_id,
        adopted_task_id, source_task_draft_id, parent_proposed_node_id,
        title, objective, task_type, read_or_write_classification,
        proposed_role, status, readiness_status, adoption_status,
        risk_level, non_executable_reason, allowed_files_json,
        forbidden_files_json, read_only_files_json, module_locks_json,
        semantic_locks_json, dependencies_json, evidence_refs_json,
        artifact_ref, trace_event_id, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposed_node_id) DO UPDATE SET
        status = excluded.status,
        readiness_status = excluded.readiness_status,
        adoption_status = excluded.adoption_status,
        non_executable_reason = excluded.non_executable_reason,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_proposed_task_nodes.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_proposed_task_nodes.trace_event_id),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      node.proposed_node_id,
      input.graphId,
      node.run_id,
      node.team_id,
      node.sub_plan_id,
      node.adopted_task_id,
      node.source_task_draft_id,
      node.parent_proposed_node_id,
      node.title,
      node.objective,
      node.task_type,
      node.read_or_write_classification,
      node.proposed_role,
      node.status,
      node.readiness_status,
      node.adoption_status,
      node.risk_level,
      node.non_executable_reason,
      JSON.stringify(node.allowed_files),
      JSON.stringify(node.forbidden_files),
      JSON.stringify(node.read_only_files),
      JSON.stringify(node.module_locks),
      JSON.stringify(node.semantic_locks),
      JSON.stringify(node.dependencies),
      JSON.stringify(node.evidence_refs),
      input.artifactRef ?? node.artifact_ref,
      node.trace_event_id,
      jsonMetadata({
        node,
        source_refs: node.source_refs,
        prompt_template_ref: node.prompt_template_ref,
        context_pack_ref: node.context_pack_ref,
        success_criteria_count: node.success_criteria.length,
        stop_condition_count: node.stop_conditions.length,
        non_executable: true
      }),
      node.created_at,
      node.updated_at
    );
  }

  recordProposedTaskEdge(input: FactoryProposedTaskEdgeRecordInput) {
    const edge = input.edge;
    this.database.prepare(`
      INSERT INTO factory_proposed_task_edges (
        proposed_edge_id, graph_id, run_id, source_node_id, target_node_id,
        edge_type, reason, artifact_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposed_edge_id) DO UPDATE SET
        edge_type = excluded.edge_type,
        reason = excluded.reason,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_proposed_task_edges.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_proposed_task_edges.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      edge.proposed_edge_id,
      input.graphId,
      edge.run_id,
      edge.source_node_id,
      edge.target_node_id,
      edge.edge_type,
      edge.reason,
      input.artifactRef ?? edge.artifact_ref,
      edge.trace_event_id,
      jsonMetadata({
        source_refs: edge.source_refs,
        ...edge.metadata_json
      }),
      edge.created_at
    );
  }

  recordProposedTaskGraphValidation(input: FactoryProposedTaskGraphValidationRecordInput) {
    const validation = input.validation;
    this.database.prepare(`
      INSERT INTO factory_proposed_task_graph_validations (
        validation_id, graph_id, run_id, valid, cycle_count, duplicate_count,
        scope_overlap_count, blocked_node_count, warnings_json, cycles_json,
        duplicate_groups_json, scope_overlaps_json, artifact_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(validation_id) DO UPDATE SET
        valid = excluded.valid,
        cycle_count = excluded.cycle_count,
        duplicate_count = excluded.duplicate_count,
        scope_overlap_count = excluded.scope_overlap_count,
        blocked_node_count = excluded.blocked_node_count,
        warnings_json = excluded.warnings_json,
        cycles_json = excluded.cycles_json,
        duplicate_groups_json = excluded.duplicate_groups_json,
        scope_overlaps_json = excluded.scope_overlaps_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_proposed_task_graph_validations.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_proposed_task_graph_validations.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      validation.validation_id,
      validation.graph_id,
      validation.run_id,
      validation.valid ? 1 : 0,
      validation.cycle_count,
      validation.duplicate_count,
      validation.scope_overlap_count,
      validation.blocked_node_count,
      JSON.stringify(validation.warnings),
      JSON.stringify(validation.cycles),
      JSON.stringify(validation.duplicate_groups),
      JSON.stringify(validation.scope_overlaps),
      input.artifactRef ?? validation.artifact_ref,
      validation.trace_event_id,
      jsonMetadata(validation.metadata_json),
      validation.created_at
    );
  }

  recordExecutionReadinessDecision(input: FactoryExecutionReadinessDecisionRecordInput) {
    const decision = input.decision;
    const artifactRef = input.artifactRef ?? decision.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_readiness_decisions (
        decision_id, run_id, proposed_node_id, team_id, adopted_task_id,
        task_type, read_or_write_classification, proposed_role,
        readiness_status, approval_status, passed_requirements_json,
        failed_requirements_json, blocker_count, warning_count,
        required_human_approval, human_approval_reason, required_locks_json,
        required_context_refs_json, required_prompt_template_ref,
        required_validation_strategy_json, required_success_criteria_json,
        required_review_policy_json, risk_level, confidence, artifact_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET
        readiness_status = excluded.readiness_status,
        approval_status = excluded.approval_status,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_readiness_decisions.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_readiness_decisions.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      decision.decision_id,
      decision.run_id,
      decision.proposed_node_id,
      decision.team_id,
      decision.adopted_task_id,
      decision.task_type,
      decision.read_or_write_classification,
      decision.proposed_role,
      decision.readiness_status,
      decision.approval_status,
      JSON.stringify(decision.passed_requirements),
      JSON.stringify(decision.failed_requirements),
      decision.blockers.length,
      decision.warnings.length,
      decision.required_human_approval?.required ? 1 : 0,
      decision.human_approval_reason,
      JSON.stringify(decision.required_locks),
      JSON.stringify(decision.required_context_refs),
      decision.required_prompt_template_ref,
      JSON.stringify(decision.required_validation_strategy),
      JSON.stringify(decision.required_success_criteria),
      JSON.stringify(decision.required_review_policy),
      decision.risk_level,
      decision.confidence,
      artifactRef,
      decision.trace_event_id,
      jsonMetadata({
        requirement_count: decision.requirements_checked.length,
        no_executor_task_created: true,
        no_scheduler_enqueue: true,
        ...decision.metadata_json
      }),
      decision.created_at
    );
  }

  recordExecutionReadinessRequirement(input: FactoryExecutionReadinessRequirementRecordInput) {
    const requirement = input.requirement;
    this.database.prepare(`
      INSERT INTO factory_execution_readiness_requirements (
        requirement_id, decision_id, run_id, proposed_node_id, team_id,
        requirement_type, status, summary, refs_json, finding_count,
        artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(requirement_id) DO UPDATE SET
        status = excluded.status,
        summary = excluded.summary,
        refs_json = excluded.refs_json,
        finding_count = excluded.finding_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_readiness_requirements.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      requirement.requirement_id,
      input.decisionId,
      input.decision.run_id,
      input.decision.proposed_node_id,
      input.decision.team_id,
      requirement.requirement_type,
      requirement.status,
      requirement.summary,
      JSON.stringify(requirement.refs),
      requirement.findings.length,
      input.artifactRef ?? requirement.artifact_ref,
      jsonMetadata({
        findings: requirement.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          refs: finding.refs
        })),
        ...requirement.metadata_json
      }),
      input.decision.created_at
    );
  }

  recordExecutionApprovalRequirement(input: FactoryExecutionApprovalRequirementRecordInput) {
    const approval = input.approval;
    const artifactRef = input.artifactRef ?? approval.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_approval_requirements (
        approval_requirement_id, run_id, proposed_node_id, team_id, required,
        reason, triggers_json, risk_level, artifact_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_requirement_id) DO UPDATE SET
        required = excluded.required,
        reason = excluded.reason,
        triggers_json = excluded.triggers_json,
        risk_level = excluded.risk_level,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_approval_requirements.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_approval_requirements.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      approval.approval_requirement_id,
      approval.run_id,
      approval.proposed_node_id,
      approval.team_id,
      approval.required ? 1 : 0,
      approval.reason,
      JSON.stringify(approval.triggers),
      approval.risk_level,
      artifactRef,
      approval.trace_event_id,
      jsonMetadata(approval.metadata_json),
      approval.created_at
    );
  }

  recordExecutionReadinessBatch(input: FactoryExecutionReadinessBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_readiness_batches (
        batch_id, run_id, graph_id, node_count, decision_count,
        approval_requirement_count, ready_read_only_count,
        future_write_candidate_count, requires_human_approval_count,
        blocked_count, rejected_count, requires_context_count,
        requires_validation_count, requires_locks_count, artifact_ref,
        summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        decision_count = excluded.decision_count,
        approval_requirement_count = excluded.approval_requirement_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_readiness_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_execution_readiness_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_readiness_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      batch.graph_id,
      batch.summary.nodes_evaluated,
      batch.decisions.length,
      batch.approval_requirements.length,
      batch.summary.ready_read_only_count,
      batch.summary.future_write_candidate_count,
      batch.summary.requires_human_approval_count,
      batch.summary.blocked_count,
      batch.summary.rejected_count,
      batch.summary.requires_context_count,
      batch.summary.requires_validation_count,
      batch.summary.requires_locks_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordExecutionPromotionRequest(input: FactoryExecutionPromotionRequestRecordInput) {
    const request = input.request;
    const artifactRef = input.artifactRef ?? request.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_promotion_requests (
        promotion_request_id, run_id, proposed_node_id, readiness_decision_id,
        team_id, adopted_task_id, task_type, read_or_write_classification,
        proposed_role, requested_promotion_type, readiness_status, risk_level,
        approval_required, approval_reason, requested_scope_json,
        required_locks_json, required_context_refs_json,
        required_prompt_template_ref, required_validation_strategy_json,
        required_success_criteria_json, required_review_policy_json,
        status, artifact_ref, trace_event_id, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(promotion_request_id) DO UPDATE SET
        status = excluded.status,
        approval_required = excluded.approval_required,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_promotion_requests.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_promotion_requests.trace_event_id),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      request.promotion_request_id,
      request.run_id,
      request.proposed_node_id,
      request.readiness_decision_id,
      request.team_id,
      request.adopted_task_id,
      request.task_type,
      request.read_or_write_classification,
      request.proposed_role,
      request.requested_promotion_type,
      request.readiness_status,
      request.risk_level,
      request.approval_required ? 1 : 0,
      request.approval_reason,
      JSON.stringify(request.requested_scope),
      JSON.stringify(request.required_locks),
      JSON.stringify(request.required_context_refs),
      request.required_prompt_template_ref,
      JSON.stringify(request.required_validation_strategy),
      JSON.stringify(request.required_success_criteria),
      JSON.stringify(request.required_review_policy),
      request.status,
      artifactRef,
      request.trace_event_id,
      jsonMetadata(request.metadata_json),
      request.created_at,
      request.updated_at
    );
  }

  recordHumanApprovalRecord(input: FactoryHumanApprovalRecordInput) {
    const approval = input.approval;
    const artifactRef = input.artifactRef ?? approval.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_human_approval_records (
        approval_id, promotion_request_id, run_id, proposed_node_id,
        approver_type, approver_id, decision, approval_status,
        decision_reason, approved_scope_json, constraints_json,
        expires_at, artifact_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(approval_id) DO UPDATE SET
        decision = excluded.decision,
        approval_status = excluded.approval_status,
        decision_reason = excluded.decision_reason,
        constraints_json = excluded.constraints_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_human_approval_records.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_human_approval_records.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      approval.approval_id,
      approval.promotion_request_id,
      approval.run_id,
      approval.proposed_node_id,
      approval.approver_type,
      approval.approver_id,
      approval.decision,
      approval.approval_status,
      approval.decision_reason,
      JSON.stringify(approval.approved_scope),
      JSON.stringify(approval.constraints),
      approval.expires_at,
      artifactRef,
      approval.trace_event_id,
      jsonMetadata(approval.metadata_json),
      approval.created_at
    );
  }

  recordPromotionQueueItem(input: FactoryPromotionQueueItemRecordInput) {
    const item = input.item;
    const artifactRef = input.artifactRef ?? item.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_promotion_queue_items (
        queue_item_id, promotion_request_id, approval_id, run_id,
        proposed_node_id, queue_status, promotion_type, priority,
        blockers_json, constraints_json, artifact_ref, trace_event_id,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue_item_id) DO UPDATE SET
        queue_status = excluded.queue_status,
        blockers_json = excluded.blockers_json,
        constraints_json = excluded.constraints_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_promotion_queue_items.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_promotion_queue_items.trace_event_id),
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      item.queue_item_id,
      item.promotion_request_id,
      item.approval_id,
      item.run_id,
      item.proposed_node_id,
      item.queue_status,
      item.promotion_type,
      item.priority,
      JSON.stringify(item.blockers),
      JSON.stringify(item.constraints),
      artifactRef,
      item.trace_event_id,
      jsonMetadata(item.metadata_json),
      item.created_at,
      item.updated_at
    );
  }

  recordExecutionPreparationPlan(input: FactoryExecutionPreparationPlanRecordInput) {
    const plan = input.plan;
    const artifactRef = input.artifactRef ?? plan.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_preparation_plans (
        preparation_plan_id, run_id, queue_item_id, promotion_request_id,
        approval_id, proposed_node_id, team_id, adopted_task_id, status,
        intended_writer_slot_json, writer_role, task_type, read_or_write_classification,
        objective, allowed_files_json, forbidden_files_json, read_only_files_json,
        required_file_locks_json, required_module_locks_json, required_semantic_locks_json,
        context_pack_ref, context_freshness_summary_json, prompt_id, prompt_template_ref,
        prompt_quality_result_ref, prompt_writer_output_ref, validation_plan_ref,
        review_policy_ref, integration_preview_ref, rollback_preview_ref,
        risk_level, human_approval_ref, readiness_decision_ref,
        blocker_count, warning_count, artifact_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(preparation_plan_id) DO UPDATE SET
        status = excluded.status,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_preparation_plans.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_preparation_plans.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      plan.preparation_plan_id,
      plan.run_id,
      plan.queue_item_id,
      plan.promotion_request_id,
      plan.approval_id,
      plan.proposed_node_id,
      plan.team_id,
      plan.adopted_task_id,
      plan.status,
      JSON.stringify(plan.intended_writer_slot),
      plan.writer_role,
      plan.task_type,
      plan.read_or_write_classification,
      plan.objective,
      JSON.stringify(plan.allowed_files),
      JSON.stringify(plan.forbidden_files),
      JSON.stringify(plan.read_only_files),
      JSON.stringify(plan.required_file_locks),
      JSON.stringify(plan.required_module_locks),
      JSON.stringify(plan.required_semantic_locks),
      plan.context_pack_ref,
      JSON.stringify(plan.context_freshness_summary),
      plan.prompt_id,
      plan.prompt_template_ref,
      plan.prompt_quality_result_ref,
      plan.prompt_writer_output_ref,
      plan.validation_plan_ref,
      plan.review_policy_ref,
      plan.integration_preview_ref,
      plan.rollback_preview_ref,
      plan.risk_level,
      plan.human_approval_ref,
      plan.readiness_decision_ref,
      plan.blockers.length,
      plan.warnings.length,
      artifactRef,
      plan.trace_event_id,
      jsonMetadata(plan.metadata_json),
      plan.created_at
    );
  }

  recordExecutionPreparationBatch(input: FactoryExecutionPreparationBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_execution_preparation_batches (
        batch_id, run_id, request_json, plan_count, prepared_count,
        blocked_count, missing_approval_count, missing_context_count,
        missing_prompt_count, missing_validation_count, missing_locks_count,
        stale_context_count, cancelled_count, artifact_ref, summary_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        plan_count = excluded.plan_count,
        prepared_count = excluded.prepared_count,
        blocked_count = excluded.blocked_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_preparation_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_execution_preparation_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_execution_preparation_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.request),
      batch.summary.preparation_plan_count,
      batch.summary.prepared_count,
      batch.summary.blocked_count,
      batch.summary.missing_approval_count,
      batch.summary.missing_context_count,
      batch.summary.missing_prompt_count,
      batch.summary.missing_validation_count,
      batch.summary.missing_locks_count,
      batch.summary.stale_context_count,
      batch.summary.cancelled_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordExecutionPreparationBlocker(input: FactoryExecutionPreparationBlockerRecordInput) {
    const blocker = input.blocker;
    this.database.prepare(`
      INSERT INTO factory_execution_preparation_blockers (
        blocker_id, preparation_plan_id, run_id, queue_item_id, blocker_type,
        severity, reason, refs_json, artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(blocker_id) DO UPDATE SET
        severity = excluded.severity,
        reason = excluded.reason,
        refs_json = excluded.refs_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_preparation_blockers.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      blocker.blocker_id,
      blocker.preparation_plan_id,
      input.runId,
      input.queueItemId,
      blocker.blocker_type,
      blocker.severity,
      blocker.reason,
      JSON.stringify(blocker.refs),
      input.artifactRef,
      jsonMetadata(blocker.metadata_json),
      blocker.created_at
    );
  }

  recordExecutionPreparationWarning(input: FactoryExecutionPreparationWarningRecordInput) {
    const warning = input.warning;
    this.database.prepare(`
      INSERT INTO factory_execution_preparation_warnings (
        warning_id, preparation_plan_id, run_id, queue_item_id, warning_type,
        severity, message, refs_json, artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(warning_id) DO UPDATE SET
        severity = excluded.severity,
        message = excluded.message,
        refs_json = excluded.refs_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_execution_preparation_warnings.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      warning.warning_id,
      warning.preparation_plan_id,
      input.runId,
      input.queueItemId,
      warning.warning_type,
      warning.severity,
      warning.message,
      JSON.stringify(warning.refs),
      input.artifactRef,
      jsonMetadata(warning.metadata_json),
      warning.created_at
    );
  }

  recordOneWriterDryRunProposal(input: FactoryOneWriterDryRunProposalRecordInput) {
    const proposal = input.proposal;
    const artifactRef = input.artifactRef ?? proposal.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_one_writer_dry_run_proposals (
        proposal_id, run_id, preparation_plan_id, queue_item_id, promotion_request_id,
        approval_id, proposed_node_id, team_id, writer_role, provider_mode,
        provider_name, model_name, prompt_id, prompt_quality_result_ref, context_pack_ref,
        raw_output_ref, parsed_output_ref, patch_artifact_ref, patch_summary,
        changed_files_json, allowed_files_json, forbidden_files_json, scope_check_status,
        forbidden_file_violations_json, out_of_scope_changes_json, required_locks_preview_json,
        validation_plan_ref, review_policy_ref, integration_preview_ref, risk_level,
        status, blocker_count, warning_count, artifact_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        status = excluded.status,
        provider_name = COALESCE(excluded.provider_name, factory_one_writer_dry_run_proposals.provider_name),
        model_name = COALESCE(excluded.model_name, factory_one_writer_dry_run_proposals.model_name),
        raw_output_ref = COALESCE(excluded.raw_output_ref, factory_one_writer_dry_run_proposals.raw_output_ref),
        parsed_output_ref = COALESCE(excluded.parsed_output_ref, factory_one_writer_dry_run_proposals.parsed_output_ref),
        patch_artifact_ref = COALESCE(excluded.patch_artifact_ref, factory_one_writer_dry_run_proposals.patch_artifact_ref),
        patch_summary = excluded.patch_summary,
        changed_files_json = excluded.changed_files_json,
        scope_check_status = excluded.scope_check_status,
        forbidden_file_violations_json = excluded.forbidden_file_violations_json,
        out_of_scope_changes_json = excluded.out_of_scope_changes_json,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_one_writer_dry_run_proposals.artifact_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_one_writer_dry_run_proposals.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      proposal.proposal_id,
      proposal.run_id,
      proposal.preparation_plan_id,
      proposal.queue_item_id,
      proposal.promotion_request_id,
      proposal.approval_id,
      proposal.proposed_node_id,
      proposal.team_id,
      proposal.writer_role,
      proposal.provider_mode,
      proposal.provider_name,
      proposal.model_name,
      proposal.prompt_id,
      proposal.prompt_quality_result_ref,
      proposal.context_pack_ref,
      proposal.raw_output_ref,
      proposal.parsed_output_ref,
      proposal.patch_artifact_ref,
      proposal.patch_summary,
      JSON.stringify(proposal.changed_files),
      JSON.stringify(proposal.allowed_files),
      JSON.stringify(proposal.forbidden_files),
      proposal.scope_check_result?.status,
      JSON.stringify(proposal.forbidden_file_violations),
      JSON.stringify(proposal.out_of_scope_changes),
      JSON.stringify(proposal.required_locks_preview),
      proposal.validation_plan_ref,
      proposal.review_policy_ref,
      proposal.integration_preview_ref,
      proposal.risk_level,
      proposal.status,
      proposal.blockers.length,
      proposal.warnings.length,
      artifactRef,
      proposal.trace_event_id,
      jsonMetadata(proposal.metadata_json),
      proposal.created_at
    );
  }

  recordPatchProposalFile(input: FactoryPatchProposalFileRecordInput) {
    const change = input.fileChange;
    this.database.prepare(`
      INSERT INTO factory_patch_proposal_files (
        file_change_id, proposal_id, run_id, preparation_plan_id, path,
        change_type, within_allowed_scope, risk, diff_ref, replacement_snippet_ref,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_change_id) DO UPDATE SET
        path = excluded.path,
        change_type = excluded.change_type,
        within_allowed_scope = excluded.within_allowed_scope,
        risk = excluded.risk,
        diff_ref = COALESCE(excluded.diff_ref, factory_patch_proposal_files.diff_ref),
        replacement_snippet_ref = COALESCE(excluded.replacement_snippet_ref, factory_patch_proposal_files.replacement_snippet_ref),
        metadata_json = excluded.metadata_json
    `).run(
      change.file_change_id,
      input.proposal.proposal_id,
      input.proposal.run_id,
      input.proposal.preparation_plan_id,
      change.path,
      change.change_type,
      change.within_allowed_scope ? 1 : 0,
      change.risk,
      undefined,
      change.replacement_snippet_ref,
      jsonMetadata({
        ...change.metadata_json,
        rationale: change.rationale,
        proposed_diff_stored_in_sqlite: false,
        proposed_diff_chars: change.proposed_diff?.length ?? 0
      }),
      input.proposal.created_at
    );
  }

  recordPatchProposalScopeCheck(input: FactoryPatchProposalScopeCheckRecordInput) {
    const check = input.scopeCheck;
    this.database.prepare(`
      INSERT INTO factory_patch_proposal_scope_checks (
        scope_check_id, proposal_id, run_id, preparation_plan_id, status,
        changed_files_json, forbidden_file_violations_json, out_of_scope_changes_json,
        finding_count, review_candidate_allowed, artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_check_id) DO UPDATE SET
        status = excluded.status,
        changed_files_json = excluded.changed_files_json,
        forbidden_file_violations_json = excluded.forbidden_file_violations_json,
        out_of_scope_changes_json = excluded.out_of_scope_changes_json,
        finding_count = excluded.finding_count,
        review_candidate_allowed = excluded.review_candidate_allowed,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_patch_proposal_scope_checks.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      check.scope_check_id,
      input.proposal.proposal_id,
      input.proposal.run_id,
      input.proposal.preparation_plan_id,
      check.status,
      JSON.stringify(check.changed_files),
      JSON.stringify(check.forbidden_file_violations),
      JSON.stringify(check.out_of_scope_changes),
      check.findings.length,
      check.review_candidate_allowed ? 1 : 0,
      input.proposal.artifact_ref,
      jsonMetadata({
        ...check.metadata_json,
        findings: check.findings.map((finding) => ({
          finding_type: finding.finding_type,
          severity: finding.severity,
          path: finding.path,
          message: finding.message
        }))
      }),
      check.created_at
    );
  }

  recordDryRunWriterBatch(input: FactoryDryRunWriterBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_dry_run_writer_batches (
        batch_id, run_id, request_json, proposal_count, generated_count,
        schema_failed_count, scope_failed_count, blocked_count,
        review_candidate_count, changed_files_preview_json, artifact_ref,
        summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        proposal_count = excluded.proposal_count,
        generated_count = excluded.generated_count,
        schema_failed_count = excluded.schema_failed_count,
        scope_failed_count = excluded.scope_failed_count,
        blocked_count = excluded.blocked_count,
        review_candidate_count = excluded.review_candidate_count,
        changed_files_preview_json = excluded.changed_files_preview_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_dry_run_writer_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_dry_run_writer_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_dry_run_writer_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.request),
      batch.summary.dry_run_proposal_count,
      batch.summary.generated_count,
      batch.summary.schema_failed_count,
      batch.summary.scope_failed_count,
      batch.summary.blocked_count,
      batch.summary.review_candidate_count,
      JSON.stringify(batch.summary.changed_files_preview),
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordPatchProposalReview(input: FactoryPatchProposalReviewRecordInput) {
    const review = input.review;
    const artifactRef = input.artifactRef ?? review.review_artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_patch_proposal_reviews (
        review_id, run_id, proposal_id, preparation_plan_id, proposed_node_id,
        reviewer_role, reviewer_mode, provider_name, model_name, prompt_id,
        prompt_quality_result_ref, raw_review_output_ref, parsed_review_output_ref,
        review_artifact_ref, decision, status, severity_counts_json,
        required_changes_json, validation_recommendations_json, integration_risks_json,
        security_risks_json, performance_risks_json, test_coverage_risks_json,
        confidence, blocker_count, warning_count, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET
        provider_name = COALESCE(excluded.provider_name, factory_patch_proposal_reviews.provider_name),
        model_name = COALESCE(excluded.model_name, factory_patch_proposal_reviews.model_name),
        raw_review_output_ref = COALESCE(excluded.raw_review_output_ref, factory_patch_proposal_reviews.raw_review_output_ref),
        parsed_review_output_ref = COALESCE(excluded.parsed_review_output_ref, factory_patch_proposal_reviews.parsed_review_output_ref),
        review_artifact_ref = COALESCE(excluded.review_artifact_ref, factory_patch_proposal_reviews.review_artifact_ref),
        decision = excluded.decision,
        status = excluded.status,
        severity_counts_json = excluded.severity_counts_json,
        required_changes_json = excluded.required_changes_json,
        validation_recommendations_json = excluded.validation_recommendations_json,
        integration_risks_json = excluded.integration_risks_json,
        security_risks_json = excluded.security_risks_json,
        performance_risks_json = excluded.performance_risks_json,
        test_coverage_risks_json = excluded.test_coverage_risks_json,
        confidence = excluded.confidence,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        trace_event_id = COALESCE(excluded.trace_event_id, factory_patch_proposal_reviews.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      review.review_id,
      review.run_id,
      review.proposal_id,
      review.preparation_plan_id,
      review.proposed_node_id,
      review.reviewer_role,
      review.reviewer_mode,
      review.provider_name,
      review.model_name,
      review.prompt_id,
      review.prompt_quality_result_ref,
      review.raw_review_output_ref,
      review.parsed_review_output_ref,
      artifactRef,
      review.decision,
      review.status,
      JSON.stringify(review.severity_counts),
      JSON.stringify(review.required_changes),
      JSON.stringify(review.validation_recommendations),
      JSON.stringify(review.integration_risks),
      JSON.stringify(review.security_risks),
      JSON.stringify(review.performance_risks),
      JSON.stringify(review.test_coverage_risks),
      review.confidence,
      review.blockers.length,
      review.warnings.length,
      review.trace_event_id,
      jsonMetadata(review.metadata_json),
      review.created_at
    );
  }

  recordPatchReviewFinding(input: FactoryPatchReviewFindingRecordInput) {
    const finding = input.finding;
    this.database.prepare(`
      INSERT INTO factory_patch_review_findings (
        finding_id, review_id, run_id, proposal_id, category, severity,
        message, file, suggested_change, blocking, evidence_ref,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(finding_id) DO UPDATE SET
        category = excluded.category,
        severity = excluded.severity,
        message = excluded.message,
        file = COALESCE(excluded.file, factory_patch_review_findings.file),
        suggested_change = COALESCE(excluded.suggested_change, factory_patch_review_findings.suggested_change),
        blocking = excluded.blocking,
        evidence_ref = COALESCE(excluded.evidence_ref, factory_patch_review_findings.evidence_ref),
        metadata_json = excluded.metadata_json
    `).run(
      finding.finding_id,
      input.review.review_id,
      input.review.run_id,
      input.review.proposal_id,
      finding.category,
      finding.severity,
      finding.message,
      finding.file,
      finding.suggested_change,
      finding.blocking ? 1 : 0,
      finding.evidence_ref,
      jsonMetadata(finding.metadata_json),
      finding.created_at
    );
  }

  recordPatchReviewBatch(input: FactoryPatchReviewBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_patch_review_batches (
        batch_id, run_id, request_json, review_count,
        accepted_for_validation_candidate_count, changes_requested_count,
        rejected_count, blocked_count, review_schema_failed_count,
        critical_findings_count, high_findings_count, artifact_ref,
        summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        review_count = excluded.review_count,
        accepted_for_validation_candidate_count = excluded.accepted_for_validation_candidate_count,
        changes_requested_count = excluded.changes_requested_count,
        rejected_count = excluded.rejected_count,
        blocked_count = excluded.blocked_count,
        review_schema_failed_count = excluded.review_schema_failed_count,
        critical_findings_count = excluded.critical_findings_count,
        high_findings_count = excluded.high_findings_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_patch_review_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_patch_review_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_patch_review_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.request),
      batch.summary.patch_reviews_count,
      batch.summary.accepted_for_validation_candidate_count,
      batch.summary.changes_requested_count,
      batch.summary.rejected_count,
      batch.summary.blocked_count,
      batch.summary.review_schema_failed_count,
      batch.summary.critical_findings_count,
      batch.summary.high_findings_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordValidationCandidate(input: FactoryValidationCandidateRecordInput) {
    const candidate = input.candidate;
    const artifactRef = input.artifactRef ?? candidate.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_validation_candidates (
        validation_candidate_id, run_id, proposal_id, review_id, preparation_plan_id,
        proposed_node_id, patch_artifact_ref, review_artifact_ref, validation_plan_ref,
        required_commands_json, optional_commands_json, expected_validation_outputs_json,
        strict_validation_semantics_ref, status, blocker_count, warning_count,
        artifact_ref, validation_plan_artifact_ref, command_preflight_ref,
        environment_preflight_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(validation_candidate_id) DO UPDATE SET
        patch_artifact_ref = COALESCE(excluded.patch_artifact_ref, factory_validation_candidates.patch_artifact_ref),
        review_artifact_ref = COALESCE(excluded.review_artifact_ref, factory_validation_candidates.review_artifact_ref),
        validation_plan_ref = COALESCE(excluded.validation_plan_ref, factory_validation_candidates.validation_plan_ref),
        required_commands_json = excluded.required_commands_json,
        optional_commands_json = excluded.optional_commands_json,
        expected_validation_outputs_json = excluded.expected_validation_outputs_json,
        strict_validation_semantics_ref = COALESCE(excluded.strict_validation_semantics_ref, factory_validation_candidates.strict_validation_semantics_ref),
        status = excluded.status,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_validation_candidates.artifact_ref),
        validation_plan_artifact_ref = COALESCE(excluded.validation_plan_artifact_ref, factory_validation_candidates.validation_plan_artifact_ref),
        command_preflight_ref = COALESCE(excluded.command_preflight_ref, factory_validation_candidates.command_preflight_ref),
        environment_preflight_ref = COALESCE(excluded.environment_preflight_ref, factory_validation_candidates.environment_preflight_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_validation_candidates.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      candidate.validation_candidate_id,
      candidate.run_id,
      candidate.proposal_id,
      candidate.review_id,
      candidate.preparation_plan_id,
      candidate.proposed_node_id,
      candidate.patch_artifact_ref,
      candidate.review_artifact_ref,
      candidate.validation_plan_ref,
      JSON.stringify(candidate.required_commands),
      JSON.stringify(candidate.optional_commands),
      JSON.stringify(candidate.expected_validation_outputs),
      candidate.strict_validation_semantics_ref,
      candidate.status,
      candidate.blockers.length,
      candidate.warnings.length,
      artifactRef,
      candidate.validation_plan_artifact_ref,
      candidate.command_preflight_ref,
      candidate.environment_preflight_ref,
      candidate.trace_event_id,
      jsonMetadata(candidate.metadata_json),
      candidate.created_at
    );
  }

  recordValidationCommandPreflight(input: FactoryValidationCommandPreflightRecordInput) {
    const preflight = input.commandPreflight;
    this.database.prepare(`
      INSERT INTO factory_validation_command_preflights (
        command_preflight_id, validation_candidate_id, run_id, command, required,
        safety_status, risk, allowlisted, inventory_present, inventory_match,
        future_semantics_status, blocked_reason, artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_preflight_id) DO UPDATE SET
        safety_status = excluded.safety_status,
        risk = excluded.risk,
        allowlisted = excluded.allowlisted,
        inventory_present = excluded.inventory_present,
        inventory_match = excluded.inventory_match,
        future_semantics_status = excluded.future_semantics_status,
        blocked_reason = COALESCE(excluded.blocked_reason, factory_validation_command_preflights.blocked_reason),
        artifact_ref = COALESCE(excluded.artifact_ref, factory_validation_command_preflights.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      preflight.command_preflight_id,
      input.candidate.validation_candidate_id,
      input.candidate.run_id,
      preflight.command,
      preflight.required ? 1 : 0,
      preflight.safety_status,
      preflight.risk,
      preflight.allowlisted ? 1 : 0,
      preflight.inventory_present ? 1 : 0,
      preflight.inventory_match ? 1 : 0,
      preflight.future_semantics_status,
      preflight.blocked_reason,
      input.candidate.command_preflight_ref,
      jsonMetadata(preflight.metadata_json),
      preflight.created_at
    );
  }

  recordValidationEnvironmentPreflight(input: FactoryValidationEnvironmentPreflightRecordInput) {
    const readiness = input.environmentReadiness;
    this.database.prepare(`
      INSERT INTO factory_validation_environment_preflights (
        environment_readiness_id, validation_candidate_id, run_id, status,
        workspace_path_known, command_inventory_available, validation_runner_available,
        required_artifacts_exist, patch_applied, patch_apply_strategy,
        artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(environment_readiness_id) DO UPDATE SET
        status = excluded.status,
        workspace_path_known = excluded.workspace_path_known,
        command_inventory_available = excluded.command_inventory_available,
        validation_runner_available = excluded.validation_runner_available,
        required_artifacts_exist = excluded.required_artifacts_exist,
        patch_applied = excluded.patch_applied,
        patch_apply_strategy = excluded.patch_apply_strategy,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_validation_environment_preflights.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      readiness.environment_readiness_id,
      input.candidate.validation_candidate_id,
      input.candidate.run_id,
      readiness.status,
      readiness.workspace_path_known ? 1 : 0,
      readiness.command_inventory_available ? 1 : 0,
      readiness.validation_runner_available ? 1 : 0,
      readiness.required_artifacts_exist ? 1 : 0,
      0,
      readiness.patch_apply_strategy,
      input.candidate.environment_preflight_ref,
      jsonMetadata(readiness.metadata_json),
      readiness.created_at
    );
  }

  recordValidationCandidateBatch(input: FactoryValidationCandidateBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_validation_candidate_batches (
        batch_id, run_id, review_ids_json, candidate_count, preflight_passed_count,
        incomplete_count, command_blocked_count, environment_blocked_count,
        rejected_count, artifact_ref, summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        review_ids_json = excluded.review_ids_json,
        candidate_count = excluded.candidate_count,
        preflight_passed_count = excluded.preflight_passed_count,
        incomplete_count = excluded.incomplete_count,
        command_blocked_count = excluded.command_blocked_count,
        environment_blocked_count = excluded.environment_blocked_count,
        rejected_count = excluded.rejected_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_validation_candidate_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_validation_candidate_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_validation_candidate_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.review_ids),
      batch.summary.validation_candidate_count,
      batch.summary.preflight_passed_count,
      batch.summary.incomplete_count,
      batch.summary.command_blocked_count,
      batch.summary.environment_blocked_count,
      batch.summary.rejected_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordPatchApplySandboxResult(input: FactoryPatchApplySandboxResultRecordInput) {
    const result = input.result;
    const artifactRef = input.artifactRef ?? result.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_patch_apply_sandbox_results (
        sandbox_result_id, run_id, validation_candidate_id, proposal_id, review_id,
        patch_artifact_ref, sandbox_mode, sandbox_path_ref, sandbox_artifact_ref,
        base_revision_ref, changed_files_json, dry_apply_status, conflict_count,
        failed_hunk_count, unsafe_finding_count, main_repo_modified, validation_run,
        integration_created, artifact_ref, summary_ref, trace_event_id,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sandbox_result_id) DO UPDATE SET
        sandbox_path_ref = COALESCE(excluded.sandbox_path_ref, factory_patch_apply_sandbox_results.sandbox_path_ref),
        sandbox_artifact_ref = COALESCE(excluded.sandbox_artifact_ref, factory_patch_apply_sandbox_results.sandbox_artifact_ref),
        changed_files_json = excluded.changed_files_json,
        dry_apply_status = excluded.dry_apply_status,
        conflict_count = excluded.conflict_count,
        failed_hunk_count = excluded.failed_hunk_count,
        unsafe_finding_count = excluded.unsafe_finding_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_patch_apply_sandbox_results.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_patch_apply_sandbox_results.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_patch_apply_sandbox_results.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      result.sandbox_result_id,
      result.run_id,
      result.validation_candidate_id,
      result.proposal_id,
      result.review_id,
      result.patch_artifact_ref,
      result.sandbox_mode,
      result.sandbox_path_ref,
      result.sandbox_artifact_ref,
      result.base_revision_ref,
      JSON.stringify(result.changed_files),
      result.dry_apply_status,
      result.conflicts.length,
      result.failed_hunks.length,
      result.unsafe_findings.length,
      0,
      0,
      0,
      artifactRef,
      result.summary_ref,
      result.trace_event_id,
      jsonMetadata(result.metadata_json),
      result.created_at
    );
  }

  recordPatchApplyConflict(input: FactoryPatchApplyConflictRecordInput) {
    const conflict = input.conflict;
    this.database.prepare(`
      INSERT INTO factory_patch_apply_conflicts (
        conflict_id, sandbox_result_id, validation_candidate_id, run_id,
        proposal_id, path, conflict_type, severity, message, refs_json,
        metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conflict_id) DO UPDATE SET
        path = excluded.path,
        conflict_type = excluded.conflict_type,
        severity = excluded.severity,
        message = excluded.message,
        refs_json = excluded.refs_json,
        metadata_json = excluded.metadata_json
    `).run(
      conflict.conflict_id,
      input.result.sandbox_result_id,
      conflict.validation_candidate_id,
      input.result.run_id,
      conflict.proposal_id,
      conflict.path,
      conflict.conflict_type,
      conflict.severity,
      conflict.message,
      JSON.stringify(conflict.refs),
      jsonMetadata(conflict.metadata_json),
      conflict.created_at
    );
  }

  recordPatchApplySandboxBatch(input: FactoryPatchApplySandboxBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_patch_apply_batches (
        batch_id, run_id, validation_candidate_ids_json, result_count,
        dry_apply_passed_count, dry_apply_failed_count, conflict_count,
        failed_hunk_count, sandbox_unavailable_count, unsafe_patch_count,
        blocked_count, main_repo_integrity_ok, artifact_ref, summary_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        validation_candidate_ids_json = excluded.validation_candidate_ids_json,
        result_count = excluded.result_count,
        dry_apply_passed_count = excluded.dry_apply_passed_count,
        dry_apply_failed_count = excluded.dry_apply_failed_count,
        conflict_count = excluded.conflict_count,
        failed_hunk_count = excluded.failed_hunk_count,
        sandbox_unavailable_count = excluded.sandbox_unavailable_count,
        unsafe_patch_count = excluded.unsafe_patch_count,
        blocked_count = excluded.blocked_count,
        main_repo_integrity_ok = excluded.main_repo_integrity_ok,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_patch_apply_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_patch_apply_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_patch_apply_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.validation_candidate_ids),
      batch.summary.sandbox_result_count,
      batch.summary.dry_apply_passed_count,
      batch.summary.dry_apply_failed_count,
      batch.summary.conflict_count,
      batch.summary.failed_hunk_count,
      batch.summary.sandbox_unavailable_count,
      batch.summary.unsafe_patch_count,
      batch.summary.blocked_count,
      batch.summary.main_repo_integrity_ok ? 1 : 0,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordSandboxValidationResult(input: FactorySandboxValidationResultRecordInput) {
    const result = input.result;
    const artifactRef = input.artifactRef ?? result.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_sandbox_validation_results (
        sandbox_validation_id, run_id, sandbox_result_id, validation_candidate_id,
        proposal_id, review_id, patch_artifact_ref, sandbox_ref, commands_json,
        strict_validation_status, status, required_command_count,
        optional_command_count, passed_count, failed_count, blocked_count,
        skipped_count, timed_out_count, not_run_count, finding_count,
        logs_ref, artifact_ref, summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sandbox_validation_id) DO UPDATE SET
        sandbox_ref = COALESCE(excluded.sandbox_ref, factory_sandbox_validation_results.sandbox_ref),
        commands_json = excluded.commands_json,
        strict_validation_status = excluded.strict_validation_status,
        status = excluded.status,
        required_command_count = excluded.required_command_count,
        optional_command_count = excluded.optional_command_count,
        passed_count = excluded.passed_count,
        failed_count = excluded.failed_count,
        blocked_count = excluded.blocked_count,
        skipped_count = excluded.skipped_count,
        timed_out_count = excluded.timed_out_count,
        not_run_count = excluded.not_run_count,
        finding_count = excluded.finding_count,
        logs_ref = COALESCE(excluded.logs_ref, factory_sandbox_validation_results.logs_ref),
        artifact_ref = COALESCE(excluded.artifact_ref, factory_sandbox_validation_results.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_sandbox_validation_results.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_sandbox_validation_results.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      result.sandbox_validation_id,
      result.run_id,
      result.sandbox_result_id,
      result.validation_candidate_id,
      result.proposal_id,
      result.review_id,
      result.patch_artifact_ref,
      result.sandbox_ref,
      JSON.stringify(result.commands),
      result.strict_validation_status,
      result.status,
      result.required_command_count,
      result.optional_command_count,
      result.passed_count,
      result.failed_count,
      result.blocked_count,
      result.skipped_count,
      result.timed_out_count,
      result.not_run_count,
      result.findings.length,
      result.logs_ref,
      artifactRef,
      result.summary_ref,
      result.trace_event_id,
      jsonMetadata(result.metadata_json),
      result.created_at
    );
  }

  recordSandboxValidationCommand(input: FactorySandboxValidationCommandRecordInput) {
    const command = input.commandResult;
    this.database.prepare(`
      INSERT INTO factory_sandbox_validation_commands (
        command_result_id, sandbox_validation_id, run_id, sandbox_result_id,
        validation_candidate_id, command, cwd, required, status, exit_code,
        duration_ms, log_ref, summary, metadata_json, started_at, finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(command_result_id) DO UPDATE SET
        cwd = excluded.cwd,
        status = excluded.status,
        exit_code = excluded.exit_code,
        duration_ms = excluded.duration_ms,
        log_ref = COALESCE(excluded.log_ref, factory_sandbox_validation_commands.log_ref),
        summary = excluded.summary,
        metadata_json = excluded.metadata_json,
        finished_at = excluded.finished_at
    `).run(
      command.command_result_id,
      command.sandbox_validation_id,
      command.run_id,
      command.sandbox_result_id,
      command.validation_candidate_id,
      command.command,
      command.cwd,
      command.required ? 1 : 0,
      command.status,
      command.exit_code,
      command.duration_ms,
      command.log_ref,
      command.summary,
      jsonMetadata(command.metadata_json),
      command.started_at,
      command.finished_at
    );
  }

  recordSandboxValidationBatch(input: FactorySandboxValidationBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_sandbox_validation_batches (
        batch_id, run_id, sandbox_result_ids_json, result_count, passed_count,
        failed_count, blocked_count, partial_count, artifact_ref, summary_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        sandbox_result_ids_json = excluded.sandbox_result_ids_json,
        result_count = excluded.result_count,
        passed_count = excluded.passed_count,
        failed_count = excluded.failed_count,
        blocked_count = excluded.blocked_count,
        partial_count = excluded.partial_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_sandbox_validation_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_sandbox_validation_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_sandbox_validation_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.sandbox_result_ids),
      batch.summary.sandbox_validation_count,
      batch.summary.sandbox_validation_passed_count,
      batch.summary.sandbox_validation_failed_count,
      batch.summary.sandbox_validation_blocked_count,
      batch.summary.sandbox_validation_partial_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordSandboxIntegrationCandidate(input: FactorySandboxIntegrationCandidateRecordInput) {
    const candidate = input.candidate;
    const artifactRef = input.artifactRef ?? candidate.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_sandbox_integration_candidates (
        integration_candidate_id, run_id, proposal_id, review_id,
        validation_candidate_id, sandbox_result_id, sandbox_validation_id,
        preparation_plan_id, proposed_node_id, patch_artifact_ref, patch_summary,
        changed_files_json, required_file_locks_json, required_module_locks_json,
        required_semantic_locks_json, review_ref, sandbox_apply_ref,
        sandbox_validation_ref, strict_validation_status, rollback_requirements_ref,
        post_integration_validation_plan_ref, risk_level, approval_required,
        status, blocker_count, warning_count, artifact_ref, summary_ref,
        trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(integration_candidate_id) DO UPDATE SET
        patch_summary = excluded.patch_summary,
        changed_files_json = excluded.changed_files_json,
        required_file_locks_json = excluded.required_file_locks_json,
        required_module_locks_json = excluded.required_module_locks_json,
        required_semantic_locks_json = excluded.required_semantic_locks_json,
        review_ref = COALESCE(excluded.review_ref, factory_sandbox_integration_candidates.review_ref),
        sandbox_apply_ref = COALESCE(excluded.sandbox_apply_ref, factory_sandbox_integration_candidates.sandbox_apply_ref),
        sandbox_validation_ref = COALESCE(excluded.sandbox_validation_ref, factory_sandbox_integration_candidates.sandbox_validation_ref),
        strict_validation_status = excluded.strict_validation_status,
        rollback_requirements_ref = COALESCE(excluded.rollback_requirements_ref, factory_sandbox_integration_candidates.rollback_requirements_ref),
        post_integration_validation_plan_ref = COALESCE(excluded.post_integration_validation_plan_ref, factory_sandbox_integration_candidates.post_integration_validation_plan_ref),
        risk_level = excluded.risk_level,
        approval_required = excluded.approval_required,
        status = excluded.status,
        blocker_count = excluded.blocker_count,
        warning_count = excluded.warning_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_sandbox_integration_candidates.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_sandbox_integration_candidates.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_sandbox_integration_candidates.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      candidate.integration_candidate_id,
      candidate.run_id,
      candidate.proposal_id,
      candidate.review_id,
      candidate.validation_candidate_id,
      candidate.sandbox_result_id,
      candidate.sandbox_validation_id,
      candidate.preparation_plan_id,
      candidate.proposed_node_id,
      candidate.patch_artifact_ref,
      candidate.patch_summary,
      JSON.stringify(candidate.changed_files),
      JSON.stringify(candidate.required_file_locks),
      JSON.stringify(candidate.required_module_locks),
      JSON.stringify(candidate.required_semantic_locks),
      candidate.review_ref,
      candidate.sandbox_apply_ref,
      candidate.sandbox_validation_ref,
      candidate.strict_validation_status,
      candidate.rollback_requirements_ref,
      candidate.post_integration_validation_plan_ref,
      candidate.risk_level,
      candidate.approval_required ? 1 : 0,
      candidate.status,
      candidate.blockers.length,
      candidate.warnings.length,
      artifactRef,
      candidate.summary_ref,
      candidate.trace_event_id,
      jsonMetadata(candidate.metadata_json),
      candidate.created_at
    );
  }

  recordSandboxIntegrationCandidateBlocker(input: FactorySandboxIntegrationCandidateBlockerRecordInput) {
    const blocker = input.blocker;
    this.database.prepare(`
      INSERT INTO factory_sandbox_integration_candidate_blockers (
        blocker_id, integration_candidate_id, run_id, blocker_type,
        severity, reason, refs_json, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(blocker_id) DO UPDATE SET
        blocker_type = excluded.blocker_type,
        severity = excluded.severity,
        reason = excluded.reason,
        refs_json = excluded.refs_json,
        metadata_json = excluded.metadata_json
    `).run(
      blocker.blocker_id,
      blocker.integration_candidate_id,
      blocker.run_id,
      blocker.blocker_type,
      blocker.severity,
      blocker.reason,
      JSON.stringify(blocker.refs),
      jsonMetadata(blocker.metadata_json),
      blocker.created_at
    );
  }

  recordSandboxIntegrationCandidateBatch(input: FactorySandboxIntegrationCandidateBatchRecordInput) {
    const batch = input.batch;
    const artifactRef = input.artifactRef ?? batch.artifact_ref;
    this.database.prepare(`
      INSERT INTO factory_sandbox_integration_candidate_batches (
        batch_id, run_id, sandbox_validation_ids_json, candidate_count,
        candidate_created_count, blocked_count, rejected_count,
        validation_failed_count, validation_blocked_count, artifact_ref,
        summary_ref, trace_event_id, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        sandbox_validation_ids_json = excluded.sandbox_validation_ids_json,
        candidate_count = excluded.candidate_count,
        candidate_created_count = excluded.candidate_created_count,
        blocked_count = excluded.blocked_count,
        rejected_count = excluded.rejected_count,
        validation_failed_count = excluded.validation_failed_count,
        validation_blocked_count = excluded.validation_blocked_count,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_sandbox_integration_candidate_batches.artifact_ref),
        summary_ref = COALESCE(excluded.summary_ref, factory_sandbox_integration_candidate_batches.summary_ref),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_sandbox_integration_candidate_batches.trace_event_id),
        metadata_json = excluded.metadata_json
    `).run(
      batch.batch_id,
      batch.run_id,
      JSON.stringify(batch.sandbox_validation_ids),
      batch.summary.integration_candidate_count,
      batch.summary.candidate_created_count,
      batch.summary.blocked_count,
      batch.summary.rejected_count,
      batch.summary.validation_failed_count,
      batch.summary.validation_blocked_count,
      artifactRef,
      batch.summary_ref,
      batch.trace_event_id,
      jsonMetadata(batch.metadata_json),
      batch.created_at
    );
  }

  recordApprovalScopeConstraint(input: FactoryApprovalScopeConstraintRecordInput) {
    const constraint = input.constraint;
    this.database.prepare(`
      INSERT INTO factory_approval_scope_constraints (
        constraint_id, run_id, source_id, source_type, constraint_type,
        status, description, refs_json, artifact_ref, metadata_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(constraint_id) DO UPDATE SET
        status = excluded.status,
        description = excluded.description,
        refs_json = excluded.refs_json,
        artifact_ref = COALESCE(excluded.artifact_ref, factory_approval_scope_constraints.artifact_ref),
        metadata_json = excluded.metadata_json
    `).run(
      constraint.constraint_id,
      input.runId,
      input.sourceId,
      input.sourceType,
      constraint.constraint_type,
      constraint.status,
      constraint.description,
      JSON.stringify(constraint.refs),
      input.artifactRef,
      jsonMetadata(constraint.metadata_json),
      input.createdAt ?? nowIso()
    );
  }

  recordLocks(input: {
    runId: string;
    taskId?: string;
    sourceId: string;
    status: string;
    artifactRef: string;
    locks: unknown;
    createdAt?: string;
  }) {
    const locks = Array.isArray(input.locks) ? input.locks : [];
    const scopes = locks.flatMap((lock) => extractLockScopes(lock));
    this.database.prepare(`
      INSERT INTO factory_locks (
        id, run_id, task_id, source_id, status, lock_scope, artifact_ref,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = COALESCE(excluded.task_id, factory_locks.task_id),
        status = excluded.status,
        lock_scope = excluded.lock_scope,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("lock", [input.runId, input.sourceId, input.artifactRef]),
      input.runId,
      input.taskId,
      input.sourceId,
      input.status,
      scopes.join(","),
      input.artifactRef,
      input.createdAt ?? nowIso(),
      input.createdAt ?? nowIso(),
      jsonMetadata({ lock_count: locks.length, scope_count: scopes.length })
    );
    this.recordArtifact({
      runId: input.runId,
      taskId: input.taskId,
      kind: "lock",
      artifactRef: input.artifactRef,
      status: input.status,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    });
  }

  recordDurableLock(input: FactoryLockRecordInput) {
    const lock = input.lock;
    const createdAt = lock.acquired_at ?? lock.heartbeat_at ?? lock.released_at ?? nowIso();
    this.database.prepare(`
      INSERT INTO factory_locks (
        id, lock_id, run_id, task_id, agent_id, work_item_id, source_id,
        lock_type, lock_mode, status, lock_scope, normalized_scope_key,
        owner_component, reason, conflict_with_lock_id, acquired_at,
        expires_at, released_at, heartbeat_at, trace_event_id,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        conflict_with_lock_id = COALESCE(excluded.conflict_with_lock_id, factory_locks.conflict_with_lock_id),
        acquired_at = COALESCE(excluded.acquired_at, factory_locks.acquired_at),
        expires_at = COALESCE(excluded.expires_at, factory_locks.expires_at),
        released_at = COALESCE(excluded.released_at, factory_locks.released_at),
        heartbeat_at = COALESCE(excluded.heartbeat_at, factory_locks.heartbeat_at),
        trace_event_id = COALESCE(excluded.trace_event_id, factory_locks.trace_event_id),
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      lock.lock_id,
      lock.lock_id,
      lock.run_id,
      lock.task_id,
      lock.agent_id,
      lock.work_item_id,
      lock.owner_component,
      lock.lock_type,
      lock.lock_mode,
      lock.status,
      lock.lock_scope,
      lock.normalized_scope_key,
      lock.owner_component,
      lock.reason,
      lock.conflict_with_lock_id ?? input.conflict?.existing_lock.lock_id,
      lock.acquired_at,
      lock.expires_at,
      lock.released_at,
      lock.heartbeat_at,
      lock.trace_event_id,
      input.artifactRef,
      createdAt,
      nowIso(),
      jsonMetadata({
        ...lock.metadata_json,
        schema_version: lock.schema_version,
        conflict: input.conflict ? {
          conflict_id: input.conflict.conflict_id,
          existing_lock_id: input.conflict.existing_lock.lock_id,
          reason: input.conflict.reason,
          blocking: input.conflict.blocking
        } : undefined
      })
    );
    this.recordArtifact({
      runId: lock.run_id,
      taskId: lock.task_id,
      kind: "lock",
      artifactRef: input.artifactRef,
      status: lock.status,
      createdAt,
      updatedAt: nowIso(),
      metadata: {
        lock_id: lock.lock_id,
        lock_type: lock.lock_type,
        lock_mode: lock.lock_mode,
        normalized_scope_key: lock.normalized_scope_key
      }
    });
  }

  listActiveDurableLocks(now = nowIso()): FactoryLock[] {
    return this.all<Record<string, unknown>>(
      `SELECT * FROM factory_locks
       WHERE lock_id IS NOT NULL
         AND status IN ('requested', 'acquired')
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at, lock_id`,
      now
    ).map(lockFromRow);
  }

  listExpiredDurableLocks(now = nowIso()): FactoryLock[] {
    return this.all<Record<string, unknown>>(
      `SELECT * FROM factory_locks
       WHERE lock_id IS NOT NULL
         AND status IN ('requested', 'acquired')
         AND expires_at IS NOT NULL
         AND expires_at <= ?
       ORDER BY expires_at, lock_id`,
      now
    ).map(lockFromRow);
  }

  recordRunMetrics(metrics: RunMetrics, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_metrics (
        id, run_id, campaign_id, metric_scope, status, generated_at,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        generated_at = excluded.generated_at,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("metric", [metrics.run_id, "run_metrics"]),
      metrics.run_id,
      undefined,
      "run",
      metrics.status,
      metrics.generated_at,
      artifactRef,
      metrics.generated_at,
      metrics.generated_at,
      jsonMetadata({
        tasks_created: metrics.tasks_created,
        tasks_completed: metrics.tasks_completed,
        tasks_failed: metrics.tasks_failed,
        validation_passed: metrics.validation.passed,
        validation_failed: metrics.validation.failed,
        validation_blocked: metrics.validation.blocked
      })
    );
    this.recordArtifact({
      runId: metrics.run_id,
      kind: "run_metrics",
      artifactRef,
      status: metrics.status,
      createdAt: metrics.generated_at,
      updatedAt: metrics.generated_at
    });
  }

  recordSwarmMetrics(metrics: SwarmMetrics, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_metrics (
        id, run_id, campaign_id, metric_scope, status, generated_at,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        generated_at = excluded.generated_at,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("metric", [metrics.swarm_run_id, "swarm_metrics"]),
      metrics.swarm_run_id,
      undefined,
      "swarm",
      undefined,
      metrics.generated_at,
      artifactRef,
      metrics.generated_at,
      metrics.generated_at,
      jsonMetadata({
        work_items_created: metrics.work_items_created,
        work_items_completed: metrics.work_items_completed,
        work_items_failed: metrics.work_items_failed,
        validation_pass_rate: metrics.validation_pass_rate,
        conflicts_detected: metrics.conflicts_detected
      })
    );
    this.recordArtifact({
      runId: metrics.swarm_run_id,
      kind: "swarm_metrics",
      artifactRef,
      createdAt: metrics.generated_at,
      updatedAt: metrics.generated_at
    });
  }

  recordCampaign(campaign: Campaign, artifactRef: string) {
    this.database.prepare(`
      INSERT INTO factory_campaigns (
        id, status, title, original_goal, artifact_ref, final_report_ref,
        created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        title = excluded.title,
        original_goal = excluded.original_goal,
        artifact_ref = excluded.artifact_ref,
        final_report_ref = excluded.final_report_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      campaign.id,
      campaign.status,
      campaign.title,
      campaign.original_goal,
      artifactRef,
      campaign.final_report_ref,
      campaign.created_at,
      campaign.updated_at,
      jsonMetadata({
        run_count: campaign.runs.length,
        milestone_count: campaign.milestones.length,
        risk_count: campaign.risks.length,
        decision_count: campaign.decisions.length,
        memory_ref_count: campaign.memory_refs.length
      })
    );
    this.recordArtifact({
      campaignId: campaign.id,
      kind: "campaign",
      artifactRef,
      status: campaign.status,
      createdAt: campaign.created_at,
      updatedAt: campaign.updated_at
    });
  }

  recordCampaignMetric(input: { campaignId: string; status: string; generatedAt: string; artifactRef: string; metadata?: Record<string, unknown> }) {
    this.database.prepare(`
      INSERT INTO factory_metrics (
        id, run_id, campaign_id, metric_scope, status, generated_at,
        artifact_ref, created_at, updated_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        generated_at = excluded.generated_at,
        artifact_ref = excluded.artifact_ref,
        updated_at = excluded.updated_at,
        metadata_json = excluded.metadata_json
    `).run(
      factoryMetadataStableId("metric", [input.campaignId, "campaign_metrics"]),
      undefined,
      input.campaignId,
      "campaign",
      input.status,
      input.generatedAt,
      input.artifactRef,
      input.generatedAt,
      input.generatedAt,
      jsonMetadata(input.metadata ?? {})
    );
    this.recordArtifact({
      campaignId: input.campaignId,
      kind: "campaign_metrics",
      artifactRef: input.artifactRef,
      status: input.status,
      createdAt: input.generatedAt,
      updatedAt: input.generatedAt
    });
  }

  recordFinalReport(report: FinalRunReport, artifactRef: string) {
    this.recordOutput({
      runId: report.run_id,
      sourceId: "final_report",
      kind: "final_report",
      status: report.status,
      artifactRef,
      metadata: {
        tasks_created: report.tasks_created,
        tasks_completed: report.tasks_completed,
        tasks_failed: report.tasks_failed,
        files_changed: report.files_changed.length,
        validation_results: report.validation_results.length
      }
    });
  }

  recordSwarmWorkItemResult(input: { runId: string; result: WorkItemResult; role: string; type: WorkItem["type"]; artifactRef: string }) {
    const status = input.result.status;
    const metadata = {
      role: input.role,
      confidence: input.result.confidence,
      finding_count: input.result.findings.length,
      risk_count: input.result.risks.length,
      structured_output_valid: input.result.structured_output_valid
    };
    if (input.type === "review" || input.role.includes("Reviewer")) {
      this.recordReview({
        runId: input.runId,
        taskId: input.result.work_item_id,
        sourceId: input.result.work_item_id,
        kind: `swarm_${input.type}`,
        status,
        decision: status,
        artifactRef: input.artifactRef,
        metadata
      });
    } else if (input.type === "test") {
      this.recordValidation({
        runId: input.runId,
        taskId: input.result.work_item_id,
        sourceId: input.result.work_item_id,
        kind: "swarm_test",
        status,
        artifactRef: input.artifactRef,
        metadata
      });
    } else {
      this.recordOutput({
        runId: input.runId,
        taskId: input.result.work_item_id,
        sourceId: input.result.work_item_id,
        kind: `swarm_${input.type}`,
        status,
        artifactRef: input.artifactRef,
        metadata
      });
    }
  }

  recordSwarmConfigArtifact(input: { runId: string; kind: string; artifactRef: string; count?: number }) {
    this.recordArtifact({
      runId: input.runId,
      kind: input.kind,
      artifactRef: input.artifactRef,
      metadata: input.count === undefined ? {} : { item_count: input.count }
    });
  }

  private migrateTraceEventSchema() {
    const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(factory_trace_events)").map((row) => row.name));
    const addColumn = (name: string, definition: string) => {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE factory_trace_events ADD COLUMN ${name} ${definition}`);
    };
    addColumn("trace_event_id", "TEXT");
    addColumn("campaign_id", "TEXT");
    addColumn("parent_task_id", "TEXT");
    addColumn("agent_id", "TEXT");
    addColumn("team_id", "TEXT");
    addColumn("lifecycle_stage", "TEXT");
    addColumn("previous_status", "TEXT");
    addColumn("next_status", "TEXT");
    addColumn("source_component", "TEXT");
    addColumn("severity", "TEXT");
    addColumn("causal_parent_event_id", "TEXT");
    addColumn("causal_chain_id", "TEXT");
    addColumn("reason", "TEXT");
    addColumn("summary", "TEXT");
    addColumn("artifact_refs_json", "TEXT NOT NULL DEFAULT '[]'");
    this.database.exec(`
      UPDATE factory_trace_events
      SET
        trace_event_id = COALESCE(trace_event_id, id),
        source_component = COALESCE(source_component, 'unknown'),
        severity = COALESCE(severity, 'info'),
        causal_chain_id = COALESCE(causal_chain_id, trace_event_id, id),
        summary = COALESCE(summary, message),
        artifact_refs_json = COALESCE(artifact_refs_json, '[]')
    `);
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_trace_events_task ON factory_trace_events(run_id, task_id, created_at)");
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_trace_events_causal ON factory_trace_events(run_id, causal_chain_id)");
  }

  private migratePromptSchema() {
    const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(factory_prompts)").map((row) => row.name));
    const addColumn = (name: string, definition: string) => {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE factory_prompts ADD COLUMN ${name} ${definition}`);
    };
    addColumn("prompt_id", "TEXT");
    addColumn("agent_id", "TEXT");
    addColumn("agent_role", "TEXT");
    addColumn("prompt_type", "TEXT");
    addColumn("template_id", "TEXT");
    addColumn("template_version", "TEXT");
    addColumn("renderer_version", "TEXT");
    addColumn("template_input_schema_version", "TEXT");
    addColumn("input_hash", "TEXT");
    addColumn("rendered_prompt_hash", "TEXT");
    addColumn("context_pack_ref", "TEXT");
    addColumn("output_schema_name", "TEXT");
    addColumn("source_component", "TEXT");
    this.database.exec(`
      UPDATE factory_prompts
      SET
        prompt_id = COALESCE(prompt_id, id),
        agent_role = COALESCE(agent_role, role),
        prompt_type = COALESCE(prompt_type, prompt_kind),
        rendered_prompt_hash = COALESCE(rendered_prompt_hash, prompt_hash),
        source_component = COALESCE(source_component, 'unknown')
    `);
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_prompts_template ON factory_prompts(template_id, template_version)");
  }

  private migrateLockSchema() {
    const columns = new Set(this.all<{ name: string }>("PRAGMA table_info(factory_locks)").map((row) => row.name));
    const addColumn = (name: string, definition: string) => {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE factory_locks ADD COLUMN ${name} ${definition}`);
    };
    addColumn("lock_id", "TEXT");
    addColumn("agent_id", "TEXT");
    addColumn("work_item_id", "TEXT");
    addColumn("lock_type", "TEXT");
    addColumn("lock_mode", "TEXT");
    addColumn("normalized_scope_key", "TEXT");
    addColumn("owner_component", "TEXT");
    addColumn("reason", "TEXT");
    addColumn("conflict_with_lock_id", "TEXT");
    addColumn("acquired_at", "TEXT");
    addColumn("expires_at", "TEXT");
    addColumn("released_at", "TEXT");
    addColumn("heartbeat_at", "TEXT");
    addColumn("trace_event_id", "TEXT");
    this.database.exec(`
      UPDATE factory_locks
      SET
        lock_id = COALESCE(lock_id, id),
        lock_type = COALESCE(lock_type, 'file'),
        lock_mode = COALESCE(lock_mode, 'write'),
        normalized_scope_key = COALESCE(normalized_scope_key, lock_scope),
        owner_component = COALESCE(owner_component, source_id),
        reason = COALESCE(reason, status),
        acquired_at = COALESCE(acquired_at, created_at),
        heartbeat_at = COALESCE(heartbeat_at, updated_at)
    `);
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_locks_active ON factory_locks(status, expires_at)");
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_locks_scope ON factory_locks(normalized_scope_key, lock_mode, status)");
    this.database.exec("CREATE INDEX IF NOT EXISTS idx_factory_locks_task ON factory_locks(run_id, task_id, status)");
  }

  private replaceTaskDependencies(runId: string, taskId: string, dependencies: string[], artifactRef?: string, updatedAt?: string) {
    this.database.prepare("DELETE FROM factory_task_dependencies WHERE run_id = ? AND task_id = ?").run(runId, taskId);
    for (const dependency of dependencies) {
      this.database.prepare(`
        INSERT INTO factory_task_dependencies (
          id, run_id, task_id, depends_on_task_id, status, artifact_ref, created_at, updated_at, metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        factoryMetadataStableId("task_dependency", [runId, taskId, dependency]),
        runId,
        taskId,
        dependency,
        "active",
        artifactRef,
        updatedAt ?? nowIso(),
        updatedAt ?? nowIso(),
        jsonMetadata({})
      );
    }
  }

  private relativeArtifactRef(artifactRef: string) {
    const resolved = path.resolve(artifactRef);
    const relative = path.relative(this.memoryRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.replaceAll("\\", "/");
  }
}

export class FactoryMetadataAdapter {
  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {}

  async recordRunSaved(run: Run, artifactRef: string) {
    await this.write((store) => store.recordRun(run, artifactRef));
  }

  async recordRunTransition(record: RunTransitionRecord) {
    await this.write((store) => store.recordRunTransition(record));
  }

  async recordFactoryTraceEvent(event: FactoryTraceEvent) {
    await this.write((store) => store.recordFactoryTraceEvent(event));
  }

  async recordSwarmRunSaved(run: SwarmRun, artifactRef: string) {
    await this.write((store) => store.recordSwarmRun(run, artifactRef));
  }

  async recordTasksSaved(runId: string, tasks: Task[], artifactRef: string) {
    await this.write((store) => store.recordTasks(runId, tasks, artifactRef));
  }

  async recordWorkItemsSaved(runId: string, workItems: WorkItem[], artifactRef: string) {
    await this.write((store) => store.recordWorkItems(runId, workItems, artifactRef));
  }

  async recordContextPackSaved(pack: ContextPack, artifactRef: string) {
    await this.write((store) => {
      store.recordMemoryChunk(pack, artifactRef);
      store.recordContextItems(pack, artifactRef);
    });
  }

  async recordInvocationSaved(invocation: AgentInvocation, artifactRef: string) {
    await this.write((store) => store.recordPromptFromInvocation(invocation, artifactRef));
  }

  async recordPromptArtifactSaved(input: PromptArtifactMetadata) {
    await this.write((store) => store.recordPromptMetadata(input));
  }

  async recordPromptQualityResultSaved(result: PromptQualityResult, artifactRef: string, traceEventId?: string) {
    await this.write((store) => store.recordPromptQualityResult(result, artifactRef, traceEventId));
  }

  async recordPlanVariantSaved(variant: PlanVariant) {
    await this.write((store) => store.recordPlanVariant(variant));
  }

  async recordPlanEvaluationSaved(evaluation: PlanEvaluation) {
    await this.write((store) => store.recordPlanEvaluation(evaluation));
  }

  async recordMergedPlanSaved(plan: MergedPlan) {
    await this.write((store) => store.recordMergedPlan(plan));
  }

  async recordWorkerInvocationSaved(input: FactoryWorkerInvocationRecordInput) {
    await this.write((store) => store.recordWorkerInvocation(input));
  }

  async recordPlanningEvidenceSaved(item: PlanningEvidenceItem) {
    await this.write((store) => store.recordPlanningEvidence(item));
  }

  async recordPlanEvidenceLinkSaved(input: FactoryPlanningEvidenceLinkInput) {
    await this.write((store) => store.recordPlanEvidenceLink(input));
  }

  async recordPromptWriterOutputSaved(input: FactoryPromptWriterOutputRecordInput) {
    await this.write((store) => store.recordPromptWriterOutput(input));
  }

  async recordPromptWriterAdoptionDecisionSaved(input: FactoryPromptWriterAdoptionDecisionRecordInput) {
    await this.write((store) => store.recordPromptWriterAdoptionDecision(input));
  }

  async recordDurableLockSaved(input: FactoryLockRecordInput) {
    await this.write((store) => store.recordDurableLock(input));
  }

  async recordIntegrationCandidateSaved(input: FactoryIntegrationCandidateRecordInput) {
    await this.write((store) => store.recordIntegrationCandidate(input));
  }

  async recordIntegrationPlanSaved(input: FactoryIntegrationPlanRecordInput) {
    await this.write((store) => store.recordIntegrationPlan(input));
  }

  async recordIntegrationConflictSaved(input: FactoryIntegrationConflictRecordInput) {
    await this.write((store) => store.recordIntegrationConflict(input));
  }

  async recordIntegrationResultSaved(input: FactoryIntegrationResultRecordInput) {
    await this.write((store) => store.recordIntegrationResult(input));
  }

  async recordAgentTeamSaved(input: FactoryAgentTeamRecordInput) {
    await this.write((store) => store.recordAgentTeam(input));
  }

  async recordAgentTeamAssignmentSaved(input: FactoryAgentTeamAssignmentRecordInput) {
    await this.write((store) => store.recordAgentTeamAssignment(input));
  }

  async recordAgentTeamBudgetSaved(input: FactoryAgentTeamBudgetRecordInput) {
    await this.write((store) => store.recordAgentTeamBudget(input));
  }

  async recordTeamContextScopeSaved(scope: TeamContextScope) {
    await this.write((store) => store.recordTeamContextScope(scope));
  }

  async recordTeamMemoryQuerySaved(query: TeamScopedMemoryQuery) {
    await this.write((store) => store.recordTeamMemoryQuery(query));
  }

  async recordTeamSubPlanSaved(plan: TeamSubPlan) {
    await this.write((store) => store.recordTeamSubPlan({ plan }));
  }

  async recordTeamSubPlanAggregationSaved(aggregation: TeamSubPlanAggregation) {
    await this.write((store) => store.recordTeamSubPlanAggregation({ aggregation }));
  }

  async recordAdoptedTaskProposalSaved(proposal: AdoptedTaskProposal) {
    await this.write((store) => store.recordAdoptedTaskProposal({ proposal }));
  }

  async recordTaskAdoptionDecisionSaved(decision: TaskAdoptionDecision) {
    await this.write((store) => store.recordTaskAdoptionDecision({ decision }));
  }

  async recordTaskReadinessResultSaved(readiness: TaskReadinessProfile) {
    await this.write((store) => store.recordTaskReadinessResult({ readiness }));
  }

  async recordProposedTaskGraphSaved(graph: ProposedTaskGraph) {
    await this.write((store) => store.recordProposedTaskGraph({ graph }));
  }

  async recordProposedTaskNodeSaved(graphId: string, node: ProposedTaskGraphNode) {
    await this.write((store) => store.recordProposedTaskNode({ graphId, node }));
  }

  async recordProposedTaskEdgeSaved(graphId: string, edge: ProposedTaskGraphEdge) {
    await this.write((store) => store.recordProposedTaskEdge({ graphId, edge }));
  }

  async recordProposedTaskGraphValidationSaved(validation: ProposedTaskGraphValidationResult) {
    await this.write((store) => store.recordProposedTaskGraphValidation({ validation }));
  }

  async recordExecutionReadinessDecisionSaved(decision: ExecutionReadinessDecision) {
    await this.write((store) => store.recordExecutionReadinessDecision({ decision }));
  }

  async recordExecutionReadinessRequirementSaved(decisionId: string, requirement: ExecutionReadinessRequirement, decision: ExecutionReadinessDecision) {
    await this.write((store) => store.recordExecutionReadinessRequirement({ decisionId, requirement, decision }));
  }

  async recordExecutionApprovalRequirementSaved(approval: HumanApprovalRequirement) {
    await this.write((store) => store.recordExecutionApprovalRequirement({ approval }));
  }

  async recordExecutionReadinessBatchSaved(batch: ExecutionReadinessBatch) {
    await this.write((store) => store.recordExecutionReadinessBatch({ batch }));
  }

  async recordExecutionPromotionRequestSaved(request: ExecutionPromotionRequest) {
    await this.write((store) => store.recordExecutionPromotionRequest({ request }));
  }

  async recordHumanApprovalRecordSaved(approval: HumanApprovalRecord) {
    await this.write((store) => {
      store.recordHumanApprovalRecord({ approval });
      for (const constraint of approval.constraints) {
        store.recordApprovalScopeConstraint({
          runId: approval.run_id,
          sourceId: approval.approval_id,
          sourceType: "human_approval",
          constraint,
          artifactRef: approval.artifact_ref,
          createdAt: approval.created_at
        });
      }
    });
  }

  async recordPromotionQueueItemSaved(item: PromotionQueueItem) {
    await this.write((store) => {
      store.recordPromotionQueueItem({ item });
      for (const constraint of item.constraints) {
        store.recordApprovalScopeConstraint({
          runId: item.run_id,
          sourceId: item.queue_item_id,
          sourceType: "promotion_queue_item",
          constraint,
          artifactRef: item.artifact_ref,
          createdAt: item.created_at
        });
      }
    });
  }

  async recordExecutionPreparationPlanSaved(plan: ExecutionPreparationPlan) {
    await this.write((store) => {
      store.recordExecutionPreparationPlan({ plan });
      for (const blocker of plan.blockers) {
        store.recordExecutionPreparationBlocker({
          blocker,
          runId: plan.run_id,
          queueItemId: plan.queue_item_id,
          artifactRef: plan.artifact_ref
        });
      }
      for (const warning of plan.warnings) {
        store.recordExecutionPreparationWarning({
          warning,
          runId: plan.run_id,
          queueItemId: plan.queue_item_id,
          artifactRef: plan.artifact_ref
        });
      }
    });
  }

  async recordExecutionPreparationBatchSaved(batch: ExecutionPreparationBatch) {
    await this.write((store) => store.recordExecutionPreparationBatch({ batch }));
  }

  async recordOneWriterDryRunProposalSaved(proposal: OneWriterDryRunProposal) {
    await this.write((store) => {
      store.recordOneWriterDryRunProposal({ proposal });
      for (const change of proposal.patch_proposal?.file_changes ?? []) {
        store.recordPatchProposalFile({ proposal, fileChange: change });
      }
      if (proposal.scope_check_result) {
        store.recordPatchProposalScopeCheck({ proposal, scopeCheck: proposal.scope_check_result });
      }
    });
  }

  async recordOneWriterDryRunBatchSaved(batch: OneWriterDryRunBatch) {
    await this.write((store) => store.recordDryRunWriterBatch({ batch }));
  }

  async recordPatchProposalReviewSaved(review: PatchProposalReview) {
    await this.write((store) => {
      store.recordPatchProposalReview({ review });
      for (const finding of review.findings) {
        store.recordPatchReviewFinding({ review, finding });
      }
    });
  }

  async recordPatchProposalReviewBatchSaved(batch: PatchProposalReviewBatch) {
    await this.write((store) => store.recordPatchReviewBatch({ batch }));
  }

  async recordValidationCandidateSaved(candidate: ValidationCandidate) {
    await this.write((store) => {
      store.recordValidationCandidate({ candidate });
      for (const preflight of candidate.command_safety_results) {
        store.recordValidationCommandPreflight({ candidate, commandPreflight: preflight });
      }
      if (candidate.environment_readiness) {
        store.recordValidationEnvironmentPreflight({ candidate, environmentReadiness: candidate.environment_readiness });
      }
    });
  }

  async recordValidationCandidateBatchSaved(batch: ValidationCandidateBatch) {
    await this.write((store) => store.recordValidationCandidateBatch({ batch }));
  }

  async recordPatchApplySandboxResultSaved(result: PatchApplySandboxResult) {
    await this.write((store) => {
      store.recordPatchApplySandboxResult({ result });
      for (const conflict of result.conflicts) {
        store.recordPatchApplyConflict({ result, conflict });
      }
    });
  }

  async recordPatchApplySandboxBatchSaved(batch: PatchSandboxBatch) {
    await this.write((store) => store.recordPatchApplySandboxBatch({ batch }));
  }

  async recordSandboxValidationResultSaved(result: SandboxValidationResult) {
    await this.write((store) => {
      store.recordSandboxValidationResult({ result });
      for (const commandResult of result.command_results) {
        store.recordSandboxValidationCommand({ result, commandResult });
      }
    });
  }

  async recordSandboxValidationBatchSaved(batch: SandboxValidationBatch) {
    await this.write((store) => store.recordSandboxValidationBatch({ batch }));
  }

  async recordSandboxIntegrationCandidateSaved(candidate: SandboxValidatedIntegrationCandidate) {
    await this.write((store) => {
      store.recordSandboxIntegrationCandidate({ candidate });
      for (const blocker of candidate.blockers) {
        store.recordSandboxIntegrationCandidateBlocker({ candidate, blocker });
      }
    });
  }

  async recordSandboxIntegrationCandidateBatchSaved(batch: IntegrationCandidateBatch) {
    await this.write((store) => store.recordSandboxIntegrationCandidateBatch({ batch }));
  }

  async recordOutputSaved(runId: string, sourceId: string, kind: string, artifactRef: string, value?: unknown, taskId?: string) {
    await this.write((store) => store.recordOutput({
      runId,
      taskId: taskId ?? extractTaskId(value) ?? inferTaskIdFromSourceId(sourceId),
      sourceId,
      kind,
      status: extractStatus(value),
      artifactRef,
      metadata: summarizeValue(value)
    }));
  }

  async recordReviewSaved(runId: string, sourceId: string, artifactRef: string, value?: unknown, taskId?: string) {
    await this.write((store) => store.recordReview({
      runId,
      taskId: taskId ?? extractTaskId(value) ?? inferTaskIdFromSourceId(sourceId),
      sourceId,
      kind: sourceId.includes("approval") ? "approval_gate" : "review",
      status: extractStatus(value),
      decision: extractDecision(value),
      artifactRef,
      metadata: summarizeValue(value)
    }));
  }

  async recordValidationSaved(runId: string, sourceId: string, kind: string, artifactRef: string, value?: unknown, taskId?: string) {
    await this.write((store) => store.recordValidation({
      runId,
      taskId: taskId ?? extractTaskId(value) ?? inferTaskIdFromSourceId(sourceId),
      sourceId,
      kind,
      status: extractStatus(value),
      artifactRef,
      metadata: summarizeValue(value)
    }));
  }

  async recordLockSnapshotSaved(runId: string, sourceId: string, artifactRef: string, value: unknown) {
    await this.write((store) => store.recordLocks({
      runId,
      taskId: inferTaskIdFromSourceId(sourceId),
      sourceId,
      status: sourceId.includes("released") ? "released" : "acquired",
      artifactRef,
      locks: value
    }));
  }

  async recordEventAppended(event: OrchestratorEvent | SwarmEvent, artifactRef: string) {
    await this.write((store) => store.recordTraceEvent(event, artifactRef));
  }

  async recordSchedulerTraceAppended(entry: SchedulerTraceEntry, artifactRef: string) {
    await this.write((store) => store.recordSchedulerTrace(entry, artifactRef));
  }

  async recordRunMetricsSaved(metrics: RunMetrics, artifactRef: string) {
    await this.write((store) => store.recordRunMetrics(metrics, artifactRef));
  }

  async recordSwarmMetricsSaved(metrics: SwarmMetrics, artifactRef: string) {
    await this.write((store) => store.recordSwarmMetrics(metrics, artifactRef));
  }

  async recordFinalReportSaved(report: FinalRunReport, artifactRef: string) {
    await this.write((store) => store.recordFinalReport(report, artifactRef));
  }

  async recordCampaignSaved(campaign: Campaign, artifactRef: string) {
    await this.write((store) => store.recordCampaign(campaign, artifactRef));
  }

  async recordCampaignMetricSaved(input: { campaignId: string; status: string; generatedAt: string; artifactRef: string; metadata?: Record<string, unknown> }) {
    await this.write((store) => store.recordCampaignMetric(input));
  }

  async recordArtifactSaved(input: FactoryArtifactRecordInput) {
    await this.write((store) => store.recordArtifact(input));
  }

  async recordSwarmConfigArtifactSaved(input: { runId: string; kind: string; artifactRef: string; count?: number }) {
    await this.write((store) => store.recordSwarmConfigArtifact(input));
  }

  async recordSwarmWorkItemResultSaved(input: { runId: string; result: WorkItemResult; role: string; type: WorkItem["type"]; artifactRef: string }) {
    await this.write((store) => store.recordSwarmWorkItemResult(input));
  }

  async recordSwarmConsensusSaved(group: ConsensusGroup, artifactRef: string) {
    await this.write((store) => {
      store.recordOutput({
        runId: group.swarm_run_id,
        sourceId: group.id,
        kind: "swarm_consensus",
        status: "recorded",
        artifactRef,
        metadata: {
          topic: group.topic,
          participant_count: group.participant_work_items.length,
          confidence: group.confidence
        }
      });
    });
  }

  async recordSwarmStaffingPlanSaved(plan: StaffingPlan, artifactRef: string) {
    await this.write((store) => {
      store.recordArtifact({
        runId: plan.swarm_run_id,
        kind: "swarm_staffing_plan",
        artifactRef,
        createdAt: plan.created_at,
        updatedAt: plan.created_at,
        metadata: {
          recommended_total_logical_agents: plan.recommended_total_logical_agents,
          executor_limit: plan.executor_limit,
          validation_level: plan.validation_level,
          risk_level: plan.risk_level
        }
      });
    });
  }

  async recordSwarmAgentTemplatesSaved(runId: string, templates: AgentTemplate[], artifactRef: string) {
    await this.recordSwarmConfigArtifactSaved({ runId, kind: "swarm_agent_templates", artifactRef, count: templates.length });
  }

  async recordSwarmAgentInstancesSaved(runId: string, instances: AgentInstance[], artifactRef: string) {
    await this.recordSwarmConfigArtifactSaved({ runId, kind: "swarm_agent_instances", artifactRef, count: instances.length });
  }

  private async write(operation: (store: FactoryMetadataStore) => void) {
    try {
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir });
      try {
        operation(store);
      } finally {
        store.close();
      }
    } catch {
      // Metadata writes are best-effort so artifact persistence behavior remains unchanged.
    }
  }
}

export function factoryMetadataStableId(prefix: string, parts: Array<string | number | undefined>) {
  return `${prefix}_${createHash("sha256").update(parts.map((part) => part ?? "").join("\0")).digest("hex").slice(0, 24)}`;
}

const FACTORY_METADATA_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS factory_schema_versions (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_runs (
  id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL,
  campaign_id TEXT,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  mode TEXT,
  user_request TEXT,
  workspace_path TEXT,
  memory_dir TEXT,
  artifacts_path TEXT NOT NULL,
  run_artifact_ref TEXT,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_run_transitions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  previous_status TEXT,
  next_status TEXT NOT NULL,
  canonical_previous_status TEXT,
  canonical_next_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_component TEXT NOT NULL,
  task_id TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  transition_trigger TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  parent_task_id TEXT,
  task_kind TEXT NOT NULL,
  title TEXT,
  objective TEXT,
  role TEXT,
  status TEXT NOT NULL,
  priority INTEGER,
  artifact_ref TEXT,
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, task_id)
);

CREATE TABLE IF NOT EXISTS factory_task_dependencies (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS factory_prompts (
  id TEXT PRIMARY KEY,
  prompt_id TEXT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  invocation_id TEXT,
  agent_id TEXT,
  role TEXT,
  agent_role TEXT,
  prompt_kind TEXT NOT NULL,
  prompt_type TEXT,
  status TEXT,
  template_id TEXT,
  template_version TEXT,
  renderer_version TEXT,
  template_input_schema_version TEXT,
  input_hash TEXT,
  rendered_prompt_hash TEXT,
  prompt_hash TEXT,
  prompt_chars INTEGER,
  context_pack_ref TEXT,
  output_schema_name TEXT,
  artifact_ref TEXT,
  source_component TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_prompt_quality_results (
  id TEXT PRIMARY KEY,
  quality_result_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  agent_role TEXT,
  status TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  role_profile TEXT NOT NULL,
  checks_passed_count INTEGER NOT NULL,
  warnings_count INTEGER NOT NULL,
  failures_count INTEGER NOT NULL,
  blocked_count INTEGER NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(prompt_id, quality_result_id)
);

CREATE TABLE IF NOT EXISTS factory_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  source_id TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  status TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, source_id, output_kind)
);

CREATE TABLE IF NOT EXISTS factory_reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  source_id TEXT NOT NULL,
  review_kind TEXT NOT NULL,
  status TEXT,
  decision TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, source_id, review_kind)
);

CREATE TABLE IF NOT EXISTS factory_validations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  source_id TEXT NOT NULL,
  validation_kind TEXT NOT NULL,
  status TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, source_id, validation_kind)
);

CREATE TABLE IF NOT EXISTS factory_agent_teams (
  team_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  campaign_id TEXT,
  parent_team_id TEXT,
  domain TEXT NOT NULL,
  objective TEXT NOT NULL,
  team_type TEXT NOT NULL,
  orchestrator_agent_id TEXT,
  prompt_writer_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  worker_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  reviewer_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  specialist_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  memory_scope TEXT NOT NULL,
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  module_locks_json TEXT NOT NULL DEFAULT '[]',
  semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  budgets_json TEXT NOT NULL DEFAULT '{}',
  limits_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_agent_team_edges (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  parent_team_id TEXT NOT NULL,
  child_team_id TEXT NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, parent_team_id, child_team_id)
);

CREATE TABLE IF NOT EXISTS factory_agent_team_assignments (
  assignment_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  assignment_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_agent_team_budgets (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  inherited_from_team_id TEXT,
  budgets_json TEXT NOT NULL DEFAULT '{}',
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(run_id, team_id)
);

CREATE TABLE IF NOT EXISTS factory_team_context_scopes (
  team_context_scope_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  parent_team_id TEXT,
  memory_scope TEXT NOT NULL,
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  module_locks_json TEXT NOT NULL DEFAULT '[]',
  semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  decision_refs_json TEXT NOT NULL DEFAULT '[]',
  failure_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_team_context_items (
  context_item_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT,
  team_id TEXT NOT NULL,
  context_pack_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  inclusion_reason TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  confidence TEXT,
  freshness TEXT NOT NULL,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(context_item_id, context_pack_id, team_id)
);

CREATE TABLE IF NOT EXISTS factory_team_memory_queries (
  query_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  memory_scope TEXT NOT NULL,
  query_type TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  fallback_used INTEGER NOT NULL,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_team_sub_plans (
  sub_plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  parent_team_id TEXT,
  team_domain TEXT NOT NULL,
  team_type TEXT NOT NULL,
  status TEXT NOT NULL,
  generation_mode TEXT NOT NULL,
  confidence REAL NOT NULL,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_team_sub_plan_tasks (
  task_draft_id TEXT NOT NULL,
  sub_plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  role_hint TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  proposed_files_json TEXT NOT NULL DEFAULT '[]',
  allowed_write_paths_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(task_draft_id, sub_plan_id)
);

CREATE TABLE IF NOT EXISTS factory_team_sub_plan_dependencies (
  dependency_id TEXT PRIMARY KEY,
  sub_plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  depends_on_sub_plan_id TEXT,
  depends_on_team_id TEXT,
  dependency_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_team_sub_plan_aggregations (
  aggregation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  teams_planned_json TEXT NOT NULL DEFAULT '[]',
  teams_skipped_json TEXT NOT NULL DEFAULT '[]',
  accepted_sub_plan_ids_json TEXT NOT NULL DEFAULT '[]',
  invalid_sub_plan_ids_json TEXT NOT NULL DEFAULT '[]',
  cross_team_dependencies_json TEXT NOT NULL DEFAULT '[]',
  duplicate_task_groups_json TEXT NOT NULL DEFAULT '[]',
  scope_conflicts_json TEXT NOT NULL DEFAULT '[]',
  top_risks_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_adopted_task_proposals (
  adopted_task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  sub_plan_id TEXT NOT NULL,
  source_task_draft_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  task_type TEXT NOT NULL,
  read_or_write_classification TEXT NOT NULL,
  proposed_role TEXT NOT NULL,
  adoption_status TEXT NOT NULL,
  readiness_status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  read_only_files_json TEXT NOT NULL DEFAULT '[]',
  module_locks_json TEXT NOT NULL DEFAULT '[]',
  semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  validation_refs_json TEXT NOT NULL DEFAULT '[]',
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  stop_conditions_json TEXT NOT NULL DEFAULT '[]',
  prompt_template_ref TEXT,
  context_pack_ref TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  readiness_ref TEXT,
  decision_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_task_adoption_decisions (
  adoption_decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  sub_plan_id TEXT NOT NULL,
  task_draft_id TEXT NOT NULL,
  adopted_task_id TEXT,
  adoption_status TEXT NOT NULL,
  readiness_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  artifact_ref TEXT,
  readiness_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_task_readiness_results (
  readiness_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  sub_plan_id TEXT NOT NULL,
  task_draft_id TEXT NOT NULL,
  adopted_task_id TEXT,
  readiness_status TEXT NOT NULL,
  executable_allowed INTEGER NOT NULL,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  finding_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_proposed_task_graphs (
  graph_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  nodes_ref TEXT,
  edges_ref TEXT,
  validation_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_proposed_task_nodes (
  proposed_node_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  team_id TEXT,
  sub_plan_id TEXT,
  adopted_task_id TEXT,
  source_task_draft_id TEXT,
  parent_proposed_node_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  task_type TEXT NOT NULL,
  read_or_write_classification TEXT NOT NULL,
  proposed_role TEXT NOT NULL,
  status TEXT NOT NULL,
  readiness_status TEXT NOT NULL,
  adoption_status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  non_executable_reason TEXT NOT NULL,
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  read_only_files_json TEXT NOT NULL DEFAULT '[]',
  module_locks_json TEXT NOT NULL DEFAULT '[]',
  semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_proposed_task_edges (
  proposed_edge_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_proposed_task_graph_validations (
  validation_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  valid INTEGER NOT NULL,
  cycle_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  scope_overlap_count INTEGER NOT NULL DEFAULT 0,
  blocked_node_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  cycles_json TEXT NOT NULL DEFAULT '[]',
  duplicate_groups_json TEXT NOT NULL DEFAULT '[]',
  scope_overlaps_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_readiness_decisions (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  team_id TEXT,
  adopted_task_id TEXT,
  task_type TEXT NOT NULL,
  read_or_write_classification TEXT NOT NULL,
  proposed_role TEXT NOT NULL,
  readiness_status TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  passed_requirements_json TEXT NOT NULL DEFAULT '[]',
  failed_requirements_json TEXT NOT NULL DEFAULT '[]',
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  required_human_approval INTEGER NOT NULL DEFAULT 0,
  human_approval_reason TEXT,
  required_locks_json TEXT NOT NULL DEFAULT '[]',
  required_context_refs_json TEXT NOT NULL DEFAULT '[]',
  required_prompt_template_ref TEXT,
  required_validation_strategy_json TEXT NOT NULL DEFAULT '[]',
  required_success_criteria_json TEXT NOT NULL DEFAULT '[]',
  required_review_policy_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL,
  confidence REAL NOT NULL,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_readiness_requirements (
  requirement_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  team_id TEXT,
  requirement_type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  finding_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_approval_requirements (
  approval_requirement_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  team_id TEXT,
  required INTEGER NOT NULL,
  reason TEXT NOT NULL,
  triggers_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_readiness_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  graph_id TEXT,
  node_count INTEGER NOT NULL DEFAULT 0,
  decision_count INTEGER NOT NULL DEFAULT 0,
  approval_requirement_count INTEGER NOT NULL DEFAULT 0,
  ready_read_only_count INTEGER NOT NULL DEFAULT 0,
  future_write_candidate_count INTEGER NOT NULL DEFAULT 0,
  requires_human_approval_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  requires_context_count INTEGER NOT NULL DEFAULT 0,
  requires_validation_count INTEGER NOT NULL DEFAULT 0,
  requires_locks_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_promotion_requests (
  promotion_request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  readiness_decision_id TEXT NOT NULL,
  team_id TEXT,
  adopted_task_id TEXT,
  task_type TEXT NOT NULL,
  read_or_write_classification TEXT NOT NULL,
  proposed_role TEXT NOT NULL,
  requested_promotion_type TEXT NOT NULL,
  readiness_status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 0,
  approval_reason TEXT,
  requested_scope_json TEXT NOT NULL DEFAULT '{}',
  required_locks_json TEXT NOT NULL DEFAULT '[]',
  required_context_refs_json TEXT NOT NULL DEFAULT '[]',
  required_prompt_template_ref TEXT,
  required_validation_strategy_json TEXT NOT NULL DEFAULT '[]',
  required_success_criteria_json TEXT NOT NULL DEFAULT '[]',
  required_review_policy_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_human_approval_records (
  approval_id TEXT PRIMARY KEY,
  promotion_request_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  approver_type TEXT NOT NULL,
  approver_id TEXT,
  decision TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  decision_reason TEXT NOT NULL,
  approved_scope_json TEXT NOT NULL DEFAULT '{}',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_promotion_queue_items (
  queue_item_id TEXT PRIMARY KEY,
  promotion_request_id TEXT NOT NULL,
  approval_id TEXT,
  run_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  queue_status TEXT NOT NULL,
  promotion_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  constraints_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_preparation_plans (
  preparation_plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  promotion_request_id TEXT NOT NULL,
  approval_id TEXT,
  proposed_node_id TEXT NOT NULL,
  team_id TEXT,
  adopted_task_id TEXT,
  status TEXT NOT NULL,
  intended_writer_slot_json TEXT NOT NULL DEFAULT '{}',
  writer_role TEXT NOT NULL,
  task_type TEXT NOT NULL,
  read_or_write_classification TEXT NOT NULL,
  objective TEXT NOT NULL,
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  read_only_files_json TEXT NOT NULL DEFAULT '[]',
  required_file_locks_json TEXT NOT NULL DEFAULT '[]',
  required_module_locks_json TEXT NOT NULL DEFAULT '[]',
  required_semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  context_pack_ref TEXT,
  context_freshness_summary_json TEXT NOT NULL DEFAULT '{}',
  prompt_id TEXT,
  prompt_template_ref TEXT,
  prompt_quality_result_ref TEXT,
  prompt_writer_output_ref TEXT,
  validation_plan_ref TEXT,
  review_policy_ref TEXT,
  integration_preview_ref TEXT,
  rollback_preview_ref TEXT,
  risk_level TEXT NOT NULL,
  human_approval_ref TEXT,
  readiness_decision_ref TEXT,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_preparation_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  plan_count INTEGER NOT NULL DEFAULT 0,
  prepared_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  missing_approval_count INTEGER NOT NULL DEFAULT 0,
  missing_context_count INTEGER NOT NULL DEFAULT 0,
  missing_prompt_count INTEGER NOT NULL DEFAULT 0,
  missing_validation_count INTEGER NOT NULL DEFAULT 0,
  missing_locks_count INTEGER NOT NULL DEFAULT 0,
  stale_context_count INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_preparation_blockers (
  blocker_id TEXT PRIMARY KEY,
  preparation_plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  blocker_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_execution_preparation_warnings (
  warning_id TEXT PRIMARY KEY,
  preparation_plan_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  warning_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_one_writer_dry_run_proposals (
  proposal_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  preparation_plan_id TEXT NOT NULL,
  queue_item_id TEXT NOT NULL,
  promotion_request_id TEXT NOT NULL,
  approval_id TEXT,
  proposed_node_id TEXT NOT NULL,
  team_id TEXT,
  writer_role TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  provider_name TEXT,
  model_name TEXT,
  prompt_id TEXT,
  prompt_quality_result_ref TEXT,
  context_pack_ref TEXT,
  raw_output_ref TEXT,
  parsed_output_ref TEXT,
  patch_artifact_ref TEXT,
  patch_summary TEXT NOT NULL DEFAULT '',
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  allowed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_files_json TEXT NOT NULL DEFAULT '[]',
  scope_check_status TEXT,
  forbidden_file_violations_json TEXT NOT NULL DEFAULT '[]',
  out_of_scope_changes_json TEXT NOT NULL DEFAULT '[]',
  required_locks_preview_json TEXT NOT NULL DEFAULT '[]',
  validation_plan_ref TEXT,
  review_policy_ref TEXT,
  integration_preview_ref TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_proposal_files (
  file_change_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  preparation_plan_id TEXT NOT NULL,
  path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  within_allowed_scope INTEGER NOT NULL DEFAULT 0,
  risk TEXT NOT NULL,
  diff_ref TEXT,
  replacement_snippet_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_proposal_scope_checks (
  scope_check_id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  preparation_plan_id TEXT NOT NULL,
  status TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  forbidden_file_violations_json TEXT NOT NULL DEFAULT '[]',
  out_of_scope_changes_json TEXT NOT NULL DEFAULT '[]',
  finding_count INTEGER NOT NULL DEFAULT 0,
  review_candidate_allowed INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_dry_run_writer_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  proposal_count INTEGER NOT NULL DEFAULT 0,
  generated_count INTEGER NOT NULL DEFAULT 0,
  schema_failed_count INTEGER NOT NULL DEFAULT 0,
  scope_failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  review_candidate_count INTEGER NOT NULL DEFAULT 0,
  changed_files_preview_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_proposal_reviews (
  review_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  preparation_plan_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  reviewer_role TEXT NOT NULL,
  reviewer_mode TEXT NOT NULL,
  provider_name TEXT,
  model_name TEXT,
  prompt_id TEXT,
  prompt_quality_result_ref TEXT,
  raw_review_output_ref TEXT,
  parsed_review_output_ref TEXT,
  review_artifact_ref TEXT,
  decision TEXT NOT NULL,
  status TEXT NOT NULL,
  severity_counts_json TEXT NOT NULL DEFAULT '{}',
  required_changes_json TEXT NOT NULL DEFAULT '[]',
  validation_recommendations_json TEXT NOT NULL DEFAULT '[]',
  integration_risks_json TEXT NOT NULL DEFAULT '[]',
  security_risks_json TEXT NOT NULL DEFAULT '[]',
  performance_risks_json TEXT NOT NULL DEFAULT '[]',
  test_coverage_risks_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_review_findings (
  finding_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  file TEXT,
  suggested_change TEXT,
  blocking INTEGER NOT NULL DEFAULT 0,
  evidence_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_review_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  review_count INTEGER NOT NULL DEFAULT 0,
  accepted_for_validation_candidate_count INTEGER NOT NULL DEFAULT 0,
  changes_requested_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  review_schema_failed_count INTEGER NOT NULL DEFAULT 0,
  critical_findings_count INTEGER NOT NULL DEFAULT 0,
  high_findings_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_validation_candidates (
  validation_candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  preparation_plan_id TEXT NOT NULL,
  proposed_node_id TEXT NOT NULL,
  patch_artifact_ref TEXT,
  review_artifact_ref TEXT,
  validation_plan_ref TEXT,
  required_commands_json TEXT NOT NULL DEFAULT '[]',
  optional_commands_json TEXT NOT NULL DEFAULT '[]',
  expected_validation_outputs_json TEXT NOT NULL DEFAULT '[]',
  strict_validation_semantics_ref TEXT,
  status TEXT NOT NULL,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  validation_plan_artifact_ref TEXT,
  command_preflight_ref TEXT,
  environment_preflight_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_validation_command_preflights (
  command_preflight_id TEXT PRIMARY KEY,
  validation_candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  command TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  safety_status TEXT NOT NULL,
  risk TEXT NOT NULL,
  allowlisted INTEGER NOT NULL DEFAULT 0,
  inventory_present INTEGER NOT NULL DEFAULT 0,
  inventory_match INTEGER NOT NULL DEFAULT 0,
  future_semantics_status TEXT NOT NULL,
  blocked_reason TEXT,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_validation_environment_preflights (
  environment_readiness_id TEXT PRIMARY KEY,
  validation_candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_path_known INTEGER NOT NULL DEFAULT 0,
  command_inventory_available INTEGER NOT NULL DEFAULT 0,
  validation_runner_available INTEGER NOT NULL DEFAULT 0,
  required_artifacts_exist INTEGER NOT NULL DEFAULT 0,
  patch_applied INTEGER NOT NULL DEFAULT 0,
  patch_apply_strategy TEXT NOT NULL,
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_validation_candidate_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  review_ids_json TEXT NOT NULL DEFAULT '[]',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  preflight_passed_count INTEGER NOT NULL DEFAULT 0,
  incomplete_count INTEGER NOT NULL DEFAULT 0,
  command_blocked_count INTEGER NOT NULL DEFAULT 0,
  environment_blocked_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_apply_sandbox_results (
  sandbox_result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  validation_candidate_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  patch_artifact_ref TEXT,
  sandbox_mode TEXT NOT NULL,
  sandbox_path_ref TEXT,
  sandbox_artifact_ref TEXT,
  base_revision_ref TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  dry_apply_status TEXT NOT NULL,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  failed_hunk_count INTEGER NOT NULL DEFAULT 0,
  unsafe_finding_count INTEGER NOT NULL DEFAULT 0,
  main_repo_modified INTEGER NOT NULL DEFAULT 0,
  validation_run INTEGER NOT NULL DEFAULT 0,
  integration_created INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_apply_conflicts (
  conflict_id TEXT PRIMARY KEY,
  sandbox_result_id TEXT NOT NULL,
  validation_candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  path TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_patch_apply_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  validation_candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0,
  dry_apply_passed_count INTEGER NOT NULL DEFAULT 0,
  dry_apply_failed_count INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  failed_hunk_count INTEGER NOT NULL DEFAULT 0,
  sandbox_unavailable_count INTEGER NOT NULL DEFAULT 0,
  unsafe_patch_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  main_repo_integrity_ok INTEGER NOT NULL DEFAULT 1,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_validation_results (
  sandbox_validation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_result_id TEXT NOT NULL,
  validation_candidate_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  patch_artifact_ref TEXT,
  sandbox_ref TEXT,
  commands_json TEXT NOT NULL DEFAULT '[]',
  strict_validation_status TEXT NOT NULL,
  status TEXT NOT NULL,
  required_command_count INTEGER NOT NULL DEFAULT 0,
  optional_command_count INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  timed_out_count INTEGER NOT NULL DEFAULT 0,
  not_run_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  logs_ref TEXT,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_validation_commands (
  command_result_id TEXT PRIMARY KEY,
  sandbox_validation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sandbox_result_id TEXT NOT NULL,
  validation_candidate_id TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  log_ref TEXT,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_validation_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_result_ids_json TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  partial_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_integration_candidates (
  integration_candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  validation_candidate_id TEXT NOT NULL,
  sandbox_result_id TEXT NOT NULL,
  sandbox_validation_id TEXT NOT NULL,
  preparation_plan_id TEXT,
  proposed_node_id TEXT,
  patch_artifact_ref TEXT,
  patch_summary TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  required_file_locks_json TEXT NOT NULL DEFAULT '[]',
  required_module_locks_json TEXT NOT NULL DEFAULT '[]',
  required_semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  review_ref TEXT,
  sandbox_apply_ref TEXT,
  sandbox_validation_ref TEXT,
  strict_validation_status TEXT NOT NULL,
  rollback_requirements_ref TEXT,
  post_integration_validation_plan_ref TEXT,
  risk_level TEXT NOT NULL,
  approval_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  blocker_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_integration_candidate_batches (
  batch_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sandbox_validation_ids_json TEXT NOT NULL DEFAULT '[]',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  candidate_created_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  validation_failed_count INTEGER NOT NULL DEFAULT 0,
  validation_blocked_count INTEGER NOT NULL DEFAULT 0,
  artifact_ref TEXT,
  summary_ref TEXT,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_sandbox_integration_candidate_blockers (
  blocker_id TEXT PRIMARY KEY,
  integration_candidate_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  blocker_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_approval_scope_constraints (
  constraint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  constraint_type TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_integration_candidates (
  candidate_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  patch_ref TEXT,
  change_artifact_ref TEXT,
  review_ref TEXT,
  validation_ref TEXT,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  module_locks_json TEXT NOT NULL DEFAULT '[]',
  semantic_locks_json TEXT NOT NULL DEFAULT '[]',
  dependencies_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_integration_plans (
  integration_plan_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  dependency_order_json TEXT NOT NULL DEFAULT '[]',
  conflict_count INTEGER NOT NULL DEFAULT 0,
  required_locks_json TEXT NOT NULL DEFAULT '[]',
  validation_plan_json TEXT NOT NULL DEFAULT '{}',
  rollback_plan_ref TEXT,
  artifact_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_integration_conflicts (
  conflict_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  conflict_type TEXT NOT NULL,
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  lock_refs_json TEXT NOT NULL DEFAULT '[]',
  severity TEXT NOT NULL,
  reason TEXT NOT NULL,
  artifact_ref TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_integration_results (
  integration_result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_candidates_json TEXT NOT NULL DEFAULT '[]',
  rejected_candidates_json TEXT NOT NULL DEFAULT '[]',
  blocked_candidates_json TEXT NOT NULL DEFAULT '[]',
  conflicts_count INTEGER NOT NULL DEFAULT 0,
  validation_status TEXT NOT NULL,
  validation_refs_json TEXT NOT NULL DEFAULT '[]',
  rollback_refs_json TEXT NOT NULL DEFAULT '[]',
  changed_files_json TEXT NOT NULL DEFAULT '[]',
  artifact_ref TEXT,
  trace_event_id TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  campaign_id TEXT,
  artifact_kind TEXT NOT NULL,
  status TEXT,
  artifact_ref TEXT NOT NULL,
  relative_artifact_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(artifact_ref)
);

CREATE TABLE IF NOT EXISTS factory_trace_events (
  id TEXT PRIMARY KEY,
  trace_event_id TEXT,
  run_id TEXT NOT NULL,
  campaign_id TEXT,
  task_id TEXT,
  parent_task_id TEXT,
  agent_id TEXT,
  team_id TEXT,
  event_type TEXT NOT NULL,
  lifecycle_stage TEXT,
  previous_status TEXT,
  next_status TEXT,
  status TEXT,
  source_component TEXT,
  severity TEXT,
  causal_parent_event_id TEXT,
  causal_chain_id TEXT,
  reason TEXT,
  summary TEXT,
  message TEXT,
  artifact_ref TEXT,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_plan_variants (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT,
  perspective TEXT NOT NULL,
  generation_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_plan_evaluations (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT,
  plan_id TEXT NOT NULL,
  perspective TEXT NOT NULL,
  scores_json TEXT NOT NULL DEFAULT '{}',
  selected INTEGER NOT NULL,
  rejected_reason TEXT,
  confidence REAL NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_merged_plans (
  id TEXT PRIMARY KEY,
  merged_plan_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT,
  generation_mode TEXT NOT NULL,
  selected_plan_ids_json TEXT NOT NULL DEFAULT '[]',
  rejected_plan_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_worker_invocations (
  id TEXT PRIMARY KEY,
  worker_invocation_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT,
  work_item_id TEXT,
  agent_id TEXT,
  agent_role TEXT NOT NULL,
  worker_mode TEXT NOT NULL,
  provider_name TEXT,
  model_name TEXT,
  prompt_id TEXT,
  prompt_quality_result_id TEXT,
  raw_output_ref TEXT,
  parsed_output_ref TEXT,
  output_schema_name TEXT,
  output_schema_status TEXT,
  trace_event_id TEXT,
  status TEXT NOT NULL,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_planning_evidence (
  id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT,
  work_item_id TEXT,
  source_type TEXT NOT NULL,
  source_role TEXT,
  artifact_ref TEXT,
  parsed_output_ref TEXT,
  trace_event_id TEXT,
  confidence TEXT NOT NULL,
  freshness TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_plan_evidence_links (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  plan_id TEXT,
  merged_plan_id TEXT,
  usage_type TEXT NOT NULL,
  influence_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_prompt_writer_outputs (
  id TEXT PRIMARY KEY,
  prompt_writer_output_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  target_agent_role TEXT NOT NULL,
  target_prompt_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider_mode TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  prompt_writer_artifact_ref TEXT,
  candidate_prompt_artifact_ref TEXT,
  candidate_prompt_quality_result_id TEXT,
  output_schema_status TEXT NOT NULL,
  confidence REAL,
  adoption_recommendation TEXT,
  status TEXT NOT NULL,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_prompt_writer_adoption_decisions (
  id TEXT PRIMARY KEY,
  adoption_decision_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  prompt_writer_output_id TEXT,
  candidate_prompt_id TEXT,
  original_prompt_id TEXT,
  mode TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  adopted INTEGER NOT NULL,
  trace_event_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_memory_chunks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT,
  chunk_kind TEXT NOT NULL,
  status TEXT,
  artifact_ref TEXT NOT NULL,
  source_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_context_items (
  id TEXT PRIMARY KEY,
  context_item_id TEXT NOT NULL,
  context_pack_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  agent_role TEXT,
  item_type TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_path TEXT,
  access_mode TEXT NOT NULL,
  inclusion_reason TEXT NOT NULL,
  relevance_score REAL,
  confidence TEXT,
  freshness TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  trace_event_id TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(context_pack_id, context_item_id)
);

CREATE TABLE IF NOT EXISTS factory_locks (
  id TEXT PRIMARY KEY,
  lock_id TEXT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  work_item_id TEXT,
  source_id TEXT NOT NULL,
  lock_type TEXT,
  lock_mode TEXT,
  status TEXT NOT NULL,
  lock_scope TEXT,
  normalized_scope_key TEXT,
  owner_component TEXT,
  reason TEXT,
  conflict_with_lock_id TEXT,
  acquired_at TEXT,
  expires_at TEXT,
  released_at TEXT,
  heartbeat_at TEXT,
  trace_event_id TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_metrics (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  campaign_id TEXT,
  metric_scope TEXT NOT NULL,
  status TEXT,
  generated_at TEXT,
  artifact_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS factory_campaigns (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT,
  original_goal TEXT,
  artifact_ref TEXT NOT NULL,
  final_report_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_factory_tasks_run ON factory_tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_factory_run_transitions_run ON factory_run_transitions(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_tasks_status ON factory_tasks(status);
CREATE INDEX IF NOT EXISTS idx_factory_artifacts_run_task ON factory_artifacts(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_prompts_task ON factory_prompts(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_prompt_quality_prompt ON factory_prompt_quality_results(prompt_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_prompt_quality_task ON factory_prompt_quality_results(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_outputs_task ON factory_outputs(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_reviews_task ON factory_reviews(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_validations_task ON factory_validations(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_agent_teams_run ON factory_agent_teams(run_id, team_type, status);
CREATE INDEX IF NOT EXISTS idx_factory_agent_teams_parent ON factory_agent_teams(run_id, parent_team_id);
CREATE INDEX IF NOT EXISTS idx_factory_agent_team_edges_parent ON factory_agent_team_edges(run_id, parent_team_id);
CREATE INDEX IF NOT EXISTS idx_factory_agent_team_assignments_team ON factory_agent_team_assignments(run_id, team_id, assignment_type);
CREATE INDEX IF NOT EXISTS idx_factory_agent_team_budgets_team ON factory_agent_team_budgets(run_id, team_id);
CREATE INDEX IF NOT EXISTS idx_factory_team_context_scopes_team ON factory_team_context_scopes(run_id, team_id);
CREATE INDEX IF NOT EXISTS idx_factory_team_context_items_team ON factory_team_context_items(run_id, team_id, context_pack_id);
CREATE INDEX IF NOT EXISTS idx_factory_team_memory_queries_team ON factory_team_memory_queries(run_id, team_id, memory_scope);
CREATE INDEX IF NOT EXISTS idx_factory_team_sub_plans_team ON factory_team_sub_plans(run_id, team_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_team_sub_plan_tasks_plan ON factory_team_sub_plan_tasks(run_id, sub_plan_id);
CREATE INDEX IF NOT EXISTS idx_factory_team_sub_plan_dependencies_plan ON factory_team_sub_plan_dependencies(run_id, sub_plan_id, dependency_type);
CREATE INDEX IF NOT EXISTS idx_factory_team_sub_plan_aggregations_run ON factory_team_sub_plan_aggregations(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_adopted_task_proposals_team ON factory_adopted_task_proposals(run_id, team_id, adoption_status);
CREATE INDEX IF NOT EXISTS idx_factory_task_adoption_decisions_run ON factory_task_adoption_decisions(run_id, adoption_status);
CREATE INDEX IF NOT EXISTS idx_factory_task_readiness_results_run ON factory_task_readiness_results(run_id, readiness_status);
CREATE INDEX IF NOT EXISTS idx_factory_proposed_task_graphs_run ON factory_proposed_task_graphs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_proposed_task_nodes_run ON factory_proposed_task_nodes(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_proposed_task_nodes_team ON factory_proposed_task_nodes(team_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_proposed_task_edges_graph ON factory_proposed_task_edges(graph_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_factory_proposed_task_graph_validations_run ON factory_proposed_task_graph_validations(run_id, graph_id);
CREATE INDEX IF NOT EXISTS idx_factory_execution_readiness_decisions_run ON factory_execution_readiness_decisions(run_id, readiness_status);
CREATE INDEX IF NOT EXISTS idx_factory_execution_readiness_decisions_node ON factory_execution_readiness_decisions(proposed_node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_execution_readiness_requirements_run ON factory_execution_readiness_requirements(run_id, requirement_type, status);
CREATE INDEX IF NOT EXISTS idx_factory_execution_approval_requirements_run ON factory_execution_approval_requirements(run_id, required);
CREATE INDEX IF NOT EXISTS idx_factory_execution_readiness_batches_run ON factory_execution_readiness_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_execution_promotion_requests_run ON factory_execution_promotion_requests(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_execution_promotion_requests_node ON factory_execution_promotion_requests(proposed_node_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_human_approval_records_run ON factory_human_approval_records(run_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_factory_promotion_queue_items_run ON factory_promotion_queue_items(run_id, queue_status);
CREATE INDEX IF NOT EXISTS idx_factory_execution_preparation_plans_run ON factory_execution_preparation_plans(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_execution_preparation_plans_queue ON factory_execution_preparation_plans(queue_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_execution_preparation_batches_run ON factory_execution_preparation_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_execution_preparation_blockers_run ON factory_execution_preparation_blockers(run_id, blocker_type);
CREATE INDEX IF NOT EXISTS idx_factory_execution_preparation_warnings_run ON factory_execution_preparation_warnings(run_id, warning_type);
CREATE INDEX IF NOT EXISTS idx_factory_one_writer_dry_run_proposals_run ON factory_one_writer_dry_run_proposals(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_one_writer_dry_run_proposals_preparation ON factory_one_writer_dry_run_proposals(preparation_plan_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_patch_proposal_files_run ON factory_patch_proposal_files(run_id, path);
CREATE INDEX IF NOT EXISTS idx_factory_patch_proposal_scope_checks_run ON factory_patch_proposal_scope_checks(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_dry_run_writer_batches_run ON factory_dry_run_writer_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_patch_proposal_reviews_run ON factory_patch_proposal_reviews(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_patch_proposal_reviews_proposal ON factory_patch_proposal_reviews(proposal_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_patch_review_findings_run ON factory_patch_review_findings(run_id, severity, category);
CREATE INDEX IF NOT EXISTS idx_factory_patch_review_batches_run ON factory_patch_review_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_validation_candidates_run ON factory_validation_candidates(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_validation_candidates_review ON factory_validation_candidates(review_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_validation_command_preflights_run ON factory_validation_command_preflights(run_id, safety_status);
CREATE INDEX IF NOT EXISTS idx_factory_validation_environment_preflights_run ON factory_validation_environment_preflights(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_validation_candidate_batches_run ON factory_validation_candidate_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_patch_apply_sandbox_results_run ON factory_patch_apply_sandbox_results(run_id, dry_apply_status);
CREATE INDEX IF NOT EXISTS idx_factory_patch_apply_sandbox_results_candidate ON factory_patch_apply_sandbox_results(validation_candidate_id, dry_apply_status);
CREATE INDEX IF NOT EXISTS idx_factory_patch_apply_conflicts_run ON factory_patch_apply_conflicts(run_id, conflict_type);
CREATE INDEX IF NOT EXISTS idx_factory_patch_apply_batches_run ON factory_patch_apply_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_validation_results_run ON factory_sandbox_validation_results(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_validation_results_sandbox ON factory_sandbox_validation_results(sandbox_result_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_validation_commands_run ON factory_sandbox_validation_commands(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_validation_batches_run ON factory_sandbox_validation_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_integration_candidates_run ON factory_sandbox_integration_candidates(run_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_integration_candidates_validation ON factory_sandbox_integration_candidates(sandbox_validation_id, status);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_integration_candidate_batches_run ON factory_sandbox_integration_candidate_batches(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_sandbox_integration_candidate_blockers_run ON factory_sandbox_integration_candidate_blockers(run_id, blocker_type);
CREATE INDEX IF NOT EXISTS idx_factory_approval_scope_constraints_run ON factory_approval_scope_constraints(run_id, source_type, status);
CREATE INDEX IF NOT EXISTS idx_factory_integration_candidates_run ON factory_integration_candidates(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_integration_plans_run ON factory_integration_plans(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_integration_conflicts_run ON factory_integration_conflicts(run_id, severity);
CREATE INDEX IF NOT EXISTS idx_factory_integration_results_run ON factory_integration_results(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_trace_events_run ON factory_trace_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_plan_variants_run ON factory_plan_variants(run_id, perspective);
CREATE INDEX IF NOT EXISTS idx_factory_plan_evaluations_run ON factory_plan_evaluations(run_id, selected);
CREATE INDEX IF NOT EXISTS idx_factory_merged_plans_run ON factory_merged_plans(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_factory_worker_invocations_run ON factory_worker_invocations(run_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_factory_worker_invocations_mode ON factory_worker_invocations(worker_mode, status);
CREATE INDEX IF NOT EXISTS idx_factory_planning_evidence_run ON factory_planning_evidence(run_id, source_type);
CREATE INDEX IF NOT EXISTS idx_factory_plan_evidence_links_run ON factory_plan_evidence_links(run_id, evidence_id);
CREATE INDEX IF NOT EXISTS idx_factory_prompt_writer_outputs_run ON factory_prompt_writer_outputs(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_prompt_writer_outputs_status ON factory_prompt_writer_outputs(mode, status);
CREATE INDEX IF NOT EXISTS idx_factory_prompt_writer_adoption_run ON factory_prompt_writer_adoption_decisions(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_context_items_pack ON factory_context_items(context_pack_id);
CREATE INDEX IF NOT EXISTS idx_factory_context_items_task ON factory_context_items(run_id, task_id);
CREATE INDEX IF NOT EXISTS idx_factory_metrics_run ON factory_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_factory_campaigns_status ON factory_campaigns(status);
`;

function jsonMetadata(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function teamIdForContextItem(pack: ContextPack, item: ContextPackInclusionRecord) {
  if (typeof item.metadata_json.team_id === "string" && item.metadata_json.team_id.length) return item.metadata_json.team_id;
  if (String(item.source_type).startsWith("team_")) return pack.team_context?.scope.team_id;
  return undefined;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function extractStatus(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.status === "string") return record.status;
  const result = asRecord(record.result);
  if (result) {
    if (typeof result.status === "string") return result.status;
    if (typeof result.passed === "boolean") return result.passed ? "passed" : "failed";
  }
  if (typeof record.passed === "boolean") return record.passed ? "passed" : "failed";
  return undefined;
}

function extractDecision(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.decision === "string") return record.decision;
  if (typeof record.required === "boolean") return record.required ? "required" : "not_required";
  return extractStatus(value);
}

function extractTaskId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.task_id === "string") return record.task_id;
  if (typeof record.original_task_id === "string") return record.original_task_id;
  const task = asRecord(record.task);
  if (typeof task?.id === "string") return task.id;
  const proposal = asRecord(record.proposal);
  if (typeof proposal?.task_id === "string") return proposal.task_id;
  return undefined;
}

function summarizeValue(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return {};
  const summary: Record<string, unknown> = {
    top_level_keys: Object.keys(record).sort()
  };
  if (Array.isArray(record.runs)) summary.run_count = record.runs.length;
  if (Array.isArray(record.reviews)) summary.review_count = record.reviews.length;
  if (Array.isArray(record.required_changes)) summary.required_change_count = record.required_changes.length;
  if (Array.isArray(record.scope_violations)) summary.scope_violation_count = record.scope_violations.length;
  const result = asRecord(record.result);
  if (result && Array.isArray(result.commands_run)) summary.command_count = result.commands_run.length;
  if (typeof record.status === "string") summary.validation_status = record.status;
  const aggregate = asRecord(record.aggregate) ?? asRecord(result?.aggregate);
  if (aggregate) {
    for (const key of [
      "status",
      "required_command_count",
      "optional_command_count",
      "passed_count",
      "failed_count",
      "blocked_count",
      "skipped_count",
      "timed_out_count",
      "not_run_count",
      "reason"
    ]) {
      if (aggregate[key] !== undefined) summary[`validation_${key}`] = aggregate[key];
    }
  }
  const runs = Array.isArray(record.runs) ? record.runs : Array.isArray(result?.commands_run) ? result.commands_run : undefined;
  if (runs) {
    const counts: Record<string, number> = {};
    let requiredCount = 0;
    let optionalCount = 0;
    for (const run of runs) {
      const command = asRecord(run);
      if (!command) continue;
      const status = typeof command.status === "string" ? command.status : "unknown";
      counts[status] = (counts[status] ?? 0) + 1;
      if (command.required === false) optionalCount += 1;
      else requiredCount += 1;
    }
    summary.command_status_counts = counts;
    summary.required_command_count = requiredCount;
    summary.optional_command_count = optionalCount;
  }
  return summary;
}

function inferTaskIdFromSourceId(sourceId: string) {
  const suffixes = [
    "_verification",
    "_review",
    "_approval_gate",
    "_patch_safety",
    "_repair_limit",
    "_invalid_parsed_output",
    "_repaired_parsed_output",
    "_invalid_patch_proposal",
    "_repaired_patch_proposal",
    "_scout_result",
    "_acquired",
    "_released"
  ];
  for (const suffix of suffixes) {
    if (sourceId.endsWith(suffix)) return sourceId.slice(0, -suffix.length);
  }
  return undefined;
}

function eventStatus(type: string, payload: Record<string, unknown>) {
  if (typeof payload.next_status === "string") return payload.next_status;
  if (typeof payload.status === "string") return payload.status;
  if (type.includes("failed")) return "failed";
  if (type.includes("blocked")) return "blocked";
  if (type.includes("completed") || type.includes("succeeded")) return "succeeded";
  if (type.includes("created") || type.includes("started")) return "active";
  return undefined;
}

function extractLockScopes(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  const direct = [record.path, record.file, record.scope].filter((entry): entry is string => typeof entry === "string");
  const requested = Array.isArray(record.requested_paths) ? record.requested_paths.filter((entry): entry is string => typeof entry === "string") : [];
  return [...direct, ...requested];
}

function lockFromRow(row: Record<string, unknown>): FactoryLock {
  return {
    schema_version: 1,
    lock_id: String(row.lock_id ?? row.id),
    run_id: String(row.run_id ?? ""),
    task_id: stringOrUndefined(row.task_id),
    agent_id: stringOrUndefined(row.agent_id),
    work_item_id: stringOrUndefined(row.work_item_id),
    lock_type: String(row.lock_type ?? "file") as FactoryLock["lock_type"],
    lock_mode: String(row.lock_mode ?? "write") as FactoryLock["lock_mode"],
    lock_scope: String(row.lock_scope ?? ""),
    normalized_scope_key: String(row.normalized_scope_key ?? row.lock_scope ?? ""),
    owner_component: String(row.owner_component ?? row.source_id ?? "unknown"),
    status: String(row.status ?? "failed") as FactoryLock["status"],
    reason: String(row.reason ?? ""),
    conflict_with_lock_id: stringOrUndefined(row.conflict_with_lock_id),
    acquired_at: stringOrUndefined(row.acquired_at),
    expires_at: stringOrUndefined(row.expires_at),
    released_at: stringOrUndefined(row.released_at),
    heartbeat_at: stringOrUndefined(row.heartbeat_at),
    trace_event_id: stringOrUndefined(row.trace_event_id),
    metadata_json: parseJsonRecord(row.metadata_json)
  };
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function plainRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row));
}

function normalizeSqliteBindings(database: SqliteDatabase): SqliteDatabase {
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (...params) => statement.run(...params.map(undefinedToNull)),
        all: (...params) => statement.all(...params.map(undefinedToNull)),
        get: (...params) => statement.get(...params.map(undefinedToNull))
      };
    },
    close: () => database.close()
  };
}

function undefinedToNull(value: unknown) {
  return value === undefined ? null : value;
}
