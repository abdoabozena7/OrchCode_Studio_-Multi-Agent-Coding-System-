import type {
  AgentRoleReason,
  BusinessBrief,
  DelegationDecision,
  ProductBrief,
  ProjectMap,
  TaskGraph,
  TaskNode,
  TechnicalPlan
} from "@orchcode/protocol";
import { estimateComplexity, parsePromptDirective } from "../runtime/delegation.js";

type OrchestratorResult = {
  technicalPlan: TechnicalPlan;
  delegationDecision: DelegationDecision;
};

export class EngineeringOrchestrator {
  createTechnicalPlan(input: {
    sessionId: string;
    productBrief: ProductBrief;
    businessBrief: BusinessBrief;
    projectMap: ProjectMap;
  }): OrchestratorResult {
    const workerSelection = selectWorkers(input.productBrief.goal, input.projectMap);
    const nodes = createNodes(input.sessionId, input.productBrief, input.projectMap, workerSelection.roles);
    const graph: TaskGraph = {
      sessionId: input.sessionId,
      nodes,
      edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id })))
    };
    const directive = parsePromptDirective(input.productBrief.goal);
    const complexity = estimateComplexity(input.productBrief.goal, input.projectMap);
    const delegationDecision: DelegationDecision = {
      resolvedMode: "orchestrated_mode",
      explicitUserDirective: directive.explicitDirectiveText,
      requestedAgentCount: directive.requestedAgentCount,
      selectedAgentCount: workerSelection.roles.length,
      selectedAgentRoles: workerSelection.roles,
      agentRoleReasons: workerSelection.reasons,
      estimatedComplexity: complexity,
      rationale:
        workerSelection.rationale ??
        `I used ${workerSelection.roles.length} agents because the task crosses ${workerSelection.roles.length > 3 ? "multiple" : "several"} implementation concerns.`
    };

    return {
      delegationDecision,
      technicalPlan: {
        summary: `Use dynamic orchestration to satisfy: ${input.productBrief.goal}`,
        architectureImpact:
          input.productBrief.userIntent === "add_feature"
            ? "Localized feature-level changes expected"
            : "Low architectural impact expected",
        affectedAreas: [...new Set(nodes.flatMap((node) => node.fileLocks))],
        testStrategy: input.projectMap.testCommands.length ? input.projectMap.testCommands : ["git diff --check"],
        riskLevel: nodes.some((node) => node.riskLevel === "high")
          ? "high"
          : nodes.some((node) => node.riskLevel === "medium")
            ? "medium"
            : "low",
        taskGraph: graph
      }
    };
  }
}

function selectWorkers(goal: string, projectMap: ProjectMap) {
  const normalized = goal.toLowerCase();
  const directive = parsePromptDirective(goal);
  const reasons: AgentRoleReason[] = [];
  const roles: string[] = [];

  const addRole = (role: string, reason: string) => {
    if (!roles.includes(role)) {
      roles.push(role);
      reasons.push({ agentName: role, reason });
    }
  };

  const isStaticUiProject =
    normalized.includes("html") && normalized.includes("css") && normalized.includes("js");
  const isGame = normalized.includes("game") || normalized.includes("threejs") || normalized.includes("3d");
  const needsFrontend =
    isStaticUiProject || normalized.includes("ui") || normalized.includes("page") || normalized.includes("react") || normalized.includes("frontend");
  const needsBackend =
    normalized.includes("backend") ||
    normalized.includes("node") ||
    normalized.includes("fastapi") ||
    normalized.includes("api") ||
    projectMap.stack.includes("Rust");
  const needsTests = normalized.includes("test") || normalized.includes("validate") || projectMap.testCommands.length > 0;
  const needsSecurity = normalized.includes("auth") || normalized.includes("security") || needsBackend;

  if (projectMap.importantFiles.length && !isStaticUiProject) {
    addRole("CodebaseMapperAgent", "Map the existing codebase before proposing targeted changes.");
  }
  if (isGame || needsFrontend || needsBackend) {
    addRole("ArchitectAgent", "Shape the implementation before specialist patches are proposed.");
  }
  if (needsFrontend || isStaticUiProject) {
    addRole(
      "FrontendAgent",
      isStaticUiProject
        ? "Produce the HTML, CSS, and JavaScript surface for the requested app."
        : "Own the user-facing implementation."
    );
  }
  if (needsBackend && !isStaticUiProject) {
    addRole("RustBackendAgent", "Handle backend or Tauri-sensitive implementation work.");
  }
  addRole("ToolingTerminalAgent", "Prepare safe validation and preview/run guidance.");
  if (needsTests || roles.length >= 3) {
    addRole("TestAgent", "Plan validation for the generated change surface.");
  }
  if (needsSecurity && !directive.requestedAgentCount) {
    addRole("SecurityAgent", "Review safety-sensitive work before completion.");
  }
  if (!directive.requestedAgentCount || roles.length < directive.requestedAgentCount) {
    addRole("ReviewerAgent", "Provide the final implementation sanity check.");
  }

  if (directive.requestedAgentCount && directive.requestedAgentCount > 0) {
    const trimmedRoles = roles.slice(0, directive.requestedAgentCount);
    const trimmedReasons = reasons.filter((reason) => trimmedRoles.includes(reason.agentName));
    return {
      roles: trimmedRoles,
      reasons: trimmedReasons,
      rationale: `I used ${trimmedRoles.length} agents because you explicitly requested that count.`
    };
  }

  return {
    roles,
    reasons,
    rationale: `I used ${roles.length} agents because the task mixes ${describeConcerns({
      needsFrontend,
      needsBackend,
      needsTests,
      isGame
    })}.`
  };
}

