import path from "node:path";
import { MEMORY_SCHEMA_VERSION, type CommandInventory, type FileManifestEntry, type ProjectIntelligence, type RepoIndex, type SymbolIndex } from "./types.js";

export type ProjectIntelligenceInput = {
  generatedAt: string;
  repoIndex: RepoIndex;
  fileManifest: FileManifestEntry[];
  symbolIndex: SymbolIndex;
  commandInventory: CommandInventory;
};

export function buildProjectIntelligence(input: ProjectIntelligenceInput): ProjectIntelligence {
  const fileSet = new Set(input.fileManifest.map((file) => file.path));
  const sourceFiles = input.fileManifest.filter((file) => file.roles.includes("source"));
  const testFiles = input.fileManifest.filter((file) => file.roles.includes("test"));
  const dependencyGraph: Record<string, string[]> = {};
  const reverseDependencyGraph: Record<string, string[]> = {};

  for (const file of input.symbolIndex.files) {
    const resolved = file.imports
      .map((specifier) => resolveImport(file.path, specifier, fileSet))
      .filter((value): value is string => Boolean(value))
      .sort();
    if (resolved.length) dependencyGraph[file.path] = uniqueStrings(resolved);
    for (const target of resolved) {
      reverseDependencyGraph[target] = uniqueStrings([...(reverseDependencyGraph[target] ?? []), file.path]).sort();
    }
  }

  const testToSourceMap: Record<string, string[]> = {};
  for (const testFile of testFiles) {
    const stem = stripTestSuffix(path.basename(testFile.path));
    const related = sourceFiles
      .filter((source) => stripExtension(path.basename(source.path)).toLowerCase() === stem || source.path.toLowerCase().includes(stem))
      .map((source) => source.path)
      .slice(0, 12);
    testToSourceMap[testFile.path] = related;
  }

  const moduleMap = groupByTopLevel(input.fileManifest.map((file) => file.path));
  const riskMap = Object.fromEntries(input.fileManifest.map((file) => [file.path, riskForFile(file.path, file.roles)]));
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    dependencyGraph: sortRecordArrays(dependencyGraph),
    reverseDependencyGraph: sortRecordArrays(reverseDependencyGraph),
    testToSourceMap: sortRecordArrays(testToSourceMap),
    commandToAreaMap: buildCommandAreaMap(input.commandInventory),
    ownershipHints: Object.fromEntries(Object.entries(moduleMap).map(([area, files]) => [area, ownershipHintsForArea(area, files)])),
    moduleMap,
    entrypointMap: groupByTopLevel(input.repoIndex.entrypoints),
    riskMap,
    generatedFiles: input.fileManifest.filter((file) => file.roles.includes("generated")).map((file) => file.path),
    largeFileWarnings: input.fileManifest
      .filter((file) => file.sizeBytes > 250_000)
      .map((file) => ({ path: file.path, sizeBytes: file.sizeBytes }))
      .sort((left, right) => right.sizeBytes - left.sizeBytes)
  };
}

export function explainIndexedFile(filePath: string, intelligence: ProjectIntelligence) {
  const normalized = filePath.replaceAll("\\", "/");
  return {
    path: normalized,
    dependencies: intelligence.dependencyGraph[normalized] ?? [],
    dependents: intelligence.reverseDependencyGraph[normalized] ?? [],
    relatedTests: Object.entries(intelligence.testToSourceMap)
      .filter(([, sources]) => sources.includes(normalized))
      .map(([testPath]) => testPath),
    risk: intelligence.riskMap[normalized] ?? { risk: "low" as const, reasons: [] },
    module: Object.entries(intelligence.moduleMap).find(([, files]) => files.includes(normalized))?.[0],
    commands: Object.entries(intelligence.commandToAreaMap)
      .filter(([, areas]) => areas.some((area) => normalized === area || normalized.startsWith(`${area}/`)))
      .map(([command]) => command)
  };
}

function resolveImport(fromPath: string, specifier: string, fileSet: Set<string>) {
  if (!specifier.startsWith(".")) return undefined;
  const fromDir = path.posix.dirname(fromPath.replaceAll("\\", "/"));
  const base = path.posix.normalize(path.posix.join(fromDir, specifier)).replaceAll("\\", "/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.rs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`
  ];
  return candidates.find((candidate) => fileSet.has(candidate));
}

function buildCommandAreaMap(inventory: CommandInventory) {
  const map: Record<string, string[]> = {};
  for (const command of inventory.commands) {
    const area = command.cwd === "." ? "." : command.cwd.replaceAll("\\", "/");
    map[command.command] = uniqueStrings([...(map[command.command] ?? []), area]).sort();
  }
  return map;
}

function groupByTopLevel(files: string[]) {
  const groups: Record<string, string[]> = {};
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const area = normalized.includes("/") ? normalized.split("/")[0] ?? "." : ".";
    groups[area] = [...(groups[area] ?? []), normalized].sort();
  }
  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)));
}

function ownershipHintsForArea(area: string, files: string[]) {
  const hints = new Set<string>();
  if (area === "apps") hints.add("application workspace");
  if (area === "packages") hints.add("shared package workspace");
  if (files.some((file) => /test|spec/i.test(file))) hints.add("has local tests");
  if (files.some((file) => /docs?\//i.test(file))) hints.add("documentation owned area");
  return [...hints].sort();
}

function riskForFile(filePath: string, roles: string[]) {
  const reasons: string[] = [];
  if (/\.github\/|ci|deploy|docker|tauri\.conf|Cargo\.toml|package\.json|package-lock\.json|tsconfig/i.test(filePath)) reasons.push("tooling, build, deployment, or package configuration");
  if (/auth|security|secret|payment|billing|credential|token/i.test(filePath)) reasons.push("security-sensitive naming");
  if (/migration|schema|database|sql/i.test(filePath)) reasons.push("database or schema-sensitive naming");
  if (roles.includes("dependency") || roles.includes("build")) reasons.push("build/dependency role");
  if (roles.includes("generated")) reasons.push("generated file");
  return {
    risk: reasons.length >= 2 ? "high" as const : reasons.length === 1 ? "medium" as const : "low" as const,
    reasons
  };
}

function stripExtension(value: string) {
  return value.replace(/\.[^.]+$/, "");
}

function stripTestSuffix(value: string) {
  return stripExtension(value)
    .replace(/\.(test|spec)$/i, "")
    .toLowerCase();
}

function sortRecordArrays(record: Record<string, string[]>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, uniqueStrings(values).sort()]));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
