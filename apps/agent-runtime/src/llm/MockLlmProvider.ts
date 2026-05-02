import type { AgentPlan, PatchProposal } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "./LlmProvider.js";
import { createThreeJsSnakeProposal, isThreeJsSnakePrompt } from "../mock/threeJsSnake.js";

export class MockLlmProvider implements LlmProvider {
  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    const schemaName = getSchemaName(schema);
    if (schemaName === "agent-plan") {
      return this.createPlan(input.userPrompt) as T;
    }
    if (schemaName === "patch-proposal") {
      return this.createPatchProposal(input.userPrompt, input.context) as T;
    }
    return {} as T;
  }

  async generateText(input: LlmRequest): Promise<string> {
    return `Mock analysis complete for: ${input.userPrompt}`;
  }

  private createPlan(userPrompt: string): AgentPlan {
    return {
      summary: `Prepare a small, reviewable change for: ${userPrompt}`,
      steps: [
        {
          id: "scan",
          title: "Scan repository",
          detail: "Identify project type, important files, and current git state.",
          status: "completed"
        },
        {
          id: "context",
          title: "Gather context",
          detail: "Search for likely files before reading specific source files.",
          status: "completed"
        },
        {
          id: "patch",
          title: "Prepare patch proposal",
          detail: "Create a non-applied unified diff for user review.",
          status: "completed"
        }
      ],
      acceptanceCriteria: [
        "The proposal is visible before any file is written.",
        "The changed files are explained.",
        "A safe validation command is suggested."
      ],
      risks: [
        "Mock mode generates a representative patch and may not compile against the real code.",
        "Patch application remains disabled until explicit approval plumbing is complete."
      ]
    };
  }

  private createPatchProposal(userPrompt: string, context: unknown): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
    if (isThreeJsSnakePrompt(userPrompt)) {
      return createThreeJsSnakeProposal(userPrompt);
    }
    const summaryFile = inferSummaryFile(context);
    const summaryContent = [
      "# Agent Proposal",
      "",
      `Request: ${userPrompt.replaceAll("\n", " ")}`,
      "",
      "This patch was generated in MOCK_LLM mode.",
      "It is intentionally not applied automatically.",
      "Review and approve before any future write operation.",
      "Suggested validation: git diff --check"
    ].join("\n");
    return {
      title: "Mock implementation note",
      summary: `Adds a local implementation note for the requested task: ${userPrompt}`,
      riskLevel: "low",
      filesChanged: [
        {
          path: summaryFile,
          changeType: "create",
          explanation: "Captures the proposed change in a reviewable generated note."
        }
      ],
      artifacts: [
        {
          path: summaryFile,
          content: `${summaryContent}\n`
        }
      ],
      unifiedDiff: [
        `diff --git a/${summaryFile} b/${summaryFile}`,
        "new file mode 100644",
        "index 0000000..1111111",
        "--- /dev/null",
        `+++ b/${summaryFile}`,
        "@@ -0,0 +1,8 @@",
        ...summaryContent.split("\n").map((line) => `+${line}`)
      ].join("\n"),
      requiresApproval: true,
      status: "proposed"
    };
  }
}

function getSchemaName(schema: unknown) {
  if (typeof schema === "object" && schema && "name" in schema) {
    return String((schema as { name: string }).name);
  }
  return "";
}

function inferSummaryFile(context: unknown) {
  if (
    typeof context === "object" &&
    context &&
    "summaryFile" in context &&
    typeof (context as { summaryFile: unknown }).summaryFile === "string"
  ) {
    return (context as { summaryFile: string }).summaryFile;
  }
  return "AGENT_PROPOSAL.md";
}
