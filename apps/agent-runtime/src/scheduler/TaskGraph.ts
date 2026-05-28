import type { TaskGraph, TaskNode } from "@hivo/protocol";

export function getReadyTasks(graph: TaskGraph) {
  return graph.nodes.filter((node) => {
    if (node.status !== "pending") return false;
    return node.dependsOn.every((dependency) => {
      const dep = graph.nodes.find((candidate) => candidate.id === dependency);
      return dep?.status === "completed";
    });
  });
}

export function markTask(graph: TaskGraph, taskId: string, status: TaskNode["status"]) {
  const node = graph.nodes.find((candidate) => candidate.id === taskId);
  if (!node) throw new Error(`Task ${taskId} not found`);
  node.status = status;
}

export function cloneTaskGraph(graph: TaskGraph): TaskGraph {
  return {
    sessionId: graph.sessionId,
    nodes: graph.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn], fileLocks: [...node.fileLocks] })),
    edges: graph.edges.map((edge) => ({ ...edge }))
  };
}
