import type {
  AgentRoleReason,
  AgentAssignmentPlan,
  BusinessBrief,
  DelegationDecision,
  ProductBrief,
  ProjectMap,
  TaskGraph,
  TaskNode,
  TechnicalPlan,
  WorkOrder
} from "@hivo/protocol";
import { randomUUID } from "node:crypto";
import { estimateComplexity, parsePromptDirective } from "../runtime/delegation.js";

type OrchestratorResult = {
  technicalPlan: TechnicalPlan;
  delegationDecision: DelegationDecision;
  workOrders: WorkOrder[];
  assignmentPlan: AgentAssignmentPlan;
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
    const workOrders = createWorkOrders(input.sessionId, input.productBrief, input.businessBrief, nodes);
    const assignmentPlan = createAssignmentPlan(input.sessionId, input.productBrief.goal, workOrders);
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
      assignmentPlan,
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
      },
      workOrders
    };
  }
}

function createAssignmentPlan(sessionId: string, goal: string, workOrders: WorkOrder[]): AgentAssignmentPlan {
  const now = new Date().toISOString();
  return {
    id: `assignment_${randomUUID()}`,
    sessionId,
    trustProfile: "strict_gated",
    rationale: `Generated ${workOrders.length} worker spec(s) from the request keywords and project shape.`,
    createdAt: now,
    workerSpecs: workOrders.map((order, index) => {
      const roleTitle = dynamicRoleTitle(goal, order.dynamicRole, index);
      return {
        id: `worker_spec_${randomUUID()}`,
        sessionId,
        roleTitle,
        persona: `Runtime-generated ${roleTitle} focused on bounded artifact handoff.`,
        objective: order.objective,
        tasks: [order.objective],
        acceptanceCriteria: order.acceptanceCriteria,
        requiredArtifacts: order.requiredArtifacts,
        targetFiles: order.requiredArtifacts,
        dependsOn: order.dependsOn,
        capabilityGrant: {
          id: `grant_${randomUUID()}`,
          workerId: order.id,
          sessionId,
          allowedPaths: order.requiredArtifacts,
          allowedTools: order.allowedTools,
          allowedCommandRisks: ["safe"],
          canProposePatches: order.allowedTools.includes("patch.propose"),
          canRequestCommands: order.allowedTools.includes("command.request_run"),
          allowNetwork: false,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
        }
      };
    })
  };
}

