import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getRelevantFiles,
  readMemoryRecords,
  readMemorySnapshot
} from "../memory/ProjectMemory.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import type {
  CommandInventory,
  DecisionRecord,
  FailedAttemptRecord,
  FileSummaryRecord,
  IndexFreshnessReport,
  LessonLearnedRecord,
  RepoIndex,
  SuccessfulPatternRecord
} from "../memory/types.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { isSecretCandidate, resolveInsideWorkspace } from "../tools/security.js";
import {
  ORCHESTRATION_SCHEMA_VERSION,
  type ContextAccessMode,
  type ContextConfidence,
  type ContextFreshness,
  type ContextPack,
  type ContextPackInclusionRecord,
  type ContextSnippet,
  type ContextSourceType,
  type Task
} from "./OrchestrationModels.js";
import { assertValid, validateContextPack } from "./Validation.js";
import { buildProjectIntelligenceGraph, resolveMechanismChain } from "../runtime/ProjectIntelligenceKernel.js";
import { summarizeRecords } from "./ContextInclusion.js";
import { AgentTeamManager } from "./AgentTeamManager.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type {
  TeamContextEvidenceLink,
  TeamContextPackExtension,
  TeamContextScope,
  TeamContextSummary,
  TeamContextWarning,
  TeamScopedMemoryQuery
} from "./AgentTeamModels.js";

export type ContextPackBuilderOptions = {
  memoryDir?: string;
  maxFiles?: number;
  maxChars?: number;
  snippetChars?: number;
};

export type ContextPackBuildOptions = {
  team_id?: string;
  team_context_scope?: TeamContextScope;
};

export class ContextPackBuilder {
  constructor(
    private readonly workspacePath: string,
    private readonly options: ContextPackBuilderOptions = {}
  ) {}

