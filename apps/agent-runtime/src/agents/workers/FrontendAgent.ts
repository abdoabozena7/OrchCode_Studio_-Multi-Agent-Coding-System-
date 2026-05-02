import type { TaskNode } from "@orchcode/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";
import { createThreeJsSnakeProposal, isThreeJsSnakePrompt, validateThreeJsSnakeProposal } from "../../mock/threeJsSnake.js";

export class FrontendAgent extends BaseWorker {
  readonly agentName = "FrontendAgent";

  protected execute(task: TaskNode, context: WorkerContext) {
    if (isThreeJsSnakePrompt(context.userPrompt)) {
      const role = context.workOrder?.agentName ?? task.assignedAgent;
      if (role === "GameLogicAgent") {
        return {
          summary: "Defined the gameplay requirements for the snake loop.",
          details: ["Requires directional movement, food spawning, score updates, self-collision/wall collision, and reset behavior."],
          risks: [],
          selfCheck: {
            workOrderId: context.workOrder?.id ?? task.id,
            passedCriteria: context.workOrder?.acceptanceCriteria ?? [],
            failedCriteria: [],
            missingItems: [],
            confidence: 0.9
          }
        };
      }
      if (role === "ThreeJsRenderingAgent") {
        return {
          summary: "Defined the Three.js rendering requirements.",
          details: ["Requires scene, camera, lighting, board grid, snake meshes, food mesh, resize handling, and animation loop."],
          risks: [],
          selfCheck: {
            workOrderId: context.workOrder?.id ?? task.id,
            passedCriteria: context.workOrder?.acceptanceCriteria ?? [],
            failedCriteria: [],
            missingItems: [],
            confidence: 0.9
          }
        };
      }
      const proposal = createThreeJsSnakeProposal(context.userPrompt, {
        title: "Playable Three.js snake implementation",
        summary: "Creates a playable HTML/CSS/JS Three.js snake game with movement, food, score, collision, reset, and HUD.",
        riskLevel: task.riskLevel
      });
      const patch = context.tools.patch.propose(
        proposal,
        context.sessionId
      );
      const quality = validateThreeJsSnakeProposal(patch);
      return {
        summary: "Prepared a playable static Three.js snake implementation.",
        details: [
          "Creates index.html, styles.css, and main.js.",
          "Includes movement, food, score, collision/reset, rendering, HUD, and resize handling.",
          ...quality.reviewerNotes,
          `Integrated prior worker outputs: ${context.previousOutputs.map((output) => output.agentName).join(", ") || "none"}.`
        ],
        risks: ["Uses CDN Three.js so preview requires network access."],
        patch,
        selfCheck: {
          workOrderId: context.workOrder?.id ?? task.id,
          passedCriteria: quality.valid ? context.workOrder?.acceptanceCriteria ?? [] : [],
          failedCriteria: quality.valid ? [] : quality.blockingReasons,
          missingItems: quality.valid ? [] : ["Browser-ready playable artifact"],
          confidence: quality.valid ? 0.95 : 0.25
        }
      };
    }

    if (isSettingsThemePrompt(context.userPrompt)) {
      const target = "apps/desktop/src/app/SettingsPage.tsx";
      const content = [
        "import { useState } from \"react\";",
        "",
        "export function SettingsPage() {",
        "  const [darkMode, setDarkMode] = useState(true);",
        "",
        "  return (",
        "    <section aria-label=\"Settings\" className=\"settings-page\">",
        "      <h2>Settings</h2>",
        "      <label>",
        "        <input",
        "          type=\"checkbox\"",
        "          checked={darkMode}",
        "          onChange={(event) => setDarkMode(event.currentTarget.checked)}",
        "        />",
        "        Dark theme",
        "      </label>",
        "    </section>",
        "  );",
        "}",
        ""
      ].join("\n");
      const patch = context.tools.patch.propose(
        {
          title: "Settings page with theme toggle",
          summary: "Creates a small React settings page component with an accessible dark-theme toggle.",
          riskLevel: task.riskLevel,
          filesChanged: [{ path: target, changeType: "create", explanation: "Adds the requested settings UI surface." }],
          artifacts: [{ path: target, content }],
          unifiedDiff: [
            `diff --git a/${target} b/${target}`,
            "new file mode 100644",
            "index 0000000..1111111",
            "--- /dev/null",
            `+++ b/${target}`,
            "@@ -0,0 +1,19 @@",
            ...content.trimEnd().split("\n").map((line) => `+${line}`)
          ].join("\n"),
          requiresApproval: true,
          status: "proposed"
        },
        context.sessionId
      );
      return {
        summary: "Prepared a concrete settings page patch.",
        details: ["Creates a SettingsPage React component.", "Includes a keyboard-accessible checkbox toggle."],
        risks: ["The component still needs integration into the app navigation."],
        patch,
        selfCheck: {
          workOrderId: context.workOrder?.id ?? task.id,
          passedCriteria: context.workOrder?.acceptanceCriteria ?? [],
          failedCriteria: [],
          missingItems: [],
          confidence: 0.78
        }
      };
    }

    const target = task.fileLocks[0] ?? "apps/desktop/src/app/App.tsx";
    const nextContent = context.tools.workspace.fileExists(target)
      ? `// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying\n${context.tools.workspace.readWholeFile(target)}`
      : "// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying\n";
    const patch = context.tools.patch.propose(
      {
        title: "Frontend implementation proposal",
        summary: `Mock frontend patch for: ${context.userPrompt}`,
        riskLevel: task.riskLevel,
        filesChanged: [{ path: target, changeType: "modify", explanation: "Representative UI change proposed by FrontendAgent." }],
        artifacts: [{ path: target, content: nextContent }],
        unifiedDiff: [
          `diff --git a/${target} b/${target}`,
          `--- a/${target}`,
          `+++ b/${target}`,
          "@@ -1,3 +1,4 @@",
          "+// MOCK_ORCHESTRATED_FRONTEND_CHANGE: review before applying",
          " import React from \"react\";"
        ].join("\n"),
        requiresApproval: true,
        status: "proposed"
      },
      context.sessionId
    );
    return {
      summary: "Prepared a frontend patch proposal.",
      details: [`Target file: ${target}`, "Patch is not applied and requires user approval."],
      risks: ["Generated diff is representative in mock mode."],
      patch,
      selfCheck: {
        workOrderId: context.workOrder?.id ?? task.id,
        passedCriteria: [],
        failedCriteria: ["Generic mock patch is representative only."],
        missingItems: ["Task-specific implementation"],
        confidence: 0.35
      }
    };
  }
}

function isSettingsThemePrompt(prompt: string) {
  const normalized = prompt.toLowerCase();
  return normalized.includes("settings") && normalized.includes("theme");
}
