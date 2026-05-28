import { createHash } from "node:crypto";
import type { ContextPack, Task } from "./OrchestrationModels.js";
import type { PromptArtifactMetadata, RenderedPrompt } from "./PromptSystem.js";

export type PromptQualityStatus = "passed" | "warning" | "failed" | "blocked" | "not_required";
export type PromptQualityFindingSeverity = "passed" | "warning" | "failed" | "blocked";
export type PromptRoleProfileName =
  | "scout"
  | "planner"
  | "executor"
  | "reviewer"
  | "tester"
  | "reporter"
  | "repair"
  | "integrator"
  | "generic";

export type PromptQualityFinding = {
  check_id: string;
  severity: PromptQualityFindingSeverity;
  message: string;
  metadata_json?: Record<string, unknown>;
};

export type PromptQualityRoleProfile = {
  name: PromptRoleProfileName;
  write_capable: boolean;
  requires_validation_section: boolean;
  requires_allowed_scope: boolean;
  requires_stop_conditions: boolean;
  requires_report_scope: boolean;
};

export type PromptQualityContext = {
  task?: Task;
  contextPack?: ContextPack;
  contextPackRef?: string;
  promptArtifactRef?: string;
  promptMetadata?: PromptArtifactMetadata;
  expectedOutputSchema?: string;
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  validationRequirements?: string[];
  successCriteria?: string[];
  stopConditions?: string[];
  reportScope?: string;
  artifactRefs?: string[];
  traceSummaryRefs?: string[];
  allowedValidationSkipReason?: string;
  skipGate?: boolean;
};

export type PromptQualityResult = {
  quality_result_id: string;
  prompt_id: string;
  run_id: string;
  task_id: string;
  agent_id?: string;
  agent_role: string;
  status: PromptQualityStatus;
  blocking: boolean;
  role_profile: PromptRoleProfileName;
  checks_passed_count: number;
  warnings_count: number;
  failures_count: number;
  blocked_count: number;
  findings: PromptQualityFinding[];
  unsafe_pattern_hits: string[];
  consistency_checks: Record<string, "passed" | "warning" | "failed" | "blocked">;
  checked_metadata: Record<string, unknown>;
  suggested_remediation: string[];
  artifact_ref?: string;
  trace_event_id?: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
};

export type PromptQualitySummary = {
  prompts_checked: number;
  prompts_passed: number;
  prompts_with_warnings: number;
  prompts_failed: number;
  prompts_blocked: number;
  unsafe_pattern_count: number;
  metadata_mismatch_count: number;
};

const ROLE_PROFILES: Record<PromptRoleProfileName, PromptQualityRoleProfile> = {
  scout: { name: "scout", write_capable: false, requires_validation_section: false, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: false },
  planner: { name: "planner", write_capable: false, requires_validation_section: false, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: false },
  executor: { name: "executor", write_capable: true, requires_validation_section: true, requires_allowed_scope: true, requires_stop_conditions: true, requires_report_scope: false },
  reviewer: { name: "reviewer", write_capable: false, requires_validation_section: false, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: false },
  tester: { name: "tester", write_capable: false, requires_validation_section: true, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: false },
  reporter: { name: "reporter", write_capable: false, requires_validation_section: false, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: true },
  repair: { name: "repair", write_capable: true, requires_validation_section: true, requires_allowed_scope: true, requires_stop_conditions: true, requires_report_scope: false },
  integrator: { name: "integrator", write_capable: true, requires_validation_section: true, requires_allowed_scope: true, requires_stop_conditions: true, requires_report_scope: false },
  generic: { name: "generic", write_capable: false, requires_validation_section: false, requires_allowed_scope: false, requires_stop_conditions: false, requires_report_scope: false }
};

