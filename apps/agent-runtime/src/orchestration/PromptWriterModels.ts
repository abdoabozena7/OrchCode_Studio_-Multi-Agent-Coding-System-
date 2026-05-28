import type { PromptQualityResult, PromptQualityStatus } from "./PromptQualityGate.js";
import type { PromptTemplateInput, PromptTemplateVersion, PromptType, RenderedPrompt } from "./PromptSystem.js";

export const PROMPT_WRITER_SCHEMA_VERSION = 1;

export type PromptWriterMode = "off" | "shadow" | "advisory" | "gated_adopt";
export type PromptWriterProviderMode = "deterministic" | "provider_read_only" | "auto";
export type PromptWriterRoleName = "PromptWriterAgent";
export type PromptWriterAdoptionRecommendation = "do_not_adopt" | "advisory_only" | "adopt_if_gated" | "needs_more_context";
export type PromptWriterDecision = "off" | "shadow_recorded" | "advisory_recorded" | "adopted" | "rejected" | "fallback_used";
export type PromptWriterSchemaStatus = "passed" | "failed";

export type PromptWriterRole = {
  name: PromptWriterRoleName;
  target_agent_role: string;
  read_only: true;
  can_run_commands: false;
  can_modify_files: false;
  can_create_patches: false;
  can_mark_tasks_complete: false;
  adoption_allowed: boolean;
  allowed_template_patch_fields: string[];
};

export type PromptDraftSection = {
  section_id: string;
  title: string;
  content: string;
  source_refs: string[];
};

export type PromptDraft = {
  summary: string;
  sections: PromptDraftSection[];
};

export type PromptWriterFinding = {
  finding_id: string;
  severity: "info" | "warning" | "blocked";
  message: string;
  evidence_refs: string[];
};

export type PromptWriterInput = {
  schema_version: number;
  prompt_writer_input_id: string;
  run_id: string;
  task_id: string;
  target_agent_role: string;
  target_prompt_type: PromptType | string;
  template_id: string;
  template_version: PromptTemplateVersion;
  task_objective: string;
  context_pack_ref: string;
  context_inclusion_summary: Record<string, unknown>;
  allowed_files: string[];
  forbidden_files: string[];
  read_only_files?: string[];
  expected_output_schema: string;
  validation_requirements: string[];
  success_criteria: string[];
  stop_conditions: string[];
  planning_evidence_refs: string[];
  prior_decision_refs?: string[];
  prior_failure_refs?: string[];
  team_id?: string;
  team_context_refs?: string[];
  team_memory_scope?: string;
  risk_summary: string[];
  mode: PromptWriterMode;
  metadata_json: Record<string, unknown>;
};

export type PromptWriterOutput = {
  schema_version: number;
  prompt_writer_output_id: string;
  run_id: string;
  task_id: string;
  target_agent_role: string;
  target_prompt_type: PromptType | string;
  recommended_template_id: string;
  recommended_template_version: PromptTemplateVersion;
  prompt_draft: PromptDraft;
  template_input_patch?: Partial<PromptTemplateInput>;
  rationale: string[];
  risks: string[];
  missing_context: string[];
  suggested_success_criteria: string[];
  suggested_stop_conditions: string[];
  suggested_validation_requirements: string[];
  confidence: number;
  adoption_recommendation: PromptWriterAdoptionRecommendation;
  artifact_ref?: string;
  created_at: string;
};

export type PromptWriterQualitySummary = {
  quality_result_id?: string;
  status: PromptQualityStatus | "not_run";
  blocking: boolean;
  warnings_count: number;
  failures_count: number;
  blocked_count: number;
  unsafe_pattern_hits: string[];
};

