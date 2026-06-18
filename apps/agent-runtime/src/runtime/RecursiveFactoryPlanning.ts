import { randomUUID } from "node:crypto";
import type {
  BranchOrchestratorRecord,
  BranchScopeConflict,
  HierarchicalRecursiveGraph,
  ProductSpecification,
  ProjectMap,
  TechnicalPlan
} from "@hivo/protocol";

export function productSpecClarificationQuestions(prompt: string) {
  const normalized = prompt.trim();
  const questions: string[] = [];
  if (normalized.split(/\s+/).length < 8) {
    questions.push("What concrete user-visible outcome should this work deliver?");
  }
  if (!/\b(user|operator|admin|developer|customer|team|visitor|client)\b/i.test(normalized)) {
    questions.push("Who is the primary user or operator for this change?");
  }
  if (!/\b(accept|must|should|verify|test|done|success|when)\b/i.test(normalized)) {
    questions.push("What is the most important acceptance condition?");
  }
  return normalized.split(/\s+/).length < 5 ? questions.slice(0, 3) : [];
}

export function buildProductSpecification(input: {
  sessionId: string;
  prompt: string;
  revision?: number;
  feedback?: string;
}): ProductSpecification {
  const now = new Date().toISOString();
  const feedback = input.feedback?.trim();
  return {
    id: `product_spec_${randomUUID()}`,
    sessionId: input.sessionId,
    revision: input.revision ?? 1,
    status: "proposed",
    userGoal: input.prompt.trim(),
    clarifiedAssumptions: [
      "Existing behavior outside the requested scope should remain unchanged.",
      "All code execution remains blocked until a later execution layer is explicitly authorized.",
      ...(feedback ? [`Revision feedback: ${feedback}`] : [])
    ],
    targetUsers: inferTargetUsers(input.prompt),
    expectedBehavior: [
      `Deliver the requested outcome: ${compact(input.prompt)}`,
      "Expose approval state and planning artifacts clearly before any implementation begins.",
      "Keep execution, patch creation, and command requests unavailable during this planning-only layer."
    ],
    acceptanceCriteria: [
      "The approved Product Specification describes the intended outcome and boundaries.",
      "A Technical Plan is generated only after Product Specification approval.",
      "No task execution, patch proposal, file mutation, or command request occurs before both approvals."
    ],
    nonGoals: [
      "Recursive executor implementation.",
      "Automatic patch application or command execution.",
      "Unapproved expansion beyond the agreed Product Specification."
    ],
    openQuestions: feedback ? [`Confirm that revision ${input.revision ?? 1} addresses: ${feedback}`] : [],
    risks: [
      "Ambiguous requirements could produce an incorrect implementation plan.",
      "Likely file scope may change after deeper repository inspection.",
      "Execution must remain impossible until both approval gates have passed."
    ],
    createdAt: now,
    updatedAt: now
  };
}

