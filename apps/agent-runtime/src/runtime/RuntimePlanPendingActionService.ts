import type { AgentRuntimeSession } from "@hivo/protocol";
import { SessionManager } from "./SessionManager.js";

export type RuntimePlanPendingActionResult = {
  handled: boolean;
  resumePrompt?: string;
  matched: boolean;
};

export type RuntimePlanClarificationRecorder = (
  session: AgentRuntimeSession,
  term: string,
  definition: string,
  source: "plan_clarification"
) => Promise<void>;

export class RuntimePlanPendingActionService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly recordClarification: RuntimePlanClarificationRecorder = async () => undefined
  ) {}

  async handle(session: AgentRuntimeSession, message: string): Promise<RuntimePlanPendingActionResult> {
    if (!session.nextAction) return { handled: false, matched: false };
    const normalized = message.trim().toLowerCase();
    if (session.nextAction.kind === "clarify_plan") {
      const selected =
        session.nextAction.options.find((option) => option.id === normalized || option.label.toLowerCase() === normalized)
        ?? session.nextAction.options.find((option) => option.prompt.toLowerCase() === normalized);
      const clarification = (selected?.prompt ?? message).trim();
      await this.recordClarification(session, "plan_mode_clarification", clarification, "plan_clarification");
      await this.sessionManager.updateSession(session.id, (draft) => {
        draft.nextAction = undefined;
        draft.thinkFirst = true;
        draft.userPrompt = `${draft.userPrompt}\n\nPlan mode clarification: ${clarification}`;
      });
      return {
        handled: false,
        matched: true,
        resumePrompt: `${session.userPrompt}\n\nPlan mode clarification: ${clarification}`
      };
    }
    if (session.nextAction.kind === "confirm_plan") {
      if (/\b(proceed|continue|implement|go ahead|start)\b/.test(normalized)) {
        await this.sessionManager.updateSession(session.id, (draft) => {
          draft.nextAction = undefined;
          draft.thinkFirst = false;
        });
        return {
          handled: false,
          matched: true,
          resumePrompt: session.userPrompt
        };
      }
      await this.sessionManager.addMessage(session.id, {
        role: "system",
        content: "Okay. Review the plan and tell me when to proceed with implementation."
      });
      return { handled: true, matched: true };
    }
    return { handled: false, matched: false };
  }
}
