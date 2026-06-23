import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { ensureMemoryLayout, readJson, writeJson } from "../memory/ProjectMemory.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { IntegrationCandidate } from "./IntegrationModels.js";
import type { Run, Task } from "./OrchestrationModels.js";
import { SemanticConflictResolver } from "./SemanticConflictResolver.js";
import type { SemanticConflictDecision, SemanticConflictResolutionBatch } from "./SemanticConflictResolverModels.js";
import {
  createGoalStewardFinding,
  createGoalStewardReview,
  type GoalStewardFinding,
  type GoalStewardMode,
  type GoalStewardRecommendedAction,
  type GoalStewardReview,
  type GoalStewardReviewStatus,
  type ProjectGoalSpec
} from "./GoalStewardModels.js";

export type GoalStewardOptions = {
  workspacePath: string;
  memoryDir?: string;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  provider?: LlmProvider;
  mode: GoalStewardMode;
  requireActiveProjectGoalSpec: boolean;
};

export type GoalStewardIntegrationInput = {
  run: Run;
  tasks: Task[];
  candidates: IntegrationCandidate[];
};

type GoalStewardProviderFinding = {
  candidate_id?: string;
  task_id?: string;
  finding_type?: GoalStewardFinding["finding_type"];
  severity?: GoalStewardFinding["severity"];
  spec_refs?: string[];
  candidate_refs?: string[];
  rationale?: string;
  recommended_action?: GoalStewardRecommendedAction;
};

type GoalStewardProviderReview = {
  status: GoalStewardReviewStatus;
  rationale: string;
  findings: GoalStewardProviderFinding[];
};

export class ProjectGoalSpecStore {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(options: { workspacePath: string; memoryDir?: string }) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async saveProjectGoalSpec(spec: ProjectGoalSpec): Promise<ProjectGoalSpec> {
    const memory = await ensureMemoryLayout(this.workspacePath, this.memoryDir);
    const specDir = path.join(memory.projectSpecsDir, safeFilePart(spec.spec_id));
    await mkdir(specDir, { recursive: true });
    const artifactRef = path.join(specDir, "project_goal_spec.json");
    const summaryRef = path.join(specDir, "project_goal_spec.md");
    const persisted: ProjectGoalSpec = {
      ...spec,
      artifact_ref: artifactRef,
      summary_ref: summaryRef,
      updated_at: new Date().toISOString()
    };
    await writeJson(artifactRef, persisted);
    await writeFile(summaryRef, projectGoalSpecSummary(persisted), "utf8");
    await this.metadata.recordProjectGoalSpecSaved({ spec: persisted, artifactRef, summaryRef });
    return persisted;
  }

  async loadActiveProjectGoalSpec(): Promise<ProjectGoalSpec | undefined> {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    if (!existsSync(databasePath)) return undefined;
    const store = await FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, readOnly: true });
    let row: { artifact_ref?: string } | undefined;
    try {
      row = store.get<{ artifact_ref?: string }>(
        "SELECT artifact_ref FROM factory_project_goal_specs WHERE status = 'active' ORDER BY version DESC, updated_at DESC LIMIT 1"
      );
    } catch {
      return undefined;
    } finally {
      store.close();
    }
    if (!row?.artifact_ref || !existsSync(row.artifact_ref)) return undefined;
    return await readJson<ProjectGoalSpec>(row.artifact_ref);
  }
}

export class GoalSteward {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly provider?: LlmProvider;
  private readonly mode: GoalStewardMode;
  private readonly requireActiveProjectGoalSpec: boolean;

  constructor(options: GoalStewardOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "GoalSteward" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
    this.provider = options.provider;
    this.mode = options.mode;
    this.requireActiveProjectGoalSpec = options.requireActiveProjectGoalSpec;
  }

