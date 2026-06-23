import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IntentContract } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { appendJsonl, readJson, resolveMemoryPaths, writeJson } from "../memory/ProjectMemory.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import {
  INTENT_LEDGER_SCHEMA_VERSION,
  type ContextLedgerEntry,
  type ContextLedgerEntryKind,
  type IntentContextSnapshot,
  type IntentRewriteSuggestion,
  type IntentRewriteTarget,
  type IntentReviewFinding,
  type IntentReviewResult,
  type IntentReviewStage,
  type IntentReviewStatus,
  type IntentRunKind,
  type LockedIntentDefinition,
  type OriginalRequestArtifact
} from "./IntentLedgerModels.js";

export type IntentLedgerServiceOptions = {
  workspacePath: string;
  memoryDir?: string;
  sourceComponent?: string;
};

export type IntentReviewInput = {
  runId: string;
  runKind: IntentRunKind;
  artifactsPath: string;
  stage: IntentReviewStage;
  target?: IntentRewriteTarget;
  reviewedArtifactRefs: string[];
  parentContextRefs?: string[];
  parentContext?: unknown;
  candidate: unknown;
  provider?: LlmProvider;
};

type ProviderIntentReview = {
  status: IntentReviewStatus;
  rationale: string;
  findings: Array<{
    severity?: IntentReviewFinding["severity"];
    finding_type?: IntentReviewFinding["finding_type"];
    rationale?: string;
    evidence_refs?: string[];
    recommended_action?: IntentReviewFinding["recommended_action"];
  }>;
};

type ProviderIntentRewriteSuggestion = {
  target?: IntentRewriteTarget;
  rationale?: string;
  rewritten_prompt?: string;
  rewritten_output_summary?: string;
  smarter_solution?: string;
  additional_context_needed?: string[];
  parent_context_refs?: string[];
};

export class IntentLedgerService {
  private readonly metadata: FactoryMetadataAdapter;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly sourceComponent: string;

  constructor(private readonly options: IntentLedgerServiceOptions) {
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.traceWriter = new FactoryTraceWriter({
      workspacePath: options.workspacePath,
      memoryDir: options.memoryDir,
      sourceComponent: options.sourceComponent ?? "IntentLedgerService"
    });
    this.sourceComponent = options.sourceComponent ?? "IntentLedgerService";
  }

