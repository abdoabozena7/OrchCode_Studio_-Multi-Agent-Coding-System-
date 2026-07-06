import type { AgentRuntimeSession, ProjectMap, RuntimeExecutionMode } from "@hivo/protocol";
import type { SwarmMode } from "../orchestration/OrchestrationConfig.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { executionModeForConversationRoute } from "./ConversationRouter.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { createSimpleDelegationDecision, parsePromptDirective, resolveExecutionMode, type PromptDirective } from "./delegation.js";
import { buildProjectIntake } from "./ProjectIntake.js";

export type RuntimeModeResolution = {
  mode: Exclude<RuntimeExecutionMode, "auto_mode">;
  directive: PromptDirective;
  complexity: ReturnType<typeof createSimpleDelegationDecision>["estimatedComplexity"];
};

export type RuntimeOrchestrationPreludeInput = {
  session: AgentRuntimeSession;
  prompt: string;
  conversationUnderstanding?: ConversationUnderstanding;
  swarmMode?: SwarmMode;
};

export type RuntimeOrchestrationPrelude = {
  tools: ToolRegistry;
  projectMap: ProjectMap;
  intake: ReturnType<typeof buildProjectIntake>;
  modeResolution: RuntimeModeResolution;
  requestedAgentCount: number;
  thinkFirst: boolean;
  swarmMode: SwarmMode;
};

export class RuntimeOrchestrationPreludeService {
  build(input: RuntimeOrchestrationPreludeInput): RuntimeOrchestrationPrelude {
    const tools = new ToolRegistry(input.session.workspacePath);
    const projectMap = inferRuntimeProjectMap(tools);
    const intake = buildProjectIntake({
      workspacePath: input.session.workspacePath,
      message: input.prompt,
      projectMap,
      tools,
      conversationUnderstanding: input.conversationUnderstanding
    });
    const modeResolution = resolveRuntimeMode({
      sessionMode: input.session.executionMode,
      prompt: input.prompt,
      projectMap,
      conversationUnderstanding: input.conversationUnderstanding
    });
    return {
      tools,
      projectMap,
      intake,
      modeResolution,
      requestedAgentCount: modeResolution.directive.requestedAgentCount ?? 0,
      thinkFirst: input.session.thinkFirst || modeResolution.directive.thinkFirstRequested,
      swarmMode: input.swarmMode ?? "recursive_tree"
    };
  }
}

export function inferRuntimeProjectMap(tools: ToolRegistry): ProjectMap {
  const projectSummary = tools.workspace.getProjectSummary();
  return {
    stack: Object.keys(projectSummary.languages),
    packageManagers: projectSummary.packageManagers,
    testCommands: projectSummary.testCommands,
    entryPoints: projectSummary.importantFiles.filter((file) => /main|index|app|server|lib\.rs/.test(file)).slice(0, 8),
    importantFiles: projectSummary.importantFiles
  };
}

export function resolveRuntimeMode(input: {
  sessionMode: RuntimeExecutionMode;
  prompt: string;
  projectMap: ProjectMap;
  conversationUnderstanding?: ConversationUnderstanding;
}): RuntimeModeResolution {
  const directive = parsePromptDirective(input.prompt);
  const routedExecutionMode = input.conversationUnderstanding
    ? executionModeForConversationRoute(input.conversationUnderstanding.routeDecision.route)
    : undefined;
  const complexity = createSimpleDelegationDecision({ prompt: input.prompt, projectMap: input.projectMap }).estimatedComplexity;
  if (input.sessionMode !== "auto_mode") {
    return {
      mode: input.sessionMode,
      directive,
      complexity
    };
  }
  if (directive.explicitMode || routedExecutionMode) {
    return {
      mode: directive.explicitMode ?? (
        routedExecutionMode === "simple_mode" && complexity === "high"
          ? "orchestrated_mode"
          : routedExecutionMode!
      ),
      directive,
      complexity
    };
  }
  return resolveExecutionMode(input.prompt, input.projectMap);
}
