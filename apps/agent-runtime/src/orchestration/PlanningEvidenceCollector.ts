import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type {
  MultiPlanGenerationMode,
  MultiPlanInput,
  PlanningEvidenceBundle,
  PlanningEvidenceConfidence,
  PlanningEvidenceConflict,
  PlanningEvidenceItem,
  PlanningEvidenceSourceType
} from "./MultiPlanModels.js";
import type { AgentTeam, TeamContextScope, TeamContextEvidenceLink } from "./AgentTeamModels.js";
import { schemaForReadOnlySwarmRole, validateReadOnlySwarmOutput } from "./ReadOnlySwarmWorkerSchemas.js";

type WorkerInvocationRow = {
  worker_invocation_id: string;
  run_id: string;
  task_id?: string | null;
  work_item_id?: string | null;
  agent_role: string;
  worker_mode: string;
  provider_name?: string | null;
  model_name?: string | null;
  raw_output_ref?: string | null;
  parsed_output_ref?: string | null;
  output_schema_name?: string | null;
  output_schema_status?: string | null;
  trace_event_id?: string | null;
  status: string;
  created_at: string;
  completed_at?: string | null;
  metadata_json?: string;
};

export class PlanningEvidenceCollector {
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;

  constructor(private readonly workspacePath: string, private readonly memoryDir?: string) {
    this.artifactStore = new OrchestrationArtifactStore(workspacePath, memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath, memoryDir, sourceComponent: "PlanningEvidenceCollector" });
  }

  async collect(input: MultiPlanInput): Promise<PlanningEvidenceBundle> {
    const started = await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "planning_evidence_collection_started",
      lifecycle_stage: "planning",
      summary: "Planning evidence collection started.",
      metadata_json: {
        run_id: input.run.id,
        task_id: input.taskId,
        mode: input.config?.planning_evidence_mode ?? "available"
      }
    });

    const rows = await this.loadWorkerInvocationRows(input);
    const items: PlanningEvidenceItem[] = [];
    const rejected: PlanningEvidenceBundle["rejected_items"] = [];
    const seen = new Set<string>();
    const maxItems = input.config?.max_evidence_items ?? 20;
    const minConfidence = input.config?.min_evidence_confidence ?? 0.2;
    const allowMock = input.config?.allow_mock_evidence ?? false;

    for (const row of rows) {
      if (items.length >= maxItems) break;
      const result = await this.itemFromWorkerRow(input, row, { minConfidence, allowMock });
      if (!result.ok) {
        rejected.push({
          source_ref: row.worker_invocation_id,
          source_role: row.agent_role,
          reason: result.reason,
          artifact_ref: row.parsed_output_ref ?? undefined
        });
        await this.traceWriter.write({
          run_id: input.run.id,
          task_id: input.taskId ?? row.task_id ?? undefined,
          event_type: "planning_evidence_item_rejected",
          lifecycle_stage: "planning",
          causal_parent_event_id: started.trace_event_id,
          severity: "warning",
          reason: result.reason,
          summary: `Planning evidence rejected from ${row.agent_role}.`,
          artifact_refs: row.parsed_output_ref ? [row.parsed_output_ref] : [],
          metadata_json: {
            run_id: input.run.id,
            work_item_id: row.work_item_id,
            source_role: row.agent_role,
            output_schema_status: row.output_schema_status,
            rejection_reason: result.reason
          }
        });
        continue;
      }
      const key = `${result.item.source_type}:${result.item.parsed_output_ref ?? result.item.artifact_ref}:${result.item.summary}`;
      if (seen.has(key)) {
        rejected.push({
          source_ref: row.worker_invocation_id,
          source_role: row.agent_role,
          reason: "Duplicate evidence item.",
          artifact_ref: row.parsed_output_ref ?? undefined
        });
        continue;
      }
      seen.add(key);
      items.push(result.item);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId ?? result.item.task_id,
        event_type: "planning_evidence_item_collected",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        summary: `Planning evidence collected from ${result.item.source_type}.`,
        artifact_refs: result.item.parsed_output_ref ? [result.item.parsed_output_ref] : [],
        metadata_json: evidenceTraceMetadata(result.item)
      });
    }

    for (const item of deterministicEvidenceItems(input).slice(0, Math.max(0, maxItems - items.length))) {
      items.push(item);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId ?? item.task_id,
        event_type: "planning_evidence_item_collected",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        summary: `Planning evidence collected from ${item.source_type}.`,
        artifact_refs: item.artifact_ref ? [item.artifact_ref] : [],
        metadata_json: evidenceTraceMetadata(item)
      });
    }

    const conflicts = detectConflicts(items);
    for (const conflict of conflicts) {
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: "planning_evidence_conflict_detected",
        lifecycle_stage: "planning",
        severity: conflict.severity === "critical" || conflict.severity === "high" ? "warning" : "info",
        summary: conflict.summary,
        reason: conflict.resolution,
        metadata_json: {
          run_id: input.run.id,
          evidence_ids: conflict.evidence_ids,
          severity: conflict.severity
        }
      });
    }

    if (!items.length) {
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.taskId,
        event_type: "planning_evidence_unavailable",
        lifecycle_stage: "planning",
        causal_parent_event_id: started.trace_event_id,
        severity: "warning",
        reason: rows.length ? "No valid planning evidence survived validation." : "No provider-backed read-only worker outputs were available.",
        summary: "Planning evidence unavailable; deterministic or heuristic planning remains the fallback.",
        metadata_json: {
          run_id: input.run.id,
          task_id: input.taskId,
          candidate_count: rows.length,
          rejected_count: rejected.length
        }
      });
    }

    const bundle: PlanningEvidenceBundle = {
      evidence_bundle_id: `evidence_bundle_${randomUUID().slice(0, 12)}`,
      run_id: input.run.id,
      task_id: input.taskId,
      generation_mode: evidenceGenerationMode(items, input),
      items,
      rejected_items: rejected,
      conflicts,
      summary: summarizeEvidence(items, rejected.length, conflicts.length),
      limitations: evidenceLimitations(items, rejected.length, input),
      created_at: new Date().toISOString()
    };
    const persisted = await this.artifactStore.savePlanningEvidenceBundle(bundle);
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.taskId,
      event_type: "planning_evidence_bundle_created",
      lifecycle_stage: "planning",
      causal_parent_event_id: started.trace_event_id,
      summary: `Planning evidence bundle created with ${persisted.items.length} item(s).`,
      artifact_refs: [persisted.artifact_ref, persisted.summary_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        run_id: input.run.id,
        evidence_bundle_id: persisted.evidence_bundle_id,
        evidence_item_count: persisted.items.length,
        rejected_evidence_count: persisted.rejected_items.length,
        confidence: average(persisted.items.map((item) => item.confidence_score)),
        artifact_ref: persisted.artifact_ref
      }
    });
    return persisted;
  }

  private async loadWorkerInvocationRows(input: MultiPlanInput): Promise<WorkerInvocationRow[]> {
    try {
      const metadata = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
      try {
        return metadata.all<WorkerInvocationRow>(
          `SELECT worker_invocation_id, run_id, task_id, work_item_id, agent_role,
             worker_mode, provider_name, model_name, raw_output_ref, parsed_output_ref,
             output_schema_name, output_schema_status, trace_event_id, status,
             created_at, completed_at, metadata_json
           FROM factory_worker_invocations
           WHERE run_id = ?
           ORDER BY created_at`,
          input.run.id
        );
      } finally {
        metadata.close();
      }
    } catch {
      return [];
    }
  }

  private async itemFromWorkerRow(
    input: MultiPlanInput,
    row: WorkerInvocationRow,
    options: { minConfidence: number; allowMock: boolean }
  ): Promise<{ ok: true; item: PlanningEvidenceItem } | { ok: false; reason: string }> {
    if (row.status !== "succeeded") return { ok: false, reason: `Worker invocation status is ${row.status}.` };
    if (row.output_schema_status !== "passed") return { ok: false, reason: `Output schema status is ${row.output_schema_status ?? "missing"}.` };
    if (row.worker_mode === "mock" && !options.allowMock) return { ok: false, reason: "Mock worker evidence is disabled by config." };
    if (!row.parsed_output_ref) return { ok: false, reason: "Missing parsed output artifact ref." };
    if (!existsSync(row.parsed_output_ref)) return { ok: false, reason: "Parsed output artifact does not exist." };
    const parsed = JSON.parse(await readFile(row.parsed_output_ref, "utf8")) as unknown;
    const schema = row.output_schema_name
      ? { name: row.output_schema_name }
      : schemaForReadOnlySwarmRole(row.agent_role, workItemTypeFromSchema(row.output_schema_name));
    const validation = validateReadOnlySwarmOutput(parsed, schema);
    if (!validation.valid) return { ok: false, reason: `Parsed output failed evidence validation: ${validation.errors.join("; ")}` };
    const extracted = extractEvidence(parsed, row);
    if (extracted.confidence_score < options.minConfidence) return { ok: false, reason: `Evidence confidence ${extracted.confidence_score} is below configured minimum.` };
    return {
      ok: true,
      item: {
        evidence_id: `evidence_${randomUUID().slice(0, 12)}`,
        run_id: input.run.id,
        task_id: row.task_id ?? input.taskId,
        work_item_id: row.work_item_id ?? undefined,
        source_type: sourceTypeFor(row),
        source_role: row.agent_role,
        artifact_ref: row.raw_output_ref ?? undefined,
        parsed_output_ref: row.parsed_output_ref,
        trace_event_id: row.trace_event_id ?? undefined,
        confidence: confidenceBucket(extracted.confidence_score),
        confidence_score: extracted.confidence_score,
        freshness: freshnessFor(row.completed_at ?? row.created_at),
        summary: extracted.summary,
        extracted_findings: extracted.findings,
        extracted_risks: extracted.risks,
        extracted_tasks: extracted.tasks,
        extracted_validation_recommendations: extracted.validation,
        extracted_dependencies: extracted.dependencies,
        metadata_json: {
          worker_invocation_id: row.worker_invocation_id,
          worker_mode: row.worker_mode,
          provider_name: row.provider_name,
          model_name: row.model_name,
          output_schema_name: row.output_schema_name
        }
      }
    };
  }
}

