import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildCommandInventory } from "./CommandInventory.js";
import { buildProjectIntelligence } from "./ProjectIntelligence.js";
import { buildSemanticProjectModel } from "./SemanticProjectModel.js";
import {
  appendRunHistory,
  ensureMemoryLayout,
  saveMemory
} from "./ProjectMemory.js";
import {
  DEFAULT_MEMORY_DIR,
  MEMORY_SCHEMA_VERSION,
  type FileManifestEntry,
  type FileRole,
  type FileSummaryRecord,
  type FileSymbolIndex,
  type RepoIndex,
  type RepoMemorySnapshot,
  type SkippedFileRecord,
  type SymbolIndex,
  type SymbolKind,
  type SymbolRecord
} from "./types.js";

export type RebuildRepoIndexOptions = {
  memoryDir?: string;
  maxFileBytes?: number;
  now?: () => Date;
};

type CollectedFile = FileManifestEntry & {
  text?: string;
};

type CollectionResult = {
  files: CollectedFile[];
  skippedFiles: SkippedFileRecord[];
  ignoredDirectories: string[];
};

const DEFAULT_MAX_FILE_BYTES = 1_000_000;

const IGNORED_DIRECTORIES = new Set([
  ".agent_memory",
  ".cache",
  ".coverage",
  ".eggs",
  ".git",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".hivo-agent-runtime",
  ".orchcode-agent-runtime",
  ".playwright-cli",
  ".playwright-mcp",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".tmp-run",
  ".tox",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "ENV",
  "build",
  "coverage",
  "dist",
  "env",
  "gen",
  "generated",
  "htmlcov",
  "node_modules",
  "out",
  "output",
  "outputs",
  "playwright-report",
  "screenshots",
  "site-packages",
  "target",
  "test-results",
  "tmp",
  "vendor",
  "venv"
]);

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".mjs",
  ".md",
  ".ps1",
  ".py",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const TEXT_BASENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  "Cargo.lock",
  "Gemfile",
  "Makefile",
  "justfile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "requirements.txt",
  "yarn.lock"
]);

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".dll",
  ".exe",
  ".gif",
  ".gz",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".sqlite",
  ".tar",
  ".webp",
  ".zip"
]);

const SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".mjs", ".py", ".rs", ".swift", ".ts", ".tsx"]);

const CONFIG_BASENAMES = new Set([
  ".eslintrc",
  ".gitignore",
  ".prettierrc",
  "Cargo.toml",
  "components.json",
  "composer.json",
  "go.mod",
  "gradle.properties",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "settings.gradle",
  "tauri.conf.json",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.ts"
]);

const DEPENDENCY_BASENAMES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock"
]);

const BUILD_BASENAMES = new Set([
  "Cargo.toml",
  "Makefile",
  "build.gradle",
  "build.rs",
  "docker-compose.yml",
  "Dockerfile",
  "gradlew",
  "justfile",
  "package.json",
  "pom.xml",
  "vite.config.js",
  "vite.config.ts"
]);