  async build(runId: string, task: Task, buildOptions: ContextPackBuildOptions = {}): Promise<ContextPack> {
    const initialFreshness = await assessIndexFreshness(this.workspacePath, this.options.memoryDir);
    if (initialFreshness.status !== "fresh") {
      await rebuildRepoIndex(this.workspacePath, { memoryDir: this.options.memoryDir });
    }
    const freshness = await assessIndexFreshness(this.workspacePath, this.options.memoryDir);
    const repoIndex = await requiredSnapshot<RepoIndex>(this.workspacePath, "repo_index", this.options.memoryDir);
    const commandInventory = await requiredSnapshot<CommandInventory>(this.workspacePath, "command_inventory", this.options.memoryDir);
    const decisions = await readMemoryRecords<DecisionRecord>(this.workspacePath, "decision", this.options.memoryDir);
    const failures = await readMemoryRecords<FailedAttemptRecord>(this.workspacePath, "failed_attempt", this.options.memoryDir);
    const lessons = await readMemoryRecords<LessonLearnedRecord>(this.workspacePath, "lesson", this.options.memoryDir);
    const successfulPatterns = await readMemoryRecords<SuccessfulPatternRecord>(this.workspacePath, "successful_pattern", this.options.memoryDir);
    const teamContext = await this.resolveTeamContext(runId, task, buildOptions, { decisions, failures, lessons, successfulPatterns });
    const memoryForContext = teamContext
      ? {
        decisions: teamContext.memory.decisions.length ? teamContext.memory.decisions : decisions,
        failures: teamContext.memory.failures.length ? teamContext.memory.failures : failures,
        lessons: teamContext.memory.lessons.length ? teamContext.memory.lessons : lessons,
        successfulPatterns: teamContext.memory.successfulPatterns.length ? teamContext.memory.successfulPatterns : successfulPatterns
      }
      : { decisions, failures, lessons, successfulPatterns };
    const relevantSummaries = await getRelevantFiles(this.workspacePath, task.objective, {
      memoryDir: this.options.memoryDir,
      limit: this.options.maxFiles ?? 6
    });
    const relevantFiles = chooseRelevantFiles(task, relevantSummaries, repoIndex, this.options.maxFiles ?? 6, teamContext?.extension.scope);
    const intelligenceFiles = uniqueStrings([
      ...relevantFiles,
      ...repoIndex.sourceFiles.slice(0, 80),
      ...repoIndex.configFiles.slice(0, 20)
    ]);
    const intelligenceGraph = buildProjectIntelligenceGraph({
      targetConcept: inferMechanismTargetFromObjective(task.objective),
      filePaths: intelligenceFiles,
      readFile: (relativePath) => readFileSync(resolveInsideWorkspace(this.workspacePath, relativePath), "utf8"),
      maxFiles: 100,
      maxReadChars: 40_000
    });
    const mechanismChain = resolveMechanismChain(intelligenceGraph, intelligenceGraph.targetConcept);
    const confirmedRelevantFiles = uniqueStrings([...relevantFiles, ...mechanismChain.confirmedFiles]).slice(0, 12);
    const safeEditSurface = uniqueStrings([
      ...task.allowed_files_to_edit,
      ...confirmedRelevantFiles.filter((file) => !matchesAnyScope(file, [...task.forbidden_files, ...(teamContext?.extension.scope.forbidden_files ?? [])]))
    ]).slice(0, 12);
    const snippets = await this.createSnippets(relevantFiles, this.options.maxChars ?? 12_000, this.options.snippetChars ?? 2_400);
    const approximateSize = snippets.reduce((sum, snippet) => sum + snippet.content.length, 0)
      + task.objective.length
      + memoryForContext.decisions.slice(-5).reduce((sum, decision) => sum + decision.summary.length, 0);
    const warnings = [
      initialFreshness.status === "stale" ? "Repository index was stale and refreshed before context pack creation." : "",
      initialFreshness.status === "missing" ? "Repository index was missing and rebuilt before context pack creation." : "",
      relevantFiles.length === 0 ? "No relevant files were selected from memory." : "",
      approximateSize >= (this.options.maxChars ?? 12_000) ? "Context pack reached the configured character budget and was truncated." : "",
      ...(teamContext?.extension.warnings.map((warning) => warning.message) ?? [])
    ].filter(Boolean);
    const commands = selectValidationCommands(task, commandInventory);
    const explanation = buildInclusionExplanation({
      runId,
      task,
      repoIndex,
      commandInventory,
      decisions: memoryForContext.decisions,
      failures: memoryForContext.failures,
      lessons: memoryForContext.lessons,
      successfulPatterns: memoryForContext.successfulPatterns,
      relevantFiles,
      relevantSummaries,
      validationCommands: commands.length ? commands : task.validation_commands,
      freshness,
      initialFreshness,
      mechanismMissingLinks: mechanismChain.missingLinks,
      mechanismSteps: mechanismChain.steps.map((step) => step.label),
      teamContext: teamContext?.extension
    });
    const pack: ContextPack = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `ctx_${task.id}`,
      run_id: runId,
      task_id: task.id,
      objective: task.objective,
      relevant_files: relevantFiles,
      snippets,
      repo_index_refs: [
        "repo_index.json",
        "file_summaries.jsonl",
        "command_inventory.json",
        ...relevantFiles.map((file) => `file:${file}`)
      ],
      constraints: [
        "Do not read or write secret-like files.",
        "Do not edit outside allowed_files_to_edit.",
        "Use structured output and include unresolved risks.",
        "Treat repository memory as a map, not a substitute for reading target files.",
        "Use target_mechanism_chain and confirmed_relevant_files before planning edits; context-only evidence is not proof."
      ],
      allowed_files_to_edit: task.allowed_files_to_edit,
      forbidden_files: teamContext ? uniqueStrings([...task.forbidden_files, ...teamContext.extension.scope.forbidden_files]) : task.forbidden_files,
      target_mechanism_chain: mechanismChain.steps.map((step) => step.label),
      confirmed_relevant_files: confirmedRelevantFiles,
      missing_evidence_links: mechanismChain.missingLinks,
      safe_edit_surface: safeEditSurface,
      previous_decisions: memoryForContext.decisions.slice(-8).map((decision) => `${decision.createdAt}: ${decision.summary}`),
      expected_output_schema: task.expected_output_schema,
      validation_requirements: commands.length ? commands : task.validation_commands,
      approximate_size: approximateSize,
      warnings,
      included_items: explanation.includedItems,
      excluded_items: explanation.excludedItems,
      freshness_warnings: explanation.freshnessWarnings,
      fallback_items: explanation.fallbackItems,
      retrieval_summary: explanation.summary,
      context_retrieval_summary: explanation.summary,
      team_context: teamContext?.extension
    };
    return assertValid("ContextPack", pack, validateContextPack);
  }

  private async resolveTeamContext(
    runId: string,
    task: Task,
    buildOptions: ContextPackBuildOptions,
    memory: {
      decisions: DecisionRecord[];
      failures: FailedAttemptRecord[];
      lessons: LessonLearnedRecord[];
      successfulPatterns: SuccessfulPatternRecord[];
    }
  ): Promise<{
    extension: TeamContextPackExtension;
    memory: {
      decisions: DecisionRecord[];
      failures: FailedAttemptRecord[];
      lessons: LessonLearnedRecord[];
      successfulPatterns: SuccessfulPatternRecord[];
    };
  } | undefined> {
    const requestedTeamId = buildOptions.team_context_scope?.team_id ?? buildOptions.team_id;
    if (!requestedTeamId && !buildOptions.team_context_scope) return undefined;
    const artifactStore = new OrchestrationArtifactStore(this.workspacePath, this.options.memoryDir);
    const metadata = new FactoryMetadataAdapter(this.workspacePath, this.options.memoryDir);
    const traceWriter = new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.options.memoryDir, sourceComponent: "ContextPackBuilder" });
    let scope = buildOptions.team_context_scope;
    if (!scope && requestedTeamId) {
      scope = await new AgentTeamManager({ workspacePath: this.workspacePath, memoryDir: this.options.memoryDir }).getTeamContextScope(requestedTeamId);
    }
    if (!scope) {
      const fallbackTeamId = requestedTeamId ?? "unknown_team";
      const trace = await traceWriter.write({
        run_id: runId,
        task_id: task.id,
        team_id: fallbackTeamId,
        event_type: "team_context_scope_fallback",
        lifecycle_stage: "executing",
        severity: "warning",
        summary: `Team context scope was unavailable for ${fallbackTeamId}; using run-level context.`,
        reason: "team_context_scope_not_found",
        metadata_json: {
          run_id: runId,
          task_id: task.id,
          team_id: fallbackTeamId,
          fallback_reason: "team_context_scope_not_found",
          source_scope: "run"
        }
      });
      const warning = teamWarning("fallback_to_run_memory", `Team ${fallbackTeamId} was not found; context uses run-level memory.`, "warning", fallbackTeamId);
      const fallbackScope = fallbackTeamContextScope(runId, task, fallbackTeamId, warning, trace.trace_event_id);
      return {
        extension: {
          scope: fallbackScope,
          summary: summarizeTeamScope(fallbackScope),
          memory_queries: [],
          evidence_links: [],
          constraints: [],
          warnings: [warning],
          inclusion_reason_summary: ["team_scope_fallback: Team scope was unavailable, so run-level context retrieval remained active."],
          fallback_used: true
        },
        memory
      };
    }

    const memoryResult = await this.queryTeamMemory(runId, task.id, scope, memory, artifactStore, metadata, traceWriter);
    const evidenceLinks = await this.queryPlanningEvidence(runId, task.id, scope);
    const warnings = uniqueWarnings([
      ...scope.warnings,
      ...memoryResult.queries.filter((query) => query.fallback_used).map((query) => teamWarning("fallback_to_run_memory", `Team memory query ${query.query_type} fell back to run-level memory.`, "warning", query.query_id)),
      ...(evidenceLinks.length ? [] : [teamWarning("missing_team_memory", "No team-specific planning evidence matched this team; context records the fallback.", "info", scope.team_id)])
    ]);
    const summary = summarizeTeamScope(scope);
    return {
      extension: {
        scope,
        summary,
        memory_queries: memoryResult.queries,
        evidence_links: evidenceLinks,
        constraints: scope.constraints,
        warnings,
        inclusion_reason_summary: [
          `team_scope_allowed_file: ${scope.allowed_files.length} effective allowed file scope(s).`,
          `team_scope_forbidden_guardrail: ${scope.forbidden_files.length} inherited forbidden guardrail(s).`,
          `team_memory_scope_decision: ${memoryResult.decisions.length} decision ref(s) considered.`,
          `team_memory_scope_failure: ${memoryResult.failures.length} prior failure ref(s) considered.`,
          `team_planning_evidence: ${evidenceLinks.length} planning evidence ref(s) linked.`
        ],
        fallback_used: memoryResult.queries.some((query) => query.fallback_used)
      },
      memory: {
        decisions: memoryResult.decisions,
        failures: memoryResult.failures,
        lessons: memoryResult.lessons,
        successfulPatterns: memoryResult.successfulPatterns
      }
    };
  }

  private async queryTeamMemory(
    runId: string,
    taskId: string,
    scope: TeamContextScope,
    memory: {
      decisions: DecisionRecord[];
      failures: FailedAttemptRecord[];
      lessons: LessonLearnedRecord[];
      successfulPatterns: SuccessfulPatternRecord[];
    },
    artifactStore: OrchestrationArtifactStore,
    metadata: FactoryMetadataAdapter,
    traceWriter: FactoryTraceWriter
  ) {
    const decide = filterTeamMemory(memory.decisions, scope, (record) => [record.summary, ...(record.relatedFiles ?? []), ...(record.tags ?? [])]);
    const fail = filterTeamMemory(memory.failures, scope, (record) => [record.summary, ...(record.evidence ?? []), record.relatedRunId, record.relatedTaskId].filter((entry): entry is string => Boolean(entry)));
    const lesson = filterTeamMemory(memory.lessons, scope, (record) => [record.summary, ...(record.evidence ?? []), ...(record.tags ?? [])]);
    const pattern = filterTeamMemory(memory.successfulPatterns, scope, (record) => [record.summary, ...(record.relatedFiles ?? []), ...(record.tags ?? [])]);
    const results = {
      decisions: decide.length ? decide : memory.decisions.slice(-8),
      failures: fail.length ? fail : memory.failures.slice(-5),
      lessons: lesson.length ? lesson : memory.lessons.slice(-3),
      successfulPatterns: pattern.length ? pattern : memory.successfulPatterns.slice(-3)
    };
    const queries: TeamScopedMemoryQuery[] = [];
    for (const [queryType, resultRefs, fallbackUsed] of [
      ["decisions", results.decisions.map((record) => `decisions.jsonl:${record.id}`), decide.length === 0],
      ["failures", results.failures.map((record) => `failed_attempts.jsonl:${record.id}`), fail.length === 0],
      ["lessons", results.lessons.map((record) => `lessons_learned.jsonl:${record.id}`), lesson.length === 0],
      ["patterns", results.successfulPatterns.map((record) => `successful_patterns.jsonl:${record.id}`), pattern.length === 0]
    ] as const) {
      const query: TeamScopedMemoryQuery = {
        query_id: `team_memory_query_${sanitizeId([scope.team_id, taskId, queryType, randomUUID().slice(0, 8)].join("_"))}`,
        run_id: runId,
        task_id: taskId,
        team_id: scope.team_id,
        memory_scope: scope.memory_scope,
        query_type: queryType,
        result_count: resultRefs.length,
        fallback_used: fallbackUsed,
        source_scope: fallbackUsed ? "run" : "team",
        result_refs: resultRefs,
        metadata_json: {
          domain: scope.domain,
          allowed_files: scope.allowed_files,
          inherited_memory_scopes: scope.inherited_memory_scopes.map((entry) => entry.scope_id)
        },
        created_at: new Date().toISOString()
      };
      const artifactRef = await artifactStore.saveTeamMemoryQuery(query);
      query.artifact_ref = artifactRef;
      const trace = await traceWriter.write({
        run_id: runId,
        task_id: taskId,
        team_id: scope.team_id,
        event_type: "team_memory_scope_queried",
        lifecycle_stage: "memory",
        severity: fallbackUsed ? "warning" : "info",
        summary: `Team memory scope queried for ${queryType}.`,
        reason: fallbackUsed ? "No team-specific memory matched; run-level fallback used." : "Team-specific memory matched.",
        artifact_refs: [artifactRef],
        metadata_json: {
          run_id: runId,
          task_id: taskId,
          team_id: scope.team_id,
          parent_team_id: scope.parent_team_id,
          memory_scope: scope.memory_scope,
          source_scope: query.source_scope,
          query_type: queryType,
          result_count: resultRefs.length,
          fallback_used: fallbackUsed,
          fallback_reason: fallbackUsed ? "no_team_specific_memory" : undefined
        }
      });
      query.trace_event_id = trace.trace_event_id;
      await metadata.recordTeamMemoryQuerySaved(query);
      if (fallbackUsed) {
        await traceWriter.write({
          run_id: runId,
          task_id: taskId,
          team_id: scope.team_id,
          event_type: "team_memory_scope_fallback",
          lifecycle_stage: "memory",
          severity: "warning",
          causal_parent_event_id: trace.trace_event_id,
          summary: `Team memory fallback used for ${queryType}.`,
          reason: "no_team_specific_memory",
          artifact_refs: [artifactRef],
          metadata_json: {
            run_id: runId,
            task_id: taskId,
            team_id: scope.team_id,
            memory_scope: scope.memory_scope,
            fallback_reason: "no_team_specific_memory",
            source_scope: "run"
          }
        });
      }
      queries.push(query);
    }
    return { ...results, queries };
  }

  private async queryPlanningEvidence(runId: string, taskId: string, scope: TeamContextScope): Promise<TeamContextEvidenceLink[]> {
    try {
      const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.options.memoryDir, readOnly: true });
      try {
        return store.all<Record<string, unknown>>(
          "SELECT evidence_id, source_type, source_role, artifact_ref, parsed_output_ref, confidence, freshness, summary, metadata_json FROM factory_planning_evidence WHERE run_id = ? ORDER BY created_at",
          runId
        ).filter((row) => evidenceMatchesScope(row, scope))
          .slice(0, 12)
          .map((row) => ({
            evidence_ref: `planning_evidence:${String(row.evidence_id)}`,
            source_type: String(row.source_type),
            source_scope: "team",
            summary: String(row.summary ?? ""),
            confidence: String(row.confidence ?? "unknown"),
            freshness: String(row.freshness ?? "unknown"),
            metadata_json: {
              task_id: taskId,
              artifact_ref: stringOrUndefined(row.artifact_ref),
              parsed_output_ref: stringOrUndefined(row.parsed_output_ref),
              source_role: stringOrUndefined(row.source_role)
            }
          }));
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }

  private async createSnippets(files: string[], maxChars: number, snippetChars: number): Promise<ContextSnippet[]> {
    const snippets: ContextSnippet[] = [];
    let usedChars = 0;
    for (const relativePath of files) {
      if (usedChars >= maxChars) break;
      const fullPath = resolveInsideWorkspace(this.workspacePath, relativePath);
      if (isSecretCandidate(fullPath)) continue;
      const text = await readFile(fullPath, "utf8").catch(() => "");
      if (!text) continue;
      const remaining = Math.max(0, maxChars - usedChars);
      const content = text.slice(0, Math.min(snippetChars, remaining));
      if (!content) break;
      const endLine = content.split(/\r?\n/).length;
      snippets.push({
        path: relativePath,
        start_line: 1,
        end_line: endLine,
        content,
        truncated: text.length > content.length
      });
      usedChars += content.length;
    }
    return snippets;
  }
}