  async reviewIntegration(input: GoalStewardIntegrationInput): Promise<GoalStewardReview | undefined> {
    if (!input.candidates.length) return undefined;
    const spec = await new ProjectGoalSpecStore({ workspacePath: this.workspacePath, memoryDir: this.memoryDir }).loadActiveProjectGoalSpec();
    if (!spec) {
      if (!this.requireActiveProjectGoalSpec) return undefined;
      return this.persistReview(input.run.id, missingSpecReview(input.run.id, this.mode, input.candidates.length));
    }

    await this.traceWriter.write({
      run_id: input.run.id,
      event_type: "goal_steward_review_started",
      lifecycle_stage: "integrating",
      summary: "Goal Steward review started for integration candidates.",
      artifact_refs: [spec.artifact_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: { spec_id: spec.spec_id, candidate_count: input.candidates.length, mode: this.mode }
    });

    const batch = await new SemanticConflictResolver({
      workspacePath: this.workspacePath,
      memoryDir: this.memoryDir,
      artifactStore: this.artifactStore,
      traceWriter: new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "SemanticConflictResolver" }),
      provider: this.provider,
      mode: this.mode
    }).resolve({
      runId: input.run.id,
      phase: "integration",
      rootIntent: spec.primary_goal,
      projectGoalSpec: spec,
      sources: semanticSourcesFromIntegration(input),
      metadata_json: { source_component: "GoalSteward.reviewIntegration" }
    });
    return this.persistReview(input.run.id, goalStewardReviewFromSemanticBatch(input.run.id, this.mode, input.candidates.length, spec, batch));
  }

  private async persistReview(runId: string, review: GoalStewardReview): Promise<GoalStewardReview> {
    const paths = await this.artifactStore.ensureRunLayout(runId);
    const reviewDir = path.join(paths.goalStewardDir, safeFilePart(review.review_id));
    await mkdir(reviewDir, { recursive: true });
    const artifactRef = path.join(reviewDir, "goal_steward_review.json");
    const summaryRef = path.join(reviewDir, "goal_steward_review.md");
    const persisted: GoalStewardReview = { ...review, artifact_ref: artifactRef, summary_ref: summaryRef };
    await writeJson(artifactRef, persisted);
    await writeFile(summaryRef, goalStewardReviewSummary(persisted), "utf8");
    await this.metadata.recordGoalStewardReviewSaved({ review: persisted, artifactRef, summaryRef });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "goal_steward_review_completed",
      lifecycle_stage: persisted.findings.some((finding) => finding.severity === "blocking") ? "blocked" : "integrating",
      severity: persisted.findings.some((finding) => finding.severity === "blocking") ? "warning" : "info",
      summary: `Goal Steward review completed: ${persisted.status}.`,
      artifact_refs: [artifactRef, summaryRef, persisted.spec_ref].filter((ref): ref is string => Boolean(ref)),
      metadata_json: {
        review_id: persisted.review_id,
        spec_id: persisted.spec_id,
        status: persisted.status,
        mode: persisted.mode,
        finding_count: persisted.findings.length
      }
    });
    return persisted;
  }
}

function missingSpecReview(runId: string, mode: GoalStewardMode, candidateCount: number) {
  const review = createGoalStewardReview({
    run_id: runId,
    status: "insufficient_spec",
    mode,
    candidate_count: candidateCount,
    rationale: "An active ProjectGoalSpec is required before integration, but none was found.",
    findings: []
  });
  review.findings = [createGoalStewardFinding({
    review_id: review.review_id,
    run_id: runId,
    finding_type: "insufficient_spec",
    severity: mode === "strict" ? "blocking" : "warning",
    spec_refs: [],
    candidate_refs: [],
    rationale: review.rationale,
    recommended_action: "clarify_spec"
  })];
  return review;
}

function unavailableReview(runId: string, mode: GoalStewardMode, candidateCount: number, spec: ProjectGoalSpec, reason: string) {
  const review = createGoalStewardReview({
    run_id: runId,
    spec_id: spec.spec_id,
    spec_ref: spec.artifact_ref,
    status: "provider_unavailable",
    mode,
    candidate_count: candidateCount,
    rationale: `Goal Steward provider was unavailable: ${reason}`,
    findings: []
  });
  review.findings = [createGoalStewardFinding({
    review_id: review.review_id,
    run_id: runId,
    finding_type: "provider_unavailable",
    severity: mode === "strict" ? "blocking" : "warning",
    spec_refs: goalSpecRefs(spec),
    candidate_refs: [],
    rationale: review.rationale,
    recommended_action: mode === "strict" ? "block_integration" : "allow",
    metadata_json: { provider_error: reason }
  })];
  return review;
}

