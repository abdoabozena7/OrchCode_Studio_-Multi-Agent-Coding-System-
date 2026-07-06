import type {
  BusinessBrief,
  IntentContract,
  ProductBrief,
  ProjectMap
} from "@hivo/protocol";
import { ProductOrchestrator } from "../orchestrators/ProductOrchestrator.js";
import { BusinessOrchestrator } from "../orchestrators/BusinessOrchestrator.js";
import { EngineeringOrchestrator } from "../orchestrators/EngineeringOrchestrator.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

export type OrchestratedPlanningInput = {
  sessionId: string;
  workspacePath: string;
  intentContract: IntentContract;
  projectMap?: ProjectMap;
};

export type OrchestratedPlanningResult = {
  projectMap: ProjectMap;
  productBrief: ProductBrief;
  businessBrief: BusinessBrief;
  engineering: ReturnType<EngineeringOrchestrator["createTechnicalPlan"]>;
};

export class OrchestratedPlanningService {
  plan(input: OrchestratedPlanningInput): OrchestratedPlanningResult {
    const projectMap = input.projectMap ?? inferProjectMap(input.workspacePath);
    const productBrief = new ProductOrchestrator().createBrief(input.intentContract);
    const businessBrief = new BusinessOrchestrator().createBrief(productBrief);
    const engineering = new EngineeringOrchestrator().createTechnicalPlan({
      sessionId: input.sessionId,
      productBrief,
      businessBrief,
      projectMap
    });
    return {
      projectMap,
      productBrief,
      businessBrief,
      engineering
    };
  }
}

export function inferProjectMap(workspacePath: string): ProjectMap {
  const tools = new ToolRegistry(workspacePath);
  const projectSummary = tools.workspace.getProjectSummary();
  return {
    stack: Object.keys(projectSummary.languages),
    packageManagers: projectSummary.packageManagers,
    testCommands: projectSummary.testCommands,
    entryPoints: inferEntryPoints(projectSummary.importantFiles),
    importantFiles: projectSummary.importantFiles
  };
}

export function inferEntryPoints(files: string[]) {
  return files.filter((file) => /main|index|App|lib\.rs|main\.rs/.test(file)).slice(0, 8);
}
