import type { CommandInventory, RepoIndex } from "../memory/types.js";
import type { SpecialistAgentDescriptor, TaskComplexity } from "./SwarmModels.js";

export type SpecialistAgentFactoryInput = {
  userGoal: string;
  taskComplexity?: TaskComplexity;
  candidateFiles?: string[];
  repoIndex?: RepoIndex;
  commandInventory?: CommandInventory;
  previousFailures?: string[];
};

export class SpecialistAgentFactory {
  create(input: SpecialistAgentFactoryInput): SpecialistAgentDescriptor[] {
    const goal = input.userGoal.toLowerCase();
    const files = uniqueStrings([
      ...(input.candidateFiles ?? []),
      ...(input.repoIndex?.importantFiles ?? []).filter((file) => goal.includes(basenameWithoutExtension(file).toLowerCase()))
    ]);
    const haystack = `${goal}\n${files.join("\n")}\n${input.previousFailures?.join("\n") ?? ""}`.toLowerCase();
    const specialists: SpecialistAgentDescriptor[] = [];

    if (matches(haystack, [
      "auth",
      "authentication",
      "authorization",
      "security",
      "password",
      "token",
      "oauth",
      "jwt",
      "session",
      "permission",
      "secret"
    ])) {
      specialists.push(specialist(
        "auth_security_reviewer",
        "AuthSecurityReviewerAgent",
        "Review authentication, authorization, secret handling, and security-sensitive changes.",
        "security/authentication indicators were present",
        "SecurityReviewOutput"
      ));
    }

    if (matches(haystack, ["migration", "database", "postgres", "sqlite", "schema", "sql", "prisma", "drizzle", "typeorm"])) {
      specialists.push(specialist(
        "migration_safety_reviewer",
        "MigrationSafetyReviewerAgent",
        "Review database migration ordering, rollback safety, data-loss risk, and schema compatibility.",
        "database or migration indicators were present",
        "MigrationReviewOutput"
      ));
    }

    const uiGoalSignal = matches(goal, ["frontend", "react", "component", "ui", "accessibility", "a11y", "aria", "screen reader", "keyboard navigation"]);
    const uiFileSignal = files.some((file) => /\.(tsx|jsx|html|css)$/i.test(file)) && matches(goal, ["frontend", "react", "component", "ui", "accessibility", "a11y"]);
    const uiSignal = input.taskComplexity !== "tiny" && (uiGoalSignal || uiFileSignal);
    if (uiSignal && !isSimpleHtmlCopyChange(goal)) {
      specialists.push(specialist(
        "accessibility_reviewer",
        "AccessibilityReviewerAgent",
        "Review UI changes for semantics, keyboard access, labels, focus, and regression risk.",
        "frontend/accessibility indicators were present",
        "AccessibilityReviewOutput"
      ));
    }

    if (matches(haystack, ["performance", "perf", "latency", "throughput", "cache", "hot path", "bundle", "render loop", "slow"])) {
      specialists.push(specialist(
        "performance_reviewer",
        "PerformanceReviewerAgent",
        "Review performance-sensitive changes and call out hot-path or bundle risks.",
        "performance indicators were present",
        "PerformanceReviewOutput"
      ));
    }

    if (hasApiCompatibilitySignal(goal, files)) {
      specialists.push(specialist(
        "api_compatibility_reviewer",
        "APICompatibilityReviewerAgent",
        "Review public API and protocol compatibility risks.",
        "public API compatibility indicators were present",
        "APICompatibilityReviewOutput"
      ));
    }

    if (hasDependencyUpgradeSignal(goal, files)) {
      specialists.push(specialist(
        "dependency_upgrade_reviewer",
        "DependencyUpgradeReviewerAgent",
        "Review dependency upgrade, lockfile, and package manager risk.",
        "dependency or lockfile indicators were present",
        "DependencyUpgradeReviewOutput"
      ));
    }

    if (matches(haystack, ["coverage", "missing test", "test gap", "uncovered", "tests"])) {
      specialists.push(specialist(
        "test_coverage_reviewer",
        "TestCoverageReviewerAgent",
        "Review whether changed behavior has adequate focused test coverage.",
        "test coverage indicators were present",
        "TestCoverageReviewOutput"
      ));
    }

    if (matches(haystack, ["docs", "documentation", "readme", ".md"])) {
      specialists.push(specialist(
        "documentation_reviewer",
        "DocumentationReviewerAgent",
        "Review documentation updates for operator workflow and architecture accuracy.",
        "documentation indicators were present",
        "DocumentationReviewOutput"
      ));
    }

    return dedupeByRole(specialists);
  }
}

function specialist(id: string, role: string, purpose: string, trigger: string, outputSchema: string): SpecialistAgentDescriptor {
  return {
    id,
    role,
    purpose,
    trigger,
    read_only: true,
    output_schema: outputSchema
  };
}

function matches(value: string, terms: string[]) {
  return terms.some((term) => value.includes(term));
}

function isSimpleHtmlCopyChange(goal: string) {
  return /\b(change|update|replace)\b/.test(goal)
    && /\b(copy|text|label|wording|headline)\b/.test(goal)
    && !/\b(accessibility|a11y|aria|keyboard|form|focus|semantic|layout|migration|security)\b/.test(goal);
}

function hasDependencyUpgradeSignal(goal: string, files: string[]) {
  if (matches(goal, ["dependency", "upgrade", "package.json", "package-lock.json", "cargo.toml", "cargo.lock"])) return true;
  if (isSimpleHtmlCopyChange(goal)) return false;
  return matches(goal, ["package", "lockfile", "dependency config"])
    && files.some((file) => /(^|\/)(package\.json|package-lock\.json|cargo\.toml|cargo\.lock)$/i.test(file.replace(/\\/g, "/")));
}

function hasApiCompatibilitySignal(goal: string, files: string[]) {
  if (matches(goal, ["public api", "api compatibility", "sdk", "contract", "breaking change", "client"])) return true;
  if (isSimpleHtmlCopyChange(goal)) return false;
  return matches(goal, ["api", "protocol", "compatibility"])
    && files.some((file) => /(^|\/)(packages\/protocol|.*protocol.*|.*api.*|.*client.*)/i.test(file.replace(/\\/g, "/")));
}

function basenameWithoutExtension(file: string) {
  const normalized = file.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(0, dot);
}

function dedupeByRole(specialists: SpecialistAgentDescriptor[]) {
  const seen = new Set<string>();
  return specialists.filter((entry) => {
    if (seen.has(entry.role)) return false;
    seen.add(entry.role);
    return true;
  });
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
