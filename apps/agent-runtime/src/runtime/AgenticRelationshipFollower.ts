import path from "node:path";
import type { AgenticFileSummary, AgenticOpenedFile, AgenticReadBudget, AgenticRelationship } from "./AgenticTaskModels.js";

const IMPORT_RE = /^\s*import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']|^\s*export\s+[^'"]+\s+from\s+["']([^"']+)["']|^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm;
const JS_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const ROUTE_RE = /\b(app|router|server)\.(get|post|put|patch|delete|route|use)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
const PY_ROUTE_RE = /@\w+\.route\s*\(\s*["']([^"']+)["']/gi;
const SYMBOL_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;

export function summarizeAgenticFiles(openedFiles: AgenticOpenedFile[]): AgenticFileSummary[] {
  return openedFiles.map((file) => {
    const imports = extractImports(file.content);
    const exports = extractExports(file.content);
    const symbols = extractSymbols(file.content).slice(0, 20);
    const routes = extractRoutes(file.content).slice(0, 12);
    const calls = extractCalls(file.content).slice(0, 24);
    return {
      path: file.path,
      kind: fileKind(file.path),
      symbols,
      imports,
      exports,
      routes,
      calls,
      summary: summarizeFile(file.path, symbols, routes, imports)
    };
  });
}

export function followAgenticRelationships(input: {
  openedFiles: AgenticOpenedFile[];
  allFiles: string[];
  readFile: (relativePath: string) => string | undefined;
  budget: AgenticReadBudget;
}): { relationships: AgenticRelationship[]; additionalFiles: AgenticOpenedFile[] } {
  const relationships: AgenticRelationship[] = [];
  const additionalFiles: AgenticOpenedFile[] = [];
  const opened = new Set(input.openedFiles.map((file) => file.path));
  const byNormalized = new Map(input.allFiles.map((file) => [normalize(file), file]));
  const startedAt = Date.now();
  for (const source of input.openedFiles) {
    if (Date.now() - startedAt > input.budget.timeoutMs) break;
    for (const specifier of extractImports(source.content)) {
      const resolved = resolveImport(source.path, specifier, byNormalized);
      relationships.push({
        fromPath: source.path,
        toPath: resolved,
        symbol: specifier,
        kind: "import",
        reason: resolved ? `Import resolves to ${resolved}.` : `Import specifier ${specifier} could not be resolved inside the workspace.`,
        depth: 1,
        confidence: resolved ? "high" : "low"
      });
      if (!resolved || opened.has(resolved) || additionalFiles.length >= input.budget.maxOpenedFiles) continue;
      const content = input.readFile(resolved);
      if (content === undefined) continue;
      additionalFiles.push({
        path: resolved,
        content: content.slice(0, input.budget.maxCharsPerFile),
        truncated: content.length > input.budget.maxCharsPerFile,
        charsRead: Math.min(content.length, input.budget.maxCharsPerFile),
        openedBecause: [`import_follow from ${source.path}`],
        readMode: "import_follow"
      });
      opened.add(resolved);
    }
    for (const route of extractRoutes(source.content)) {
      relationships.push({
        fromPath: source.path,
        symbol: route,
        kind: "route",
        reason: `Route or endpoint registration found for ${route}.`,
        depth: 0,
        confidence: "medium"
      });
    }
    for (const call of extractCalls(source.content).slice(0, 24)) {
      relationships.push({
        fromPath: source.path,
        symbol: call,
        kind: "call",
        reason: `Potential call/reference found for ${call}.`,
        depth: 0,
        confidence: "low"
      });
    }
  }
  return { relationships: dedupeRelationships(relationships), additionalFiles };
}

export function extractImports(content: string) {
  const imports: string[] = [];
  for (const match of content.matchAll(IMPORT_RE)) imports.push(match[1] ?? match[2] ?? match[3] ?? "");
  return uniqueStrings(imports).slice(0, 40);
}

function extractExports(content: string) {
  const exports: string[] = [];
  for (const match of content.matchAll(/^\s*export\s+(?:default\s+)?(?:class|function|const|let|var|type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    exports.push(match[1] ?? "");
  }
  return uniqueStrings(exports).slice(0, 30);
}

function extractSymbols(content: string) {
  const symbols: string[] = [];
  for (const match of content.matchAll(SYMBOL_RE)) symbols.push(match[1] ?? "");
  return uniqueStrings(symbols);
}

function extractRoutes(content: string) {
  const routes: string[] = [];
  for (const match of content.matchAll(ROUTE_RE)) routes.push(`${match[2]?.toUpperCase() ?? "ROUTE"} ${match[3] ?? ""}`);
  for (const match of content.matchAll(PY_ROUTE_RE)) routes.push(match[1] ?? "");
  return uniqueStrings(routes);
}

function extractCalls(content: string) {
  const ignore = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "String", "Number", "Boolean", "Array", "Object", "Promise"]);
  const calls: string[] = [];
  for (const match of content.matchAll(JS_CALL_RE)) {
    const call = match[1] ?? "";
    if (!ignore.has(call)) calls.push(call);
  }
  return uniqueStrings(calls);
}

function resolveImport(sourcePath: string, specifier: string, byNormalized: Map<string, string>) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
  const sourceDir = path.posix.dirname(sourcePath.replaceAll("\\", "/"));
  const base = normalize(path.posix.normalize(path.posix.join(sourceDir, specifier)));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`
  ];
  for (const candidate of candidates) {
    const resolved = byNormalized.get(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

function fileKind(filePath: string): AgenticFileSummary["kind"] {
  if (/(^|\/)(tests?|__tests__)\/|(\.|-)(test|spec)\./i.test(filePath)) return "test";
  if (/(^|\/)(fixtures?|mocks?)\//i.test(filePath)) return "fixture";
  if (/(^|\/)(tmp|dist|build|coverage|node_modules|\.agent_memory)\//i.test(filePath)) return "generated";
  if (/\.(json|toml|ya?ml)$/i.test(filePath) || /(^|\/)(package\.json|tsconfig\.json)$/i.test(filePath)) return "config";
  if (/\.(md|mdx|txt)$/i.test(filePath)) return "docs";
  if (/\.(ts|tsx|js|jsx|mjs|py|rs|go|java|cs|cpp|c)$/i.test(filePath)) return "production_source";
  return "unknown";
}

function summarizeFile(filePath: string, symbols: string[], routes: string[], imports: string[]) {
  const parts = [`${filePath}`];
  if (symbols.length) parts.push(`symbols=${symbols.slice(0, 6).join(", ")}`);
  if (routes.length) parts.push(`routes=${routes.slice(0, 4).join(", ")}`);
  if (imports.length) parts.push(`imports=${imports.slice(0, 4).join(", ")}`);
  return parts.join(" | ");
}

function dedupeRelationships(items: AgenticRelationship[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.fromPath}:${item.toPath ?? ""}:${item.symbol ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalize(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
