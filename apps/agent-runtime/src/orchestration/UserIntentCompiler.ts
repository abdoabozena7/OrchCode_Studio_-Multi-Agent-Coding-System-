import { randomUUID } from "node:crypto";
import type { IntentContract, IntentContractPriorityKey, IntentContractRunKind } from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { IntentLedgerService } from "./IntentLedgerService.js";

export const INTENT_CONTRACT_SCHEMA_VERSION = 1;

const PRIORITY_KEYS: IntentContractPriorityKey[] = ["speed", "quality", "realism", "fun", "security", "cost"];
const MAX_PROVIDER_INTENT_REPAIR_ATTEMPTS = 2;

export type UserIntentCompilerInput = {
  workspacePath: string;
  memoryDir?: string;
  runId: string;
  runKind: IntentContractRunKind;
  artifactsPath: string;
  originalRequest: string;
  provider?: LlmProvider;
  parentContext?: unknown;
  sourceComponent?: string;
};

export type UserIntentCompilationResult = {
  contract: IntentContract;
  ready: boolean;
  blockingQuestions: string[];
  errors: string[];
  validationErrors: string[];
};

type ProviderIntentContract = {
  original_user_request?: unknown;
  precise_rewrite?: unknown;
  assumptions?: unknown;
  missing_questions?: unknown;
  tradeoffs?: unknown;
  priorities?: unknown;
  definition_of_done?: unknown;
  non_goals?: unknown;
  conflict_rules?: unknown;
};

type NormalizedIntentContract = {
  contract: IntentContract;
  errors: string[];
};

export class UserIntentCompiler {
  async compile(input: UserIntentCompilerInput): Promise<UserIntentCompilationResult> {
    const ledger = new IntentLedgerService({
      workspacePath: input.workspacePath,
      memoryDir: input.memoryDir,
      sourceComponent: input.sourceComponent ?? "UserIntentCompiler"
    });

    if (!input.provider) {
      const contract = await ledger.saveIntentContract({
        runId: input.runId,
        runKind: input.runKind,
        artifactsPath: input.artifactsPath,
        contract: unavailableContract(input, "No UserIntentCompiler provider is configured.")
      });
      return result(contract, ["No UserIntentCompiler provider is configured."]);
    }

    let providerOutput: ProviderIntentContract;
    try {
      providerOutput = await invokeReasoningProviderStructured<ProviderIntentContract>(input.provider, intentCompilerRequest(input), intentCompilerSchema);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const contract = await ledger.saveIntentContract({
        runId: input.runId,
        runKind: input.runKind,
        artifactsPath: input.artifactsPath,
        contract: unavailableContract(input, `UserIntentCompiler provider failed: ${reason}`)
      });
      return result(contract, [`UserIntentCompiler provider failed: ${reason}`]);
    }

    const normalized = await normalizeOrRepairProviderContract(input, input.provider, providerOutput);
    const contract = await ledger.saveIntentContract({
      runId: input.runId,
      runKind: input.runKind,
      artifactsPath: input.artifactsPath,
      contract: normalized.contract
    });
    return result(contract, normalized.errors);
  }
}

function intentCompilerRequest(input: UserIntentCompilerInput) {
  return {
    purpose: "route" as const,
    reasoningStage: "route" as const,
    responseFormat: "json" as const,
    systemPrompt: [
      "You are UserIntentCompiler for a multi-agent coding system.",
      "Compile the user's request into a strict intent contract before any planning starts.",
      "Preserve original_user_request exactly, byte-for-byte as provided.",
      "Return only semantic intent fields. Do not invent files, execution results, tests, or implementation details.",
      "Mark missing questions as blocking only when planning would likely choose the wrong goal without the answer."
    ].join("\n"),
    userPrompt: [
      "Create an intent contract for this original user request.",
      "The exact original request must be copied into original_user_request without edits.",
      "Priorities must include speed, quality, realism, fun, security, and cost, each with score 0-100 and rationale.",
      "Conflict rules should describe how to resolve clashes between user goals, safety, cost, quality, and existing behavior."
    ].join("\n"),
    context: {
      original_user_request: input.originalRequest,
      run_kind: input.runKind,
      required_priority_keys: PRIORITY_KEYS,
      parent_context: input.parentContext
    },
    maxContextChars: 48_000,
    maxOutputTokens: 2_048
  };
}