function sourceTypeFor(row: WorkerInvocationRow): PlanningEvidenceSourceType {
  if (row.worker_mode === "mock") return "mock_worker_output";
  if (row.agent_role === "ScoutAgent") return "provider_scout_output";
  if (row.agent_role === "PlannerAgent" || row.agent_role === "ArchitectAgent") return "provider_planner_output";
  if (row.agent_role === "RiskAnalyzerAgent") return "provider_risk_analyst_output";
  if (row.agent_role === "ReviewerAgent" || /Reviewer/i.test(row.agent_role)) return "provider_reviewer_output";
  if (row.agent_role === "TesterAgent") return "provider_tester_planner_output";
  if (row.agent_role === "ReporterAgent") return "provider_reporter_output";
  return "provider_specialist_output";
}

function deterministicEvidenceItems(input: MultiPlanInput): PlanningEvidenceItem[] {
  const items: PlanningEvidenceItem[] = [];
  if (input.repoIndex) {
    items.push({
      evidence_id: `evidence_repo_index_${randomUUID().slice(0, 8)}`,
      run_id: input.run.id,
      task_id: input.taskId,
      source_type: "repo_index",
      source_role: "ProjectMemory",
      artifact_ref: input.run.memory_snapshot_ref,
      confidence: "medium",
      confidence_score: 0.62,
      freshness: "unknown",
      summary: `Repo index exposes ${input.repoIndex.totals.indexedFiles} indexed file(s) and ${input.repoIndex.entrypoints.length} entrypoint(s).`,
      extracted_findings: [
        `Important files: ${input.repoIndex.importantFiles.slice(0, 5).join(", ") || "none recorded"}`,
        `Entrypoints: ${input.repoIndex.entrypoints.slice(0, 5).join(", ") || "none recorded"}`
      ],
      extracted_risks: input.repoIndex.dependencyFiles.some((file) => /package-lock|lock/i.test(file))
        ? ["Dependency lock files are present and should be treated as risky touch points."]
        : [],
      extracted_tasks: [],
      extracted_validation_recommendations: [],
      extracted_dependencies: uniqueStrings([
        ...input.repoIndex.importantFiles,
        ...input.repoIndex.entrypoints,
        ...input.repoIndex.configFiles
      ]).slice(0, 10),
      metadata_json: {
        indexed_files: input.repoIndex.totals.indexedFiles,
        source_files: input.repoIndex.totals.sourceFiles,
        test_files: input.repoIndex.totals.testFiles
      }
    });
  }
  if (input.contextPack) {
    items.push({
      evidence_id: `evidence_context_pack_${randomUUID().slice(0, 8)}`,
      run_id: input.run.id,
      task_id: input.contextPack.task_id ?? input.taskId,
      source_type: "context_pack",
      source_role: "ContextPackBuilder",
      artifact_ref: input.contextPack.id,
      confidence: input.contextPack.warnings.length ? "medium" : "high",
      confidence_score: input.contextPack.warnings.length ? 0.58 : 0.78,
      freshness: input.contextPack.freshness_warnings?.length ? "possibly_stale" : "unknown",
      summary: `Context pack includes ${input.contextPack.relevant_files.length} relevant file(s).`,
      extracted_findings: input.contextPack.included_items?.map((item) => `${item.item_type}: ${item.inclusion_reason}`).slice(0, 8) ?? [],
      extracted_risks: input.contextPack.warnings,
      extracted_tasks: [],
      extracted_validation_recommendations: [],
      extracted_dependencies: input.contextPack.relevant_files,
      metadata_json: {
        context_pack_id: input.contextPack.id,
        included_item_count: input.contextPack.included_items?.length ?? 0,
        warning_count: input.contextPack.warnings.length
      }
    });
  }
  if (input.commandInventory) {
    const commands = uniqueStrings([
      ...input.commandInventory.byKind.test,
      ...input.commandInventory.byKind.typecheck,
      ...input.commandInventory.byKind.lint,
      ...input.commandInventory.byKind.build,
      ...input.commandInventory.byKind.smoke
    ]);
    if (commands.length) {
      items.push({
        evidence_id: `evidence_validation_history_${randomUUID().slice(0, 8)}`,
        run_id: input.run.id,
        task_id: input.taskId,
        source_type: "validation_history",
        source_role: "CommandInventory",
        confidence: "medium",
        confidence_score: 0.64,
        freshness: "unknown",
        summary: `Command inventory offers ${commands.length} validation command(s).`,
        extracted_findings: [],
        extracted_risks: [],
        extracted_tasks: [],
        extracted_validation_recommendations: commands.slice(0, 8),
        extracted_dependencies: [],
        metadata_json: {
          command_count: commands.length
        }
      });
    }
  }
  return items;
}