function chooseRelevantFiles(task: Task, summaries: FileSummaryRecord[], repoIndex: RepoIndex, maxFiles: number, teamScope?: TeamContextScope) {
  const direct = [...task.relevant_files, ...task.allowed_files_to_edit].filter(Boolean);
  const fromSummaries = summaries.map((summary) => summary.path);
  const fallback = [
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.sourceFiles.slice(0, 5),
    ...repoIndex.docFiles.slice(0, 3)
  ];
  const teamAllowed = teamScope?.allowed_files ?? [];
  const teamForbidden = teamScope?.forbidden_files ?? [];
  const candidates = uniqueStrings([
    ...direct,
    ...teamAllowed,
    ...fromSummaries,
    ...fallback
  ]);
  return candidates
    .filter((file) => !matchesAnyScope(file, [...task.forbidden_files, ...teamForbidden]) && !isLikelyGeneratedOrSecret(file))
    .sort((left, right) => teamFilePriority(right, teamAllowed, direct) - teamFilePriority(left, teamAllowed, direct))
    .slice(0, maxFiles);
}

function selectValidationCommands(task: Task, inventory: CommandInventory) {
  if (task.validation_commands.length) return task.validation_commands;
  return [
    ...inventory.byKind.test.slice(0, 1),
    ...inventory.byKind.typecheck.slice(0, 1),
    ...inventory.byKind.build.slice(0, 1)
  ].slice(0, 2);
}

