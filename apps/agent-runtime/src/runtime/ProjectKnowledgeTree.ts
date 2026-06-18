import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BranchOrchestratorRecord,
  HierarchicalRecursiveGraph,
  KnowledgeBranchTarget,
  KnowledgeBranchTargetBlockedReason,
  KnowledgeGuidedEditPlan,
  KnowledgeQueryRoute,
  KnowledgeRoutedEdit,
  ProjectKnowledgeFileOwnership,
  ProjectKnowledgeFreshness,
  ProjectKnowledgeNode,
  ProjectKnowledgeTree,
  RecursiveBranchExecutionRecord
} from "@hivo/protocol";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import { readMemorySnapshot } from "../memory/ProjectMemory.js";
import type {
  CommandInventory,
  FileManifestEntry,
  FileSummaryRecord,
  FileSymbolIndex,
  IndexFreshnessReport,
  ProjectIntelligence,
  RepoIndex,
  SymbolIndex
} from "../memory/types.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

type KnowledgeEvidence = {
  repoIndex?: RepoIndex;
  fileManifest: FileManifestEntry[];
  symbolIndex?: SymbolIndex;
  fileSummaries: FileSummaryRecord[];
  projectIntelligence?: ProjectIntelligence;
  commandInventory?: CommandInventory;
  freshnessReport: IndexFreshnessReport;
  evidenceSources: string[];
};

type MutableNode = Omit<ProjectKnowledgeNode, "filesOwned" | "children" | "importantSymbols" | "dependencies" | "risks" | "whoUnderstandsThisArea" | "completeness"> & {
  filesOwned: Set<string>;
  children: Set<string>;
  importantSymbols: Set<string>;
  dependencies: Set<string>;
  risks: Set<string>;
  whoUnderstandsThisArea: Set<string>;
};

type FileRoute = {
  nodeId: string;
  parent: string;
  scope: string;
  summary: string;
} | null;

const REQUIRED_KNOWLEDGE_NODE_FIELDS = [
  "nodeId",
  "scope",
  "filesOwned",
  "summary",
  "importantSymbols",
  "dependencies",
  "risks",
  "children",
  "parent",
  "freshness",
  "whoUnderstandsThisArea"
] as const;

const ROOT_NODE_ID = "root";
const AREA_NODE_IDS = [
  "frontend",
  "frontend_ui",
  "backend",
  "backend_entry_api",
  "backend_api",
  "auth",
  "database",
  "tests_validation",
  "config_dependencies",
  "docs",
  "build_tooling"
] as const;

const ROUTE_DETAILS = [
  { pattern: "frontend/app.js", targetNodeId: "frontend_ui", reason: "Frontend app entry files route through the UI node." },
  { pattern: "backend/main.py", targetNodeId: "backend_entry_api", reason: "Backend main entrypoints route through the backend-entry/API node." },
  { pattern: "README/requirements/package config", targetNodeId: "config_dependencies", reason: "Project docs and dependency manifests route through config/dependencies." },
  { pattern: "tests", targetNodeId: "tests_validation", reason: "Test files route through the tests/validation node." }
];