function workItemTypeFromSchema(schemaName?: string | null) {
  if (schemaName === "swarm_scout_output") return "scout";
  if (schemaName === "swarm_planner_output") return "plan";
  if (schemaName === "swarm_risk_analyst_output") return "risk_analysis";
  if (schemaName === "swarm_tester_planner_output") return "test";
  if (schemaName === "swarm_reporter_output") return "summarize";
  if (schemaName === "swarm_reviewer_output") return "review";
  return "review";
}

function extractEvidence(value: unknown, row: WorkerInvocationRow) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    summary: stringValue(record.summary) ?? stringValue(record.plan_summary) ?? stringArray(record.findings)[0] ?? `${row.agent_role} evidence`,
    findings: uniqueStrings([
      ...stringArray(record.findings),
      ...stringArray(record.recommendations),
      ...stringArray(record.suggested_next_steps)
    ]),
    risks: uniqueStrings([
      ...stringArray(record.risks),
      ...stringArray(record.blockers),
      ...stringArray(record.unresolved_risks),
      ...stringArray(record.blocked_or_missing_validation)
    ]),
    tasks: uniqueStrings([
      ...stringArray(record.task_drafts),
      ...stringArray(record.next_steps),
      ...stringArray(record.suggested_next_steps)
    ]),
    validation: uniqueStrings([
      ...stringArray(record.validation_strategy),
      ...stringArray(record.recommended_validation),
      ...stringArray(record.required_commands),
      ...stringArray(record.optional_commands),
      ...stringArray(record.smoke_checks),
      ...stringArray(record.validation_recommendations)
    ]),
    dependencies: uniqueStrings([
      ...stringArray(record.dependencies),
      ...stringArray(record.impacted_files_or_modules),
      ...stringArray(record.relevant_files),
      ...stringArray(record.evidence_refs)
    ]),
    confidence_score: typeof record.confidence === "number" ? round(record.confidence) : 0.45
  };
}