const UNSAFE_PATTERNS: Array<{ id: string; pattern: RegExp; global: boolean }> = [
  { id: "modify_anything", pattern: /\b(modify|edit|change)\s+(anything|any\s+file|all\s+files?)\b/i, global: false },
  { id: "ignore_allowed_files", pattern: /\bignore\s+(the\s+)?allowed\s+files?\b/i, global: true },
  { id: "skip_validation", pattern: /\b(skip|omit)\s+validation\b|\bdo\s+not\s+run\s+tests\b/i, global: false },
  { id: "delete_files_without_context", pattern: /\b(delete|remove)\s+files?\b/i, global: false },
  { id: "bypass_policy", pattern: /\b(bypass|ignore)\s+(policy|safety|approval|guardrails?)\b/i, global: true },
  { id: "ignore_errors", pattern: /\bignore\s+errors?\b/i, global: false },
  { id: "continue_after_validation_failure", pattern: /\bcontinue\s+even\s+if\s+validation\s+fails\b/i, global: true }
];

export function evaluatePromptQuality(renderedPrompt: RenderedPrompt, context: PromptQualityContext = {}): PromptQualityResult {
  const profile = profileForRole(renderedPrompt.agent_role);
  const findings: PromptQualityFinding[] = [];
  const consistencyChecks: PromptQualityResult["consistency_checks"] = {};
  const unsafePatternHits: string[] = [];
  const createdAt = new Date().toISOString();

  if (context.skipGate) {
    return buildResult(renderedPrompt, profile, [{
      check_id: "gate_not_required",
      severity: "passed",
      message: "Prompt quality gate was explicitly marked not required for this compatibility path."
    }], unsafePatternHits, consistencyChecks, context, "not_required", createdAt);
  }

  requireMetadata(findings, renderedPrompt.run_id, "run_id", "Run id is present.");
  requireMetadata(findings, renderedPrompt.task_id, "task_id", "Task id is present.");
  requireMetadata(findings, renderedPrompt.agent_role, "agent_role", "Agent role is present.");
  requireMetadata(findings, renderedPrompt.context_pack_ref, "context_pack_ref", "Context pack ref is present.");
  requireMetadata(findings, renderedPrompt.output_schema_name, "output_schema_name", "Output schema name is present.");
  requireMetadata(findings, renderedPrompt.template_id, "template_id", "Template id is present.");
  requireMetadata(findings, renderedPrompt.template_version, "template_version", "Template version is present.");
  requireMetadata(findings, context.promptArtifactRef ?? context.promptMetadata?.artifact_ref, "prompt_artifact_ref", "Prompt artifact ref is present.");

  requireText(findings, /^Role:\s*\S+/m.test(renderedPrompt.text), "prompt_role_present", "Rendered prompt includes a role line.");
  requireText(findings, /^Task:\s*\S+/m.test(renderedPrompt.text), "prompt_task_present", "Rendered prompt includes a task line.");
  requireText(findings, /^Objective:\s*\S+/m.test(renderedPrompt.text), "prompt_objective_present", "Rendered prompt includes an objective line.");
  requireText(findings, /Return structured output/i.test(renderedPrompt.text), "prompt_output_contract_present", "Rendered prompt includes a structured-output contract.");

  if (profile.requires_allowed_scope) {
    const allowedSection = parseSection(renderedPrompt.text, "Allowed files to edit");
    if (!allowedSection.present) {
      add(findings, "allowed_files_section_missing", "blocked", "Write-capable role prompt is missing the allowed-files section.");
    } else {
      add(findings, "allowed_files_section_present", "passed", "Write-capable role prompt includes an allowed-files section.");
    }
  }
  const forbiddenSection = parseSection(renderedPrompt.text, "Forbidden files");
  if (!forbiddenSection.present) {
    add(findings, "forbidden_files_section_missing", profile.write_capable ? "blocked" : "failed", "Prompt is missing forbidden-files scope or an explicit empty list.");
  } else {
    add(findings, "forbidden_files_section_present", "passed", "Prompt includes forbidden-files scope or an explicit empty list.");
  }

  const validationSection = parseSection(renderedPrompt.text, "Validation requirements");
  if (profile.requires_validation_section && !validationSection.present) {
    add(findings, "validation_section_missing", "blocked", "Role profile requires validation requirements or an explicit empty validation list.");
  } else if (validationSection.present) {
    add(findings, "validation_section_present", "passed", "Prompt includes validation requirements or an explicit empty validation list.");
    if (profile.write_capable && validationSection.items.length === 0) {
      add(findings, "validation_empty_for_write_role", "warning", "Write-capable role has an explicit empty validation list; downstream strict validation must report this honestly.");
    }
  }

  if (profile.requires_stop_conditions) {
    const hasStopCondition = context.stopConditions?.length
      || /do not claim validation that was not run/i.test(renderedPrompt.text)
      || /stop|blocked|approval|required/i.test(renderedPrompt.text);
    add(findings, "stop_conditions", hasStopCondition ? "passed" : "blocked", hasStopCondition
      ? "Stop condition is present or derivable."
      : "Write-capable role prompt is missing stop conditions.");
  }
  const hasSuccessCriteria = Boolean(context.successCriteria?.length)
    || Boolean(context.expectedOutputSchema ?? context.task?.expected_output_schema ?? renderedPrompt.output_schema_name)
    || /Return structured output/i.test(renderedPrompt.text);
  add(findings, "success_criteria", hasSuccessCriteria ? "passed" : "failed", hasSuccessCriteria
    ? "Success criteria are present or derivable from the output schema."
    : "Success criteria are not present or derivable.");

  if (profile.requires_report_scope) {
    const hasReportScope = Boolean(context.reportScope)
      || Boolean(context.artifactRefs?.length)
      || Boolean(context.traceSummaryRefs?.length)
      || renderedPrompt.context_pack_ref.length > 0;
    add(findings, "report_scope", hasReportScope ? "passed" : "failed", hasReportScope
      ? "Reporter prompt has report scope through context or artifact refs."
      : "Reporter prompt is missing report scope, artifact refs, or trace summary refs.");
  }

  for (const unsafe of UNSAFE_PATTERNS) {
    if (!unsafe.pattern.test(renderedPrompt.text)) continue;
    if (unsafe.id === "skip_validation" && context.allowedValidationSkipReason) {
      add(findings, unsafe.id, "warning", `Unsafe validation skip language was found but an explicit skip reason exists: ${context.allowedValidationSkipReason}`);
      unsafePatternHits.push(unsafe.id);
      continue;
    }
    const severity: PromptQualityFindingSeverity = unsafe.global || profile.write_capable ? "blocked" : "warning";
    add(findings, unsafe.id, severity, `Prompt contains unsafe or unscoped instruction pattern: ${unsafe.id}.`);
    unsafePatternHits.push(unsafe.id);
  }

  checkConsistency(renderedPrompt.run_id, context.task?.run_id, "run_id_consistency", profile.write_capable, findings, consistencyChecks);
  checkConsistency(renderedPrompt.task_id, context.task?.id, "task_id_consistency", profile.write_capable, findings, consistencyChecks);
  checkConsistency(renderedPrompt.agent_role, context.task?.role_required, "agent_role_consistency", profile.write_capable, findings, consistencyChecks);
  checkConsistency(renderedPrompt.context_pack_ref, context.contextPackRef, "context_pack_ref_consistency", profile.write_capable, findings, consistencyChecks);
  checkConsistency(renderedPrompt.output_schema_name, context.expectedOutputSchema ?? context.task?.expected_output_schema, "output_schema_consistency", profile.write_capable, findings, consistencyChecks);

  const expectedAllowed = context.allowedFiles ?? context.task?.allowed_files_to_edit;
  if (expectedAllowed) {
    compareScopeList(parseSection(renderedPrompt.text, "Allowed files to edit").items, expectedAllowed, "allowed_files_consistency", profile.write_capable, findings, consistencyChecks);
  }
  const expectedForbidden = context.forbiddenFiles ?? context.task?.forbidden_files;
  if (expectedForbidden) {
    compareScopeList(parseSection(renderedPrompt.text, "Forbidden files").items, expectedForbidden, "forbidden_files_consistency", profile.write_capable, findings, consistencyChecks);
  }

  if (profile.write_capable && /\b(write|edit|modify|change)\b/i.test(renderedPrompt.text) && !parseSection(renderedPrompt.text, "Allowed files to edit").present) {
    add(findings, "unscoped_write_instruction", "blocked", "Write-like prompt language appears without an allowed-files section.");
  }

  return buildResult(renderedPrompt, profile, findings, unsafePatternHits, consistencyChecks, context, undefined, createdAt);
}