  async saveOriginalRequest(input: {
    runId: string;
    runKind: IntentRunKind;
    artifactsPath: string;
    originalRequest: string;
    metadata?: Record<string, unknown>;
  }): Promise<OriginalRequestArtifact> {
    const paths = await this.pathsForArtifacts(input.artifactsPath);
    const now = new Date().toISOString();
    const requestHash = sha256(input.originalRequest);
    const artifact: OriginalRequestArtifact = {
      schema_version: INTENT_LEDGER_SCHEMA_VERSION,
      run_id: input.runId,
      run_kind: input.runKind,
      original_request: input.originalRequest,
      request_hash: requestHash,
      source: "user",
      created_at: now,
      artifact_ref: paths.originalRequestJson,
      summary_ref: paths.originalRequestMd,
      metadata_json: input.metadata ?? {}
    };
    await writeJson(paths.originalRequestJson, artifact);
    await writeFile(paths.originalRequestMd, originalRequestMarkdown(artifact), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "original_user_request",
      artifactRef: paths.originalRequestJson,
      status: "recorded",
      createdAt: now,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        request_hash: requestHash,
        summary_ref: paths.originalRequestMd
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "original_user_request_summary",
      artifactRef: paths.originalRequestMd,
      status: "recorded",
      createdAt: now,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        request_hash: requestHash,
        artifact_ref: paths.originalRequestJson
      }
    });
    await this.appendLedgerEntry({
      runId: input.runId,
      runKind: input.runKind,
      artifactsPath: input.artifactsPath,
      entryKind: "original_request_recorded",
      summary: "Original user request artifact recorded as canonical intent source.",
      artifactRefs: [paths.originalRequestJson, paths.originalRequestMd],
      metadata: { request_hash: requestHash }
    });
    await this.traceWriter.write({
      run_id: input.runId,
      event_type: "metadata_record_written",
      lifecycle_stage: "intake",
      summary: "Original user request artifact recorded.",
      artifact_refs: [paths.originalRequestJson, paths.originalRequestMd],
      metadata_json: {
        run_kind: input.runKind,
        request_hash: requestHash
      }
    });
    return artifact;
  }

  async saveIntentContract(input: {
    runId: string;
    runKind: IntentRunKind;
    artifactsPath: string;
    contract: IntentContract;
  }): Promise<IntentContract> {
    const paths = await this.pathsForArtifacts(input.artifactsPath);
    const revisions = await this.loadContractRevisionsFromPath(paths.intentContractRevisionsJsonl);
    const now = new Date().toISOString();
    const revision = revisions.length + 1;
    const artifactRef = paths.intentContractJson;
    const summaryRef = paths.intentContractMd;
    const persisted: IntentContract = {
      ...input.contract,
      run_id: input.runId,
      run_kind: input.runKind,
      revision,
      artifact_ref: artifactRef,
      summary_ref: summaryRef,
      created_at: input.contract.created_at || now
    };
    await writeJson(artifactRef, persisted);
    await writeFile(summaryRef, intentContractMarkdown(persisted), "utf8");
    await appendJsonl(paths.intentContractRevisionsJsonl, persisted);
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "intent_contract",
      artifactRef,
      status: persisted.status,
      createdAt: persisted.created_at,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        contract_id: persisted.contract_id,
        revision,
        status: persisted.status,
        summary_ref: summaryRef,
        blocking_question_count: persisted.missing_questions.filter((question) => question.blocking).length
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "intent_contract_summary",
      artifactRef: summaryRef,
      status: persisted.status,
      createdAt: persisted.created_at,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        contract_id: persisted.contract_id,
        revision,
        artifact_ref: artifactRef
      }
    });
    await this.appendLedgerEntry({
      runId: input.runId,
      runKind: input.runKind,
      artifactsPath: input.artifactsPath,
      entryKind: "intent_contract_compiled",
      summary: `Intent contract compiled with status ${persisted.status}.`,
      artifactRefs: [artifactRef, summaryRef],
      metadata: {
        contract_id: persisted.contract_id,
        revision,
        status: persisted.status
      }
    });
    await this.traceWriter.write({
      run_id: input.runId,
      event_type: "intent_contract_compiled",
      lifecycle_stage: persisted.status === "ready" ? "intake" : "blocked",
      severity: persisted.status === "ready" ? "info" : "warning",
      summary: `Intent contract compiled with status ${persisted.status}.`,
      artifact_refs: [artifactRef, summaryRef],
      metadata_json: {
        run_kind: input.runKind,
        contract_id: persisted.contract_id,
        revision,
        status: persisted.status
      }
    });
    return persisted;
  }

  async appendLedgerEntry(input: {
    runId: string;
    runKind: IntentRunKind;
    artifactsPath: string;
    entryKind: ContextLedgerEntryKind;
    summary: string;
    artifactRefs: string[];
    metadata?: Record<string, unknown>;
  }): Promise<ContextLedgerEntry> {
    const paths = await this.pathsForArtifacts(input.artifactsPath);
    const entries = await this.loadLedgerEntriesFromPath(paths.ledgerJsonl);
    const now = new Date().toISOString();
    const entry: ContextLedgerEntry = {
      schema_version: INTENT_LEDGER_SCHEMA_VERSION,
      ledger_entry_id: `intent_ledger_${randomUUID()}`,
      run_id: input.runId,
      run_kind: input.runKind,
      revision: entries.length + 1,
      entry_kind: input.entryKind,
      summary: input.summary,
      artifact_refs: uniqueStrings(input.artifactRefs),
      source_component: this.sourceComponent,
      created_at: now,
      metadata_json: input.metadata ?? {}
    };
    await appendJsonl(paths.ledgerJsonl, entry);
    await writeJson(paths.ledgerSnapshotJson, {
      schema_version: INTENT_LEDGER_SCHEMA_VERSION,
      run_id: input.runId,
      run_kind: input.runKind,
      latest_revision: entry.revision,
      entries: [...entries, entry],
      updated_at: now
    });
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "intent_ledger",
      artifactRef: paths.ledgerSnapshotJson,
      status: "updated",
      createdAt: now,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        latest_revision: entry.revision,
        entry_kind: input.entryKind,
        ledger_jsonl_ref: paths.ledgerJsonl
      }
    });
    return entry;
  }

  async saveLockedDefinition(input: {
    runId: string;
    runKind: IntentRunKind;
    artifactsPath: string;
    term: string;
    definition: string;
    source: LockedIntentDefinition["source"];
    approvalRef?: string;
    supersedesDefinitionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<LockedIntentDefinition> {
    const paths = await this.pathsForArtifacts(input.artifactsPath);
    const definitions = await this.loadLockedDefinitionsFromPath(paths.lockedDefinitionsJson);
    const now = new Date().toISOString();
    const definition: LockedIntentDefinition = {
      schema_version: INTENT_LEDGER_SCHEMA_VERSION,
      definition_id: `locked_intent_${randomUUID()}`,
      run_id: input.runId,
      run_kind: input.runKind,
      revision: definitions.length + 1,
      term: input.term,
      definition: input.definition,
      source: input.source,
      approval_ref: input.approvalRef,
      supersedes_definition_id: input.supersedesDefinitionId,
      created_at: now,
      artifact_ref: paths.lockedDefinitionsJson,
      metadata_json: input.metadata ?? {}
    };
    await writeJson(paths.lockedDefinitionsJson, [...definitions, definition]);
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "locked_intent_definitions",
      artifactRef: paths.lockedDefinitionsJson,
      status: "updated",
      createdAt: now,
      updatedAt: now,
      metadata: {
        run_kind: input.runKind,
        definition_count: definitions.length + 1,
        latest_definition_id: definition.definition_id
      }
    });
    await this.appendLedgerEntry({
      runId: input.runId,
      runKind: input.runKind,
      artifactsPath: input.artifactsPath,
      entryKind: "locked_definition_recorded",
      summary: `Locked intent definition recorded: ${input.term}.`,
      artifactRefs: [paths.lockedDefinitionsJson, input.approvalRef ?? ""].filter(Boolean),
      metadata: { definition_id: definition.definition_id, source: input.source }
    });
    return definition;
  }

  async loadContext(runId: string, runKind: IntentRunKind = "core", artifactsPath?: string): Promise<IntentContextSnapshot> {
    const base = artifactsPath ?? this.defaultArtifactsPath(runId, runKind);
    const paths = await this.pathsForArtifacts(base);
    const original = existsSync(paths.originalRequestJson)
      ? await readJson<OriginalRequestArtifact>(paths.originalRequestJson)
      : undefined;
    const intentContract = existsSync(paths.intentContractJson)
      ? await readJson<IntentContract>(paths.intentContractJson)
      : undefined;
    const locked = await this.loadLockedDefinitionsFromPath(paths.lockedDefinitionsJson);
    const latestReview = await this.loadLatestReviewFromPath(paths.reviewsDir);
    const refs = uniqueStrings([
      paths.ledgerSnapshotJson,
      paths.ledgerJsonl,
      original?.artifact_ref,
      original?.summary_ref,
      intentContract?.artifact_ref,
      intentContract?.summary_ref,
      locked.length ? paths.lockedDefinitionsJson : "",
      latestReview?.artifact_ref,
      latestReview?.summary_ref
    ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0 && existsSync(ref)));
    return {
      original_request: original,
      original_request_ref: original?.artifact_ref,
      original_request_hash: original?.request_hash,
      intent_contract: intentContract,
      intent_contract_ref: intentContract?.artifact_ref,
      intent_contract_status: intentContract?.status,
      intent_ledger_ref: existsSync(paths.ledgerSnapshotJson) ? paths.ledgerSnapshotJson : undefined,
      intent_ledger_refs: refs,
      locked_definitions: locked,
      latest_review: latestReview
    };
  }

  async reviewIntent(input: IntentReviewInput): Promise<IntentReviewResult> {
    const paths = await this.pathsForArtifacts(input.artifactsPath);
    const context = await this.loadContext(input.runId, input.runKind, input.artifactsPath);
    let providerResult: ProviderIntentReview | undefined;
    if (input.provider && context.original_request) {
      try {
        providerResult = await invokeReasoningProviderStructured<ProviderIntentReview>(input.provider, {
          purpose: "verify",
          reasoningStage: "verify",
          responseFormat: "json",
          systemPrompt: [
            "You are IntentReviewer, a read-only reviewer for a multi-agent coding system.",
            "Compare the candidate plan or result only against the canonical original user request and locked intent definitions.",
            "Do not judge technical correctness, merge safety, or tests.",
            "Return strict JSON only. Do not invent artifact refs."
          ].join("\n"),
          userPrompt: [
            `Review stage: ${input.stage}.`,
            "Use aligned only when the candidate remains compatible with the original request.",
            "Use possible_drift when intent may have widened or narrowed without enough proof.",
            "Use drift_detected when the candidate contradicts or materially changes the request.",
            "Use insufficient_context when there is not enough evidence to judge."
          ].join("\n"),
          context: {
            original_request: context.original_request,
            locked_definitions: context.locked_definitions,
            reviewed_artifact_refs: input.reviewedArtifactRefs,
            parent_context_refs: input.parentContextRefs ?? [],
            parent_context: input.parentContext,
            candidate: input.candidate
          },
          maxContextChars: 48_000,
          maxOutputTokens: 1_024
        }, intentReviewSchema);
      } catch {
        providerResult = undefined;
      }
    }
    const review = normalizeReview({
      runId: input.runId,
      runKind: input.runKind,
      stage: input.stage,
      providerUsed: Boolean(providerResult),
      originalRequestRef: context.original_request_ref,
      intentLedgerRef: context.intent_ledger_ref,
      reviewedArtifactRefs: input.reviewedArtifactRefs,
      providerResult
    });
    const reviewDir = path.join(paths.reviewsDir, review.review_id);
    await mkdir(reviewDir, { recursive: true });
    const artifactRef = path.join(reviewDir, "intent_review.json");
    const summaryRef = path.join(reviewDir, "intent_review.md");
    let persisted: IntentReviewResult = { ...review, artifact_ref: artifactRef, summary_ref: summaryRef };
    const rewriteSuggestion = await this.createRewriteSuggestionIfNeeded({
      input,
      context,
      review: persisted,
      reviewDir
    });
    if (rewriteSuggestion?.artifact_ref) {
      persisted = {
        ...persisted,
        rewrite_suggestion_ref: rewriteSuggestion.artifact_ref,
        metadata_json: {
          ...persisted.metadata_json,
          rewrite_suggestion_ref: rewriteSuggestion.artifact_ref
        }
      };
    }
    await writeJson(artifactRef, persisted);
    await writeFile(summaryRef, intentReviewMarkdown(persisted), "utf8");
    await this.metadata.recordArtifactSaved({
      runId: input.runId,
      kind: "intent_review",
      artifactRef,
      status: persisted.status,
      createdAt: persisted.created_at,
      updatedAt: persisted.created_at,
      metadata: {
        run_kind: input.runKind,
        stage: input.stage,
        provider_used: persisted.provider_used,
        summary_ref: summaryRef,
        finding_count: persisted.findings.length,
        rewrite_suggestion_ref: persisted.rewrite_suggestion_ref
      }
    });
    await this.appendLedgerEntry({
      runId: input.runId,
      runKind: input.runKind,
      artifactsPath: input.artifactsPath,
      entryKind: input.stage === "initial" ? "initial_intent_review" : "final_intent_review",
      summary: `Intent review ${input.stage} completed: ${persisted.status}.`,
      artifactRefs: [artifactRef, summaryRef, ...input.reviewedArtifactRefs],
      metadata: {
        review_id: persisted.review_id,
        status: persisted.status,
        provider_used: persisted.provider_used
      }
    });
    await this.traceWriter.write({
      run_id: input.runId,
      event_type: "review_completed",
      lifecycle_stage: input.stage === "initial" ? "planning" : "reporting",
      severity: persisted.status === "drift_detected" ? "warning" : "info",
      summary: `Intent review ${input.stage} completed: ${persisted.status}.`,
      artifact_refs: [artifactRef, summaryRef],
      metadata_json: {
        run_kind: input.runKind,
        review_id: persisted.review_id,
        status: persisted.status,
        provider_used: persisted.provider_used
      }
    });
    return persisted;
  }

  async saveRuntimeLockedDefinition(input: {
    sessionId: string;
    workspacePath: string;
    term: string;
    definition: string;
    source: LockedIntentDefinition["source"];
    approvalRef?: string;
  }): Promise<LockedIntentDefinition> {
    const artifactsPath = path.join(resolveMemoryPaths(input.workspacePath, this.options.memoryDir).rootDir, "runtime_intents", input.sessionId);
    return this.saveLockedDefinition({
      runId: input.sessionId,
      runKind: "runtime_session",
      artifactsPath,
      term: input.term,
      definition: input.definition,
      source: input.source,
      approvalRef: input.approvalRef
    });
  }

  private async createRewriteSuggestionIfNeeded(input: {
    input: IntentReviewInput;
    context: IntentContextSnapshot;
    review: IntentReviewResult;
    reviewDir: string;
  }): Promise<IntentRewriteSuggestion | undefined> {
    if (!input.input.provider || !input.context.original_request) return undefined;
    if (input.review.status !== "possible_drift" && input.review.status !== "drift_detected") return undefined;
    try {
      const providerSuggestion = await invokeReasoningProviderStructured<ProviderIntentRewriteSuggestion>(input.input.provider, {
        purpose: "repair",
        reasoningStage: "repair",
        responseFormat: "json",
        systemPrompt: [
          "You are IntentRewriteAdvisor for a multi-agent coding system.",
          "A prior read-only IntentReviewer found possible or confirmed drift.",
          "Rewrite only the drifting prompt/output summary or propose a smarter next-step plan that restores alignment with the canonical user request.",
          "Use the original user request, locked intent definitions, parent orchestrator context refs, and main goal context when present.",
          "Do not claim execution, tests, or file changes. Return strict JSON only."
        ].join("\n"),
        userPrompt: "Create an auditable rewrite suggestion for the drifting prompt/output/plan.",
        context: {
          review: input.review,
          target: input.input.target ?? "unknown",
          original_request: input.context.original_request,
          locked_definitions: input.context.locked_definitions,
          intent_ledger_refs: input.context.intent_ledger_refs,
          reviewed_artifact_refs: input.input.reviewedArtifactRefs,
          parent_context_refs: input.input.parentContextRefs ?? [],
          parent_context: input.input.parentContext,
          candidate: input.input.candidate
        },
        maxContextChars: 48_000,
        maxOutputTokens: 1_536
      }, intentRewriteSuggestionSchema);
      const now = new Date().toISOString();
      const suggestion: IntentRewriteSuggestion = {
        schema_version: INTENT_LEDGER_SCHEMA_VERSION,
        suggestion_id: `intent_rewrite_${randomUUID()}`,
        run_id: input.input.runId,
        run_kind: input.input.runKind,
        review_id: input.review.review_id,
        stage: input.input.stage,
        target: validRewriteTarget(providerSuggestion.target) ? providerSuggestion.target : input.input.target ?? "unknown",
        status: providerSuggestion.rewritten_prompt || providerSuggestion.rewritten_output_summary || providerSuggestion.smarter_solution
          ? "suggested"
          : "not_available",
        source: "provider",
        original_request_ref: input.context.original_request_ref,
        intent_ledger_ref: input.context.intent_ledger_ref,
        parent_context_refs: uniqueStrings([
          ...(input.input.parentContextRefs ?? []),
          ...(providerSuggestion.parent_context_refs ?? [])
        ]),
        rationale: nonEmptyString(providerSuggestion.rationale, "Provider did not provide a rewrite rationale."),
        rewritten_prompt: nonEmptyOptional(providerSuggestion.rewritten_prompt),
        rewritten_output_summary: nonEmptyOptional(providerSuggestion.rewritten_output_summary),
        smarter_solution: nonEmptyOptional(providerSuggestion.smarter_solution),
        additional_context_needed: asStringArray(providerSuggestion.additional_context_needed),
        created_at: now,
        metadata_json: {
          review_status: input.review.status,
          reviewed_artifact_refs: input.input.reviewedArtifactRefs
        }
      };
      const artifactRef = path.join(input.reviewDir, "intent_rewrite_suggestion.json");
      const summaryRef = path.join(input.reviewDir, "intent_rewrite_suggestion.md");
      const persisted: IntentRewriteSuggestion = { ...suggestion, artifact_ref: artifactRef, summary_ref: summaryRef };
      await writeJson(artifactRef, persisted);
      await writeFile(summaryRef, intentRewriteSuggestionMarkdown(persisted), "utf8");
      await this.metadata.recordArtifactSaved({
        runId: input.input.runId,
        kind: "intent_rewrite_suggestion",
        artifactRef,
        status: persisted.status,
        createdAt: persisted.created_at,
        updatedAt: persisted.created_at,
        metadata: {
          run_kind: input.input.runKind,
          review_id: input.review.review_id,
          review_status: input.review.status,
          summary_ref: summaryRef
        }
      });
      await this.appendLedgerEntry({
        runId: input.input.runId,
        runKind: input.input.runKind,
        artifactsPath: input.input.artifactsPath,
        entryKind: "intent_rewrite_suggested",
        summary: `Intent rewrite suggestion recorded for ${input.review.status}.`,
        artifactRefs: [artifactRef, summaryRef, ...persisted.parent_context_refs],
        metadata: {
          review_id: input.review.review_id,
          target: persisted.target,
          status: persisted.status
        }
      });
      await this.traceWriter.write({
        run_id: input.input.runId,
        event_type: "metadata_record_written",
        lifecycle_stage: input.input.stage === "initial" ? "planning" : "reporting",
        severity: "warning",
        summary: `Intent rewrite suggestion recorded for ${input.review.status}.`,
        artifact_refs: [artifactRef, summaryRef],
        metadata_json: {
          run_kind: input.input.runKind,
          review_id: input.review.review_id,
          target: persisted.target,
          status: persisted.status
        }
      });
      return persisted;
    } catch {
      return undefined;
    }
  }

  private async pathsForArtifacts(artifactsPath: string) {
    const intentDir = path.join(artifactsPath, "intent");
    const reviewsDir = path.join(intentDir, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    return {
      intentDir,
      reviewsDir,
      originalRequestJson: path.join(intentDir, "original_request.json"),
      originalRequestMd: path.join(intentDir, "original_request.md"),
      intentContractJson: path.join(intentDir, "intent_contract.json"),
      intentContractMd: path.join(intentDir, "intent_contract.md"),
      intentContractRevisionsJsonl: path.join(intentDir, "intent_contract_revisions.jsonl"),
      ledgerJsonl: path.join(intentDir, "context_ledger.jsonl"),
      ledgerSnapshotJson: path.join(intentDir, "intent_ledger.json"),
      lockedDefinitionsJson: path.join(intentDir, "locked_definitions.json")
    };
  }

  private defaultArtifactsPath(runId: string, runKind: IntentRunKind) {
    const memoryRoot = resolveMemoryPaths(this.options.workspacePath, this.options.memoryDir).rootDir;
    if (runKind === "swarm") return path.join(memoryRoot, "swarm_runs", runId);
    if (runKind === "runtime_session") return path.join(memoryRoot, "runtime_intents", runId);
    return path.join(memoryRoot, "runs", runId);
  }

  private async loadLedgerEntriesFromPath(filePath: string): Promise<ContextLedgerEntry[]> {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ContextLedgerEntry);
  }

  private async loadLockedDefinitionsFromPath(filePath: string): Promise<LockedIntentDefinition[]> {
    if (!existsSync(filePath)) return [];
    return await readJson<LockedIntentDefinition[]>(filePath);
  }

  private async loadContractRevisionsFromPath(filePath: string): Promise<IntentContract[]> {
    if (!existsSync(filePath)) return [];
    const raw = await readFile(filePath, "utf8");
    return raw.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as IntentContract);
  }

  private async loadLatestReviewFromPath(reviewsDir: string): Promise<IntentReviewResult | undefined> {
    if (!existsSync(reviewsDir)) return undefined;
    const { readdir } = await import("node:fs/promises");
    const dirs = await readdir(reviewsDir, { withFileTypes: true });
    const reviews: IntentReviewResult[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const reviewPath = path.join(reviewsDir, dir.name, "intent_review.json");
      if (existsSync(reviewPath)) reviews.push(await readJson<IntentReviewResult>(reviewPath));
    }
    return reviews.sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
  }
}

