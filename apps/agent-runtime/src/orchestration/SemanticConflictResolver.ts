import path from "node:path";
import type { IntentContract } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { ProjectGoalSpec } from "./GoalStewardModels.js";
import {
  createSemanticConflictDecision,
  createSemanticConflictResolutionBatch,
  type SemanticConflictDecision,
  type SemanticConflictPhase,
  type SemanticConflictResolutionBatch,
  type SemanticConflictSeverity
} from "./SemanticConflictResolverModels.js";

export type SemanticConflictResolverMode = "strict" | "report_only";

export type SemanticConflictSource = {
  source_id: string;
  source_role: string;
  summary: string;
  refs: string[];
  possible_conflicts?: string[];
  metadata_json?: Record<string, unknown>;
};

export type SemanticConflictResolverOptions = {
  workspacePath: string;
  memoryDir?: string;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
  provider?: LlmProvider;
  mode: SemanticConflictResolverMode;
};

export type SemanticConflictResolverInput = {
  runId: string;
  phase: SemanticConflictPhase;
  rootIntent?: string;
  intentContract?: IntentContract;
  intentContractRef?: string;
  projectGoalSpec?: ProjectGoalSpec;
  sources: SemanticConflictSource[];
  metadata_json?: Record<string, unknown>;
};

type ProviderDecision = {
  conflict?: unknown;
  source_a?: unknown;
  source_b?: unknown;
  root_intent?: unknown;
  decision?: unknown;
  reason?: unknown;
  requires_user_approval?: unknown;
  severity?: unknown;
  status?: unknown;
  question?: unknown;
  options?: unknown;
  source_refs?: unknown;
  evidence_refs?: unknown;
};

type ProviderResolution = {
  rationale?: unknown;
  decisions?: unknown;
};

export class SemanticConflictResolver {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly provider?: LlmProvider;
  private readonly mode: SemanticConflictResolverMode;

  constructor(options: SemanticConflictResolverOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "SemanticConflictResolver" });
    this.provider = options.provider;
    this.mode = options.mode;
  }

  async resolve(input: SemanticConflictResolverInput): Promise<SemanticConflictResolutionBatch> {
    const rootIntent = rootIntentForInput(input);
    await this.traceWriter.write({
      run_id: input.runId,
      event_type: "semantic_conflict_resolution_started",
      lifecycle_stage: "reviewing",
      summary: `Semantic conflict resolver started for ${input.phase}.`,
      artifact_refs: sourceRefs(input),
      metadata_json: {
        phase: input.phase,
        source_count: input.sources.length,
        provider_configured: Boolean(this.provider),
        mode: this.mode
      }
    });

    if (!input.sources.length) {
      return this.persist(createSemanticConflictResolutionBatch({
        run_id: input.runId,
        phase: input.phase,
        root_intent: rootIntent,
        decisions: [],
        provider_used: false,
        metadata_json: { reason: "No semantic conflict sources were provided.", ...input.metadata_json }
      }));
    }

    if (!this.provider) {
      return this.persist(providerUnavailableBatch(input, rootIntent, this.mode, "No SemanticConflictResolver provider is configured."));
    }

    try {
      const generated = await invokeReasoningProviderStructured<ProviderResolution>(
        this.provider,
        semanticConflictResolverRequest(input, rootIntent),
        semanticConflictResolverSchema
      );
      const normalized = normalizeProviderResolution(input, rootIntent, generated);
      return this.persist(normalized);
    } catch (error) {
      return this.persist(providerUnavailableBatch(input, rootIntent, this.mode, formatError(error)));
    }
  }

  private async persist(batch: SemanticConflictResolutionBatch) {
    return this.artifactStore.saveSemanticConflictResolutionBatch(batch);
  }
}

function semanticConflictResolverRequest(input: SemanticConflictResolverInput, rootIntent: string) {
  return {
    purpose: "verify" as const,
    reasoningStage: "verify" as const,
    responseFormat: "json" as const,
    systemPrompt: [
      "You are the provider-authored Semantic Conflict Resolver for Hivo Studio.",
      "Your job is to resolve conflicts in product meaning, intent, and tradeoffs before execution or integration.",
      "Do not judge file merge conflicts, code formatting, command policy, or Rust apply safety.",
      "Use the intent contract and active project goal spec as semantic authority.",
      "If the intent/spec clearly ranks a tradeoff, return a resolved decision.",
      "If the tradeoff is not decided by the intent/spec, require user approval.",
      "Return strict JSON only. Do not invent files, command results, or patches."
    ].join("\n"),
    userPrompt: [
      "Review the provided sources for semantic conflicts.",
      "Return { decisions } where each decision has conflict, source_a, source_b, root_intent, decision, reason, requires_user_approval.",
      "Use requires_user_approval true when the root intent or project spec does not settle the tradeoff.",
      "Use severity blocking for decisions that must stop execution or integration.",
      "Use an empty decisions array only when there are no semantic conflicts."
    ].join("\n"),
    context: {
      run_id: input.runId,
      phase: input.phase,
      root_intent: rootIntent,
      intent_contract: input.intentContract,
      intent_contract_ref: input.intentContractRef,
      project_goal_spec: input.projectGoalSpec,
      sources: input.sources
    },
    maxContextChars: 48_000,
    maxOutputTokens: 1_536
  };
}

