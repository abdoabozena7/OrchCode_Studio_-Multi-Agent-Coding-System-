export type CodingAgentIntent =
  | "inspect_explain"
  | "locate_code"
  | "architecture_reasoning"
  | "plan_change"
  | "edit"
  | "run"
  | "debug"
  | "verify"
  | "review";

const EDIT_VERBS = /\b(change|edit|fix|add|implement|update|write|create|make|build|modify|remove|delete)\b/i;
const ARABIC_EDIT = /(غيّر|غير|عدّل|عدل|صلح|أصلح|اضف|أضف|نفذ|اكتب|اعمل|أنشئ|انشئ|ابني|احذف|شيل)/;

const RUN_VERBS = /\b(run|launch|start|serve|open|boot)\b/i;
const ARABIC_RUN = /(شغل|ابدأ|افتح|ثبت|نزل)/;

const DEBUG_VERBS = /\b(debug|error|failed|bug|crash|broken|issue)\b/i;
const ARABIC_DEBUG = /(بايظ|مشكلة|ارور|إيرور|خطأ|فشل|كراش)/;

const VERIFY_VERBS = /\b(verify|test|check|lint)\b/i;
const ARABIC_VERIFY = /(اتاكد|اتأكد|اختبر|جرب|تست|فحص)/;

const REVIEW_VERBS = /\b(review|audit|critique)\b/i;
const ARABIC_REVIEW = /(قيم|راجع الكود|تدقيق)/;

const PLAN_CHANGE_VERBS = /\b(plan|think|strategy|how to add|how to implement)\b/i;
const ARABIC_PLAN_CHANGE = /(خطط|فكر|طريقة اضافة|طريقة إضافة|استراتيجية)/;

const LOCATE_CODE_VERBS = /\b(where|locate|find|which file|where is)\b/i;
const ARABIC_LOCATE_CODE = /(فين|مكان|انهي ملف|أنهي ملف|موجود فين)/;

const ARCHITECTURE_VERBS = /\b(architecture|design|structure|pattern|how it works)\b/i;
const ARABIC_ARCHITECTURE = /(شغال ازاي|بيشتغل ازاي|هيكلة|تصميم|معمارية)/;

const INSPECT_EXPLAIN_VERBS = /\b(explain|inspect|analyze|summarize|map|count|list|how many|which|what is|what does|how does|how is|are there|is there|do we have|trace|flow|buttons?|actions?|controls?|inputs?|ui)\b/i;
const ARABIC_INSPECT_EXPLAIN = /(اشرح|حلل|افهم|لخص|راجع|كام|كم|ايه|إيه|ازاي|إزاي|كيف|مين|ليست|هاتلي|اعرض|هل|زراير|زرار|زر|ازرار|أزرار|أكشن|اكشن|تحكم|واجهة)/;

export function classifyIntent(message: string): CodingAgentIntent {
  const normalized = message.toLowerCase();

  const isEdit = EDIT_VERBS.test(normalized) || ARABIC_EDIT.test(normalized);
  const isRun = RUN_VERBS.test(normalized) || ARABIC_RUN.test(normalized);
  const isDebug = DEBUG_VERBS.test(normalized) || ARABIC_DEBUG.test(normalized);
  const isVerify = VERIFY_VERBS.test(normalized) || ARABIC_VERIFY.test(normalized);
  const isReview = REVIEW_VERBS.test(normalized) || ARABIC_REVIEW.test(normalized);
  const isPlan = PLAN_CHANGE_VERBS.test(normalized) || ARABIC_PLAN_CHANGE.test(normalized);
  
  const isLocate = LOCATE_CODE_VERBS.test(normalized) || ARABIC_LOCATE_CODE.test(normalized);
  const isArchitecture = ARCHITECTURE_VERBS.test(normalized) || ARABIC_ARCHITECTURE.test(normalized);
  const isInspect = INSPECT_EXPLAIN_VERBS.test(normalized) || ARABIC_INSPECT_EXPLAIN.test(normalized);

  if (isPlan) return "plan_change";

  // If a prompt contains both explanation and edit, action intent wins only when edit is explicit
  if (isEdit) return "edit";
  
  if (isDebug) return "debug";
  if (isRun) return "run";
  if (isVerify) return "verify";
  if (isReview) return "review";

  if (isArchitecture) return "architecture_reasoning";
  if (isInspect) return "inspect_explain";
  if (isLocate) return "locate_code";

  // Default fallback if no clear intent
  return "edit";
}

export function isInspectExplainIntent(intent: CodingAgentIntent): boolean {
  return intent === "inspect_explain" || intent === "locate_code" || intent === "architecture_reasoning";
}
