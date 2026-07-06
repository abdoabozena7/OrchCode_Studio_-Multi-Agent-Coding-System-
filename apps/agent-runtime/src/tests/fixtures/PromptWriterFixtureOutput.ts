import { randomUUID } from "node:crypto";
import {
  PROMPT_WRITER_SCHEMA_VERSION,
  type PromptWriterInput,
  type PromptWriterOutput
} from "../../orchestration/PromptWriterModels.js";

export function scriptedPromptWriterOutput(
  input: PromptWriterInput,
  outputId = `prompt_writer_output_${randomUUID()}`
): PromptWriterOutput {
  const validation = uniqueStrings([
    ...input.validation_requirements,
    ...(input.expected_output_schema ? [`Return strict structured output matching ${input.expected_output_schema}.`] : [])
  ]);
  return {
    schema_version: PROMPT_WRITER_SCHEMA_VERSION,
    prompt_writer_output_id: outputId,
    run_id: input.run_id,
    task_id: input.task_id,
    target_agent_role: input.target_agent_role,
    target_prompt_type: input.target_prompt_type,
    recommended_template_id: input.template_id,
    recommended_template_version: input.template_version,
    prompt_draft: {
      summary: "Scripted PromptWriter fixture suggestions derived from task scope, context inclusion metadata, and validation requirements.",
      sections: [
        {
          section_id: "objective",
          title: "Objective",
          content: `Clarify the task objective around: ${input.task_objective}`,
          source_refs: uniqueStrings([input.context_pack_ref, input.original_request_ref ?? ""])
        },
        ...(input.original_request_ref ? [{
          section_id: "intent",
          title: "Canonical Intent",
          content: "Preserve the original user request and locked intent definitions when refining this prompt.",
          source_refs: uniqueStrings([input.original_request_ref, ...(input.intent_ledger_refs ?? [])])
        }] : []),
        {
          section_id: "scope",
          title: "Scope",
          content: `Keep allowed files and forbidden files exactly as supplied. Allowed count: ${input.allowed_files.length}; forbidden count: ${input.forbidden_files.length}.`,
          source_refs: [input.context_pack_ref]
        },
        {
          section_id: "validation",
          title: "Validation",
          content: validation.length ? validation.join("\n") : "Record when validation is unavailable and keep the result honest.",
          source_refs: input.planning_evidence_refs
        }
      ]
    },
    template_input_patch: {
      task_objective: `${input.task_objective}\n\nPromptWriter advisory focus: preserve scope, use the provided context pack, return ${input.expected_output_schema}, and report unresolved risks honestly.`,
      validation_requirements: validation,
      metadata_json: {
        prompt_writer_mode: input.mode,
        prompt_writer_advisory: true,
        prompt_writer_missing_context_count: input.risk_summary.length,
        original_request_ref: input.original_request_ref,
        intent_ledger_refs: input.intent_ledger_refs ?? [],
        locked_intent_definition_count: input.locked_intent_definitions?.length ?? 0
      }
    },
    rationale: [
      "The existing PromptSystem template remains the base.",
      "Suggestions emphasize scope, validation, and honest limitations."
    ],
    risks: input.risk_summary,
    missing_context: input.risk_summary.length ? input.risk_summary : [],
    suggested_success_criteria: input.success_criteria,
    suggested_stop_conditions: input.stop_conditions,
    suggested_validation_requirements: validation,
    confidence: input.context_pack_ref ? 0.78 : 0.45,
    adoption_recommendation: input.mode === "gated_adopt" ? "adopt_if_gated" : "advisory_only",
    created_at: new Date().toISOString()
  };
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
