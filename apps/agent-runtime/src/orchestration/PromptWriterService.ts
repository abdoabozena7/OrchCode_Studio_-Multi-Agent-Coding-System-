import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { writeJson } from "../memory/ProjectMemory.js";
import { invokeReasoningProviderStructured } from "../runtime/ReasoningKernel.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { ContextPack, Task } from "./OrchestrationModels.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import {
  evaluatePromptQuality,
  isPromptQualityBlocking,
  type PromptQualityResult,
  type PromptQualityStatus
} from "./PromptQualityGate.js";
import {
  renderPromptTemplate,
  type PromptTemplateInput,
  type PromptTemplateVersion,
  type PromptType,
  type RenderedPrompt
} from "./PromptSystem.js";
import {
  PROMPT_WRITER_SCHEMA_VERSION,
  applyPromptWriterTemplateInputPatch,
  promptWriterQualitySummaryFromResult,
  validatePromptWriterOutput,
  type PromptWriterAdoptionDecision,
  type PromptWriterInput,
  type PromptWriterMode,
  type PromptWriterOutput,
  type PromptWriterProviderMode,
  type PromptWriterRunResult
} from "./PromptWriterModels.js";

export type PromptWriterServiceOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  providerFactory?: (role: string) => LlmProvider | undefined;
  providerName?: string;
  modelName?: string;
};

export type PromptWriterBuildInput = {
  runId: string;
  task: Task;
  pack: ContextPack;
  contextPackRef: string;
  originalTemplateInput: PromptTemplateInput;
  targetPromptType: PromptType | string;
  templateId: string;
  templateVersion: PromptTemplateVersion;
  originalPromptId?: string;
  originalPromptArtifactRef?: string;
  planningEvidenceRefs?: string[];
  priorDecisionRefs?: string[];
  priorFailureRefs?: string[];
  mode?: PromptWriterMode;
};

