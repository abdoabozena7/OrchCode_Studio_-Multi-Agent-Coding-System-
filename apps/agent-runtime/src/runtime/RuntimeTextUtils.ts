import type { AgentRuntimeSession } from "@hivo/protocol";

export function detectResponseLanguage(value: string): "ar" | "en" {
  return /[\u0600-\u06ff]/.test(value) ? "ar" : "en";
}

export function isArabicRuntimeLanguage(language: "ar" | "en" | "arabic" | "english" | string | undefined) {
  return language === "ar" || language === "arabic";
}

export function waitingForProviderSummary(
  session: AgentRuntimeSession,
  language: "ar" | "en" | "arabic" | "english" | string | undefined
) {
  const model = session.providerConfig?.selectedModel ?? session.providerConfig?.routerModel ?? "selected model";
  if (isArabicRuntimeLanguage(language)) {
    return `بانتظار رد الموديل ${model} لتحديد نوع السؤال وخطة الأدلة.`;
  }
  return `Waiting for ${model} to classify the request and choose the evidence plan.`;
}

export function summarizeRuntimeOutput(text: string | undefined, limit = 240) {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}