export function assertPromptQuality(renderedPrompt: RenderedPrompt, context: PromptQualityContext = {}) {
  const result = evaluatePromptQuality(renderedPrompt, context);
  if (isPromptQualityBlocking(result)) {
    throw new Error(summarizePromptQuality(result));
  }
  return result;
}

export function summarizePromptQuality(result: PromptQualityResult) {
  return `Prompt quality ${result.status}: ${result.blocked_count} blocked, ${result.failures_count} failed, ${result.warnings_count} warning finding(s).`;
}

export function isPromptQualityBlocking(result: PromptQualityResult) {
  return result.status === "blocked" || result.status === "failed";
}

export function promptQualityStatusToRunImpact(result: PromptQualityResult): "continue" | "failed" | "blocked" | "not_required" {
  if (result.status === "not_required") return "not_required";
  if (result.status === "blocked") return "blocked";
  if (result.status === "failed") return "failed";
  return "continue";
}

export function summarizePromptQualityResults(results: PromptQualityResult[]): PromptQualitySummary {
  return {
    prompts_checked: results.length,
    prompts_passed: results.filter((result) => result.status === "passed").length,
    prompts_with_warnings: results.filter((result) => result.status === "warning").length,
    prompts_failed: results.filter((result) => result.status === "failed").length,
    prompts_blocked: results.filter((result) => result.status === "blocked").length,
    unsafe_pattern_count: results.reduce((sum, result) => sum + result.unsafe_pattern_hits.length, 0),
    metadata_mismatch_count: results.reduce((sum, result) => sum + Object.values(result.consistency_checks).filter((status) => status === "failed" || status === "blocked").length, 0)
  };
}