function inferMechanismTargetFromObjective(objective: string) {
  const normalized = objective.toLowerCase();
  if (/\bfeedback\b|customer_feedback|submitfeedback|awaiting_feedback/i.test(objective)) return "feedback";
  if (/\bouter\s*loop\b|\bouterloop\b|outer_loop/i.test(objective)) return "outerloop";
  if (/\bdbscan\b/i.test(objective)) return "dbscan";
  if (/\bfcm\b|fuzzy c/i.test(objective)) return "fcm";
  if (/\bsvm\b|support vector/i.test(objective)) return "svm";
  const candidate = normalized.match(/\b[a-z][a-z0-9_]{3,}\b/);
  return candidate?.[0] ?? "general";
}

function isLikelyGeneratedOrSecret(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)(node_modules|dist|build|target|coverage|\.git|\.agent_memory)\//.test(normalized)
    || /(^|\/)\.env(\.|$)|\.pem$|id_rsa$|id_ed25519$|credentials\.json$/i.test(path.basename(normalized));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function requiredSnapshot<T>(workspacePath: string, kind: string, memoryDir?: string): Promise<T> {
  const value = await readMemorySnapshot<T>(workspacePath, kind, memoryDir);
  if (value === undefined) throw new Error(`Required SQLite memory snapshot is missing: ${kind}`);
  return value;
}

