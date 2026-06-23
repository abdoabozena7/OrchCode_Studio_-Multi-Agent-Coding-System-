export const MEMORY_SCHEMA_VERSION = 2;
export const DEFAULT_MEMORY_DIR = ".agent_memory";

export type MemoryPaths = {
  rootDir: string;
  readme: string;
  schemaVersion: string;
  repoIndex: string;
  fileManifest: string;
  symbolIndex: string;
  fileSummaries: string;
  commandInventory: string;
  decisions: string;
  taskHistory: string;
  lessonsLearned: string;
  failedAttempts: string;
  successfulPatterns: string;
  projectGlossary: string;
  architectureNotes: string;
  indexState: string;
  projectIntelligence: string;
  swarmStaffingLessons: string;
  swarmTuningHistory: string;
  swarmFailurePatterns: string;
  swarmSuccessPatterns: string;
  swarmSpecialistSelectionHistory: string;
  database: string;
  backupsDir: string;
  runsDir: string;
  projectSpecsDir: string;
  campaignsDir: string;
  evalsDir: string;
};

export type FileRole =
  | "source"
  | "test"
  | "config"
  | "doc"
  | "entrypoint"
  | "package"
  | "dependency"
  | "build"
  | "generated"
  | "other";

export type FileManifestEntry = {
  path: string;
  extension: string;
  basename: string;
  dirname: string;
  sizeBytes: number;
  mtimeMs: number;
  hashSha256?: string;
  language?: string;
  isText: boolean;
  roles: FileRole[];
};

export type SkippedFileRecord = {
  path: string;
  reason: "ignored_directory" | "binary" | "large_file" | "secret_candidate" | "symlink" | "unreadable";
  sizeBytes?: number;
};

export type RepoIndex = {
  schemaVersion: number;
  generatedAt: string;
  workspaceRoot: string;
  projectName: string;
  totals: {
    indexedFiles: number;
    sourceFiles: number;
    testFiles: number;
    configFiles: number;
    docFiles: number;
    skippedFiles: number;
    indexedBytes: number;
  };
  languages: Record<string, number>;
  extensions: Record<string, number>;
  topLevelDirectories: Array<{ path: string; files: number }>;
  ignoredDirectories: string[];
  skippedFiles: SkippedFileRecord[];
  sourceFiles: string[];
  testFiles: string[];
  configFiles: string[];
  docFiles: string[];
  importantFiles: string[];
  entrypoints: string[];
  packageFiles: string[];
  dependencyFiles: string[];
  buildFiles: string[];
};

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "module"
  | "constant"
  | "method"
  | "struct"
  | "trait";

export type SymbolRecord = {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  exported?: boolean;
};

export type FileSymbolIndex = {
  path: string;
  language?: string;
  imports: string[];
  exports: string[];
  symbols: SymbolRecord[];
};

export type SymbolIndex = {
  schemaVersion: number;
  generatedAt: string;
  files: FileSymbolIndex[];
  symbols: SymbolRecord[];
};

export type CommandKind = "test" | "lint" | "typecheck" | "build" | "format" | "smoke" | "dev" | "run" | "unknown";

export type CommandInventoryEntry = {
  id: string;
  kind: CommandKind;
  command: string;
  cwd: string;
  sourceFile: string;
  source: "package_json" | "cargo" | "go" | "python" | "make" | "just" | "ci" | "composer" | "gem" | "gradle" | "maven";
  packageManager?: string;
  scriptName?: string;
  confidence: "high" | "medium" | "low";
  notes?: string[];
};

export type CommandInventory = {
  schemaVersion: number;
  generatedAt: string;
  packageManagers: string[];
  commands: CommandInventoryEntry[];
  byKind: Record<CommandKind, string[]>;
};

export type FileSummaryRecord = {
  schemaVersion: number;
  path: string;
  roleGuess: string;
  language?: string;
  roles: FileRole[];
  exports: string[];
  imports: string[];
  symbols: Array<{ name: string; kind: SymbolKind; line: number; exported?: boolean }>;
  relatedTests: string[];
  purposeGuess: string;
};

export type DecisionRecord = {
  id: string;
  createdAt: string;
  agent?: string;
  summary: string;
  rationale?: string;
  relatedFiles?: string[];
  tags?: string[];
};

export type TaskHistoryRecord = {
  id: string;
  createdAt: string;
  task: string;
  status: "started" | "completed" | "failed" | "blocked" | "noted";
  summary?: string;
  relatedFiles?: string[];
  commands?: string[];
};

