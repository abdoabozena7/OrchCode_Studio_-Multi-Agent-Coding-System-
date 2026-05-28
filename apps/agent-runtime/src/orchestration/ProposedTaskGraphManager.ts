import path from "node:path";
import { OrchestrationArtifactStore } from "./ArtifactStore.js";
import { FactoryMetadataAdapter, FactoryMetadataStore, resolveFactoryMetadataDatabasePath } from "./FactoryMetadataStore.js";
import { FactoryTraceWriter } from "./FactoryTraceWriter.js";
import type { OrchestrationSafetyConfig } from "./OrchestrationConfig.js";
import type { Task } from "./OrchestrationModels.js";
import type { AdoptedTaskProposal, ReadOrWriteClassification, TaskAdoptionStatus, TaskReadinessStatus } from "./TeamTaskAdoptionModels.js";
import {
  createProposedTaskGraph,
  createProposedTaskGraphBuildRequest,
  createProposedTaskGraphBuildResult,
  createProposedTaskGraphEdge,
  createProposedTaskGraphNode,
  createProposedTaskGraphSummary,
  createProposedTaskGraphValidationResult,
  proposedNodeSignature,
  type ProposedTaskGraph,
  type ProposedTaskGraphBuildResult,
  type ProposedTaskGraphEdge,
  type ProposedTaskGraphEdgeType,
  type ProposedTaskGraphNode,
  type ProposedTaskGraphNodeStatus,
  type ProposedTaskGraphSourceRef,
  type ProposedTaskGraphValidationResult
} from "./ProposedTaskGraphModels.js";
import type { TeamSubPlanValidationStrategy } from "./TeamSubPlanningModels.js";

export type ProposedTaskGraphManagerOptions = {
  workspacePath: string;
  memoryDir?: string;
  config: OrchestrationSafetyConfig;
  artifactStore?: OrchestrationArtifactStore;
  traceWriter?: FactoryTraceWriter;
};

export type ProposedTaskGraphBuildOptions = {
  adoptedProposals?: AdoptedTaskProposal[];
  existingTasks?: Task[];
};

type AdoptedProposalRow = {
  adopted_task_id: string;
  run_id: string;
  team_id: string;
  sub_plan_id: string;
  source_task_draft_id: string;
  parent_task_id?: string;
  title: string;
  objective: string;
  task_type: string;
  read_or_write_classification: string;
  proposed_role: string;
  adoption_status: string;
  readiness_status: string;
  risk_level: string;
  allowed_files_json: string;
  forbidden_files_json: string;
  read_only_files_json: string;
  module_locks_json: string;
  semantic_locks_json: string;
  dependencies_json: string;
  validation_refs_json: string;
  success_criteria_json: string;
  stop_conditions_json: string;
  prompt_template_ref?: string;
  context_pack_ref?: string;
  evidence_refs_json: string;
  artifact_ref?: string;
  readiness_ref?: string;
  decision_ref?: string;
  trace_event_id?: string;
  metadata_json: string;
  created_at: string;
};

type AdoptionDecisionRow = {
  adoption_decision_id: string;
  run_id: string;
  team_id: string;
  sub_plan_id: string;
  task_draft_id: string;
  adopted_task_id?: string;
  adoption_status: string;
  readiness_status: string;
  reason: string;
  artifact_ref?: string;
  readiness_ref?: string;
  trace_event_id?: string;
  metadata_json: string;
  created_at: string;
};

export class ProposedTaskGraphManager {
  private readonly workspacePath: string;
  private readonly memoryDir?: string;
  private readonly artifactStore: OrchestrationArtifactStore;
  private readonly traceWriter: FactoryTraceWriter;
  private readonly metadata: FactoryMetadataAdapter;

  constructor(private readonly options: ProposedTaskGraphManagerOptions) {
    this.workspacePath = path.resolve(options.workspacePath);
    this.memoryDir = options.memoryDir;
    this.artifactStore = options.artifactStore ?? new OrchestrationArtifactStore(this.workspacePath, this.memoryDir);
    this.traceWriter = options.traceWriter ?? new FactoryTraceWriter({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, sourceComponent: "ProposedTaskGraphManager" });
    this.metadata = new FactoryMetadataAdapter(this.workspacePath, this.memoryDir);
  }

