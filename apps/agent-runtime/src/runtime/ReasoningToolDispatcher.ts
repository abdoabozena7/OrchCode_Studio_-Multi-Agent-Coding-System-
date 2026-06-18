import path from "node:path";
import type {
  InvestigationBundle,
  ReasoningToolRequest,
  ReasoningToolResult
} from "@hivo/protocol";
import { assessIndexFreshness, refreshRepoIndex } from "../memory/IndexFreshness.js";
import { semanticNodeEmbeddingText } from "../memory/SemanticProjectModel.js";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import type { SemanticEmbeddingRecord, SemanticProjectNode } from "../memory/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { EvidenceStore } from "./EvidenceStore.js";

export type ReasoningToolDispatcherOptions = {
  sessionId: string;
  tools: ToolRegistry;
  evidenceStore: EvidenceStore;
  onCommandRequest?: (request: ReturnType<ToolRegistry["command"]["requestRun"]>) => Promise<void>;
  onPatchProposal?: (proposal: ReturnType<ToolRegistry["patch"]["propose"]>) => Promise<void>;
  embeddingModel?: string;
  embed?: (inputs: string[], model: string) => Promise<number[][]>;
  delegateReadonly?: (request: ReasoningToolRequest) => Promise<ReasoningToolResult>;
};

const REPOSITORY_SEARCH_RESULT_LIMIT = 30;
const REPOSITORY_SEARCH_EVIDENCE_LIMIT = 12;
const INVESTIGATE_PROJECT_LIMIT = 8;
const INVESTIGATE_NODE_EVIDENCE_LIMIT = 6;
const INVESTIGATE_RELATIONSHIP_EVIDENCE_LIMIT = 6;
const INVESTIGATE_SOURCE_EVIDENCE_LIMIT = 8;
const SEMANTIC_SEARCH_LIMIT = 8;

export class ReasoningToolDispatcher {
  constructor(private readonly options: ReasoningToolDispatcherOptions) {}

  async executeBatch(requests: ReasoningToolRequest[]): Promise<ReasoningToolResult[]> {
    const readOnly = requests.filter(isReadOnlyRequest);
    const stateful = requests.filter((request) => !isReadOnlyRequest(request));
    const results = await Promise.all(readOnly.map((request) => this.execute(request)));
    for (const request of stateful) results.push(await this.execute(request));
    return results;
  }

  async execute(request: ReasoningToolRequest): Promise<ReasoningToolResult> {
    try {
      switch (request.kind) {
        case "list_files":
          return this.listFiles(request);
        case "repository_search":
          return this.search(request);
        case "read_file":
          return this.readFile(request);
        case "inspect_manifest":
          return this.inspectManifest(request);
        case "investigate_project":
          return await this.investigateProject(request);
        case "semantic_search":
          return await this.semanticSearch(request);
        case "follow_relationships":
          return await this.followRelationships(request);
        case "read_semantic_sources":
          return await this.readSemanticSources(request);
        case "run_command":
          return await this.requestCommand(request);
        case "propose_patch":
          return await this.proposePatch(request);
        case "analyze_project":
          return this.analyzeProject(request);
        case "delegate_readonly":
          return this.options.delegateReadonly
            ? await this.options.delegateReadonly(request)
            : this.result(request, "unavailable", "Read-only delegation is unavailable; choose repository tools or escalate explicitly.");
      }
    } catch (error) {
      return this.result(request, "failed", `Tool ${request.kind} failed.`, [], undefined, formatError(error));
    }
  }

  private listFiles(request: ReasoningToolRequest) {
    const files = this.options.tools.workspace.listFiles(clamp(request.limit, 1, 5_000, 500))
      .filter((entry) => !entry.isDir && !entry.isSecretCandidate)
      .map((entry) => entry.path);
    const evidenceFiles = files.slice(0, 20);
    const omittedEvidenceFiles = Math.max(0, files.length - evidenceFiles.length);
    const evidence = this.options.evidenceStore.add({
      sourceType: "workspace_listing",
      summary: request.reason || "Workspace file listing",
      excerpt: [
        ...evidenceFiles,
        ...(omittedEvidenceFiles ? [`[${omittedEvidenceFiles} additional file path(s) omitted from this evidence excerpt; use the structured tool result or another list_files request.]`] : [])
      ].join("\n")
    });
    return this.result(request, "success", `Listed ${files.length} workspace files.`, [evidence], {
      files,
      totalFiles: files.length,
      evidenceFileLimit: evidenceFiles.length,
      omittedEvidenceFiles
    });
  }

