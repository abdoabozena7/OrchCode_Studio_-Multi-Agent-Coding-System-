import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { LlmProvider } from "../llm/LlmProvider.js";
import { invokeReasoningProviderStructured, invokeReasoningProviderText } from "../runtime/ReasoningKernel.js";
import { GoalKeeperAgent } from "./GoalKeeperAgent.js";
import { HierarchicalCollector } from "./HierarchicalCollector.js";
import { RecursiveTaskSplitter } from "./RecursiveTaskSplitter.js";
import { SqliteTaskQueueBackend } from "./AgentTaskQueue.js";
import type {
  RecursiveSwarmNode,
  RecursiveSwarmTree,
  RecursiveSwarmRunOptions,
  RecursiveSwarmRunState,
  MemoryEvidencePack,
  RecursiveContextSource,
  DurableSwarmEvent,
  GoalEnvelope,
  GoalCheckResult,
  AtomicTaskAssessment,
  SteeringMessage,
  RecursiveNodeOutput
} from "./RecursiveSwarmModels.js";
import {
  RECURSIVE_SWARM_SCHEMA_VERSION,
  DEFAULT_RECURSIVE_SWARM_OPTIONS,
  createGoalEnvelope,
  normalizeRecursiveNodeOutput,
  wrapTextFallback,
  RECURSIVE_OUTPUT_KINDS,
  EDIT_INTENT_OPERATIONS,
  RISK_LEVELS,
  REVIEW_DECISIONS
} from "./RecursiveSwarmModels.js";
import type {
  AgentRuntimeSwarmNode,
  AgentRuntimeSwarmNodeKind,
  AgentRuntimeSwarmState
} from "@hivo/protocol";

export type RecursiveSwarmOrchestratorOptions = {
  provider?: LlmProvider;
  workspacePath?: string;
  options?: Partial<RecursiveSwarmRunOptions>;
  onNodeCreated?: (node: RecursiveSwarmNode) => void;
  onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  onTreeUpdated?: (tree: RecursiveSwarmTree) => void;
  onDurableEvent?: (event: DurableSwarmEvent) => void;
  /** Build a per-node MemoryEvidencePack from the node's task prompt */
  buildPack?: (taskPrompt: string, nodeId: string) => MemoryEvidencePack;
};

export type RecursiveSwarmResult = {
  tree: RecursiveSwarmTree;
  runState: RecursiveSwarmRunState;
  finalOutput: string;
  goalCheckHistory: GoalCheckResult[];
  totalSplits: number;
  totalExecutions: number;
  unresolvedErrors: string[];
  contextSourceCounts: Record<RecursiveContextSource, number>;
};

export class RecursiveSwarmOrchestrator {
  private readonly provider?: LlmProvider;
  private readonly workspacePath: string;
  private readonly splitter: RecursiveTaskSplitter;
  private readonly collector: HierarchicalCollector;
  private readonly goalKeeper: GoalKeeperAgent;
  private readonly runOptions: RecursiveSwarmRunOptions;
  private readonly onNodeCreated?: (node: RecursiveSwarmNode) => void;
  private readonly onNodeStatusChanged?: (node: RecursiveSwarmNode) => void;
  private readonly onTreeUpdated?: (tree: RecursiveSwarmTree) => void;
  private readonly onDurableEvent?: (event: DurableSwarmEvent) => void;
  private readonly buildPack?: (taskPrompt: string, nodeId: string) => MemoryEvidencePack;

  private tree!: RecursiveSwarmTree;
  private runState!: RecursiveSwarmRunState;
  private totalSplits = 0;
  private totalExecutions = 0;
  private goalCheckHistory: GoalCheckResult[] = [];
  private durableEvents: DurableSwarmEvent[] = [];
  private sessionId: string = "";
  private contextSourceCounts: Record<RecursiveContextSource, number> = {
    memory_evidence: 0,
    partial_context: 0,
    prompt_only_fallback: 0
  };

  constructor(options: RecursiveSwarmOrchestratorOptions = {}) {
    this.provider = options.provider;
    this.workspacePath = options.workspacePath ?? "";
    this.runOptions = { ...DEFAULT_RECURSIVE_SWARM_OPTIONS, ...options.options };
    this.buildPack = options.buildPack;
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
    this.onDurableEvent = options.onDurableEvent;
  }