  async buildProposedGraphFromAdoptedTasks(runId: string, options: ProposedTaskGraphBuildOptions = {}): Promise<ProposedTaskGraphBuildResult> {
    const request = createProposedTaskGraphBuildRequest({
      run_id: runId,
      mode: this.options.config.proposed_task_graph_mode,
      max_nodes: this.options.config.max_proposed_nodes_per_run,
      max_edges: this.options.config.max_proposed_edges_per_run,
      block_cycles: this.options.config.block_cycles,
      dedupe_proposed_nodes: this.options.config.dedupe_proposed_nodes,
      adopted_proposals: options.adoptedProposals,
      existing_task_refs: options.existingTasks?.map((task) => task.id) ?? [],
      requested_by: "ProposedTaskGraphManager",
      metadata_json: { non_executable_graph_only: true }
    });
    await this.traceWriter.write({
      run_id: runId,
      event_type: "proposed_task_graph_build_started",
      lifecycle_stage: "planning",
      summary: "Proposed task graph build started.",
      metadata_json: {
        run_id: runId,
        mode: request.mode,
        max_nodes: request.max_nodes,
        max_edges: request.max_edges
      }
    });

    if (!this.options.config.enable_proposed_task_graph || this.options.config.proposed_task_graph_mode === "off") {
      return this.skippedResult(runId, "proposed_task_graph_disabled");
    }

    const proposals = options.adoptedProposals ?? await this.loadAdoptedProposals(runId);
    const rejectedDecisionNodes = await this.loadRejectedDecisionNodes(runId);
    const nodes = [
      ...proposals.map((proposal) => this.addProposedNodeFromAdoptedTask(proposal)),
      ...rejectedDecisionNodes
    ].slice(0, request.max_nodes);

    if (!nodes.length) return this.skippedResult(runId, "no_adopted_task_proposals");

    const edges: ProposedTaskGraphEdge[] = [];
    const addEdge = (edge: ProposedTaskGraphEdge) => {
      if (edges.length < request.max_edges && !edges.some((candidate) => sameEdge(candidate, edge))) edges.push(edge);
    };
    for (const edge of this.dependencyEdges(runId, nodes)) addEdge(edge);
    for (const edge of this.parentChildEdges(runId, nodes, options.existingTasks ?? [])) addEdge(edge);
    if (request.dedupe_proposed_nodes) {
      for (const edge of this.duplicateEdges(runId, nodes)) addEdge(edge);
    }
    for (const edge of this.scopeAndLockEdges(runId, nodes)) addEdge(edge);

    const graph = createProposedTaskGraph({
      run_id: runId,
      status: "created",
      nodes,
      edges,
      metadata_json: {
        non_executable: true,
        node_limit_applied: nodes.length >= request.max_nodes,
        edge_limit_applied: edges.length >= request.max_edges,
        existing_task_count: options.existingTasks?.length ?? 0
      }
    });
    for (const edge of graph.edges) edge.graph_id = graph.graph_id;
    const validation = this.validateProposedGraph(graph);
    graph.validation = validation;
    graph.status = validation.valid ? "validated" : "invalid";
    if (request.block_cycles && validation.cycles.length) {
      const cycleNodeIds = new Set(validation.cycles.flat());
      for (const node of graph.nodes) {
        if (cycleNodeIds.has(node.proposed_node_id)) this.markProposedNodeStatusInGraph(graph, node.proposed_node_id, "blocked", "Dependency cycle requires a future approval gate review.");
      }
    }

    await this.emitGraphEvents(graph, validation);
    const refs = await this.artifactStore.saveProposedTaskGraph(graph, validation, this.summarizeProposedGraph(graph));
    graph.artifact_ref = refs.graphRef;
    graph.nodes_ref = refs.nodesRef;
    graph.edges_ref = refs.edgesRef;
    graph.validation_ref = refs.validationRef;
    graph.summary_ref = refs.summaryRef;
    validation.artifact_ref = refs.validationRef;
    const persistedTrace = await this.traceWriter.write({
      run_id: runId,
      event_type: "proposed_task_graph_persisted",
      lifecycle_stage: "planning",
      summary: `Proposed task graph persisted with ${graph.nodes.length} node(s).`,
      artifact_refs: Object.values(refs),
      metadata_json: {
        run_id: runId,
        graph_id: graph.graph_id,
        proposed_node_count: graph.nodes.length,
        proposed_edge_count: graph.edges.length,
        status: graph.status
      }
    });
    graph.trace_event_id = persistedTrace.trace_event_id;
    await this.metadata.recordProposedTaskGraphSaved(graph);
    for (const node of graph.nodes) await this.metadata.recordProposedTaskNodeSaved(graph.graph_id, node);
    for (const edge of graph.edges) await this.metadata.recordProposedTaskEdgeSaved(graph.graph_id, edge);
    await this.metadata.recordProposedTaskGraphValidationSaved(validation);

    const summary = this.summarizeProposedGraph(graph);
    summary.graph_summary_ref = graph.summary_ref;
    await this.traceWriter.write({
      run_id: runId,
      event_type: "proposed_task_graph_summary_created",
      lifecycle_stage: "planning",
      summary: "Proposed task graph summary created.",
      artifact_refs: [refs.summaryRef],
      metadata_json: {
        run_id: runId,
        graph_id: graph.graph_id,
        proposed_node_count: summary.proposed_node_count,
        proposed_edge_count: summary.proposed_edge_count,
        cycle_count: summary.cycle_count,
        scope_overlap_count: summary.scope_overlap_count
      }
    });
    return createProposedTaskGraphBuildResult({
      run_id: runId,
      graph,
      validation,
      summary,
      artifact_refs: Object.values(refs),
      skipped: false
    });
  }

