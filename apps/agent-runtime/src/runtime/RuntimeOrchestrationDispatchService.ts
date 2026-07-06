import type { AgentRuntimeSession, ProjectMap } from "@hivo/protocol";
import type { SwarmMode } from "../orchestration/OrchestrationConfig.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import type { RuntimeModeResolution } from "./RuntimeOrchestrationPreludeService.js";

export type SimpleRuntimeDispatchOptions = {
  resolvedMode: RuntimeModeResolution["mode"];
  projectMap: ProjectMap;
  thinkFirst: boolean;
  conversationUnderstanding?: ConversationUnderstanding;
};

export type RuntimeOrchestrationDispatchInput = {
  sessionId: string;
  prompt: string;
  projectMap: ProjectMap;
  modeResolution: RuntimeModeResolution;
  swarmMode: SwarmMode;
  thinkFirst: boolean;
  conversationUnderstanding?: ConversationUnderstanding;
  branches: {
    recursiveSwarm: () => Promise<AgentRuntimeSession>;
    recursiveFactory: () => Promise<AgentRuntimeSession>;
    providerBackedSwarm: () => Promise<AgentRuntimeSession>;
    simple: (options: SimpleRuntimeDispatchOptions) => Promise<AgentRuntimeSession>;
  };
};

export type RuntimeOrchestrationDispatchResult = {
  session: AgentRuntimeSession;
  branch: "recursive_swarm" | "recursive_factory" | "provider_backed_swarm" | "simple";
};

export class RuntimeOrchestrationDispatchService {
  async dispatch(input: RuntimeOrchestrationDispatchInput): Promise<RuntimeOrchestrationDispatchResult> {
    if (input.conversationUnderstanding?.intentDecision.kind === "run_request") {
      return {
        branch: "simple",
        session: await input.branches.simple({
          resolvedMode: input.modeResolution.mode,
          projectMap: input.projectMap,
          thinkFirst: input.thinkFirst,
          conversationUnderstanding: input.conversationUnderstanding
        })
      };
    }
    if (input.modeResolution.mode === "recursive_factory") {
      return {
        branch: "recursive_factory",
        session: await input.branches.recursiveFactory()
      };
    }
    if (shouldUseProviderBackedSwarm(input)) {
      return {
        branch: "provider_backed_swarm",
        session: await input.branches.providerBackedSwarm()
      };
    }
    if (input.swarmMode === "recursive_tree") {
      return {
        branch: "recursive_swarm",
        session: await input.branches.recursiveSwarm()
      };
    }
    return {
      branch: "simple",
      session: await input.branches.simple({
        resolvedMode: input.modeResolution.mode,
        projectMap: input.projectMap,
        thinkFirst: input.thinkFirst,
        conversationUnderstanding: input.conversationUnderstanding
      })
    };
  }
}

function shouldUseProviderBackedSwarm(input: RuntimeOrchestrationDispatchInput) {
  if (input.modeResolution.mode !== "orchestrated_mode") return false;
  const route = input.conversationUnderstanding?.routeDecision.route;
  return route === "swarm_readonly" || route === "orchestrated_run" || input.swarmMode === "pipeline";
}
