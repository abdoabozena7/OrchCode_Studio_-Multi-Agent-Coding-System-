import type { RuntimeExecutionMode } from "@hivo/protocol";

export type ConversationRoute =
  | "chat"
  | "inspect_explain"
  | "simple_run"
  | "orchestrated_run"
  | "swarm_readonly";

export type ConversationRouteConfidence = "high" | "medium" | "low";

export type ConversationRouteDecision = {
  route: ConversationRoute;
  confidence: ConversationRouteConfidence;
  language: "arabic" | "english";
  normalizedPrompt: string;
  workspacePrompt: string;
  rationale: string;
};

type RouteSignals = {
  tokenCount: number;
  hasQuestion: boolean;
  hasGeneralChat: boolean;
  hasProjectQuestion: boolean;
  hasProjectObject: boolean;
  hasCodeAction: boolean;
  hasRunRequest: boolean;
  hasExplicitSwarmReadOnly: boolean;
  hasRiskyMultiFileScope: boolean;
  hasSmallChangeCue: boolean;
};

export function routeConversation(message: string): ConversationRouteDecision {
  const language = hasArabic(message) ? "arabic" : "english";
  const normalizedPrompt = normalizeConversationPrompt(message);
  const workspacePrompt = stripConversationPreamble(normalizedPrompt);
  const signals = collectRouteSignals(workspacePrompt || normalizedPrompt);

  if (!normalizedPrompt) {
    return decision("chat", "high", language, normalizedPrompt, workspacePrompt, "Empty or whitespace-only message.");
  }

  if (signals.hasExplicitSwarmReadOnly) {
    return decision("swarm_readonly", "high", language, normalizedPrompt, workspacePrompt, "Explicit read-only swarm, audit, or whole-repo request.");
  }

  if (signals.hasCodeAction) {
    if (signals.hasRiskyMultiFileScope && !signals.hasSmallChangeCue) {
      return decision("orchestrated_run", "high", language, normalizedPrompt, workspacePrompt, "The requested change spans risky or multi-file scope.");
    }
    return decision("simple_run", signals.hasSmallChangeCue ? "high" : "medium", language, normalizedPrompt, workspacePrompt, "The request is a bounded code/project action.");
  }

  if (signals.hasRunRequest) {
    return decision("simple_run", "high", language, normalizedPrompt, workspacePrompt, "The request asks to run, start, launch, test, or build.");
  }

  if (signals.hasProjectQuestion || (signals.hasProjectObject && signals.hasQuestion)) {
    return decision("inspect_explain", signals.hasProjectQuestion ? "high" : "medium", language, normalizedPrompt, workspacePrompt, "The request asks about project or code behavior.");
  }

  if (signals.hasGeneralChat) {
    return decision("chat", "high", language, normalizedPrompt, workspacePrompt, "General chat does not need workspace routing.");
  }

  if (signals.hasProjectObject) {
    return decision("chat", "low", language, normalizedPrompt, workspacePrompt, "Low-confidence project mention without a clear task; route to chat.");
  }

  if (signals.tokenCount <= 8 || signals.hasQuestion) {
    return decision("chat", "medium", language, normalizedPrompt, workspacePrompt, "Unknown or general question; route to normal chat.");
  }

  return decision("chat", "low", language, normalizedPrompt, workspacePrompt, "Low-confidence unknown prompt; route to normal chat.");
}

export function executionModeForConversationRoute(route: ConversationRoute): Exclude<RuntimeExecutionMode, "auto_mode"> {
  if (route === "orchestrated_run" || route === "swarm_readonly") return "orchestrated_mode";
  return "simple_mode";
}

export function isWorkspaceRoute(route: ConversationRoute) {
  return route !== "chat";
}