  addProposedNodeFromAdoptedTask(proposal: AdoptedTaskProposal): ProposedTaskGraphNode {
    const status = statusFromProposal(proposal, this.options.config.proposed_task_graph_mode);
    const node = createProposedTaskGraphNode({
      proposed_node_id: `proposed_node_${proposal.adopted_task_id}`,
      run_id: proposal.run_id,
      team_id: proposal.team_id,
      sub_plan_id: proposal.sub_plan_id,
      adopted_task_id: proposal.adopted_task_id,
      source_task_draft_id: proposal.source_task_draft_id,
      title: proposal.title,
      objective: proposal.objective,
      task_type: proposal.task_type,
      read_or_write_classification: proposal.read_or_write_classification,
      proposed_role: proposal.proposed_role,
      status,
      readiness_status: proposal.readiness_status,
      adoption_status: proposal.adoption_status,
      allowed_files: proposal.allowed_files,
      forbidden_files: proposal.forbidden_files,
      read_only_files: proposal.read_only_files,
      module_locks: proposal.module_locks,
      semantic_locks: proposal.semantic_locks,
      dependencies: proposal.dependencies,
      validation_strategy: proposal.validation_strategy,
      success_criteria: proposal.success_criteria,
      stop_conditions: proposal.stop_conditions,
      prompt_template_ref: proposal.prompt_template_ref,
      context_pack_ref: proposal.context_pack_ref,
      evidence_refs: proposal.evidence_refs,
      risk_level: proposal.risk_level,
      non_executable_reason: nonExecutableReason(proposal.read_or_write_classification, status),
      source_refs: [
        sourceRef("adopted_task_proposal", proposal.adopted_task_id, proposal.artifact_ref),
        ...(proposal.readiness_ref ? [sourceRef("task_readiness_result", proposal.readiness_ref, proposal.readiness_ref)] : []),
        ...(proposal.sub_plan_id ? [sourceRef("team_sub_plan", proposal.sub_plan_id)] : [])
      ],
      artifact_ref: proposal.artifact_ref,
      metadata_json: {
        imported_from_adoption_gate: true,
        no_executor_task_created: true,
        no_scheduler_enqueue: true,
        source_metadata: proposal.metadata_json
      }
    });
    return this.applyNodeSafetyStatus(node);
  }

  addProposedEdge(input: Omit<ProposedTaskGraphEdge, "proposed_edge_id" | "created_at" | "metadata_json" | "source_refs"> & {
    proposed_edge_id?: string;
    metadata_json?: Record<string, unknown>;
    source_refs?: ProposedTaskGraphSourceRef[];
  }) {
    return createProposedTaskGraphEdge(input);
  }

  validateProposedGraph(graph: ProposedTaskGraph): ProposedTaskGraphValidationResult {
    const cycles = this.detectProposedGraphCycles(graph);
    const duplicates = this.detectDuplicateProposedNodes(graph);
    const scopeOverlaps = this.detectScopeOverlaps(graph);
    const warnings = [
      ...cycles.map((cycle) => `Dependency cycle: ${cycle.join(" -> ")}`),
      ...duplicates.map((group) => `Duplicate proposed nodes: ${group.join(", ")}`),
      ...scopeOverlaps.map((overlap) => `Scope overlap: ${overlap.node_ids.join(", ")} share ${overlap.shared_refs.join(", ")}`),
      ...graph.nodes.filter((node) => node.read_or_write_classification !== "read_only" && !node.validation_strategy?.commands.length && !node.validation_strategy?.required_checks.length)
        .map((node) => `Write candidate ${node.proposed_node_id} needs validation strategy.`),
      ...graph.nodes.filter((node) => node.read_or_write_classification !== "read_only" && !node.success_criteria.length)
        .map((node) => `Write candidate ${node.proposed_node_id} needs success criteria.`)
    ];
    return createProposedTaskGraphValidationResult({
      run_id: graph.run_id,
      graph_id: graph.graph_id,
      valid: cycles.length === 0,
      cycle_count: cycles.length,
      duplicate_count: duplicates.length,
      scope_overlap_count: scopeOverlaps.length,
      blocked_node_count: graph.nodes.filter((node) => node.status === "blocked" || node.status.startsWith("needs_")).length,
      warnings,
      cycles,
      duplicate_groups: duplicates,
      scope_overlaps: scopeOverlaps,
      metadata_json: { non_executable_validation_only: true }
    });
  }

