import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import type { OrchestrationArtifactStore } from "./ArtifactStore.js";
import type { AgentInvocation, ContextPack, ParsedAgentOutput, Run, Task } from "./OrchestrationModels.js";

export type CoreReadOnlyRoleInvocationInput = {
  run: Run;
  task: Task;
  pack: ContextPack;
  invocation: AgentInvocation;
};

export class CoreReadOnlyRoleInvocationService {
  constructor(
    private readonly artifactStore: OrchestrationArtifactStore,
    private readonly providerFactory?: (role: string) => LlmProvider | undefined
  ) {}

  async invoke(input: CoreReadOnlyRoleInvocationInput): Promise<ParsedAgentOutput> {
    const { run, task, pack, invocation } = input;
    const provider = this.providerFactory?.(task.role_required);
    if (!provider) throw new Error(`provider_required_for_readonly_worker:${task.role_required}`);

    const generated = await invokeReasoningProviderStructured<unknown>(provider, {
      systemPrompt: [
        `You are ${task.role_required}, a read-only worker inside Hivo Studio's CoreOrchestrator.`,
        "Return only strict JSON matching this TypeScript shape:",
        "{ summary: string, status: 'succeeded' | 'failed' | 'blocked', files_changed: string[], validation_results: { command: string, status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'timed_out' | 'not_run', summary?: string }[], artifacts: string[], limitations: string[], next_recommendations: string[], intent_alignment: { schema_version: 1, original_request_hash: string, intent_contract_ref?: string, intent_contract_revision?: number, task_slice_id: string, task_understanding: string, original_goal_contribution: string, possible_intent_conflicts: string[], assumptions_used: string[], evidence_refs: string[] } }",
        "You may inspect and reason from the provided context only.",
        "You must use intent_frame.original_request_hash, intent_frame.intent_contract_ref, and intent_frame.current_task_slice.task_slice_id exactly in intent_alignment.",
        "Do not claim files were changed. Do not claim validation passed unless the context proves a command actually ran.",
        "If evidence is insufficient, set status to blocked or include the uncertainty in limitations."
      ].join("\n"),
      userPrompt: invocation.prompt,
      context: {
        run_id: run.id,
        task_id: task.id,
        role: task.role_required,
        objective: task.objective,
        expected_output_schema: task.expected_output_schema,
        relevant_files: pack.relevant_files,
        repo_index_refs: pack.repo_index_refs,
        validation_requirements: pack.validation_requirements,
        warnings: pack.warnings,
        context_pack_ref: invocation.context_pack_ref,
        original_user_request: pack.intent_frame?.original_user_request,
        intent_contract: pack.intent_frame?.intent_contract,
        intent_frame: pack.intent_frame
      }
    }, { name: "parsed-agent-output" });

    const output = normalizeProviderReadOnlyOutput(generated);
    invocation.raw_output_ref = await this.artifactStore.saveRawOutput(run.id, invocation.id, {
      role: task.role_required,
      provider_backed: true,
      context_pack_ref: invocation.context_pack_ref,
      output: generated
    });
    output.artifacts.push(invocation.raw_output_ref);
    output.limitations = uniqueStrings([
      `Provider-backed read-only ${task.role_required} invocation used the configured provider; no deterministic role fallback was accepted.`,
      ...output.limitations
    ]);
    return output;
  }
}

export function normalizeProviderReadOnlyOutput(value: unknown): ParsedAgentOutput {
  if (!isRecord(value)) {
    return {
      summary: "Provider returned invalid read-only role output.",
      status: "failed",
      files_changed: [],
      validation_results: [],
      artifacts: [],
      limitations: ["Provider-backed read-only role output was not a JSON object; no deterministic fallback was accepted."],
      next_recommendations: ["Inspect the raw provider output artifact and retry with a schema-following provider response."]
    };
  }
  return {
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary : "Provider-backed read-only role returned no summary.",
    status: value.status === "succeeded" || value.status === "failed" || value.status === "blocked" ? value.status : "failed",
    files_changed: [],
    validation_results: Array.isArray(value.validation_results) ? value.validation_results as ParsedAgentOutput["validation_results"] : [],
    artifacts: Array.isArray(value.artifacts) ? value.artifacts.filter((entry): entry is string => typeof entry === "string") : [],
    limitations: Array.isArray(value.limitations) ? value.limitations.filter((entry): entry is string => typeof entry === "string") : [],
    next_recommendations: Array.isArray(value.next_recommendations) ? value.next_recommendations.filter((entry): entry is string => typeof entry === "string") : [],
    intent_alignment: isRecord(value.intent_alignment) ? value.intent_alignment as ParsedAgentOutput["intent_alignment"] : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
