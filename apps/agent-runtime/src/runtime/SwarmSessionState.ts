import type {
  AgentRuntimeSession,
  AgentRuntimeSwarmMessage,
  AgentRuntimeSwarmNode,
  AgentRuntimeSwarmNodeKind,
  AgentRuntimeSwarmNodeStatus,
  AgentRuntimeSwarmState
} from "@hivo/protocol";

const MAX_SUPPORTED_LOGICAL_AGENTS = 300;
const STATUS_KEYS: AgentRuntimeSwarmNodeStatus[] = ["idle", "queued", "running", "completed", "blocked", "failed"];
const AGENT_NODE_KINDS = new Set<AgentRuntimeSwarmNodeKind>(["coordinator", "worker", "specialist", "aggregator"]);
const SYNTHETIC_NODE_KINDS = new Set<AgentRuntimeSwarmNodeKind>(["group", "work_item", "gate"]);

export function buildAgentRuntimeSwarmState(
  session: AgentRuntimeSession,
  messages: AgentRuntimeSwarmMessage[] = session.swarmState?.messages ?? []
): AgentRuntimeSwarmState {
  const now = new Date().toISOString();
  const rootId = `session:${session.id}:root`;
  const nodeMap = new Map<string, AgentRuntimeSwarmNode>();
  const taskById = new Map(session.tasks.map((task) => [task.id, task]));
  const linkedWorkItemRefs = new Set<string>();

  const addNode = (node: AgentRuntimeSwarmNode) => {
    const existing = nodeMap.get(node.id);
    nodeMap.set(node.id, existing ? mergeNode(existing, node) : node);
  };

  const ensureGroup = (key: string, name: string, role: string, objective: string, updatedAt = session.updatedAt) => {
    const id = `group:${session.id}:${sanitizeId(key)}`;
    addNode({
      id,
      parentId: rootId,
      kind: "group",
      name,
      role,
      status: "idle",
      objective,
      currentAction: "Collecting runtime records.",
      summary: "Runtime projection group.",
      ownedPaths: [],
      targetFiles: [],
      changedFiles: [],
      artifactRefs: [],
      workItemRefs: [],
      evidenceRefs: [],
      riskRefs: [],
      updatedAt
    });
    return id;
  };

  const ensureRoleGroup = (role: string, updatedAt?: string) => ensureGroup(
    `role:${role}`,
    `${prettyRole(role)} group`,
    "Agent group",
    `Agents selected automatically for ${prettyRole(role)} work.`,
    updatedAt
  );

  const addWorkItemNode = (input: {
    parentId: string;
    ref: string;
    fallbackStatus: AgentRuntimeSwarmNodeStatus;
    fallbackRole?: string;
    updatedAt?: string;
  }) => {
    if (!input.ref) return;
    linkedWorkItemRefs.add(input.ref);
    const task = taskById.get(input.ref);
    const status = task ? mapTaskStatus(task.status) : input.fallbackStatus;
    addNode({
      id: `work-item:${sanitizeId(input.parentId)}:${sanitizeId(input.ref)}`,
      parentId: input.parentId,
      kind: "work_item",
      name: task?.title ?? input.ref,
      role: task?.agentRole ?? input.fallbackRole ?? "Work item",
      status,
      objective: task ? `Run task: ${task.title}` : `Runtime work item ${input.ref}.`,
      currentAction: STATUS_LABELS[status],
      summary: task ? `Task status: ${task.status}.` : "Referenced by an agent runtime record.",
      ownedPaths: [],
      targetFiles: [],
      changedFiles: [],
      artifactRefs: [],
      workItemRefs: [input.ref],
      evidenceRefs: [],
      riskRefs: status === "blocked" || status === "failed" ? [input.ref] : [],
      updatedAt: task?.createdAt ?? input.updatedAt ?? session.updatedAt
    });
  };

  addNode({
    id: rootId,
    kind: "root",
    name: session.agentName || "Hivo",
    role: "Coordinator",
    status: mapSessionStatus(session.status),
    objective: session.userPrompt,
    currentAction: session.runSummary?.summary ?? session.taskState?.phase ?? session.lifecycleStage,
    summary: session.runSummary?.summary,
    ownedPaths: [],
    targetFiles: [],
    changedFiles: [],
    artifactRefs: session.artifacts.map((artifact) => artifact.id),
    workItemRefs: session.tasks.map((task) => task.id),
    evidenceRefs: session.decisionLedger.flatMap((record) => record.evidenceRefs.map((ref) => ref.id ?? "")).filter(Boolean),
    riskRefs: [],
    updatedAt: session.updatedAt
  });

  for (const agent of session.orchestration?.agentRuns ?? []) {
    const role = agent.roleTitle ?? agent.role;
    const workItemRefs = uniqueStrings([agent.currentTask, extractCurrentWorkItemId(agent.artifactJson)]);
    const groupId = ensureRoleGroup(role, agent.completedAt ?? agent.startedAt ?? session.updatedAt);
    addNode({
      id: agent.id,
      parentId: groupId,
      kind: isSpecialistRole(role) ? "specialist" : "worker",
      name: agent.displayName ?? agent.agentName,
      role,
      status: mapAgentRunStatus(agent.status),
      objective: agent.objective ?? session.userPrompt,
      currentAction: agent.currentAction ?? agent.currentTask ?? agent.lastEvent,
      summary: agent.lastEvent,
      output: agent.integrationNotes?.join(" | "),
      ownedPaths: agent.ownedPaths ?? [],
      targetFiles: uniqueStrings([...(agent.ownedPaths ?? []), ...(agent.changedFiles ?? [])]),
      changedFiles: agent.changedFiles ?? [],
      artifactRefs: collectAgentArtifactRefs(agent.artifactJson),
      workItemRefs,
      evidenceRefs: uniqueStrings((agent.evidenceRefs ?? []).map((ref) => ref.id ?? `${ref.type}:${ref.reason ?? ref.note ?? ""}`)),
      riskRefs: uniqueStrings((agent.riskRefs ?? []).map((risk) => risk.id ?? risk.reason)),
      metrics: {
        tokenCount: agent.tokenCount,
        costUsd: agent.costUsd
      },
      updatedAt: agent.completedAt ?? agent.startedAt ?? session.updatedAt
    });
    for (const ref of workItemRefs) {
      addWorkItemNode({
        parentId: agent.id,
        ref,
        fallbackStatus: mapAgentRunStatus(agent.status),
        fallbackRole: role,
        updatedAt: agent.completedAt ?? agent.startedAt ?? session.updatedAt
      });
    }
  }

  for (const status of session.agentWorkStatuses ?? []) {
    const id = `work-status:${status.agentName}:${status.role}`;
    const groupId = ensureRoleGroup(status.role, status.updatedAt);
    addNode({
      id,
      parentId: groupId,
      kind: isSpecialistRole(status.role) ? "specialist" : "worker",
      name: status.agentName,
      role: status.role,
      status: mapProgressStatus(status.status),
      objective: status.objective,
      currentAction: status.summary ?? status.taskTitle,
      summary: status.summary,
      ownedPaths: [],
      targetFiles: status.targetFiles,
      changedFiles: status.targetFiles,
      artifactRefs: [],
      workItemRefs: [status.taskTitle],
      evidenceRefs: [],
      riskRefs: [],
      updatedAt: status.updatedAt
    });
    addWorkItemNode({
      parentId: id,
      ref: status.taskTitle,
      fallbackStatus: mapProgressStatus(status.status),
      fallbackRole: status.role,
      updatedAt: status.updatedAt
    });
  }

  const recursiveGroupId = ensureGroup(
    "recursive-factory",
    "Recursive factory",
    "Branch group",
    "Recursive branch coordinators and nested subtasks."
  );
  for (const branch of session.recursiveFactory?.branchOrchestrators ?? []) {
    const branchId = `recursive-branch:${branch.branchId}`;
    addNode({
      id: branchId,
      parentId: recursiveGroupId,
      kind: "coordinator",
      name: branch.title,
      role: branch.ownerRole,
      status: mapRecursiveStatus(branch.status),
      objective: branch.objective,
      currentAction: branch.validationStrategy.join(" | "),
      summary: branch.risks.join(" | "),
      ownedPaths: branch.fileScopes,
      targetFiles: branch.fileScopes,
      changedFiles: [],
      artifactRefs: [],
      workItemRefs: [branch.branchId],
      evidenceRefs: branch.expectedOutputs,
      riskRefs: branch.risks,
      updatedAt: branch.updatedAt
    });
  }

  for (const execution of session.recursiveFactory?.branchExecutions ?? []) {
    const branchId = `recursive-branch:${execution.branchId}`;
    addNode({
      id: branchId,
      parentId: recursiveGroupId,
      kind: "coordinator",
      name: execution.title,
      role: execution.schedulerDecision.writeBranch ? "Recursive Write Branch" : "Recursive Read Branch",
      status: mapRecursiveStatus(execution.status),
      objective: execution.executionContext.branchObjective,
      currentAction: execution.blockedReason ?? execution.conflictReason ?? execution.validationStatus,
      summary: execution.validationPlan.join(" | "),
      ownedPaths: execution.executionContext.fileScopes,
      targetFiles: execution.executionContext.fileScopes,
      changedFiles: execution.plannedPatch?.targetFile ? [execution.plannedPatch.targetFile] : [],
      artifactRefs: [execution.proposedPatchId ?? ""].filter(Boolean),
      workItemRefs: [execution.branchId],
      evidenceRefs: execution.executionContext.evidenceContextPack,
      riskRefs: [execution.blockedReason ?? "", execution.conflictReason ?? ""].filter(Boolean),
      updatedAt: execution.updatedAt
    });
    for (const subtask of execution.nestedSubtasks ?? []) {
      addNode({
        id: `recursive-subtask:${subtask.subtaskId}`,
        parentId: branchId,
        kind: "worker",
        name: subtask.subtaskId,
        role: subtask.writeSubtask ? "Nested Write Subtask" : "Nested Read Subtask",
        status: mapRecursiveStatus(subtask.status),
        objective: subtask.objective,
        currentAction: subtask.blockedReason ?? subtask.validationStatus,
        summary: subtask.expectedOutput,
        ownedPaths: subtask.fileScopes,
        targetFiles: subtask.fileScopes,
        changedFiles: subtask.plannedPatch?.targetFile ? [subtask.plannedPatch.targetFile] : [],
        artifactRefs: [subtask.proposedPatchId ?? ""].filter(Boolean),
        workItemRefs: [subtask.subtaskId],
        evidenceRefs: [],
        riskRefs: [subtask.blockedReason ?? ""].filter(Boolean),
        updatedAt: subtask.updatedAt
      });
    }
  }

  if (session.runSummary?.gates.length) {
    const gateGroupId = ensureGroup("runtime-gates", "Runtime gates", "Gate group", "Review, validation, and truth gates for this run.", session.runSummary.createdAt);
    session.runSummary.gates.forEach((gate, index) => {
      const status = mapGateStatus(gate.status);
      addNode({
        id: `gate:${session.id}:${index + 1}:${sanitizeId(gate.name)}`,
        parentId: gateGroupId,
        kind: "gate",
        name: gate.name,
        role: "Run gate",
        status,
        objective: `Verify ${gate.name}.`,
        currentAction: STATUS_LABELS[status],
        summary: gate.notes.join(" | ") || `Gate ${gate.status}.`,
        ownedPaths: [],
        targetFiles: [],
        changedFiles: [],
        artifactRefs: [],
        workItemRefs: [],
        evidenceRefs: gate.notes,
        riskRefs: gate.status === "passed" ? [] : gate.notes,
        updatedAt: session.runSummary?.createdAt ?? session.updatedAt
      });
    });
  }

  const unlinkedTasks = session.tasks.filter((task) => !linkedWorkItemRefs.has(task.id));
  if (unlinkedTasks.length) {
    const workGroupId = ensureGroup("unassigned-work-items", "Unassigned work", "Work item group", "Runtime tasks without a currently reported owning agent.");
    for (const task of unlinkedTasks) {
      addWorkItemNode({
        parentId: workGroupId,
        ref: task.id,
        fallbackStatus: mapTaskStatus(task.status),
        fallbackRole: task.agentRole,
        updatedAt: task.createdAt
      });
    }
  }

  finalizeSyntheticNodes(nodeMap, rootId);

  const nodes = [...nodeMap.values()]
    .filter((node) => node.kind !== "group" || hasChildren(node.id, nodeMap))
    .sort((left, right) => {
      if (left.id === rootId) return -1;
      if (right.id === rootId) return 1;
      if ((left.parentId ?? "") !== (right.parentId ?? "")) return (left.parentId ?? "").localeCompare(right.parentId ?? "");
      return kindOrder(left.kind) - kindOrder(right.kind)
        || left.updatedAt.localeCompare(right.updatedAt)
        || left.role.localeCompare(right.role)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id);
    });
  const statusCounts = emptyStatusCounts();
  for (const node of nodes) {
    statusCounts[node.status] += 1;
  }
  const agentNodes = nodes.filter(isLogicalAgentNode);
  const activeAgentCount = agentNodes.filter((node) => node.status === "queued" || node.status === "running").length;
  const source = inferSwarmSource(session, nodes);
  const swarmRunId = inferSwarmRunId(session);
  const roleCounts = countRoles(agentNodes);
  const effectiveTotal = Math.max(0, Number(session.delegationDecision?.selectedAgentCount ?? agentNodes.length));

  return {
    schemaVersion: 1,
    rootId,
    sessionId: session.id,
    generatedAt: now,
    swarmRunId,
    source,
    maxSupportedLogicalAgents: MAX_SUPPORTED_LOGICAL_AGENTS,
    effectiveTotalLogicalAgents: effectiveTotal,
    activeAgentCount,
    statusCounts,
    staffingPlan: agentNodes.length ? {
      summary: session.delegationDecision?.rationale ?? `${agentNodes.length} runtime agent(s) reported across ${Object.keys(roleCounts).length} group(s).`,
      recommendedTotalLogicalAgents: session.delegationDecision?.selectedAgentCount,
      roleCounts,
      specialists: agentNodes
        .filter((node) => node.kind === "specialist")
        .map((node) => ({
          id: node.id,
          role: node.role,
          purpose: node.objective,
          readOnly: !/executor|write/i.test(node.role)
        }))
    } : undefined,
    metrics: extractSwarmMetrics(session),
    nodes,
    messages: messages.filter((message) => nodeMap.has(message.agentId) && isLogicalAgentNode(nodeMap.get(message.agentId)!)).slice(-200)
  };
}