export type RepoMemorySnapshot = {
  repoIndex: RepoIndex;
  fileManifest: FileManifestEntry[];
  symbolIndex: SymbolIndex;
  fileSummaries: FileSummaryRecord[];
  commandInventory: CommandInventory;
  projectIntelligence?: ProjectIntelligence;
  semanticProjectModel?: SemanticProjectModel;
};

export type SemanticProjectNodeKind = "file" | "symbol" | "route" | "concept" | "data_field";

export type SemanticProjectNode = {
  id: string;
  kind: SemanticProjectNodeKind;
  name: string;
  path?: string;
  line?: number;
  summary: string;
  contentHash: string;
  evidenceRefs: string[];
  freshness: "current" | "stale";
};

export type SemanticProjectRelationshipKind =
  | "contains"
  | "import"
  | "export"
  | "call"
  | "route"
  | "ui_to_api"
  | "storage"
  | "produces"
  | "consumes"
  | "test_to_source"
  | "concept_alias";

export type SemanticProjectRelationship = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: SemanticProjectRelationshipKind;
  confidence: "high" | "medium" | "low";
  reason: string;
  evidenceRefs: string[];
  contentHash: string;
  freshness: "current" | "stale";
};

export type SemanticEmbeddingRecord = {
  nodeId: string;
  model: string;
  dimensions: number;
  vector: number[];
  contentHash: string;
  updatedAt: string;
};

export type SemanticProjectModel = {
  schemaVersion: number;
  generatedAt: string;
  manifestHash: string;
  nodes: SemanticProjectNode[];
  relationships: SemanticProjectRelationship[];
};

export type MemoryStatus = {
  schemaVersion: number;
  memoryRoot: string;
  hasRepoIndex: boolean;
  hasFileManifest: boolean;
  hasSymbolIndex: boolean;
  hasFileSummaries: boolean;
  hasCommandInventory: boolean;
  hasDecisions: boolean;
  hasTaskHistory: boolean;
  hasLessonsLearned: boolean;
  hasFailedAttempts: boolean;
  hasSuccessfulPatterns: boolean;
  hasProjectGlossary: boolean;
  hasArchitectureNotes: boolean;
  hasIndexState: boolean;
  hasProjectIntelligence: boolean;
  databasePath?: string;
  storageMode?: string;
  runArtifacts: number;
  campaignArtifacts: number;
  evalArtifacts: number;
};

export type LessonLearnedRecord = {
  id: string;
  createdAt: string;
  summary: string;
  evidence?: string[];
  relatedRunIds?: string[];
  tags?: string[];
};

export type FailedAttemptRecord = {
  id: string;
  createdAt: string;
  summary: string;
  fingerprint?: string;
  relatedRunId?: string;
  relatedTaskId?: string;
  evidence?: string[];
  nextAvoidance?: string;
};

export type SuccessfulPatternRecord = {
  id: string;
  createdAt: string;
  summary: string;
  relatedRunIds?: string[];
  relatedFiles?: string[];
  tags?: string[];
};

export type ArchitectureNoteRecord = {
  id: string;
  createdAt: string;
  title: string;
  note: string;
  relatedFiles?: string[];
  tags?: string[];
};

export type ProjectGlossary = {
  schemaVersion: number;
  updatedAt: string;
  terms: Array<{
    term: string;
    meaning: string;
    evidence?: string[];
  }>;
};

export type IndexFreshnessReport = {
  schemaVersion: number;
  status: "fresh" | "stale" | "missing";
  generatedAt?: string;
  checkedAt: string;
  indexVersion?: number;
  commandInventoryVersion?: number;
  indexedFiles: number;
  changedFiles: string[];
  newFiles: string[];
  deletedFiles: string[];
  warnings: string[];
};

export type IndexState = {
  schemaVersion: number;
  indexVersion: number;
  generatedAt: string;
  commandInventoryVersion: number;
  fileCount: number;
  hash: string;
  projectIntelligenceRef?: string;
};

export type ProjectIntelligence = {
  schemaVersion: number;
  generatedAt: string;
  dependencyGraph: Record<string, string[]>;
  reverseDependencyGraph: Record<string, string[]>;
  testToSourceMap: Record<string, string[]>;
  commandToAreaMap: Record<string, string[]>;
  ownershipHints: Record<string, string[]>;
  moduleMap: Record<string, string[]>;
  entrypointMap: Record<string, string[]>;
  riskMap: Record<string, {
    risk: "low" | "medium" | "high";
    reasons: string[];
  }>;
  generatedFiles: string[];
  largeFileWarnings: Array<{ path: string; sizeBytes: number }>;
};