function buildInclusionExplanation(input: {
  runId: string;
  task: Task;
  repoIndex: RepoIndex;
  commandInventory: CommandInventory;
  decisions: DecisionRecord[];
  failures: FailedAttemptRecord[];
  lessons: LessonLearnedRecord[];
  successfulPatterns: SuccessfulPatternRecord[];
  relevantFiles: string[];
  relevantSummaries: FileSummaryRecord[];
  validationCommands: string[];
  freshness: IndexFreshnessReport;
  initialFreshness: IndexFreshnessReport;
  mechanismMissingLinks: string[];
  mechanismSteps: string[];
  teamContext?: TeamContextPackExtension;
}) {
  const includedItems: ContextPackInclusionRecord[] = [];
  const excludedItems: ContextPackInclusionRecord[] = [];
  const fallbackItems: ContextPackInclusionRecord[] = [];
  const summaryByPath = new Map(input.relevantSummaries.map((summary) => [summary.path, summary]));
  const directRelevant = new Set([...input.task.relevant_files, ...input.task.allowed_files_to_edit]);
  const fallbackFiles = new Set([
    ...input.repoIndex.entrypoints,
    ...input.repoIndex.importantFiles,
    ...input.repoIndex.sourceFiles.slice(0, 5),
    ...input.repoIndex.docFiles.slice(0, 3)
  ]);

  for (const file of input.relevantFiles) {
    const isEditable = input.task.allowed_files_to_edit.includes(file);
    const summary = summaryByPath.get(file);
    const isFallback = !directRelevant.has(file) && !summary && fallbackFiles.has(file);
    const score = summary ? scoreFileSummaryForObjective(summary, input.task.objective) : isEditable || input.task.relevant_files.includes(file) ? 1 : null;
    const item = inclusionRecord(input, {
      itemType: "file",
      sourceType: isEditable ? "direct_allowed_file" : isFallback ? "fallback_heuristic" : summary ? "file_summary" : "read_only_dependency",
      sourceRef: summary ? `file_summaries.jsonl:${file}` : isFallback ? `repo_index.json:fallback:${file}` : `task:${input.task.id}:${file}`,
      sourcePath: file,
      accessMode: isEditable ? "editable" : "read_only",
      reason: fileReason(file, isEditable, isFallback, summary, input.task),
      relevanceScore: score,
      confidence: score === null ? "low" : score >= 1 ? "high" : "medium",
      freshness: freshnessForSource(file, input.freshness),
      evidenceRefs: evidenceRefsForFile(file, summary, input.task),
      warnings: itemFreshnessWarnings(file, input.freshness),
      metadata: {
        heuristic_score: score,
        matched_terms: matchedTerms(input.task.objective, [file, summary?.purposeGuess, summary?.symbols.map((symbol) => symbol.name).join(" ")]),
        matched_paths: directRelevant.has(file) ? [file] : [],
        matched_symbols: summary?.symbols.map((symbol) => symbol.name).filter((name) => taskTerms(input.task.objective).some((term) => name.toLowerCase().includes(term))).slice(0, 10) ?? [],
        matched_task_objective: Boolean(summary && scoreFileSummaryForObjective(summary, input.task.objective) > 0),
        matched_role: input.task.role_required,
        fallback_reason: isFallback ? "Selected from repo entrypoints, important files, source files, or docs after direct and summary matches." : undefined
      }
    });
    includedItems.push(item);
    if (isFallback) fallbackItems.push(item);
  }

  for (const forbidden of input.task.forbidden_files) {
    const item = inclusionRecord(input, {
      itemType: "file",
      sourceType: "forbidden_file_reference",
      sourceRef: `task:${input.task.id}:forbidden_files:${forbidden}`,
      sourcePath: forbidden,
      accessMode: "forbidden",
      reason: `Included only as a guardrail: ${forbidden} is forbidden for this task and should not be edited or used as writable context.`,
      relevanceScore: null,
      confidence: "high",
      freshness: "unknown",
      evidenceRefs: [`task:${input.task.id}`, `forbidden_files:${forbidden}`],
      warnings: ["Forbidden reference only; do not edit this path."],
      metadata: { guardrail: true }
    });
    includedItems.push(item);
    excludedItems.push({ ...item, item_id: `${item.item_id}_excluded`, inclusion_reason: `${item.inclusion_reason} It was excluded from editable and snippet-bearing context.` });
  }

  const repoRefs = [
    ["repo_index.json", "Repository layout, source/doc/config groups, entrypoints, and skipped file metadata."],
    ["file_summaries.jsonl", "Per-file summaries and symbol hints used by the current heuristic selector."],
    ["command_inventory.json", "Detected validation commands and command sources."]
  ] as const;
  for (const [sourceRef, reason] of repoRefs) {
    includedItems.push(inclusionRecord(input, {
      itemType: "repo_index_item",
      sourceType: "repo_index_summary",
      sourceRef,
      accessMode: "memory_only",
      reason,
      relevanceScore: sourceRef === "command_inventory.json" && input.validationCommands.length ? 0.8 : 0.6,
      confidence: "medium",
      freshness: freshnessForIndex(input.freshness),
      evidenceRefs: [sourceRef],
      warnings: input.freshness.status === "fresh" ? [] : [`Repo index freshness is ${input.freshness.status}.`],
      metadata: { index_generated_at: input.repoIndex.generatedAt, command_inventory_generated_at: input.commandInventory.generatedAt }
    }));
  }

  for (const command of input.validationCommands) {
    includedItems.push(inclusionRecord(input, {
      itemType: "validation_command",
      sourceType: "validation_command",
      sourceRef: `command_inventory:${command}`,
      accessMode: "validation_only",
      reason: `Validation command is relevant because this task needs a mechanical check for ${input.task.role_required} output or selected module behavior.`,
      relevanceScore: input.task.validation_commands.includes(command) ? 1 : 0.75,
      confidence: input.task.validation_commands.includes(command) ? "high" : "medium",
      freshness: freshnessForIndex(input.freshness),
      evidenceRefs: [`task:${input.task.id}`, "command_inventory.json"],
      warnings: [],
      metadata: { command_kind: commandKind(command, input.commandInventory), required_by_task: input.task.validation_commands.includes(command) }
    }));
  }

  if (input.task.input_context) {
    includedItems.push(inclusionRecord(input, {
      itemType: "user_constraint",
      sourceType: "user_constraint",
      sourceRef: `task:${input.task.id}:input_context`,
      accessMode: "reference_only",
      reason: "Task input context was included as a user or planner constraint for this worker.",
      relevanceScore: 1,
      confidence: "high",
      freshness: "current",
      evidenceRefs: [`task:${input.task.id}`],
      warnings: [],
      metadata: { constraint_chars: input.task.input_context.length }
    }));
  }

  for (const decision of input.decisions.slice(-8)) {
    includedItems.push(inclusionRecord(input, {
      itemType: "memory_decision",
      sourceType: "prior_decision",
      sourceRef: `decisions.jsonl:${decision.id}`,
      accessMode: "memory_only",
      reason: memoryReason("decision", decision.summary, decision.relatedFiles, input.task, input.relevantFiles),
      relevanceScore: memoryScore(decision.summary, decision.relatedFiles, input.task, input.relevantFiles),
      confidence: memoryScore(decision.summary, decision.relatedFiles, input.task, input.relevantFiles) >= 0.7 ? "medium" : "low",
      freshness: "unknown",
      evidenceRefs: [`decisions.jsonl:${decision.id}`, ...(decision.relatedFiles ?? []).map((file) => `file:${file}`)],
      warnings: ["Memory freshness cannot be proven from the repository index."],
      metadata: { created_at: decision.createdAt, tags: decision.tags ?? [], related_files: decision.relatedFiles ?? [] }
    }));
  }

  for (const failure of input.failures.slice(-5)) {
    includedItems.push(inclusionRecord(input, {
      itemType: "memory_failure",
      sourceType: "prior_failure",
      sourceRef: `failed_attempts.jsonl:${failure.id}`,
      accessMode: "memory_only",
      reason: `Prior failure included to avoid repeating a known risk: ${failure.summary}`,
      relevanceScore: memoryScore(failure.summary, failure.evidence, input.task, input.relevantFiles),
      confidence: "medium",
      freshness: "unknown",
      evidenceRefs: [`failed_attempts.jsonl:${failure.id}`, ...(failure.evidence ?? [])],
      warnings: ["Prior failure is cautionary memory, not proof of current repository state."],
      metadata: {
        fingerprint: failure.fingerprint,
        related_run_id: failure.relatedRunId,
        related_task_id: failure.relatedTaskId,
        next_avoidance: failure.nextAvoidance
      }
    }));
  }

  for (const lesson of input.lessons.slice(-3)) {
    includedItems.push(inclusionRecord(input, {
      itemType: "memory_lesson",
      sourceType: "lesson",
      sourceRef: `lessons_learned.jsonl:${lesson.id}`,
      accessMode: "memory_only",
      reason: `Lesson included as cautionary project memory for this task: ${lesson.summary}`,
      relevanceScore: memoryScore(lesson.summary, lesson.evidence, input.task, input.relevantFiles),
      confidence: "low",
      freshness: "unknown",
      evidenceRefs: [`lessons_learned.jsonl:${lesson.id}`, ...(lesson.evidence ?? [])],
      warnings: ["Lesson freshness cannot be proven from repository hashes."],
      metadata: { created_at: lesson.createdAt, related_run_ids: lesson.relatedRunIds ?? [], tags: lesson.tags ?? [] }
    }));
  }

  for (const pattern of input.successfulPatterns.slice(-3)) {
    includedItems.push(inclusionRecord(input, {
      itemType: "memory_successful_pattern",
      sourceType: "successful_pattern",
      sourceRef: `successful_patterns.jsonl:${pattern.id}`,
      accessMode: "memory_only",
      reason: `Successful pattern included because it may describe an accepted local approach: ${pattern.summary}`,
      relevanceScore: memoryScore(pattern.summary, pattern.relatedFiles, input.task, input.relevantFiles),
      confidence: "low",
      freshness: "unknown",
      evidenceRefs: [`successful_patterns.jsonl:${pattern.id}`, ...(pattern.relatedFiles ?? []).map((file) => `file:${file}`)],
      warnings: ["Pattern is memory-only and should be checked against current files before editing."],
      metadata: { created_at: pattern.createdAt, related_run_ids: pattern.relatedRunIds ?? [], tags: pattern.tags ?? [] }
    }));
  }

  if (input.mechanismSteps.length || input.mechanismMissingLinks.length) {
    includedItems.push(inclusionRecord(input, {
      itemType: "project_intelligence",
      sourceType: "project_intelligence",
      sourceRef: "project_intelligence:mechanism_chain",
      accessMode: "reference_only",
      reason: "Project intelligence mechanism chain was included to explain confirmed files and unresolved evidence links.",
      relevanceScore: input.mechanismSteps.length ? 0.7 : null,
      confidence: input.mechanismSteps.length ? "medium" : "low",
      freshness: freshnessForIndex(input.freshness),
      evidenceRefs: ["project_intelligence.json", ...input.mechanismSteps.map((step) => `mechanism:${step}`)],
      warnings: input.mechanismMissingLinks.length ? ["Mechanism chain has missing evidence links."] : [],
      metadata: { missing_links: input.mechanismMissingLinks, steps: input.mechanismSteps }
    }));
  }

  if (input.teamContext) {
    applyTeamContextInclusions(input, includedItems, excludedItems, fallbackItems);
  }

  const freshnessWarnings = [
    input.initialFreshness.status === "stale" ? "Repository index was stale before context pack creation and was refreshed." : "",
    input.initialFreshness.status === "missing" ? "Repository index was missing before context pack creation and was rebuilt." : "",
    ...includedItems.filter((item) => item.freshness === "stale" || item.freshness === "possibly_stale").map((item) => `${item.source_ref} freshness is ${item.freshness}.`)
  ].filter(Boolean);
  return {
    includedItems,
    excludedItems,
    fallbackItems,
    freshnessWarnings,
    summary: summarizeRecords(includedItems, excludedItems)
  };
}

