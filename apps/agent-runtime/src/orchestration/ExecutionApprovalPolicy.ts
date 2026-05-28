import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { ProposedTaskGraphNode } from "./ProposedTaskGraphModels.js";
import {
  createHumanApprovalRequirement,
  type ExecutionApprovalPolicy,
  type HumanApprovalRequirement
} from "./ExecutionReadinessModels.js";

export function executionApprovalPolicyFromConfig(config: OrchestrationSafetyConfig): ExecutionApprovalPolicy {
  return {
    mode: config.execution_readiness_mode,
    allow_read_only_promotion_candidates: config.allow_read_only_promotion_candidates,
    allow_write_future_candidates: config.allow_write_future_candidates,
    require_human_approval_for_write: config.require_human_approval_for_write,
    allow_auto_approval_for_low_risk_read_only: config.allow_auto_approval_for_low_risk_read_only,
    max_nodes_evaluated_per_run: config.max_nodes_evaluated_per_run,
    metadata_json: { source: "orchestration_config" }
  };
}

export function humanApprovalRequirementForNode(node: ProposedTaskGraphNode, policy: ExecutionApprovalPolicy): HumanApprovalRequirement | undefined {
  const triggers = humanApprovalTriggers(node, policy);
  if (!triggers.length) return undefined;
  return createHumanApprovalRequirement({
    run_id: node.run_id,
    proposed_node_id: node.proposed_node_id,
    team_id: node.team_id,
    required: true,
    reason: `Human approval required: ${triggers.join(", ")}.`,
    triggers,
    risk_level: node.risk_level,
    metadata_json: {
      read_or_write_classification: node.read_or_write_classification,
      proposed_role: node.proposed_role,
      task_type: node.task_type
    }
  });
}

export function humanApprovalTriggers(node: ProposedTaskGraphNode, policy: ExecutionApprovalPolicy) {
  const refs = [...node.allowed_files, ...node.read_only_files].map(normalizePath);
  const text = `${node.title} ${node.objective} ${node.task_type}`.toLowerCase();
  const triggers: string[] = [];
  if (policy.require_human_approval_for_write && node.read_or_write_classification !== "read_only") triggers.push("write_classified_node");
  if (refs.some((file) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|cargo\.lock)$/i.test(file))) triggers.push("dependency_or_manifest_change");
  if (refs.some((file) => /(^|\/)(\.env|\.github\/|tsconfig|vite\.config|webpack|rollup|eslint|prettier|config)/i.test(file))) triggers.push("config_or_security_sensitive_file");
  if (refs.some((file) => /(migration|schema|prisma|database|db\/|sql)/i.test(file)) || /database|schema|migration/.test(text)) triggers.push("database_schema_change");
  if (/public api|breaking api|route|endpoint|protocol/.test(text) || refs.some((file) => /(api|protocol|routes?)/i.test(file))) triggers.push("public_api_change");
  if (/delete|remove|destructive|drop|overwrite/.test(text)) triggers.push("destructive_operation");
  if (uniqueTopLevelDirs(refs).length > 1 || refs.length > 4) triggers.push("broad_or_multi_module_change");
  if (node.risk_level === "high" || node.risk_level === "critical") triggers.push("high_or_critical_risk");
  if (node.read_or_write_classification !== "read_only" && !node.validation_strategy?.commands.length && !node.validation_strategy?.required_checks.length) triggers.push("missing_validation_coverage");
  if (node.status === "blocked" || node.status.startsWith("needs_")) triggers.push("unsafe_scope_or_readiness_warning");
  if (node.context_pack_ref && /stale|unknown|fallback/i.test(node.context_pack_ref)) triggers.push("stale_or_unknown_context");
  return uniqueStrings(triggers);
}

function uniqueTopLevelDirs(files: string[]) {
  return uniqueStrings(files.map((file) => file.split("/")[0]).filter(Boolean));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