function semanticSourcesFromIntegration(input: GoalStewardIntegrationInput) {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  return input.candidates.map((candidate) => {
    const task = tasksById.get(candidate.task_id);
    return {
      source_id: candidate.candidate_id,
      source_role: task?.role_required ?? "IntegrationCandidate",
      summary: [
        `candidate_id=${candidate.candidate_id}`,
        `task_id=${candidate.task_id}`,
        task?.title ? `task_title=${task.title}` : undefined,
        task?.objective ? `task_objective=${task.objective}` : undefined,
        stringValue(candidate.metadata_json.output_summary) ? `output_summary=${stringValue(candidate.metadata_json.output_summary)}` : undefined,
        candidate.changed_files.length ? `changed_files=${candidate.changed_files.join(", ")}` : undefined
      ].filter(Boolean).join("; "),
      refs: [
        candidate.candidate_id,
        candidate.patch_ref,
        candidate.change_artifact_ref,
        candidate.review_ref,
        candidate.validation_ref
      ].filter((ref): ref is string => Boolean(ref)),
      possible_conflicts: [
        ...stringArray(candidate.metadata_json.possible_intent_conflicts),
        ...stringArray(candidate.metadata_json.intent_conflicts)
      ],
      metadata_json: {
        task_id: candidate.task_id,
        changed_files: candidate.changed_files,
        module_locks: candidate.module_locks,
        semantic_locks: candidate.semantic_locks
      }
    };
  });
}

function goalStewardReviewFromSemanticBatch(
  runId: string,
  mode: GoalStewardMode,
  candidateCount: number,
  spec: ProjectGoalSpec,
  batch: SemanticConflictResolutionBatch
): GoalStewardReview {
  const review = createGoalStewardReview({
    run_id: runId,
    spec_id: spec.spec_id,
    spec_ref: spec.artifact_ref,
    status: semanticBatchStatus(batch),
    mode,
    candidate_count: candidateCount,
    rationale: batch.decisions.length
      ? batch.decisions.map((decision) => `${decision.conflict}: ${decision.decision}`).join(" ")
      : "Semantic Conflict Resolver found no integration goal conflicts.",
    findings: [],
    metadata_json: {
      semantic_conflict_batch_id: batch.batch_id,
      semantic_conflict_batch_ref: batch.artifact_ref,
      semantic_conflict_summary_ref: batch.summary_ref,
      semantic_conflict_status: batch.status
    }
  });
  review.findings = batch.decisions
    .filter((decision) => decision.severity !== "info" || decision.requires_user_approval || decision.status !== "resolved")
    .map((decision) => goalStewardFindingFromSemanticDecision(runId, review.review_id, mode, spec, batch, decision));
  return review;
}

function goalStewardFindingFromSemanticDecision(
  runId: string,
  reviewId: string,
  mode: GoalStewardMode,
  spec: ProjectGoalSpec,
  batch: SemanticConflictResolutionBatch,
  decision: SemanticConflictDecision
) {
  const originalSeverity = decision.severity === "blocking" || decision.requires_user_approval ? "blocking" : decision.severity;
  const severity = mode === "report_only" && originalSeverity === "blocking" ? "warning" : originalSeverity;
  return createGoalStewardFinding({
    review_id: reviewId,
    run_id: runId,
    candidate_id: candidateIdFromDecision(decision),
    finding_type: semanticFindingType(decision),
    severity,
    spec_refs: goalSpecRefs(spec),
    candidate_refs: uniqueStrings([batch.artifact_ref, batch.summary_ref, ...decision.source_refs, ...decision.evidence_refs]),
    rationale: decision.reason,
    recommended_action: semanticRecommendedAction(decision, mode),
    metadata_json: {
      semantic_conflict_batch_id: batch.batch_id,
      semantic_conflict_decision_id: decision.decision_id,
      semantic_conflict: decision.conflict,
      semantic_decision: decision.decision,
      requires_user_approval: decision.requires_user_approval,
      source_a: decision.source_a,
      source_b: decision.source_b
    }
  });
}

function semanticBatchStatus(batch: SemanticConflictResolutionBatch): GoalStewardReviewStatus {
  if (batch.status === "provider_unavailable") return "provider_unavailable";
  if (batch.decisions.some((decision) => decision.requires_user_approval || decision.status === "requires_user_approval")) return "requires_human_approval";
  if (batch.decisions.some((decision) => decision.status === "blocked" || decision.severity === "blocking")) return "conflicts_with_spec";
  return "aligned";
}

function semanticFindingType(decision: SemanticConflictDecision): GoalStewardFinding["finding_type"] {
  if (decision.status === "provider_unavailable") return "provider_unavailable";
  if (decision.requires_user_approval || decision.status === "requires_user_approval") return "requires_human_approval";
  if (decision.status === "blocked" || decision.severity === "blocking") return "conflicts_with_spec";
  return "warning";
}

function semanticRecommendedAction(decision: SemanticConflictDecision, mode: GoalStewardMode): GoalStewardRecommendedAction {
  if (mode === "report_only") return "allow";
  if (decision.status === "provider_unavailable" || decision.status === "blocked") return "block_integration";
  if (decision.requires_user_approval || decision.status === "requires_user_approval") return "require_human_approval";
  return "allow";
}

