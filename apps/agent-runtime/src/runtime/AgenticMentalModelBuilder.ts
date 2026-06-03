import type { AgenticEvidenceGraph, AgenticFileSummary, AgenticMentalModel } from "./AgenticTaskModels.js";

export function buildAgenticMentalModel(input: {
  fileSummaries: AgenticFileSummary[];
  evidenceGraph: AgenticEvidenceGraph;
}): AgenticMentalModel {
  const importantFiles = uniqueStrings(input.evidenceGraph.accepted.map((item) => item.path)).slice(0, 16);
  const components = componentGroups(input.fileSummaries, importantFiles);
  const responsibilities = components.map((component) => ({
    component: component.name,
    summary: responsibilityForComponent(component.paths, input.fileSummaries),
    evidenceIds: evidenceIdsForPaths(input.evidenceGraph, component.paths)
  }));
  const productionEvidence = input.evidenceGraph.accepted
    .filter((item) => item.canSupportProductionBehavior)
    .map((item) => formatEvidenceRef(item))
    .slice(0, 20);
  const testOrSupportEvidence = input.evidenceGraph.downgraded
    .filter((item) => item.evidenceType === "test" || item.evidenceType === "docs" || item.evidenceType === "config")
    .map((item) => formatEvidenceRef(item))
    .slice(0, 20);
  const rejectedOrDowngradedEvidence = [...input.evidenceGraph.downgraded, ...input.evidenceGraph.rejected]
    .map((item) => `${formatEvidenceRef(item)} (${item.provenanceStatus}: ${item.provenance.reason})`)
    .slice(0, 20);
  const unknowns = input.evidenceGraph.summary.productionEvidenceCount
    ? []
    : ["No accepted production evidence was found for the core claim."];
  const risks = input.evidenceGraph.rejected.length
    ? ["Some candidate evidence was rejected or downgraded, so production behavior claims must avoid relying on it."]
    : [];
  return {
    relevantComponents: components,
    responsibilities,
    relationships: input.evidenceGraph.relationships.slice(0, 40),
    dataOrControlFlow: input.evidenceGraph.relationships
      .filter((relationship) => relationship.kind === "route" || relationship.kind === "import" || relationship.kind === "call")
      .slice(0, 12)
      .map((relationship) => relationship.toPath ? `${relationship.fromPath} -> ${relationship.toPath}` : `${relationship.fromPath}: ${relationship.symbol ?? relationship.kind}`),
    importantFiles,
    risks,
    unknowns,
    testOrSupportEvidence,
    productionEvidence,
    rejectedOrDowngradedEvidence,
    confidence: input.evidenceGraph.summary.confidence
  };
}

function componentGroups(fileSummaries: AgenticFileSummary[], importantFiles: string[]) {
  const groups = new Map<string, string[]>();
  for (const file of importantFiles) {
    const name = componentName(file);
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  if (!groups.size) {
    for (const summary of fileSummaries.slice(0, 6)) {
      const name = componentName(summary.path);
      groups.set(name, [...(groups.get(name) ?? []), summary.path]);
    }
  }
  return [...groups.entries()].map(([name, paths]) => ({
    name,
    paths: uniqueStrings(paths),
    evidenceIds: [] as string[]
  })).slice(0, 10);
}

function responsibilityForComponent(paths: string[], summaries: AgenticFileSummary[]) {
  const relevant = summaries.filter((summary) => paths.includes(summary.path));
  const symbols = uniqueStrings(relevant.flatMap((summary) => summary.symbols)).slice(0, 6);
  const routes = uniqueStrings(relevant.flatMap((summary) => summary.routes)).slice(0, 4);
  const fragments = [];
  if (symbols.length) fragments.push(`defines ${symbols.join(", ")}`);
  if (routes.length) fragments.push(`registers ${routes.join(", ")}`);
  return fragments.length ? fragments.join("; ") : "opened as relevant source for the requested task";
}

function componentName(filePath: string) {
  const parts = filePath.split("/");
  if (parts[0] === "apps" && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "packages" && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  if (parts[0] === "src" && parts[1]) return `src/${parts[1]}`;
  return parts[0] ?? filePath;
}

function evidenceIdsForPaths(graph: AgenticEvidenceGraph, paths: string[]) {
  return paths.flatMap((path) => graph.byPath[path]?.map((item) => item.id) ?? []).slice(0, 20);
}

function formatEvidenceRef(item: { path: string; lineStart?: number }) {
  return `${item.path}:${item.lineStart ?? 1}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