  private search(request: ReasoningToolRequest) {
    if (!request.query?.trim()) return this.result(request, "failed", "repository_search requires query.", [], undefined, "missing_query");
    const limit = clamp(request.limit, 1, 80, REPOSITORY_SEARCH_RESULT_LIMIT);
    const exactMatches = this.options.tools.workspace.searchCode(request.query, limit);
    const matches = exactMatches.length ? exactMatches : this.options.tools.workspace.searchCodeTerms(request.query, limit);
    const evidenceMatches = [...matches]
      .sort((a, b) => searchEvidenceRank(a.path) - searchEvidenceRank(b.path))
      .slice(0, REPOSITORY_SEARCH_EVIDENCE_LIMIT);
    const refs = evidenceMatches.map((match) => this.options.evidenceStore.addFile({
      sourceType: "workspace_file",
      summary: `Search match for ${request.query}`,
      path: match.path,
      startLine: match.line,
      endLine: match.line,
      content: this.options.tools.workspace.readWholeFile(match.path)
    }));
    return this.result(
      request,
      matches.length ? "success" : "unavailable",
      `Found ${matches.length} ${exactMatches.length ? "exact" : "ranked term"} matches for ${request.query}.`,
      refs,
      {
        matches,
        retrieval: exactMatches.length ? "exact" : "ranked_terms",
        evidenceMatchLimit: evidenceMatches.length,
        omittedEvidenceMatches: Math.max(0, matches.length - evidenceMatches.length)
      }
    );
  }

  private readFile(request: ReasoningToolRequest) {
    const paths = unique([...(request.paths ?? []), ...(request.path ? [request.path] : [])]);
    if (!paths.length) return this.result(request, "failed", "read_file requires path or paths.", [], undefined, "missing_path");
    const files = paths.slice(0, 24).map((filePath) => {
      const content = this.options.tools.workspace.readWholeFile(filePath);
      return {
        path: filePath,
        content,
        evidence: this.options.evidenceStore.addFile({
          path: filePath,
          content,
          summary: request.reason
        })
      };
    });
    return this.result(request, "success", `Read ${files.length} file(s).`, files.map((file) => file.evidence), {
      files: files.map((file) => ({ path: file.path, content: file.content.slice(0, 80_000) }))
    });
  }