  detectProposedGraphCycles(graph: Pick<ProposedTaskGraph, "nodes" | "edges">) {
    const depends = graph.edges.filter((edge) => edge.edge_type === "depends_on");
    const adjacency = new Map<string, string[]>();
    for (const edge of depends) {
      adjacency.set(edge.source_node_id, [...(adjacency.get(edge.source_node_id) ?? []), edge.target_node_id]);
    }
    const cycles: string[][] = [];
    const stack: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string) => {
      if (visiting.has(nodeId)) {
        const start = stack.indexOf(nodeId);
        cycles.push([...stack.slice(start), nodeId]);
        return;
      }
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      stack.push(nodeId);
      for (const target of adjacency.get(nodeId) ?? []) visit(target);
      stack.pop();
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    for (const node of graph.nodes) visit(node.proposed_node_id);
    return cycles;
  }

  detectDuplicateProposedNodes(graph: Pick<ProposedTaskGraph, "nodes">) {
    const groups = new Map<string, string[]>();
    for (const node of graph.nodes) {
      const signature = proposedNodeSignature(node);
      groups.set(signature, [...(groups.get(signature) ?? []), node.proposed_node_id]);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }

  detectScopeOverlaps(graph: Pick<ProposedTaskGraph, "nodes">) {
    const overlaps: Array<{ node_ids: string[]; shared_refs: string[]; reason: string }> = [];
    for (let i = 0; i < graph.nodes.length; i += 1) {
      for (let j = i + 1; j < graph.nodes.length; j += 1) {
        const left = graph.nodes[i];
        const right = graph.nodes[j];
        const sharedFiles = intersection([...left.allowed_files, ...left.read_only_files], [...right.allowed_files, ...right.read_only_files]);
        const sharedLocks = intersection([...left.module_locks, ...left.semantic_locks], [...right.module_locks, ...right.semantic_locks]);
        if (sharedFiles.length || sharedLocks.length) {
          overlaps.push({
            node_ids: [left.proposed_node_id, right.proposed_node_id],
            shared_refs: uniqueStrings([...sharedFiles, ...sharedLocks]),
            reason: sharedLocks.length ? "shared lock context" : "shared file scope"
          });
        }
      }
    }
    return overlaps;
  }

  summarizeProposedGraph(graph: ProposedTaskGraph) {
    const validation = graph.validation;
    return createProposedTaskGraphSummary({
      graph_id: graph.graph_id,
      run_id: graph.run_id,
      status: graph.status,
      proposed_node_count: graph.nodes.length,
      proposed_edge_count: graph.edges.length,
      read_only_ready_count: graph.nodes.filter((node) => node.status === "read_only_ready").length,
      future_write_candidate_count: graph.nodes.filter((node) => node.status === "future_write_candidate" || node.status === "ready_for_approval_gate").length,
      blocked_count: graph.nodes.filter((node) => node.status === "blocked" || node.status.startsWith("needs_")).length,
      duplicate_count: graph.nodes.filter((node) => node.status === "duplicate").length + (validation?.duplicate_count ?? 0),
      cycle_count: validation?.cycle_count ?? 0,
      scope_overlap_count: validation?.scope_overlap_count ?? 0,
      graph_summary_ref: graph.summary_ref,
      metadata_json: { non_executable: true }
    });
  }

  markProposedNodeStatus(nodeId: string, status: ProposedTaskGraphNodeStatus, reason: string) {
    return { nodeId, status, reason };
  }

  async listProposedNodesForRun(runId: string) {
    return this.readNodes("WHERE run_id = ?", runId);
  }

  async listProposedNodesForTeam(teamId: string) {
    return this.readNodes("WHERE team_id = ?", teamId);
  }

  private async skippedResult(runId: string, reason: string): Promise<ProposedTaskGraphBuildResult> {
    const graph = createProposedTaskGraph({
      run_id: runId,
      status: reason === "no_adopted_task_proposals" ? "not_required" : "skipped",
      nodes: [],
      edges: [],
      metadata_json: { reason, non_executable: true }
    });
    const validation = this.validateProposedGraph(graph);
    graph.validation = validation;
    const summary = this.summarizeProposedGraph(graph);
    await this.traceWriter.write({
      run_id: runId,
      event_type: "proposed_task_graph_build_skipped",
      lifecycle_stage: "planning",
      severity: "warning",
      reason,
      summary: `Proposed task graph build skipped: ${reason}.`,
      metadata_json: { run_id: runId, graph_id: graph.graph_id, reason }
    });
    const refs = await this.artifactStore.saveProposedTaskGraph(graph, validation, summary);
    graph.artifact_ref = refs.graphRef;
    graph.nodes_ref = refs.nodesRef;
    graph.edges_ref = refs.edgesRef;
    graph.validation_ref = refs.validationRef;
    graph.summary_ref = refs.summaryRef;
    validation.artifact_ref = refs.validationRef;
    await this.metadata.recordProposedTaskGraphSaved(graph);
    await this.metadata.recordProposedTaskGraphValidationSaved(validation);
    return createProposedTaskGraphBuildResult({
      run_id: runId,
      graph,
      validation,
      summary: { ...summary, graph_summary_ref: refs.summaryRef },
      artifact_refs: Object.values(refs),
      skipped: true,
      reason
    });
  }

  private dependencyEdges(runId: string, nodes: ProposedTaskGraphNode[]) {
    const byAdoptedId = new Map(nodes.map((node) => [node.adopted_task_id, node]).filter((entry): entry is [string, ProposedTaskGraphNode] => Boolean(entry[0])));
    const byDraftId = new Map(nodes.map((node) => [node.source_task_draft_id, node]).filter((entry): entry is [string, ProposedTaskGraphNode] => Boolean(entry[0])));
    const byTitle = new Map(nodes.map((node) => [normalize(node.title), node]));
    const edges: ProposedTaskGraphEdge[] = [];
    for (const node of nodes) {
      for (const dependency of node.dependencies) {
        const target = byAdoptedId.get(dependency) ?? byDraftId.get(dependency) ?? byTitle.get(normalize(dependency));
        if (!target || target.proposed_node_id === node.proposed_node_id) continue;
        edges.push(createProposedTaskGraphEdge({
          run_id: runId,
          source_node_id: node.proposed_node_id,
          target_node_id: target.proposed_node_id,
          edge_type: "depends_on",
          reason: `Adopted proposal dependency ${dependency}.`,
          source_refs: [sourceRef("adopted_task_proposal", node.adopted_task_id ?? node.proposed_node_id)]
        }));
      }
    }
    return edges;
  }

  private parentChildEdges(runId: string, nodes: ProposedTaskGraphNode[], existingTasks: Task[]) {
    const byAdoptedId = new Map(nodes.map((node) => [node.adopted_task_id, node]).filter((entry): entry is [string, ProposedTaskGraphNode] => Boolean(entry[0])));
    const edges: ProposedTaskGraphEdge[] = [];
    for (const node of nodes) {
      const parentRef = stringFromMetadata(node.metadata_json, "parent_task_id");
      if (parentRef && byAdoptedId.has(parentRef)) {
        const parent = byAdoptedId.get(parentRef)!;
        node.parent_proposed_node_id = parent.proposed_node_id;
        edges.push(createProposedTaskGraphEdge({
          run_id: runId,
          source_node_id: parent.proposed_node_id,
          target_node_id: node.proposed_node_id,
          edge_type: "parent_child",
          reason: "Adopted proposal parent relation.",
          source_refs: [sourceRef("adopted_task_proposal", node.adopted_task_id ?? node.proposed_node_id)]
        }));
      } else if (parentRef && existingTasks.some((task) => task.id === parentRef)) {
        node.source_refs.push(sourceRef("existing_task_graph", parentRef));
      }
    }
    return edges;
  }

  private duplicateEdges(runId: string, nodes: ProposedTaskGraphNode[]) {
    const edges: ProposedTaskGraphEdge[] = [];
    for (const group of this.detectDuplicateProposedNodes({ nodes })) {
      const [first, ...rest] = group;
      for (const duplicate of rest) {
        edges.push(createProposedTaskGraphEdge({
          run_id: runId,
          source_node_id: duplicate,
          target_node_id: first,
          edge_type: "duplicates",
          reason: "Duplicate proposed node signature.",
          source_refs: [sourceRef("adopted_task_proposal", duplicate)]
        }));
      }
    }
    return edges;
  }

  private scopeAndLockEdges(runId: string, nodes: ProposedTaskGraphNode[]) {
    const edges: ProposedTaskGraphEdge[] = [];
    for (const overlap of this.detectScopeOverlaps({ nodes })) {
      const [left, right] = overlap.node_ids;
      edges.push(createProposedTaskGraphEdge({
        run_id: runId,
        source_node_id: left,
        target_node_id: right,
        edge_type: overlap.shared_refs.some((ref) => ref.startsWith("module:") || ref.startsWith("semantic:")) ? "requires_same_lock" : "shares_scope_with",
        reason: overlap.reason,
        source_refs: overlap.shared_refs.map((ref) => sourceRef(ref.startsWith("module:") || ref.startsWith("semantic:") ? "team_context_scope" : "adopted_task_proposal", ref))
      }));
    }
    return edges;
  }

  private applyNodeSafetyStatus(node: ProposedTaskGraphNode) {
    if (node.read_or_write_classification !== "read_only" && node.status === "read_only_ready") node.status = "metadata_only";
    if (node.read_or_write_classification !== "read_only" && node.readiness_status === "future_write_candidate") node.status = "future_write_candidate";
    if (node.read_or_write_classification !== "read_only" && !node.validation_strategy?.commands.length && !node.validation_strategy?.required_checks.length) node.status = "needs_validation_strategy";
    if (node.read_or_write_classification !== "read_only" && !node.success_criteria.length) node.status = "needs_success_criteria";
    if (node.read_or_write_classification !== "read_only" && ![...node.module_locks, ...node.semantic_locks].length) node.status = "needs_locks";
    if (node.forbidden_files.some((file) => node.allowed_files.includes(file) || node.read_only_files.includes(file))) node.status = "blocked";
    node.non_executable_reason = nonExecutableReason(node.read_or_write_classification, node.status);
    return node;
  }

  private markProposedNodeStatusInGraph(graph: ProposedTaskGraph, nodeId: string, status: ProposedTaskGraphNodeStatus, reason: string) {
    const node = graph.nodes.find((candidate) => candidate.proposed_node_id === nodeId);
    if (!node) return;
    node.status = status;
    node.non_executable_reason = reason;
    node.updated_at = new Date().toISOString();
  }

  private async emitGraphEvents(graph: ProposedTaskGraph, validation: ProposedTaskGraphValidationResult) {
    for (const node of graph.nodes) {
      const trace = await this.traceWriter.write({
        run_id: graph.run_id,
        team_id: node.team_id,
        event_type: "proposed_task_graph_node_created",
        lifecycle_stage: "planning",
        reason: node.non_executable_reason,
        summary: `Proposed task graph node ${node.proposed_node_id} is ${node.status}.`,
        artifact_refs: node.artifact_ref ? [node.artifact_ref] : [],
        metadata_json: nodeTraceMetadata(graph.graph_id, node)
      });
      node.trace_event_id = trace.trace_event_id;
      if (node.status === "blocked" || node.status.startsWith("needs_")) {
        await this.traceWriter.write({
          run_id: graph.run_id,
          team_id: node.team_id,
          event_type: "proposed_task_graph_node_blocked",
          lifecycle_stage: "planning",
          severity: "warning",
          reason: node.non_executable_reason,
          summary: `Proposed task graph node ${node.proposed_node_id} is blocked from execution.`,
          artifact_refs: node.artifact_ref ? [node.artifact_ref] : [],
          metadata_json: nodeTraceMetadata(graph.graph_id, node)
        });
      }
    }
    for (const edge of graph.edges) {
      const trace = await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "proposed_task_graph_edge_created",
        lifecycle_stage: "planning",
        summary: `Proposed task graph edge ${edge.edge_type} created.`,
        metadata_json: {
          run_id: graph.run_id,
          graph_id: graph.graph_id,
          proposed_edge_id: edge.proposed_edge_id,
          source_node_id: edge.source_node_id,
          target_node_id: edge.target_node_id,
          edge_type: edge.edge_type,
          reason: edge.reason
        }
      });
      edge.trace_event_id = trace.trace_event_id;
    }
    for (const group of validation.duplicate_groups) {
      await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "proposed_task_graph_duplicate_detected",
        lifecycle_stage: "planning",
        severity: "warning",
        summary: "Duplicate proposed task graph nodes detected.",
        metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, duplicate_group: group }
      });
    }
    for (const overlap of validation.scope_overlaps) {
      await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "proposed_task_graph_scope_overlap_detected",
        lifecycle_stage: "planning",
        severity: "warning",
        summary: "Proposed task graph scope overlap detected.",
        metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, ...overlap }
      });
    }
    for (const cycle of validation.cycles) {
      await this.traceWriter.write({
        run_id: graph.run_id,
        event_type: "proposed_task_graph_cycle_detected",
        lifecycle_stage: "planning",
        severity: "warning",
        summary: "Proposed task graph cycle detected.",
        metadata_json: { run_id: graph.run_id, graph_id: graph.graph_id, cycle }
      });
    }
    const trace = await this.traceWriter.write({
      run_id: graph.run_id,
      event_type: "proposed_task_graph_validated",
      lifecycle_stage: "planning",
      severity: validation.valid ? "info" : "warning",
      summary: `Proposed task graph validation ${validation.valid ? "passed" : "requires review"}.`,
      metadata_json: {
        run_id: graph.run_id,
        graph_id: graph.graph_id,
        cycle_count: validation.cycle_count,
        duplicate_count: validation.duplicate_count,
        scope_overlap_count: validation.scope_overlap_count,
        blocked_node_count: validation.blocked_node_count
      }
    });
    validation.trace_event_id = trace.trace_event_id;
  }

  private async loadAdoptedProposals(runId: string): Promise<AdoptedTaskProposal[]> {
    try {
      const store = await this.openReadOnlyStore();
      try {
        return store.all<AdoptedProposalRow>(
          "SELECT * FROM factory_adopted_task_proposals WHERE run_id = ? ORDER BY created_at",
          runId
        ).map(proposalFromRow);
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }

  private async loadRejectedDecisionNodes(runId: string): Promise<ProposedTaskGraphNode[]> {
    try {
      const store = await this.openReadOnlyStore();
      try {
        return store.all<AdoptionDecisionRow>(
          "SELECT * FROM factory_task_adoption_decisions WHERE run_id = ? AND adopted_task_id IS NULL ORDER BY created_at",
          runId
        ).map((row) => this.nodeFromRejectedDecision(row));
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }

  private nodeFromRejectedDecision(row: AdoptionDecisionRow): ProposedTaskGraphNode {
    const status = statusFromAdoptionDecision(row.adoption_status);
    return createProposedTaskGraphNode({
      proposed_node_id: `proposed_node_${row.adoption_decision_id}`,
      run_id: row.run_id,
      team_id: row.team_id,
      sub_plan_id: row.sub_plan_id,
      source_task_draft_id: row.task_draft_id,
      title: `Rejected draft ${row.task_draft_id}`,
      objective: row.reason,
      task_type: "adoption_decision",
      read_or_write_classification: "unknown",
      proposed_role: "PlannerAgent",
      status,
      readiness_status: row.readiness_status as TaskReadinessStatus,
      adoption_status: row.adoption_status as TaskAdoptionStatus,
      allowed_files: [],
      forbidden_files: [],
      read_only_files: [],
      module_locks: [],
      semantic_locks: [],
      dependencies: [],
      success_criteria: [],
      stop_conditions: [],
      evidence_refs: [],
      risk_level: "medium",
      non_executable_reason: row.reason,
      source_refs: [sourceRef("task_adoption_decision", row.adoption_decision_id, row.artifact_ref)],
      artifact_ref: row.artifact_ref,
      metadata_json: {
        decision_metadata: parseJsonRecord(row.metadata_json),
        no_executor_task_created: true,
        no_scheduler_enqueue: true
      },
      created_at: row.created_at
    });
  }

  private async readNodes(whereClause: string, value: string): Promise<ProposedTaskGraphNode[]> {
    try {
      const store = await this.openReadOnlyStore();
      try {
        return store.all<{ metadata_json: string }>(
          `SELECT metadata_json FROM factory_proposed_task_nodes ${whereClause} ORDER BY created_at`,
          value
        ).map((row) => parseJsonRecord(row.metadata_json).node).filter((node): node is ProposedTaskGraphNode => Boolean(node));
      } finally {
        store.close();
      }
    } catch {
      return [];
    }
  }

  private async openReadOnlyStore() {
    const databasePath = await resolveFactoryMetadataDatabasePath(this.workspacePath, this.memoryDir);
    return FactoryMetadataStore.open({ workspacePath: this.workspacePath, memoryDir: this.memoryDir, databasePath, readOnly: true });
  }
}

function statusFromProposal(proposal: AdoptedTaskProposal, mode: "off" | "metadata_only" | "read_only_ready"): ProposedTaskGraphNodeStatus {
  if (proposal.adoption_status === "duplicate") return "duplicate";
  if (proposal.adoption_status === "rejected") return "rejected";
  if (proposal.adoption_status === "out_of_scope" || proposal.adoption_status === "unsafe_write_scope" || proposal.adoption_status === "adopted_blocked") return "blocked";
  if (proposal.adoption_status === "missing_validation") return "needs_validation_strategy";
  if (proposal.adoption_status === "missing_success_criteria") return "needs_success_criteria";
  if (proposal.adoption_status === "missing_locks") return "needs_locks";
  if (proposal.readiness_status === "future_write_candidate") return "future_write_candidate";
  if (proposal.readiness_status === "read_only_ready" && proposal.read_or_write_classification === "read_only" && mode === "read_only_ready") return "read_only_ready";
  if (proposal.adoption_status === "ready_for_future_gate") return "ready_for_approval_gate";
  return "metadata_only";
}

function statusFromAdoptionDecision(status: string): ProposedTaskGraphNodeStatus {
  if (status === "duplicate") return "duplicate";
  if (status === "out_of_scope" || status === "unsafe_write_scope") return "rejected";
  if (status === "missing_validation") return "needs_validation_strategy";
  if (status === "missing_success_criteria") return "needs_success_criteria";
  if (status === "missing_locks") return "needs_locks";
  return "blocked";
}

function nonExecutableReason(classification: ReadOrWriteClassification, status: ProposedTaskGraphNodeStatus) {
  if (classification === "read_only") return "Proposed graph nodes are read-only planning records and are never scheduled directly.";
  if (status === "future_write_candidate" || status === "ready_for_approval_gate") return "Write candidate requires a separate future execution readiness approval gate.";
  if (status === "blocked" || status.startsWith("needs_")) return "Node is blocked in the proposed graph and cannot enter execution.";
  return "Metadata-only proposed graph node; execution is disabled by default.";
}

function proposalFromRow(row: AdoptedProposalRow): AdoptedTaskProposal {
  const validationRefs = parseJsonArray(row.validation_refs_json);
  const validation: TeamSubPlanValidationStrategy = {
    strategy_id: `validation_${row.adopted_task_id}`,
    status: String(parseJsonRecord(row.metadata_json).validation_status ?? "planned") as TeamSubPlanValidationStrategy["status"],
    commands: validationRefs,
    required_checks: validationRefs,
    artifact_refs: [],
    notes: ["Imported from adopted task proposal metadata."],
    metadata_json: {}
  };
  return {
    adopted_task_id: row.adopted_task_id,
    run_id: row.run_id,
    team_id: row.team_id,
    sub_plan_id: row.sub_plan_id,
    source_task_draft_id: row.source_task_draft_id,
    parent_task_id: row.parent_task_id,
    title: row.title,
    objective: row.objective,
    task_type: row.task_type,
    read_or_write_classification: row.read_or_write_classification as ReadOrWriteClassification,
    proposed_role: row.proposed_role,
    adoption_status: row.adoption_status as TaskAdoptionStatus,
    readiness_status: row.readiness_status as TaskReadinessStatus,
    risk_level: row.risk_level as AdoptedTaskProposal["risk_level"],
    allowed_files: parseJsonArray(row.allowed_files_json),
    forbidden_files: parseJsonArray(row.forbidden_files_json),
    read_only_files: parseJsonArray(row.read_only_files_json),
    module_locks: parseJsonArray(row.module_locks_json),
    semantic_locks: parseJsonArray(row.semantic_locks_json),
    dependencies: parseJsonArray(row.dependencies_json),
    validation_strategy: validation,
    success_criteria: parseJsonArray(row.success_criteria_json),
    stop_conditions: parseJsonArray(row.stop_conditions_json),
    prompt_template_ref: row.prompt_template_ref,
    context_pack_ref: row.context_pack_ref,
    evidence_refs: parseJsonArray(row.evidence_refs_json),
    artifact_ref: row.artifact_ref,
    readiness_ref: row.readiness_ref,
    decision_ref: row.decision_ref,
    trace_event_id: row.trace_event_id,
    metadata_json: parseJsonRecord(row.metadata_json),
    created_at: row.created_at
  };
}

function sourceRef(sourceType: ProposedTaskGraphSourceRef["source_type"], sourceRef: string, artifactRef?: string): ProposedTaskGraphSourceRef {
  return { source_type: sourceType, source_ref: sourceRef, artifact_ref: artifactRef, metadata_json: {} };
}

function nodeTraceMetadata(graphId: string, node: ProposedTaskGraphNode) {
  return {
    run_id: node.run_id,
    team_id: node.team_id,
    graph_id: graphId,
    proposed_node_id: node.proposed_node_id,
    adopted_task_id: node.adopted_task_id,
    sub_plan_id: node.sub_plan_id,
    status: node.status,
    readiness_status: node.readiness_status,
    adoption_status: node.adoption_status,
    reason: node.non_executable_reason,
    artifact_refs: node.source_refs.map((ref) => ref.artifact_ref).filter(Boolean)
  };
}

function sameEdge(left: ProposedTaskGraphEdge, right: ProposedTaskGraphEdge) {
  return left.source_node_id === right.source_node_id && left.target_node_id === right.target_node_id && left.edge_type === right.edge_type;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === "string" && value.length ? value : undefined;
}

function intersection(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return uniqueStrings(left.filter((entry) => rightSet.has(entry)));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