function candidateIdFromDecision(decision: SemanticConflictDecision) {
  return [decision.source_a, decision.source_b, ...decision.source_refs].find((ref) => /^integration_candidate_/.test(ref));
}

function normalizeProviderReview(
  runId: string,
  mode: GoalStewardMode,
  candidateCount: number,
  spec: ProjectGoalSpec,
  generated: GoalStewardProviderReview
): GoalStewardReview {
  const status = validStatus(generated.status) ? generated.status : "provider_unavailable";
  const review = createGoalStewardReview({
    run_id: runId,
    spec_id: spec.spec_id,
    spec_ref: spec.artifact_ref,
    status,
    mode,
    candidate_count: candidateCount,
    rationale: stringValue(generated.rationale) ?? "Goal Steward provider returned no rationale.",
    findings: []
  });
  const rawFindings = Array.isArray(generated.findings) ? generated.findings : [];
  review.findings = rawFindings.map((finding) => normalizeFinding(runId, review.review_id, mode, spec, finding));
  if (status !== "aligned" && !review.findings.length) {
    review.findings.push(defaultFindingForStatus(runId, review.review_id, mode, spec, status, review.rationale));
  }
  return review;
}

function normalizeFinding(runId: string, reviewId: string, mode: GoalStewardMode, spec: ProjectGoalSpec, finding: GoalStewardProviderFinding): GoalStewardFinding {
  const originalSeverity = validSeverity(finding.severity) ? finding.severity : "warning";
  const severity = mode === "report_only" && originalSeverity === "blocking" ? "warning" : originalSeverity;
  const findingType = validFindingType(finding.finding_type) ? finding.finding_type : severity === "blocking" ? "conflicts_with_spec" : "warning";
  const recommended = validRecommendedAction(finding.recommended_action)
    ? finding.recommended_action
    : severity === "blocking"
      ? "block_integration"
      : "allow";
  return createGoalStewardFinding({
    review_id: reviewId,
    run_id: runId,
    candidate_id: stringValue(finding.candidate_id),
    task_id: stringValue(finding.task_id),
    finding_type: findingType,
    severity,
    spec_refs: stringArray(finding.spec_refs).length ? stringArray(finding.spec_refs) : goalSpecRefs(spec),
    candidate_refs: stringArray(finding.candidate_refs),
    rationale: stringValue(finding.rationale) ?? "Goal Steward provider reported a finding without rationale.",
    recommended_action: mode === "report_only" && recommended === "block_integration" ? "allow" : recommended,
    metadata_json: { original_severity: originalSeverity }
  });
}

function defaultFindingForStatus(runId: string, reviewId: string, mode: GoalStewardMode, spec: ProjectGoalSpec, status: GoalStewardReviewStatus, rationale: string) {
  const findingType = status === "requires_human_approval"
    ? "requires_human_approval"
    : status === "insufficient_spec"
      ? "insufficient_spec"
      : status === "provider_unavailable"
        ? "provider_unavailable"
        : "conflicts_with_spec";
  return createGoalStewardFinding({
    review_id: reviewId,
    run_id: runId,
    finding_type: findingType,
    severity: mode === "strict" ? "blocking" : "warning",
    spec_refs: goalSpecRefs(spec),
    candidate_refs: [],
    rationale,
    recommended_action: status === "requires_human_approval" || status === "insufficient_spec" ? "require_human_approval" : "block_integration"
  });
}

function goalStewardRequest(spec: ProjectGoalSpec, input: GoalStewardIntegrationInput) {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  return {
    purpose: "verify" as const,
    reasoningStage: "verify" as const,
    responseFormat: "json" as const,
    systemPrompt: [
      "You are the provider-authored Goal Steward for a multi-agent coding system.",
      "Your job is to compare proposed integration candidates against the active ProjectGoalSpec.",
      "Do not judge technical merge safety, validation success, or file conflicts.",
      "Only decide whether the candidate intent contradicts, weakens, or attempts to change the project goal.",
      "Return strict JSON only. Do not invent files or refs."
    ].join("\n"),
    userPrompt: [
      "Review these integration candidates against the active ProjectGoalSpec.",
      "Return { status, rationale, findings }.",
      "Use status aligned only when every candidate is compatible with the spec.",
      "Use conflicts_with_spec for direct conceptual conflict.",
      "Use requires_human_approval for strategic goal changes that may be valid only with operator approval.",
      "Use insufficient_spec if the active spec is too ambiguous to decide.",
      "Each blocking finding must name candidate_id or task_id when possible."
    ].join("\n"),
    context: {
      project_goal_spec: spec,
      candidates: input.candidates.map((candidate) => {
        const task = tasksById.get(candidate.task_id);
        return {
          candidate_id: candidate.candidate_id,
          task_id: candidate.task_id,
          task_title: task?.title,
          task_objective: task?.objective,
          output_summary: stringValue(candidate.metadata_json.output_summary),
          changed_files: candidate.changed_files,
          patch_ref: candidate.patch_ref,
          change_artifact_ref: candidate.change_artifact_ref,
          review_ref: candidate.review_ref,
          validation_ref: candidate.validation_ref
        };
      })
    },
    maxContextChars: 48_000,
    maxOutputTokens: 1_024
  };
}