function normalizeProviderResolution(
  input: SemanticConflictResolverInput,
  rootIntent: string,
  generated: ProviderResolution
): SemanticConflictResolutionBatch {
  if (!generated || !Array.isArray(generated.decisions)) {
    throw new Error("semantic_conflict_provider_output_invalid: decisions array missing");
  }
  const decisions = generated.decisions.map((entry, index) => normalizeProviderDecision(input, rootIntent, entry as ProviderDecision, index));
  return createSemanticConflictResolutionBatch({
    run_id: input.runId,
    phase: input.phase,
    root_intent: rootIntent,
    decisions,
    provider_used: true,
    metadata_json: {
      provider_rationale: stringValue(generated.rationale),
      source_count: input.sources.length,
      ...input.metadata_json
    }
  });
}

function normalizeProviderDecision(
  input: SemanticConflictResolverInput,
  rootIntent: string,
  decision: ProviderDecision,
  index: number
): SemanticConflictDecision {
  const conflict = requiredString(decision.conflict, `decisions[${index}].conflict`);
  const sourceA = requiredString(decision.source_a, `decisions[${index}].source_a`);
  const sourceB = requiredString(decision.source_b, `decisions[${index}].source_b`);
  const resolvedDecision = requiredString(decision.decision, `decisions[${index}].decision`);
  const reason = requiredString(decision.reason, `decisions[${index}].reason`);
  const requiresUserApproval = Boolean(decision.requires_user_approval);
  const status = validStatus(decision.status)
    ? decision.status
    : requiresUserApproval
      ? "requires_user_approval"
      : "resolved";
  return createSemanticConflictDecision({
    run_id: input.runId,
    phase: input.phase,
    conflict,
    source_a: sourceA,
    source_b: sourceB,
    root_intent: stringValue(decision.root_intent) ?? rootIntent,
    decision: resolvedDecision,
    reason,
    requires_user_approval: requiresUserApproval,
    severity: validSeverity(decision.severity)
      ? decision.severity
      : requiresUserApproval || status === "blocked"
        ? "blocking"
        : "warning",
    status,
    question: stringValue(decision.question),
    options: stringArray(decision.options),
    source_refs: stringArray(decision.source_refs),
    evidence_refs: stringArray(decision.evidence_refs),
    intent_contract_ref: input.intentContractRef ?? input.intentContract?.artifact_ref,
    project_goal_spec_ref: input.projectGoalSpec?.artifact_ref,
    metadata_json: { source_count: input.sources.length }
  });
}

function providerUnavailableBatch(
  input: SemanticConflictResolverInput,
  rootIntent: string,
  mode: SemanticConflictResolverMode,
  reason: string
) {
  const strict = mode === "strict";
  return createSemanticConflictResolutionBatch({
    run_id: input.runId,
    phase: input.phase,
    root_intent: rootIntent,
    provider_used: false,
    decisions: [createSemanticConflictDecision({
      run_id: input.runId,
      phase: input.phase,
      conflict: "semantic_conflict_provider_unavailable",
      source_a: "SemanticConflictResolver",
      source_b: "ConfiguredProvider",
      root_intent: rootIntent,
      decision: strict ? "block until a provider-authored semantic decision is available" : "record warning without semantic approval",
      reason: `Semantic conflict provider was unavailable: ${reason}`,
      requires_user_approval: strict,
      severity: strict ? "blocking" : "warning",
      status: "provider_unavailable",
      source_refs: sourceRefs(input),
      evidence_refs: sourceRefs(input),
      intent_contract_ref: input.intentContractRef ?? input.intentContract?.artifact_ref,
      project_goal_spec_ref: input.projectGoalSpec?.artifact_ref,
      metadata_json: { provider_error: reason, mode }
    })],
    metadata_json: { provider_error: reason, mode, ...input.metadata_json }
  });
}

const semanticConflictResolverSchema = {
  name: "semantic_conflict_resolution",
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    rationale: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["conflict", "source_a", "source_b", "root_intent", "decision", "reason", "requires_user_approval"],
        properties: {
          conflict: { type: "string" },
          source_a: { type: "string" },
          source_b: { type: "string" },
          root_intent: { type: "string" },
          decision: { type: "string" },
          reason: { type: "string" },
          requires_user_approval: { type: "boolean" },
          severity: { type: "string", enum: ["info", "warning", "blocking"] },
          status: { type: "string", enum: ["resolved", "requires_user_approval", "blocked", "provider_unavailable"] },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          source_refs: { type: "array", items: { type: "string" } },
          evidence_refs: { type: "array", items: { type: "string" } }
        }
      }
    }
  }
};

function rootIntentForInput(input: SemanticConflictResolverInput) {
  return input.rootIntent
    ?? input.intentContract?.precise_rewrite
    ?? input.intentContract?.original_user_request
    ?? input.projectGoalSpec?.primary_goal
    ?? input.sources.map((source) => source.summary).join(" | ")
    ?? "unknown root intent";
}

function sourceRefs(input: SemanticConflictResolverInput) {
  return uniqueStrings([
    input.intentContractRef,
    input.intentContract?.artifact_ref,
    input.projectGoalSpec?.artifact_ref,
    input.projectGoalSpec?.summary_ref,
    ...input.sources.flatMap((source) => source.refs)
  ]);
}

function requiredString(value: unknown, field: string) {
  const text = stringValue(value);
  if (!text) throw new Error(`semantic_conflict_provider_output_invalid:${field}`);
  return text;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length ? value.trim() : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

function validSeverity(value: unknown): value is SemanticConflictSeverity {
  return typeof value === "string" && ["info", "warning", "blocking"].includes(value);
}

function validStatus(value: unknown): value is SemanticConflictDecision["status"] {
  return typeof value === "string" && ["resolved", "requires_user_approval", "blocked", "provider_unavailable"].includes(value);
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