function detectConflicts(items: PlanningEvidenceItem[]): PlanningEvidenceConflict[] {
  const highRisk = items.find((item) => item.extracted_risks.some((risk) => /critical|high|block|unsafe|approval/i.test(risk)));
  const acceptingReview = items.find((item) => item.source_type === "provider_reviewer_output" && /accept/i.test(item.summary) && item.extracted_risks.length === 0);
  if (!highRisk || !acceptingReview) return [];
  return [{
    conflict_id: `evidence_conflict_${randomUUID().slice(0, 8)}`,
    evidence_ids: [highRisk.evidence_id, acceptingReview.evidence_id],
    summary: "Reviewer evidence appears more optimistic than high-risk evidence.",
    severity: "medium",
    resolution: "Preserve both refs and let risk-first planning remain conservative."
  }];
}

function summarizeEvidence(items: PlanningEvidenceItem[], rejectedCount: number, conflictCount: number) {
  return {
    evidence_used: items.length > 0,
    evidence_item_count: items.length,
    provider_evidence_count: items.filter((item) => item.source_type.startsWith("provider_")).length,
    mock_evidence_count: items.filter((item) => item.source_type === "mock_worker_output").length,
    low_confidence_count: items.filter((item) => item.confidence === "low").length,
    rejected_evidence_count: rejectedCount,
    evidence_conflict_count: conflictCount,
    top_evidence_sources: uniqueStrings(items.map((item) => item.source_type)).slice(0, 6) as PlanningEvidenceSourceType[],
    limitations: []
  };
}

