import type { TaskNode } from "@hivo/protocol";
import { BaseWorker, type WorkerContext } from "./BaseWorker.js";

export class ToolingTerminalAgent extends BaseWorker {
  readonly agentName = "ToolingTerminalAgent";

  protected execute(_task: TaskNode, context: WorkerContext) {
    const previewRecommendation = inferPreview(context);
    const command = context.projectMap.testCommands[0] ?? "git diff --check";
    const commandRequest = context.tools.command.requestRun(context.sessionId, command, "Validate the orchestrated patch proposal.");
    return {
      summary: "Prepared safe validation command request.",
      details: [
        `Command: ${command}`,
        `Risk: ${commandRequest.risk}`,
        previewRecommendation ? `Preview: ${previewRecommendation.description}` : "No preview recommendation"
      ],
      risks: commandRequest.risk === "safe" ? [] : ["Command requires approval before execution."],
      commandRequest,
      previewRecommendation
    };
  }
}

function inferPreview(context: WorkerContext) {
  const normalized = context.userPrompt.toLowerCase();
  if (normalized.includes("snake") && normalized.includes("threejs") && normalized.includes("html")) {
    return {
      type: "file" as const,
      target: "index.html",
      description: "the generated static Three.js demo"
    };
  }
  if (context.projectMap.packageManagers.includes("pnpm")) {
    return {
      type: "url" as const,
      target: "http://127.0.0.1:5173",
      description: "the local pnpm dev server",
      command: "pnpm dev"
    };
  }
  if (context.projectMap.packageManagers.includes("npm")) {
    return {
      type: "url" as const,
      target: "http://127.0.0.1:5173",
      description: "the local npm dev server",
      command: "npm run dev"
    };
  }
  return undefined;
}