export function buildTechnicalPlan(input: {
  sessionId: string;
  productSpec: ProductSpecification;
  projectMap: ProjectMap;
  revision?: number;
  feedback?: string;
}): TechnicalPlan {
  const now = new Date().toISOString();
  const likelyFiles = input.projectMap.importantFiles.slice(0, 12);
  const areas = inferProjectAreas(likelyFiles, input.projectMap.stack);
  const nodes = areas.map((area, index) => ({
    id: `${input.sessionId}_planned_${index + 1}`,
    title: `Plan ${area}`,
    description: `Prepare a bounded implementation group for ${area}.`,
    assignedAgent: "Unassigned",
    status: "pending" as const,
    dependsOn: index === 0 ? [] : [`${input.sessionId}_planned_${index}`],
    fileLocks: likelyFiles.filter((file) => file.toLowerCase().includes(area.toLowerCase().split(" ")[0] ?? "")),
    expectedOutput: `${area} patch group proposal`,
    riskLevel: "medium" as const
  }));
  return {
    id: `technical_plan_${randomUUID()}`,
    sessionId: input.sessionId,
    revision: input.revision ?? 1,
    status: "proposed",
    summary: `Planning-only implementation strategy for: ${compact(input.productSpec.userGoal)}`,
    architectureImpact: areas.length > 2 ? "Cross-module change requiring staged patch groups." : "Bounded feature-level change.",
    affectedAreas: areas,
    projectAreasAffected: areas,
    filesLikelyTouched: likelyFiles,
    implementationStrategy: [
      "Inspect and confirm the affected modules before writing.",
      "Implement in bounded patch groups that map to the approved task graph.",
      "Review each patch group and validate it before integration.",
      ...(input.feedback ? [`Apply requested plan revision: ${input.feedback.trim()}`] : [])
    ],
    testStrategy: input.projectMap.testCommands.length ? input.projectMap.testCommands : ["Run the repository's focused tests", "Run typecheck/build where available"],
    validationCommands: input.projectMap.testCommands.length ? input.projectMap.testCommands : ["git diff --check"],
    expectedPatchGroups: areas.map((area) => `${area}: focused implementation and tests`),
    rollbackNotes: [
      "Keep patch groups independently reviewable and revertible.",
      "Stop and request renewed approval if implementation scope exceeds the approved plan."
    ],
    riskLevel: areas.length > 3 ? "high" : "medium",
    taskGraph: {
      sessionId: input.sessionId,
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }))
    },
    createdAt: now,
    updatedAt: now
  };
}

export function formatProductSpecification(spec: ProductSpecification) {
  return formatArtifact("Product Specification", spec.revision, [
    ["User goal", [spec.userGoal]],
    ["Clarified assumptions", spec.clarifiedAssumptions],
    ["Target users", spec.targetUsers],
    ["Expected behavior", spec.expectedBehavior],
    ["Acceptance criteria", spec.acceptanceCriteria],
    ["Non-goals", spec.nonGoals],
    ["Open questions", spec.openQuestions],
    ["Risks", spec.risks]
  ]);
}

export function formatTechnicalPlan(plan: TechnicalPlan) {
  return formatArtifact("Technical Plan", plan.revision ?? 1, [
    ["Summary", [plan.summary]],
    ["Project areas affected", plan.projectAreasAffected ?? plan.affectedAreas],
    ["Files/modules likely touched", plan.filesLikelyTouched ?? []],
    ["Implementation strategy", plan.implementationStrategy ?? []],
    ["Test strategy", plan.testStrategy],
    ["Risk assessment", [plan.riskLevel]],
    ["Proposed task graph", plan.taskGraph.nodes.map((node) => node.title)],
    ["Expected patch groups", plan.expectedPatchGroups ?? []],
    ["Validation commands", plan.validationCommands ?? []],
    ["Rollback notes", plan.rollbackNotes ?? []]
  ]);
}

