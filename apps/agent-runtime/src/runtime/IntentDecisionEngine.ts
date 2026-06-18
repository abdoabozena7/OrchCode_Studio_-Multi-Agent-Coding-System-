import { isWorkspaceRoute, routeConversation } from "./ConversationRouter.js";

export type IntentDecisionKind =
  | "direct_conversation"
  | "workspace_question"
  | "workspace_action"
  | "run_request";

export type IntentDecisionLanguage = "arabic" | "english";

export type IntentDecision = {
  kind: IntentDecisionKind;
  language: IntentDecisionLanguage;
  needsWorkspace: boolean;
  confidence: "high" | "medium" | "low";
  rationale: string;
};

export type ProviderIntentDecisionModel = IntentDecision & {
  workspaceMessage: string;
};

export type WorkspacePromptPreparation = {
  originalMessage: string;
  workspaceMessage: string;
  droppedPreamble: string;
};

type IntentSignals = {
  tokenCount: number;
  hasRunSignal: boolean;
  hasWorkspaceQuestionSignal: boolean;
  hasWorkspaceActionSignal: boolean;
  hasWorkspaceObjectSignal: boolean;
  hasCodeLikeSignal: boolean;
  hasSocialSignal: boolean;
  hasThanksSignal: boolean;
  hasQuestionSignal: boolean;
};

export function decideIntentBeforeRetrieval(message: string): IntentDecision {
  const route = routeConversation(message);
  if (!isWorkspaceRoute(route.route)) {
    return directDecision(route.language, route.rationale, route.confidence);
  }
  if (route.route === "inspect_explain" || route.route === "swarm_readonly") {
    return workspaceDecision("workspace_question", route.language, route.rationale, route.confidence);
  }
  if (route.route === "simple_run" && looksLikeRunRequest(route.workspacePrompt)) {
    return workspaceDecision("run_request", route.language, route.rationale, route.confidence);
  }
  return workspaceDecision("workspace_action", route.language, route.rationale, route.confidence);
}

export function normalizeProviderIntentDecision(input: ProviderIntentDecisionModel, originalMessage: string): {
  decision: IntentDecision;
  workspaceMessage: string;
  preparedPrompt: WorkspacePromptPreparation;
} {
  const workspaceMessage = input.kind === "direct_conversation"
    ? ""
    : input.workspaceMessage.trim();
  if (input.kind !== "direct_conversation" && !workspaceMessage) {
    throw new Error("provider_intent_decision_invalid: workspaceMessage is required for workspace intents");
  }
  const decision: IntentDecision = {
    kind: input.kind,
    language: input.language,
    needsWorkspace: input.needsWorkspace,
    confidence: input.confidence,
    rationale: input.rationale.trim().slice(0, 280)
  };
  return {
    decision,
    workspaceMessage: workspaceMessage || originalMessage.trim(),
    preparedPrompt: {
      originalMessage,
      workspaceMessage: workspaceMessage || originalMessage.trim(),
      droppedPreamble: workspaceMessage && workspaceMessage !== originalMessage.trim()
        ? originalMessage.trim().slice(0, Math.max(0, originalMessage.trim().length - workspaceMessage.length)).trim()
        : ""
    }
  };
}

export function prepareWorkspacePromptForUnderstanding(message: string): WorkspacePromptPreparation {
  const trimmed = message.trim();
  if (!trimmed) return { originalMessage: message, workspaceMessage: "", droppedPreamble: "" };

  const routed = routeConversation(trimmed);
  const workspaceMessage = routed.workspacePrompt || stripConversationPreamble(trimmed).trim();
  return {
    originalMessage: message,
    workspaceMessage: workspaceMessage || trimmed,
    droppedPreamble: workspaceMessage && workspaceMessage !== trimmed ? trimmed.slice(0, trimmed.length - workspaceMessage.length).trim() : ""
  };
}