function buildResult(
  prompt: RenderedPrompt,
  profile: PromptQualityRoleProfile,
  findings: PromptQualityFinding[],
  unsafePatternHits: string[],
  consistencyChecks: PromptQualityResult["consistency_checks"],
  context: PromptQualityContext,
  forcedStatus: PromptQualityStatus | undefined,
  createdAt: string
): PromptQualityResult {
  const blockedCount = findings.filter((finding) => finding.severity === "blocked").length;
  const failuresCount = findings.filter((finding) => finding.severity === "failed").length;
  const warningsCount = findings.filter((finding) => finding.severity === "warning").length;
  const status = forcedStatus ?? (
    blockedCount ? "blocked" :
      failuresCount ? "failed" :
        warningsCount ? "warning" :
          "passed"
  );
  return {
    quality_result_id: `prompt_quality_${hash([prompt.prompt_id, status, createdAt].join("\0")).slice(0, 24)}`,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    task_id: prompt.task_id,
    agent_id: prompt.agent_id,
    agent_role: prompt.agent_role,
    status,
    blocking: status === "blocked" || status === "failed",
    role_profile: profile.name,
    checks_passed_count: findings.filter((finding) => finding.severity === "passed").length,
    warnings_count: warningsCount,
    failures_count: failuresCount,
    blocked_count: blockedCount,
    findings,
    unsafe_pattern_hits: unsafePatternHits,
    consistency_checks: consistencyChecks,
    checked_metadata: {
      prompt_artifact_ref: context.promptArtifactRef ?? context.promptMetadata?.artifact_ref,
      context_pack_ref: context.contextPackRef,
      team_id: context.contextPack?.team_context?.scope.team_id ?? prompt.metadata_json.team_id ?? asRecord(prompt.metadata_json.team_context)?.team_id,
      team_memory_scope: context.contextPack?.team_context?.scope.memory_scope ?? prompt.metadata_json.team_memory_scope ?? asRecord(prompt.metadata_json.team_context)?.memory_scope,
      team_context_scope_ref: context.contextPack?.team_context?.scope.artifact_ref,
      team_context_warning_count: context.contextPack?.team_context?.warnings.length,
      expected_output_schema: context.expectedOutputSchema ?? context.task?.expected_output_schema,
      allowed_files: context.allowedFiles ?? context.task?.allowed_files_to_edit,
      forbidden_files: context.forbiddenFiles ?? context.task?.forbidden_files,
      validation_requirements: context.validationRequirements ?? context.task?.validation_commands
    },
    suggested_remediation: remediation(findings),
    metadata_json: {
      template_id: prompt.template_id,
      template_version: prompt.template_version,
      renderer_version: prompt.renderer_version,
      template_input_schema_version: prompt.template_input_schema_version,
      output_schema_name: prompt.output_schema_name,
      team_id: context.contextPack?.team_context?.scope.team_id ?? prompt.metadata_json.team_id ?? asRecord(prompt.metadata_json.team_context)?.team_id,
      team_memory_scope: context.contextPack?.team_context?.scope.memory_scope ?? prompt.metadata_json.team_memory_scope ?? asRecord(prompt.metadata_json.team_context)?.memory_scope,
      team_context_fallback_used: context.contextPack?.team_context?.fallback_used
    },
    created_at: createdAt
  };
}