export async function rebuildRepoIndex(workspacePath: string, options: RebuildRepoIndexOptions = {}): Promise<RepoMemorySnapshot> {
  const workspaceRoot = path.resolve(workspacePath);
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  await ensureMemoryLayout(
    workspaceRoot,
    options.memoryDir ?? process.env.HIVO_MEMORY_DIR ?? process.env.ORCHCODE_MEMORY_DIR ?? DEFAULT_MEMORY_DIR
  );
  const collection = await collectFiles(workspaceRoot, {
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  });
  const fileText = new Map(collection.files.flatMap((file) => file.text === undefined ? [] : [[file.path, file.text] as const]));
  const fileManifest = collection.files.map(stripText).sort((left, right) => left.path.localeCompare(right.path));
  const symbolIndex = buildSymbolIndex(fileManifest, fileText, generatedAt);
  const commandInventory = buildCommandInventory({ generatedAt, files: fileManifest, fileText });
  const fileSummaries = buildFileSummaries(fileManifest, symbolIndex.files);
  const repoIndex = buildRepoIndexDocument({
    generatedAt,
    workspaceRoot,
    files: fileManifest,
    fileText,
    skippedFiles: collection.skippedFiles,
    ignoredDirectories: collection.ignoredDirectories
  });
  const projectIntelligence = buildProjectIntelligence({
    generatedAt,
    repoIndex,
    fileManifest,
    symbolIndex,
    commandInventory
  });
  const semanticProjectModel = buildSemanticProjectModel({
    generatedAt,
    manifestHash: manifestHash(fileManifest),
    manifest: fileManifest,
    summaries: fileSummaries,
    symbols: symbolIndex,
    fileText
  });

  await saveMemory(workspaceRoot, {
    repoIndex,
    fileManifest,
    symbolIndex,
    fileSummaries,
    commandInventory,
    projectIntelligence,
    semanticProjectModel,
    indexState: {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    indexVersion: MEMORY_SCHEMA_VERSION,
    generatedAt,
    commandInventoryVersion: MEMORY_SCHEMA_VERSION,
    fileCount: fileManifest.length,
    hash: manifestHash(fileManifest),
    projectIntelligenceRef: "project_intelligence.json"
    }
  }, options.memoryDir);
  await appendRunHistory(workspaceRoot, {
    task: "rebuild_repo_index",
    status: "completed",
    summary: `Indexed ${fileManifest.length} file(s), ${symbolIndex.symbols.length} symbol hint(s), ${semanticProjectModel.relationships.length} semantic relationship(s), and ${commandInventory.commands.length} command(s).`,
    relatedFiles: ["repo_index.json", "file_manifest.json", "symbol_index.json", "command_inventory.json"],
    commands: ["memory index repo"]
  }, options.memoryDir);

  return {
    repoIndex,
    fileManifest,
    symbolIndex,
    fileSummaries,
    commandInventory,
    projectIntelligence,
    semanticProjectModel
  };
}

async function collectFiles(workspaceRoot: string, options: { maxFileBytes: number }): Promise<CollectionResult> {
  const files: CollectedFile[] = [];
  const skippedFiles: SkippedFileRecord[] = [];
  const ignoredDirectories = new Set<string>();

  async function walk(currentDir: string, relativeDir: string) {
    const entries = (await readdir(currentDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = normalizePath(path.join(relativeDir, entry.name));
      const fullPath = path.join(workspaceRoot, relativePath);
      if (entry.isDirectory()) {
        if (shouldIgnoreDirectory(entry.name, relativePath)) {
          ignoredDirectories.add(relativePath);
          continue;
        }
        await walk(fullPath, relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        skippedFiles.push({ path: relativePath, reason: "symlink" });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretCandidate(relativePath)) {
        skippedFiles.push({ path: relativePath, reason: "secret_candidate" });
        continue;
      }
      if (!isTextLike(relativePath)) {
        const sizeBytes = await safeSize(fullPath);
        skippedFiles.push({ path: relativePath, reason: BINARY_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) ? "binary" : "unreadable", sizeBytes });
        continue;
      }
      const info = await lstat(fullPath);
      if (info.size > options.maxFileBytes) {
        skippedFiles.push({ path: relativePath, reason: "large_file", sizeBytes: info.size });
        continue;
      }
      try {
        const text = await readFile(fullPath, "utf8");
        files.push({
          path: relativePath,
          extension: path.extname(relativePath).toLowerCase(),
          basename: path.basename(relativePath),
          dirname: normalizePath(path.dirname(relativePath)),
          sizeBytes: info.size,
          mtimeMs: Math.round(info.mtimeMs),
          hashSha256: createHash("sha256").update(text).digest("hex"),
          language: languageForPath(relativePath),
          isText: true,
          roles: rolesForPath(relativePath),
          text
        });
      } catch {
        skippedFiles.push({ path: relativePath, reason: "unreadable", sizeBytes: info.size });
      }
    }
  }

  await walk(workspaceRoot, "");
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
    skippedFiles: skippedFiles.sort((left, right) => left.path.localeCompare(right.path)),
    ignoredDirectories: [...ignoredDirectories].sort()
  };
}