function inclusionRecord(input: {
  runId: string;
  task: Task;
}, value: {
  itemType: string;
  sourceType: ContextSourceType;
  sourceRef: string;
  sourcePath?: string;
  accessMode: ContextAccessMode;
  reason: string;
  relevanceScore: number | null;
  confidence: ContextConfidence;
  freshness: ContextFreshness;
  evidenceRefs: string[];
  warnings: string[];
  metadata: Record<string, unknown>;
}): ContextPackInclusionRecord {
  return {
    item_id: contextItemId(input.task.id, value.sourceType, value.sourceRef),
    item_type: value.itemType,
    source_type: value.sourceType,
    source_ref: value.sourceRef,
    source_path: value.sourcePath,
    run_id: input.runId,
    task_id: input.task.id,
    agent_role: input.task.role_required,
    access_mode: value.accessMode,
    inclusion_reason: value.reason,
    relevance_score: normalizeScore(value.relevanceScore),
    confidence: value.confidence,
    freshness: value.freshness,
    evidence_refs: uniqueStrings(value.evidenceRefs),
    evidence: uniqueStrings(value.evidenceRefs).map((ref) => ({ evidence_ref: ref })),
    warnings: value.warnings,
    metadata_json: scrubUndefined(value.metadata)
  };
}

function applyTeamContextInclusions(
  input: {
    runId: string;
    task: Task;
    teamContext?: TeamContextPackExtension;
  },
  includedItems: ContextPackInclusionRecord[],
  excludedItems: ContextPackInclusionRecord[],
  fallbackItems: ContextPackInclusionRecord[]
) {
  const team = input.teamContext;
  if (!team) return;
  for (const item of includedItems) {
    if (item.source_type === "prior_decision") {
      item.source_type = "team_memory_scope_decision";
      item.inclusion_reason = `${item.inclusion_reason} Included through team memory scope ${team.scope.memory_scope}.`;
      item.metadata_json = { ...item.metadata_json, team_id: team.scope.team_id, memory_scope: team.scope.memory_scope };
    }
    if (item.source_type === "prior_failure") {
      item.source_type = "team_memory_scope_failure";
      item.inclusion_reason = `${item.inclusion_reason} Included through team memory scope ${team.scope.memory_scope}.`;
      item.metadata_json = { ...item.metadata_json, team_id: team.scope.team_id, memory_scope: team.scope.memory_scope };
    }
    if (!item.source_path) continue;
    if (matchesAnyScope(item.source_path, team.scope.allowed_files)) {
      const parentMatch = team.scope.inherited_memory_scopes.some((scopeRef) => scopeRef.context_refs.some((ref) => pathMatchesScope(item.source_path ?? "", ref)));
      item.source_type = item.access_mode === "editable" ? "team_scope_allowed_file" : "team_scope_read_only_dependency";
      item.inclusion_reason = `${item.inclusion_reason} Team context included this because ${item.source_path} is inside team scope${parentMatch ? " inherited from a parent team" : ""}.`;
      item.evidence_refs = uniqueStrings([...item.evidence_refs, `team:${team.scope.team_id}`, `team_memory_scope:${team.scope.memory_scope}`]);
      item.metadata_json = {
        ...item.metadata_json,
        team_id: team.scope.team_id,
        parent_team_id: team.scope.parent_team_id,
        memory_scope: team.scope.memory_scope,
        inclusion_reason_type: item.source_type,
        included_by_parent_team_scope: parentMatch
      };
    }
    if (matchesAnyScope(item.source_path, team.scope.forbidden_files)) {
      item.access_mode = "forbidden";
      item.source_type = "team_scope_forbidden_guardrail";
      item.inclusion_reason = `${item.source_path} was downgraded to forbidden reference because it is outside writable team scope or matches inherited forbidden files.`;
      item.warnings = uniqueStrings([...item.warnings, "Excluded or downgraded by team forbidden scope."]);
      item.metadata_json = { ...item.metadata_json, team_id: team.scope.team_id, excluded_or_downgraded_by_team_scope: true };
      excludedItems.push({ ...item, item_id: `${item.item_id}_team_excluded` });
    }
  }
  for (const forbidden of team.scope.forbidden_files) {
    if (includedItems.some((item) => item.source_ref === `team:${team.scope.team_id}:forbidden:${forbidden}`)) continue;
    const item = inclusionRecord(input, {
      itemType: "team_scope_guardrail",
      sourceType: "team_scope_forbidden_guardrail",
      sourceRef: `team:${team.scope.team_id}:forbidden:${forbidden}`,
      sourcePath: forbidden,
      accessMode: "forbidden",
      reason: `Team scope forbidden guardrail inherited for ${team.scope.team_id}: ${forbidden}.`,
      relevanceScore: 1,
      confidence: "high",
      freshness: team.scope.freshness === "current" || team.scope.freshness === "fresh" ? "current" : "unknown",
      evidenceRefs: [`team:${team.scope.team_id}`, `team_memory_scope:${team.scope.memory_scope}`],
      warnings: ["Forbidden by team or parent team scope."],
      metadata: { team_id: team.scope.team_id, parent_team_id: team.scope.parent_team_id, memory_scope: team.scope.memory_scope, guardrail: true }
    });
    includedItems.push(item);
    excludedItems.push({ ...item, item_id: `${item.item_id}_excluded`, inclusion_reason: `${item.inclusion_reason} It was excluded from snippets and editable context.` });
  }
  for (const constraint of team.constraints.filter((entry) => entry.source === "parent_team").slice(0, 8)) {
    includedItems.push(inclusionRecord(input, {
      itemType: "team_parent_constraint",
      sourceType: "team_parent_scope_constraint",
      sourceRef: constraint.source_ref,
      accessMode: "reference_only",
      reason: `Parent team constraint included for team scope: ${constraint.summary}`,
      relevanceScore: 0.8,
      confidence: "medium",
      freshness: team.scope.freshness === "current" ? "current" : "unknown",
      evidenceRefs: [`team:${team.scope.team_id}`, `parent_team:${team.scope.parent_team_id ?? constraint.source_ref}`],
      warnings: constraint.severity === "blocking" ? [constraint.summary] : [],
      metadata: { team_id: team.scope.team_id, parent_team_id: team.scope.parent_team_id, constraint }
    }));
  }
  for (const lock of team.scope.module_locks.slice(0, 8)) {
    includedItems.push(teamLockItem(input, team, lock, "team_module_lock_context"));
  }
  for (const lock of team.scope.semantic_locks.slice(0, 8)) {
    includedItems.push(teamLockItem(input, team, lock, "team_semantic_lock_context"));
  }
  for (const evidence of team.evidence_links) {
    includedItems.push(inclusionRecord(input, {
      itemType: "team_planning_evidence",
      sourceType: "team_planning_evidence",
      sourceRef: evidence.evidence_ref,
      accessMode: "memory_only",
      reason: `Planning evidence linked to team ${team.scope.team_id}: ${evidence.summary ?? evidence.evidence_ref}`,
      relevanceScore: 0.75,
      confidence: evidence.confidence === "high" ? "high" : evidence.confidence === "medium" ? "medium" : "low",
      freshness: contextFreshness(evidence.freshness),
      evidenceRefs: [evidence.evidence_ref],
      warnings: evidence.freshness === "stale" || evidence.confidence === "low" ? ["Team planning evidence may be stale or low confidence."] : [],
      metadata: { team_id: team.scope.team_id, parent_team_id: team.scope.parent_team_id, memory_scope: team.scope.memory_scope, source_scope: evidence.source_scope }
    }));
  }
  for (const query of team.memory_queries) {
    if (query.fallback_used) {
      const item = inclusionRecord(input, {
        itemType: "team_memory_fallback",
        sourceType: "team_scope_fallback",
        sourceRef: query.query_id,
        accessMode: "memory_only",
        reason: `Team memory scope fallback used for ${query.query_type}; no team-specific memory existed.`,
        relevanceScore: 0.4,
        confidence: "low",
        freshness: "unknown",
        evidenceRefs: [query.artifact_ref ?? query.query_id],
        warnings: ["Run-level memory fallback used for team-scoped context."],
        metadata: { team_id: team.scope.team_id, memory_scope: team.scope.memory_scope, query_type: query.query_type, fallback_reason: "no_team_specific_memory" }
      });
      includedItems.push(item);
      fallbackItems.push(item);
    }
  }
  for (const warning of team.warnings.filter((entry) => entry.reason === "budget_pressure")) {
    includedItems.push(inclusionRecord(input, {
      itemType: "team_budget_warning",
      sourceType: "team_budget_warning",
      sourceRef: warning.source_ref ?? warning.warning_id,
      accessMode: "reference_only",
      reason: `Team budget warning included: ${warning.message}`,
      relevanceScore: 0.6,
      confidence: "medium",
      freshness: "current",
      evidenceRefs: [`team:${team.scope.team_id}`],
      warnings: [warning.message],
      metadata: { team_id: team.scope.team_id, memory_scope: team.scope.memory_scope, warning }
    }));
  }
}