function collectIntentSignals(normalized: string): IntentSignals {
  const tokens = normalized.split(" ").filter(Boolean);
  if (isAnswerRelationshipQuestion(normalized)) {
    return {
      tokenCount: tokens.length,
      hasRunSignal: false,
      hasWorkspaceQuestionSignal: true,
      hasWorkspaceActionSignal: false,
      hasWorkspaceObjectSignal: true,
      hasCodeLikeSignal: true,
      hasSocialSignal: false,
      hasThanksSignal: false,
      hasQuestionSignal: true
    };
  }
  return {
    tokenCount: tokens.length,
    hasRunSignal: /\b(run|start|launch|serve|open|preview|boot)\b/i.test(normalized)
      || /(شغل|شغّل|افتح|ابدأ|ابدا|شغله|شغلها).*(مشروع|بروجكت|تطبيق|ابلكيشن|app|project|site|server|سيرفر)/u.test(normalized),
    hasWorkspaceQuestionSignal: /\b(explain|inspect|analyze|review|where|why|how|what|trace|flow|architecture|implemented|applied|work|works)\b/i.test(normalized)
      || /(ازاي|إزاي|ايه|إيه|فين|ليه|اشرح|حلل|راجع|بيتطبق|بيشتغل|متطبق|المعماري|المعمارية|الفلو|التدفق)/u.test(normalized),
    hasWorkspaceActionSignal: /\b(fix|change|edit|modify|implement|add|remove|delete|update|wire|build|write|create|refactor)\b/i.test(normalized)
      || /(صلح|عدّل|عدل|غير|غيّر|نفذ|ضيف|أضف|اضف|احذف|امسح|اكتب|اعمل|ابني|اربط)/u.test(normalized),
    hasWorkspaceObjectSignal: /\b(project|repo|workspace|file|folder|code|app|site|component|api|backend|frontend|database|test|route|module|class|function|bug|error|feedback|rag|agent|system)\b/i.test(normalized)
      || /(مشروع|بروجكت|كود|ملف|ملفات|فولدر|سيستم|النظام|باك|فرونت|واجهة|api|داتا|تست|خطأ|ايرور|فيدباك|عميل|موديل|agent|rag)/u.test(normalized),
    hasCodeLikeSignal: /[`./\\]|\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+|\([^)]*\)|_[A-Za-z0-9_]+)\b/.test(normalized),
    hasSocialSignal: /\b(hi|hello|hey|yo|sup|morning|evening)\b/i.test(normalized)
      || /(هاي|هاى|هلا|اهلا|أهلا|اهلين|أهلين|مرحبا|سلام|صباح الخير|مساء الخير)/u.test(normalized),
    hasThanksSignal: /\b(thanks|thank you|thx|ty)\b/i.test(normalized)
      || /(شكرا|شكرًا|متشكر|تسلم|تسلمي)/u.test(normalized),
    hasQuestionSignal: /[?؟]/.test(normalized)
      || /\b(why|how|what|where|is|does|can|should)\b/i.test(normalized)
      || /(ازاي|إزاي|ايه|إيه|فين|ليه|هل|ازاى)/u.test(normalized)
  };
}

function isAnswerRelationshipQuestion(text: string) {
  const asksWhenOrDecision = /\b(when|decide|decision)\b/i.test(text)
    || /(?:\u0627\u0645\u062a\u0649|\u0645\u062a\u0649|\u064a\u0642\u0631\u0631)/u.test(text);
  const answerLinkDirective = /(?:\u0627\u0631\u0628\u0637|\u0631\u0628\u0637)\s+(?:\u0625?\u062c\u0627\u0628\u062a\u0643|\u0627\u0644\u0625?\u062c\u0627\u0628\u0629)/u.test(text)
    || /(?:\u0625?\u062c\u0627\u0628\u062a\u0643|\u0627\u0644\u0625?\u062c\u0627\u0628\u0629).{0,40}(?:\u0627\u0631\u0628\u0637|\u0631\u0628\u0637)/u.test(text);
  const projectDecisionTerms = /\b(orchestrator|rules?|drift|fcm|membership|cluster|re-cluster|offer)\b/i.test(text);
  return asksWhenOrDecision && answerLinkDirective && projectDecisionTerms;
}

function normalizeMessageForIntentDecision(message: string) {
  return message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s`./\\_()?؟-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripConversationPreamble(message: string) {
  let current = message;
  for (let index = 0; index < 3; index += 1) {
    const next = current
      .replace(/^\s*(?:hi|hello|hey|yo|sup|good\s+morning|good\s+evening|morning|evening|thanks|thank\s+you|thx|please)\b[\s,.:;!?-]*/iu, "")
      .replace(/^\s*(?:هاي|هاى|هلا|اهلا|أهلا|اهلين|أهلين|مرحبا|سلام|صباح\s+الخير|مسا(?:ء|)\s+الخير|شكرا|شكرًا|متشكر|تسلم|لو\s+سمحت)[\s،,.:;!؟?-]*/u, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

function directDecision(language: IntentDecisionLanguage, rationale: string, confidence: IntentDecision["confidence"]): IntentDecision {
  return {
    kind: "direct_conversation",
    language,
    needsWorkspace: false,
    confidence,
    rationale
  };
}

function looksLikeRunRequest(message: string) {
  return /\b(run|start|launch|serve|open|preview|boot|test|build)\b/i.test(message)
    || /(?:\u0634\u063a\u0644|\u0627\u0641\u062a\u062d|\u0627\u0628\u062f\u0623|\u0627\u0628\u062f\u0627|\u0627\u062e\u062a\u0628\u0631|\u0627\u0628\u0646\u064a).*(?:\u0645\u0634\u0631\u0648\u0639|\u062a\u0637\u0628\u064a\u0642|app|project|site|server)/u.test(message);
}

function workspaceDecision(kind: Exclude<IntentDecisionKind, "direct_conversation">, language: IntentDecisionLanguage, rationale: string, confidence: IntentDecision["confidence"]): IntentDecision {
  return {
    kind,
    language,
    needsWorkspace: true,
    confidence,
    rationale
  };
}