function createNodes(sessionId: string, productBrief: ProductBrief, projectMap: ProjectMap, roles: string[]): TaskNode[] {
  const frontendFiles = projectMap.importantFiles.filter((file) => /src|app|component|vite|package|html|css|js/.test(file)).slice(0, 3);
  const backendFiles = projectMap.importantFiles.filter((file) => /Cargo|src-tauri|rust|tauri|server|api/.test(file)).slice(0, 3);
  const nodes: TaskNode[] = [];
  const previousNodeIds: string[] = [];

  const pushNode = (node: TaskNode) => {
    nodes.push(node);
    previousNodeIds.push(node.id);
  };

  for (const role of roles) {
    if (role === "CodebaseMapperAgent") {
      pushNode({
        id: `${sessionId}_map`,
        title: "Map codebase",
        description: "Identify stack, important files, and entry points.",
        assignedAgent: role,
        status: "pending",
        dependsOn: [],
        fileLocks: [],
        expectedOutput: "Project map",
        riskLevel: "low"
      });
      continue;
    }

    if (role === "ArchitectAgent") {
      pushNode({
        id: `${sessionId}_architecture`,
        title: "Design implementation",
        description: "Define the implementation shape and trim scope if needed.",
        assignedAgent: role,
        status: "pending",
        dependsOn: previousNodeIds.includes(`${sessionId}_map`) ? [`${sessionId}_map`] : [],
        fileLocks: [],
        expectedOutput: "Design notes",
        riskLevel: "low"
      });
      continue;
    }

    if (role === "FrontendAgent") {
      pushNode({
        id: `${sessionId}_frontend`,
        title: "Prepare frontend patch",
        description: "Propose the user-facing code changes.",
        assignedAgent: role,
        status: "pending",
        dependsOn: previousNodeIds.includes(`${sessionId}_architecture`) ? [`${sessionId}_architecture`] : [],
        fileLocks: frontendFiles.length ? frontendFiles : defaultFrontendLocks(productBrief.goal),
        expectedOutput: "Frontend patch proposal",
        riskLevel: productBrief.goal.toLowerCase().includes("game") ? "high" : "medium"
      });
      continue;
    }

    if (role === "RustBackendAgent") {
      pushNode({
        id: `${sessionId}_backend`,
        title: "Prepare backend patch",
        description: "Propose the backend or Tauri changes.",
        assignedAgent: role,
        status: "pending",
        dependsOn: previousNodeIds.includes(`${sessionId}_architecture`) ? [`${sessionId}_architecture`] : [],
        fileLocks: backendFiles.length ? backendFiles : ["apps/desktop/src-tauri/src/lib.rs"],
        expectedOutput: "Backend patch proposal",
        riskLevel: "medium"
      });
      continue;
    }

    if (role === "ToolingTerminalAgent") {
      pushNode({
        id: `${sessionId}_tooling`,
        title: "Prepare validation and preview",
        description: "Suggest safe commands and preview steps.",
        assignedAgent: role,
        status: "pending",
        dependsOn: nodes
          .filter((node) => ["FrontendAgent", "RustBackendAgent"].includes(node.assignedAgent))
          .map((node) => node.id),
        fileLocks: [],
        expectedOutput: "Validation commands and preview recommendation",
        riskLevel: "low"
      });
      continue;
    }

    if (role === "TestAgent") {
      pushNode({
        id: `${sessionId}_tests`,
        title: "Plan tests",
        description: "Define a focused validation path for the generated work.",
        assignedAgent: role,
        status: "pending",
        dependsOn: previousNodeIds.includes(`${sessionId}_tooling`) ? [`${sessionId}_tooling`] : [],
        fileLocks: [],
        expectedOutput: "Test plan",
        riskLevel: "low"
      });
      continue;
    }

    if (role === "SecurityAgent") {
      pushNode({
        id: `${sessionId}_security`,
        title: "Security review",
        description: "Review command and patch safety before finalization.",
        assignedAgent: role,
        status: "pending",
        dependsOn: previousNodeIds.includes(`${sessionId}_tests`) ? [`${sessionId}_tests`] : [],
        fileLocks: [],
        expectedOutput: "Security review",
        riskLevel: "medium"
      });
      continue;
    }

    if (role === "ReviewerAgent") {
      pushNode({
        id: `${sessionId}_review`,
        title: "Final review",
        description: "Check consistency, maintainability, and merge readiness.",
        assignedAgent: role,
        status: "pending",
        dependsOn: nodes.length ? [nodes[nodes.length - 1]!.id] : [],
        fileLocks: [],
        expectedOutput: "Reviewer summary",
        riskLevel: "low"
      });
    }
  }

  return nodes;
}

function defaultFrontendLocks(goal: string) {
  const normalized = goal.toLowerCase();
  if (normalized.includes("html") && normalized.includes("css") && normalized.includes("js")) {
    return ["index.html", "styles.css", "main.js"];
  }
  return ["apps/desktop/src/app/App.tsx"];
}

function describeConcerns(input: {
  needsFrontend: boolean;
  needsBackend: boolean;
  needsTests: boolean;
  isGame: boolean;
}) {
  const concerns = [
    input.isGame ? "rendering and interaction" : undefined,
    input.needsFrontend ? "frontend work" : undefined,
    input.needsBackend ? "backend work" : undefined,
    input.needsTests ? "validation" : undefined
  ].filter(Boolean);
  return concerns.join(", ");
}