function teamLockItem(input: { runId: string; task: Task }, team: TeamContextPackExtension, lock: string, sourceType: "team_module_lock_context" | "team_semantic_lock_context") {
  return inclusionRecord(input, {
    itemType: sourceType,
    sourceType,
    sourceRef: lock,
    accessMode: "reference_only",
    reason: `${sourceType === "team_module_lock_context" ? "Module" : "Semantic"} lock context included for team ${team.scope.team_id}: ${lock}.`,
    relevanceScore: 0.7,
    confidence: "medium",
    freshness: "current",
    evidenceRefs: [`team:${team.scope.team_id}`, lock],
    warnings: ["Lock context is advisory for retrieval and must not bypass durable lock authority."],
    metadata: { team_id: team.scope.team_id, parent_team_id: team.scope.parent_team_id, memory_scope: team.scope.memory_scope }
  });
}

function fileReason(file: string, isEditable: boolean, isFallback: boolean, summary: FileSummaryRecord | undefined, task: Task) {
  if (isEditable) return `${file} is directly editable for this task because it appears in allowed_files_to_edit.`;
  if (task.relevant_files.includes(file)) return `${file} was named as relevant task context and is included read-only unless also allowed for edits.`;
  if (summary) return `${file} matched the task objective through the existing file-summary heuristic and is included as read-only context.`;
  if (isFallback) return `${file} was included by the existing fallback heuristic from repo index entrypoints, important files, source files, or docs.`;
  return `${file} is included as read-only dependency context selected by the existing context-pack builder.`;
}

function evidenceRefsForFile(file: string, summary: FileSummaryRecord | undefined, task: Task) {
  return uniqueStrings([
    `file:${file}`,
    summary ? `file_summaries.jsonl:${file}` : "",
    task.allowed_files_to_edit.includes(file) ? `task:${task.id}:allowed_files_to_edit` : "",
    task.relevant_files.includes(file) ? `task:${task.id}:relevant_files` : ""
  ]);
}

function freshnessForSource(file: string, freshness: IndexFreshnessReport): ContextFreshness {
  if (freshness.status === "fresh") return "current";
  if (freshness.changedFiles.includes(file) || freshness.deletedFiles.includes(file)) return "stale";
  if (freshness.newFiles.includes(file)) return "possibly_stale";
  if (freshness.status === "stale") return "possibly_stale";
  return "unknown";
}

function freshnessForIndex(freshness: IndexFreshnessReport): ContextFreshness {
  if (freshness.status === "fresh") return "current";
  if (freshness.status === "stale") return "stale";
  return "unknown";
}

function itemFreshnessWarnings(file: string, freshness: IndexFreshnessReport) {
  const sourceFreshness = freshnessForSource(file, freshness);
  if (sourceFreshness === "stale" || sourceFreshness === "possibly_stale") return [`Freshness for ${file} is ${sourceFreshness}.`];
  if (sourceFreshness === "unknown") return [`Freshness for ${file} could not be proven.`];
  return [];
}