function buildRepoIndexDocument(input: {
  generatedAt: string;
  workspaceRoot: string;
  files: FileManifestEntry[];
  fileText: Map<string, string>;
  skippedFiles: SkippedFileRecord[];
  ignoredDirectories: string[];
}): RepoIndex {
  const languages = countBy(input.files.flatMap((file) => file.language ? [file.language] : []));
  const extensions = countBy(input.files.map((file) => file.extension || "[none]"));
  const sourceFiles = filesWithRole(input.files, "source");
  const testFiles = filesWithRole(input.files, "test");
  const configFiles = filesWithRole(input.files, "config");
  const docFiles = filesWithRole(input.files, "doc");
  const packageFiles = filesWithRole(input.files, "package");
  const dependencyFiles = filesWithRole(input.files, "dependency");
  const buildFiles = filesWithRole(input.files, "build");
  const entrypoints = inferEntryPoints(input.files);
  const importantFiles = uniqueStrings([
    ...packageFiles,
    ...buildFiles,
    ...configFiles.filter((file) => /tsconfig|vite|tauri|Cargo\.toml|package\.json|pyproject|go\.mod/i.test(file)),
    ...docFiles.filter((file) => /README|architecture|docs\//i.test(file)),
    ...entrypoints,
    ...testFiles.slice(0, 20)
  ]).slice(0, 100);

  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    workspaceRoot: input.workspaceRoot,
    projectName: inferProjectName(input.workspaceRoot, input.fileText),
    totals: {
      indexedFiles: input.files.length,
      sourceFiles: sourceFiles.length,
      testFiles: testFiles.length,
      configFiles: configFiles.length,
      docFiles: docFiles.length,
      skippedFiles: input.skippedFiles.length,
      indexedBytes: input.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    },
    languages,
    extensions,
    topLevelDirectories: topLevelDirectoryCounts(input.files),
    ignoredDirectories: input.ignoredDirectories,
    skippedFiles: input.skippedFiles,
    sourceFiles,
    testFiles,
    configFiles,
    docFiles,
    importantFiles,
    entrypoints,
    packageFiles,
    dependencyFiles,
    buildFiles
  };
}

function buildSymbolIndex(files: FileManifestEntry[], fileText: Map<string, string>, generatedAt: string): SymbolIndex {
  const indexedFiles = files
    .filter((file) => file.roles.includes("source") || file.roles.includes("config") || file.roles.includes("package"))
    .map((file) => extractFileSymbols(file, fileText.get(file.path) ?? ""));
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    generatedAt,
    files: indexedFiles,
    symbols: indexedFiles.flatMap((file) => file.symbols).sort(symbolCompare)
  };
}

function extractFileSymbols(file: FileManifestEntry, text: string): FileSymbolIndex {
  const language = file.language;
  if (!text) return { path: file.path, language, imports: [], exports: [], symbols: [] };
  const lines = text.split(/\r?\n/);
  const imports = uniqueStrings(extractImports(file.path, text));
  const exportNames = new Set<string>(extractExports(file.path, text));
  const symbols: SymbolRecord[] = [];

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    const lineNumber = index + 1;
    for (const match of matchSymbols(file.path, line)) {
      const exported = exportNames.has(match.name) || /\bexport\b|\bpub\b/.test(line);
      symbols.push({
        name: match.name,
        kind: match.kind,
        path: file.path,
        line: lineNumber,
        exported
      });
      if (exported) exportNames.add(match.name);
    }
  });

  return {
    path: file.path,
    language,
    imports,
    exports: [...exportNames].sort(),
    symbols: dedupeSymbols(symbols).sort(symbolCompare)
  };
}