function collectRouteSignals(text: string): RouteSignals {
  const tokenCount = text.split(/\s+/).filter(Boolean).length;
  const hasQuestion = /[?\u061f]/.test(text)
    || /\b(why|how|what|where|when|is|are|does|do|can|should|explain)\b/i.test(text)
    || /(?:\u0627\u0632\u0627\u064a|\u0625\u0632\u0627\u064a|\u0627\u064a\u0647|\u0625\u064a\u0647|\u0641\u064a\u0646|\u0644\u064a\u0647|\u0647\u0644|\u0634\u0631\u062d)/u.test(text);
  const hasGeneralChat = /\b(hi|hello|hey|thanks|thank you|good morning|good evening|who are you|what can you do)\b/i.test(text)
    || /(?:\u0647\u0627\u064a|\u0647\u0644\u0627|\u0627\u0647\u0644\u0627|\u0623\u0647\u0644\u0627|\u0645\u0631\u062d\u0628\u0627|\u0633\u0644\u0627\u0645|\u0634\u0643\u0631\u0627|\u0645\u062a\u0634\u0643\u0631|\u062a\u0633\u0644\u0645)/u.test(text);
  const hasProjectQuestion = /\b(explain|inspect|analyze|review|trace|where|why|how|architecture|flow|implemented|works|what.*project|what.*repo)\b/i.test(text)
    || /(?:\u0627\u0634\u0631\u062d|\u062d\u0644\u0644|\u0631\u0627\u062c\u0639|\u0627\u0644\u0645\u0639\u0645\u0627\u0631\u064a|\u0627\u0644\u0641\u0644\u0648|\u0627\u0644\u062a\u062f\u0641\u0642|\u0628\u064a\u062a\u0637\u0628\u0642|\u0628\u064a\u0634\u062a\u063a\u0644)/u.test(text);
  const hasProjectObject = /\b(project|repo|workspace|file|folder|code|app|component|api|backend|frontend|database|test|route|module|class|function|bug|error|agent|runtime|provider|tauri|react|rust|typescript)\b/i.test(text)
    || /(?:\u0645\u0634\u0631\u0648\u0639|\u0628\u0631\u0648\u062c\u0643\u062a|\u0643\u0648\u062f|\u0645\u0644\u0641|\u0645\u0644\u0641\u0627\u062a|\u0646\u0638\u0627\u0645|\u0628\u0627\u0643|\u0641\u0631\u0648\u0646\u062a|\u0648\u0627\u062c\u0647\u0629|\u062a\u0633\u062a|\u062e\u0637\u0623|\u0627\u064a\u0631\u0648\u0631)/u.test(text);
  const hasCodeAction = /\b(fix|change|edit|modify|implement|add|remove|delete|update|wire|build|write|create|refactor|migrate)\b/i.test(text)
    || /(?:\u0635\u0644\u062d|\u0639\u062f\u0644|\u063a\u064a\u0631|\u0646\u0641\u0630|\u0636\u064a\u0641|\u0623\u0636\u0641|\u0627\u0636\u0641|\u0627\u062d\u0630\u0641|\u0627\u0643\u062a\u0628|\u0627\u0639\u0645\u0644|\u0627\u0628\u0646\u064a|\u0627\u0631\u0628\u0637)/u.test(text);
  const hasRunRequest = /\b(run|start|launch|serve|open|preview|boot|test|build)\b/i.test(text)
    || /(?:\u0634\u063a\u0644|\u0627\u0641\u062a\u062d|\u0627\u0628\u062f\u0623|\u0627\u0628\u062f\u0627|\u0627\u062e\u062a\u0628\u0631|\u0627\u0628\u0646\u064a).*(?:\u0645\u0634\u0631\u0648\u0639|\u062a\u0637\u0628\u064a\u0642|app|project|site|server)/u.test(text);
  const hasExplicitSwarmReadOnly = /\b(swarm|whole[- ]repo|repo-wide|read[- ]only audit|audit the whole|scan the whole|broad audit)\b/i.test(text)
    || /(?:\u0633\u0648\u0627\u0631\u0645|\u0627\u0644\u0631\u064a\u0628\u0648 \u0643\u0644\u0647|\u0627\u0644\u0645\u0634\u0631\u0648\u0639 \u0643\u0644\u0647|\u0623\u0648\u062f\u062a|\u0627\u0648\u062f\u062a).*(?:read.?only|\u0642\u0631\u0627\u0621\u0629|\u0645\u0646 \u063a\u064a\u0631 \u062a\u0639\u062f\u064a\u0644)/u.test(text);
  const hasRiskyMultiFileScope = /\b(multi[- ]file|many files|whole app|whole project|large refactor|migration|auth|security|database|cross-cutting|architecture-wide|breaking change)\b/i.test(text)
    || /(?:\u0623\u0643\u062a\u0631 \u0645\u0646 \u0645\u0644\u0641|\u0643\u0644 \u0627\u0644\u0645\u0634\u0631\u0648\u0639|\u0631\u064a\u0641\u0627\u0643\u062a\u0648\u0631 \u0643\u0628\u064a\u0631|\u0633\u064a\u0643\u064a\u0648\u0631\u062a\u064a|\u062f\u0627\u062a\u0627\u0628\u064a\u0632)/u.test(text);
  const hasSmallChangeCue = /\b(small|quick|one file|single file|tiny|minimal|minor|just)\b/i.test(text)
    || /(?:\u0628\u0633|\u0645\u0644\u0641 \u0648\u0627\u062d\u062f|\u062a\u0639\u062f\u064a\u0644 \u0635\u063a\u064a\u0631|\u0628\u0633\u064a\u0637|\u0633\u0631\u064a\u0639)/u.test(text);
  return {
    tokenCount,
    hasQuestion,
    hasGeneralChat,
    hasProjectQuestion,
    hasProjectObject,
    hasCodeAction,
    hasRunRequest,
    hasExplicitSwarmReadOnly,
    hasRiskyMultiFileScope,
    hasSmallChangeCue
  };
}

function normalizeConversationPrompt(message: string) {
  return message
    .normalize("NFKC")
    .replace(/[\u064b-\u065f\u0670]/gu, "")
    .replace(/\u0640/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripConversationPreamble(message: string) {
  return message
    .replace(/^(?:hi|hello|hey|yo|thanks|thank you|please)\b[\s,.:;!?-]*/iu, "")
    .replace(/^(?:\u0647\u0627\u064a|\u0647\u0644\u0627|\u0627\u0647\u0644\u0627|\u0623\u0647\u0644\u0627|\u0645\u0631\u062d\u0628\u0627|\u0633\u0644\u0627\u0645|\u0634\u0643\u0631\u0627|\u0644\u0648\s+\u0633\u0645\u062d\u062a)[\s\u060c,.:;!\u061f?-]*/u, "")
    .trim();
}

function hasArabic(message: string) {
  return /[\u0600-\u06ff]/u.test(message);
}

function decision(
  route: ConversationRoute,
  confidence: ConversationRouteConfidence,
  language: ConversationRouteDecision["language"],
  normalizedPrompt: string,
  workspacePrompt: string,
  rationale: string
): ConversationRouteDecision {
  return {
    route,
    confidence,
    language,
    normalizedPrompt,
    workspacePrompt: workspacePrompt || normalizedPrompt,
    rationale
  };
}