async function normalizeOrRepairProviderContract(
  input: UserIntentCompilerInput,
  provider: LlmProvider,
  providerOutput: ProviderIntentContract
): Promise<NormalizedIntentContract> {
  let candidateOutput = providerOutput;
  let normalized = normalizeProviderContract(input, candidateOutput);
  const initialValidationErrors = normalized.errors;
  const repairValidationHistory: string[][] = [];

  for (let attempt = 1; normalized.errors.length && attempt <= MAX_PROVIDER_INTENT_REPAIR_ATTEMPTS; attempt += 1) {
    try {
      candidateOutput = await invokeReasoningProviderStructured<ProviderIntentContract>(
        provider,
        intentCompilerRepairRequest(input, candidateOutput, normalized.errors, attempt),
        intentCompilerSchema
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const errors = [...normalized.errors, `intent contract provider repair failed: ${reason}`];
      return {
        errors,
        contract: withContractMetadata(normalized.contract, {
          provider_repair_attempted: true,
          provider_repair_attempt_count: attempt,
          provider_repair_succeeded: false,
          provider_repair_failed_reason: reason,
          initial_validation_errors: initialValidationErrors,
          repair_validation_history: repairValidationHistory,
          validation_errors: errors
        })
      };
    }
    normalized = normalizeProviderContract(input, candidateOutput);
    repairValidationHistory.push(normalized.errors);
  }

  if (!initialValidationErrors.length) return normalized;
  return {
    errors: normalized.errors,
    contract: withContractMetadata(normalized.contract, {
      provider_repair_attempted: true,
      provider_repair_attempt_count: repairValidationHistory.length,
      provider_repair_succeeded: normalized.errors.length === 0,
      initial_validation_errors: initialValidationErrors,
      repair_validation_errors: normalized.errors,
      repair_validation_history: repairValidationHistory,
      validation_errors: normalized.errors
    })
  };
}

function intentCompilerRepairRequest(
  input: UserIntentCompilerInput,
  invalidOutput: ProviderIntentContract,
  validationErrors: string[],
  attempt: number
) {
  return {
    purpose: "repair" as const,
    reasoningStage: "repair" as const,
    responseFormat: "json" as const,
    systemPrompt: [
      "You are UserIntentCompiler repair for a multi-agent coding system.",
      "The previous provider-authored intent contract failed deterministic validation.",
      "Return a complete replacement intent contract object and preserve original_user_request exactly.",
      "Every required array field must be present, even when empty.",
      "Do not invent files, execution results, tests, implementation details, or claim work has already happened."
    ].join("\n"),
    userPrompt: [
      "Repair the intent contract JSON using the validation errors.",
      "Return all required top-level fields: original_user_request, precise_rewrite, assumptions, missing_questions, tradeoffs, priorities, definition_of_done, non_goals, conflict_rules.",
      "Priorities must include speed, quality, realism, fun, security, and cost, each with score 0-100 and rationale.",
      "Return only the corrected JSON object."
    ].join("\n"),
    context: {
      original_user_request: input.originalRequest,
      run_kind: input.runKind,
      repair_attempt: attempt,
      max_repair_attempts: MAX_PROVIDER_INTENT_REPAIR_ATTEMPTS,
      required_priority_keys: PRIORITY_KEYS,
      validation_errors: validationErrors,
      invalid_contract_candidate: invalidOutput,
      parent_context: input.parentContext
    },
    maxContextChars: 48_000,
    maxOutputTokens: 2_048
  };
}

function normalizeProviderContract(input: UserIntentCompilerInput, generated: ProviderIntentContract): NormalizedIntentContract {
  const errors: string[] = [];
  const candidate = isRecord(generated) ? generated : {};
  if (!isRecord(generated)) errors.push("Provider result must be an object.");
  const original = rawStringValue(candidate.original_user_request);
  if (original !== input.originalRequest) errors.push("original_user_request must exactly match the user request.");
  const preciseRewrite = stringValue(candidate.precise_rewrite);
  if (!preciseRewrite) errors.push("precise_rewrite must be a non-empty string.");
  const assumptions = stringArray(candidate.assumptions, "assumptions", errors);
  const missingQuestions = questionArray(candidate.missing_questions, errors);
  const tradeoffs = tradeoffArray(candidate.tradeoffs, errors);
  const priorities = prioritiesObject(candidate.priorities, errors);
  const definitionOfDone = stringArray(candidate.definition_of_done, "definition_of_done", errors);
  const nonGoals = stringArray(candidate.non_goals, "non_goals", errors);
  const conflictRules = stringArray(candidate.conflict_rules, "conflict_rules", errors);
  const blockingQuestions = missingQuestions.filter((question) => question.blocking);
  const status: IntentContract["status"] = errors.length
    ? "invalid"
    : blockingQuestions.length
      ? "needs_clarification"
      : "ready";
  return {
    errors,
    contract: baseContract(input, {
      status,
      preciseRewrite: preciseRewrite || input.originalRequest,
      assumptions,
      missingQuestions,
      tradeoffs,
      priorities,
      definitionOfDone,
      nonGoals,
      conflictRules,
      metadata: {
        provider_used: true,
        validation_errors: errors
      }
    })
  };
}

function withContractMetadata(contract: IntentContract, metadata: Record<string, unknown>): IntentContract {
  return {
    ...contract,
    metadata_json: {
      ...contract.metadata_json,
      ...metadata
    }
  };
}

function unavailableContract(input: UserIntentCompilerInput, reason: string): IntentContract {
  return baseContract(input, {
    status: "provider_unavailable",
    preciseRewrite: input.originalRequest,
    assumptions: [],
    missingQuestions: [{
      question: "A configured provider must compile the user intent contract before planning.",
      reason,
      blocking: true
    }],
    tradeoffs: [],
    priorities: emptyPriorities(reason),
    definitionOfDone: [],
    nonGoals: [],
    conflictRules: [],
    metadata: {
      provider_used: false,
      provider_unavailable_reason: reason
    }
  });
}

function baseContract(input: UserIntentCompilerInput, value: {
  status: IntentContract["status"];
  preciseRewrite: string;
  assumptions: string[];
  missingQuestions: IntentContract["missing_questions"];
  tradeoffs: IntentContract["tradeoffs"];
  priorities: IntentContract["priorities"];
  definitionOfDone: string[];
  nonGoals: string[];
  conflictRules: string[];
  metadata: Record<string, unknown>;
}): IntentContract {
  return {
    schema_version: INTENT_CONTRACT_SCHEMA_VERSION,
    contract_id: `intent_contract_${randomUUID()}`,
    run_id: input.runId,
    run_kind: input.runKind,
    revision: 0,
    original_user_request: input.originalRequest,
    precise_rewrite: value.preciseRewrite,
    assumptions: value.assumptions,
    missing_questions: value.missingQuestions,
    tradeoffs: value.tradeoffs,
    priorities: value.priorities,
    definition_of_done: value.definitionOfDone,
    non_goals: value.nonGoals,
    conflict_rules: value.conflictRules,
    status: value.status,
    created_at: new Date().toISOString(),
    metadata_json: {
      source_component: input.sourceComponent ?? "UserIntentCompiler",
      ...value.metadata
    }
  };
}

function result(contract: IntentContract, errors: string[]): UserIntentCompilationResult {
  return {
    contract,
    ready: contract.status === "ready",
    blockingQuestions: contract.missing_questions.filter((question) => question.blocking).map((question) => question.question),
    errors,
    validationErrors: errors
  };
}

function prioritiesObject(value: unknown, errors: string[]): IntentContract["priorities"] {
  if (!isRecord(value)) {
    errors.push("priorities must be an object.");
    return emptyPriorities("Provider did not return priorities.");
  }
  const priorities = emptyPriorities("Provider priority was invalid.");
  for (const key of PRIORITY_KEYS) {
    const entry = value[key];
    if (!isRecord(entry)) {
      errors.push(`priorities.${key} must be an object.`);
      continue;
    }
    const score = typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : undefined;
    const rationale = stringValue(entry.rationale);
    if (score === undefined || score < 0 || score > 100) errors.push(`priorities.${key}.score must be a number from 0 to 100.`);
    if (!rationale) errors.push(`priorities.${key}.rationale must be a non-empty string.`);
    priorities[key] = {
      score: score ?? 0,
      rationale: rationale ?? "Invalid provider priority."
    };
  }
  return priorities;
}

function emptyPriorities(rationale: string): IntentContract["priorities"] {
  return {
    speed: { score: 0, rationale },
    quality: { score: 0, rationale },
    realism: { score: 0, rationale },
    fun: { score: 0, rationale },
    security: { score: 0, rationale },
    cost: { score: 0, rationale }
  };
}

function questionArray(value: unknown, errors: string[]): IntentContract["missing_questions"] {
  if (!Array.isArray(value)) {
    errors.push("missing_questions must be an array.");
    return [];
  }
  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      const question = entry.trim();
      return {
        question,
        reason: "Provider supplied this as an unresolved question without structured rationale.",
        blocking: shouldIntentQuestionBlockPlanning(question, undefined)
      };
    }
    if (!isRecord(entry)) {
      errors.push(`missing_questions[${index}] must be an object.`);
      return { question: "", reason: "Invalid provider question.", blocking: true };
    }
    const question = stringValue(entry.question) ?? stringValue(entry.text) ?? stringValue(entry.prompt);
    const reason =
      stringValue(entry.reason)
      ?? stringValue(entry.rationale)
      ?? stringValue(entry.why)
      ?? stringValue(entry.why_it_matters)
      ?? "Provider did not explain this missing question.";
    const providerBlocking =
      typeof entry.blocking === "boolean"
        ? entry.blocking
        : typeof entry.is_blocking === "boolean"
          ? entry.is_blocking
          : typeof entry.requires_user_answer === "boolean"
            ? entry.requires_user_answer
            : undefined;
    if (!question) errors.push(`missing_questions[${index}].question must be a non-empty string.`);
    return {
      question: question ?? "",
      reason,
      blocking: shouldIntentQuestionBlockPlanning(question ?? "", providerBlocking)
    };
  }).filter((entry) => entry.question);
}

