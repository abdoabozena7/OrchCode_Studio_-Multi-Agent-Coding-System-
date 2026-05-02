import type { BusinessBrief, ProductBrief } from "@orchcode/protocol";

export class BusinessOrchestrator {
  createBrief(productBrief: ProductBrief): BusinessBrief {
    const isSnakeGame = productBrief.goal.toLowerCase().includes("snake") && productBrief.goal.toLowerCase().includes("threejs");
    return {
      mvpScope: isSnakeGame
        ? ["Playable browser snake game", "Three.js rendering", "Keyboard controls", "Score/collision/reset loop"]
        : productBrief.scope.slice(0, 3),
      outOfScope: isSnakeGame
        ? ["Package setup", "Backend services", "Multiplayer", "Persistent high scores"]
        : ["Large rewrites", "Unapproved file writes", "Network-dependent behavior in mock mode"],
      userValue: `Delivers a reviewable path toward: ${productBrief.goal}`,
      businessRisks: ["Scope creep", "Regression risk if tests are skipped", "Security review needed for command or patch changes"],
      acceptanceCriteria: productBrief.successCriteria,
      priority: productBrief.userIntent === "bug_fix" ? "high" : "medium",
      releaseNotesDraft: `Prepared a safe multi-agent implementation plan for ${productBrief.goal}.`
    };
  }
}
