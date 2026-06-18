import { createHash } from "node:crypto";
import path from "node:path";
import type {
  FileManifestEntry,
  FileSummaryRecord,
  SemanticProjectModel,
  SemanticProjectNode,
  SemanticProjectRelationship,
  SymbolIndex
} from "./types.js";

export function buildSemanticProjectModel(input: {
  generatedAt: string;
  manifestHash: string;
  manifest: FileManifestEntry[];
  summaries: FileSummaryRecord[];
  symbols: SymbolIndex;
  fileText: Map<string, string>;
}): SemanticProjectModel {
  const nodes: SemanticProjectNode[] = [];
  const relationships: SemanticProjectRelationship[] = [];
  const nodeIds = new Set<string>();
  const symbolNodesByName = new Map<string, SemanticProjectNode[]>();
  const summaryByPath = new Map(input.summaries.map((summary) => [summary.path, summary]));
  const manifestByPath = new Map(input.manifest.map((file) => [file.path, file]));

  for (const file of input.manifest) {
    const summary = summaryByPath.get(file.path);
    addNode(nodes, nodeIds, {
      id: fileNodeId(file.path),
      kind: "file",
      name: file.path,
      path: file.path,
      summary: semanticFileText(summary, file.path),
      contentHash: file.hashSha256 ?? hash(file.path),
      evidenceRefs: [`${file.path}:1`],
      freshness: "current"
    });
  }

  for (const symbol of input.symbols.symbols) {
    const fileHash = manifestByPath.get(symbol.path)?.hashSha256 ?? hash(symbol.path);
    const node: SemanticProjectNode = {
      id: symbolNodeId(symbol.path, symbol.name, symbol.line),
      kind: "symbol",
      name: symbol.name,
      path: symbol.path,
      line: symbol.line,
      summary: `${symbol.kind} ${symbol.name} in ${symbol.path}`,
      contentHash: hash(`${fileHash}:${symbol.name}:${symbol.kind}:${symbol.line}`),
      evidenceRefs: [`${symbol.path}:${symbol.line}`],
      freshness: "current"
    };
    addNode(nodes, nodeIds, node);
    symbolNodesByName.set(symbol.name, [...(symbolNodesByName.get(symbol.name) ?? []), node]);
    addRelationship(relationships, {
      fromNodeId: fileNodeId(symbol.path),
      toNodeId: node.id,
      kind: symbol.exported ? "export" : "contains",
      confidence: "high",
      reason: `${symbol.path} defines ${symbol.kind} ${symbol.name}.`,
      evidenceRefs: [`${symbol.path}:${symbol.line}`],
      contentHash: node.contentHash,
      freshness: "current"
    });
  }

  for (const summary of input.summaries) {
    const sourceId = fileNodeId(summary.path);
    for (const imported of summary.imports) {
      const targetPath = resolveImport(summary.path, imported, manifestByPath);
      if (!targetPath) continue;
      addRelationship(relationships, {
        fromNodeId: sourceId,
        toNodeId: fileNodeId(targetPath),
        kind: "import",
        confidence: "high",
        reason: `${summary.path} imports ${imported}.`,
        evidenceRefs: [`${summary.path}:1`],
        contentHash: hash(`${manifestByPath.get(summary.path)?.hashSha256}:${targetPath}`),
        freshness: "current"
      });
    }
    if (summary.roles.includes("test")) {
      for (const source of likelyTestSources(summary.path, manifestByPath)) {
        addRelationship(relationships, {
          fromNodeId: sourceId,
          toNodeId: fileNodeId(source),
          kind: "test_to_source",
          confidence: "medium",
          reason: `${summary.path} appears to test ${source}.`,
          evidenceRefs: [`${summary.path}:1`],
          contentHash: hash(`${summary.path}:${source}`),
          freshness: "current"
        });
      }
    }
    relationships.push(...extractTextRelationships({
      filePath: summary.path,
      text: input.fileText.get(summary.path) ?? "",
      sourceId,
      symbolNodesByName,
      nodeIds,
      nodes,
      fileHash: manifestByPath.get(summary.path)?.hashSha256 ?? hash(summary.path)
    }));
  }
  relationships.push(...extractCrossFileRelationships({
    fileText: input.fileText,
    manifestByPath,
    nodes,
    nodeIds
  }));

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    manifestHash: input.manifestHash,
    nodes: dedupe(nodes, (node) => node.id),
    relationships: dedupe(relationships, (relationship) => relationship.id)
  };
}