function dynamicRoleTitle(goal: string, fallback: string, index: number) {
  const normalized = goal.toLowerCase();
  const candidates = [
    normalized.includes("game") ? "Gameplay Systems Worker" : undefined,
    normalized.includes("3d") || normalized.includes("three") ? "Rendering Worker" : undefined,
    normalized.includes("ui") || normalized.includes("frontend") || normalized.includes("page") ? "Interface Worker" : undefined,
    normalized.includes("rust") || normalized.includes("tauri") || normalized.includes("backend") ? "Runtime Boundary Worker" : undefined,
    normalized.includes("test") || normalized.includes("verify") ? "Validation Worker" : undefined,
    normalized.includes("security") || normalized.includes("auth") ? "Safety Review Worker" : undefined
  ].filter(Boolean) as string[];
  return candidates[index % Math.max(candidates.length, 1)] ?? fallback;
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

  if (isGame && isStaticUiProject) {
    addRole("GameLogicAgent", "Own playable rules: movement, food, scoring, collision, and reset.");
    addRole("ThreeJsRenderingAgent", "Own Three.js scene, camera, grid, meshes, lighting, and animation.");
    addRole("FrontendIntegrationAgent", "Own HTML/CSS/JS integration, HUD, controls, and preview readiness.");
  } else if (projectMap.importantFiles.length && !isStaticUiProject) {
    addRole("CodebaseMapperAgent", "Map the existing codebase before proposing targeted changes.");
  }
  if (!isGame && (needsFrontend || needsBackend)) {
    addRole("ArchitectAgent", "Shape the implementation before specialist patches are proposed.");
  }
  if (!isGame && (needsFrontend || isStaticUiProject)) {
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
  if (!directive.requestedAgentCount) {
    addRole("ToolingTerminalAgent", "Prepare safe validation and preview/run guidance.");
  }
  if ((needsTests || roles.length >= 3) && !directive.requestedAgentCount) {
    addRole("TestAgent", "Plan validation for the generated change surface.");
  }
  if (needsSecurity && !directive.requestedAgentCount) {
    addRole("SecurityAgent", "Review safety-sensitive work before completion.");
  }
  if (!directive.requestedAgentCount || roles.length < directive.requestedAgentCount) {
    addRole("ReviewerAgent", "Provide the final implementation sanity check.");
  }

  if (directive.requestedAgentCount && directive.requestedAgentCount > 0) {
    const trimmedRoles =
      isGame && isStaticUiProject
        ? trimGameRoles(roles, directive.requestedAgentCount)
        : roles.slice(0, directive.requestedAgentCount);
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

function trimGameRoles(roles: string[], requestedCount: number) {
  if (requestedCount <= 1) {
    return roles.includes("FrontendIntegrationAgent") ? ["FrontendIntegrationAgent"] : roles.slice(0, 1);
  }
  if (requestedCount === 2) {
    return ["GameLogicAgent", "FrontendIntegrationAgent"].filter((role) => roles.includes(role));
  }
  return roles.slice(0, requestedCount);
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
    if (role === "GameLogicAgent") {
      pushNode({
        id: `${sessionId}_game_logic`,
        title: "Build gameplay logic",
        description: "Implement snake movement, food, scoring, collision, and restart behavior.",
        assignedAgent: role,
        status: "pending",
        dependsOn: [],
        fileLocks: ["main.js"],
        expectedOutput: "Playable game logic patch contribution",
        riskLevel: "medium"
      });
      continue;
    }

    if (role === "ThreeJsRenderingAgent") {
      pushNode({
        id: `${sessionId}_three_rendering`,
        title: "Build Three.js rendering",
        description: "Implement scene, camera, lighting, grid, snake meshes, food mesh, and animation loop.",
        assignedAgent: role,
        status: "pending",
        dependsOn: [],
        fileLocks: ["main.js"],
        expectedOutput: "Three.js rendering patch contribution",
        riskLevel: "medium"
      });
      continue;
    }

    if (role === "FrontendIntegrationAgent") {
      pushNode({
        id: `${sessionId}_frontend_integration`,
        title: "Integrate static app",
        description: "Create HTML/CSS/JS shell, HUD, controls, and preview-ready files.",
        assignedAgent: role,
        status: "pending",
        dependsOn: [
          `${sessionId}_game_logic`,
          `${sessionId}_three_rendering`
        ].filter((dependency) => previousNodeIds.includes(dependency)),
        fileLocks: ["index.html", "styles.css", "main.js"],
        expectedOutput: "Integrated playable static app patch",
        riskLevel: "medium"
      });
      continue;
    }

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

function createWorkOrders(
  sessionId: string,
  productBrief: ProductBrief,
  businessBrief: BusinessBrief,
  nodes: TaskNode[]
): WorkOrder[] {
  const criteria = [...new Set([...productBrief.successCriteria, ...businessBrief.acceptanceCriteria])];
  return nodes.map((node) => ({
    id: `work_${node.id}`,
    sessionId,
    agentName: node.assignedAgent,
    dynamicRole: node.assignedAgent.replace(/Agent$/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
    objective: node.description,
    acceptanceCriteria: criteria,
    requiredArtifacts: node.fileLocks,
    allowedTools: ["workspace.read_file", "workspace.search_code", "patch.propose", "command.request_run"],
    dependsOn: node.dependsOn.map((dependency) => `work_${dependency}`)
  }));
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