  private inspectManifest(request: ReasoningToolRequest) {
    const manifests = this.options.tools.workspace.listFiles(5_000)
      .filter((entry) => !entry.isDir && /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|pom\.xml|build\.gradle)$/i.test(entry.path))
      .slice(0, clamp(request.limit, 1, 30, 12));
    const refs = manifests.map((manifest) => {
      const content = this.options.tools.workspace.readWholeFile(manifest.path);
      return this.options.evidenceStore.addFile({
        path: manifest.path,
        content,
        summary: request.reason,
        sourceType: "manifest"
      });
    });
    return this.result(request, "success", `Inspected ${refs.length} manifest(s).`, refs);
  }

  private async investigateProject(request: ReasoningToolRequest) {
    if (!request.query?.trim()) return this.result(request, "failed", "investigate_project requires query.", [], undefined, "missing_query");
    const query = request.query.trim();
    const limit = clamp(request.limit, 1, 24, INVESTIGATE_PROJECT_LIMIT);
    const workspacePath = this.options.tools.getWorkspacePath();
    const before = await assessIndexFreshness(workspacePath);
    let after = before;
    let refreshed = false;
    let refreshError: string | undefined;
    if (before.status !== "fresh") {
      try {
        after = (await refreshRepoIndex(workspacePath, { changedOnly: true })).after;
        refreshed = true;
      } catch (error) {
        refreshError = formatError(error);
        after = await assessIndexFreshness(workspacePath);
      }
    }

    const exactMatches = this.options.tools.workspace.searchCode(query, limit);
    const textMatches = exactMatches.length ? exactMatches : this.options.tools.workspace.searchCodeTerms(query, limit);
    const store = await SqliteMemoryStore.open({ workspacePath });
    try {
      const allNodes = after.status === "fresh" ? store.semanticNodes() : [];
      const ftsNodes = after.status === "fresh"
        ? store.semanticNodes(store.search(query, { kinds: ["semantic_node"], limit: limit * 2 }).map((entry) => entry.id))
        : [];
      const lexicalNodes = rankSemanticNodes(allNodes, query).slice(0, limit);
      let vectorNodes: SemanticProjectNode[] = [];
      let vectorUnavailableReason: string | undefined;
      if (after.status === "fresh" && this.options.embeddingModel && this.options.embed) {
        try {
          await ensureSemanticEmbeddings(store, this.options.embeddingModel, this.options.embed, allNodes);
          const [queryVector] = await this.options.embed([query], this.options.embeddingModel);
          if (queryVector?.length) vectorNodes = store.semanticSearch(queryVector, this.options.embeddingModel, limit).map((entry) => entry.node);
        } catch (error) {
          vectorUnavailableReason = formatError(error);
        }
      }
      const nodes = uniqueSemanticNodes([...vectorNodes, ...ftsNodes, ...lexicalNodes]).slice(0, limit);
      const nodeIds = nodes.map((node) => node.id);
      const relationships = after.status === "fresh"
        ? store.semanticRelationships(nodeIds).slice(0, limit * 2)
        : [];
      const candidatePaths = unique([
        ...textMatches.map((match) => match.path),
        ...nodes.flatMap((node) => node.path ? [node.path] : [])
      ]).sort((a, b) => searchEvidenceRank(a) - searchEvidenceRank(b)).slice(0, INVESTIGATE_SOURCE_EVIDENCE_LIMIT);
      const lineByPath = new Map<string, number>();
      for (const match of textMatches) if (!lineByPath.has(match.path)) lineByPath.set(match.path, match.line);
      for (const node of nodes) if (node.path && node.line && !lineByPath.has(node.path)) lineByPath.set(node.path, node.line);

      const evidenceNodes = nodes.slice(0, INVESTIGATE_NODE_EVIDENCE_LIMIT);
      const evidenceRelationships = relationships.slice(0, INVESTIGATE_RELATIONSHIP_EVIDENCE_LIMIT);
      const evidenceCandidatePaths = candidatePaths.slice(0, INVESTIGATE_SOURCE_EVIDENCE_LIMIT);
      const refs = [
        ...evidenceNodes.map((node) => this.options.evidenceStore.add({
          sourceType: "semantic_node" as const,
          summary: `${node.kind}: ${node.name}`,
          path: node.path,
          startLine: node.line,
          endLine: node.line,
          excerpt: node.summary,
          contentHash: node.contentHash
        })),
        ...evidenceRelationships.map((relationship) => this.options.evidenceStore.add({
          sourceType: "semantic_relationship" as const,
          summary: `${relationship.fromNodeId} -[${relationship.kind}]-> ${relationship.toNodeId}`,
          excerpt: relationship.reason,
          contentHash: relationship.contentHash
        })),
        ...evidenceCandidatePaths.flatMap((filePath) => {
          try {
            const content = this.options.tools.workspace.readWholeFile(filePath);
            const line = lineByPath.get(filePath) ?? 1;
            return [this.options.evidenceStore.addFile({
              sourceType: "workspace_file",
              summary: `Investigation excerpt for ${query}`,
              path: filePath,
              content,
              startLine: Math.max(1, line - 30),
              endLine: line + 70
            })];
          } catch {
            return [];
          }
        })
      ];
      const bundle: InvestigationBundle = {
        query,
        freshness: after.status,
        retrieval: {
          textMatches: textMatches.length,
          semanticNodes: nodes.length,
          relationships: relationships.length,
          sourceFiles: candidatePaths.length,
          vectorUsed: vectorNodes.length > 0,
          vectorUnavailableReason
        },
        candidatePaths,
        relatedNodeIds: nodeIds,
        relationshipIds: relationships.map((relationship) => relationship.id),
        evidenceIds: refs.map((ref) => ref.id)
      };
      const bundleRef = this.options.evidenceStore.add({
        sourceType: "investigation_bundle",
        summary: `Fact-only investigation bundle for ${query}`,
        excerpt: JSON.stringify(bundle)
      });
      return this.result(
        request,
        refs.length ? "success" : "unavailable",
        `Investigated project with ${textMatches.length} text match(es), ${nodes.length} semantic node(s), ${relationships.length} relationship(s), and ${candidatePaths.length} source excerpt(s).`,
        [...refs, bundleRef],
        {
          bundle: { ...bundle, evidenceIds: [...bundle.evidenceIds, bundleRef.id] },
          indexReadiness: {
            before: before.status,
            after: after.status,
            refreshed,
            error: refreshError,
            createdAt: new Date().toISOString()
          }
        },
        refreshError && !refs.length ? refreshError : undefined
      );
    } finally {
      store.close();
    }
  }

  private async semanticSearch(request: ReasoningToolRequest) {
    if (!request.query?.trim()) return this.result(request, "failed", "semantic_search requires query.", [], undefined, "missing_query");
    const freshness = await assessIndexFreshness(this.options.tools.getWorkspacePath());
    if (freshness.status !== "fresh") {
      return this.result(request, "unavailable", `Semantic index is ${freshness.status}; continue with list_files, repository_search, analyze_project, inspect_manifest, or read_file.`);
    }
    const store = await SqliteMemoryStore.open({ workspacePath: this.options.tools.getWorkspacePath() });
    try {
      const limit = clamp(request.limit, 1, 24, SEMANTIC_SEARCH_LIMIT);
      const query = request.query.trim();
      const ftsNodes = store.semanticNodes(store.search(query, { kinds: ["semantic_node"], limit: limit * 2 }).map((entry) => entry.id));
      const lexicalNodes = rankSemanticNodes(store.semanticNodes(), query).slice(0, limit);
      let vectorNodes: SemanticProjectNode[] = [];
      let vectorUnavailableReason: string | undefined;
      if (this.options.embeddingModel && this.options.embed) {
        try {
          await ensureSemanticEmbeddings(store, this.options.embeddingModel, this.options.embed, store.semanticNodes());
          const [queryVector] = await this.options.embed([query], this.options.embeddingModel);
          if (queryVector?.length) vectorNodes = store.semanticSearch(queryVector, this.options.embeddingModel, limit).map((entry) => entry.node);
        } catch (error) {
          vectorUnavailableReason = formatError(error);
        }
      }
      const nodes = uniqueSemanticNodes([...vectorNodes, ...ftsNodes, ...lexicalNodes]).slice(0, limit);
      const refs = nodes.map((node) => this.options.evidenceStore.add({
        sourceType: "semantic_node",
        summary: `${node.kind}: ${node.name}`,
        path: node.path,
        excerpt: node.summary,
        contentHash: node.contentHash
      }));
      return this.result(
        request,
        nodes.length ? "success" : "unavailable",
        `Found ${nodes.length} semantic node(s) using hybrid vector, full-text, and lexical retrieval.${vectorUnavailableReason ? " Vector retrieval was unavailable." : ""}`,
        refs,
        { nodes, retrieval: { vectorUsed: vectorNodes.length > 0, vectorUnavailableReason } }
      );
    } finally {
      store.close();
    }
  }

  private async followRelationships(request: ReasoningToolRequest) {
    const ids = request.relatedNodeIds ?? [];
    if (!ids.length) return this.result(request, "failed", "follow_relationships requires relatedNodeIds.", [], undefined, "missing_node_ids");
    const store = await SqliteMemoryStore.open({ workspacePath: this.options.tools.getWorkspacePath() });
    try {
      const relationships = store.semanticRelationships(ids).slice(0, clamp(request.limit, 1, 100, 40));
      const refs = relationships.map((relationship) => this.options.evidenceStore.add({
        sourceType: "semantic_relationship",
        summary: `${relationship.fromNodeId} -[${relationship.kind}]-> ${relationship.toNodeId}`,
        excerpt: relationship.reason
      }));
      return this.result(request, relationships.length ? "success" : "unavailable", `Followed ${relationships.length} semantic relationship(s).`, refs, { relationships });
    } finally {
      store.close();
    }
  }

  private async readSemanticSources(request: ReasoningToolRequest) {
    const ids = request.relatedNodeIds ?? [];
    if (!ids.length) return this.result(request, "failed", "read_semantic_sources requires relatedNodeIds.", [], undefined, "missing_node_ids");
    const store = await SqliteMemoryStore.open({ workspacePath: this.options.tools.getWorkspacePath() });
    try {
      const paths = unique(store.semanticNodes(ids).flatMap((node) => node.path ? [node.path] : []));
      return this.readFile({ ...request, kind: "read_file", paths });
    } finally {
      store.close();
    }
  }

  private async requestCommand(request: ReasoningToolRequest) {
    if (!request.command?.trim()) return this.result(request, "failed", "run_command requires command.", [], undefined, "missing_command");
    const command = this.options.tools.command.requestRun(this.options.sessionId, request.command, request.reason);
    if (this.options.onCommandRequest) await this.options.onCommandRequest(command);
    const evidence = this.options.evidenceStore.add({
      sourceType: "command_result",
      summary: `Command requested: ${command.command}`,
      excerpt: command.reason
    });
    return this.result(request, command.status === "blocked" ? "blocked" : "approval_required", `Command ${command.status}; Rust authority must execute it.`, [evidence], { command }, undefined, command.id);
  }

  private async proposePatch(request: ReasoningToolRequest) {
    if (!request.patch) return this.result(request, "failed", "propose_patch requires patch payload.", [], undefined, "missing_patch");
    const proposal = this.options.tools.patch.propose({
      title: request.patch.title,
      summary: request.patch.summary,
      riskLevel: request.patch.riskLevel,
      filesChanged: request.patch.filesChanged.map((file) => ({
        path: file.path,
        changeType: file.changeType,
        explanation: file.summary
      })),
      unifiedDiff: request.patch.unifiedDiff,
      requiresApproval: true,
      status: "proposed"
    }, this.options.sessionId);
    const validation = this.options.tools.patch.validate(proposal);
    const evidence = this.options.evidenceStore.add({
      sourceType: "patch_validation",
      summary: `Patch validation ${validation.valid ? "passed" : "failed"} for ${proposal.title}`,
      excerpt: [...validation.errors, ...validation.warnings].join("\n")
    });
    if (!validation.valid) return this.result(request, "failed", "Patch proposal failed deterministic validation.", [evidence], { validation }, validation.errors.join("; "));
    if (this.options.onPatchProposal) await this.options.onPatchProposal(proposal);
    return this.result(request, "approval_required", "Patch proposal passed validation and requires Rust/operator approval.", [evidence], { proposal, validation }, undefined, proposal.id);
  }

  private analyzeProject(request: ReasoningToolRequest) {
    const summary = this.options.tools.workspace.getProjectSummary();
    const evidence = this.options.evidenceStore.add({
      sourceType: "manifest",
      summary: request.reason,
      excerpt: JSON.stringify(summary)
    });
    return this.result(request, "success", "Collected deterministic project structure facts.", [evidence], summary);
  }

  private result(
    request: ReasoningToolRequest,
    status: ReasoningToolResult["status"],
    summary: string,
    evidenceRefs = [] as ReasoningToolResult["evidenceRefs"],
    data?: unknown,
    error?: string,
    approvalRef?: string
  ): ReasoningToolResult {
    return { requestId: request.id, kind: request.kind, status, summary, evidenceRefs, data, error, approvalRef, createdAt: new Date().toISOString() };
  }
}