export class PromptWriterService {
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly options: PromptWriterServiceOptions) {
    this.traceWriter = new FactoryTraceWriter({
      workspacePath: options.workspacePath,
      memoryDir: options.memoryDir,
      sourceComponent: "PromptWriterService"
    });
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
  }

  async run(input: PromptWriterBuildInput): Promise<PromptWriterRunResult | undefined> {
    const mode = input.mode ?? this.options.config.prompt_writer_mode;
    if (mode === "off") return undefined;

    const writerInput = this.buildInput(input, mode);
    const outputId = `prompt_writer_output_${randomUUID()}`;
    const artifacts = await this.artifactPaths(writerInput.run_id, writerInput.task_id, outputId);

    const startedTrace = await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: "prompt_writer_started",
      lifecycle_stage: "executing",
      summary: "PromptWriter started.",
      artifact_refs: [writerInput.context_pack_ref],
      metadata_json: traceMetadata(writerInput, {
        prompt_writer_output_id: outputId,
        original_prompt_id: input.originalPromptId
      })
    });

    await writeJson(artifacts.input, writerInput);
    await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: "prompt_writer_input_created",
      lifecycle_stage: "executing",
      causal_parent_event_id: startedTrace.trace_event_id,
      summary: "PromptWriter input artifact created.",
      artifact_refs: [artifacts.input],
      metadata_json: traceMetadata(writerInput, { prompt_writer_output_id: outputId })
    });

    const providerMode = this.options.config.prompt_writer_provider_mode;
    const provider = providerMode === "deterministic" ? undefined : this.options.providerFactory?.("PromptWriterAgent");
    let rawOutput: unknown;
    let usedProviderMode: PromptWriterProviderMode | "fallback" = provider ? "provider_read_only" : "fallback";
    if (provider) {
      await this.traceWriter.write({
        run_id: writerInput.run_id,
        task_id: writerInput.task_id,
        event_type: "prompt_writer_provider_selected",
        lifecycle_stage: "executing",
        causal_parent_event_id: startedTrace.trace_event_id,
        summary: "Provider-backed read-only PromptWriter selected.",
        metadata_json: traceMetadata(writerInput, {
          prompt_writer_output_id: outputId,
          provider_name: this.options.providerName,
          model_name: this.options.modelName,
          mode
        })
      });
      try {
        rawOutput = await invokeReasoningProviderStructured<PromptWriterOutput>(provider, {
          systemPrompt: [
            "You are PromptWriterAgent.",
            "Return strict JSON only.",
            "You are read-only: do not run commands, edit files, create patches, or mark tasks complete.",
            "Suggest template input improvements only; do not bypass PromptSystem or PromptQualityGate."
          ].join("\n"),
          userPrompt: "Create a controlled prompt draft and template input suggestions for the target agent.",
          context: writerInput
        }, promptWriterOutputSchemaHint());
      } catch (error) {
        await this.traceWriter.write({
          run_id: writerInput.run_id,
          task_id: writerInput.task_id,
          event_type: "prompt_writer_provider_unavailable",
          lifecycle_stage: "executing",
          severity: providerMode === "auto" ? "warning" : "error",
          causal_parent_event_id: startedTrace.trace_event_id,
          summary: error instanceof Error ? error.message : String(error),
          reason: "Provider failed or was unavailable; deterministic fallback will be used.",
          metadata_json: traceMetadata(writerInput, {
            prompt_writer_output_id: outputId,
            provider_name: this.options.providerName,
            model_name: this.options.modelName
          })
        });
        rawOutput = deterministicPromptWriterOutput(writerInput, outputId);
        usedProviderMode = "fallback";
        await this.traceWriter.write({
          run_id: writerInput.run_id,
          task_id: writerInput.task_id,
          event_type: "prompt_writer_fallback_used",
          lifecycle_stage: "executing",
          severity: "warning",
          causal_parent_event_id: startedTrace.trace_event_id,
          summary: "Deterministic PromptWriter fallback used.",
          metadata_json: traceMetadata(writerInput, { prompt_writer_output_id: outputId })
        });
      }
    } else {
      if (providerMode !== "deterministic") {
        await this.traceWriter.write({
          run_id: writerInput.run_id,
          task_id: writerInput.task_id,
          event_type: "prompt_writer_provider_unavailable",
          lifecycle_stage: "executing",
          severity: "warning",
          causal_parent_event_id: startedTrace.trace_event_id,
          summary: "PromptWriter provider unavailable.",
          reason: "No PromptWriter provider was configured.",
          metadata_json: traceMetadata(writerInput, { prompt_writer_output_id: outputId, mode })
        });
      }
      rawOutput = deterministicPromptWriterOutput(writerInput, outputId);
      await this.traceWriter.write({
        run_id: writerInput.run_id,
        task_id: writerInput.task_id,
        event_type: "prompt_writer_fallback_used",
        lifecycle_stage: "executing",
        severity: providerMode === "deterministic" ? "info" : "warning",
        causal_parent_event_id: startedTrace.trace_event_id,
        summary: "Deterministic PromptWriter fallback used.",
        metadata_json: traceMetadata(writerInput, { prompt_writer_output_id: outputId })
      });
    }

    await writeFile(artifacts.rawOutput, typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2), "utf8");
    const savedTrace = await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: "prompt_writer_output_saved",
      lifecycle_stage: "executing",
      causal_parent_event_id: startedTrace.trace_event_id,
      summary: "PromptWriter raw output saved.",
      artifact_refs: [artifacts.rawOutput],
      metadata_json: traceMetadata(writerInput, {
        prompt_writer_output_id: outputId,
        provider_mode: usedProviderMode
      })
    });

    const parsedOutput = typeof rawOutput === "string" ? safeParseJson(rawOutput) : rawOutput;
    const schemaValidation = validatePromptWriterOutput(parsedOutput, writerInput);
    await writeJson(artifacts.schemaValidation, schemaValidation);
    await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: schemaValidation.schema_status === "passed" ? "prompt_writer_output_schema_validated" : "prompt_writer_output_schema_failed",
      lifecycle_stage: "executing",
      severity: schemaValidation.schema_status === "passed" ? "info" : "error",
      causal_parent_event_id: savedTrace.trace_event_id,
      summary: schemaValidation.schema_status === "passed" ? "PromptWriter output schema validated." : "PromptWriter output schema failed.",
      reason: [...schemaValidation.errors, ...schemaValidation.safety_findings.map((finding) => finding.message)].join("; ") || undefined,
      artifact_refs: [artifacts.schemaValidation],
      metadata_json: traceMetadata(writerInput, {
        prompt_writer_output_id: outputId,
        output_schema_status: schemaValidation.schema_status
      })
    });

    let output: PromptWriterOutput | undefined;
    let candidate: RenderedPrompt | undefined;
    let quality: PromptQualityResult | undefined;
    let candidateInputPatch: Partial<PromptTemplateInput> | undefined;

    if (schemaValidation.schema_status === "passed") {
      output = {
        ...(parsedOutput as PromptWriterOutput),
        artifact_ref: artifacts.parsedOutput
      };
      await writeJson(artifacts.parsedOutput, output);
      const patchResult = applyPromptWriterTemplateInputPatch(input.originalTemplateInput, output);
      if (patchResult.ok) {
        candidateInputPatch = output.template_input_patch;
        const candidateRender = renderPromptTemplate(output.recommended_template_id, patchResult.input, {
          version: output.recommended_template_version,
          sourceComponent: "PromptWriterService"
        });
        if (candidateRender.ok) {
          candidate = candidateRender.rendered;
          await writeFile(artifacts.candidatePrompt, candidate.text, "utf8");
          await this.traceWriter.write({
            run_id: writerInput.run_id,
            task_id: writerInput.task_id,
            event_type: "prompt_writer_candidate_prompt_rendered",
            lifecycle_stage: "executing",
            causal_parent_event_id: savedTrace.trace_event_id,
            summary: "PromptWriter candidate prompt rendered through PromptSystem.",
            artifact_refs: [artifacts.candidatePrompt],
            metadata_json: traceMetadata(writerInput, {
              prompt_writer_output_id: output.prompt_writer_output_id,
              candidate_prompt_id: candidate.prompt_id,
              original_prompt_id: input.originalPromptId
            })
          });
          await this.traceWriter.write({
            run_id: writerInput.run_id,
            task_id: writerInput.task_id,
            event_type: "prompt_writer_quality_gate_started",
            lifecycle_stage: "executing",
            causal_parent_event_id: savedTrace.trace_event_id,
            summary: "PromptWriter candidate prompt quality gate started.",
            artifact_refs: [artifacts.candidatePrompt],
            metadata_json: traceMetadata(writerInput, {
              prompt_writer_output_id: output.prompt_writer_output_id,
              candidate_prompt_id: candidate.prompt_id
            })
          });
          quality = evaluatePromptQuality(candidate, {
            task: input.task,
            contextPack: input.pack,
            contextPackRef: input.contextPackRef,
            promptArtifactRef: artifacts.candidatePrompt,
            expectedOutputSchema: input.task.expected_output_schema,
            allowedFiles: input.task.allowed_files_to_edit,
            forbiddenFiles: input.task.forbidden_files,
            validationRequirements: input.pack.validation_requirements,
            successCriteria: writerInput.success_criteria,
            stopConditions: writerInput.stop_conditions,
            artifactRefs: [input.contextPackRef, artifacts.parsedOutput]
          });
          const qualityRef = path.join(path.dirname(artifacts.candidatePrompt), `candidate_prompt_quality_${outputId}.json`);
          await writeJson(qualityRef, quality);
          quality.artifact_ref = qualityRef;
          await this.metadata.recordPromptQualityResultSaved(quality, qualityRef);
          await this.traceWriter.write({
            run_id: writerInput.run_id,
            task_id: writerInput.task_id,
            event_type: "prompt_writer_quality_gate_completed",
            lifecycle_stage: "executing",
            severity: isPromptQualityBlocking(quality) ? "warning" : "info",
            causal_parent_event_id: savedTrace.trace_event_id,
            summary: `PromptWriter candidate prompt quality ${quality.status}.`,
            artifact_refs: [qualityRef],
            metadata_json: traceMetadata(writerInput, {
              prompt_writer_output_id: output.prompt_writer_output_id,
              candidate_prompt_id: candidate.prompt_id,
              quality_status: quality.status,
              candidate_prompt_quality_result_id: quality.quality_result_id
            })
          });
        } else {
          schemaValidation.schema_status = "failed";
          schemaValidation.errors.push(candidateRender.error.message);
        }
      } else {
        schemaValidation.schema_status = "failed";
        schemaValidation.errors.push(patchResult.reason);
      }
    }

    const adoption = this.evaluateAdoption({
      mode,
      writerInput,
      output,
      candidate,
      quality,
      schemaPassed: schemaValidation.schema_status === "passed",
      originalPromptId: input.originalPromptId
    });
    await writeJson(artifacts.adoptionDecision, adoption);
    const adoptionTrace = await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: "prompt_writer_adoption_evaluated",
      lifecycle_stage: "executing",
      severity: adoption.adopted ? "info" : "warning",
      causal_parent_event_id: savedTrace.trace_event_id,
      summary: adoption.reason,
      artifact_refs: [artifacts.adoptionDecision],
      metadata_json: traceMetadata(writerInput, {
        prompt_writer_output_id: output?.prompt_writer_output_id ?? outputId,
        candidate_prompt_id: candidate?.prompt_id,
        original_prompt_id: input.originalPromptId,
        quality_status: quality?.status ?? "not_run",
        adoption_decision: adoption.decision,
        confidence: output?.confidence
      })
    });
    adoption.trace_event_id = adoptionTrace.trace_event_id;
    await writeJson(artifacts.adoptionDecision, adoption);
    await this.traceWriter.write({
      run_id: writerInput.run_id,
      task_id: writerInput.task_id,
      event_type: adoption.adopted ? "prompt_writer_adopted" : mode === "shadow" ? "prompt_writer_shadow_recorded" : "prompt_writer_rejected",
      lifecycle_stage: "executing",
      severity: adoption.adopted || mode === "shadow" ? "info" : "warning",
      causal_parent_event_id: adoptionTrace.trace_event_id,
      summary: adoption.reason,
      artifact_refs: [artifacts.adoptionDecision],
      metadata_json: traceMetadata(writerInput, {
        prompt_writer_output_id: output?.prompt_writer_output_id ?? outputId,
        candidate_prompt_id: candidate?.prompt_id,
        original_prompt_id: input.originalPromptId,
        quality_status: quality?.status ?? "not_run",
        adoption_decision: adoption.decision
      })
    });

    await writeFile(artifacts.summary, summaryMarkdown(writerInput, output, schemaValidation.schema_status, adoption, quality), "utf8");
    await this.metadata.recordPromptWriterOutputSaved({
      outputId,
      runId: writerInput.run_id,
      taskId: writerInput.task_id,
      targetAgentRole: writerInput.target_agent_role,
      targetPromptType: writerInput.target_prompt_type,
      mode,
      providerMode: usedProviderMode,
      templateId: writerInput.template_id,
      templateVersion: writerInput.template_version,
      promptWriterArtifactRef: artifacts.parsedOutput,
      candidatePromptArtifactRef: candidate ? artifacts.candidatePrompt : undefined,
      candidatePromptQualityResultId: quality?.quality_result_id,
      outputSchemaStatus: schemaValidation.schema_status,
      confidence: output?.confidence,
      adoptionRecommendation: output?.adoption_recommendation,
      status: adoption.adopted ? "adopted" : schemaValidation.schema_status === "passed" ? "recorded" : "rejected",
      traceEventId: adoptionTrace.trace_event_id,
      metadata: {
        input_ref: artifacts.input,
        raw_output_ref: artifacts.rawOutput,
        schema_validation_ref: artifacts.schemaValidation,
        adoption_decision_ref: artifacts.adoptionDecision,
        summary_ref: artifacts.summary
      }
    });
    await this.metadata.recordPromptWriterAdoptionDecisionSaved({
      decision: adoption,
      metadata: {
        output_ref: artifacts.parsedOutput,
        candidate_prompt_ref: candidate ? artifacts.candidatePrompt : undefined,
        original_prompt_ref: input.originalPromptArtifactRef
      }
    });
    await this.metadata.recordArtifactSaved({
      runId: writerInput.run_id,
      taskId: writerInput.task_id,
      kind: "prompt_writer",
      artifactRef: artifacts.summary,
      status: adoption.decision,
      metadata: {
        mode,
        provider_mode: usedProviderMode,
        output_schema_status: schemaValidation.schema_status,
        adopted: adoption.adopted
      }
    });

    return {
      mode,
      provider_mode: usedProviderMode,
      input: writerInput,
      output,
      schema_validation: schemaValidation,
      quality_summary: promptWriterQualitySummaryFromResult(quality),
      adoption_decision: adoption,
      artifact_refs: {
        input: artifacts.input,
        raw_output: artifacts.rawOutput,
        parsed_output: artifacts.parsedOutput,
        schema_validation: artifacts.schemaValidation,
        candidate_prompt: candidate ? artifacts.candidatePrompt : undefined,
        adoption_decision: artifacts.adoptionDecision,
        summary: artifacts.summary,
        quality: quality?.artifact_ref
      },
      candidate_rendered_prompt: adoption.adopted ? candidate : undefined,
      candidate_prompt_text: adoption.adopted ? candidate?.text : undefined,
      template_input_patch: adoption.adopted ? candidateInputPatch : undefined
    };
  }

  private buildInput(input: PromptWriterBuildInput, mode: PromptWriterMode): PromptWriterInput {
    const included = input.pack.included_items ?? [];
    const readOnlyFiles = included
      .filter((item) => item.access_mode === "read_only" || item.access_mode === "reference_only")
      .map((item) => item.source_path ?? item.source_ref)
      .filter(Boolean);
    return {
      schema_version: PROMPT_WRITER_SCHEMA_VERSION,
      prompt_writer_input_id: `prompt_writer_input_${randomUUID()}`,
      run_id: input.runId,
      task_id: input.task.id,
      target_agent_role: input.task.role_required,
      target_prompt_type: input.targetPromptType,
      template_id: input.templateId,
      template_version: input.templateVersion,
      task_objective: input.task.objective,
      context_pack_ref: input.contextPackRef,
      context_inclusion_summary: {
        ...(input.pack.retrieval_summary ?? input.pack.context_retrieval_summary ?? {}),
        included_item_count: included.length,
        excluded_item_count: input.pack.excluded_items?.length ?? 0,
        warning_count: input.pack.warnings.length
      },
      allowed_files: input.task.allowed_files_to_edit,
      forbidden_files: input.task.forbidden_files,
      read_only_files: uniqueStrings(readOnlyFiles),
      expected_output_schema: input.task.expected_output_schema,
      validation_requirements: input.pack.validation_requirements,
      success_criteria: [input.task.objective, input.task.expected_output_schema],
      stop_conditions: ["Keep validation requirements intact.", "Use static PromptSystem fallback if PromptWriter output is rejected."],
      planning_evidence_refs: input.planningEvidenceRefs ?? evidenceRefsFromPack(input.pack),
      prior_decision_refs: input.priorDecisionRefs ?? input.pack.previous_decisions,
      prior_failure_refs: input.priorFailureRefs ?? [],
      team_id: input.pack.team_context?.scope.team_id,
      team_context_refs: input.pack.team_context ? uniqueStrings([
        input.pack.team_context.scope.artifact_ref,
        input.pack.team_context.scope.summary_ref,
        ...input.pack.team_context.memory_queries.map((query) => query.artifact_ref)
      ].filter((entry): entry is string => Boolean(entry))) : undefined,
      team_memory_scope: input.pack.team_context?.scope.memory_scope,
      risk_summary: [...input.pack.warnings, ...input.pack.missing_evidence_links],
      mode,
      metadata_json: {
        context_pack_id: input.pack.id,
        original_prompt_id: input.originalPromptId,
        original_prompt_artifact_ref: input.originalPromptArtifactRef,
        prompt_writer_provider_mode: this.options.config.prompt_writer_provider_mode,
        team_context: input.pack.team_context ? {
          team_id: input.pack.team_context.scope.team_id,
          parent_team_id: input.pack.team_context.scope.parent_team_id,
          memory_scope: input.pack.team_context.scope.memory_scope,
          fallback_used: input.pack.team_context.fallback_used,
          warning_count: input.pack.team_context.warnings.length
        } : undefined
      }
    };
  }

  private evaluateAdoption(input: {
    mode: PromptWriterMode;
    writerInput: PromptWriterInput;
    output?: PromptWriterOutput;
    candidate?: RenderedPrompt;
    quality?: PromptQualityResult;
    schemaPassed: boolean;
    originalPromptId?: string;
  }): PromptWriterAdoptionDecision {
    const now = new Date().toISOString();
    const qualityStatus: PromptQualityStatus | "not_run" = input.quality?.status ?? "not_run";
    const base: Omit<PromptWriterAdoptionDecision, "decision" | "reason" | "adopted"> = {
      schema_version: PROMPT_WRITER_SCHEMA_VERSION,
      adoption_decision_id: `prompt_writer_adoption_${randomUUID()}`,
      run_id: input.writerInput.run_id,
      task_id: input.writerInput.task_id,
      prompt_writer_output_id: input.output?.prompt_writer_output_id,
      candidate_prompt_id: input.candidate?.prompt_id,
      original_prompt_id: input.originalPromptId,
      mode: input.mode,
      quality_status: qualityStatus,
      created_at: now,
      metadata_json: {}
    };
    if (input.mode === "shadow") {
      return { ...base, decision: "shadow_recorded", adopted: false, reason: "Shadow mode records PromptWriter output without changing execution prompts." };
    }
    if (input.mode === "advisory") {
      return { ...base, decision: "advisory_recorded", adopted: false, reason: "Advisory mode records recommendations without replacing rendered prompts." };
    }
    if (input.mode !== "gated_adopt") {
      return { ...base, decision: "off", adopted: false, reason: "PromptWriter mode is off." };
    }
    if (!input.schemaPassed) {
      return { ...base, decision: "rejected", adopted: false, reason: "PromptWriter output schema or safety validation failed." };
    }
    if (!input.output || !input.candidate || !input.quality) {
      return { ...base, decision: "rejected", adopted: false, reason: "PromptWriter did not produce a complete candidate prompt." };
    }
    if (input.output.adoption_recommendation !== "adopt_if_gated") {
      return { ...base, decision: "rejected", adopted: false, reason: "PromptWriter did not recommend gated adoption." };
    }
    if (isPromptQualityBlocking(input.quality)) {
      return { ...base, decision: "rejected", adopted: false, reason: `Candidate prompt quality gate blocked adoption: ${input.quality.status}.` };
    }
    return { ...base, decision: "adopted", adopted: true, reason: "Gated adoption allowed after schema validation and PromptQualityGate." };
  }

  private async artifactPaths(runId: string, taskId: string, outputId: string) {
    const root = path.join(this.options.workspacePath, this.options.memoryDir ?? ".agent_memory", "runs", runId, "prompt_writers", taskId);
    await mkdir(root, { recursive: true });
    return {
      input: path.join(root, `input_${outputId}.json`),
      rawOutput: path.join(root, `raw_output_${outputId}.md`),
      parsedOutput: path.join(root, `parsed_output_${outputId}.json`),
      schemaValidation: path.join(root, `schema_validation_${outputId}.json`),
      candidatePrompt: path.join(root, `candidate_prompt_${outputId}.md`),
      adoptionDecision: path.join(root, `adoption_decision_${outputId}.json`),
      summary: path.join(root, `summary_${outputId}.md`)
    };
  }
}