function evidenceLimitations(items: PlanningEvidenceItem[], rejectedCount: number, input: MultiPlanInput) {
  const limitations: string[] = [];
  if (!items.length) limitations.push("No valid provider-backed read-only swarm evidence was available; planning uses deterministic or heuristic fallback signals.");
  if (rejectedCount) limitations.push(`${rejectedCount} evidence candidate(s) were rejected due to missing refs, schema status, confidence, or config.`);
  if (!input.contextPack) limitations.push("No context pack was provided directly to the evidence collector.");
  if (items.some((item) => item.confidence === "low")) limitations.push("Some evidence is low confidence and should not be treated as ground truth.");
  return limitations;
}

function evidenceGenerationMode(items: PlanningEvidenceItem[], input: MultiPlanInput): MultiPlanGenerationMode {
  if (items.some((item) => item.source_type.startsWith("provider_"))) return "mixed";
  if (input.repoIndex || input.commandInventory || input.contextPack) return "heuristic";
  return "deterministic";
}

function evidenceTraceMetadata(item: PlanningEvidenceItem) {
  return {
    run_id: item.run_id,
    task_id: item.task_id,
    evidence_id: item.evidence_id,
    source_role: item.source_role,
    source_type: item.source_type,
    artifact_ref: item.artifact_ref,
    parsed_output_ref: item.parsed_output_ref,
    trace_event_id: item.trace_event_id,
    confidence: item.confidence,
    freshness: item.freshness
  };
}

export function planningEvidenceRelevantToTeam(item: PlanningEvidenceItem, team: Pick<AgentTeam, "team_id" | "domain" | "team_type" | "allowed_files" | "memory_scope"> | TeamContextScope): boolean {
  const memoryScope = typeof team.memory_scope === "string" ? team.memory_scope : team.memory_scope.scope_id;
  const allowedFiles = "allowed_files" in team ? team.allowed_files : [];
  const haystack = [
    item.evidence_id,
    item.source_type,
    item.source_role,
    item.summary,
    item.artifact_ref,
    item.parsed_output_ref,
    ...item.extracted_findings,
    ...item.extracted_risks,
    ...item.extracted_tasks,
    ...item.extracted_validation_recommendations,
    ...item.extracted_dependencies,
    JSON.stringify(item.metadata_json)
  ].filter(Boolean).join("\n").toLowerCase();
  if (haystack.includes(team.team_id.toLowerCase()) || haystack.includes(memoryScope.toLowerCase())) return true;
  if (team.domain && haystack.includes(team.domain.toLowerCase())) return true;
  if (team.team_type === "review" && /review|risk|safety/.test(haystack)) return true;
  if (team.team_type === "validation" && /test|validation|command/.test(haystack)) return true;
  if (team.team_type === "integration" && /integration|merge|patch|conflict/.test(haystack)) return true;
  if (team.team_type === "memory" && /memory|decision|failure|lesson/.test(haystack)) return true;
  return allowedFiles.some((file) => haystack.includes(file.toLowerCase()));
}

export function planningEvidenceLinksForTeam(items: PlanningEvidenceItem[], team: Pick<AgentTeam, "team_id" | "domain" | "team_type" | "allowed_files" | "memory_scope"> | TeamContextScope): TeamContextEvidenceLink[] {
  return items
    .filter((item) => planningEvidenceRelevantToTeam(item, team))
    .map((item) => ({
      evidence_ref: `planning_evidence:${item.evidence_id}`,
      source_type: item.source_type,
      source_scope: "team",
      summary: item.summary,
      confidence: item.confidence,
      freshness: item.freshness,
      metadata_json: {
        task_id: item.task_id,
        work_item_id: item.work_item_id,
        artifact_ref: item.artifact_ref,
        parsed_output_ref: item.parsed_output_ref,
        source_role: item.source_role
      }
    }));
}

function confidenceBucket(value: number): PlanningEvidenceConfidence {
  if (value >= 0.75) return "high";
  if (value >= 0.45) return "medium";
  return "low";
}

function freshnessFor(value?: string | null) {
  if (!value) return "unknown" as const;
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs)) return "unknown" as const;
  if (ageMs < 24 * 60 * 60 * 1000) return "fresh" as const;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return "possibly_stale" as const;
  return "stale" as const;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function average(values: number[]) {
  if (!values.length) return 0;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
