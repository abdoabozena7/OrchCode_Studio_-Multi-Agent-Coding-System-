import type { DelegationComplexity, DelegationDecision, RuntimeExecutionMode } from "@orchcode/protocol";
import type { ProjectMap } from "@orchcode/protocol";

export type PromptDirective = {
  requestedAgentCount?: number;
  explicitMode?: Exclude<RuntimeExecutionMode, "auto_mode">;
  thinkFirstRequested: boolean;
  explicitDirectiveText?: string;
};

export function parsePromptDirective(prompt: string): PromptDirective {
  const normalized = prompt.toLowerCase();
  const requestedAgentCount = normalized.match(/\buse\s+(\d+)\s+agents?\b/)?.[1];
  if (requestedAgentCount) {
    return {
      requestedAgentCount: Number(requestedAgentCount),
      explicitMode: "orchestrated_mode",
      thinkFirstRequested: hasThinkFirstLanguage(normalized),
      explicitDirectiveText: `User requested ${requestedAgentCount} agents`
    };
  }
  if (/\b(do this yourself|one agent|single agent)\b/.test(normalized)) {
    return {
      explicitMode: "simple_mode",
      thinkFirstRequested: hasThinkFirstLanguage(normalized),
      explicitDirectiveText: "User requested a single agent"
    };
  }
  if (/\b(subagents?|multi[- ]agent|orchestrate|working team)\b/.test(normalized)) {
    return {
      explicitMode: "orchestrated_mode",
      thinkFirstRequested: hasThinkFirstLanguage(normalized),
      explicitDirectiveText: "User requested orchestrated delegation"
    };
  }
  return {
    thinkFirstRequested: hasThinkFirstLanguage(normalized)
  };
}

export function estimateComplexity(prompt: string, projectMap: ProjectMap): DelegationComplexity {
  const normalized = prompt.toLowerCase();
  let score = 0;
  const highComplexityTerms = [
    "react",
    "node",
    "fastapi",
    "backend",
    "frontend",
    "full stack",
    "threejs",
    "3d",
    "game",
    "database",
    "authentication",
    "tauri",
    "rust",
    "api"
  ];
  const mediumTerms = ["html", "css", "javascript", "typescript", "tests", "refactor", "settings", "page"];

  score += highComplexityTerms.filter((term) => normalized.includes(term)).length * 2;
  score += mediumTerms.filter((term) => normalized.includes(term)).length;
  score += projectMap.stack.length >= 3 ? 2 : 0;
  score += projectMap.entryPoints.length > 4 ? 1 : 0;
  score += /\band\b/.test(normalized) ? 1 : 0;
  score += /[,/]/.test(normalized) ? 1 : 0;

  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

export function resolveExecutionMode(
  prompt: string,
  projectMap: ProjectMap
): {
  mode: Exclude<RuntimeExecutionMode, "auto_mode">;
  directive: PromptDirective;
  complexity: DelegationComplexity;
} {
  const directive = parsePromptDirective(prompt);
  const complexity = estimateComplexity(prompt, projectMap);
  if (directive.explicitMode) {
    return { mode: directive.explicitMode, directive, complexity };
  }
  return {
    mode: complexity === "low" ? "simple_mode" : "orchestrated_mode",
    directive,
    complexity
  };
}

export function createSimpleDelegationDecision(input: {
  prompt: string;
  projectMap: ProjectMap;
}): DelegationDecision {
  const { mode, directive, complexity } = resolveExecutionMode(input.prompt, input.projectMap);
  if (mode === "simple_mode") {
    return {
      resolvedMode: "simple_mode",
      explicitUserDirective: directive.explicitDirectiveText,
      requestedAgentCount: directive.requestedAgentCount,
      selectedAgentCount: 1,
      selectedAgentRoles: ["Senior Coding Agent"],
      agentRoleReasons: [{ agentName: "Senior Coding Agent", reason: "The task is small enough to stay in one focused thread." }],
      estimatedComplexity: complexity,
      rationale:
        complexity === "low"
          ? "I kept this in one agent because the task looks narrow and local."
          : "The user explicitly asked to avoid delegation."
    };
  }
  return {
    resolvedMode: "orchestrated_mode",
    explicitUserDirective: directive.explicitDirectiveText,
    requestedAgentCount: directive.requestedAgentCount,
    selectedAgentCount: 0,
    selectedAgentRoles: [],
    agentRoleReasons: [],
    estimatedComplexity: complexity,
    rationale: "The task spans multiple concerns, so an orchestrated run is the safer default."
  };
}

function hasThinkFirstLanguage(normalizedPrompt: string) {
  return /\b(plan first|think first|make a plan|show plan)\b/.test(normalizedPrompt);
}
