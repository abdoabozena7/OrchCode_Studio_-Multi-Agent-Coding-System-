import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { FactoryMetadataAdapter } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import { AgentTeamManager } from "./AgentTeamManager.js";
import type { TeamContextScope } from "./AgentTeamModels.js";
import { evaluatePromptQuality, isPromptQualityBlocking, summarizePromptQuality } from "./PromptQualityGate.js";
import {
  createPromptArtifact,
  renderPromptTemplate,
  swarmPromptTemplateIdForRole,
  type PromptArtifactMetadata
} from "./PromptSystem.js";
import {
  normalizeReadOnlySwarmOutput,
  schemaForReadOnlySwarmRole,
  summarizeReadOnlySwarmOutput
} from "./ReadOnlySwarmWorkerSchemas.js";
import { SwarmArtifactStore } from "./SwarmArtifactStore.js";
import { defaultMockWorker, type SwarmWorker } from "./SwarmScheduler.js";
import { SWARM_SCHEMA_VERSION, type WorkItemResult } from "./SwarmModels.js";

export type SwarmProviderWorkerMode = "mock" | "provider_read_only" | "auto";

export type ProviderBackedSwarmWorkerOptions = {
  workspacePath: string;
  memoryDir?: string;
  mode?: SwarmProviderWorkerMode;
  providerFactory?: (role: string) => LlmProvider | undefined;
  providerName?: string;
  modelName?: string;
  fallbackWorker?: SwarmWorker;
};

export class ProviderBackedSwarmWorker {
  private readonly mode: SwarmProviderWorkerMode;
  private readonly artifactStore: SwarmArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;
  private readonly fallbackWorker: SwarmWorker;

  constructor(private readonly options: ProviderBackedSwarmWorkerOptions) {
    this.mode = options.mode ?? (options.providerFactory ? "provider_read_only" : "mock");
    this.artifactStore = new SwarmArtifactStore(options.workspacePath, options.memoryDir);
    this.traceWriter = new FactoryTraceWriter({ workspacePath: options.workspacePath, memoryDir: options.memoryDir, sourceComponent: "ProviderBackedSwarmWorker" });
    this.metadata = new FactoryMetadataAdapter(options.workspacePath, options.memoryDir);
    this.fallbackWorker = options.fallbackWorker ?? defaultMockWorker;
  }

  asWorker(): SwarmWorker {
    return (input) => this.run(input);
  }

