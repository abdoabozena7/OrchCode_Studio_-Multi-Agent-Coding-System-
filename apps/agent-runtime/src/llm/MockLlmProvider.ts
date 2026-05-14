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
    if (schemaName === "run-plan") {
      return this.createRunPlan(input.userPrompt) as T;
    }
    if (schemaName === "run-patch") {
      return this.createRunPatch(input.userPrompt) as T;
    }
    if (schemaName === "run-verification") {
      return {
        summary: "Mock verification pending Rust apply.",
        checks: [{ name: "Mock verification", status: "pending", detail: "Waiting for approved apply." }]
      } as T;
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

  private createRunPlan(userPrompt: string) {
    const request = extractUserRequest(userPrompt);
    const mode = /\b(create|new|scaffold|generate|make a new)\b/i.test(request)
      ? "create_project"
      : (/\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/i.test(request) ||
          (/\b(explain|inspect|analyze)\b/i.test(request) && !/\b(change|edit|fix|add|create)\b/i.test(request)))
        ? "inspect_only"
        : "edit_project";
    const requestedCount = Number(request.match(/\buse\s+(\d+)\s+agents?\b/i)?.[1] ?? "1");
    const count = mode === "inspect_only" ? 1 : Math.min(Math.max(requestedCount || 1, 1), 5);
    const rolePool = /\b(game|three|3d|snake)\b/i.test(request)
      ? ["Gameplay Implementer", "3D Rendering Implementer", "Frontend Integration Implementer", "Verification Planner", "UX Polish Implementer"]
      : ["Implementation Worker", "Workspace Integrator", "Verification Planner", "Documentation Worker", "Review Worker"];
    return {
      summary: mode === "create_project" ? "Create a new local project as reviewable files." : "Prepare a gated local coding run.",
      reasoningSummary: "Mock planning keeps the flow reviewable and Rust-gated.",
      mode,
      tasks: Array.from({ length: count }, (_, index) => ({
        id: `mock_task_${index + 1}`,
        title: mode === "create_project" && index === 0 ? "Create project scaffold" : `Prepare reviewable change ${index + 1}`,
        objective: request,
        roleTitle: mode === "create_project" && index === 0 ? "Project Scaffolder" : rolePool[index] ?? `Dynamic Worker ${index + 1}`,
        targetFiles: mode === "create_project" ? ["orchcode-project/README.md", "orchcode-project/index.html"] : ["AGENT_PROPOSAL.md"],
        expectedArtifact: "Reviewable diff",
        verification: "git diff --check"
      })),
      acceptanceCriteria: ["User can review before apply.", "Rust applies changes."],
      risks: ["Mock mode is not codebase-specific."],
      suggestedCommands: [{ command: "git diff --check", reason: "Validate the approved diff." }]
    };
  }

  private createRunPatch(userPrompt: string) {
    const request = extractUserRequest(userPrompt);
    return {
      title: "Mock gated patch",
      summary: "Creates a reviewable proposal artifact.",
      files: [
        {
          path: "AGENT_PROPOSAL.md",
          changeType: "create",
          explanation: "Reviewable mock artifact.",
          content: `# Agent Proposal\n\nRequest: ${request}\n\nThis is a gated mock artifact. Use a validated Ollama provider for project-specific code generation.\n`
        }
      ],
      suggestedCommands: [{ command: "git diff --check", reason: "Validate the approved diff." }]
    };
  }
}

function extractUserRequest(prompt: string) {
  const match = prompt.match(/User request:\s*([\s\S]*?)(?:\n(?:Workspace snapshot|Plan):|$)/i);
  return (match?.[1] ?? prompt).trim();
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
