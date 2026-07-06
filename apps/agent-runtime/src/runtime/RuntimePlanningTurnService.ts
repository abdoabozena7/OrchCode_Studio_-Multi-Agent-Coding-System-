import type { AgentRuntimeSession, RuntimeTurnResponse } from "@hivo/protocol";
import type { SwarmMode } from "../orchestration/OrchestrationConfig.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import type { RuntimeProviderContext } from "./RuntimeProviderContextService.js";
import type { RuntimeIntentContractService } from "./RuntimeIntentContractService.js";
import { RuntimeOrchestrationDispatchService } from "./RuntimeOrchestrationDispatchService.js";
import { RuntimeOrchestrationPreludeService } from "./RuntimeOrchestrationPreludeService.js";
import type { RuntimeProviderBackedSwarmService } from "./RuntimeProviderBackedSwarmService.js";
import type { RuntimeRecursiveFactoryPlanningService } from "./RuntimeRecursiveFactoryPlanningService.js";
import type { RuntimeRecursiveSwarmService } from "./RuntimeRecursiveSwarmService.js";
import type { RuntimeRunEngineService } from "./RuntimeRunEngineService.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimePlanningTurnServices = {
  intentContract: RuntimeIntentContractService;
  recursiveSwarm: RuntimeRecursiveSwarmService;
  recursiveFactoryPlanning: RuntimeRecursiveFactoryPlanningService;
  providerBackedSwarm: RuntimeProviderBackedSwarmService;
  runEngine: RuntimeRunEngineService;
};

export type RuntimePlanningTurnInput = {
  sessionId: string;
  session: AgentRuntimeSession;
  prompt: string;
  conversationUnderstanding: ConversationUnderstanding;
  decisionPipelineId: string;
  providerContext: RuntimeProviderContext;
  swarmMode?: SwarmMode;
};

export class RuntimePlanningTurnService {
  private readonly preludeService = new RuntimeOrchestrationPreludeService();
  private readonly dispatchService = new RuntimeOrchestrationDispatchService();

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly services: RuntimePlanningTurnServices
  ) {}

  async run(input: RuntimePlanningTurnInput): Promise<RuntimeTurnResponse> {
    const { sessionId, session, prompt, conversationUnderstanding, providerContext } = input;
    const { provider, telemetry: providerTelemetry } = providerContext;
    const intentCompilation = await this.services.intentContract.compile({
      sessionId,
      originalRequest: prompt,
      provider,
      parentContext: {
        route: conversationUnderstanding.routeDecision.route,
        intent_kind: conversationUnderstanding.intentDecision.kind,
        decision_pipeline_id: input.decisionPipelineId
      }
    });
    if (!intentCompilation.ready) {
      return this.services.intentContract.blockPlanning({
        sessionId,
        originalRequest: prompt,
        compilation: intentCompilation,
        providerTelemetry
      });
    }

    const planningPrompt = intentCompilation.contract.precise_rewrite;
    const prelude = this.preludeService.build({
      session,
      prompt: planningPrompt,
      conversationUnderstanding,
      swarmMode: input.swarmMode
    });
    const { projectMap, modeResolution, thinkFirst, swarmMode } = prelude;
    const dispatched = await this.dispatchService.dispatch({
      sessionId,
      prompt: planningPrompt,
      projectMap,
      modeResolution,
      swarmMode,
      thinkFirst,
      conversationUnderstanding,
      branches: {
        recursiveSwarm: () => this.services.recursiveSwarm.run({
          sessionId,
          message: planningPrompt,
          provider,
          providerTelemetry,
          projectMap
        }),
        recursiveFactory: () => this.services.recursiveFactoryPlanning.startRecursiveFactory(sessionId, planningPrompt, projectMap),
        providerBackedSwarm: () => this.services.providerBackedSwarm.run({
          sessionId,
          message: planningPrompt,
          provider,
          providerTelemetry,
          projectMap,
          conversationUnderstanding
        }),
        simple: (options) => this.services.runEngine.run({
          sessionId,
          prompt: planningPrompt,
          provider,
          providerTelemetry,
          ...options
        })
      }
    });
    const updated = dispatched.session;
    await this.sessionManager.updateSession(sessionId, (draft) => {
      draft.resolvedExecutionMode = modeResolution.mode;
    });
    return { sessionId, status: updated.status };
  }
}
