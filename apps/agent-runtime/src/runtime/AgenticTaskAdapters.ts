import type { LlmProvider } from "../llm/LlmProvider.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { AgenticTaskAdapter, AgenticTaskRequest, AgenticTaskResult } from "./AgenticTaskModels.js";

export type ProjectExplainAgenticAdapterInput = {
  provider: LlmProvider;
  tools: ToolRegistry;
  userPrompt: string;
  workspacePath: string;
  config?: AgenticTaskRequest["config"];
};

export type ProjectExplainAgenticAdapterOutput = {
  answerMarkdown: string;
  evidenceRefs: string[];
  trace: AgenticTaskResult["trace"];
  result: AgenticTaskResult;
};

export const ProjectExplainAgenticAdapter: AgenticTaskAdapter<ProjectExplainAgenticAdapterInput, ProjectExplainAgenticAdapterOutput> = {
  id: "project_explain_agentic_adapter",
  modes: ["project_explain", "architecture_explain", "feature_explain", "feature_existence", "data_flow", "ui_flow", "backend_flow", "config_explain", "design_assessment", "debugging_analysis"],
  canHandle(request) {
    return !request.adapterId || request.adapterId === "project_explain" || request.adapterId === this.id;
  },
  toRequest(input) {
    return {
      adapterId: "project_explain",
      prompt: input.userPrompt,
      workspacePath: input.workspacePath,
      provider: input.provider,
      tools: input.tools,
      config: input.config
    };
  },
  fromResult(result) {
    return {
      answerMarkdown: result.finalOutput.markdown,
      evidenceRefs: result.finalOutput.citations,
      trace: result.trace,
      result
    };
  }
};

export type FutureAgenticAdapterId =
  | "coding_planning"
  | "debugging"
  | "refactor_planning"
  | "review_reasoning"
  | "repair_planning"
  | "validation_planning"
  | "docs";

export const FutureAgenticTaskAdapters: Array<AgenticTaskAdapter<AgenticTaskRequest, AgenticTaskResult>> = [
  skeletalAdapter("coding_planning", ["coding_planning", "patch_preparation"]),
  skeletalAdapter("debugging", ["debugging_analysis"]),
  skeletalAdapter("refactor_planning", ["refactor_planning"]),
  skeletalAdapter("review_reasoning", ["review_reasoning"]),
  skeletalAdapter("repair_planning", ["repair_planning"]),
  skeletalAdapter("validation_planning", ["validation_planning"]),
  skeletalAdapter("docs", ["docs_generation"])
];

function skeletalAdapter(id: FutureAgenticAdapterId, modes: AgenticTaskAdapter["modes"]): AgenticTaskAdapter<AgenticTaskRequest, AgenticTaskResult> {
  return {
    id,
    modes,
    canHandle() {
      return false;
    },
    toRequest(input) {
      return input;
    },
    fromResult(result) {
      return result;
    }
  };
}