export type PromptWriterAdoptionDecision = {
  schema_version: number;
  adoption_decision_id: string;
  run_id: string;
  task_id: string;
  prompt_writer_output_id?: string;
  candidate_prompt_id?: string;
  original_prompt_id?: string;
  mode: PromptWriterMode;
  decision: PromptWriterDecision;
  reason: string;
  quality_status: PromptQualityStatus | "not_run";
  adopted: boolean;
  trace_event_id?: string;
  artifact_ref?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PromptWriterSchemaValidation = {
  schema_status: PromptWriterSchemaStatus;
  errors: string[];
  safety_findings: PromptWriterFinding[];
};

export type PromptWriterRunResult = {
  mode: PromptWriterMode;
  provider_mode: PromptWriterProviderMode | "fallback";
  input: PromptWriterInput;
  output?: PromptWriterOutput;
  schema_validation: PromptWriterSchemaValidation;
  quality_summary: PromptWriterQualitySummary;
  adoption_decision: PromptWriterAdoptionDecision;
  artifact_refs: Record<string, string | undefined>;
  candidate_rendered_prompt?: RenderedPrompt;
  candidate_prompt_text?: string;
  template_input_patch?: Partial<PromptTemplateInput>;
};

const OUTPUT_KEYS = new Set([
  "schema_version",
  "prompt_writer_output_id",
  "run_id",
  "task_id",
  "target_agent_role",
  "target_prompt_type",
  "recommended_template_id",
  "recommended_template_version",
  "prompt_draft",
  "template_input_patch",
  "rationale",
  "risks",
  "missing_context",
  "suggested_success_criteria",
  "suggested_stop_conditions",
  "suggested_validation_requirements",
  "confidence",
  "adoption_recommendation",
  "artifact_ref",
  "created_at"
]);

const PATCH_SAFETY_FIELDS = new Set([
  "allowed_files",
  "forbidden_files",
  "read_only_files",
  "context_pack_ref",
  "run_id",
  "task_id",
  "agent_role",
  "output_schema_name",
  "expected_output_schema"
]);

const UNSAFE_OUTPUT_PATTERNS = [
  { id: "skip_validation", pattern: /\b(skip|omit)\s+validation\b|\bdo\s+not\s+run\s+tests\b/i },
  { id: "ignore_allowed_files", pattern: /\bignore\s+(the\s+)?allowed\s+files?\b/i },
  { id: "ignore_forbidden_files", pattern: /\bignore\s+(the\s+)?forbidden\s+files?\b/i },
  { id: "run_commands", pattern: /\b(run|execute)\s+(shell\s+)?commands?\b/i },
  { id: "create_patch", pattern: /\b(create|apply|produce)\s+(a\s+)?(patch|diff)\b/i },
  { id: "modify_source", pattern: /\b(modify|edit|write|change)\s+(source\s+)?files?\b/i },
  { id: "mark_complete", pattern: /\b(mark|declare)\s+(the\s+)?task\s+complete\b/i },
  { id: "bypass_prompt_system", pattern: /\bbypass\s+(PromptSystem|prompt\s+system|PromptQualityGate|quality\s+gate)\b/i }
];

export function promptWriterRoleForTarget(targetAgentRole: string): PromptWriterRole {
  return {
    name: "PromptWriterAgent",
    target_agent_role: targetAgentRole,
    read_only: true,
    can_run_commands: false,
    can_modify_files: false,
    can_create_patches: false,
    can_mark_tasks_complete: false,
    adoption_allowed: true,
    allowed_template_patch_fields: ["task_objective", "validation_requirements", "metadata_json", "source_component"]
  };
}

export function validatePromptWriterOutput(value: unknown, input: PromptWriterInput): PromptWriterSchemaValidation {
  const errors: string[] = [];
  const safetyFindings: PromptWriterFinding[] = [];
  const record = asRecord(value);
  if (!record) {
    return { schema_status: "failed", errors: ["Output must be an object."], safety_findings: [] };
  }

  for (const key of Object.keys(record)) {
    if (!OUTPUT_KEYS.has(key)) errors.push(`Unexpected top-level field: ${key}.`);
  }

  requireNumber(record, "schema_version", errors);
  requireString(record, "prompt_writer_output_id", errors);
  requireString(record, "run_id", errors);
  requireString(record, "task_id", errors);
  requireString(record, "target_agent_role", errors);
  requireString(record, "target_prompt_type", errors);
  requireString(record, "recommended_template_id", errors);
  requireString(record, "recommended_template_version", errors);
  requireStringArray(record, "rationale", errors);
  requireStringArray(record, "risks", errors);
  requireStringArray(record, "missing_context", errors);
  requireStringArray(record, "suggested_success_criteria", errors);
  requireStringArray(record, "suggested_stop_conditions", errors);
  requireStringArray(record, "suggested_validation_requirements", errors);
  requireString(record, "created_at", errors);
  if (typeof record.confidence !== "number" || record.confidence < 0 || record.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1.");
  }
  if (!["do_not_adopt", "advisory_only", "adopt_if_gated", "needs_more_context"].includes(String(record.adoption_recommendation))) {
    errors.push("adoption_recommendation is invalid.");
  }
  validatePromptDraft(record.prompt_draft, errors);

  if (record.run_id !== input.run_id) errors.push("run_id does not match PromptWriterInput.");
  if (record.task_id !== input.task_id) errors.push("task_id does not match PromptWriterInput.");
  if (record.target_agent_role !== input.target_agent_role) errors.push("target_agent_role does not match PromptWriterInput.");
  if (record.target_prompt_type !== input.target_prompt_type) errors.push("target_prompt_type does not match PromptWriterInput.");

  const patch = asRecord(record.template_input_patch);
  if (patch) {
    for (const key of Object.keys(patch)) {
      if (PATCH_SAFETY_FIELDS.has(key)) {
        safetyFindings.push(blockedFinding(`patch_${key}`, `PromptWriter output attempted to change protected template input field ${key}.`));
      }
    }
    if (Array.isArray(patch.validation_requirements)) {
      const suggested = patch.validation_requirements.filter((entry): entry is string => typeof entry === "string");
      const missingExisting = input.validation_requirements.filter((entry) => !suggested.includes(entry));
      if (missingExisting.length) {
        safetyFindings.push(blockedFinding("validation_requirements_weakened", "PromptWriter output attempted to remove validation requirements."));
      }
    }
  }

  const searchableText = JSON.stringify(record);
  for (const unsafe of UNSAFE_OUTPUT_PATTERNS) {
    if (unsafe.pattern.test(searchableText)) {
      safetyFindings.push(blockedFinding(unsafe.id, `PromptWriter output contains unsafe pattern: ${unsafe.id}.`));
    }
  }

  return {
    schema_status: errors.length || safetyFindings.some((finding) => finding.severity === "blocked") ? "failed" : "passed",
    errors,
    safety_findings: safetyFindings
  };
}

export function applyPromptWriterTemplateInputPatch(
  original: PromptTemplateInput,
  output: PromptWriterOutput
): { ok: true; input: PromptTemplateInput } | { ok: false; reason: string } {
  const patch = asRecord(output.template_input_patch) ?? {};
  for (const key of Object.keys(patch)) {
    if (!promptWriterRoleForTarget(output.target_agent_role).allowed_template_patch_fields.includes(key)) {
      return { ok: false, reason: `Template input patch field is not allowed: ${key}.` };
    }
  }
  const next: PromptTemplateInput = { ...original };
  if (typeof patch.task_objective === "string" && patch.task_objective.trim()) {
    next.task_objective = patch.task_objective.trim();
  }
  if (Array.isArray(patch.validation_requirements)) {
    const requirements = patch.validation_requirements.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    const missingExisting = asStringArray(original.validation_requirements).filter((entry) => !requirements.includes(entry));
    if (missingExisting.length) return { ok: false, reason: "Template input patch cannot remove validation requirements." };
    next.validation_requirements = uniqueStrings([...asStringArray(original.validation_requirements), ...requirements]);
  }
  if (asRecord(patch.metadata_json)) {
    next.metadata_json = {
      ...asRecord(original.metadata_json),
      ...asRecord(patch.metadata_json),
      prompt_writer_output_id: output.prompt_writer_output_id
    };
  }
  next.source_component = "PromptWriterService";
  return { ok: true, input: next };
}

export function promptWriterQualitySummaryFromResult(result?: PromptQualityResult): PromptWriterQualitySummary {
  if (!result) {
    return {
      status: "not_run",
      blocking: false,
      warnings_count: 0,
      failures_count: 0,
      blocked_count: 0,
      unsafe_pattern_hits: []
    };
  }
  return {
    quality_result_id: result.quality_result_id,
    status: result.status,
    blocking: result.blocking,
    warnings_count: result.warnings_count,
    failures_count: result.failures_count,
    blocked_count: result.blocked_count,
    unsafe_pattern_hits: result.unsafe_pattern_hits
  };
}

function validatePromptDraft(value: unknown, errors: string[]) {
  const draft = asRecord(value);
  if (!draft) {
    errors.push("prompt_draft must be an object.");
    return;
  }
  requireString(draft, "summary", errors, "prompt_draft.summary");
  if (!Array.isArray(draft.sections)) {
    errors.push("prompt_draft.sections must be an array.");
    return;
  }
  for (const [index, sectionValue] of draft.sections.entries()) {
    const section = asRecord(sectionValue);
    if (!section) {
      errors.push(`prompt_draft.sections[${index}] must be an object.`);
      continue;
    }
    requireString(section, "section_id", errors, `prompt_draft.sections[${index}].section_id`);
    requireString(section, "title", errors, `prompt_draft.sections[${index}].title`);
    requireString(section, "content", errors, `prompt_draft.sections[${index}].content`);
    requireStringArray(section, "source_refs", errors, `prompt_draft.sections[${index}].source_refs`);
  }
}

function requireString(record: Record<string, unknown>, key: string, errors: string[], label = key) {
  if (typeof record[key] !== "string" || !String(record[key]).length) errors.push(`${label} must be a non-empty string.`);
}

function requireNumber(record: Record<string, unknown>, key: string, errors: string[]) {
  if (typeof record[key] !== "number") errors.push(`${key} must be a number.`);
}

function requireStringArray(record: Record<string, unknown>, key: string, errors: string[], label = key) {
  if (!Array.isArray(record[key]) || (record[key] as unknown[]).some((entry) => typeof entry !== "string")) {
    errors.push(`${label} must be a string array.`);
  }
}

function blockedFinding(id: string, message: string): PromptWriterFinding {
  return {
    finding_id: id,
    severity: "blocked",
    message,
    evidence_refs: []
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