  async createRootAndGoalKeeper(goal: string, sessionId: string): Promise<{ root: RecursiveSwarmNode; goalKeeperNode: RecursiveSwarmNode }> {
    this.sessionId = sessionId;
    const runId = `recursive_swarm_${randomUUID()}`;
    const goalEnvelope = createGoalEnvelope({
      originalGoal: goal,
      workspaceIdentity: this.workspacePath,
      localTask: goal
    });
    const rootNode = this.createNode({
      name: "Root",
      kind: "root",
      taskPrompt: goal,
      goalEnvelope,
      parentId: undefined,
      depth: 0
    });
    const goalKeeperNode = this.createNode({
      name: `Goal Keeper`,
      kind: "goal_keeper",
      taskPrompt: `Monitor alignment with original goal: ${goal}`,
      goalEnvelope,
      parentId: rootNode.id,
      depth: 0
    });
    rootNode.children.push(goalKeeperNode.id);
    this.tree = {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      runId,
      rootGoal: goal,
      rootId: rootNode.id,
      nodes: { [rootNode.id]: rootNode, [goalKeeperNode.id]: goalKeeperNode },
      maxDepth: 0,
      totalNodes: 2,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.runState = {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      runId,
      sessionId,
      goalEnvelope,
      tree: this.tree,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durableEvents: [],
      contextSourceCounts: { memory_evidence: 0, partial_context: 0, prompt_only_fallback: 0 }
    };
    this.emitDurableEvent("run_created", undefined, { goal, rootId: rootNode.id });
    this.emitNodeCreated(rootNode);
    this.emitNodeCreated(goalKeeperNode);
    this.emitTreeUpdated();
    return { root: rootNode, goalKeeperNode };
  }

  async run(goal: string, sessionId?: string): Promise<RecursiveSwarmResult> {
    if (!this.tree) {
      await this.createRootAndGoalKeeper(goal, sessionId ?? "");
    }
    const rootNode = this.tree.nodes[this.tree.rootId];
    await this.processNode(rootNode);
    // Build context-source summary
    const totalNodes = Object.values(this.tree.nodes).length;
    const evidenceCount = this.contextSourceCounts.memory_evidence;
    const partialCount = this.contextSourceCounts.partial_context;
    const fallbackCount = this.contextSourceCounts.prompt_only_fallback;
    const summaryLines: string[] = [];
    if (evidenceCount > 0) summaryLines.push(`${evidenceCount}/${totalNodes} nodes used memory evidence`);
    if (partialCount > 0) summaryLines.push(`${partialCount}/${totalNodes} nodes used partial context`);
    if (fallbackCount > 0) summaryLines.push(`${fallbackCount}/${totalNodes} nodes used prompt-only fallback`);
    const sourceSummary = summaryLines.length > 0 ? summaryLines.join("; ") : "No context-source data recorded";
    // Derive final output from structured artifacts
    const structured = rootNode.structuredOutput;
    const blockers = structured?.kind === "final_summary" ? structured.blockers
      : structured?.kind === "integration_summary" ? structured.unresolved_items
      : [];
    const structuredText = structured?.kind === "final_summary" ? structured.summary
      : structured?.kind === "integration_summary" ? structured.merged_findings.join("\n")
      : null;
    const rawOutput = structuredText ?? rootNode.collectResult?.mergedOutput
      ?? rootNode.outputSummary
      ?? "No output produced.";
    const blockerSuffix = blockers.length > 0 ? `\n\n[Blockers: ${blockers.join("; ")}]` : "";
    const finalOutput = `${rawOutput}${blockerSuffix}\n\n[Context-source summary: ${sourceSummary}]`;
    this.runState.contextSourceCounts = { ...this.contextSourceCounts };
    this.tree.status = this.hasAnyFailed() ? "failed" : "succeeded";
    this.tree.updatedAt = new Date().toISOString();
    this.emitDurableEvent("run_completed", undefined, { status: this.tree.status });
    this.emitTreeUpdated();
    return {
      tree: this.tree,
      runState: this.runState,
      finalOutput,
      goalCheckHistory: this.goalCheckHistory,
      totalSplits: this.totalSplits,
      totalExecutions: this.totalExecutions,
      unresolvedErrors: this.collectUnresolvedErrors(),
      contextSourceCounts: { ...this.contextSourceCounts }
    };
  }

  getRunState(): RecursiveSwarmRunState {
    return this.runState;
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
        originalGoal: recursiveNode.goalEnvelope.originalGoal,
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
      maxSupportedLogicalAgents: this.runOptions.maxAgents,
      effectiveTotalLogicalAgents: this.tree.totalNodes,
      activeAgentCount: nodeList.filter((n) =>
        n.status === "assessing" || n.status === "splitting" ||
        n.status === "executing" || n.status === "waiting_children" ||
        n.status === "verifying"
      ).length,
      statusCounts: {
        idle: nodeList.filter((n) => n.status === "created").length,
        queued: nodeList.filter((n) => n.status === "assessing" || n.status === "splitting" || n.status === "waiting_children" || n.status === "collecting" || n.status === "verifying").length,
        running: nodeList.filter((n) => n.status === "executing").length,
        completed: nodeList.filter((n) => n.status === "succeeded").length,
        blocked: nodeList.filter((n) => n.status === "blocked" || n.status === "escalated").length,
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

  addSteeringMessage(nodeId: string, text: string): SteeringMessage {
    const node = this.tree.nodes[nodeId];
    if (!node) throw new Error(`Node ${nodeId} not found`);
    const msg: SteeringMessage = {
      id: `steer_${randomUUID().slice(0, 8)}`,
      senderId: "user",
      text,
      checkpoint: node.status === "assessing" ? "pre_split" : node.status === "executing" ? "pre_execute" : "pre_accept",
      applied: false,
      createdAt: new Date().toISOString()
    };
    node.steeringQueue.push(msg);
    this.emitDurableEvent("steering_message", nodeId, { messageId: msg.id, text });
    return msg;
  }

  private async processNode(node: RecursiveSwarmNode): Promise<void> {
    await this.processSteeringQueue(node);
    await this.checkGoalAt(node, "pre_split");
    if (node.status === "blocked" || node.status === "failed" || node.status === "escalated") return;

    if (node.depth >= this.runOptions.maxDepth) {
      node.status = "blocked";
      node.errorSummary = `Max depth (${this.runOptions.maxDepth}) reached; task too complex.`;
      this.emitNodeStatusChanged(node);
      return;
    }
    if (this.tree.totalNodes >= this.runOptions.maxAgents) {
      node.status = "escalated";
      node.errorSummary = `Max agents (${this.runOptions.maxAgents}) reached; cannot split further.`;
      this.emitNodeStatusChanged(node);
      return;
    }

    node.status = "assessing";
    this.emitNodeStatusChanged(node);

    const assessment = await this.assessAtomicity(node);
    node.complexity = assessment;
    this.emitDurableEvent("complexity_assessed", node.id, { score: assessment.score, recommendation: assessment.recommendation });
    this.emitNodeStatusChanged(node);

    if (assessment.recommendation === "escalate") {
      node.status = "escalated";
      node.errorSummary = assessment.rationale;
      this.emitNodeStatusChanged(node);
      return;
    }
    if (assessment.recommendation === "block") {
      node.status = "blocked";
      node.errorSummary = assessment.rationale;
      this.emitNodeStatusChanged(node);
      return;
    }

    if (assessment.recommendation === "split") {
      await this.splitAndProcess(node);
    } else {
      await this.enqueueNodeExecution(node);
    }
  }

  private async enqueueNodeExecution(node: RecursiveSwarmNode): Promise<void> {
    const queueDir = this.workspacePath
      ? path.join(this.workspacePath, ".agent_memory")
      : path.join(process.cwd(), ".agent_memory");
    if (!existsSync(queueDir)) {
      await mkdir(queueDir, { recursive: true });
    }
    const queue = new SqliteTaskQueueBackend(queueDir);

    const jobId = await queue.enqueue({
      queue_name: `recursive_swarm:${this.runState.sessionId}`,
      job_type: "recursive_node_execution",
      payload: { node_id: node.id, task_prompt: node.taskPrompt, goal: node.goalEnvelope.originalGoal },
      priority: 3,
      max_attempts: 3
    });

    node.status = "queued";
    this.emitNodeStatusChanged(node);

    const dequeued = await queue.dequeue(`recursive_swarm:${this.runState.sessionId}`, 120_000);
    if (!dequeued) {
      node.status = "failed";
      node.errorSummary = "Node execution dequeued timed out";
      this.emitNodeStatusChanged(node);
      queue.close();
      return;
    }

    try {
      await this.executeWithVerification(node);
      await queue.ack(dequeued.job.id, dequeued.lease_id);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await queue.nack(dequeued.job.id, dequeued.lease_id, msg);
      node.status = "failed";
      node.errorSummary = msg;
      this.emitNodeStatusChanged(node);
    }
    queue.close();
  }

  private async assessAtomicity(node: RecursiveSwarmNode): Promise<AtomicTaskAssessment> {
    if (!this.provider) {
      return {
        isAtomic: false,
        score: 10,
        rationale: "Recursive atomicity assessment requires a configured provider; deterministic local task assessment is not a runtime fallback.",
        failures: ["provider_unavailable"],
        recommendation: "block"
      };
    }
    return this.providerAssessAtomic(node);
  }

  private formatPackForPrompt(pack?: MemoryEvidencePack): string {
    if (!pack) return "";
    const lines: string[] = ["=== Memory Evidence Pack ==="];
    if (pack.intent_contract_ref) lines.push(`Intent contract: ${pack.intent_contract_ref}`);
    if (pack.relevant_files.length) lines.push(`Relevant files: ${pack.relevant_files.slice(0, 10).join(", ")}`);
    for (const [filePath, range] of Object.entries(pack.file_ranges).slice(0, 5)) {
      lines.push(`  ${filePath}: lines ${range}`);
    }
    if (pack.symbols.length) lines.push(`Symbols: ${pack.symbols.slice(0, 8).join(", ")}`);
    if (pack.commands.length) lines.push(`Known commands: ${pack.commands.slice(0, 6).join(", ")}`);
    if (pack.allowed_paths.length) lines.push(`Allowed paths: ${pack.allowed_paths.join(", ")}`);
    if (pack.forbidden_paths.length) lines.push(`Forbidden paths: ${pack.forbidden_paths.join(", ")}`);
    if (pack.unknowns.length) lines.push(`Unknowns: ${pack.unknowns.slice(0, 3).join("; ")}`);
    if (pack.warnings.length) lines.push(`Warnings: ${pack.warnings.slice(0, 3).join("; ")}`);
    lines.push(`Evidence confidence: ${pack.confidence.toFixed(2)}, freshness: ${pack.freshness_status}`);
    lines.push(`Context source: ${pack.context_source}`);
    if (pack.context_source !== "memory_evidence") {
      lines.push("WARNING: No sufficient memory evidence available — answer from task prompt and general knowledge. State clearly that this answer is prompt-only.");
    }
    if (pack.freshness_status === "stale") {
      lines.push("WARNING: Memory evidence may be stale. Verify file contents before relying on file paths or summaries.");
    }
    return lines.join("\n");
  }

  private async providerAssessAtomic(node: RecursiveSwarmNode): Promise<AtomicTaskAssessment> {
    if (!this.provider) {
      throw new Error("Recursive atomicity assessment provider is not configured.");
    }
    const contextBlock = this.formatPackForPrompt(node.evidencePack);
    try {
      const response = await invokeReasoningProviderStructured<{
        isAtomic: boolean; score: number; rationale: string; failures: string[];
      }>(
        this.provider,
        {
          purpose: "reason",
          reasoningStage: "reason",
          responseFormat: "json",
          systemPrompt: `You are a Task Atomicity Assessor.
Determine if a task is ATOMIC (can be executed directly) or needs splitting.
A task is atomic ONLY when ALL of these conditions are met:
1. SINGLE GOAL: The task has one clear, indivisible objective
2. CLEAR OUTPUTS: The expected output is well-defined and measurable
3. LIMITED SCOPE: The task touches at most one file/component/module
4. RESOLVED DEPS: All dependencies are satisfied or none needed
5. VERIFIABLE DOD: Definition of Done is concrete and testable

Score 1-10. Score >= 5 or any condition failure means NOT atomic.
If score >= 8 AND depth >= 5, recommend "escalate".
If score >= 5 but not salvageable, recommend "block".${contextBlock ? `\n\n${contextBlock}` : ""}`,
          userPrompt: `Evaluate this task for atomicity:

TASK: ${node.taskPrompt}
ORIGINAL GOAL: ${node.goalEnvelope.originalGoal}
DEPTH: ${node.depth}

Return { isAtomic, score, rationale, failures } where failures lists which atomicity conditions failed.`,
          maxOutputTokens: 512
        },
        {
          name: "atomicity_assessment",
          type: "object",
          properties: {
            isAtomic: { type: "boolean" },
            score: { type: "number", minimum: 1, maximum: 10 },
            rationale: { type: "string" },
            failures: { type: "array", items: { type: "string" } }
          },
          required: ["isAtomic", "score", "rationale", "failures"]
        }
      );
      const score = Math.max(1, Math.min(10, Math.round(response.score ?? 5))) as AtomicTaskAssessment["score"];
      const isAtomic = response.isAtomic === true && score < 5 && response.failures.length === 0;
      let recommendation: AtomicTaskAssessment["recommendation"] = "execute";
      if (!isAtomic) recommendation = "split";
      if (score >= 8 && node.depth >= 5) recommendation = "escalate";
      return { isAtomic, score, rationale: response.rationale ?? "Provider assessment", failures: response.failures ?? [], recommendation };
    } catch (error) {
      return {
        isAtomic: false,
        score: 10,
        rationale: `Provider-backed recursive atomicity assessment failed: ${error instanceof Error ? error.message : String(error)}`,
        failures: ["provider_failed"],
        recommendation: "block"
      };
    }
  }

  private async splitAndProcess(node: RecursiveSwarmNode): Promise<void> {
    this.totalSplits++;
    node.status = "splitting";
    this.emitNodeStatusChanged(node);
    let splitResult: Awaited<ReturnType<RecursiveTaskSplitter["splitTask"]>>;
    try {
      splitResult = await this.splitter.splitTask(node, this.runOptions, { pack: node.evidencePack });
    } catch (error) {
      node.status = "blocked";
      node.errorSummary = error instanceof Error ? error.message : String(error);
      this.emitDurableEvent("error", node.id, { stage: "task_split", reason: node.errorSummary });
      this.emitNodeStatusChanged(node);
      this.emitTreeUpdated();
      return;
    }
    node.splitResult = splitResult;

    // Bug 3 fix: detect self-similar split that would cause infinite recursion
    if (splitResult.subTasks.length === 0) {
      this.emitDurableEvent("task_split", node.id, { subTaskCount: 0, note: "cannot meaningfully split, executing directly" });
      await this.executeWithVerification(node);
      return;
    }
    if (splitResult.subTasks.length === 1 && splitResult.subTasks[0].taskPrompt.trim() === node.taskPrompt.trim()) {
      this.emitDurableEvent("task_split", node.id, { subTaskCount: 1, note: "self-similar split detected, executing directly" });
      await this.executeWithVerification(node);
      return;
    }

    this.emitDurableEvent("task_split", node.id, { subTaskCount: splitResult.subTasks.length });
    this.emitNodeStatusChanged(node);

    const childNodes: RecursiveSwarmNode[] = [];

    for (const subTask of splitResult.subTasks) {
      const childNode = this.createNode({
        name: subTask.title.slice(0, 40),
        kind: "task_agent",
        taskPrompt: subTask.taskPrompt,
        goalEnvelope: { ...node.goalEnvelope, localTask: subTask.taskPrompt },
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
    // Create visible collector for this parent
    const collectorNode = this.createNode({
      name: `Collector (${node.name})`,
      kind: "collector",
      taskPrompt: `Merge results from ${childNodes.length} child agent(s) for: ${node.goalEnvelope.localTask}`,
      goalEnvelope: node.goalEnvelope,
      parentId: node.id,
      depth: node.depth
    });
    node.children.push(collectorNode.id);
    this.tree.nodes[collectorNode.id] = collectorNode;
    this.tree.totalNodes++;
    this.emitNodeCreated(collectorNode);
    this.emitTreeUpdated();

    node.status = "waiting_children";
    this.emitNodeStatusChanged(node);

    // Execute children respecting dependencies and parallel cap
    await this.executeChildren(childNodes, splitResult);

    // Collect — Bug 1 fix: use stable parentId lookup, not object references
    node.status = "collecting";
    this.emitNodeStatusChanged(node);

    const freshChildren = Object.values(this.tree.nodes).filter((n) => n.parentId === node.id && n.kind === "task_agent");
    const collectResult = await this.collector.collect(freshChildren, node.goalEnvelope.originalGoal, { pack: node.evidencePack });
    node.collectResult = collectResult;
    node.outputSummary = collectResult.mergedOutput;

    // Create repair agent if needed
    if (collectResult.unresolvedErrors.length > 0 && this.runOptions.enableErrorRecovery) {
      await this.createRepairAgent(node, collectorNode, collectResult);
    }

    // Verify
    node.status = "verifying";
    this.emitNodeStatusChanged(node);
    await this.checkGoalAt(node, "pre_accept");

    collectorNode.status = "succeeded";
    collectorNode.outputSummary = collectResult.mergedOutput;
    this.emitNodeStatusChanged(collectorNode);

    node.status = collectResult.unresolvedErrors.length > 0 ? "failed" : "succeeded";
    if (collectResult.unresolvedErrors.length > 0) {
      node.errorSummary = `Unresolved errors: ${collectResult.unresolvedErrors.join("; ")}`;
    }
    this.emitDurableEvent("collect_completed", node.id, { childCount: freshChildren.length, errors: collectResult.unresolvedErrors.length });
    this.emitNodeStatusChanged(node);
    this.emitTreeUpdated();
  }

  private async executeChildren(children: RecursiveSwarmNode[], parentSplitResult: import("./RecursiveSwarmModels.js").SplitResult): Promise<void> {
    // Build child ID by subtask index and subtask ID
    const indexToChildId: string[] = parentSplitResult.subTasks.map((st, i) => children[i]?.id ?? "");
    const subtaskIdToChildId = new Map<string, string>();
    const childIdToResolvedDeps = new Map<string, string[]>();
    for (let i = 0; i < parentSplitResult.subTasks.length; i++) {
      const st = parentSplitResult.subTasks[i];
      const childId = children[i]?.id;
      if (!childId) continue;
      subtaskIdToChildId.set(st.id, childId);
    }
    // Resolve each child's dependencies to child node IDs
    for (let i = 0; i < parentSplitResult.subTasks.length; i++) {
      const st = parentSplitResult.subTasks[i];
      const childId = children[i]?.id;
      if (!childId) continue;
      const resolved = st.dependencies.map((dep) => {
        // Try as numeric index
        if (/^\d+$/.test(dep)) {
          const idx = parseInt(dep, 10);
          if (idx >= 0 && idx < indexToChildId.length && idx !== i) return indexToChildId[idx];
        }
        // Try as subtask ID
        const mapped = subtaskIdToChildId.get(dep);
        if (mapped && mapped !== childId) return mapped;
        return "";
      }).filter(Boolean) as string[];
      childIdToResolvedDeps.set(childId, resolved);
    }

    const executed = new Set<string>();
    let remaining = children.map((c) => c.id);
    while (remaining.length > 0) {
      const ready = remaining.filter((childId) => {
        const deps = childIdToResolvedDeps.get(childId) ?? [];
        return deps.every((depId) => executed.has(depId));
      });
      if (ready.length === 0) {
        // Deadlock — mark remaining as blocked
        for (const id of remaining) {
          const node = this.tree.nodes[id];
          if (node) {
            node.status = "blocked";
            node.errorSummary = `Deadlock: dependencies cannot be satisfied (pending: ${remaining.join(", ")})`;
            this.emitNodeStatusChanged(node);
            executed.add(id);
          }
        }
        break;
      }
      // Execute ready batch respecting parallel cap
      if (this.runOptions.enableParallelExecution) {
        const maxParallel = this.runOptions.maxWriteExecutors;
        for (let i = 0; i < ready.length; i += maxParallel) {
          const slice = ready.slice(i, i + maxParallel);
          await Promise.all(slice.map((id) => this.processNode(this.tree.nodes[id])));
        }
      } else {
        for (const id of ready) {
          await this.processNode(this.tree.nodes[id]);
        }
      }
      for (const id of ready) {
        executed.add(id);
      }
      remaining = remaining.filter((id) => !executed.has(id));
    }
  }

  private async executeWithVerification(node: RecursiveSwarmNode): Promise<void> {
    this.totalExecutions++;
    node.status = "executing";
    this.emitNodeStatusChanged(node);

    const pack = node.evidencePack;
    const contextBlock = this.formatPackForPrompt(pack);
    const contextNote = pack?.context_source === "memory_evidence"
      ? "\nThe memory evidence pack above was built from project evidence. Reference relevant files and line ranges in your answer."
      : pack?.context_source === "partial_context"
        ? "\nWARNING: Only partial context was available. Answer from the task prompt and available evidence."
        : "\nWARNING: No evidence pack was available. Answer from the task prompt and general knowledge only. State clearly that this answer is prompt-only.";

    const structuredPrompt = `Produce a structured JSON output with exactly one of these kinds:
- "evidence_report": findings[], files[], symbols[], evidence_refs[], unknowns[], confidence (0-1)
- "task_plan": tasks[{name, description, dependencies[], risk(low|medium|high)}], validation_strategy, confidence
- "edit_intent": target_file, target_symbol_or_range, operation(create|modify|delete|refactor), reason, expected_behavior, risk(low|medium|high), evidence_refs[]
- "validation_plan": commands[], smoke_checks[], expected_results[], blockers[]
- "review_decision": decision(approve|block|needs_changes), findings[], required_changes[], risks[]
- "integration_summary": child_outputs_used, conflicts[], merged_findings[], unresolved_items[]
- "final_summary": summary, blockers[], edit_intents[], validation_plans[], confidence

Return valid JSON with a "kind" field matching one of the above.`;

    if (this.provider) {
      try {
        // Attempt structured output via invokeReasoningProviderStructured
        const raw = await invokeReasoningProviderStructured<Record<string, unknown>>(
          this.provider,
          {
            systemPrompt: `You are an executor agent.\nOriginal goal: ${node.goalEnvelope.originalGoal}\nTheme: ${node.goalEnvelope.theme}\nConstraints: ${node.goalEnvelope.constraints.join(", ")}\nComplete the following task.${contextBlock ? `\n\n${contextBlock}` : ""}${contextNote}\n\n${structuredPrompt}`,
            userPrompt: node.taskPrompt,
            maxOutputTokens: 4096
          },
          {
            name: "structured_node_output",
            type: "object",
            additionalProperties: true,
            required: ["kind"],
            properties: {
              kind: { type: "string", enum: RECURSIVE_OUTPUT_KINDS },
              findings: { type: "array", items: { type: "string" } },
              files: { type: "array", items: { type: "string" } },
              symbols: { type: "array", items: { type: "string" } },
              evidence_refs: { type: "array", items: { type: "string" } },
              unknowns: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
              summary: { type: "string" },
              blockers: { type: "array", items: { type: "string" } },
              edit_intents: { type: "array", items: { type: "object" } },
              validation_plans: { type: "array", items: { type: "object" } },
              tasks: { type: "array", items: { type: "object" } },
              validation_strategy: { type: "string" },
              target_file: { type: "string" },
              target_symbol_or_range: { type: "string" },
              operation: { type: "string" },
              reason: { type: "string" },
              expected_behavior: { type: "string" },
              risk: { type: "string" },
              commands: { type: "array", items: { type: "string" } },
              smoke_checks: { type: "array", items: { type: "string" } },
              expected_results: { type: "array", items: { type: "string" } },
              decision: { type: "string" },
              required_changes: { type: "array", items: { type: "string" } },
              risks: { type: "array", items: { type: "string" } },
              child_outputs_used: { type: "number" },
              conflicts: { type: "array", items: { type: "string" } },
              merged_findings: { type: "array", items: { type: "string" } },
              unresolved_items: { type: "array", items: { type: "string" } }
            }
          }
        );
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const { output, summary } = normalizeRecursiveNodeOutput(parsed);
        node.structuredOutput = output;
        node.outputSummary = summary;
      } catch (error) {
        // Fallback: try plain text invocation
        try {
          const result = await invokeReasoningProviderText(this.provider, {
            systemPrompt: `You are an executor agent.\nOriginal goal: ${node.goalEnvelope.originalGoal}\nTheme: ${node.goalEnvelope.theme}\nConstraints: ${node.goalEnvelope.constraints.join(", ")}\nComplete the following task.${contextBlock ? `\n\n${contextBlock}` : ""}${contextNote}`,
            userPrompt: node.taskPrompt,
            maxOutputTokens: 4096
          });
          const { output, summary } = wrapTextFallback(result);
          node.structuredOutput = output;
          node.outputSummary = summary;
        } catch (error2) {
          node.status = "failed";
          node.errorSummary = `Execution error: ${error2 instanceof Error ? error2.message : String(error2)}`;
          this.emitNodeStatusChanged(node);
          this.emitTreeUpdated();
          return;
        }
      }
    } else {
      node.status = "blocked";
      node.errorSummary = "Recursive node execution requires a configured provider; local prompt-only execution output is not a runtime fallback.";
      this.emitDurableEvent("error", node.id, { stage: "node_execution", reason: node.errorSummary });
      this.emitNodeStatusChanged(node);
      this.emitTreeUpdated();
      return;
    }

    // Verify after execution
    node.status = "verifying";
    this.emitNodeStatusChanged(node);
    await this.checkGoalAt(node, "pre_accept");

    node.status = "succeeded";
    this.emitDurableEvent("node_completed", node.id, { outputLength: node.outputSummary?.length ?? 0 });
    this.emitNodeStatusChanged(node);
    this.emitTreeUpdated();
  }

  private async createRepairAgent(parent: RecursiveSwarmNode, collectorNode: RecursiveSwarmNode, collectResult: { unresolvedErrors: string[]; mergedOutput: string }): Promise<void> {
    const repairNode = this.createNode({
      name: `Repair Agent (${parent.name})`,
      kind: "repair_agent",
      taskPrompt: `Repair the following errors:\n${collectResult.unresolvedErrors.join("\n")}\n\nCurrent merged output:\n${collectResult.mergedOutput}`,
      goalEnvelope: parent.goalEnvelope,
      parentId: collectorNode.id,
      depth: parent.depth + 1
    });
    collectorNode.children.push(repairNode.id);
    this.tree.nodes[repairNode.id] = repairNode;
    this.tree.totalNodes++;
    this.emitDurableEvent("repair_agent_created", repairNode.id, { parentId: parent.id, errors: collectResult.unresolvedErrors });
    this.emitNodeCreated(repairNode);
    // Process repair agent
    await this.executeWithVerification(repairNode);
  }

  private async processSteeringQueue(node: RecursiveSwarmNode): Promise<void> {
    const pending = node.steeringQueue.filter((m) => !m.applied && !m.supersededAt);
    if (pending.length === 0) return;
    for (const msg of pending) {
      msg.checkpoint = node.status === "assessing" ? "pre_split" : node.status === "executing" ? "pre_execute" : "post_steer";
      if (this.provider) {
        try {
          const classification = await invokeReasoningProviderStructured<{ type: string }>(
            this.provider,
            {
              systemPrompt: `Classify this steering message for a task agent. Respond with one of: "question", "task_modification", "restart", "resplit".`,
              userPrompt: `Current task: ${node.taskPrompt}\nSteering: ${msg.text}`,
              maxOutputTokens: 64
            },
            {
              name: "steering_classification",
              type: "object",
              properties: { type: { type: "string", enum: ["question", "task_modification", "restart", "resplit"] } },
              required: ["type"]
            }
          );
          msg.classification = classification.type as SteeringMessage["classification"];
        } catch {
          msg.classification = "question";
        }
      } else {
        msg.classification = "question";
      }
      msg.applied = true;
      if (msg.classification === "restart") {
        node.revision++;
        node.taskPrompt = msg.text;
        node.status = "created";
        this.emitNodeStatusChanged(node);
      } else if (msg.classification === "resplit") {
        node.revision++;
        node.complexity = undefined;
        node.splitResult = undefined;
        node.children = [];
        node.status = "created";
        this.emitNodeStatusChanged(node);
      }
    }
  }

  private async checkGoalAt(node: RecursiveSwarmNode, checkpoint: GoalCheckResult["checkpoint"]): Promise<void> {
    if (!this.runOptions.enableGoalKeeper) return;
    const lastCheck = node.goalChecks[node.goalChecks.length - 1];
    if (lastCheck && !this.goalKeeper.shouldRecheck(lastCheck) && lastCheck.checkpoint !== checkpoint) return;
    const result = await this.goalKeeper.checkAlignment(node, { pack: node.evidencePack });
    result.checkpoint = checkpoint;
    node.goalChecks.push(result);
    this.goalCheckHistory.push(result);
    this.emitDurableEvent("goal_check", node.id, { checkpoint, aligned: result.aligned, status: result.status });
    if (!result.aligned && (result.status === "major_drift" || result.status === "unknown")) {
      node.status = "blocked";
      node.errorSummary = `Goal drift at ${checkpoint}: ${result.findings.join("; ")}`;
    }
  }

  private createNode(input: {
    name: string;
    kind: RecursiveSwarmNode["kind"];
    taskPrompt: string;
    goalEnvelope: GoalEnvelope;
    parentId?: string;
    depth: number;
  }): RecursiveSwarmNode {
    const nodeId = `recursive_node_${randomUUID()}`;
    const pack = this.buildPack?.(input.taskPrompt, nodeId);
    if (pack) {
      this.contextSourceCounts[pack.context_source]++;
    }
    return {
      schema_version: RECURSIVE_SWARM_SCHEMA_VERSION,
      id: nodeId,
      parentId: input.parentId,
      runId: this.tree?.runId ?? `run_${randomUUID()}`,
      kind: input.kind,
      status: "created",
      name: input.name,
      role: this.nodeKindToRole(input.kind),
      goalEnvelope: input.goalEnvelope,
      taskPrompt: input.taskPrompt,
      depth: input.depth,
      goalChecks: [],
      steeringQueue: [],
      children: [],
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      evidencePack: pack
    };
  }

  private nodeKindToRole(kind: RecursiveSwarmNode["kind"]): string {
    switch (kind) {
      case "root": return "Root Orchestrator";
      case "task_agent": return "Task Agent";
      case "goal_keeper": return "Goal Keeper";
      case "collector": return "Collector";
      case "repair_agent": return "Repair Agent";
    }
  }

  private toSwarmNodeKind(kind: RecursiveSwarmNode["kind"]): AgentRuntimeSwarmNodeKind {
    switch (kind) {
      case "root": return "root";
      case "task_agent": return "worker";
      case "goal_keeper": return "gate";
      case "collector": return "aggregator";
      case "repair_agent": return "worker";
    }
  }

  private toSwarmStatus(status: RecursiveSwarmNode["status"]): AgentRuntimeSwarmNode["status"] {
    switch (status) {
      case "created": return "idle";
      case "assessing":
      case "splitting":
      case "waiting_children":
      case "collecting":
      case "verifying": return "queued";
      case "executing": return "running";
      case "succeeded": return "completed";
      case "blocked":
      case "escalated": return "blocked";
      case "failed": return "failed";
      case "superseded": return "completed";
      case "queued": return "queued";
    }
    return "idle";
  }

  private getCurrentAction(node: RecursiveSwarmNode): string | undefined {
    switch (node.status) {
      case "assessing": return "Assessing task atomicity...";
      case "splitting": return "Splitting task into sub-tasks...";
      case "waiting_children": return `Waiting for ${node.children.length} child agent(s)...`;
      case "executing": return "Executing task...";
      case "verifying": return "Verifying results...";
      case "collecting": return "Collecting results from children...";
      case "succeeded": return "Completed.";
      case "failed": return node.errorSummary ?? "Failed.";
      case "blocked": return node.errorSummary ?? "Blocked.";
      case "escalated": return node.errorSummary ?? "Escalated.";
      case "superseded": return "Superseded by newer revision.";
      default: return undefined;
    }
  }

  private getLatestAlignment(node: RecursiveSwarmNode): boolean {
    const last = node.goalChecks[node.goalChecks.length - 1];
    return last ? last.aligned : true;
  }

  private hasAnyFailed(): boolean {
    return Object.values(this.tree.nodes).some(
      (n) => n.status === "failed" || n.status === "blocked" || n.status === "escalated"
    );
  }

  private collectUnresolvedErrors(): string[] {
    const errors: string[] = [];
    for (const n of Object.values(this.tree.nodes)) {
      if (n.collectResult?.unresolvedErrors) errors.push(...n.collectResult.unresolvedErrors);
      if (n.errorSummary && (n.status === "failed" || n.status === "blocked")) {
        errors.push(`[${n.name}] ${n.errorSummary}`);
      }
    }
    return [...new Set(errors)];
  }

  private emitDurableEvent(type: DurableSwarmEvent["type"], nodeId?: string, data: Record<string, unknown> = {}): void {
    const event: DurableSwarmEvent = { id: `durable_${randomUUID().slice(0, 8)}`, type, nodeId, data, createdAt: new Date().toISOString() };
    this.durableEvents.push(event);
    this.runState.durableEvents.push(event);
    this.runState.updatedAt = new Date().toISOString();
    this.onDurableEvent?.(event);
  }

  private emitNodeCreated(node: RecursiveSwarmNode): void {
    this.emitDurableEvent("node_created", node.id, { kind: node.kind, name: node.name, depth: node.depth });
    this.onNodeCreated?.(node);
  }

  private emitNodeStatusChanged(node: RecursiveSwarmNode): void {
    this.tree.updatedAt = new Date().toISOString();
    this.tree.nodes[node.id] = { ...node };
    this.emitDurableEvent("node_status_changed", node.id, { status: node.status });
    this.onNodeStatusChanged?.(node);
    this.emitTreeUpdated();
  }

  private emitTreeUpdated(): void {
    this.onTreeUpdated?.(this.tree);
  }
}