function tradeoffArray(value: unknown, errors: string[]): IntentContract["tradeoffs"] {
  if (!Array.isArray(value)) {
    errors.push("tradeoffs must be an array.");
    return [];
  }
  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.trim()) {
      return { name: entry.trim(), options: [] };
    }
    if (!isRecord(entry)) {
      errors.push(`tradeoffs[${index}] must be an object.`);
      return { name: "", options: [] };
    }
    const name = stringValue(entry.name) ?? stringValue(entry.title) ?? stringValue(entry.tradeoff) ?? stringValue(entry.decision);
    if (!name) errors.push(`tradeoffs[${index}].name must be a non-empty string.`);
    const optionCandidates = Array.isArray(entry.options)
      ? entry.options
      : [entry.option_a, entry.option_b, entry.first_option, entry.second_option];
    const options = optionCandidates.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    return {
      name: name ?? "",
      options,
      preferred: stringValue(entry.preferred),
      rationale: stringValue(entry.rationale)
    };
  }).filter((entry) => entry.name);
}

function stringArray(value: unknown, field: string, errors: string[]) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return [];
  }
  const strings = value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
  if (strings.length !== value.length) errors.push(`${field} must contain only non-empty strings.`);
  return strings;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function shouldIntentQuestionBlockPlanning(question: string, providerBlocking: boolean | undefined) {
  if (!question.trim()) return true;
  if (isSafeDefaultIntentQuestion(question)) return false;
  if (providerBlocking !== undefined) return providerBlocking;
  return /\b(which|choose|preferred|required|required behavior|target api|external api|business rule|acceptance criteria)\b/i.test(question);
}