function mergeNode(left: AgentRuntimeSwarmNode, right: AgentRuntimeSwarmNode): AgentRuntimeSwarmNode {
  return {
    ...left,
    ...right,
    parentId: right.parentId ?? left.parentId,
    currentAction: right.currentAction ?? left.currentAction,
    summary: right.summary ?? left.summary,
    prompt: right.prompt ?? left.prompt,
    output: right.output ?? left.output,
    ownedPaths: uniqueStrings([...left.ownedPaths, ...right.ownedPaths]),
    targetFiles: uniqueStrings([...left.targetFiles, ...right.targetFiles]),
    changedFiles: uniqueStrings([...left.changedFiles, ...right.changedFiles]),
    artifactRefs: uniqueStrings([...left.artifactRefs, ...right.artifactRefs]),
    workItemRefs: uniqueStrings([...left.workItemRefs, ...right.workItemRefs]),
    evidenceRefs: uniqueStrings([...left.evidenceRefs, ...right.evidenceRefs]),
    riskRefs: uniqueStrings([...left.riskRefs, ...right.riskRefs]),
    metrics: {
      ...(left.metrics ?? {}),
      ...(right.metrics ?? {})
    },
    updatedAt: left.updatedAt > right.updatedAt ? left.updatedAt : right.updatedAt
  };
}

