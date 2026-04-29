import type { BusinessBrief, ProductBrief } from "@orchcode/protocol";

export class BusinessOrchestrator {
  createBrief(productBrief: ProductBrief): BusinessBrief {
    return {
      mvpScope: productBrief.scope.slice(0, 3),
      outOfScope: ["Large rewrites", "Unapproved file writes", "Network-dependent behavior in mock mode"],
      userValue: `Delivers a reviewable path toward: ${productBrief.goal}`,
      businessRisks: ["Scope creep", "Regression risk if tests are skipped", "Security review needed for command or patch changes"],
      acceptanceCriteria: productBrief.successCriteria,
      priority: productBrief.userIntent === "bug_fix" ? "high" : "medium",
      releaseNotesDraft: `Prepared a safe multi-agent implementation plan for ${productBrief.goal}.`
    };
  }
}