export function buildHierarchicalRecursiveGraph(input: {
  sessionId: string;
  productSpec: ProductSpecification;
  technicalPlan: TechnicalPlan;
}): HierarchicalRecursiveGraph {
  const now = new Date().toISOString();
  const graphId = `recursive_graph_${randomUUID()}`;
  const branches = buildBranchRecords({
    sessionId: input.sessionId,
    graphId,
    productSpec: input.productSpec,
    technicalPlan: input.technicalPlan,
    createdAt: now
  });
  const dependencies = deriveBranchDependencies(branches, input.technicalPlan);
  const conflicts = analyzeBranchScopes(input.sessionId, branches, dependencies, now);
  const blockingCodes = [...new Set(conflicts.filter((conflict) => conflict.severity === "blocking").map((conflict) => conflict.code))];
  const status = blockingCodes.length ? "blocked" : "ready";
  return {
    id: graphId,
    sessionId: input.sessionId,
    technicalPlanId: input.technicalPlan.id ?? "technical_plan_unknown",
    status,
    rootGoal: input.productSpec.userGoal,
    rootNode: {
      id: `${graphId}_root`,
      title: "Recursive Factory Root Goal",
      objective: input.productSpec.userGoal
    },
    branches,
    dependencies,
    conflicts,
    readiness: {
      status,
      summary: status === "ready"
        ? "Recursive graph is planned and ready for a future execution layer. Execution has not started."
        : `Recursive graph is blocked by ${blockingCodes.join(", ")}.`,
      blockedReasons: blockingCodes,
      checkedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
}

export function formatRecursiveGraph(graph: HierarchicalRecursiveGraph) {
  return [
    `## Hierarchical Recursive Graph (${graph.status})`,
    "",
    "**Root goal**",
    `- ${graph.rootGoal}`,
    "",
    "**Branches**",
    ...graph.branches.map((branch) => `- ${branch.title}: ${branch.objective} | files: ${branch.fileScopes.join(", ") || "none"} | status: ${branch.status}`),
    "",
    "**Dependencies**",
    ...(graph.dependencies.length
      ? graph.dependencies.map((dependency) => `- ${dependency.from} -> ${dependency.to}: ${dependency.reason}`)
      : ["- No branch dependencies identified."]),
    "",
    "**Readiness**",
    `- ${graph.readiness.summary}`,
    "",
    "**Conflicts**",
    ...(graph.conflicts.length
      ? graph.conflicts.map((conflict) => `- ${conflict.code}: ${conflict.reason}`)
      : ["- No branch scope conflicts detected."]),
    "",
    "Execution has not started. This is a planned recursive graph."
  ].join("\n");
}

function formatArtifact(title: string, revision: number, sections: Array<[string, string[]]>) {
  return [
    `## ${title} (revision ${revision})`,
    ...sections.flatMap(([heading, values]) => [
      "",
      `**${heading}**`,
      ...(values.length ? values.map((value) => `- ${value}`) : ["- None identified."])
    ]),
    "",
    "Approval is required before the next phase. No execution has started."
  ].join("\n");
}

function buildBranchRecords(input: {
  sessionId: string;
  graphId: string;
  productSpec: ProductSpecification;
  technicalPlan: TechnicalPlan;
  createdAt: string;
}): BranchOrchestratorRecord[] {
  const nodes = input.technicalPlan.taskGraph.nodes.length
    ? input.technicalPlan.taskGraph.nodes
    : (input.technicalPlan.projectAreasAffected ?? input.technicalPlan.affectedAreas).map((area, index) => ({
        id: `${input.sessionId}_area_${index + 1}`,
        title: area,
        description: `Plan branch for ${area}.`,
        assignedAgent: ownerRoleForArea(area),
        status: "pending" as const,
        dependsOn: index === 0 ? [] : [`${input.sessionId}_area_${index}`],
        fileLocks: filesForArea(area, input.technicalPlan.filesLikelyTouched ?? []),
        expectedOutput: `${area} branch output`,
        riskLevel: input.technicalPlan.riskLevel
      }));
  const graphNodes = nodes.length >= 2
    ? nodes
    : [
        ...nodes,
        {
          id: `${input.sessionId}_integration_validation`,
          title: "Integration and Validation",
          description: "Plan final integration checks and validation evidence for the approved Technical Plan.",
          assignedAgent: "Tester/Validator",
          status: "pending" as const,
          dependsOn: nodes[0]?.id ? [nodes[0].id] : [],
          fileLocks: [],
          expectedOutput: "Integration validation branch output",
          riskLevel: input.technicalPlan.riskLevel
        }
      ];
  return graphNodes.map((node, index) => {
    const title = normalizeBranchTitle(node.title || `Branch ${index + 1}`);
    const fileScopes = uniqueStrings(
      node.fileLocks.length
        ? node.fileLocks
        : filesForArea(title, input.technicalPlan.filesLikelyTouched ?? [])
    );
    const semanticScopes = uniqueStrings([
      title,
      ...(input.technicalPlan.projectAreasAffected ?? input.technicalPlan.affectedAreas).filter((area) =>
        title.toLowerCase().includes(area.toLowerCase()) || area.toLowerCase().includes(title.toLowerCase().replace(/^plan\s+/, ""))
      )
    ]);
    const branchId = `branch_${node.id.replace(/[^a-z0-9_:-]/gi, "_")}`;
    return {
      branchId,
      sessionId: input.sessionId,
      graphId: input.graphId,
      title,
      objective: node.description || `Prepare planned work for ${title}.`,
      ownerRole: node.assignedAgent && node.assignedAgent !== "Unassigned" ? node.assignedAgent : ownerRoleForArea(title),
      inputContextRequirements: [
        "Approved Product Specification",
        "Approved Technical Plan",
        ...fileScopes.map((file) => `Workspace context for ${file}`)
      ],
      fileScopes,
      semanticScopes: semanticScopes.length ? semanticScopes : [title],
      lockScopes: fileScopes.map((file) => `file:${file}`),
      dependencies: node.dependsOn.map((dependency) => `branch_${dependency.replace(/[^a-z0-9_:-]/gi, "_")}`),
      expectedOutputs: [
        node.expectedOutput || `${title} implementation plan`,
        "Patch proposal draft for a future execution layer",
        "Validation evidence plan"
      ],
      reviewerRequirements: ["Review scope, dependency ordering, and patch boundaries before execution."],
      testerRequirements: input.technicalPlan.validationCommands ?? input.technicalPlan.testStrategy,
      status: "planned",
      risks: [
        `${node.riskLevel} branch risk`,
        ...input.productSpec.risks.slice(0, 2)
      ],
      validationStrategy: input.technicalPlan.validationCommands ?? input.technicalPlan.testStrategy,
      expectedIntegrationPoints: expectedIntegrationPoints(title, input.technicalPlan),
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    };
  });
}

function deriveBranchDependencies(branches: BranchOrchestratorRecord[], plan: TechnicalPlan) {
  const idByNode = new Map<string, string>();
  for (const node of plan.taskGraph.nodes) {
    idByNode.set(node.id, `branch_${node.id.replace(/[^a-z0-9_:-]/gi, "_")}`);
  }
  const dependencies = plan.taskGraph.edges
    .map((edge) => {
      const from = idByNode.get(edge.from);
      const to = idByNode.get(edge.to);
      return from && to ? { from, to, reason: "Technical Plan task dependency." } : undefined;
    })
    .filter(Boolean) as Array<{ from: string; to: string; reason: string }>;
  for (const branch of branches) {
    for (const dependency of branch.dependencies) {
      if (branches.some((candidate) => candidate.branchId === dependency) && !dependencies.some((edge) => edge.from === dependency && edge.to === branch.branchId)) {
        dependencies.push({ from: dependency, to: branch.branchId, reason: "Branch declared dependency." });
      }
    }
  }
  return dependencies;
}

function analyzeBranchScopes(
  sessionId: string,
  branches: BranchOrchestratorRecord[],
  dependencies: Array<{ from: string; to: string; reason: string }>,
  createdAt: string
) {
  const conflicts: BranchScopeConflict[] = [];
  for (const branch of branches) {
    const missingFileScope = branch.fileScopes.length === 0;
    if (missingFileScope) {
      conflicts.push({
        id: `branch_conflict_${randomUUID()}`,
        sessionId,
        branchIds: [branch.branchId],
        code: "missing_file_scope",
        severity: "blocking",
        reason: `${branch.title} has no file scope, so it cannot be prepared for safe execution.`,
        requiresOrdering: false,
        createdAt
      });
    }
    const unresolved = branch.dependencies.filter((dependency) => !branches.some((candidate) => candidate.branchId === dependency));
    for (const dependency of unresolved) {
      conflicts.push({
        id: `branch_conflict_${randomUUID()}`,
        sessionId,
        branchIds: [branch.branchId, dependency],
        code: "unresolved_dependency",
        severity: "blocking",
        reason: `${branch.title} depends on missing branch ${dependency}.`,
        requiresOrdering: true,
        createdAt
      });
    }
  }
  for (let leftIndex = 0; leftIndex < branches.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < branches.length; rightIndex += 1) {
      const left = branches[leftIndex]!;
      const right = branches[rightIndex]!;
      const overlappingFiles = left.fileScopes.filter((file) => right.fileScopes.includes(file));
      for (const filePath of overlappingFiles) {
        const ordered = dependencies.some((dependency) =>
          (dependency.from === left.branchId && dependency.to === right.branchId)
          || (dependency.from === right.branchId && dependency.to === left.branchId)
        );
        conflicts.push({
          id: `branch_conflict_${randomUUID()}`,
          sessionId,
          branchIds: [left.branchId, right.branchId],
          filePath,
          semanticScope: `file:${filePath}`,
          code: ordered ? "branch_scope_conflict" : "unsafe_parallel_write_scope",
          severity: ordered ? "warning" : "blocking",
          reason: ordered
            ? `${left.title} and ${right.title} both touch ${filePath}; dependency ordering makes this a planned shared scope.`
            : `${left.title} and ${right.title} both touch ${filePath} without ordering or a shared lock scope.`,
          requiresOrdering: true,
          sharedLockScope: ordered ? `file:${filePath}` : undefined,
          createdAt
        });
      }
    }
  }
  return conflicts;
}

function normalizeBranchTitle(title: string) {
  return title.replace(/^Plan\s+/i, "").trim() || title;
}

function filesForArea(area: string, files: string[]) {
  const normalized = area.toLowerCase();
  const matches = files.filter((file) => {
    const lower = file.toLowerCase();
    if (/user interface|frontend|ui|component/.test(normalized)) return /app|component|ui|frontend|css|html|tsx|jsx/.test(lower);
    if (/runtime|backend|server|api/.test(normalized)) return /server|api|runtime|backend|src-tauri|rust|\.rs/.test(lower);
    if (/test|smoke|validation/.test(normalized)) return /test|spec|smoke|vitest|jest/.test(lower);
    if (/protocol|type|schema/.test(normalized)) return /protocol|schema|type|model/.test(lower);
    return lower.includes(normalized.split(/\s+/)[0] ?? "");
  });
  return matches.length ? matches.slice(0, 5) : files.slice(0, 1);
}

function ownerRoleForArea(area: string) {
  const normalized = area.toLowerCase();
  if (/user interface|frontend|ui|component/.test(normalized)) return "Frontend Branch Orchestrator";
  if (/runtime|backend|server|api/.test(normalized)) return "Runtime Branch Orchestrator";
  if (/test|smoke|validation/.test(normalized)) return "Validation Branch Orchestrator";
  if (/protocol|type|schema/.test(normalized)) return "Protocol Branch Orchestrator";
  return "Feature Branch Orchestrator";
}

function expectedIntegrationPoints(title: string, plan: TechnicalPlan) {
  const areas = plan.projectAreasAffected ?? plan.affectedAreas;
  return uniqueStrings([
    `${title} handoff into final integration review`,
    ...areas.filter((area) => area !== title).slice(0, 3).map((area) => `${title} <-> ${area}`)
  ]);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function inferTargetUsers(prompt: string) {
  const matches = ["developers", "operators", "admins", "customers", "users"].filter((candidate) =>
    prompt.toLowerCase().includes(candidate.slice(0, -1))
  );
  return matches.length ? matches : ["Project users", "Repository maintainers"];
}

function inferProjectAreas(files: string[], stack: string[]) {
  const areas = [
    files.some((file) => /app|component|ui|frontend|css/i.test(file)) ? "User interface" : undefined,
    files.some((file) => /server|api|runtime|backend|src-tauri/i.test(file)) ? "Runtime and backend" : undefined,
    files.some((file) => /test|spec|smoke/i.test(file)) ? "Tests and smoke coverage" : undefined,
    files.some((file) => /protocol|schema|types/i.test(file)) ? "Protocol and shared types" : undefined,
    stack.length ? `${stack.slice(0, 3).join(", ")} project modules` : "Project modules"
  ].filter(Boolean) as string[];
  return [...new Set(areas)];
}

function compact(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}