  async run(input: Parameters<SwarmWorker>[0]): Promise<WorkItemResult> {
    if (this.mode === "mock") return this.fallbackWorker(input);
    const provider = this.options.providerFactory?.(input.workItem.required_role);
    if (!provider) {
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.workItem.id,
        event_type: "worker_provider_unavailable",
        lifecycle_stage: "executing",
        severity: this.mode === "auto" ? "warning" : "error",
        summary: "Provider-backed swarm worker is unavailable.",
        reason: "No provider factory/provider was configured for this role.",
        metadata_json: traceMetadata(input, {
          worker_mode: this.mode,
          fallback_reason: "provider_unavailable"
        })
      });
      if (this.mode === "auto") {
        await this.traceWriter.write({
          run_id: input.run.id,
          task_id: input.workItem.id,
          event_type: "provider_worker_fallback_to_mock",
          lifecycle_stage: "executing",
          severity: "warning",
          summary: "Falling back to mock swarm worker.",
          reason: "Provider unavailable in auto mode.",
          metadata_json: traceMetadata(input, {
            worker_mode: this.mode,
            fallback_reason: "provider_unavailable"
          })
        });
        return this.fallbackWorker(input);
      }
      return this.blockedResult(input, "Provider-backed worker requested but no provider is configured.");
    }

    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.workItem.id,
      event_type: "worker_provider_selected",
      lifecycle_stage: "executing",
      summary: "Provider-backed read-only swarm worker selected.",
      metadata_json: traceMetadata(input, {
        worker_mode: this.mode,
        provider_name: this.options.providerName,
        model_name: this.options.modelName
      })
    });

    const guard = readOnlyGuard(input);
    if (!guard.ok) {
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.workItem.id,
        event_type: "worker_read_only_guard_blocked",
        lifecycle_stage: "blocked",
        severity: "warning",
        summary: guard.reason,
        reason: guard.reason,
        metadata_json: traceMetadata(input, {
          worker_mode: this.mode,
          blocked_reason: guard.reason
        })
      });
      const result = this.blockedResult(input, guard.reason);
      await this.recordWorkerResultArtifact(input, result, { status: "blocked", errorSummary: guard.reason });
      return result;
    }
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.workItem.id,
      event_type: "worker_read_only_guard_passed",
      lifecycle_stage: "executing",
      summary: "Read-only guard passed for provider-backed swarm worker.",
      metadata_json: traceMetadata(input, { worker_mode: this.mode })
    });

    const invocationId = `worker_invocation_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const outputSchema = schemaForReadOnlySwarmRole(input.workItem.required_role, input.workItem.type);
    const teamContextScope = await this.resolveTeamContextScope(input);
    const contextSummary = await buildContextSummary(input, teamContextScope, this.options.workspacePath);
    const contextRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "context_summary",
      extension: "json",
      value: contextSummary,
      metadata: { worker_invocation_id: invocationId, team_id: teamContextScope?.team_id }
    });
    const promptResult = renderPromptTemplate(swarmPromptTemplateIdForRole(input.workItem.required_role, input.workItem.type), {
      run_id: input.run.id,
      task_id: input.workItem.id,
      agent_id: input.agent.id,
      agent_role: input.workItem.required_role,
      task_title: `${input.workItem.type} ${input.workItem.id}`,
      task_objective: input.run.user_goal,
      context_pack_ref: input.workItem.context_pack_ref ?? contextRef,
      allowed_files: [],
      forbidden_files: [".agent_memory/", ".git/", "node_modules/", "dist/", "build/", ".env"],
      relevant_files: input.workItem.read_files.filter((entry) => !looksLikeCommand(entry)),
      validation_requirements: input.workItem.type === "test" ? input.workItem.read_files.filter(looksLikeCommand) : [],
      expected_output_schema: outputSchema.name,
      output_schema_name: outputSchema.name,
      source_component: "ProviderBackedSwarmWorker",
      metadata_json: {
        work_item_type: input.workItem.type,
        worker_mode: this.mode,
        provider_name: this.options.providerName,
        model_name: this.options.modelName,
        team_context: teamContextScope ? {
          team_id: teamContextScope.team_id,
          parent_team_id: teamContextScope.parent_team_id,
          memory_scope: teamContextScope.memory_scope,
          team_context_scope_ref: teamContextScope.artifact_ref,
          warning_count: teamContextScope.warnings.length
        } : undefined
      }
    }, { sourceComponent: "ProviderBackedSwarmWorker" });
    if (!promptResult.ok) {
      const result = this.failedResult(input, promptResult.error.message, false);
      await this.recordWorkerInvocation({
        input,
        invocationId,
        createdAt,
        status: result.status,
        outputSchemaName: outputSchema.name,
        outputSchemaStatus: "not_run",
        errorSummary: promptResult.error.message
      });
      return result;
    }

    const promptRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "prompt",
      extension: "md",
      value: promptResult.rendered.text,
      metadata: { prompt_id: promptResult.rendered.prompt_id, worker_invocation_id: invocationId }
    });
    const promptMetadata: PromptArtifactMetadata = createPromptArtifact(promptResult.rendered, promptRef);
    await this.metadata.recordPromptArtifactSaved(promptMetadata);

    const quality = evaluatePromptQuality(promptResult.rendered, {
      promptArtifactRef: promptRef,
      promptMetadata,
      contextPackRef: promptResult.rendered.context_pack_ref,
      expectedOutputSchema: outputSchema.name,
      allowedFiles: [],
      forbiddenFiles: [".agent_memory/", ".git/", "node_modules/", "dist/", "build/", ".env"],
      validationRequirements: input.workItem.type === "test" ? input.workItem.read_files.filter(looksLikeCommand) : [],
      successCriteria: ["Return strict JSON matching the requested read-only output schema."],
      stopConditions: ["Do not edit files.", "Do not create patches.", "Do not run commands."],
      artifactRefs: [contextRef]
    });
    const promptQualityRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "prompt_quality",
      extension: "json",
      value: quality,
      metadata: { prompt_id: promptResult.rendered.prompt_id, prompt_quality_result_id: quality.quality_result_id }
    });
    quality.artifact_ref = promptQualityRef;
    await this.metadata.recordPromptQualityResultSaved(quality, promptQualityRef);
    if (isPromptQualityBlocking(quality)) {
      const summary = summarizePromptQuality(quality);
      const result = this.blockedResult(input, summary);
      await this.recordWorkerInvocation({
        input,
        invocationId,
        createdAt,
        status: result.status,
        promptId: promptResult.rendered.prompt_id,
        promptQualityResultId: quality.quality_result_id,
        outputSchemaName: outputSchema.name,
        outputSchemaStatus: "not_run",
        errorSummary: summary,
        metadata: { prompt_ref: promptRef, prompt_quality_ref: promptQualityRef, team_id: teamContextScope?.team_id, team_memory_scope: teamContextScope?.memory_scope }
      });
      return result;
    }

    let rawOutput: unknown;
    let startedTraceId: string | undefined;
    try {
      const started = await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.workItem.id,
        event_type: "provider_invocation_started",
        lifecycle_stage: "executing",
        summary: "Provider invocation started for read-only swarm worker.",
        artifact_refs: [promptRef, promptQualityRef],
        metadata_json: traceMetadata(input, {
          worker_mode: this.mode,
          provider_name: this.options.providerName,
          model_name: this.options.modelName,
          prompt_id: promptResult.rendered.prompt_id,
          prompt_quality_result_id: quality.quality_result_id
        })
      });
      startedTraceId = started.trace_event_id;
      rawOutput = await provider.generateStructured({
        systemPrompt: "You are a read-only swarm worker. Return strict JSON only. Never propose patches, commands, or file writes.",
        userPrompt: promptResult.rendered.text,
        context: contextSummary
      }, outputSchema);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.workItem.id,
        event_type: "provider_invocation_completed",
        lifecycle_stage: "executing",
        causal_parent_event_id: startedTraceId,
        summary: "Provider invocation completed for read-only swarm worker.",
        metadata_json: traceMetadata(input, {
          worker_mode: this.mode,
          provider_name: this.options.providerName,
          model_name: this.options.modelName,
          prompt_id: promptResult.rendered.prompt_id
        })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.traceWriter.write({
        run_id: input.run.id,
        task_id: input.workItem.id,
        event_type: "provider_invocation_failed",
        lifecycle_stage: "executing",
        causal_parent_event_id: startedTraceId,
        severity: "error",
        summary: message,
        reason: message,
        metadata_json: traceMetadata(input, {
          worker_mode: this.mode,
          provider_name: this.options.providerName,
          model_name: this.options.modelName,
          prompt_id: promptResult.rendered.prompt_id
        })
      });
      const result = this.failedResult(input, message, false);
      await this.recordWorkerInvocation({
        input,
        invocationId,
        createdAt,
        status: result.status,
        promptId: promptResult.rendered.prompt_id,
        promptQualityResultId: quality.quality_result_id,
        outputSchemaName: outputSchema.name,
        outputSchemaStatus: "not_run",
        errorSummary: message,
        metadata: { prompt_ref: promptRef, prompt_quality_ref: promptQualityRef, team_id: teamContextScope?.team_id, team_memory_scope: teamContextScope?.memory_scope }
      });
      return result;
    }

    const rawRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "raw_output",
      extension: "md",
      value: typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput, null, 2),
      metadata: { worker_invocation_id: invocationId }
    });
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.workItem.id,
      event_type: "provider_output_saved",
      lifecycle_stage: "executing",
      summary: "Provider raw output saved.",
      artifact_refs: [rawRef],
      metadata_json: traceMetadata(input, {
        raw_output_ref: rawRef,
        output_schema_name: outputSchema.name
      })
    });

    const normalizedOutput = normalizeReadOnlySwarmOutput(rawOutput, outputSchema);
    const validation = normalizedOutput.validation;
    const validationRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "schema_validation",
      extension: "json",
      value: {
        ...validation,
        repaired: normalizedOutput.repaired,
        repair_reasons: normalizedOutput.repair_reasons
      },
      metadata: {
        worker_invocation_id: invocationId,
        output_schema_status: validation.valid ? "passed" : "failed",
        schema_repaired: normalizedOutput.repaired
      }
    });
    const schemaTrace = await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.workItem.id,
      event_type: validation.valid
        ? normalizedOutput.repaired
          ? "provider_output_schema_repaired"
          : "provider_output_schema_validated"
        : "provider_output_schema_failed",
      lifecycle_stage: "executing",
      severity: validation.valid ? normalizedOutput.repaired ? "warning" : "info" : "error",
      summary: validation.valid
        ? normalizedOutput.repaired
          ? "Provider read-only output schema was repaired and validated."
          : "Provider read-only output schema validated."
        : "Provider read-only output schema failed.",
      reason: validation.valid && normalizedOutput.repaired ? normalizedOutput.repair_reasons.join("; ") : validation.errors.join("; ") || undefined,
      artifact_refs: [validationRef],
      metadata_json: traceMetadata(input, {
        output_schema_name: outputSchema.name,
        output_schema_status: validation.valid ? "passed" : "failed",
        schema_repaired: normalizedOutput.repaired
      })
    });

    if (!validation.valid) {
      const result = this.failedResult(input, `Provider output schema failed: ${validation.errors.join("; ")}`, false);
      await this.recordWorkerResultArtifact(input, result, { status: result.status, errorSummary: result.summary });
      await this.recordWorkerInvocation({
        input,
        invocationId,
        createdAt,
        status: result.status,
        promptId: promptResult.rendered.prompt_id,
        promptQualityResultId: quality.quality_result_id,
        rawOutputRef: rawRef,
        outputSchemaName: outputSchema.name,
        outputSchemaStatus: "failed",
        traceEventId: schemaTrace.trace_event_id,
        errorSummary: result.summary,
        metadata: { prompt_ref: promptRef, prompt_quality_ref: promptQualityRef, schema_validation_ref: validationRef, team_id: teamContextScope?.team_id, team_memory_scope: teamContextScope?.memory_scope }
      });
      return result;
    }

    const summary = summarizeReadOnlySwarmOutput(normalizedOutput.value);
    const parsedRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "parsed_output",
      extension: "json",
      value: normalizedOutput.value,
      metadata: {
        worker_invocation_id: invocationId,
        output_schema_name: outputSchema.name,
        schema_repaired: normalizedOutput.repaired
      }
    });
    const result: WorkItemResult = {
      schema_version: SWARM_SCHEMA_VERSION,
      work_item_id: input.workItem.id,
      status: "succeeded",
      summary: summary.summary,
      relevant_files: summary.relevant_files,
      findings: summary.findings,
      risks: summary.risks,
      unknowns: summary.unknowns,
      validation_passed: input.workItem.type === "test" ? false : undefined,
      structured_output_valid: true,
      confidence: summary.confidence
    };
    await this.recordWorkerResultArtifact(input, result, { status: result.status });
    await this.recordWorkerInvocation({
      input,
      invocationId,
      createdAt,
      status: result.status,
      promptId: promptResult.rendered.prompt_id,
      promptQualityResultId: quality.quality_result_id,
      rawOutputRef: rawRef,
      parsedOutputRef: parsedRef,
      outputSchemaName: outputSchema.name,
      outputSchemaStatus: "passed",
      traceEventId: schemaTrace.trace_event_id,
      metadata: {
        prompt_ref: promptRef,
        prompt_quality_ref: promptQualityRef,
        schema_validation_ref: validationRef,
        schema_repaired: normalizedOutput.repaired,
        repair_reasons: normalizedOutput.repair_reasons,
        team_id: teamContextScope?.team_id,
        team_memory_scope: teamContextScope?.memory_scope
      }
    });
    return result;
  }

  private blockedResult(input: Parameters<SwarmWorker>[0], summary: string): WorkItemResult {
    return this.failedResult(input, summary, true);
  }

  private failedResult(input: Parameters<SwarmWorker>[0], summary: string, blocked: boolean): WorkItemResult {
    return {
      schema_version: SWARM_SCHEMA_VERSION,
      work_item_id: input.workItem.id,
      status: blocked ? "blocked" : "failed",
      summary,
      relevant_files: input.workItem.read_files.filter((file) => !looksLikeCommand(file)),
      findings: [],
      risks: [summary],
      unknowns: [],
      structured_output_valid: false,
      confidence: 0.2
    };
  }

  private async recordWorkerResultArtifact(input: Parameters<SwarmWorker>[0], result: WorkItemResult, metadata: { status: string; errorSummary?: string }) {
    const resultRef = await this.artifactStore.saveProviderWorkerArtifact({
      runId: input.run.id,
      workItemId: input.workItem.id,
      name: "worker_result",
      extension: "json",
      value: result,
      metadata
    });
    await this.traceWriter.write({
      run_id: input.run.id,
      task_id: input.workItem.id,
      event_type: "provider_worker_result_recorded",
      lifecycle_stage: "executing",
      severity: result.status === "succeeded" ? "info" : result.status === "blocked" ? "warning" : "error",
      summary: "Provider worker result recorded.",
      artifact_refs: [resultRef],
      metadata_json: traceMetadata(input, {
        worker_mode: this.mode,
        status: result.status,
        result_ref: resultRef
      })
    });
  }

  private async recordWorkerInvocation(input: {
    input: Parameters<SwarmWorker>[0];
    invocationId: string;
    createdAt: string;
    status: string;
    promptId?: string;
    promptQualityResultId?: string;
    rawOutputRef?: string;
    parsedOutputRef?: string;
    outputSchemaName?: string;
    outputSchemaStatus?: string;
    traceEventId?: string;
    errorSummary?: string;
    metadata?: Record<string, unknown>;
  }) {
    await this.metadata.recordWorkerInvocationSaved({
      workerInvocationId: input.invocationId,
      runId: input.input.run.id,
      taskId: input.input.workItem.task_id,
      workItemId: input.input.workItem.id,
      agentId: input.input.agent.id,
      agentRole: input.input.workItem.required_role,
      workerMode: this.mode,
      providerName: this.options.providerName,
      modelName: this.options.modelName,
      promptId: input.promptId,
      promptQualityResultId: input.promptQualityResultId,
      rawOutputRef: input.rawOutputRef,
      parsedOutputRef: input.parsedOutputRef,
      outputSchemaName: input.outputSchemaName,
      outputSchemaStatus: input.outputSchemaStatus,
      traceEventId: input.traceEventId,
      status: input.status,
      errorSummary: input.errorSummary,
      createdAt: input.createdAt,
      completedAt: new Date().toISOString(),
      metadata: input.metadata
    });
  }

  private async resolveTeamContextScope(input: Parameters<SwarmWorker>[0]): Promise<TeamContextScope | undefined> {
    const teamId = input.workItem.team_id ?? await this.findAssignedTeamId(input.run.id, input.workItem.id);
    if (!teamId) return undefined;
    return new AgentTeamManager({ workspacePath: this.options.workspacePath, memoryDir: this.options.memoryDir }).getTeamContextScope(teamId);
  }

  private async findAssignedTeamId(runId: string, workItemId: string) {
    try {
      const store = await import("./FactoryMetadataStore.js").then((module) => module.FactoryMetadataStore.open({
        workspacePath: this.options.workspacePath,
        memoryDir: this.options.memoryDir,
        readOnly: true
      }));
      try {
        const row = store.get<{ team_id: string }>(
          "SELECT team_id FROM factory_agent_team_assignments WHERE run_id = ? AND target_id = ? AND assignment_type = 'task' ORDER BY created_at DESC LIMIT 1",
          runId,
          workItemId
        );
        return row?.team_id;
      } finally {
        store.close();
      }
    } catch {
      return undefined;
    }
  }
}

function readOnlyGuard(input: Parameters<SwarmWorker>[0]): { ok: true } | { ok: false; reason: string } {
  if (input.workItem.write_files.length > 0) return { ok: false, reason: "Provider-backed read-only worker cannot handle work items with write files." };
  if (input.template.can_edit_files) return { ok: false, reason: `Provider-backed read-only worker rejects edit-capable template ${input.template.id}.` };
  if (input.template.can_run_commands && input.workItem.required_role !== "TesterAgent") {
    return { ok: false, reason: `Provider-backed read-only worker rejects command-capable template ${input.template.id}.` };
  }
  if (input.workItem.type === "execute" || input.workItem.type === "integrate") return { ok: false, reason: `Provider-backed worker rejects write-capable work item type ${input.workItem.type}.` };
  if (/Executor|Integrator|Repair/i.test(input.workItem.required_role) || /Repair/i.test(input.workItem.expected_output_schema) || input.workItem.id.startsWith("swarm_repair_")) {
    return { ok: false, reason: `Provider-backed worker rejects write-capable role/schema ${input.workItem.required_role}.` };
  }
  if (input.template.allowed_operations.some((operation) => operation === "propose_patch" || operation === "update_memory")) {
    return { ok: false, reason: "Provider-backed read-only worker rejects patch or direct memory mutation operations." };
  }
  return { ok: true };
}

async function buildContextSummary(input: Parameters<SwarmWorker>[0], teamContextScope: TeamContextScope | undefined, workspacePath: string) {
  const fileExcerpts = await readFileExcerpts(workspacePath, input.workItem.read_files);
  return {
    run_id: input.run.id,
    work_item_id: input.workItem.id,
    user_goal: input.run.user_goal,
    role: input.workItem.required_role,
    work_item_type: input.workItem.type,
    read_files: input.workItem.read_files,
    file_excerpts: fileExcerpts,
    write_files: input.workItem.write_files,
    risk_level: input.workItem.risk_level,
    context_pack_ref: input.workItem.context_pack_ref,
    team_context: teamContextScope ? {
      team_id: teamContextScope.team_id,
      parent_team_id: teamContextScope.parent_team_id,
      domain: teamContextScope.domain,
      objective: teamContextScope.objective,
      team_type: teamContextScope.team_type,
      memory_scope: teamContextScope.memory_scope,
      allowed_files: teamContextScope.allowed_files,
      forbidden_files: teamContextScope.forbidden_files,
      module_locks: teamContextScope.module_locks,
      semantic_locks: teamContextScope.semantic_locks,
      evidence_refs: teamContextScope.evidence_refs,
      warning_count: teamContextScope.warnings.length,
      artifact_ref: teamContextScope.artifact_ref
    } : undefined,
    expected_output_schema: input.workItem.expected_output_schema,
    staffing: {
      task_complexity: input.staffingPlan.task_complexity,
      repo_scope: input.staffingPlan.repo_scope,
      risk_level: input.staffingPlan.risk_level,
      validation_level: input.staffingPlan.validation_level
    },
    constraints: [
      "Read-only provider-backed worker.",
      "No file edits, patches, diffs, or shell commands.",
      "Validation can be recommended but not marked mechanically passed."
    ],
    confidence: input.workItem.context_pack_ref ? "medium" : "low",
    inclusion_metadata: {
      source: input.workItem.context_pack_ref ? "work_item.context_pack_ref" : "fallback_work_item_summary",
      inclusion_reason: fileExcerpts.length
        ? "Read-only file excerpts were included so provider-backed workers can inspect evidence, not just file names."
        : teamContextScope
          ? "Team-aware read-only context metadata for provider-backed swarm worker."
          : "Minimal read-only context for provider-backed swarm worker.",
      access_mode: "reference_only"
    }
  };
}

async function readFileExcerpts(workspacePath: string, readFiles: string[]) {
  const excerpts: Array<{ path: string; content: string; truncated: boolean; chars: number }> = [];
  let remaining = 18_000;
  for (const file of readFiles.filter((entry) => !looksLikeCommand(entry)).slice(0, 8)) {
    if (remaining <= 0) break;
    if (!isUsefulTextPath(file)) continue;
    const resolved = path.resolve(workspacePath, file);
    const root = path.resolve(workspacePath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) continue;
    const raw = await readFile(resolved, "utf8").catch(() => "");
    if (!raw.trim()) continue;
    const limit = Math.min(3_000, remaining);
    const content = raw.slice(0, limit);
    remaining -= content.length;
    excerpts.push({
      path: file.replaceAll("\\", "/"),
      content,
      truncated: raw.length > content.length,
      chars: content.length
    });
  }
  return excerpts;
}

function isUsefulTextPath(file: string) {
  return /\.(c|cc|conf|cpp|cs|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i.test(file)
    && !/(^|[\\/])(\.git|node_modules|dist|build|coverage|target|venv|\.venv|__pycache__)([\\/]|$)/i.test(file);
}

function traceMetadata(input: Parameters<SwarmWorker>[0], extra: Record<string, unknown> = {}) {
  return {
    run_id: input.run.id,
    work_item_id: input.workItem.id,
    task_id: input.workItem.task_id,
    role: input.workItem.required_role,
    team_id: input.workItem.team_id,
    work_item_type: input.workItem.type,
    agent_id: input.agent.id,
    ...extra
  };
}

function looksLikeCommand(value: string) {
  return /\b(npm|node|cargo|python|pytest|vitest|tsc|eslint|pnpm|yarn)\b/.test(value);
}
