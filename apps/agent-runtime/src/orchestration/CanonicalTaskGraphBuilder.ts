import type { TaskGraph, TaskNode } from "@hivo/protocol";

export type CanonicalTaskGraphNodeInput = Omit<TaskNode, "dependsOn"> & {
  dependsOn?: string[];
};

export function createCanonicalTaskGraph(input: {
  sessionId: string;
  nodes: CanonicalTaskGraphNodeInput[];
}): TaskGraph {
  const knownIds = new Set(input.nodes.map((node) => node.id));
  const nodes: TaskNode[] = input.nodes.map((node) => ({
    ...node,
    dependsOn: node.dependsOn ?? []
  }));
  return {
    sessionId: input.sessionId,
    nodes,
    edges: nodes.flatMap((node) =>
      node.dependsOn
        .filter((dependency) => knownIds.has(dependency))
        .map((dependency) => ({ from: dependency, to: node.id }))
    )
  };
}

export function validateCanonicalTaskGraph(taskGraph: TaskGraph): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const node of taskGraph.nodes) {
    if (ids.has(node.id)) {
      errors.push(`Duplicate task id: ${node.id}`);
    }
    ids.add(node.id);
  }
  for (const edge of taskGraph.edges) {
    if (!ids.has(edge.from)) errors.push(`Edge references missing source task: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`Edge references missing target task: ${edge.to}`);
    const target = taskGraph.nodes.find((node) => node.id === edge.to);
    if (target && !target.dependsOn.includes(edge.from)) {
      errors.push(`Edge ${edge.from} -> ${edge.to} is not mirrored by task ${edge.to} dependsOn.`);
    }
  }
  const edges = new Set(taskGraph.edges.map((edge) => `${edge.from}->${edge.to}`));
  for (const node of taskGraph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) errors.push(`Task ${node.id} depends on missing task ${dependency}`);
      if (ids.has(dependency) && !edges.has(`${dependency}->${node.id}`)) {
        errors.push(`Task ${node.id} depends on ${dependency} but graph is missing edge ${dependency} -> ${node.id}.`);
      }
    }
  }
  errors.push(...detectCanonicalTaskGraphCycles(taskGraph));
  return [...new Set(errors)];
}

function detectCanonicalTaskGraphCycles(taskGraph: TaskGraph): string[] {
  const byId = new Map(taskGraph.nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[] = [];

  const visit = (taskId: string, path: string[]) => {
    if (visiting.has(taskId)) {
      cycles.push(`Task dependency cycle: ${[...path, taskId].join(" -> ")}`);
      return;
    }
    if (visited.has(taskId)) return;
    const node = byId.get(taskId);
    if (!node) return;
    visiting.add(taskId);
    for (const dependency of node.dependsOn) visit(dependency, [...path, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const node of taskGraph.nodes) visit(node.id, []);
  return cycles;
}