function profileForRole(role: string): PromptQualityRoleProfile {
  if (role === "ScoutAgent") return ROLE_PROFILES.scout;
  if (role === "PlannerAgent") return ROLE_PROFILES.planner;
  if (role === "ExecutorAgent") return ROLE_PROFILES.executor;
  if (role === "ReviewerAgent") return ROLE_PROFILES.reviewer;
  if (role === "TesterAgent") return ROLE_PROFILES.tester;
  if (role === "ReporterAgent") return ROLE_PROFILES.reporter;
  if (role === "IntegratorAgent") return ROLE_PROFILES.integrator;
  if (/repair/i.test(role)) return ROLE_PROFILES.repair;
  return ROLE_PROFILES.generic;
}

function requireMetadata(findings: PromptQualityFinding[], value: unknown, checkId: string, message: string) {
  add(findings, checkId, typeof value === "string" && value.length ? "passed" : "failed", typeof value === "string" && value.length ? message : `${checkId} is missing.`);
}

function requireText(findings: PromptQualityFinding[], condition: boolean, checkId: string, message: string) {
  add(findings, checkId, condition ? "passed" : "failed", condition ? message : `${checkId} is missing from rendered prompt text.`);
}

function checkConsistency(
  left: string | undefined,
  right: string | undefined,
  checkId: string,
  strict: boolean,
  findings: PromptQualityFinding[],
  consistencyChecks: PromptQualityResult["consistency_checks"]
) {
  if (!right) return;
  const passed = left === right;
  const severity: PromptQualityFindingSeverity = passed ? "passed" : strict ? "blocked" : "failed";
  consistencyChecks[checkId] = severity;
  add(findings, checkId, severity, passed ? `${checkId} passed.` : `${checkId} mismatch: prompt=${left ?? "<missing>"} expected=${right}.`);
}

function compareScopeList(
  promptItems: string[],
  expectedItems: string[],
  checkId: string,
  strict: boolean,
  findings: PromptQualityFinding[],
  consistencyChecks: PromptQualityResult["consistency_checks"]
) {
  const normalizedPrompt = promptItems.filter((item) => item !== "none").sort();
  const normalizedExpected = expectedItems.filter(Boolean).sort();
  const passed = JSON.stringify(normalizedPrompt) === JSON.stringify(normalizedExpected);
  const severity: PromptQualityFindingSeverity = passed ? "passed" : strict ? "blocked" : "warning";
  consistencyChecks[checkId] = severity;
  add(findings, checkId, severity, passed ? `${checkId} passed.` : `${checkId} mismatch.`, {
    prompt_items: normalizedPrompt,
    expected_items: normalizedExpected
  });
}

function parseSection(text: string, title: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `${title}:`.toLowerCase());
  if (start < 0) return { present: false, items: [] as string[] };
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    if (!line.trim().startsWith("- ")) break;
    const item = line.trim().slice(2).trim();
    if (item === "none") continue;
    items.push(item);
  }
  return { present: true, items };
}

function add(findings: PromptQualityFinding[], checkId: string, severity: PromptQualityFindingSeverity, message: string, metadataJson?: Record<string, unknown>) {
  findings.push({ check_id: checkId, severity, message, metadata_json: metadataJson });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function remediation(findings: PromptQualityFinding[]) {
  return findings
    .filter((finding) => finding.severity === "blocked" || finding.severity === "failed")
    .map((finding) => `Fix ${finding.check_id}: ${finding.message}`);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