function isReadOnlyRequest(request: ReasoningToolRequest) {
  // investigate_project may refresh durable repository memory, so serialize it
  // with other stateful requests even though it cannot modify project sources.
  return !["run_command", "propose_patch", "investigate_project"].includes(request.kind);
}

function rankSemanticNodes(nodes: SemanticProjectNode[], query: string) {
  const tokens = tokenize(query);
  return nodes
    .map((node) => {
      const text = tokenize(`${node.name} ${node.summary} ${node.path ?? ""}`);
      const overlap = tokens.filter((token) => text.includes(token)).length;
      return { node, score: overlap / Math.max(1, tokens.length) };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .map((entry) => entry.node);
}

async function ensureSemanticEmbeddings(
  store: SqliteMemoryStore,
  model: string,
  embed: (inputs: string[], model: string) => Promise<number[][]>,
  nodes: SemanticProjectNode[]
) {
  const existing = new Set(store.semanticEmbeddings(model).map((entry) => entry.nodeId));
  const missing = nodes.filter((node) => !existing.has(node.id)).slice(0, 320);
  for (let index = 0; index < missing.length; index += 64) {
    const batch = missing.slice(index, index + 64);
    const vectors = await embed(batch.map(semanticNodeEmbeddingText), model);
    const updatedAt = new Date().toISOString();
    store.saveSemanticEmbeddings(batch.map((node, vectorIndex): SemanticEmbeddingRecord => ({
      nodeId: node.id,
      model,
      dimensions: vectors[vectorIndex]?.length ?? 0,
      vector: vectors[vectorIndex] ?? [],
      contentHash: node.contentHash,
      updatedAt
    })).filter((entry) => entry.vector.length > 0));
  }
}

function uniqueSemanticNodes(nodes: SemanticProjectNode[]) {
  return [...new Map(nodes.map((node) => [node.id, node])).values()];
}

function searchEvidenceRank(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (/^readme(\.[a-z0-9]+)?$/i.test(normalized)) return 0;
  if (/^(agents|package)\.(md|json)$/i.test(normalized)) return 1;
  if (/^docs\//i.test(normalized)) return 2;
  if (!normalized.includes("/")) return 3;
  if (/(test|spec|fixture|dist|build|output|node_modules)\//i.test(normalized)) return 8;
  return 5;
}

function tokenize(value: string) {
  return [...new Set(value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 1))];
}

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  return Math.min(maximum, Math.max(minimum, value ?? fallback));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean).map((value) => path.normalize(value).replaceAll("\\", "/")))];
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
