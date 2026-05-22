import type { InspectExplainFacts } from "./InspectExplainFacts.js";

export type InspectExplainValidation = {
  valid: boolean;
  errors: string[];
  fallbackMarkdown?: string;
};

export function validateAnswerContract(
  intent: "inspect_explain" | "locate_code" | "architecture_reasoning",
  facts: InspectExplainFacts,
  topic: "frontend" | "algorithms" | "training_inference" | "code_flow" | "ui_controls" | "general"
): InspectExplainValidation {
  const errors: string[] = [];

  if (topic === "frontend") {
    if (!facts.frontend || facts.frontend.totalItems === 0) {
      errors.push("No frontend structural items found in evidence.");
      return { valid: false, errors, fallbackMarkdown: "I could not find frontend pages, screens, or routes in the current workspace evidence." };
    }
  }

  if (topic === "algorithms") {
    if (!facts.algorithms || facts.algorithms.deduplicatedCount === 0) {
      errors.push("No algorithms or models found in evidence.");
      return { valid: false, errors, fallbackMarkdown: "I could not find algorithms, models, or ML methods in the current workspace evidence." };
    }
  }

  if (topic === "training_inference") {
    if (!facts.trainingInference || (facts.trainingInference.training.length === 0 && facts.trainingInference.inference.length === 0)) {
      errors.push("No training or inference functions found in evidence.");
      return { valid: false, errors, fallbackMarkdown: "I could not find training or inference separation in the current workspace evidence." };
    }
  }

  if (topic === "code_flow") {
    if (!facts.codeFlow || facts.codeFlow.steps.length === 0) {
      errors.push("Could not trace code flow from evidence.");
      return { valid: false, errors, fallbackMarkdown: "I found files, but I could not confidently synthesize this flow from the current workspace." };
    }
  }

  if (topic === "ui_controls") {
    if (!facts.uiControls || facts.uiControls.controls.length === 0) {
      errors.push("No UI controls found in evidence.");
      return { valid: false, errors, fallbackMarkdown: "لم أجد أزرار أو أحداث في واجهة المستخدم الحالية." };
    }
  }

  return { valid: true, errors };
}