function extractCrossFileRelationships(input: {
  fileText: Map<string, string>;
  manifestByPath: Map<string, FileManifestEntry>;
  nodes: SemanticProjectNode[];
  nodeIds: Set<string>;
}) {
  const relationships: SemanticProjectRelationship[] = [];
  const sharedEvidence = new Map<string, Set<string>>();
  const addSharedEvidence = (id: string, ref: string) => {
    const refs = sharedEvidence.get(id) ?? new Set<string>();
    refs.add(ref);
    sharedEvidence.set(id, refs);
  };

  for (const [filePath, text] of input.fileText) {
    const sourceId = fileNodeId(filePath);
    const fileHash = input.manifestByPath.get(filePath)?.hashSha256 ?? hash(filePath);
    text.split(/\r?\n/).forEach((line, index) => {
      const lineNumber = index + 1;
      const evidenceRef = `${filePath}:${lineNumber}`;
      const endpoint = extractEndpoint(line);
      if (endpoint) {
        const routeId = `route:shared:${endpoint}`;
        addSharedEvidence(routeId, evidenceRef);
        const clientCall = /\b(?:fetch|api(?:Get|Post|Put|Patch|Delete)|axios(?:\.(?:get|post|put|patch|delete))?)\s*\(/i.test(line);
        addRelationship(relationships, {
          fromNodeId: sourceId,
          toNodeId: routeId,
          kind: clientCall ? "ui_to_api" : "route",
          confidence: clientCall ? "medium" : "high",
          reason: clientCall ? `${filePath} calls API route ${endpoint}.` : `${filePath} declares route ${endpoint}.`,
          evidenceRefs: [evidenceRef],
          contentHash: hash(`${fileHash}:${lineNumber}:${endpoint}:${clientCall ? "client" : "server"}`),
          freshness: "current"
        });
      }

      if (isStorageLine(line)) {
        addSharedEvidence("concept:storage", evidenceRef);
        addRelationship(relationships, {
          fromNodeId: sourceId,
          toNodeId: "concept:storage",
          kind: "storage",
          confidence: "medium",
          reason: `${filePath} contains a storage interaction.`,
          evidenceRefs: [evidenceRef],
          contentHash: hash(`${fileHash}:${lineNumber}:storage`),
          freshness: "current"
        });
      }

      for (const field of producedFields(line)) {
        const fieldId = `data_field:${field}`;
        addSharedEvidence(fieldId, evidenceRef);
        addRelationship(relationships, {
          fromNodeId: sourceId,
          toNodeId: fieldId,
          kind: "produces",
          confidence: "medium",
          reason: `${filePath} produces data field ${field}.`,
          evidenceRefs: [evidenceRef],
          contentHash: hash(`${fileHash}:${lineNumber}:produces:${field}`),
          freshness: "current"
        });
      }
      for (const field of consumedFields(line)) {
        const fieldId = `data_field:${field}`;
        addSharedEvidence(fieldId, evidenceRef);
        addRelationship(relationships, {
          fromNodeId: fieldId,
          toNodeId: sourceId,
          kind: "consumes",
          confidence: "medium",
          reason: `${filePath} consumes data field ${field}.`,
          evidenceRefs: [evidenceRef],
          contentHash: hash(`${fileHash}:${lineNumber}:consumes:${field}`),
          freshness: "current"
        });
      }
    });
  }

  for (const [id, refs] of sharedEvidence) {
    const evidenceRefs = [...refs].sort();
    const kind = id.startsWith("route:") ? "route" : id.startsWith("data_field:") ? "data_field" : "concept";
    const name = id.replace(/^(?:route:shared:|data_field:|concept:)/, "");
    addNode(input.nodes, input.nodeIds, {
      id,
      kind,
      name,
      summary: kind === "route" ? `Shared API route ${name}.` : kind === "data_field" ? `Data field ${name}.` : `Project concept ${name}.`,
      contentHash: hash(`${id}:${evidenceRefs.join("|")}`),
      evidenceRefs,
      freshness: "current"
    });
  }
  return relationships;
}

function extractEndpoint(line: string) {
  const declaration = line.match(/(?:route|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete))\s*\(?\s*["'`]([^"'`]+)["'`]/i);
  if (declaration?.[1]) return declaration[1];
  const client = line.match(/\b(?:fetch|api(?:Get|Post|Put|Patch|Delete)|axios(?:\.(?:get|post|put|patch|delete))?)\s*\(\s*["'`]([^"'`]+)["'`]/i);
  return client?.[1];
}

function isStorageLine(line: string) {
  return /\b(?:INSERT\s+INTO|SELECT\b.+\bFROM|UPDATE\b.+\bSET|DELETE\s+FROM|localStorage|sessionStorage|DatabaseSync|sqlite|rusqlite|\.save\s*\(|\.write\s*\()/i.test(line);
}

function producedFields(line: string) {
  const object = line.match(/\b(?:return|json|send|emit|write|save)\s*\(?\s*\{([^}\n]{0,300})/i)?.[1];
  return object ? unique(Array.from(object.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)).map((match) => match[1] ?? "").filter(validDataField)) : [];
}

function consumedFields(line: string) {
  const direct = Array.from(line.matchAll(/\b(?:body|data|payload|result|response|record|row|input)\.([A-Za-z_][A-Za-z0-9_]*)\b/g))
    .map((match) => match[1] ?? "");
  const destructured = line.match(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=/)?.[1]
    ?.split(",")
    .map((field) => field.trim().split(/[:=]/)[0]?.trim() ?? "") ?? [];
  return unique([...direct, ...destructured].filter(validDataField));
}

function validDataField(field: string) {
  return field.length >= 3 && !["const", "false", "function", "return", "true", "undefined"].includes(field);
}

export function semanticNodeEmbeddingText(node: SemanticProjectNode) {
  return [node.kind, node.name, node.path ?? "", node.summary].filter(Boolean).join("\n");
}

function extractTextRelationships(input: {
  filePath: string;
  text: string;
  sourceId: string;
  symbolNodesByName: Map<string, SemanticProjectNode[]>;
  nodeIds: Set<string>;
  nodes: SemanticProjectNode[];
  fileHash: string;
}) {
  const relationships: SemanticProjectRelationship[] = [];
  const lines = input.text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const target = input.symbolNodesByName.get(match[1] ?? "")?.find((candidate) => candidate.path !== input.filePath);
      if (target) {
        addRelationship(relationships, {
          fromNodeId: input.sourceId,
          toNodeId: target.id,
          kind: "call",
          confidence: "medium",
          reason: `${input.filePath} calls ${target.name}.`,
          evidenceRefs: [`${input.filePath}:${lineNumber}`, ...target.evidenceRefs],
          contentHash: hash(`${input.fileHash}:${lineNumber}:${target.id}`),
          freshness: "current"
        });
      }
    }
    const route = line.match(/(?:route|router\.(?:get|post|put|patch|delete)|app\.(?:get|post|put|patch|delete))\s*\(?\s*["'`]([^"'`]+)["'`]/i);
    if (route?.[1]) {
      const node: SemanticProjectNode = {
        id: `route:${input.filePath}:${route[1]}`,
        kind: "route",
        name: route[1],
        path: input.filePath,
        line: lineNumber,
        summary: `Route ${route[1]} declared in ${input.filePath}.`,
        contentHash: hash(`${input.fileHash}:${route[1]}`),
        evidenceRefs: [`${input.filePath}:${lineNumber}`],
        freshness: "current"
      };
      addNode(input.nodes, input.nodeIds, node);
      addRelationship(relationships, {
        fromNodeId: input.sourceId,
        toNodeId: node.id,
        kind: "route",
        confidence: "high",
        reason: node.summary,
        evidenceRefs: node.evidenceRefs,
        contentHash: node.contentHash,
        freshness: "current"
      });
    }
  });
  return relationships;
}

function semanticFileText(summary: FileSummaryRecord | undefined, filePath: string) {
  if (!summary) return `File ${filePath}.`;
  return [
    summary.purposeGuess,
    `roles: ${summary.roles.join(", ")}`,
    summary.exports.length ? `exports: ${summary.exports.join(", ")}` : "",
    summary.imports.length ? `imports: ${summary.imports.join(", ")}` : "",
    summary.symbols.length ? `symbols: ${summary.symbols.map((symbol) => symbol.name).join(", ")}` : ""
  ].filter(Boolean).join("; ");
}

function resolveImport(sourcePath: string, imported: string, manifest: Map<string, FileManifestEntry>) {
  if (!imported.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), imported)).replaceAll("\\", "/");
  return [base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".rs", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => `${base}${suffix}`)]
    .find((candidate) => manifest.has(candidate));
}

function likelyTestSources(testPath: string, manifest: Map<string, FileManifestEntry>) {
  const base = testPath.replace(/\.(test|spec)(?=\.)/i, "");
  return [base, base.replace(/(^|\/)tests?\//i, "$1src/")].filter((candidate) => candidate !== testPath && manifest.has(candidate));
}

function fileNodeId(filePath: string) {
  return `file:${filePath}`;
}

function symbolNodeId(filePath: string, name: string, line: number) {
  return `symbol:${filePath}:${line}:${name}`;
}

function addNode(nodes: SemanticProjectNode[], ids: Set<string>, node: SemanticProjectNode) {
  if (ids.has(node.id)) return;
  ids.add(node.id);
  nodes.push(node);
}

function addRelationship(relationships: SemanticProjectRelationship[], relationship: Omit<SemanticProjectRelationship, "id">) {
  relationships.push({
    ...relationship,
    id: `rel:${hash(`${relationship.fromNodeId}:${relationship.kind}:${relationship.toNodeId}`).slice(0, 24)}`
  });
}

function dedupe<T>(values: T[], key: (value: T) => string) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