function isSafeDefaultIntentQuestion(question: string) {
  return /\b(mobile|desktop|browsers?|browser support|devices?|officially supported|platforms?|input method|keyboard|mouse|touch|accessibility|testing framework|test framework|test runner|unit test|integration test|jest|mocha|vitest|agent count|number of agents|number of internal agents|internal agents|max(?:imum)? agents?|logical agents?|budget constraint|compute budget|theme|color|colour|palette|visual style|bundle size|performance budget|fps|frame rate|audio|sound|difficulty|port|dev server|development server|local url|available port|runtime environment|runtime|interpreter|node\.?js|node|npm|package manager|start command|launch command)\b/i.test(question);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export const intentCompilerSchema = {
  name: "intent-contract",
  type: "object",
  additionalProperties: false,
  required: [
    "original_user_request",
    "precise_rewrite",
    "assumptions",
    "missing_questions",
    "tradeoffs",
    "priorities",
    "definition_of_done",
    "non_goals",
    "conflict_rules"
  ],
  properties: {
    original_user_request: { type: "string" },
    precise_rewrite: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    missing_questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "reason", "blocking"],
        properties: {
          question: { type: "string" },
          reason: { type: "string" },
          blocking: { type: "boolean" }
        }
      }
    },
    tradeoffs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "options"],
        properties: {
          name: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          preferred: { type: "string" },
          rationale: { type: "string" }
        }
      }
    },
    priorities: {
      type: "object",
      additionalProperties: false,
      required: PRIORITY_KEYS,
      properties: Object.fromEntries(PRIORITY_KEYS.map((key) => [key, {
        type: "object",
        additionalProperties: false,
        required: ["score", "rationale"],
        properties: {
          score: { type: "number", minimum: 0, maximum: 100 },
          rationale: { type: "string" }
        }
      }]))
    },
    definition_of_done: { type: "array", items: { type: "string" } },
    non_goals: { type: "array", items: { type: "string" } },
    conflict_rules: { type: "array", items: { type: "string" } }
  }
};
