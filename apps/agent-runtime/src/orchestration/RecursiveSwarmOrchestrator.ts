import { randomUUID } from "node:crypto";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { GoalKeeperAgent } from "./GoalKeeperAgent.js";
import { HierarchicalCollector } from "./HierarchicalCollector.js";
import { RecursiveTaskSplitter } from "./RecursiveTaskSplitter.js";
import type {
  RecursiveSwarmNode,
  RecursiveSwarmTree,
  RecursiveSwarmRunOptions,
  ComplexityAssessment,
  GoalCheckResult
} from "./RecursiveSwarmModels.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  DEFAULT_RECURSIVE_SWARM_OPTIONS
} from "./RecursiveSwarmModels.js";
import type {
  AgentRuntimeSwarmNode,
  AgentRuntimeSwarmNodeKind,
  AgentRuntimeSwarmState
} from "@hivo/protocol";

export type RecursiveSwarmOrchestratorOptions = {
  provider?: LlmProvider;
  options?: Partial<RecursiveSwarmRunOptions>;
  onNodeCreated?: (node: RecursiveSwarmNode) => void;
  onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  onTreeUpdated?: (tree: RecursiveSwarmTree) => void;
};

export type RecursiveSwarmResult = {
  tree: RecursiveSwarmTree;
  finalOutput: string;
  goalCheckHistory: GoalCheckResult[];
  totalSplits: number;
  totalExecutions: number;
  unresolvedErrors: string[];
};

export class RecursiveSwarmOrchestrator {
  private readonly provider?: LlmProvider;
  private readonly splitter: RecursiveTaskSplitter;
  private readonly collector: HierarchicalCollector;
  private readonly goalKeeper: GoalKeeperAgent;
  private readonly runOptions: RecursiveSwarmRunOptions;
  private readonly onNodeCreated?: (node: RecursiveSwarmNode) => void;
  private readonly onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  private readonly onTreeUpdated?: (tree: RecursiveSwarmTree) => void;

  private tree!: RecursiveSwarmTree;
  private totalSplits = 0;
  private totalExecutions = 0;
  private goalCheckHistory: GoalCheckResult[] = [];

  constructor(options: RecursiveSwarmOrchestratorOptions = {}) {
    this.provider = options.provider;
    this.runOptions = { ...DEFAULT_RECURSIVE_SWARM_OPTIONS, ...options.options };
    this.splitter = new RecursiveTaskSplitter({
      provider: this.provider,
      complexityThreshold: this.runOptions.complexityThreshold
    });
    this.collector = new HierarchicalCollector({
      provider: this.provider,
      enableErrorRecovery: this.runOptions.enableErrorRecovery
    });
    this.goalKeeper = new GoalKeeperAgent({
      provider: this.provider,
      checkIntervalMs: this.runOptions.goalCheckIntervalMs
    });
    this.onNodeCreated = options.onNodeCreated;
    this.onNodeStatusChanged = options.onNodeStatusChanged;
    this.onTreeUpdated = options.onTreeUpdated;
  }