function matchSymbols(filePath: string, line: string): Array<{ name: string; kind: SymbolKind }> {
  const ext = path.extname(filePath).toLowerCase();
  const matches: Array<{ name: string; kind: SymbolKind }> = [];
  const add = (regex: RegExp, kind: SymbolKind, group = 1) => {
    const match = line.match(regex);
    if (match?.[group]) matches.push({ name: match[group], kind });
  };

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    add(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, "function");
    add(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/, "class");
    add(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/, "interface");
    add(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/, "type");
    add(/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/, "enum");
    add(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*\)?\s*=>/, "function");
    add(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, "constant");
  } else if (ext === ".rs") {
    add(/^(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/, "function");
    add(/^(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/, "struct");
    add(/^(?:pub\s+)?enum\s+([A-Za-z_][\w]*)\b/, "enum");
    add(/^(?:pub\s+)?trait\s+([A-Za-z_][\w]*)\b/, "trait");
    add(/^(?:pub\s+)?mod\s+([A-Za-z_][\w]*)\b/, "module");
  } else if (ext === ".py") {
    add(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/, "function");
    add(/^class\s+([A-Za-z_][\w]*)\b/, "class");
  } else if (ext === ".go") {
    add(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/, "function");
    add(/^type\s+([A-Za-z_][\w]*)\s+struct\b/, "struct");
    add(/^type\s+([A-Za-z_][\w]*)\s+interface\b/, "interface");
  } else if ([".java", ".cs"].includes(ext)) {
    add(/^(?:public|private|protected|internal|static|\s)*class\s+([A-Za-z_][\w]*)\b/, "class");
    add(/^(?:public|private|protected|internal|static|\s)*interface\s+([A-Za-z_][\w]*)\b/, "interface");
    add(/^(?:public|private|protected|internal|static|\s)*enum\s+([A-Za-z_][\w]*)\b/, "enum");
  }

  return matches;
}

function extractImports(filePath: string, text: string) {
  const ext = path.extname(filePath).toLowerCase();
  const imports: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    for (const match of text.matchAll(/\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g)) {
      imports.push((match[1] ?? match[2] ?? "").trim());
    }
  } else if (ext === ".rs") {
    for (const match of text.matchAll(/^\s*use\s+([^;]+);/gm)) imports.push(match[1]?.trim() ?? "");
    for (const match of text.matchAll(/^\s*(?:pub\s+)?mod\s+([A-Za-z_][\w]*);/gm)) imports.push(match[1]?.trim() ?? "");
  } else if (ext === ".py") {
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z0-9_.,\s]+)|^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm)) {
      imports.push((match[1] ?? match[2] ?? "").trim());
    }
  } else if (ext === ".go") {
    for (const match of text.matchAll(/^\s*import\s+(?:"([^"]+)"|\(([\s\S]*?)\))/gm)) {
      if (match[1]) imports.push(match[1]);
      if (match[2]) {
        imports.push(...match[2].split(/\r?\n/).map((line) => line.match(/"([^"]+)"/)?.[1] ?? "").filter(Boolean));
      }
    }
  }
  return imports.filter(Boolean).sort();
}

function extractExports(filePath: string, text: string) {
  const ext = path.extname(filePath).toLowerCase();
  const exports: string[] = [];
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      if (match[1]) exports.push(match[1]);
    }
    for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
      exports.push(...(match[1] ?? "").split(",").map((part) => part.trim().split(/\s+as\s+/i)[1] ?? part.trim().split(/\s+as\s+/i)[0]).filter(Boolean));
    }
  } else if (ext === ".rs") {
    for (const match of text.matchAll(/^\s*pub\s+(?:fn|struct|enum|trait|mod)\s+([A-Za-z_][\w]*)/gm)) {
      if (match[1]) exports.push(match[1]);
    }
  } else if (ext === ".go") {
    for (const match of text.matchAll(/^(?:func|type|var|const)\s+([A-Z][A-Za-z0-9_]*)/gm)) {
      if (match[1]) exports.push(match[1]);
    }
  }
  return uniqueStrings(exports).sort();
}

