import type { ProductBrief } from "@hivo/protocol";

export class ProductOrchestrator {
  createBrief(userPrompt: string): ProductBrief {
    const successCriteria = inferSuccessCriteria(userPrompt);
    return {
      goal: userPrompt.trim(),
      userIntent: inferIntent(userPrompt),
      scope: ["Clarify the requested outcome", "Keep the first implementation reviewable", "Preserve existing behavior"],
      constraints: ["No direct workspace writes by agents", "Patch proposals require approval", "Use controlled tools only"],
      successCriteria,
      clarifyingQuestions: [],
      assumptions: ["The request can proceed with the current workspace context", "Mock mode may produce representative patches"]
    };
  }
}

function inferIntent(prompt: string): ProductBrief["userIntent"] {
  const value = prompt.toLowerCase();
  if (value.includes("test")) return "write_tests";
  if (value.includes("bug") || value.includes("fix")) return "bug_fix";
  if (value.includes("refactor")) return "refactor";
  if (value.includes("new project")) return "new_project";
  if (value.includes("explain")) return "explain_code";
  return "add_feature";
}

function inferSuccessCriteria(prompt: string) {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("snake") && normalized.includes("threejs")) {
    return [
      "Creates index.html, styles.css, and main.js",
      "Renders a nonblank Three.js scene",
      "Implements snake movement controlled by arrow keys",
      "Implements food spawning and growth",
      "Shows and updates score",
      "Handles wall or self collision by resetting the game",
      "Can be previewed locally without a build step"
    ];
  }
  return [
    "A technical plan is produced",
    "Relevant workers contribute outputs",
    "Patch proposals and reviews are visible before approval"
  ];
}