export function deterministicPromptWriterOutput(input: PromptWriterInput, outputId = `prompt_writer_output_${randomUUID()}`): PromptWriterOutput {
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
      summary: "Deterministic PromptWriter suggestions derived from task scope, context inclusion metadata, and validation requirements.",
      sections: [
        {
          section_id: "objective",
          title: "Objective",
          content: `Clarify the task objective around: ${input.task_objective}`,
          source_refs: [input.context_pack_ref]
        },
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
        prompt_writer_missing_context_count: input.risk_summary.length
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

function summaryMarkdown(
  input: PromptWriterInput,
  output: PromptWriterOutput | undefined,
  schemaStatus: string,
  adoption: PromptWriterAdoptionDecision,
  quality?: PromptQualityResult
) {
  return [
    "# PromptWriter Summary",
    "",
    `- mode: ${input.mode}`,
    `- task_id: ${input.task_id}`,
    `- target_agent_role: ${input.target_agent_role}`,
    `- template: ${input.template_id}@${input.template_version}`,
    `- schema_status: ${schemaStatus}`,
    `- quality_status: ${quality?.status ?? "not_run"}`,
    `- adoption_decision: ${adoption.decision}`,
    `- adopted: ${adoption.adopted}`,
    `- confidence: ${output?.confidence ?? "n/a"}`,
    "",
    "## Missing Context",
    ...(output?.missing_context.length ? output.missing_context.map((entry) => `- ${entry}`) : ["- none recorded"])
  ].join("\n");
}

function traceMetadata(input: PromptWriterInput, extra: Record<string, unknown> = {}) {
  return {
    run_id: input.run_id,
    task_id: input.task_id,
    target_agent_role: input.target_agent_role,
    template_id: input.template_id,
    template_version: input.template_version,
    mode: input.mode,
    ...extra,
    team_id: input.team_id,
    team_memory_scope: input.team_memory_scope,
    team_context_ref_count: input.team_context_refs?.length ?? 0
  };
}

function evidenceRefsFromPack(pack: ContextPack) {
  return uniqueStrings((pack.included_items ?? []).flatMap((item) => item.evidence_refs));
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function promptWriterOutputSchemaHint() {
  return {
    name: "PromptWriterOutput",
    schema_version: PROMPT_WRITER_SCHEMA_VERSION,
    strict: true
  };
}
