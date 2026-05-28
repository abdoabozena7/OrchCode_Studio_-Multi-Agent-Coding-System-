import path from "node:path";
import { classifyCommandRisk, looksLikeNetworkCommand } from "../tools/CommandPolicy.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";

export type SandboxValidationCommandPlanEntry = {
  command_id: string;
  command: string;
  cwd: string;
  required: boolean;
  safety_status: "allowed" | "blocked";
  blocked_reason?: string;
};

export function buildSandboxCommandPlan(input: {
  workspacePath: string;
  sandboxPath: string;
  requiredCommands: string[];
  optionalCommands: string[];
  allowlist: string[];
  config: Pick<OrchestrationSafetyConfig, "allow_network_in_sandbox_validation" | "allow_dependency_install_in_sandbox_validation">;
}): SandboxValidationCommandPlanEntry[] {
  return [
    ...input.requiredCommands.map((command) => planEntry(input, command, true)),
    ...input.optionalCommands.map((command) => planEntry(input, command, false))
  ];
}

export function resolveSandboxCommandCwd(sandboxPath: string, cwd = ".") {
  const sandbox = path.resolve(sandboxPath);
  const resolved = path.resolve(sandbox, cwd);
  const relative = path.relative(sandbox, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Sandbox validation cwd outside sandbox: ${cwd}`);
  return resolved;
}

function planEntry(input: Parameters<typeof buildSandboxCommandPlan>[0], command: string, required: boolean): SandboxValidationCommandPlanEntry {
  const normalized = command.trim();
  const risk = classifyCommandRisk(normalized, input.sandboxPath);
  const allowlisted = commandAllowed(normalized, input.allowlist);
  const network = looksLikeNetworkCommand(normalized.toLowerCase());
  const dependencyInstall = looksLikeDependencyInstall(normalized);
  const blocked = !normalized
    ? "Command is empty."
    : risk !== "safe"
      ? `Command is not safe for sandbox validation (risk=${risk}).`
      : !allowlisted
        ? "Command is not present in safe_commands_allowlist."
        : network && !input.config.allow_network_in_sandbox_validation
          ? "Network command is not allowed in sandbox validation."
          : dependencyInstall && !input.config.allow_dependency_install_in_sandbox_validation
            ? "Dependency installation is not allowed in sandbox validation."
            : undefined;
  return {
    command_id: safeId(`${required ? "required" : "optional"}_${normalized}`),
    command: normalized,
    cwd: ".",
    required,
    safety_status: blocked ? "blocked" : "allowed",
    blocked_reason: blocked
  };
}

function commandAllowed(command: string, allowlist: string[]) {
  const normalized = command.trim().toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return normalized === allowed || normalized.startsWith(`${allowed} `);
  });
}

function looksLikeDependencyInstall(command: string) {
  return /^(npm\s+i|npm\s+install|pnpm\s+install|pnpm\s+add|yarn\s+install|yarn\s+add|pip\s+install|cargo\s+install)\b/i.test(command.trim());
}

function safeId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "command";
}