function normalizeReview(input: {
  runId: string;
  runKind: IntentRunKind;
  stage: IntentReviewStage;
  providerUsed: boolean;
  originalRequestRef?: string;
  intentLedgerRef?: string;
  reviewedArtifactRefs: string[];
  providerResult?: ProviderIntentReview;
}): IntentReviewResult {
  const now = new Date().toISOString();
  if (!input.providerResult) {
    return {
      schema_version: INTENT_LEDGER_SCHEMA_VERSION,
      review_id: `intent_review_${randomUUID()}`,
      run_id: input.runId,
      run_kind: input.runKind,
      stage: input.stage,
      status: "insufficient_context",
      mode: "report_only",
      original_request_ref: input.originalRequestRef,
      intent_ledger_ref: input.intentLedgerRef,
      reviewed_artifact_refs: uniqueStrings(input.reviewedArtifactRefs),
      rationale: "IntentReviewer could not make a semantic judgment because no provider-authored review was available.",
      findings: [finding("insufficient_context", "warning", "Provider-backed IntentReviewer was unavailable; no local semantic alignment fallback was used.", [input.originalRequestRef, input.intentLedgerRef])],
      provider_used: false,
      created_at: now,
      metadata_json: {}
    };
  }
  const status = validStatus(input.providerResult.status) ? input.providerResult.status : "insufficient_context";
  const findings = Array.isArray(input.providerResult.findings)
    ? input.providerResult.findings.map((item) => finding(
      validFindingType(item.finding_type) ? item.finding_type : status,
      validSeverity(item.severity) ? item.severity : status === "aligned" ? "info" : "warning",
      typeof item.rationale === "string" && item.rationale.trim() ? item.rationale : input.providerResult!.rationale,
      Array.isArray(item.evidence_refs) ? item.evidence_refs.filter((ref): ref is string => typeof ref === "string") : [],
      validRecommendedAction(item.recommended_action) ? item.recommended_action : status === "aligned" ? "allow" : "review_manually"
    ))
    : [];
  return {
    schema_version: INTENT_LEDGER_SCHEMA_VERSION,
    review_id: `intent_review_${randomUUID()}`,
    run_id: input.runId,
    run_kind: input.runKind,
    stage: input.stage,
    status,
    mode: "report_only",
    original_request_ref: input.originalRequestRef,
    intent_ledger_ref: input.intentLedgerRef,
    reviewed_artifact_refs: uniqueStrings(input.reviewedArtifactRefs),
    rationale: input.providerResult.rationale || `Intent review completed with status ${status}.`,
    findings: findings.length ? findings : [finding(status, status === "aligned" ? "info" : "warning", input.providerResult.rationale || `Intent review status: ${status}.`, [input.originalRequestRef, input.intentLedgerRef])],
    provider_used: input.providerUsed,
    created_at: now,
    metadata_json: {}
  };
}

