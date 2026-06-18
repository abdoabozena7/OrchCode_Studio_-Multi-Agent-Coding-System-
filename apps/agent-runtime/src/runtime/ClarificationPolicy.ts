import type { ClarificationClassification, QuestionDecomposition } from "@hivo/protocol";

export function classifyClarifications(input: {
  decomposition: QuestionDecomposition;
  missingFacts: string[];
}): ClarificationClassification[] {
  return unique([...input.decomposition.ambiguities, ...input.missingFacts]).map((fact) => {
    const classification = classifyFact(fact);
    return {
      fact,
      classification,
      rationale: rationaleForFact(fact, classification)
    };
  });
}

export function blockingUserClarifications(classifications: ClarificationClassification[]) {
  return classifications.filter((entry) => entry.classification === "user_blocker");
}

function classifyFact(fact: string): ClarificationClassification["classification"] {
  if (/\b(which|choose|preference|desired|expected|should mean|target behavior|acceptance|business rule|intended)\b/i.test(fact)
    || /(?:أي|اختيار|تفضيل|المقصود|السلوك المطلوب|معيار القبول|قاعدة العمل)/u.test(fact)) {
    return "user_blocker";
  }
  if (/\b(file|symbol|implementation|call|route|endpoint|storage|database|test|config|dependency|workspace|repository|project)\b/i.test(fact)
    || /(?:ملف|رمز|تنفيذ|استدعاء|مسار|تخزين|قاعدة بيانات|اختبار|إعداد|مستودع|مشروع)/u.test(fact)) {
    return "discoverable";
  }
  if (/\b(format|detail level|answer shape|ordering|presentation)\b/i.test(fact)
    || /(?:تنسيق|مستوى التفاصيل|شكل الإجابة|ترتيب|عرض)/u.test(fact)) {
    return "safe_assumption";
  }
  return "deferred_unknown";
}

function rationaleForFact(fact: string, classification: ClarificationClassification["classification"]) {
  if (classification === "user_blocker") return `"${fact}" changes the intended answer and cannot be proven from repository evidence.`;
  if (classification === "discoverable") return `"${fact}" should be investigated from the repository before asking the user.`;
  if (classification === "safe_assumption") return `"${fact}" can use a recorded conservative default without blocking investigation.`;
  return `"${fact}" is not required to support the material claims and can remain explicit as unknown.`;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