  async run(goal: string): Promise<RecursiveSwarmResult> {
    const rootNode = this.createNode({
      name: "Root",
      kind: "root",
      taskPrompt: goal,
      originalGoal: goal,
      parentId: undefined,
      depth: 0
    });

    this.tree = {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      runId: `recursive_swarm_${randomUUID()}`,
      rootGoal: goal,
      rootId: rootNode.id,
      nodes: { [rootNode.id]: rootNode },
      maxDepth: 0,
      totalNodes: 1,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.emitNodeCreated(rootNode);
    this.emitTreeUpdated();

    await this.processNode(rootNode);

    const finalOutput = rootNode.collectResult?.mergedOutput
      ?? rootNode.outputSummary
      ?? "No output produced.";

    this.tree.status = this.hasAnyFailed() ? "failed" : "succeeded";
    this.tree.updatedAt = new Date().toISOString();
    this.emitTreeUpdated();

    return {
      tree: this.tree,
      finalOutput,
      goalCheckHistory: this.goalCheckHistory,
      totalSplits: this.totalSplits,
      totalExecutions: this.totalExecutions,
      unresolvedErrors: this.collectUnresolvedErrors()
    };
  }

  toSwarmState(): AgentRuntimeSwarmState {
    const nodeList = Object.values(this.tree.nodes);
    const rollup: Record<string, number> = {};
    const nodes: AgentRuntimeSwarmNode[] = nodeList.map((recursiveNode) => {
      const swarmNode = this.toSwarmNodeKind(recursiveNode.kind);
      const count = (rollup[recursiveNode.kind] ?? 0) + 1;
      rollup[recursiveNode.kind] = count;
      return {
        id: recursiveNode.id,
        parentId: recursiveNode.parentId,
        kind: swarmNode,
        nodeKind: recursiveNode.kind,
        name: recursiveNode.name,
        role: recursiveNode.role,
        status: this.toSwarmStatus(recursiveNode.status),
        objective: recursiveNode.taskPrompt.slice(0, 200),
        prompt: recursiveNode.taskPrompt,
        taskPrompt: recursiveNode.taskPrompt,
        originalGoal: recursiveNode.originalGoal,
        depth: recursiveNode.depth,
        complexity: recursiveNode.complexity?.score,
        complexityRationale: recursiveNode.complexity?.rationale,
        goalAligned: this.getLatestAlignment(recursiveNode),
        currentAction: this.getCurrentAction(recursiveNode),
        summary: recursiveNode.collectResult?.mergedOutput ?? recursiveNode.outputSummary,
        output: recursiveNode.outputSummary,
        ownedPaths: [],
        targetFiles: [],
        changedFiles: [],
        artifactRefs: [],
        workItemRefs: [],
        evidenceRefs: [],
        riskRefs: [],
        updatedAt: recursiveNode.updatedAt
      };
    });

    return {
      schemaVersion: 1,
      rootId: this.tree.rootId,
      sessionId: this.tree.runId,
      swarmRunId: this.tree.runId,
      generatedAt: new Date().toISOString(),
      source: "recursive_factory",
      maxSupportedLogicalAgents: 300,
      effectiveTotalLogicalAgents: this.tree.totalNodes,
      activeAgentCount: nodeList.filter((n) =>
        n.status === "assessing" || n.status === "splitting" ||
        n.status === "executing" || n.status === "waiting_children"
      ).length,
      statusCounts: {
        idle: nodeList.filter((n) => n.status === "created").length,
        queued: nodeList.filter((n) => n.status === "assessing" || n.status === "splitting" || n.status === "waiting_children" || n.status === "collecting").length,
        running: nodeList.filter((n) => n.status === "executing").length,
        completed: nodeList.filter((n) => n.status === "succeeded").length,
        blocked: nodeList.filter((n) => n.status === "blocked").length,
        failed: nodeList.filter((n) => n.status === "failed").length
      },
      staffingPlan: {
        summary: `Recursive tree: ${this.tree.totalNodes} nodes across ${this.tree.maxDepth + 1} depth levels with ${this.totalSplits} splits and ${this.totalExecutions} executions`,
        roleCounts: rollup as Record<string, number>,
        specialists: []
      },
      nodes,
      messages: []
    };
  }

  private async processNode(node: RecursiveSwarmNode): Promise<void> {
    if (node.depth >= this.runOptions.maxDepth) {
      node.status = "executing";
      this.emitNodeStatusChanged(node);
      await this.executeNode(node);
      return;
    }

    const goalCheck = await this.checkGoalAlignment(node);
    if (goalCheck && !goalCheck.aligned && goalCheck.status === "major_drift") {
      node.status = "blocked";
      node.errorSummary = `Goal drift detected: ${goalCheck.findings.join("; ")}`;
      this.emitNodeStatusChanged(node);
      return;
    }

    node.status = "assessing";
    this.emitNodeStatusChanged(node);

    const assessment = await this.splitter.assessComplexity(
      node.taskPrompt,
      node.originalGoal
    );
    node.complexity = assessment;
    this.emitNodeStatusChanged(node);

    if (assessment.recommendation === "split" && node.depth < this.runOptions.maxDepth) {
      await this.splitAndProcess(node);
    } else {
      node.status = "executing";
      this.emitNodeStatusChanged(node);
      await this.executeNode(node);
    }
  }

  private async splitAndProcess(node: RecursiveSwarmNode): Promise<void> {
    this.totalSplits++;
    node.status = "splitting";
    this.emitNodeStatusChanged(node);

    const splitResult = await this.splitter.splitTask(node, this.runOptions);
    node.splitResult = splitResult;
    this.emitNodeStatusChanged(node);

    const childNodes: RecursiveSwarmNode[] = [];
    for (const subTask of splitResult.subTasks) {
      const childNode = this.createNode({
        name: subTask.title.slice(0, 40),
        kind: "splitter",
        taskPrompt: subTask.taskPrompt,
        originalGoal: node.originalGoal,
        parentId: node.id,
        depth: node.depth + 1
      });
      childNodes.push(childNode);
      node.children.push(childNode.id);
      this.tree.nodes[childNode.id] = childNode;
      this.tree.totalNodes++;
      this.tree.maxDepth = Math.max(this.tree.maxDepth, childNode.depth);
      this.emitNodeCreated(childNode);
    }

    this.emitTreeUpdated();

    node.status = "waiting_children";
    this.emitNodeStatusChanged(node);

    for (const childNode of childNodes) {
      await this.processNode(childNode);
    }

    node.status = "collecting";
    this.emitNodeStatusChanged(node);

    const collectResult = await this.collector.collect(childNodes, node.originalGoal);
    node.collectResult = collectResult;
    node.outputSummary = collectResult.mergedOutput;

    node.status = collectResult.unresolvedErrors.length > 0 ? "failed" : "succeeded";
    if (collectResult.unresolvedErrors.length > 0) {
      node.errorSummary = `Unresolved errors: ${collectResult.unresolvedErrors.join("; ")}`;
    }
    this.emitNodeStatusChanged(node);
    this.emitTreeUpdated();
  }

  private async executeNode(node: RecursiveSwarmNode): Promise<void> {
    this.totalExecutions++;
    node.status = "executing";
    this.emitNodeStatusChanged(node);

    if (this.provider) {
      try {
        const result = await this.provider.generateText({
          systemPrompt: `You are an executor agent.\nOriginal goal: ${node.originalGoal}\nComplete the following task and return your result.`,
          userPrompt: node.taskPrompt,
          maxOutputTokens: 4096
        });
        node.outputSummary = result;
      } catch (error) {
        node.status = "failed";
        node.errorSummary = `Execution error: ${error instanceof Error ? error.message : String(error)}`;
        this.emitNodeStatusChanged(node);
        this.emitTreeUpdated();
        return;
      }
    } else {
      node.outputSummary = `Executed task: ${node.taskPrompt.slice(0, 100)}...`;
    }

    node.status = "succeeded";
    this.emitNodeStatusChanged(node);
    this.emitTreeUpdated();
  }

  private async checkGoalAlignment(node: RecursiveSwarmNode): Promise<GoalCheckResult | null> {
    if (!this.runOptions.enableGoalKeeper) return null;

    const lastCheck = node.goalChecks[node.goalChecks.length - 1];
    if (lastCheck && !this.goalKeeper.shouldRecheck(lastCheck)) {
      return lastCheck;
    }

    const result = await this.goalKeeper.checkAlignment(node);
    node.goalChecks.push(result);
    this.goalCheckHistory.push(result);
    return result;
  }

  private createNode(input: {
    name: string;
    kind: RecursiveSwarmNode["kind"];
    taskPrompt: string;
    originalGoal: string;
    parentId?: string;
    depth: number;
  }): RecursiveSwarmNode {
    return {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      id: `recursive_node_${randomUUID()}`,
      parentId: input.parentId,
      runId: this.tree?.runId ?? `run_${randomUUID()}`,
      kind: input.kind,
      status: "created",
      name: input.name,
      role: this.nodeKindToRole(input.kind),
      originalGoal: input.originalGoal,
      taskPrompt: input.taskPrompt,
      depth: input.depth,
      goalChecks: [],
      children: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  private nodeKindToRole(kind: RecursiveSwarmNode["kind"]): string {
    switch (kind) {
      case "root": return "Root Orchestrator";
      case "splitter": return "Task Splitter";
      case "executor": return "Executor";
      case "goal_keeper": return "Goal Keeper";
      case "collector": return "Collector";
    }
  }

  private toSwarmNodeKind(kind: RecursiveSwarmNode["kind"]): AgentRuntimeSwarmNodeKind {
    switch (kind) {
      case "root": return "root";
      case "splitter": return "group";
      case "executor": return "worker";
      case "goal_keeper": return "gate";
      case "collector": return "aggregator";
    }
  }

  private toSwarmStatus(status: RecursiveSwarmNode["status"]): AgentRuntimeSwarmNode["status"] {
    switch (status) {
      case "created": return "idle";
      case "assessing":
      case "splitting":
      case "waiting_children":
      case "collecting": return "queued";
      case "executing": return "running";
      case "succeeded": return "completed";
      case "blocked": return "blocked";
      case "failed": return "failed";
    }
  }

  private getCurrentAction(node: RecursiveSwarmNode): string | undefined {
    switch (node.status) {
      case "assessing": return "Assessing task complexity...";
      case "splitting": return "Splitting task into sub-tasks...";
      case "waiting_children": return `Waiting for ${node.children.length} child agent(s)...`;
      case "executing": return "Executing task...";
      case "collecting": return "Collecting results from children...";
      case "succeeded": return "Completed.";
      case "failed": return node.errorSummary ?? "Failed.";
      case "blocked": return node.errorSummary ?? "Blocked.";
      default: return undefined;
    }
  }

  private getLatestAlignment(node: RecursiveSwarmNode): boolean {
    const last = node.goalChecks[node.goalChecks.length - 1];
    return last ? last.aligned : true;
  }

  private hasAnyFailed(): boolean {
    return Object.values(this.tree.nodes).some(
      (node) => node.status === "failed"
    );
  }

  private collectUnresolvedErrors(): string[] {
    const errors: string[] = [];
    for (const node of Object.values(this.tree.nodes)) {
      if (node.collectResult?.unresolvedErrors) {
        errors.push(...node.collectResult.unresolvedErrors);
      }
      if (node.errorSummary && node.status === "failed") {
        errors.push(`[${node.name}] ${node.errorSummary}`);
      }
    }
    return [...new Set(errors)];
  }

  private emitNodeCreated(node: RecursiveSwarmNode): void {
    this.onNodeCreated?.(node);
  }

  private emitNodeStatusChanged(node: RecursiveSwarmNode): void {
    this.tree.updatedAt = new Date().toISOString();
    this.tree.nodes[node.id] = { ...node };
    this.onNodeStatusChanged?.(node);
    this.emitTreeUpdated();
  }

  private emitTreeUpdated(): void {
    this.onTreeUpdated?.(this.tree);
  }
}