function buildFileSummaries(files: FileManifestEntry[], symbolFiles: FileSymbolIndex[]): FileSummaryRecord[] {
  const symbolsByPath = new Map(symbolFiles.map((file) => [file.path, file]));
  const testFiles = files.filter((file) => file.roles.includes("test")).map((file) => file.path);
  return files.map((file) => {
    const symbolFile = symbolsByPath.get(file.path) ?? { path: file.path, imports: [], exports: [], symbols: [] };
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      path: file.path,
      roleGuess: roleGuess(file),
      language: file.language,
      roles: file.roles,
      exports: symbolFile.exports,
      imports: symbolFile.imports,
      symbols: symbolFile.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        line: symbol.line,
        exported: symbol.exported
      })),
      relatedTests: relatedTestsFor(file.path, testFiles),
      purposeGuess: purposeGuess(file, symbolFile)
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function roleGuess(file: FileManifestEntry) {
  if (file.roles.includes("entrypoint")) return "Likely entrypoint or application bootstrap file.";
  if (file.roles.includes("test")) return "Automated test or smoke coverage.";
  if (file.roles.includes("package")) return "Package manifest or dependency metadata.";
  if (file.roles.includes("config")) return "Project configuration.";
  if (file.roles.includes("doc")) return "Project documentation.";
  if (file.roles.includes("source")) return `${file.language ?? "Source"} implementation file.`;
  return "Repository support file.";
}

function purposeGuess(file: FileManifestEntry, symbolFile: Pick<FileSymbolIndex, "imports" | "exports" | "symbols">) {
  const highSignal = [
    symbolFile.exports.length ? `exports ${symbolFile.exports.slice(0, 6).join(", ")}` : "",
    symbolFile.symbols.length ? `defines ${symbolFile.symbols.slice(0, 6).map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ")}` : "",
    symbolFile.imports.length ? `imports ${symbolFile.imports.slice(0, 5).join(", ")}` : ""
  ].filter(Boolean);
  if (highSignal.length) return highSignal.join("; ");
  if (file.roles.includes("doc")) return "Documentation file used for project guidance or architecture context.";
  if (file.roles.includes("config")) return "Configuration file that affects build, tooling, runtime, or package behavior.";
  return "No specific symbols detected by Phase 1 heuristics.";
}

function rolesForPath(filePath: string): FileRole[] {
  const roles: FileRole[] = [];
  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(ext)) roles.push("source");
  if (isTestFile(filePath)) roles.push("test");
  if (isConfigFile(filePath)) roles.push("config");
  if (isDocFile(filePath)) roles.push("doc");
  if (isEntryPoint(filePath)) roles.push("entrypoint");
  if (basename === "package.json" || basename === "Cargo.toml" || basename === "pyproject.toml" || basename === "go.mod" || basename === "pom.xml" || basename === "composer.json" || basename === "Gemfile") roles.push("package");
  if (DEPENDENCY_BASENAMES.has(basename)) roles.push("dependency");
  if (BUILD_BASENAMES.has(basename)) roles.push("build");
  if (filePath.split("/").some((part) => part === "gen" || part === "generated")) roles.push("generated");
  if (!roles.length) roles.push("other");
  return uniqueRoles(roles);
}

function languageForPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  const map: Record<string, string> = {
    ".c": "C",
    ".cc": "C++",
    ".cpp": "C++",
    ".cs": "C#",
    ".css": "CSS",
    ".go": "Go",
    ".html": "HTML",
    ".java": "Java",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".kt": "Kotlin",
    ".md": "Markdown",
    ".mjs": "JavaScript",
    ".ps1": "PowerShell",
    ".py": "Python",
    ".rs": "Rust",
    ".scss": "CSS",
    ".sh": "Shell",
    ".sql": "SQL",
    ".swift": "Swift",
    ".toml": "TOML",
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".xml": "XML",
    ".yaml": "YAML",
    ".yml": "YAML"
  };
  if (basename === "Dockerfile" || basename === "Makefile" || basename === "justfile") return basename;
  if (basename === "package-lock.json" || basename === "package.json" || basename === "tsconfig.json") return "JSON";
  return map[ext];
}