function finalizeSyntheticNodes(nodeMap: Map<string, AgentRuntimeSwarmNode>, rootId: string) {
  const byParent = new Map<string, AgentRuntimeSwarmNode[]>();
  for (const node of nodeMap.values()) {
    if (!node.parentId) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  for (const node of [...nodeMap.values()].reverse()) {
    if (!SYNTHETIC_NODE_KINDS.has(node.kind) || node.id === rootId) continue;
    const descendants = collectDescendants(node.id, byParent);
    if (!descendants.length) continue;
    const agentCount = descendants.filter(isLogicalAgentNode).length;
    const workItemCount = descendants.filter((child) => child.kind === "work_item").length;
    const changedFiles = uniqueStrings(descendants.flatMap((child) => child.changedFiles));
    const targetFiles = uniqueStrings(descendants.flatMap((child) => child.targetFiles));
    const artifactRefs = uniqueStrings(descendants.flatMap((child) => child.artifactRefs));
    const workItemRefs = uniqueStrings(descendants.flatMap((child) => child.workItemRefs));
    const riskRefs = uniqueStrings(descendants.flatMap((child) => child.riskRefs));
    nodeMap.set(node.id, {
      ...node,
      status: rollupStatus(descendants.map((child) => child.status)),
      currentAction: `${agentCount} agent(s), ${workItemCount} work item(s)`,
      summary: summarizeSyntheticNode(node, agentCount, workItemCount),
      targetFiles,
      changedFiles,
      artifactRefs,
      workItemRefs,
      riskRefs,
      metrics: {
        ...(node.metrics ?? {}),
        completedWorkItemCount: descendants.filter((child) => child.kind === "work_item" && child.status === "completed").length,
        failureCount: descendants.filter((child) => child.status === "failed" || child.status === "blocked").length
      },
      updatedAt: descendants.reduce((latest, child) => latest > child.updatedAt ? latest : child.updatedAt, node.updatedAt)
    });
  }
}

function collectDescendants(parentId: string, byParent: Map<string, AgentRuntimeSwarmNode[]>) {
  const result: AgentRuntimeSwarmNode[] = [];
  const stack = [...(byParent.get(parentId) ?? [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    result.push(node);
    stack.push(...(byParent.get(node.id) ?? []));
  }
  return result;
}

function summarizeSyntheticNode(node: AgentRuntimeSwarmNode, agentCount: number, workItemCount: number) {
  if (node.kind === "gate") return node.summary;
  const pieces = [];
  if (agentCount) pieces.push(`${agentCount} agent(s)`);
  if (workItemCount) pieces.push(`${workItemCount} work item(s)`);
  return pieces.length ? pieces.join(" | ") : node.summary;
}

function rollupStatus(statuses: AgentRuntimeSwarmNodeStatus[]): AgentRuntimeSwarmNodeStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("queued")) return "queued";
  if (statuses.length && statuses.every((status) => status === "completed")) return "completed";
  if (statuses.includes("completed")) return "completed";
  return "idle";
}

function hasChildren(nodeId: string, nodeMap: Map<string, AgentRuntimeSwarmNode>) {
  return [...nodeMap.values()].some((node) => node.parentId === nodeId);
}

function isLogicalAgentNode(node: AgentRuntimeSwarmNode) {
  return AGENT_NODE_KINDS.has(node.kind);
}

function kindOrder(kind: AgentRuntimeSwarmNodeKind) {
  if (kind === "root") return 0;
  if (kind === "group") return 1;
  if (kind === "coordinator") return 2;
  if (kind === "worker" || kind === "specialist") return 3;
  if (kind === "work_item") return 4;
  if (kind === "gate") return 5;
  return 6;
}

function mapSessionStatus(status: AgentRuntimeSession["status"]): AgentRuntimeSwarmNodeStatus {
  if (status === "completed") return "completed";
  if (status === "blocked" || status === "needs_approval") return "blocked";
  if (status === "failed" || status === "failed_provider" || status === "expired") return "failed";
  if (status === "created") return "queued";
  return "running";
}

function mapAgentRunStatus(status: string): AgentRuntimeSwarmNodeStatus {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  return "idle";
}

function mapProgressStatus(status: string): AgentRuntimeSwarmNodeStatus {
  if (status === "completed") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  return "idle";
}

function mapRecursiveStatus(status: string): AgentRuntimeSwarmNodeStatus {
  if (/completed|succeeded|passed/.test(status)) return "completed";
  if (/blocked|conflict|waiting/.test(status)) return "blocked";
  if (/failed/.test(status)) return "failed";
  if (/running|review|validation|patch/.test(status)) return "running";
  if (/ready|planned/.test(status)) return "queued";
  return "idle";
}

function mapTaskStatus(status: AgentRuntimeSession["tasks"][number]["status"]): AgentRuntimeSwarmNodeStatus {
  if (status === "done") return "completed";
  if (status === "blocked") return "blocked";
  if (status === "in_progress") return "running";
  return "queued";
}

function mapGateStatus(status: NonNullable<AgentRuntimeSession["runSummary"]>["gates"][number]["status"]): AgentRuntimeSwarmNodeStatus {
  if (status === "passed") return "completed";
  if (status === "failed") return "failed";
  return "blocked";
}

function inferSwarmSource(session: AgentRuntimeSession, nodes: AgentRuntimeSwarmNode[]): AgentRuntimeSwarmState["source"] {
  const realNodes = nodes.filter(isLogicalAgentNode);
  const hasProviderBackedSwarm = realNodes.some((node) => node.artifactRefs.some((ref) => /swarmRunId|swarm_run|swarm/i.test(ref)) || node.id.startsWith("agent_"));
  const hasRecursive = realNodes.some((node) => node.id.startsWith("recursive-"));
  const hasOrchestration = Boolean(session.orchestration?.agentRuns.length || session.orchestration?.workOrders.length);
  const count = [hasProviderBackedSwarm, hasRecursive, hasOrchestration].filter(Boolean).length;
  if (count > 1) return "mixed";
  if (hasProviderBackedSwarm) return "provider_backed_swarm";
  if (hasRecursive) return "recursive_factory";
  if (hasOrchestration) return "orchestration";
  return "session";
}

function inferSwarmRunId(session: AgentRuntimeSession) {
  for (const agent of session.orchestration?.agentRuns ?? []) {
    const id = extractStringFromUnknown(agent.artifactJson, "swarmRunId");
    if (id) return id;
  }
  return undefined;
}

function extractSwarmMetrics(session: AgentRuntimeSession): Record<string, number | string | boolean> | undefined {
  const summary = session.runSummary?.gates.flatMap((gate) => gate.notes).find((note) => /providerRequests|invalidStructuredOutputs|retries/.test(note));
  if (!summary && !session.providerTelemetry) return undefined;
  return {
    providerRequests: session.providerTelemetry?.providerRequestCount ?? 0,
    providerFailures: session.providerTelemetry?.providerFailureCount ?? 0,
    providerTimeouts: session.providerTelemetry?.providerTimeoutCount ?? 0,
    finalResponseSource: session.providerTelemetry?.finalResponseSource ?? "none"
  };
}

function collectAgentArtifactRefs(value: unknown): string[] {
  const refs = [
    extractStringFromUnknown(value, "swarmRunId"),
    extractStringFromUnknown(value, "currentWorkItemId"),
    extractStringFromUnknown(value, "workerMode")
  ];
  return uniqueStrings(refs);
}

function extractCurrentWorkItemId(value: unknown) {
  return extractStringFromUnknown(value, "currentWorkItemId");
}

function extractStringFromUnknown(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function isSpecialistRole(role: string) {
  return /specialist|security|accessibility|migration|risk|reviewer|tester/i.test(role);
}

function countRoles(nodes: AgentRuntimeSwarmNode[]) {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.role] = (counts[node.role] ?? 0) + 1;
  }
  return counts;
}

function emptyStatusCounts(): Record<AgentRuntimeSwarmNodeStatus, number> {
  return Object.fromEntries(STATUS_KEYS.map((status) => [status, 0])) as Record<AgentRuntimeSwarmNodeStatus, number>;
}

function prettyRole(role: string) {
  return role
    .replace(/Agent$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim() || role;
}

function sanitizeId(value: string) {
  return String(value || "node")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "node";
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

const STATUS_LABELS: Record<AgentRuntimeSwarmNodeStatus, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed"
};