function scoreFileSummaryForObjective(summary: FileSummaryRecord, objective: string) {
  const terms = taskTerms(objective);
  const haystack = [
    summary.path,
    summary.language ?? "",
    summary.roleGuess,
    summary.purposeGuess,
    summary.roles.join(" "),
    summary.imports.join(" "),
    summary.exports.join(" "),
    summary.symbols.map((symbol) => symbol.name).join(" ")
  ].join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (summary.path.toLowerCase().includes(term)) score += 6;
    if (haystack.includes(term)) score += 2;
  }
  if (summary.roles.includes("entrypoint")) score += 1;
  return normalizeScore(score / 10) ?? 0;
}

function memoryScore(summary: string, refs: string[] | undefined, task: Task, relevantFiles: string[]) {
  const terms = taskTerms(task.objective);
  const haystack = [summary, ...(refs ?? [])].join("\n").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 0.1;
  }
  if ((refs ?? []).some((ref) => relevantFiles.some((file) => ref.includes(file)))) score += 0.5;
  if ((refs ?? []).some((ref) => task.allowed_files_to_edit.includes(ref))) score += 0.3;
  return normalizeScore(score) ?? 0.25;
}

function memoryReason(kind: string, summary: string, relatedFiles: string[] | undefined, task: Task, relevantFiles: string[]) {
  const related = (relatedFiles ?? []).filter((file) => relevantFiles.includes(file) || task.allowed_files_to_edit.includes(file));
  if (related.length) return `Prior ${kind} is relevant because it references selected task file(s): ${related.join(", ")}.`;
  return `Prior ${kind} is included as recent project memory for this worker: ${summary}`;
}

function commandKind(command: string, inventory: CommandInventory) {
  return inventory.commands.find((entry) => entry.command === command)?.kind ?? Object.entries(inventory.byKind).find(([, commands]) => commands.includes(command))?.[0] ?? "unknown";
}

function matchedTerms(objective: string, values: Array<string | undefined>) {
  const haystack = values.filter(Boolean).join("\n").toLowerCase();
  return taskTerms(objective).filter((term) => haystack.includes(term)).slice(0, 20);
}

function taskTerms(objective: string) {
  return objective.toLowerCase().split(/[^a-z0-9_./-]+/i).filter((term) => term.length >= 2);
}

function normalizeScore(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function contextItemId(taskId: string, sourceType: string, sourceRef: string) {
  return `ctx_item_${sanitizeId(taskId)}_${sanitizeId(sourceType)}_${sanitizeId(sourceRef).slice(0, 80)}`;
}

function sanitizeId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function fallbackTeamContextScope(runId: string, task: Task, teamId: string, warning: TeamContextWarning, traceEventId?: string): TeamContextScope {
  return {
    team_context_scope_id: `team_context_scope_${sanitizeId(teamId)}`,
    team_id: teamId,
    run_id: runId,
    domain: "unknown",
    objective: task.objective,
    team_type: "ad_hoc",
    memory_scope: `run:${runId}`,
    inherited_memory_scopes: [],
    allowed_files: [],
    forbidden_files: task.forbidden_files,
    read_only_files: task.relevant_files,
    module_locks: [],
    semantic_locks: [],
    evidence_refs: [],
    decision_refs: [],
    failure_refs: [],
    budget_summary: {},
    constraints: [],
    warnings: [warning],
    confidence: 0.25,
    freshness: "unknown",
    trace_event_id: traceEventId,
    metadata_json: { fallback_reason: "team_context_scope_not_found" }
  };
}

function summarizeTeamScope(scope: TeamContextScope): TeamContextSummary {
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

function filterTeamMemory<T>(records: T[], scope: TeamContextScope, fields: (record: T) => string[]) {
  return records.filter((record) => {
    const haystack = fields(record).join("\n").toLowerCase();
    return haystack.includes(scope.team_id.toLowerCase())
      || haystack.includes(scope.memory_scope.toLowerCase())
      || (scope.domain.length > 1 && haystack.includes(scope.domain.toLowerCase()))
      || scope.allowed_files.some((file) => haystack.includes(file.toLowerCase()))
      || scope.inherited_memory_scopes.some((memoryScope) => haystack.includes(memoryScope.scope_id.toLowerCase()));
  });
}

function evidenceMatchesScope(row: Record<string, unknown>, scope: TeamContextScope) {
  const haystack = [
    row.evidence_id,
    row.source_type,
    row.source_role,
    row.summary,
    row.artifact_ref,
    row.parsed_output_ref,
    row.metadata_json,
    scope.team_type === "integration" ? "integration" : "",
    scope.team_type === "memory" ? "memory decisions failures lessons" : ""
  ].filter(Boolean).join("\n").toLowerCase();
  if (haystack.includes(scope.team_id.toLowerCase()) || haystack.includes(scope.memory_scope.toLowerCase())) return true;
  if (scope.domain && haystack.includes(scope.domain.toLowerCase())) return true;
  if (scope.team_type === "review" && /review|risk|safety/.test(haystack)) return true;
  if (scope.team_type === "validation" && /test|validation|command/.test(haystack)) return true;
  if (scope.team_type === "integration" && /integration|merge|patch|conflict/.test(haystack)) return true;
  if (scope.team_type === "memory" && /memory|decision|failure|lesson/.test(haystack)) return true;
  return scope.allowed_files.some((file) => haystack.includes(file.toLowerCase()));
}

function teamWarning(reason: TeamContextWarning["reason"], message: string, severity: TeamContextWarning["severity"], sourceRef?: string): TeamContextWarning {
  return {
    warning_id: `team_warning_${sanitizeId([reason, sourceRef ?? message].join("_")).slice(0, 80)}`,
    reason,
    message,
    severity,
    source_ref: sourceRef,
    metadata_json: {}
  };
}

function uniqueWarnings(warnings: TeamContextWarning[]) {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.reason}:${warning.message}:${warning.source_ref ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function teamFilePriority(file: string, allowedFiles: string[], directFiles: string[]) {
  let score = 0;
  if (directFiles.some((entry) => normalizePath(entry) === normalizePath(file))) score += 10;
  if (matchesAnyScope(file, allowedFiles)) score += 5;
  return score;
}

function matchesAnyScope(file: string, scopes: string[]) {
  return scopes.some((scope) => pathMatchesScope(file, scope));
}

function pathMatchesScope(file: string, scope: string) {
  const normalizedFile = normalizePath(file);
  const normalizedScope = normalizePath(scope).replace(/\/$/, "");
  return normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function contextFreshness(value: string | undefined): ContextFreshness {
  if (value === "current" || value === "fresh" || value === "possibly_stale" || value === "stale" || value === "unknown") return value;
  return "unknown";
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function scrubUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