export async function buildProjectKnowledgeTree(input: {
  sessionId?: string;
  workspacePath: string;
  tools: ToolRegistry;
}): Promise<ProjectKnowledgeTree> {
  const now = new Date().toISOString();
  const evidence = await collectKnowledgeEvidence(input.workspacePath, input.tools);
  const freshness = projectKnowledgeFreshness(evidence.freshnessReport);
  const nodes = new Map<string, MutableNode>();
  const ensureNode = (nodeId: string, scope: string, parent?: string, summary?: string) => {
    const existing = nodes.get(nodeId);
    if (existing) return existing;
    const node: MutableNode = {
      nodeId,
      scope,
      parent: parent ?? null,
      summary: summary ?? `Knowledge node for ${scope}.`,
      filesOwned: new Set(),
      importantSymbols: new Set(),
      dependencies: new Set(),
      risks: new Set(freshness.status === "fresh" ? [] : [`Memory freshness is ${freshness.status}; direct workspace evidence was used for routing.`]),
      children: new Set(),
      freshness,
      whoUnderstandsThisArea: new Set([ownerLabel(scope)])
    };
    nodes.set(nodeId, node);
    if (parent) ensureNode(parent, parent === ROOT_NODE_ID ? "whole project" : parent).children.add(nodeId);
    return node;
  };

  ensureNode(
    ROOT_NODE_ID,
    "whole project",
    undefined,
    "Root project map. Routes frontend/app.js to frontend/UI, backend/main.py to backend-entry/API, README/requirements/package config to config/dependencies, and tests to tests/validation."
  );
  ensureAreaNodes(ensureNode);

  const ownership: ProjectKnowledgeFileOwnership[] = [];
  const files = evidence.fileManifest
    .filter((file) => file.isText && !file.roles.includes("generated"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const summaryByPath = new Map(evidence.fileSummaries.map((summary) => [summary.path, summary]));
  const symbolsByPath = new Map((evidence.symbolIndex?.files ?? []).map((file) => [file.path, file]));

  for (const file of files) {
    const route = classifyFile(file.path, file.roles);
    if (!route) {
      continue;
    }
    const owner = ensureNode(route.nodeId, route.scope, route.parent, route.summary);
    const root = ensureNode(ROOT_NODE_ID, "whole project");
    owner.filesOwned.add(file.path);
    root.filesOwned.add(file.path);
    for (const risk of fileRisks(file.path, file.roles, evidence.projectIntelligence)) owner.risks.add(risk);
    const symbols = symbolsByPath.get(file.path) ?? symbolsFromSummary(summaryByPath.get(file.path));
    for (const symbol of importantSymbolsForFile(symbols)) owner.importantSymbols.add(symbol);
    for (const dependency of dependenciesForFile(symbols, evidence.projectIntelligence, file.path)) owner.dependencies.add(dependency);

    const leaf = shouldCreateLeafExpert(file)
      ? ensureNode(fileNodeId(file.path), `file/module expert: ${file.path}`, route.nodeId, fileSummary(file.path, summaryByPath.get(file.path), route.scope))
      : undefined;
    if (leaf) {
      leaf.filesOwned.add(file.path);
      for (const symbol of importantSymbolsForFile(symbols)) leaf.importantSymbols.add(symbol);
      for (const dependency of dependenciesForFile(symbols, evidence.projectIntelligence, file.path)) leaf.dependencies.add(dependency);
      for (const risk of fileRisks(file.path, file.roles, evidence.projectIntelligence)) leaf.risks.add(risk);
    }

    const primaryOwnerNodeId = leaf?.nodeId ?? owner.nodeId;
    ownership.push({
      path: file.path,
      primaryOwnerNodeId,
      reviewerNodeIds: reviewerNodeIds(route.nodeId, nodes),
      dependencyNodeIds: dependencyNodeIds(file.path, evidence.projectIntelligence, nodes)
    });
  }

  attachAreaSummaries(nodes, evidence);
  const finalizedNodes = [...nodes.values()].map(finalizeNode).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const ownershipMap = Object.fromEntries(ownership.map((owner) => [owner.path, owner]));
  const orphanedFiles = files
    .filter((file) => !ownershipMap[file.path] && isImportantKnowledgeFilePath(file.path, file.roles))
    .map((file) => ({
      path: file.path,
      reason: "No deterministic Project Knowledge Tree owner matched this important source/config/test file."
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const rootRoutingGuarantees = buildRootRoutingGuarantees(files.map((file) => file.path), ownershipMap, finalizedNodes);
  const completeness = validateProjectKnowledgeTree({
    nodes: finalizedNodes,
    fileOwnership: ownership,
    orphanedFiles
  });
  return {
    id: `knowledge_tree_${randomUUID()}`,
    sessionId: input.sessionId,
    workspaceRoot: input.workspacePath,
    rootNodeId: ROOT_NODE_ID,
    nodes: finalizedNodes,
    fileOwnership: ownership.sort((left, right) => left.path.localeCompare(right.path)),
    ownershipMap,
    orphanedFiles,
    rootRoutingGuarantees,
    completeness,
    routeDetails: ROUTE_DETAILS,
    evidenceSources: evidence.evidenceSources,
    memoryFreshness: freshness,
    createdAt: now,
    updatedAt: now
  };
}

export function routeKnowledgeQuery(input: {
  tree: ProjectKnowledgeTree;
  request: string;
}): KnowledgeQueryRoute {
  const now = new Date().toISOString();
  const terms = queryTerms(input.request);
  const nodeById = new Map(input.tree.nodes.map((node) => [node.nodeId, node]));
  const ownershipByPath = new Map(input.tree.fileOwnership.map((owner) => [owner.path, owner]));
  const scoredFiles = input.tree.fileOwnership
    .map((owner) => ({ path: owner.path, score: scoreFileForQuery(owner.path, nodeById.get(owner.primaryOwnerNodeId), terms, input.request) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 12);
  const likelyFiles = scoredFiles.map((entry) => entry.path);
  const affected = new Set<string>();
  const reviewers = new Set<string>();
  for (const file of likelyFiles) {
    const owner = ownershipByPath.get(file);
    if (!owner) continue;
    affected.add(owner.primaryOwnerNodeId);
    for (const reviewer of owner.reviewerNodeIds) reviewers.add(reviewer);
    for (const dependency of owner.dependencyNodeIds) reviewers.add(dependency);
  }
  for (const node of input.tree.nodes) {
    if (scoreNodeForQuery(node, terms, input.request) >= 6) affected.add(node.nodeId);
  }
  if (!affected.size) affected.add(input.tree.rootNodeId);
  const affectedNodeIds = [...affected].filter((nodeId) => nodeById.has(nodeId));
  const primaryNode = choosePrimaryNode(affectedNodeIds, scoredFiles, ownershipByPath, input.tree.rootNodeId);
  const primary = nodeById.get(primaryNode);
  if (primary?.parent) reviewers.add(primary.parent);
  reviewers.add(input.tree.rootNodeId);
  for (const nodeId of affectedNodeIds) {
    const node = nodeById.get(nodeId);
    if (node?.parent && node.parent !== primaryNode) reviewers.add(node.parent);
  }
  const reviewerNodes = [...reviewers].filter((nodeId) => nodeById.has(nodeId) && nodeId !== primaryNode);
  const risks = uniqueStrings([
    ...affectedNodeIds.flatMap((nodeId) => nodeById.get(nodeId)?.risks ?? []),
    likelyFiles.some((file) => /package\.json|requirements|Cargo\.toml|lock/i.test(file)) ? "Dependency/config changes can affect install, build, and validation commands." : "",
    affectedNodeIds.length > 3 ? "Routing spans several project areas; require parent and root integration review." : ""
  ]).slice(0, 10);
  const confidence = routeConfidence(scoredFiles, affectedNodeIds, input.tree.memoryFreshness.status);
  const evidenceUsed = routeEvidenceUsed(scoredFiles, affectedNodeIds, reviewerNodes, input.tree);
  return {
    id: `edit_route_${randomUUID()}`,
    treeId: input.tree.id,
    request: input.request,
    affectedNodeIds,
    primaryNode,
    reviewerNodes,
    likelyFiles,
    risks,
    confidence: confidence.value,
    confidenceLevel: confidence.level,
    blockedReason: confidence.blockedReason,
    evidenceUsed,
    why: routeWhy(input.request, likelyFiles, affectedNodeIds, reviewerNodes, input.tree.memoryFreshness.status),
    createdAt: now
  };
}

export function createKnowledgeGuidedEditPlan(input: {
  tree: ProjectKnowledgeTree;
  route: KnowledgeQueryRoute;
  request: string;
}): KnowledgeRoutedEdit {
  const now = new Date().toISOString();
  const nodeById = new Map(input.tree.nodes.map((node) => [node.nodeId, node]));
  const affectedNodes = input.route.affectedNodeIds;
  const targetFiles = input.route.likelyFiles;
  const parentReviews = uniqueStrings(affectedNodes.map((nodeId) => nodeById.get(nodeId)?.parent ?? "").filter(Boolean));
  const siblingReviews = uniqueStrings(input.route.reviewerNodes.filter((nodeId) => nodeId !== input.tree.rootNodeId && !parentReviews.includes(nodeId)));
  const reviewChain = {
    leafReview: affectedNodes.filter((nodeId) => nodeById.get(nodeId)?.scope.startsWith("file/module expert")),
    parentScopeReview: parentReviews,
    siblingAffectedNodeReview: siblingReviews,
    rootIntegrationReview: [input.tree.rootNodeId]
  };
  const knowledgeBranchTargets = createKnowledgeBranchTargets({
    tree: input.tree,
    route: input.route,
    request: input.request,
    reviewChain,
    createdAt: now
  });
  const plan: KnowledgeGuidedEditPlan = {
    id: `knowledge_edit_plan_${randomUUID()}`,
    treeId: input.tree.id,
    routeId: input.route.id,
    userIntentSummary: summarizeIntent(input.request),
    affectedNodes,
    targetFiles,
    filesNotToTouch: filesNotToTouch(input.tree, targetFiles),
    localNodeRisks: affectedNodes.map((nodeId) => ({
      nodeId,
      risks: nodeById.get(nodeId)?.risks.slice(0, 5) ?? []
    })),
    crossNodeRisks: crossNodeRisks(input.route, input.tree),
    requiredReviewChain: reviewChain,
    knowledgeBranchTargets,
    suggestedBranchTargets: knowledgeBranchTargets,
    executionState: "Execution has not started. This edit was routed through the Project Knowledge Tree.",
    executionStarted: false,
    createdAt: now
  };
  return {
    id: `knowledge_routed_edit_${randomUUID()}`,
    treeId: input.tree.id,
    route: input.route,
    plan,
    intentSummary: plan.userIntentSummary,
    affectedNodeIds: input.route.affectedNodeIds,
    primaryNode: input.route.primaryNode,
    likelyFiles: input.route.likelyFiles,
    filesNotToTouch: plan.filesNotToTouch,
    risks: uniqueStrings([...input.route.risks, ...plan.crossNodeRisks]),
    reviewChain,
    knowledgeBranchTargets,
    confidence: input.route.confidence,
    confidenceLevel: input.route.confidenceLevel,
    evidenceUsed: input.route.evidenceUsed,
    executionStarted: false,
    status: input.route.confidenceLevel === "low" ? "blocked" : "ready",
    createdAt: now
  };
}

export function shouldRouteExistingProjectEdit(input: {
  message: string;
  projectKind: string;
  runIntent: string | undefined;
}) {
  if (input.projectKind !== "existing_project" && input.projectKind !== "mid_progress_project") return false;
  if (input.runIntent === "inspect_only" || input.runIntent === "run_to_green" || input.runIntent === "run_once") return false;
  return input.runIntent === "implement_module" || /\b(edit|change|modify|fix|add|implement|update|refactor|login|auth|backend|frontend|api)\b/i.test(input.message);
}

export function formatKnowledgeRoutedEditMessage(input: {
  tree: ProjectKnowledgeTree;
  routedEdit: KnowledgeRoutedEdit;
}) {
  const nodeById = new Map(input.tree.nodes.map((node) => [node.nodeId, node]));
  const route = input.routedEdit.route;
  const plan = input.routedEdit.plan;
  const affected = route.affectedNodeIds.map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).slice(0, 8);
  const reviewers = route.reviewerNodes.map((nodeId) => nodeById.get(nodeId)?.scope ?? nodeId).slice(0, 8);
  return [
    "Execution has not started. This edit was routed through the Project Knowledge Tree.",
    "",
    `Intent: ${plan.userIntentSummary}`,
    `Primary node: ${nodeById.get(route.primaryNode)?.scope ?? route.primaryNode}`,
    `Confidence: ${Math.round(route.confidence * 100)}%`,
    "",
    `Affected nodes: ${affected.join(", ") || "root"}`,
    `Target files: ${plan.targetFiles.slice(0, 10).join(", ") || "No specific file was selected with enough evidence."}`,
    `Files not to touch: ${plan.filesNotToTouch.slice(0, 8).join(", ") || "No extra protected paths selected."}`,
    `Reviewer nodes: ${reviewers.join(", ") || "root integration review"}`,
    `Evidence used: ${route.evidenceUsed.slice(0, 8).join("; ") || "No direct evidence selected."}`,
    "",
    "Review chain:",
    `- Leaf review: ${plan.requiredReviewChain.leafReview.join(", ") || "No leaf file expert selected"}`,
    `- Parent scope review: ${plan.requiredReviewChain.parentScopeReview.join(", ") || "root"}`,
    `- Sibling affected-node review: ${plan.requiredReviewChain.siblingAffectedNodeReview.join(", ") || "none"}`,
    `- Root integration review: ${plan.requiredReviewChain.rootIntegrationReview.join(", ")}`,
    "",
    `Risks: ${uniqueStrings([...route.risks, ...plan.crossNodeRisks]).slice(0, 6).join("; ") || "No special routing risk beyond normal scoped review."}`
  ].join("\n");
}

async function collectKnowledgeEvidence(workspacePath: string, tools: ToolRegistry): Promise<KnowledgeEvidence> {
  const freshnessReport = await assessIndexFreshness(workspacePath);
  if (freshnessReport.status === "fresh") {
    try {
      const repoIndex = await requireKnowledgeSnapshot<RepoIndex>(workspacePath, "repo_index");
      const fileManifest = await requireKnowledgeSnapshot<FileManifestEntry[]>(workspacePath, "file_manifest");
      const symbolIndex = await requireKnowledgeSnapshot<SymbolIndex>(workspacePath, "symbol_index");
      const fileSummaries = await requireKnowledgeSnapshot<FileSummaryRecord[]>(workspacePath, "file_summaries");
      const projectIntelligence = await requireKnowledgeSnapshot<ProjectIntelligence>(workspacePath, "project_intelligence");
      const commandInventory = await requireKnowledgeSnapshot<CommandInventory>(workspacePath, "command_inventory");
      return {
        repoIndex,
        fileManifest,
        symbolIndex,
        fileSummaries,
        projectIntelligence,
        commandInventory,
        freshnessReport,
        evidenceSources: ["repo_index", "file_manifest", "symbol_index", "file_summaries", "project_intelligence", "command_inventory"]
      };
    } catch {
      // Fall through to direct workspace evidence while preserving the freshness warning.
    }
  }
  return {
    fileManifest: directFileManifest(tools),
    fileSummaries: [],
    freshnessReport,
    evidenceSources: ["direct_workspace_reads", "WorkspaceTools summaries", `memory_${freshnessReport.status}_not_trusted`]
  };
}

async function requireKnowledgeSnapshot<T>(workspacePath: string, kind: string): Promise<T> {
  const value = await readMemorySnapshot<T>(workspacePath, kind);
  if (value === undefined) throw new Error(`Missing SQLite project knowledge snapshot: ${kind}`);
  return value;
}

function projectKnowledgeFreshness(report: IndexFreshnessReport): ProjectKnowledgeFreshness {
  return {
    status: report.status === "fresh" ? "fresh" : report.status === "missing" ? "missing" : "stale",
    checkedAt: report.checkedAt,
    generatedAt: report.generatedAt,
    staleReasons: report.warnings,
    changedFiles: report.changedFiles,
    newFiles: report.newFiles,
    deletedFiles: report.deletedFiles
  };
}

function directFileManifest(tools: ToolRegistry): FileManifestEntry[] {
  return tools.workspace.listFiles(2_000)
    .filter((entry) => !entry.isDir && !entry.isSecretCandidate)
    .filter((entry) => isTextLike(entry.path))
    .map((entry) => ({
      path: normalizePath(entry.path),
      extension: path.extname(entry.path),
      basename: path.basename(entry.path),
      dirname: normalizePath(path.dirname(entry.path)),
      sizeBytes: 0,
      mtimeMs: 0,
      isText: true,
      language: languageForPath(entry.path),
      roles: rolesForPath(entry.path)
    }));
}

function ensureAreaNodes(ensureNode: (nodeId: string, scope: string, parent?: string, summary?: string) => MutableNode) {
  ensureNode("frontend", "frontend", ROOT_NODE_ID, "Frontend project area.");
  ensureNode("frontend_ui", "frontend/UI", "frontend", "UI, client app, components, pages, styles, and browser-facing behavior.");
  ensureNode("backend", "backend", ROOT_NODE_ID, "Backend project area.");
  ensureNode("backend_entry_api", "backend-entry/API", "backend", "Backend entrypoints, server startup, and API wiring.");
  ensureNode("backend_api", "api", "backend", "API routes, controllers, request/response contracts, and transport boundaries.");
  ensureNode("auth", "auth", "backend", "Authentication, login, session, authorization, and identity-sensitive behavior.");
  ensureNode("database", "database", "backend", "Database, persistence, schema, migrations, repositories, and model storage.");
  ensureNode("tests_validation", "tests/validation", ROOT_NODE_ID, "Tests, validation scripts, smoke checks, and fixtures.");
  ensureNode("config_dependencies", "config/dependencies", ROOT_NODE_ID, "README, requirements, package manifests, lockfiles, and dependency/build configuration.");
  ensureNode("docs", "docs", ROOT_NODE_ID, "Documentation and operator-facing project notes.");
  ensureNode("build_tooling", "build/tooling", ROOT_NODE_ID, "Build tooling, CI, dev scripts, and generated-tool configuration.");
}

function classifyFile(filePath: string, roles: string[]): FileRoute {
  const lower = filePath.toLowerCase();
  if (roles.includes("test") || /(^|\/)(tests?|__tests__|specs?)(\/|$)|(\.test\.|\.spec\.)/.test(lower)) {
    return { nodeId: "tests_validation", parent: ROOT_NODE_ID, scope: "tests/validation", summary: "Tests and validation files." };
  }
  if (/(^|\/)(readme|requirements|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|cargo\.lock|pyproject\.toml|tsconfig.*\.json)(\/|$)?/i.test(filePath)) {
    return { nodeId: "config_dependencies", parent: ROOT_NODE_ID, scope: "config/dependencies", summary: "Project dependencies and package/config evidence." };
  }
  if (/(^|\/)(docs?|architecture|adr)(\/|$)|readme|\.md$/i.test(filePath)) {
    return { nodeId: "docs", parent: ROOT_NODE_ID, scope: "docs", summary: "Documentation evidence." };
  }
  if (/(^|\/)(vite|webpack|rollup|esbuild|scripts?|ci|\.github)(\/|$)|dockerfile|makefile|build\./i.test(lower)) {
    return { nodeId: "build_tooling", parent: ROOT_NODE_ID, scope: "build/tooling", summary: "Build and tooling evidence." };
  }
  if (/\b(auth|login|logout|session|jwt|oauth|permission|identity|user)\b/i.test(lower)) {
    return { nodeId: "auth", parent: "backend", scope: "auth", summary: "Authentication or authorization code." };
  }
  if (/\b(db|database|schema|migration|prisma|sql|repository|models?)\b/i.test(lower)) {
    return { nodeId: "database", parent: "backend", scope: "database", summary: "Persistence and database code." };
  }
  if (/(^|\/)(backend|server|api|routes?|controllers?)(\/|$)|backend\/main\.py|server\.(ts|js|py)|main\.py$/i.test(filePath)) {
    return /main\.py$|server\.(ts|js|py)$/i.test(filePath)
      ? { nodeId: "backend_entry_api", parent: "backend", scope: "backend-entry/API", summary: "Backend entrypoint and API startup file." }
      : { nodeId: "backend_api", parent: "backend", scope: "api", summary: "Backend API code." };
  }
  if (/(^|\/)(frontend|client|web|ui|components?|pages?|app)(\/|$)|\.(tsx|jsx|css|scss|html)$/i.test(filePath)) {
    return { nodeId: "frontend_ui", parent: "frontend", scope: "frontend/UI", summary: "Frontend UI code." };
  }
  if (/\.(py|rs|go|java|cs)$/i.test(filePath)) {
    return { nodeId: "backend", parent: ROOT_NODE_ID, scope: "backend", summary: "Backend or service source code." };
  }
  if (roles.includes("source")) {
    return { nodeId: "backend", parent: ROOT_NODE_ID, scope: "backend", summary: "General source code." };
  }
  return null;
}

function symbolsFromSummary(summary: FileSummaryRecord | undefined): FileSymbolIndex | undefined {
  if (!summary) return undefined;
  return {
    path: summary.path,
    language: summary.language,
    imports: summary.imports,
    exports: summary.exports,
    symbols: summary.symbols.map((symbol) => ({ ...symbol, path: summary.path }))
  };
}

function importantSymbolsForFile(file: FileSymbolIndex | undefined) {
  return uniqueStrings([
    ...(file?.exports ?? []),
    ...(file?.symbols ?? []).filter((symbol) => symbol.exported || /class|function|interface|type|struct|trait/.test(symbol.kind)).map((symbol) => symbol.name)
  ]).slice(0, 10);
}

function dependenciesForFile(file: FileSymbolIndex | undefined, intelligence: ProjectIntelligence | undefined, filePath: string) {
  return uniqueStrings([
    ...(file?.imports ?? []).slice(0, 8),
    ...(intelligence?.dependencyGraph[filePath] ?? []).slice(0, 8)
  ]);
}

function fileRisks(filePath: string, roles: string[], intelligence: ProjectIntelligence | undefined) {
  const risk = intelligence?.riskMap[filePath];
  return uniqueStrings([
    ...(risk?.reasons ?? []),
    roles.includes("config") ? "Config files can affect multiple runtime paths." : "",
    roles.includes("dependency") ? "Dependency files can change install or build behavior." : "",
    /(^|\/)(main|server|app|index)\./i.test(filePath) ? "Entrypoint changes can alter startup behavior." : "",
    /auth|login|session|jwt/i.test(filePath) ? "Auth changes require security and regression review." : ""
  ]);
}

function shouldCreateLeafExpert(file: FileManifestEntry) {
  return file.roles.some((role) => ["source", "test", "config", "dependency", "entrypoint", "package", "build"].includes(role));
}

function fileSummary(filePath: string, summary: FileSummaryRecord | undefined, scope: string) {
  return summary?.purposeGuess || `Leaf expert for ${filePath} under ${scope}.`;
}

function reviewerNodeIds(ownerNodeId: string, nodes: Map<string, MutableNode>) {
  const reviewers = new Set<string>([ROOT_NODE_ID]);
  const node = nodes.get(ownerNodeId);
  if (node?.parent) reviewers.add(node.parent);
  if (/auth|database|backend_api|backend_entry_api/.test(ownerNodeId)) reviewers.add("tests_validation");
  if (/frontend|backend|auth|database|api/.test(ownerNodeId)) reviewers.add("config_dependencies");
  return [...reviewers].filter((nodeId) => nodeId !== ownerNodeId && nodes.has(nodeId));
}

function dependencyNodeIds(filePath: string, intelligence: ProjectIntelligence | undefined, nodes: Map<string, MutableNode>) {
  const dependencies = intelligence?.dependencyGraph[filePath] ?? [];
  return uniqueStrings(dependencies.map((dependency) => classifyFile(dependency, [])?.nodeId ?? "")).filter((nodeId) => nodes.has(nodeId));
}

function attachAreaSummaries(nodes: Map<string, MutableNode>, evidence: KnowledgeEvidence) {
  const root = nodes.get(ROOT_NODE_ID);
  if (root) {
    root.summary = `Root Project Knowledge Tree for ${evidence.repoIndex?.projectName ?? "workspace"} with ${root.filesOwned.size} owned file(s), built from ${evidence.evidenceSources.join(", ")}.`;
    if (evidence.commandInventory?.commands.length) {
      for (const command of evidence.commandInventory.commands.slice(0, 8)) root.dependencies.add(command.command);
    }
  }
  for (const id of AREA_NODE_IDS) {
    const node = nodes.get(id);
    if (!node) continue;
    node.summary = `${node.scope} owns ${node.filesOwned.size} file(s). ${node.summary}`;
  }
}

function buildRootRoutingGuarantees(
  files: string[],
  ownershipMap: Record<string, ProjectKnowledgeFileOwnership>,
  nodes: ProjectKnowledgeNode[]
): ProjectKnowledgeTree["rootRoutingGuarantees"] {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const routesThrough = (owner: ProjectKnowledgeFileOwnership | undefined, targetNodeId: string) => {
    if (!owner) return false;
    if (owner.primaryOwnerNodeId === targetNodeId || owner.reviewerNodeIds.includes(targetNodeId)) return true;
    let current = nodeById.get(owner.primaryOwnerNodeId);
    while (current?.parent) {
      if (current.parent === targetNodeId) return true;
      current = nodeById.get(current.parent);
    }
    return false;
  };
  const checks = [
    {
      pattern: "frontend files",
      targetNodeId: "frontend_ui",
      matchingFiles: files.filter((file) => /(^|\/)frontend\/|frontend\/app\.js|\.(tsx|jsx|css|scss|html)$/i.test(file))
    },
    {
      pattern: "backend files",
      targetNodeId: "backend_entry_api",
      matchingFiles: files.filter((file) => /backend\/main\.py$/i.test(file))
    },
    {
      pattern: "backend API files",
      targetNodeId: "backend_api",
      matchingFiles: files.filter((file) => /(^|\/)(backend|api|routes?)(\/|$)/i.test(file) && !/backend\/main\.py$/i.test(file))
    },
    {
      pattern: "README, manifests, and config files",
      targetNodeId: "config_dependencies",
      matchingFiles: files.filter((file) => /(^|\/)(readme|requirements|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.toml|cargo\.lock|pyproject\.toml|tsconfig.*\.json)(\/|$)?/i.test(file))
    },
    {
      pattern: "tests",
      targetNodeId: "tests_validation",
      matchingFiles: files.filter((file) => /(^|\/)(tests?|__tests__|specs?)(\/|$)|(\.test\.|\.spec\.)/i.test(file))
    }
  ];
  return checks.map((check) => {
    const orphaned = check.matchingFiles.filter((file) => !ownershipMap[file]);
    const routed = check.matchingFiles.filter((file) => {
      const owner = ownershipMap[file];
      return routesThrough(owner, check.targetNodeId)
        || (check.targetNodeId === "backend_api" && routesThrough(owner, "backend"));
    });
    return {
      pattern: check.pattern,
      targetNodeId: check.targetNodeId,
      matchingFiles: check.matchingFiles,
      status: orphaned.length ? "orphaned" : check.matchingFiles.length && routed.length === check.matchingFiles.length ? "passed" : "missing",
      reason: orphaned.length
        ? `Unowned files: ${orphaned.slice(0, 5).join(", ")}`
        : check.matchingFiles.length
          ? `Root can route ${check.matchingFiles.length} matching file(s) through ${check.targetNodeId}.`
          : `No files matched ${check.pattern} in this workspace.`
    };
  });
}

function finalizeNode(node: MutableNode): ProjectKnowledgeNode {
  const finalized = {
    ...node,
    filesOwned: [...node.filesOwned].sort(),
    importantSymbols: [...node.importantSymbols].sort().slice(0, 30),
    dependencies: [...node.dependencies].sort().slice(0, 30),
    risks: [...node.risks].sort().slice(0, 12),
    children: [...node.children].sort(),
    whoUnderstandsThisArea: [...node.whoUnderstandsThisArea].sort()
  };
  return {
    ...finalized,
    completeness: validateProjectKnowledgeNode(finalized)
  };
}

export function validateProjectKnowledgeNode(node: Partial<ProjectKnowledgeNode>): ProjectKnowledgeNode["completeness"] {
  const missingFields = REQUIRED_KNOWLEDGE_NODE_FIELDS.filter((field) => {
    if (!(field in node)) return true;
    const value = node[field];
    if (value === undefined) return true;
    if (typeof value === "string") return value.trim().length === 0;
    if (Array.isArray(value)) return false;
    if (field === "freshness") return typeof value !== "object" || value === null || !("status" in value);
    return false;
  });
  return {
    status: missingFields.length ? "incomplete" : "complete",
    missingFields: [...missingFields]
  };
}

export function validateProjectKnowledgeTree(input: {
  nodes: ProjectKnowledgeNode[];
  fileOwnership: ProjectKnowledgeFileOwnership[];
  orphanedFiles: Array<{ path: string; reason: string }>;
}): ProjectKnowledgeTree["completeness"] {
  const nodeIds = new Set(input.nodes.map((node) => node.nodeId));
  const missingNodeFields = input.nodes
    .map((node) => ({
      nodeId: node.nodeId || "unknown_node",
      missingFields: validateProjectKnowledgeNode(node).missingFields
    }))
    .filter((entry) => entry.missingFields.length);
  const duplicateOwners = duplicateStrings(input.fileOwnership.map((owner) => owner.path));
  for (const owner of input.fileOwnership) {
    if (!nodeIds.has(owner.primaryOwnerNodeId)) {
      missingNodeFields.push({ nodeId: owner.primaryOwnerNodeId, missingFields: [`ownership for ${owner.path} references missing primary node`] });
    }
  }
  for (const path of duplicateOwners) {
    missingNodeFields.push({ nodeId: "ownership_map", missingFields: [`ambiguous primary ownership for ${path}`] });
  }
  return {
    status: missingNodeFields.length ? "incomplete" : "ready",
    incompleteNodeIds: uniqueStrings(missingNodeFields.map((entry) => entry.nodeId)),
    missingNodeFields
  };
}

function queryTerms(request: string) {
  return uniqueStrings(request.toLowerCase().split(/[^a-z0-9_./-]+/i).filter((term) => term.length >= 2));
}

function scoreFileForQuery(filePath: string, node: ProjectKnowledgeNode | undefined, terms: string[], request: string) {
  const lowerPath = filePath.toLowerCase();
  const haystack = `${lowerPath} ${node?.scope ?? ""} ${(node?.importantSymbols ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerPath.includes(term)) score += 8;
    if (path.basename(lowerPath).includes(term)) score += 5;
    if (haystack.includes(term)) score += 2;
  }
  if (/\blogin|auth|session|jwt|user\b/i.test(request) && /auth|login|session|user|jwt|backend|frontend|api/i.test(filePath)) score += 10;
  if (/\bfrontend|ui|button|page|component|style\b/i.test(request) && /frontend|client|component|page|app|\.tsx|\.jsx|\.css/i.test(filePath)) score += 9;
  if (/\bbackend|api|endpoint|route|server\b/i.test(request) && /backend|api|route|server|main\.py/i.test(filePath)) score += 9;
  if (/\btest|validation|smoke\b/i.test(request) && /test|spec|smoke/i.test(filePath)) score += 10;
  return score;
}

function scoreNodeForQuery(node: ProjectKnowledgeNode, terms: string[], request: string) {
  const haystack = `${node.nodeId} ${node.scope} ${node.summary} ${node.importantSymbols.join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }
  if (/\blogin|auth|session\b/i.test(request) && node.nodeId === "auth") score += 10;
  if (/\bfrontend|ui|component|page\b/i.test(request) && node.nodeId === "frontend_ui") score += 8;
  if (/\bbackend|api|server|route\b/i.test(request) && (node.nodeId === "backend_entry_api" || node.nodeId === "backend_api")) score += 8;
  return score;
}

function choosePrimaryNode(
  affectedNodeIds: string[],
  scoredFiles: Array<{ path: string; score: number }>,
  ownershipByPath: Map<string, ProjectKnowledgeFileOwnership>,
  fallback: string
) {
  const firstFileOwner = scoredFiles[0] ? ownershipByPath.get(scoredFiles[0].path)?.primaryOwnerNodeId : undefined;
  if (firstFileOwner && affectedNodeIds.includes(firstFileOwner)) return firstFileOwner;
  return affectedNodeIds.find((nodeId) => nodeId !== fallback) ?? fallback;
}

function routeConfidence(scoredFiles: Array<{ score: number }>, affectedNodeIds: string[], freshness: ProjectKnowledgeFreshness["status"]) {
  const topScore = scoredFiles[0]?.score ?? 0;
  const directEvidence = scoredFiles.some((entry) => entry.score >= 14);
  const partialAreaMatch = topScore >= 6 || affectedNodeIds.some((nodeId) => nodeId !== ROOT_NODE_ID);
  if (!directEvidence && !partialAreaMatch) {
    return {
      value: 0.18,
      level: "low" as const,
      blockedReason: "No direct file, symbol, config, or partial area evidence was strong enough to route this edit."
    };
  }
  if (freshness !== "fresh") {
    const staleValue = directEvidence ? 0.6 : partialAreaMatch ? 0.45 : 0.18;
    return {
      value: staleValue,
      level: staleValue >= 0.4 ? "medium" as const : "low" as const,
      blockedReason: staleValue < 0.25 ? "Repository memory was not fresh and direct workspace evidence was insufficient." : undefined
    };
  }
  if (directEvidence) {
    return {
      value: Math.min(0.9, Number((0.72 + Math.min(topScore, 30) / 150).toFixed(2))),
      level: "high" as const
    };
  }
  return {
    value: 0.45,
    level: "medium" as const
  };
}

function routeEvidenceUsed(
  scoredFiles: Array<{ path: string; score: number }>,
  affectedNodeIds: string[],
  reviewerNodes: string[],
  tree: ProjectKnowledgeTree
) {
  return uniqueStrings([
    `memory freshness: ${tree.memoryFreshness.status}`,
    ...scoredFiles.slice(0, 6).map((entry) => `file match: ${entry.path} score ${entry.score}`),
    ...affectedNodeIds.slice(0, 6).map((nodeId) => `affected node: ${nodeId}`),
    ...reviewerNodes.slice(0, 6).map((nodeId) => `review node: ${nodeId}`),
    ...tree.evidenceSources.slice(0, 6).map((source) => `source: ${source}`)
  ]);
}

function routeWhy(request: string, likelyFiles: string[], affectedNodeIds: string[], reviewerNodes: string[], freshness: ProjectKnowledgeFreshness["status"]) {
  return uniqueStrings([
    `The request was tokenized and matched against file paths, node scopes, symbols, and ownership evidence: "${request.slice(0, 160)}".`,
    likelyFiles.length ? `Likely files came from ownership-backed scores: ${likelyFiles.slice(0, 5).join(", ")}.` : "No high-confidence file match was found; the route falls back to the root node.",
    `Affected nodes were selected from primary file owners and matching node scopes: ${affectedNodeIds.join(", ")}.`,
    `Reviewer nodes include parents, dependency reviewers, tests/config where relevant, and root integration: ${reviewerNodes.join(", ")}.`,
    freshness === "fresh" ? "Repository memory was fresh and used as evidence." : `Repository memory was ${freshness}; stale/missing memory was not trusted for final routing.`
  ]);
}

function summarizeIntent(request: string) {
  return request.trim().replace(/\s+/g, " ").slice(0, 220) || "Existing-project edit request.";
}

function filesNotToTouch(tree: ProjectKnowledgeTree, targetFiles: string[]) {
  const targetSet = new Set(targetFiles);
  return uniqueStrings([
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "target/",
    ...tree.fileOwnership
      .map((owner) => owner.path)
      .filter((file) => !targetSet.has(file) && /lock|package-lock|pnpm-lock|yarn\.lock|cargo\.lock/i.test(file))
      .slice(0, 8)
  ]);
}

function crossNodeRisks(route: KnowledgeQueryRoute, tree: ProjectKnowledgeTree) {
  const nodeById = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const scopes = uniqueStrings(route.affectedNodeIds.map((nodeId) => nodeById.get(nodeId)?.parent ?? nodeId));
  return uniqueStrings([
    scopes.length > 2 ? "Multiple parent scopes are affected; root integration review is required before execution." : "",
    route.reviewerNodes.includes("tests_validation") ? "Validation ownership is implicated; tests should be selected by the validation node before execution." : "",
    route.reviewerNodes.includes("config_dependencies") ? "Config/dependency ownership is implicated; avoid manifest changes unless explicitly required." : "",
    tree.memoryFreshness.status === "fresh" ? "" : "Routing used direct workspace evidence because memory was not fresh."
  ]);
}

export function createKnowledgeBranchTargets(input: {
  tree: ProjectKnowledgeTree;
  route: KnowledgeQueryRoute;
  request: string;
  reviewChain: KnowledgeRoutedEdit["reviewChain"];
  createdAt?: string;
}): KnowledgeBranchTarget[] {
  const now = input.createdAt ?? new Date().toISOString();
  const nodeById = new Map(input.tree.nodes.map((node) => [node.nodeId, node]));
  const orphanedPaths = new Set(input.tree.orphanedFiles.map((file) => file.path));
  const routeConfidenceLevel = input.tree.memoryFreshness.status === "fresh"
    ? input.route.confidenceLevel
    : input.route.confidenceLevel === "high" ? "medium" : input.route.confidenceLevel;
  const routeConfidence = input.tree.memoryFreshness.status === "fresh"
    ? input.route.confidence
    : Math.min(input.route.confidence, 0.6);
  const filesForbidden = filesNotToTouch(input.tree, input.route.likelyFiles);
  const targets = routePrimaryOwnerGroups(input.tree, input.route).map((group) => {
    const ownerNode = nodeById.get(group.primaryOwnerNodeId);
    const blockedReasons: KnowledgeBranchTargetBlockedReason[] = [];
    if (!group.files.length) blockedReasons.push("missing_allowed_files");
    if (!ownerNode || ownerNode.completeness.status !== "complete") blockedReasons.push("owner_node_incomplete");
    if (ownerNode?.freshness.status && ownerNode.freshness.status !== "fresh") blockedReasons.push("owner_node_stale");
    if (group.files.some((file) => orphanedPaths.has(file) || !input.tree.ownershipMap[file])) blockedReasons.push("orphaned_file_scope");
    if (routeConfidenceLevel === "low") blockedReasons.push("confidence_too_low");
    const requiredReviewChain = targetReviewChain(input.reviewChain, group.sourceKnowledgeNodeId, group.primaryOwnerNodeId, nodeById);
    const missingReviewers = missingReviewChainNodes(requiredReviewChain, nodeById);
    if (missingReviewers.length) blockedReasons.push("review_chain_incomplete");
    const status: KnowledgeBranchTarget["status"] = missingReviewers.length
      ? "blocked_review_chain_incomplete"
      : blockedReasons.length ? "blocked" : "planned";
    return {
      targetId: `knowledge_target_${stableId(`${group.sourceKnowledgeNodeId}_${group.primaryOwnerNodeId}_${group.files.join("_")}`)}`,
      sourceKnowledgeNodeId: group.sourceKnowledgeNodeId,
      scope: ownerNode?.scope ?? group.primaryOwnerNodeId,
      objective: `Plan a ${routeConfidenceLevel === "low" ? "read-only investigation" : "patch candidate"} branch for ${ownerNode?.scope ?? group.primaryOwnerNodeId}: ${summarizeIntent(input.request)}`,
      filesAllowed: group.files,
      filesForbidden,
      primaryOwnerNodeId: group.primaryOwnerNodeId,
      reviewerNodeIds: uniqueStrings([
        ...(input.tree.ownershipMap[group.files[0] ?? ""]?.reviewerNodeIds ?? []),
        ...input.route.reviewerNodes,
        ...requiredReviewChain.leafReview,
        ...requiredReviewChain.parentScopeReview,
        ...requiredReviewChain.siblingAffectedNodeReview,
        ...requiredReviewChain.rootIntegrationReview
      ]).filter((nodeId) => nodeId !== group.primaryOwnerNodeId && nodeById.has(nodeId)),
      dependencyNodeIds: uniqueStrings(group.files.flatMap((file) => input.tree.ownershipMap[file]?.dependencyNodeIds ?? [])).filter((nodeId) => nodeById.has(nodeId)),
      risks: uniqueStrings([
        ...(ownerNode?.risks ?? []),
        ...input.route.risks,
        ...blockedReasons.map((reason) => `Blocked by ${reason}.`)
      ]).slice(0, 12),
      evidenceUsed: uniqueStrings([
        ...input.route.evidenceUsed,
        `source knowledge node: ${group.sourceKnowledgeNodeId}`,
        `primary owner node: ${group.primaryOwnerNodeId}`,
        ...group.files.map((file) => `allowed file: ${file}`)
      ]),
      confidence: routeConfidence,
      confidenceLevel: routeConfidenceLevel,
      requiredReviewChain,
      executionModeHint: (routeConfidenceLevel === "low" || status !== "planned" ? "read_only" : "patch_candidate") as KnowledgeBranchTarget["executionModeHint"],
      status,
      blockedReasons: uniqueStrings(blockedReasons) as KnowledgeBranchTargetBlockedReason[],
      freshness: ownerNode?.freshness ?? input.tree.memoryFreshness,
      recursiveBranchId: `knowledge_branch_${stableId(group.primaryOwnerNodeId)}`,
      createdAt: now
    };
  });
  return markUnsafeScopeOverlaps(targets).slice(0, 12);
}

export function createKnowledgeRecursivePlanning(input: {
  sessionId: string;
  routedEdit: KnowledgeRoutedEdit;
  targets?: KnowledgeBranchTarget[];
  createdAt?: string;
}): {
  graph: HierarchicalRecursiveGraph;
  branchOrchestrators: BranchOrchestratorRecord[];
  branchExecutions: RecursiveBranchExecutionRecord[];
} {
  const now = input.createdAt ?? new Date().toISOString();
  const graphId = `knowledge_recursive_graph_${stableId(input.routedEdit.id)}`;
  const targets = input.targets ?? input.routedEdit.knowledgeBranchTargets;
  const branchOrchestrators = targets.map((target) => knowledgeTargetToBranchOrchestrator({
    sessionId: input.sessionId,
    graphId,
    target,
    routedEdit: input.routedEdit,
    createdAt: now
  }));
  const branchExecutions = targets.map((target) => knowledgeTargetToPlannedBranchExecution({
    sessionId: input.sessionId,
    target,
    routedEdit: input.routedEdit,
    createdAt: now
  }));
  const blockedTargets = targets.filter((target) => target.status !== "planned");
  const status = blockedTargets.length ? "blocked" : "ready";
  const graph: HierarchicalRecursiveGraph = {
    id: graphId,
    sessionId: input.sessionId,
    technicalPlanId: input.routedEdit.plan.id,
    status,
    rootGoal: input.routedEdit.intentSummary,
    rootNode: {
      id: `${graphId}_root`,
      title: "Knowledge-Routed Recursive Branch Plan",
      objective: input.routedEdit.intentSummary
    },
    branches: branchOrchestrators,
    dependencies: deriveKnowledgeBranchDependencies(branchOrchestrators),
    conflicts: [],
    readiness: {
      status,
      summary: status === "ready"
        ? "Knowledge branch targets are planned for future recursive execution. Execution has not started."
        : `Knowledge branch targets are blocked by ${uniqueStrings(blockedTargets.flatMap((target) => target.blockedReasons)).join(", ")}.`,
      blockedReasons: [],
      checkedAt: now
    },
    createdAt: now,
    updatedAt: now
  };
  return { graph, branchOrchestrators, branchExecutions };
}

function routePrimaryOwnerGroups(tree: ProjectKnowledgeTree, route: KnowledgeQueryRoute) {
  const nodeById = new Map(tree.nodes.map((node) => [node.nodeId, node]));
  const likelyFiles = route.likelyFiles.filter((file) => !file.endsWith("/"));
  const groups = new Map<string, { sourceKnowledgeNodeId: string; primaryOwnerNodeId: string; files: string[] }>();
  for (const file of likelyFiles) {
    const owner = tree.ownershipMap[file];
    if (!owner) {
      const key = `orphan:${file}`;
      groups.set(key, { sourceKnowledgeNodeId: route.primaryNode, primaryOwnerNodeId: "orphaned_file_scope", files: [file] });
      continue;
    }
    const sourceKnowledgeNodeId = route.affectedNodeIds.find((nodeId) =>
      nodeId === owner.primaryOwnerNodeId || nodeIsAncestorOf(nodeId, owner.primaryOwnerNodeId, nodeById)
    ) ?? owner.primaryOwnerNodeId;
    const key = `${sourceKnowledgeNodeId}:${owner.primaryOwnerNodeId}`;
    const group = groups.get(key) ?? { sourceKnowledgeNodeId, primaryOwnerNodeId: owner.primaryOwnerNodeId, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }
  if (!groups.size && route.primaryNode !== ROOT_NODE_ID) {
    groups.set(route.primaryNode, { sourceKnowledgeNodeId: route.primaryNode, primaryOwnerNodeId: route.primaryNode, files: [] });
  }
  return [...groups.values()].map((group) => ({ ...group, files: uniqueStrings(group.files).sort() }));
}

function targetReviewChain(
  reviewChain: KnowledgeRoutedEdit["reviewChain"],
  sourceKnowledgeNodeId: string,
  primaryOwnerNodeId: string,
  nodeById: Map<string, ProjectKnowledgeNode>
): KnowledgeBranchTarget["requiredReviewChain"] {
  const owner = nodeById.get(primaryOwnerNodeId);
  const leafReview = uniqueStrings([
    ...reviewChain.leafReview,
    nodeById.get(primaryOwnerNodeId)?.scope.startsWith("file/module expert") ? primaryOwnerNodeId : "",
    nodeById.get(sourceKnowledgeNodeId)?.scope.startsWith("file/module expert") ? sourceKnowledgeNodeId : ""
  ]);
  const parentScopeReview = uniqueStrings([
    ...reviewChain.parentScopeReview,
    owner?.parent ?? "",
    nodeById.get(sourceKnowledgeNodeId)?.parent ?? ""
  ]);
  return {
    leafReview,
    parentScopeReview,
    siblingAffectedNodeReview: uniqueStrings(reviewChain.siblingAffectedNodeReview),
    rootIntegrationReview: uniqueStrings(reviewChain.rootIntegrationReview.length ? reviewChain.rootIntegrationReview : [ROOT_NODE_ID])
  };
}

function missingReviewChainNodes(reviewChain: KnowledgeBranchTarget["requiredReviewChain"], nodeById: Map<string, ProjectKnowledgeNode>) {
  return uniqueStrings([
    ...reviewChain.leafReview,
    ...reviewChain.parentScopeReview,
    ...reviewChain.siblingAffectedNodeReview,
    ...reviewChain.rootIntegrationReview
  ]).filter((nodeId) => !nodeById.has(nodeId));
}

function markUnsafeScopeOverlaps(targets: KnowledgeBranchTarget[]) {
  const targetIdsByFile = new Map<string, string[]>();
  for (const target of targets) {
    for (const file of target.filesAllowed) {
      targetIdsByFile.set(file, [...(targetIdsByFile.get(file) ?? []), target.targetId]);
    }
  }
  const unsafeTargetIds = new Set<string>();
  for (const targetIds of targetIdsByFile.values()) {
    if (targetIds.length > 1) {
      for (const targetId of targetIds) unsafeTargetIds.add(targetId);
    }
  }
  if (!unsafeTargetIds.size) return targets;
  return targets.map((target) => {
    if (!unsafeTargetIds.has(target.targetId)) return target;
    const blockedReasons = uniqueStrings([...target.blockedReasons, "unsafe_scope_overlap"]) as KnowledgeBranchTargetBlockedReason[];
    return {
      ...target,
      status: target.status === "blocked_review_chain_incomplete" ? target.status : "blocked" as const,
      blockedReasons,
      executionModeHint: "read_only" as const,
      risks: uniqueStrings([...target.risks, "Blocked by unsafe_scope_overlap."])
    };
  });
}

function knowledgeTargetToBranchOrchestrator(input: {
  sessionId: string;
  graphId: string;
  target: KnowledgeBranchTarget;
  routedEdit: KnowledgeRoutedEdit;
  createdAt: string;
}): BranchOrchestratorRecord {
  const branchId = input.target.recursiveBranchId ?? `knowledge_branch_${stableId(input.target.targetId)}`;
  return {
    branchId,
    sessionId: input.sessionId,
    graphId: input.graphId,
    title: `Knowledge branch: ${input.target.scope}`,
    objective: input.target.objective,
    ownerRole: `${input.target.primaryOwnerNodeId} owner`,
    inputContextRequirements: [
      "Knowledge-Routed Edit Plan",
      `Knowledge target ${input.target.targetId}`,
      ...input.target.evidenceUsed.slice(0, 8)
    ],
    fileScopes: input.target.filesAllowed,
    semanticScopes: [input.target.scope, input.target.sourceKnowledgeNodeId],
    lockScopes: input.target.filesAllowed.map((file) => `file:${file}`),
    dependencies: input.target.dependencyNodeIds.map((nodeId) => `knowledge_dependency_${stableId(nodeId)}`),
    expectedOutputs: [
      "Future patch candidate scoped to filesAllowed.",
      "Reviewer handoff using requiredReviewChain.",
      "No execution in this planning-only slice."
    ],
    reviewerRequirements: uniqueStrings([
      ...input.target.reviewerNodeIds,
      ...input.target.requiredReviewChain.leafReview,
      ...input.target.requiredReviewChain.parentScopeReview,
      ...input.target.requiredReviewChain.siblingAffectedNodeReview,
      ...input.target.requiredReviewChain.rootIntegrationReview
    ]),
    testerRequirements: ["Validation command selection is deferred. No validation command is run during target planning."],
    status: input.target.status === "planned" ? "planned_only" : "blocked",
    risks: input.target.risks,
    validationStrategy: ["Plan validation later from the tests/validation knowledge node. No commands run now."],
    expectedIntegrationPoints: [
      `Root integration review for ${input.routedEdit.id}`,
      ...input.target.requiredReviewChain.rootIntegrationReview
    ],
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function knowledgeTargetToPlannedBranchExecution(input: {
  sessionId: string;
  target: KnowledgeBranchTarget;
  routedEdit: KnowledgeRoutedEdit;
  createdAt: string;
}): RecursiveBranchExecutionRecord {
  const branchId = input.target.recursiveBranchId ?? `knowledge_branch_${stableId(input.target.targetId)}`;
  return {
    branchId,
    sessionId: input.sessionId,
    title: `Knowledge branch: ${input.target.scope}`,
    status: input.target.status === "planned" ? "planned_only" : "blocked",
    active: false,
    executionContext: {
      branchObjective: input.target.objective,
      approvedProductSpecSummary: input.routedEdit.intentSummary,
      approvedTechnicalPlanSummary: "Knowledge branch target planning only. Execution has not started.",
      fileScopes: input.target.filesAllowed,
      semanticScopes: [input.target.scope, input.target.sourceKnowledgeNodeId],
      lockScopes: input.target.filesAllowed.map((file) => `file:${file}`),
      dependencies: input.target.dependencyNodeIds,
      evidenceContextPack: input.target.evidenceUsed
    },
    schedulerDecision: {
      maxActiveWriteBranches: 0,
      writeBranch: false,
      blockedReason: "execution_not_approved",
      sequencingReason: "KnowledgeBranchTarget created a future recursive branch plan only; no branch executor starts."
    },
    reviewStatus: input.target.status === "planned" ? "not_started" : "blocked",
    validationStatus: "not_run_needs_approval",
    validationPlan: ["No validation command is run during KnowledgeBranchTarget planning."],
    blockedReason: input.target.blockedReasons.join(", ") || undefined,
    patchApplied: false,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}

function deriveKnowledgeBranchDependencies(branches: BranchOrchestratorRecord[]) {
  const branchIds = new Set(branches.map((branch) => branch.branchId));
  return branches.flatMap((branch) =>
    branch.dependencies
      .filter((dependency) => branchIds.has(dependency))
      .map((dependency) => ({ from: dependency, to: branch.branchId, reason: "Knowledge target dependency node." }))
  );
}

function nodeIsAncestorOf(ancestorId: string, nodeId: string, nodeById: Map<string, ProjectKnowledgeNode>) {
  let current = nodeById.get(nodeId);
  while (current?.parent) {
    if (current.parent === ancestorId) return true;
    current = nodeById.get(current.parent);
  }
  return false;
}

function fileNodeId(filePath: string) {
  return `file_${filePath.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)}`;
}

function ownerLabel(scope: string) {
  if (scope === "whole project") return "Root Project Mapper";
  return `${scope} Knowledge Node`;
}

function rolesForPath(filePath: string): FileManifestEntry["roles"] {
  const roles: FileManifestEntry["roles"] = [];
  if (/\.(ts|tsx|js|jsx|rs|py|go|java|cs)$/i.test(filePath)) roles.push("source");
  if (/(^|\/)(tests?|__tests__)(\/|$)|(\.test\.|\.spec\.)/i.test(filePath)) roles.push("test");
  if (/package\.json|tsconfig|cargo\.toml|pyproject|vite\.config|tauri\.conf|requirements/i.test(filePath)) roles.push("config");
  if (/lock|requirements|package\.json|cargo\.toml/i.test(filePath)) roles.push("dependency");
  if (/readme|\.md$/i.test(filePath)) roles.push("doc");
  if (/(^|\/)(main|index|app|server)\.(ts|tsx|js|jsx|rs|py|html)$/i.test(filePath)) roles.push("entrypoint");
  return roles.length ? roles : ["other"];
}

function isImportantKnowledgeFilePath(filePath: string, roles: string[]) {
  return roles.some((role) => ["source", "test", "config", "dependency", "entrypoint", "package", "build"].includes(role))
    || /\.(ts|tsx|js|jsx|rs|py|go|java|cs)$/i.test(filePath)
    || /(^|\/)(readme|requirements|package\.json|cargo\.toml|pyproject\.toml|tests?)(\/|$)?/i.test(filePath);
}

function isTextLike(filePath: string) {
  return /\.(ts|tsx|js|jsx|rs|py|go|java|cs|css|html|md|json|toml|yaml|yml|txt)$/i.test(filePath)
    || /(^|\/)(makefile|dockerfile|requirements\.txt|cargo\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(filePath);
}

function languageForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".rs": "Rust",
    ".py": "Python",
    ".css": "CSS",
    ".html": "HTML",
    ".md": "Markdown",
    ".json": "JSON",
    ".toml": "TOML",
    ".yaml": "YAML",
    ".yml": "YAML"
  };
  return map[extension];
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.$/, "");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function stableId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "target";
}

function duplicateStrings(values: string[]) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}