function finding(
  type: IntentReviewFinding["finding_type"],
  severity: IntentReviewFinding["severity"],
  rationale: string,
  refs: Array<string | undefined>,
  action: IntentReviewFinding["recommended_action"] = type === "aligned" ? "allow" : "review_manually"
): IntentReviewFinding {
  return {
    finding_id: `intent_finding_${randomUUID()}`,
    severity,
    finding_type: type,
    rationale,
    evidence_refs: uniqueStrings(refs.filter((ref): ref is string => Boolean(ref))),
    recommended_action: action
  };
}

function originalRequestMarkdown(artifact: OriginalRequestArtifact) {
  return [
    "# Original User Request",
    "",
    `- run_id: ${artifact.run_id}`,
    `- run_kind: ${artifact.run_kind}`,
    `- request_hash: ${artifact.request_hash}`,
    `- source: ${artifact.source}`,
    `- created_at: ${artifact.created_at}`,
    "",
    "## Request",
    "",
    artifact.original_request
  ].join("\n");
}

function intentContractMarkdown(contract: IntentContract) {
  return [
    "# Intent Contract",
    "",
    `- contract_id: ${contract.contract_id}`,
    `- run_id: ${contract.run_id}`,
    `- run_kind: ${contract.run_kind}`,
    `- revision: ${contract.revision}`,
    `- status: ${contract.status}`,
    `- created_at: ${contract.created_at}`,
    "",
    "## Original Request",
    "",
    contract.original_user_request,
    "",
    "## Precise Rewrite",
    "",
    contract.precise_rewrite,
    "",
    "## Priorities",
    ...Object.entries(contract.priorities).map(([key, value]) => `- ${key}: ${value.score} (${value.rationale})`),
    "",
    "## Missing Questions",
    ...(contract.missing_questions.length
      ? contract.missing_questions.map((question) => `- ${question.blocking ? "blocking" : "non-blocking"}: ${question.question} (${question.reason})`)
      : ["- none"]),
    "",
    "## Assumptions",
    ...(contract.assumptions.length ? contract.assumptions.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Tradeoffs",
    ...(contract.tradeoffs.length
      ? contract.tradeoffs.map((tradeoff) => `- ${tradeoff.name}: ${tradeoff.preferred ?? "unspecified"}${tradeoff.rationale ? ` (${tradeoff.rationale})` : ""}`)
      : ["- none"]),
    "",
    "## Definition Of Done",
    ...(contract.definition_of_done.length ? contract.definition_of_done.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Non-Goals",
    ...(contract.non_goals.length ? contract.non_goals.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Conflict Rules",
    ...(contract.conflict_rules.length ? contract.conflict_rules.map((item) => `- ${item}`) : ["- none"])
  ].join("\n");
}

function intentReviewMarkdown(review: IntentReviewResult) {
  return [
    `# Intent Review ${review.stage}: ${review.status}`,
    "",
    `- review_id: ${review.review_id}`,
    `- run_id: ${review.run_id}`,
    `- mode: ${review.mode}`,
    `- provider_used: ${review.provider_used}`,
    `- original_request_ref: ${review.original_request_ref ?? "n/a"}`,
    `- intent_ledger_ref: ${review.intent_ledger_ref ?? "n/a"}`,
    `- rewrite_suggestion_ref: ${review.rewrite_suggestion_ref ?? "n/a"}`,
    "",
    review.rationale,
    "",
    "## Findings",
    ...(review.findings.length
      ? review.findings.map((item) => `- ${item.severity}: ${item.finding_type}: ${item.rationale}`)
      : ["- none"])
  ].join("\n");
}

function intentRewriteSuggestionMarkdown(suggestion: IntentRewriteSuggestion) {
  return [
    `# Intent Rewrite Suggestion: ${suggestion.status}`,
    "",
    `- suggestion_id: ${suggestion.suggestion_id}`,
    `- review_id: ${suggestion.review_id}`,
    `- run_id: ${suggestion.run_id}`,
    `- target: ${suggestion.target}`,
    `- source: ${suggestion.source}`,
    `- original_request_ref: ${suggestion.original_request_ref ?? "n/a"}`,
    `- intent_ledger_ref: ${suggestion.intent_ledger_ref ?? "n/a"}`,
    "",
    "## Rationale",
    suggestion.rationale,
    "",
    "## Rewrite",
    suggestion.rewritten_prompt ? `Prompt:\n\n${suggestion.rewritten_prompt}` : "",
    suggestion.rewritten_output_summary ? `Output summary:\n\n${suggestion.rewritten_output_summary}` : "",
    suggestion.smarter_solution ? `Smarter solution:\n\n${suggestion.smarter_solution}` : "",
    suggestion.rewritten_prompt || suggestion.rewritten_output_summary || suggestion.smarter_solution ? "" : "No provider rewrite was available.",
    "## Additional Context Needed",
    ...(suggestion.additional_context_needed.length ? suggestion.additional_context_needed.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Parent Context Refs",
    ...(suggestion.parent_context_refs.length ? suggestion.parent_context_refs.map((ref) => `- ${ref}`) : ["- none"])
  ].filter((line) => line !== "").join("\n");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function validStatus(value: unknown): value is IntentReviewStatus {
  return typeof value === "string" && ["aligned", "possible_drift", "drift_detected", "insufficient_context"].includes(value);
}

function validSeverity(value: unknown): value is IntentReviewFinding["severity"] {
  return typeof value === "string" && ["info", "warning", "blocking"].includes(value);
}

function validFindingType(value: unknown): value is IntentReviewFinding["finding_type"] {
  return typeof value === "string" && ["aligned", "possible_drift", "drift_detected", "insufficient_context", "provider_unavailable"].includes(value);
}

function validRecommendedAction(value: unknown): value is IntentReviewFinding["recommended_action"] {
  return typeof value === "string" && ["allow", "review_manually", "clarify_intent"].includes(value);
}

function validRewriteTarget(value: unknown): value is IntentRewriteTarget {
  return typeof value === "string" && ["prompt", "output", "plan", "final_report", "swarm_context", "unknown"].includes(value);
}

function nonEmptyOptional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonEmptyString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())) : [];
}

const intentReviewSchema = {
  name: "intent_review_result",
  type: "object",
  additionalProperties: false,
  required: ["status", "rationale", "findings"],
  properties: {
    status: { type: "string", enum: ["aligned", "possible_drift", "drift_detected", "insufficient_context"] },
    rationale: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["info", "warning", "blocking"] },
          finding_type: { type: "string", enum: ["aligned", "possible_drift", "drift_detected", "insufficient_context", "provider_unavailable"] },
          rationale: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
          recommended_action: { type: "string", enum: ["allow", "review_manually", "clarify_intent"] }
        }
      }
    }
  }
};

const intentRewriteSuggestionSchema = {
  name: "intent_rewrite_suggestion",
  type: "object",
  additionalProperties: false,
  required: ["target", "rationale", "additional_context_needed"],
  properties: {
    target: { type: "string", enum: ["prompt", "output", "plan", "final_report", "swarm_context", "unknown"] },
    rationale: { type: "string" },
    rewritten_prompt: { type: "string" },
    rewritten_output_summary: { type: "string" },
    smarter_solution: { type: "string" },
    additional_context_needed: { type: "array", items: { type: "string" } },
    parent_context_refs: { type: "array", items: { type: "string" } }
  }
};
