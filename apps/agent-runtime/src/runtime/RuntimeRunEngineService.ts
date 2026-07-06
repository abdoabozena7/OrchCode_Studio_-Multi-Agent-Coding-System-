import type {
  AgentRuntimeSession,
  ProjectMap,
  RuntimeExecutionMode
} from "@hivo/protocol";
import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ProviderTelemetryRecorder } from "../llm/ProviderTelemetry.js";
import type { ConversationUnderstanding } from "./ConversationUnderstanding.js";
import { RunEngine } from "./RunEngine.js";
import { SessionManager } from "./SessionManager.js";

export type RuntimeRunEngineInput = {
  sessionId: string;
  prompt: string;
  provider: LlmProvider;
  providerTelemetry?: ProviderTelemetryRecorder;
  resolvedMode: Exclude<RuntimeExecutionMode, "auto_mode">;
  projectMap: ProjectMap;
  thinkFirst?: boolean;
  conversationUnderstanding?: ConversationUnderstanding;
};

export class RuntimeRunEngineService {
  constructor(private readonly sessionManager: SessionManager) {}

  async run(input: RuntimeRunEngineInput): Promise<AgentRuntimeSession> {
    return new RunEngine(input.provider, this.sessionManager, {
      providerTelemetry: input.providerTelemetry
    }).runTurn(input.sessionId, input.prompt, {
      resolvedMode: input.resolvedMode,
      projectMap: input.projectMap,
      thinkFirst: input.thinkFirst,
      conversationUnderstanding: input.conversationUnderstanding
    });
  }
}
