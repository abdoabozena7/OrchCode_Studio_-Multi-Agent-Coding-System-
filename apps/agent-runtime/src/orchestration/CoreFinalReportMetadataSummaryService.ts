import { existsSync } from "node:fs";
import { FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { parseJsonArray, parseJsonRecord } from "./CoreReportArtifactHelpers.js";

export class CoreFinalReportMetadataSummaryService {
  constructor(
    private readonly workspacePath: string,
    private readonly memoryDir?: string
  ) {}

  async goalStewardReportSummary(runId: string) {
    const empty = {
      goal_steward_used: false,
      goal_alignment_status: undefined as string | undefined,
      goal_conflict_count: 0,
      project_goal_spec_ref: undefined as string | undefined,
      goal_steward_review_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const review = store.get<{
          status?: string;
          spec_ref?: string;
          artifact_ref?: string;
          review_id?: string;
        }>(
          "SELECT review_id, status, spec_ref, artifact_ref FROM factory_goal_steward_reviews WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          runId
        );
        if (!review?.review_id) return empty;
        const findingCount = store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM factory_goal_steward_findings WHERE run_id = ? AND review_id = ? AND severity = 'blocking'",
          runId,
          review.review_id
        )?.count ?? 0;
        return {
          goal_steward_used: true,
          goal_alignment_status: review.status,
          goal_conflict_count: findingCount,
          project_goal_spec_ref: review.spec_ref,
          goal_steward_review_ref: review.artifact_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async teamContextReportSummary(runId: string) {
    const empty = {
      team_context_used: false,
      team_context_scope_count: 0,
      team_memory_queries: 0,
      team_scope_fallbacks: 0,
      team_scope_warnings: 0,
      stale_or_low_confidence_team_context_items: 0
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const scopes = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_context_scopes WHERE run_id = ?", runId)?.count ?? 0;
        const queries = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_memory_queries WHERE run_id = ?", runId)?.count ?? 0;
        const fallbacks = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_memory_queries WHERE run_id = ? AND fallback_used = 1", runId)?.count ?? 0;
        const warningRows = store.all<{ metadata_json: string }>("SELECT metadata_json FROM factory_team_context_scopes WHERE run_id = ?", runId);
        const warningCount = warningRows.reduce((sum, row) => {
          const metadata = parseJsonRecord(row.metadata_json);
          return sum + (Array.isArray(metadata.warnings) ? metadata.warnings.length : 0);
        }, 0);
        const staleLow = store.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM factory_team_context_items WHERE run_id = ? AND (freshness IN ('stale', 'possibly_stale', 'unknown') OR confidence = 'low')",
          runId
        )?.count ?? 0;
        return {
          team_context_used: scopes > 0 || queries > 0,
          team_context_scope_count: Number(scopes),
          team_memory_queries: Number(queries),
          team_scope_fallbacks: Number(fallbacks),
          team_scope_warnings: warningCount,
          stale_or_low_confidence_team_context_items: Number(staleLow)
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async teamSubPlanningReportSummary(runId: string) {
    const empty = {
      team_sub_planning_used: false,
      sub_plan_count: 0,
      invalid_sub_plan_count: 0,
      teams_planned: 0,
      cross_team_dependency_count: 0,
      scope_conflict_count: 0,
      top_team_risks: [] as string[],
      aggregation_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const plans = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plans WHERE run_id = ?", runId)?.count ?? 0;
        const invalid = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_team_sub_plans WHERE run_id = ? AND status IN ('invalid', 'blocked')", runId)?.count ?? 0;
        const aggregation = store.get<{ artifact_ref?: string; cross_team_dependencies_json: string; scope_conflicts_json: string; top_risks_json: string; teams_planned_json: string }>(
          "SELECT artifact_ref, cross_team_dependencies_json, scope_conflicts_json, top_risks_json, teams_planned_json FROM factory_team_sub_plan_aggregations WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          runId
        );
        const dependencies = parseJsonArray(aggregation?.cross_team_dependencies_json);
        const scopeConflicts = parseJsonArray(aggregation?.scope_conflicts_json);
        const topRisks = parseJsonArray(aggregation?.top_risks_json)
          .map((entry) => typeof entry === "object" && entry && "summary" in entry ? String((entry as Record<string, unknown>).summary) : "")
          .filter(Boolean)
          .slice(0, 8);
        const teamsPlanned = parseJsonArray(aggregation?.teams_planned_json).length;
        return {
          team_sub_planning_used: Number(plans) > 0,
          sub_plan_count: Number(plans),
          invalid_sub_plan_count: Number(invalid),
          teams_planned: teamsPlanned,
          cross_team_dependency_count: dependencies.length,
          scope_conflict_count: scopeConflicts.length,
          top_team_risks: topRisks,
          aggregation_ref: aggregation?.artifact_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async teamTaskAdoptionReportSummary(runId: string) {
    const empty = {
      team_task_adoption_used: false,
      drafts_evaluated: 0,
      adopted_metadata_only_count: 0,
      adopted_read_only_count: 0,
      rejected_count: 0,
      duplicate_count: 0,
      blocked_count: 0,
      future_write_candidate_count: 0,
      executable_ready_count: 0,
      adoption_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const decisions = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ?", runId)?.count ?? 0;
        const metadataOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_adopted_task_proposals WHERE run_id = ? AND adoption_status = 'adopted_metadata_only'", runId)?.count ?? 0;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_adopted_task_proposals WHERE run_id = ? AND adoption_status = 'adopted_read_only'", runId)?.count ?? 0;
        const rejected = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND adoption_status IN ('rejected', 'out_of_scope', 'unsafe_write_scope')", runId)?.count ?? 0;
        const duplicate = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND adoption_status = 'duplicate'", runId)?.count ?? 0;
        const blocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_adoption_decisions WHERE run_id = ? AND (adoption_status = 'adopted_blocked' OR adoption_status LIKE 'missing_%')", runId)?.count ?? 0;
        const future = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_readiness_results WHERE run_id = ? AND readiness_status = 'future_write_candidate'", runId)?.count ?? 0;
        const executable = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_task_readiness_results WHERE run_id = ? AND readiness_status = 'executable_ready'", runId)?.count ?? 0;
        const summary = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_artifacts WHERE run_id = ? AND artifact_kind = 'team_task_adoption_summary' ORDER BY created_at DESC LIMIT 1", runId);
        return {
          team_task_adoption_used: Number(decisions) > 0,
          drafts_evaluated: Number(decisions),
          adopted_metadata_only_count: Number(metadataOnly),
          adopted_read_only_count: Number(readOnly),
          rejected_count: Number(rejected),
          duplicate_count: Number(duplicate),
          blocked_count: Number(blocked),
          future_write_candidate_count: Number(future),
          executable_ready_count: Number(executable),
          adoption_summary_ref: summary?.artifact_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async proposedTaskGraphReportSummary(runId: string) {
    const empty = {
      proposed_task_graph_used: false,
      proposed_node_count: 0,
      proposed_edge_count: 0,
      read_only_ready_count: 0,
      future_write_candidate_count: 0,
      blocked_count: 0,
      duplicate_count: 0,
      cycle_count: 0,
      scope_overlap_count: 0,
      graph_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const graph = store.get<{ graph_id: string; node_count: number; edge_count: number; summary_ref?: string }>(
          "SELECT graph_id, node_count, edge_count, summary_ref FROM factory_proposed_task_graphs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
          runId
        );
        if (!graph) return empty;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status = 'read_only_ready'", runId)?.count ?? 0;
        const future = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status IN ('future_write_candidate', 'ready_for_approval_gate')", runId)?.count ?? 0;
        const blocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND (status = 'blocked' OR status LIKE 'needs_%')", runId)?.count ?? 0;
        const duplicate = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_proposed_task_nodes WHERE run_id = ? AND status = 'duplicate'", runId)?.count ?? 0;
        const validation = store.get<{ cycle_count: number; scope_overlap_count: number }>(
          "SELECT cycle_count, scope_overlap_count FROM factory_proposed_task_graph_validations WHERE run_id = ? AND graph_id = ? ORDER BY created_at DESC LIMIT 1",
          runId,
          graph.graph_id
        );
        return {
          proposed_task_graph_used: Number(graph.node_count) > 0,
          proposed_node_count: Number(graph.node_count),
          proposed_edge_count: Number(graph.edge_count),
          read_only_ready_count: Number(readOnly),
          future_write_candidate_count: Number(future),
          blocked_count: Number(blocked),
          duplicate_count: Number(duplicate),
          cycle_count: Number(validation?.cycle_count ?? 0),
          scope_overlap_count: Number(validation?.scope_overlap_count ?? 0),
          graph_summary_ref: graph.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async executionReadinessReportSummary(runId: string) {
    const empty = {
      execution_readiness_used: false,
      nodes_evaluated: 0,
      ready_read_only_count: 0,
      future_write_candidate_count: 0,
      requires_human_approval_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      requires_context_count: 0,
      requires_validation_count: 0,
      requires_locks_count: 0,
      readiness_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          node_count: number;
          ready_read_only_count: number;
          future_write_candidate_count: number;
          requires_human_approval_count: number;
          blocked_count: number;
          rejected_count: number;
          requires_context_count: number;
          requires_validation_count: number;
          requires_locks_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_execution_readiness_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          execution_readiness_used: Number(batch.node_count) > 0,
          nodes_evaluated: Number(batch.node_count),
          ready_read_only_count: Number(batch.ready_read_only_count),
          future_write_candidate_count: Number(batch.future_write_candidate_count),
          requires_human_approval_count: Number(batch.requires_human_approval_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          requires_context_count: Number(batch.requires_context_count),
          requires_validation_count: Number(batch.requires_validation_count),
          requires_locks_count: Number(batch.requires_locks_count),
          readiness_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async approvalPromotionReportSummary(runId: string) {
    const empty = {
      promotion_requests_created: 0,
      approvals_required: 0,
      approvals_granted: 0,
      approvals_denied: 0,
      approvals_expired: 0,
      queue_items_created: 0,
      queue_items_blocked: 0,
      read_only_candidates: 0,
      write_candidates_waiting_approval: 0,
      approval_summary_ref: undefined as string | undefined,
      promotion_queue_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const requests = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ?", runId)?.count ?? 0;
        const approvalsRequired = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND approval_required = 1", runId)?.count ?? 0;
        const approvalsGranted = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'approved'", runId)?.count ?? 0;
        const approvalsDenied = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'denied'", runId)?.count ?? 0;
        const approvalsExpired = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_human_approval_records WHERE run_id = ? AND approval_status = 'expired'", runId)?.count ?? 0;
        const queueItems = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ?", runId)?.count ?? 0;
        const queueBlocked = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND queue_status = 'blocked'", runId)?.count ?? 0;
        const readOnly = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_promotion_queue_items WHERE run_id = ? AND promotion_type = 'read_only_candidate'", runId)?.count ?? 0;
        const writeWaiting = store.get<{ count: number }>("SELECT COUNT(*) AS count FROM factory_execution_promotion_requests WHERE run_id = ? AND read_or_write_classification <> 'read_only' AND status = 'awaiting_human_approval'", runId)?.count ?? 0;
        const summary = store.get<{ artifact_ref?: string }>("SELECT artifact_ref FROM factory_artifacts WHERE run_id = ? AND artifact_kind = 'promotion_queue_summary' ORDER BY created_at DESC LIMIT 1", runId);
        const batch = summary ? undefined : store.get<{ metadata_json: string }>("SELECT metadata_json FROM factory_execution_readiness_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        const batchMetadata = parseJsonRecord(batch?.metadata_json);
        const summaryRef = summary?.artifact_ref ?? (typeof batchMetadata.promotion_queue_summary_ref === "string" ? batchMetadata.promotion_queue_summary_ref : undefined);
        return {
          promotion_requests_created: Number(requests),
          approvals_required: Number(approvalsRequired),
          approvals_granted: Number(approvalsGranted),
          approvals_denied: Number(approvalsDenied),
          approvals_expired: Number(approvalsExpired),
          queue_items_created: Number(queueItems),
          queue_items_blocked: Number(queueBlocked),
          read_only_candidates: Number(readOnly),
          write_candidates_waiting_approval: Number(writeWaiting),
          approval_summary_ref: summaryRef,
          promotion_queue_summary_ref: summaryRef
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async executionPreparationReportSummary(runId: string) {
    const empty = {
      execution_preparation_used: false,
      preparation_plan_count: 0,
      prepared_count: 0,
      blocked_count: 0,
      missing_approval_count: 0,
      missing_context_count: 0,
      missing_prompt_count: 0,
      missing_validation_count: 0,
      missing_locks_count: 0,
      stale_context_count: 0,
      preparation_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          plan_count: number;
          prepared_count: number;
          blocked_count: number;
          missing_approval_count: number;
          missing_context_count: number;
          missing_prompt_count: number;
          missing_validation_count: number;
          missing_locks_count: number;
          stale_context_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_execution_preparation_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          execution_preparation_used: Number(batch.plan_count) > 0,
          preparation_plan_count: Number(batch.plan_count),
          prepared_count: Number(batch.prepared_count),
          blocked_count: Number(batch.blocked_count),
          missing_approval_count: Number(batch.missing_approval_count),
          missing_context_count: Number(batch.missing_context_count),
          missing_prompt_count: Number(batch.missing_prompt_count),
          missing_validation_count: Number(batch.missing_validation_count),
          missing_locks_count: Number(batch.missing_locks_count),
          stale_context_count: Number(batch.stale_context_count),
          preparation_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async oneWriterDryRunReportSummary(runId: string) {
    const empty = {
      one_writer_dry_run_used: false,
      dry_run_proposal_count: 0,
      generated_count: 0,
      schema_failed_count: 0,
      scope_failed_count: 0,
      blocked_count: 0,
      review_candidate_count: 0,
      changed_files_preview: [] as string[],
      dry_run_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          proposal_count: number;
          generated_count: number;
          schema_failed_count: number;
          scope_failed_count: number;
          blocked_count: number;
          review_candidate_count: number;
          changed_files_preview_json: string;
          summary_ref?: string;
        }>("SELECT * FROM factory_dry_run_writer_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          one_writer_dry_run_used: Number(batch.proposal_count) > 0,
          dry_run_proposal_count: Number(batch.proposal_count),
          generated_count: Number(batch.generated_count),
          schema_failed_count: Number(batch.schema_failed_count),
          scope_failed_count: Number(batch.scope_failed_count),
          blocked_count: Number(batch.blocked_count),
          review_candidate_count: Number(batch.review_candidate_count),
          changed_files_preview: parseJsonArray(batch.changed_files_preview_json).map(String),
          dry_run_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async patchProposalReviewReportSummary(runId: string) {
    const empty = {
      patch_review_used: false,
      patch_reviews_count: 0,
      accepted_for_validation_candidate_count: 0,
      changes_requested_count: 0,
      rejected_count: 0,
      blocked_count: 0,
      review_schema_failed_count: 0,
      critical_findings_count: 0,
      high_findings_count: 0,
      review_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          review_count: number;
          accepted_for_validation_candidate_count: number;
          changes_requested_count: number;
          rejected_count: number;
          blocked_count: number;
          review_schema_failed_count: number;
          critical_findings_count: number;
          high_findings_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_patch_review_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          patch_review_used: Number(batch.review_count) > 0,
          patch_reviews_count: Number(batch.review_count),
          accepted_for_validation_candidate_count: Number(batch.accepted_for_validation_candidate_count),
          changes_requested_count: Number(batch.changes_requested_count),
          rejected_count: Number(batch.rejected_count),
          blocked_count: Number(batch.blocked_count),
          review_schema_failed_count: Number(batch.review_schema_failed_count),
          critical_findings_count: Number(batch.critical_findings_count),
          high_findings_count: Number(batch.high_findings_count),
          review_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async validationCandidateReportSummary(runId: string) {
    const empty = {
      validation_candidate_used: false,
      validation_candidate_count: 0,
      preflight_passed_count: 0,
      incomplete_count: 0,
      command_blocked_count: 0,
      environment_blocked_count: 0,
      rejected_count: 0,
      validation_candidate_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          candidate_count: number;
          preflight_passed_count: number;
          incomplete_count: number;
          command_blocked_count: number;
          environment_blocked_count: number;
          rejected_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_validation_candidate_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          validation_candidate_used: Number(batch.candidate_count) > 0,
          validation_candidate_count: Number(batch.candidate_count),
          preflight_passed_count: Number(batch.preflight_passed_count),
          incomplete_count: Number(batch.incomplete_count),
          command_blocked_count: Number(batch.command_blocked_count),
          environment_blocked_count: Number(batch.environment_blocked_count),
          rejected_count: Number(batch.rejected_count),
          validation_candidate_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async patchApplySandboxReportSummary(runId: string) {
    const empty = {
      patch_apply_sandbox_used: false,
      sandbox_result_count: 0,
      dry_apply_passed_count: 0,
      dry_apply_failed_count: 0,
      conflict_count: 0,
      failed_hunk_count: 0,
      sandbox_unavailable_count: 0,
      main_repo_integrity_ok: true,
      sandbox_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          result_count: number;
          dry_apply_passed_count: number;
          dry_apply_failed_count: number;
          conflict_count: number;
          failed_hunk_count: number;
          sandbox_unavailable_count: number;
          main_repo_integrity_ok: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_patch_apply_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          patch_apply_sandbox_used: Number(batch.result_count) > 0,
          sandbox_result_count: Number(batch.result_count),
          dry_apply_passed_count: Number(batch.dry_apply_passed_count),
          dry_apply_failed_count: Number(batch.dry_apply_failed_count),
          conflict_count: Number(batch.conflict_count),
          failed_hunk_count: Number(batch.failed_hunk_count),
          sandbox_unavailable_count: Number(batch.sandbox_unavailable_count),
          main_repo_integrity_ok: Number(batch.main_repo_integrity_ok) === 1,
          sandbox_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async sandboxValidationReportSummary(runId: string) {
    const empty = {
      sandbox_validation_used: false,
      sandbox_validation_count: 0,
      sandbox_validation_passed_count: 0,
      sandbox_validation_failed_count: 0,
      sandbox_validation_blocked_count: 0,
      sandbox_validation_partial_count: 0,
      sandbox_validation_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          result_count: number;
          passed_count: number;
          failed_count: number;
          blocked_count: number;
          partial_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_sandbox_validation_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          sandbox_validation_used: Number(batch.result_count) > 0,
          sandbox_validation_count: Number(batch.result_count),
          sandbox_validation_passed_count: Number(batch.passed_count),
          sandbox_validation_failed_count: Number(batch.failed_count),
          sandbox_validation_blocked_count: Number(batch.blocked_count),
          sandbox_validation_partial_count: Number(batch.partial_count),
          sandbox_validation_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async sandboxIntegrationCandidateReportSummary(runId: string) {
    const empty = {
      sandbox_integration_candidate_used: false,
      integration_candidate_count: 0,
      candidate_created_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      validation_failed_count: 0,
      validation_blocked_count: 0,
      candidate_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          candidate_count: number;
          candidate_created_count: number;
          blocked_count: number;
          rejected_count: number;
          validation_failed_count: number;
          validation_blocked_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_sandbox_integration_candidate_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          sandbox_integration_candidate_used: Number(batch.candidate_count) > 0,
          integration_candidate_count: Number(batch.candidate_count),
          candidate_created_count: Number(batch.candidate_created_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          validation_failed_count: Number(batch.validation_failed_count),
          validation_blocked_count: Number(batch.validation_blocked_count),
          candidate_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async integrationApplyApprovalReportSummary(runId: string) {
    const empty = {
      integration_apply_approval_used: false,
      apply_approval_count: 0,
      approved_for_apply_candidate_count: 0,
      requires_human_approval_count: 0,
      blocked_count: 0,
      rejected_count: 0,
      dirty_worktree_blocked_count: 0,
      apply_mode_recommendation_count: 0,
      apply_approval_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          approval_count: number;
          approved_for_apply_candidate_count: number;
          requires_human_approval_count: number;
          blocked_count: number;
          rejected_count: number;
          dirty_worktree_blocked_count: number;
          apply_mode_recommendation_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_integration_apply_approval_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          integration_apply_approval_used: Number(batch.approval_count) > 0,
          apply_approval_count: Number(batch.approval_count),
          approved_for_apply_candidate_count: Number(batch.approved_for_apply_candidate_count),
          requires_human_approval_count: Number(batch.requires_human_approval_count),
          blocked_count: Number(batch.blocked_count),
          rejected_count: Number(batch.rejected_count),
          dirty_worktree_blocked_count: Number(batch.dirty_worktree_blocked_count),
          apply_mode_recommendation_count: Number(batch.apply_mode_recommendation_count),
          apply_approval_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async controlledApplyReportSummary(runId: string) {
    const empty = {
      controlled_apply_used: false,
      controlled_apply_count: 0,
      applied_count: 0,
      post_validation_passed_count: 0,
      post_validation_failed_count: 0,
      rolled_back_count: 0,
      rollback_failed_count: 0,
      lock_failed_count: 0,
      blocked_count: 0,
      controlled_apply_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          controlled_apply_count: number;
          applied_count: number;
          post_validation_passed_count: number;
          post_validation_failed_count: number;
          rolled_back_count: number;
          rollback_failed_count: number;
          lock_failed_count: number;
          blocked_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_controlled_apply_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          controlled_apply_used: Number(batch.controlled_apply_count) > 0,
          controlled_apply_count: Number(batch.controlled_apply_count),
          applied_count: Number(batch.applied_count),
          post_validation_passed_count: Number(batch.post_validation_passed_count),
          post_validation_failed_count: Number(batch.post_validation_failed_count),
          rolled_back_count: Number(batch.rolled_back_count),
          rollback_failed_count: Number(batch.rollback_failed_count),
          lock_failed_count: Number(batch.lock_failed_count),
          blocked_count: Number(batch.blocked_count),
          controlled_apply_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }

  async integrationFinalizationReportSummary(runId: string) {
    const empty = {
      integration_finalization_used: false,
      integration_finalization_count: 0,
      finalized_count: 0,
      validation_failed_count: 0,
      rollback_completed_count: 0,
      rollback_failed_count: 0,
      memory_entries_created_count: 0,
      lessons_created_count: 0,
      finalization_summary_ref: undefined as string | undefined
    };
    try {
      if (!existsSync(await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir))) return empty;
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        const batch = store.get<{
          integration_finalization_count: number;
          finalized_count: number;
          validation_failed_count: number;
          rollback_completed_count: number;
          rollback_failed_count: number;
          memory_entries_created_count: number;
          lessons_created_count: number;
          summary_ref?: string;
        }>("SELECT * FROM factory_integration_finalization_batches WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", runId);
        if (!batch) return empty;
        return {
          integration_finalization_used: Number(batch.integration_finalization_count) > 0,
          integration_finalization_count: Number(batch.integration_finalization_count),
          finalized_count: Number(batch.finalized_count),
          validation_failed_count: Number(batch.validation_failed_count),
          rollback_completed_count: Number(batch.rollback_completed_count),
          rollback_failed_count: Number(batch.rollback_failed_count),
          memory_entries_created_count: Number(batch.memory_entries_created_count),
          lessons_created_count: Number(batch.lessons_created_count),
          finalization_summary_ref: batch.summary_ref
        };
      } finally {
        store.close();
      }
    } catch {
      return empty;
    }
  }
}