const goalStewardProviderReviewSchema = {
  name: "goal_steward_review",
  type: "object",
  additionalProperties: false,
  required: ["status", "rationale", "findings"],
  properties: {
    status: { type: "string", enum: ["aligned", "conflicts_with_spec", "requires_human_approval", "insufficient_spec", "provider_unavailable"] },
    rationale: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string" },
          task_id: { type: "string" },
          finding_type: { type: "string", enum: ["conflicts_with_spec", "requires_human_approval", "insufficient_spec", "provider_unavailable", "warning"] },
          severity: { type: "string", enum: ["info", "warning", "blocking"] },
          spec_refs: { type: "array", items: { type: "string" } },
          candidate_refs: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          recommended_action: { type: "string", enum: ["allow", "block_integration", "require_human_approval", "clarify_spec"] }
        }
      }
    }
  }
};

function projectGoalSpecSummary(spec: ProjectGoalSpec) {
  return [
    `# ${spec.title}`,
    "",
    `- spec_id: ${spec.spec_id}`,
    `- status: ${spec.status}`,
    `- version: ${spec.version}`,
    `- primary_goal: ${spec.primary_goal}`,
    "",
    "## Non-Goals",
    ...(spec.non_goals.length ? spec.non_goals.map((item) => `- ${item}`) : ["- none recorded"]),
    "",
    "## Tradeoffs",
    ...(spec.tradeoffs.length ? spec.tradeoffs.map((tradeoff) => `- ${tradeoff.name}: prefer ${tradeoff.prefer} over ${tradeoff.over}${tradeoff.rationale ? `; ${tradeoff.rationale}` : ""}`) : ["- none recorded"]),
    "",
    "## Constraints",
    ...(spec.constraints.length ? spec.constraints.map((item) => `- ${item}`) : ["- none recorded"])
  ].join("\n");
}

function goalStewardReviewSummary(review: GoalStewardReview) {
  return [
    `# Goal Steward Review ${review.status}`,
    "",
    `- review_id: ${review.review_id}`,
    `- run_id: ${review.run_id}`,
    `- spec_id: ${review.spec_id ?? "n/a"}`,
    `- mode: ${review.mode}`,
    `- candidate_count: ${review.candidate_count}`,
    `- finding_count: ${review.findings.length}`,
    "",
    review.rationale,
    "",
    "## Findings",
    ...(review.findings.length
      ? review.findings.map((finding) => `- ${finding.severity}: ${finding.finding_type}${finding.candidate_id ? ` (${finding.candidate_id})` : ""}: ${finding.rationale}`)
      : ["- none"])
  ].join("\n");
}

function goalSpecRefs(spec: ProjectGoalSpec) {
  return [spec.artifact_ref, spec.summary_ref, ...spec.source_refs].filter((ref): ref is string => Boolean(ref));
}

function validStatus(value: unknown): value is GoalStewardReviewStatus {
  return typeof value === "string" && ["aligned", "conflicts_with_spec", "requires_human_approval", "insufficient_spec", "provider_unavailable"].includes(value);
}

function validSeverity(value: unknown): value is GoalStewardFinding["severity"] {
  return typeof value === "string" && ["info", "warning", "blocking"].includes(value);
}

function validFindingType(value: unknown): value is GoalStewardFinding["finding_type"] {
  return typeof value === "string" && ["conflicts_with_spec", "requires_human_approval", "insufficient_spec", "provider_unavailable", "warning"].includes(value);
}

function validRecommendedAction(value: unknown): value is GoalStewardRecommendedAction {
  return typeof value === "string" && ["allow", "block_integration", "require_human_approval", "clarify_spec"].includes(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((entry): entry is string => Boolean(entry)))].sort();
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "item";
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