function isTextLike(filePath: string) {
  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (/\.log$/i.test(filePath)) return false;
  if (TEXT_BASENAMES.has(basename)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return TEXT_EXTENSIONS.has(ext);
}

function isConfigFile(filePath: string) {
  const basename = path.basename(filePath);
  return CONFIG_BASENAMES.has(basename)
    || /^\.github\/workflows\/.+\.ya?ml$/i.test(filePath)
    || /(^|\/)(eslint|prettier|babel|vite|webpack|rollup|tsconfig|jest|vitest|playwright|tailwind|postcss|docker|compose)\b/i.test(filePath);
}

function isDocFile(filePath: string) {
  return /\.md$/i.test(filePath) || /(^|\/)(README|CHANGELOG|CONTRIBUTING|ARCHITECTURE|docs\/)/i.test(filePath);
}

function isTestFile(filePath: string) {
  return /(^|\/)(test|tests|__tests__)\b|(\.test\.|\.(spec)\.)/i.test(filePath);
}

function isEntryPoint(filePath: string) {
  return /(^|\/)(index|main|app|server|cli|lib)\.(ts|tsx|js|jsx|mjs|rs|py|go|html)$/i.test(filePath)
    || /(^|\/)src-tauri\/src\/main\.rs$/i.test(filePath)
    || /(^|\/)src-tauri\/src\/lib\.rs$/i.test(filePath);
}

function inferEntryPoints(files: FileManifestEntry[]) {
  return uniqueStrings(files.filter((file) => file.roles.includes("entrypoint")).map((file) => file.path)).slice(0, 50);
}

function inferProjectName(workspaceRoot: string, fileText: Map<string, string>) {
  const packageJson = fileText.get("package.json");
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // Fall through to directory name.
    }
  }
  return path.basename(workspaceRoot);
}

function shouldIgnoreDirectory(name: string, relativePath: string) {
  return IGNORED_DIRECTORIES.has(name) || relativePath.split("/").some((part) => IGNORED_DIRECTORIES.has(part));
}

function isSecretCandidate(filePath: string) {
  const basename = path.basename(filePath).toLowerCase();
  return basename === ".env"
    || basename.endsWith(".pem")
    || basename === "id_rsa"
    || basename === "id_ed25519"
    || basename === "credentials.json";
}

function relatedTestsFor(filePath: string, testFiles: string[]) {
  if (isTestFile(filePath)) return [];
  const stem = path.basename(filePath).replace(/\.[^.]+$/, "").toLowerCase();
  return testFiles
    .filter((testPath) => {
      const testStem = path.basename(testPath).replace(/\.(test|spec)\./, ".").replace(/\.[^.]+$/, "").toLowerCase();
      return testStem === stem || testPath.toLowerCase().includes(stem);
    })
    .slice(0, 12);
}

function filesWithRole(files: FileManifestEntry[], role: FileRole) {
  return files.filter((file) => file.roles.includes(role)).map((file) => file.path);
}

function topLevelDirectoryCounts(files: FileManifestEntry[]) {
  const counts = new Map<string, number>();
  for (const file of files) {
    const root = file.path.includes("/") ? file.path.split("/")[0] ?? "." : ".";
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([dirPath, fileCount]) => ({ path: dirPath, files: fileCount }));
}

function countBy(values: string[]) {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function stripText(file: CollectedFile): FileManifestEntry {
  return {
    path: file.path,
    extension: file.extension,
    basename: file.basename,
    dirname: file.dirname,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    hashSha256: file.hashSha256,
    language: file.language,
    isText: file.isText,
    roles: file.roles
  };
}

function manifestHash(manifest: FileManifestEntry[]) {
  const stable = manifest
    .map((entry) => `${entry.path}:${entry.sizeBytes}:${entry.hashSha256 ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(stable).digest("hex");
}

function uniqueRoles(roles: FileRole[]) {
  return [...new Set(roles)];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeSymbols(symbols: SymbolRecord[]) {
  const seen = new Set<string>();
  return symbols.filter((symbol) => {
    const key = `${symbol.path}:${symbol.line}:${symbol.kind}:${symbol.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function symbolCompare(left: SymbolRecord, right: SymbolRecord) {
  return left.path.localeCompare(right.path) || left.line - right.line || left.name.localeCompare(right.name);
}

function normalizePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.$/, "");
  return normalized || ".";
}

async function safeSize(filePath: string) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}
