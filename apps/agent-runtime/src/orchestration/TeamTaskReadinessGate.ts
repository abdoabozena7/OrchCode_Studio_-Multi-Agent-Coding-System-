import {
  createTaskAdoptionFinding,
  createTaskReadinessProfile,
  type AdoptedTaskProposal,
  type TaskAdoptionFinding,
  type TaskPromotionPolicy,
  type TaskReadinessProfile,
  type TaskReadinessRequirement,
  type TaskReadinessStatus
} from "./TeamTaskAdoptionModels.js";

export class TeamTaskReadinessGate {
  checkReadiness(proposal: AdoptedTaskProposal, policy: TaskPromotionPolicy, upstreamFindings: TaskAdoptionFinding[] = []): TaskReadinessProfile {
    const requirements = buildRequirements(proposal, policy);
    const findings = [...upstreamFindings, ...findingsFromRequirements(requirements, proposal, policy)];
    const hasBlocking = findings.some((finding) => finding.severity === "blocking")
      || requirements.some((requirement) => requirement.status === "blocked" || requirement.status === "missing");
    const readinessStatus = readinessStatusForProposal(proposal, policy, hasBlocking);
    return createTaskReadinessProfile({
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      sub_plan_id: proposal.sub_plan_id,
      task_draft_id: proposal.source_task_draft_id,
      adopted_task_id: proposal.adopted_task_id,
      readiness_status: readinessStatus,
      requirements,
      findings,
      executable_allowed: readinessStatus === "executable_ready",
      metadata_json: {
        mode: policy.mode,
        read_or_write_classification: proposal.read_or_write_classification,
        adoption_status: proposal.adoption_status,
        allow_executable_adoption: policy.allow_executable_adoption
      }
    });
  }
}

function buildRequirements(proposal: AdoptedTaskProposal, policy: TaskPromotionPolicy): TaskReadinessRequirement[] {
  const isWrite = proposal.read_or_write_classification === "write_candidate" || proposal.read_or_write_classification === "repair_candidate";
  const locks = [...proposal.module_locks, ...proposal.semantic_locks];
  return [
    requirement("objective", proposal.objective.trim().length > 0, "Task objective is present.", [proposal.source_task_draft_id]),
    requirement("team_scope", Boolean(proposal.team_id), "Task proposal is associated with a team.", [proposal.team_id]),
    requirement("allowed_files", !isWrite || proposal.allowed_files.length > 0, "Write candidates must have explicit allowed files.", proposal.allowed_files),
    requirement("forbidden_files", proposal.forbidden_files.length > 0, "Forbidden file guardrails are inherited.", proposal.forbidden_files),
    requirement("validation", !isWrite || proposal.validation_strategy.commands.length > 0 || proposal.validation_strategy.required_checks.length > 0, "Write candidates must carry validation strategy.", proposal.validation_strategy.commands),
    requirement("success_criteria", proposal.success_criteria.length > 0, "Success criteria are present.", proposal.success_criteria),
    requirement("stop_conditions", !isWrite || proposal.stop_conditions.length > 0, "Write or repair candidates require stop conditions.", proposal.stop_conditions),
    requirement("locks", !isWrite || locks.length > 0, "Required lock refs are derivable.", locks),
    requirement("prompt_profile", Boolean(proposal.prompt_template_ref), "Prompt template/profile ref is known.", [proposal.prompt_template_ref ?? ""], true),
    requirement("context", Boolean(proposal.context_pack_ref) || proposal.read_or_write_classification === "read_only", "Context pack is available or buildable.", [proposal.context_pack_ref ?? ""], proposal.read_or_write_classification === "read_only"),
    requirement("risk", Boolean(proposal.risk_level), "Risk level is classified.", [proposal.risk_level]),
    requirement("execution_policy", policy.allow_executable_adoption, "Executable adoption is disabled by default.", [], true)
  ];
}

function requirement(type: TaskReadinessRequirement["requirement_type"], satisfied: boolean, summary: string, refs: string[], optional = false): TaskReadinessRequirement {
  return {
    requirement_id: `readiness_requirement_${type}`,
    requirement_type: type,
    status: satisfied ? "satisfied" : optional ? "not_required" : "missing",
    summary,
    refs: refs.filter(Boolean),
    metadata_json: { optional }
  };
}

function findingsFromRequirements(requirements: TaskReadinessRequirement[], proposal: AdoptedTaskProposal, policy: TaskPromotionPolicy): TaskAdoptionFinding[] {
  const findings: TaskAdoptionFinding[] = [];
  for (const requirement of requirements) {
    if (requirement.status !== "missing" && requirement.status !== "blocked") continue;
    findings.push(createTaskAdoptionFinding({
      code: codeForRequirement(requirement.requirement_type),
      severity: "blocking",
      message: requirement.summary,
      refs: requirement.refs
    }));
  }
  if (!policy.allow_executable_adoption) {
    findings.push(createTaskAdoptionFinding({
      code: "executable_disabled",
      severity: proposal.read_or_write_classification === "read_only" ? "info" : "warning",
      message: "Executable task adoption is disabled by configuration.",
      refs: [proposal.adopted_task_id]
    }));
  }
  if (policy.mode === "metadata_only") {
    findings.push(createTaskAdoptionFinding({
      code: "metadata_only_default",
      severity: "info",
      message: "Task proposal remains metadata-only by default.",
      refs: [proposal.adopted_task_id]
    }));
  }
  return findings;
}

function codeForRequirement(type: TaskReadinessRequirement["requirement_type"]): TaskAdoptionFinding["code"] {
  if (type === "objective") return "objective_missing";
  if (type === "team_scope") return "team_missing";
  if (type === "allowed_files") return "allowed_files_missing";
  if (type === "forbidden_files") return "forbidden_file_conflict";
  if (type === "validation") return "validation_missing";
  if (type === "success_criteria") return "success_criteria_missing";
  if (type === "stop_conditions") return "stop_conditions_missing";
  if (type === "locks") return "locks_missing";
  if (type === "prompt_profile") return "prompt_profile_missing";
  if (type === "context") return "context_missing";
  if (type === "risk") return "risk_classified";
  return "executable_disabled";
}

function readinessStatusForProposal(proposal: AdoptedTaskProposal, policy: TaskPromotionPolicy, blocked: boolean): TaskReadinessStatus {
  if (blocked) return "blocked";
  if (proposal.read_or_write_classification === "read_only") return "read_only_ready";
  if (policy.allow_executable_adoption && policy.mode === "gated_future_ready") return "executable_ready";
  if (policy.allow_write_task_future_candidates && policy.mode === "gated_future_ready") return "future_write_candidate";
  return "metadata_only";
}
