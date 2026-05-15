import fs from "node:fs";
import path from "node:path";
import type { ProjectContextPack, ProjectIntake, ProjectKind, ProjectMap, ProjectRunIntent, ProjectSignal } from "@orchcode/protocol";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { WorkspaceTools } from "../tools/WorkspaceTools.js";

type ProjectIntakeInput = {
  workspacePath: string;
  message: string;
  projectMap: ProjectMap;
  tools: ToolRegistry;
};

type SearchHit = {
  path: string;
  line: number;
  preview: string;
};

export function buildProjectIntake(input: ProjectIntakeInput): ProjectIntake {
  const { workspacePath, message, projectMap, tools } = input;
  const workspace = tools.workspace;
  const files = workspace.listFiles(500).filter((entry) => !entry.isDir && !entry.isSecretCandidate);
  const filePaths = files.map((entry) => entry.path);
  const topLevelDirs = summarizeTopLevelDirs(filePaths);
  const sourceFiles = filePaths.filter((file) => /\.(ts|tsx|js|jsx|rs|py|go|java|cs|css|html)$/i.test(file));
  const testFiles = filePaths.filter((file) => /(^|\/)(test|tests|__tests__)\b|(\.test\.|\.(spec))/.test(file));
  const docFiles = filePaths.filter((file) => /(^|\/)(docs\/|README|CHANGELOG|CONTRIBUTING|ARCHITECTURE)/i.test(file));
  const configFiles = filePaths.filter((file) => isConfigFile(file));
  const lockFiles = filePaths.filter((file) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/i.test(file));
  const entryPoints = inferEntryPoints(filePaths, projectMap.importantFiles);
  const packageManifest = readPackageManifest(workspace);
  const scripts = packageManifest?.scripts ?? {};
  const gitStatusText = tools.git.status();
  const gitRepoDetected = workspace.fileExists(".git") || !/not a git repository/i.test(gitStatusText);
  const gitChanges = parseGitStatus(gitStatusText);
  const todoHits = uniqueSearchHits([
    ...workspace.searchCode("TODO", 12),
    ...workspace.searchCode("FIXME", 8),
    ...workspace.searchCode("not implemented", 6)
  ]);
  const orchCodeStateFiles = filePaths.filter((file) => /(orchcode|agent_proposal|work[_-]?journal|decision)/i.test(file));
  const buildCommands = collectBuildCommands(scripts);
  const testCommands = uniqueStrings([...projectMap.testCommands, ...collectTestCommands(scripts)]);
  const knownCommands = uniqueStrings([
    ...buildCommands,
    ...testCommands,
    ...collectKnownCommands(scripts)
  ]);
  const signals: ProjectSignal[] = [];
  const warnings: string[] = [];
  const unknowns: string[] = [];

  if (gitRepoDetected) {
    signals.push({
      type: "git_repository",
      detail: gitChanges.length ? `Git repo detected with ${gitChanges.length} changed path(s).` : "Git repo detected.",
      paths: gitChanges.slice(0, 8)
    });
  }
  if (configFiles.length) {
    signals.push({
      type: "package_config",
      detail: `Detected ${configFiles.length} config or manifest file(s).`,
      paths: configFiles.slice(0, 8)
    });
  }
  if (sourceFiles.length) {
    signals.push({
      type: "source_directories",
      detail: `Detected ${sourceFiles.length} source file(s).`,
      paths: topLevelDirs.slice(0, 8)
    });
  }
  if (testFiles.length) {
    signals.push({
      type: "tests",
      detail: `Detected ${testFiles.length} test file(s).`,
      paths: testFiles.slice(0, 8)
    });
  }
  if (docFiles.length) {
    signals.push({
      type: "docs",
      detail: `Detected ${docFiles.length} documentation file(s).`,
      paths: docFiles.slice(0, 8)
    });
  }
  if (orchCodeStateFiles.length) {
    signals.push({
      type: "previous_orchcode_state",
      detail: "Detected existing OrchCode-like state or proposal artifacts.",
      paths: orchCodeStateFiles.slice(0, 8)
    });
  }
  if (todoHits.length) {
    signals.push({
      type: "existing_todos",
      detail: `Detected ${todoHits.length} TODO/FIXME/not-implemented marker(s).`,
      paths: todoHits.slice(0, 8).map((hit) => hit.path)
    });
  }
  if (buildCommands.length) {
    signals.push({
      type: "existing_build_scripts",
      detail: `Detected ${buildCommands.length} build/dev/start script(s).`,
      paths: configFiles.slice(0, 4)
    });
  }
  if (gitChanges.length) {
    signals.push({
      type: "current_git_changes",
      detail: `Detected ${gitChanges.length} uncommitted or untracked path(s).`,
      paths: gitChanges.slice(0, 8)
    });
  }

  const confidence = inferConfidence({
    sourceFiles: sourceFiles.length,
    configFiles: configFiles.length,
    docs: docFiles.length,
    tests: testFiles.length
  });
  const projectKind = inferProjectKind({
    message,
    sourceFiles: sourceFiles.length,
    configFiles: configFiles.length,
    docs: docFiles.length,
    tests: testFiles.length,
    gitChanges: gitChanges.length,
    todos: todoHits.length,
    entryPoints: entryPoints.length
  });
  if (projectKind === "unknown") {
    warnings.push("Workspace shape could not be classified confidently from the available signals.");
  }
  if (!knownCommands.length) {
    unknowns.push("No known build, test, or launch commands could be inferred.");
  }
  if (!entryPoints.length) {
    warnings.push("No obvious entry point could be proven from the current file scan.");
  }
  if (!testFiles.length) {
    unknowns.push("Tests may be absent, generated elsewhere, or outside the scanned file patterns.");
  }
  if (!gitRepoDetected) {
    warnings.push("Git repository signal could not be proven; change tracking confidence is reduced.");
  }

  const detectedProjectName =
    packageManifest?.name ||
    path.basename(path.resolve(workspacePath)) ||
    "Workspace";
  const importantFiles = rankImportantFiles({
    configFiles,
    docFiles,
    entryPoints,
    testFiles,
    gitChanges,
    projectMap
  });
  const riskyFiles = uniqueStrings([
    ...configFiles.filter((file) => /package\.json|Cargo\.toml|tsconfig|vite\.config|tauri\.conf/i.test(file)),
    ...gitChanges.filter((file) => importantFiles.includes(file)),
    ...entryPoints.filter((file) => file.split("/").length <= 2)
  ]).slice(0, 10);
  const doNotTouchCandidates = uniqueStrings([
    ...lockFiles,
    ".git/",
    "node_modules/",
    "dist/",
    "build/",
    "target/"
  ]);

  const nextActionRecommendation = recommendNextAction({
    message,
    projectKind,
    importantFiles,
    entryPoints,
    todoHits
  });
  const progressReconstruction = reconstructProgress({
    message,
    sourceFiles,
    testFiles,
    todoHits,
    docFiles,
    topLevelDirs,
    importantFiles,
    nextActionRecommendation
  });
  const architectureSummary = summarizeArchitecture(projectMap, topLevelDirs, entryPoints);
  const moduleSummary = topLevelDirs.map((dir) => `${dir}/`);
  const currentStateSummary = summarizeCurrentState({
    projectKind,
    sourceFiles: sourceFiles.length,
    tests: testFiles.length,
    docs: docFiles.length,
    gitChanges: gitChanges.length,
    todoHits: todoHits.length
  });
  const runIntent = classifyRunIntent(message);
  const guardrails = createGuardrails();
  const contextPack = buildContextPack({
    message,
    projectKind,
    importantFiles,
    testFiles,
    sourceFiles,
    todoHits,
    entryPoints,
    knownCommands,
    testCommands,
    riskyFiles,
    doNotTouchCandidates,
    unknowns,
    currentStateSummary,
    guardrails
  });

  return {
    projectId: workspacePath,
    workspaceRoot: workspacePath,
    detectedProjectName,
    intakeStatus: "completed",
    projectKind,
    confidence,
    detectedSignals: signals,
    architectureSummary,
    moduleSummary,
    knownEntryPoints: entryPoints,
    knownCommands,
    testCommands,
    buildCommands,
    importantFiles,
    riskyFiles,
    doNotTouchCandidates,
    currentStateSummary,
    nextActionRecommendation,
    unknowns,
    warnings,
    progressReconstruction,
    contextPack,
    runIntent,
    guardrails
  };
}

export function shouldTreatProjectAsExisting(projectKind: ProjectKind) {
  return projectKind === "existing_project" || projectKind === "mid_progress_project";
}

export function classifyRunIntent(message: string): ProjectRunIntent {
  const normalized = message.toLowerCase();
  if (/\b(explain|inspect|analyze|summarize|map)\b/.test(normalized) && !/\b(change|edit|fix|add|implement)\b/.test(normalized)) {
    return "inspect_only";
  }
  if (
    /\b(run to green|make it run|fix until it starts|fix until it runs|boot it|start it working)\b/.test(normalized) ||
    /\bfix\b.*\b(project|app|site|game)\b.*\buntil it (starts|runs)\b/.test(normalized) ||
    /\b(run|launch|start|serve|open)\b.+\b(project|app|preview|site|game)\b/.test(normalized)
  ) {
    return "run_to_green";
  }
  if (/\b(run|launch|start|serve|open)\b/.test(normalized)) {
    return "run_once";
  }
  if (/\b(add|edit|fix|implement|update|change|wire|build)\b/.test(normalized)) {
    return "implement_module";
  }
  return "unknown";
}

function readPackageManifest(workspace: WorkspaceTools) {
  if (!workspace.fileExists("package.json")) return undefined;
  try {
    return JSON.parse(workspace.readWholeFile("package.json")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

function collectBuildCommands(scripts: Record<string, string>) {
  return Object.entries(scripts)
    .filter(([name]) => /^(build|dev|start|preview)$/i.test(name))
    .map(([name]) => `npm run ${name}`);
}

function collectTestCommands(scripts: Record<string, string>) {
  return Object.entries(scripts)
    .filter(([name]) => /test|check|lint|verify/i.test(name))
    .map(([name]) => `npm run ${name}`);
}

function collectKnownCommands(scripts: Record<string, string>) {
  return Object.keys(scripts).slice(0, 8).map((name) => `npm run ${name}`);
}

function parseGitStatus(statusText: string) {
  if (!statusText || /not a git repository/i.test(statusText)) return [];
  return statusText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function inferConfidence(input: {
  sourceFiles: number;
  configFiles: number;
  docs: number;
  tests: number;
}): ProjectIntake["confidence"] {
  const score = Number(input.sourceFiles > 0) + Number(input.configFiles > 0) + Number(input.docs > 0) + Number(input.tests > 0);
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  if (score >= 1) return "low";
  return "unknown";
}

function inferProjectKind(input: {
  message: string;
  sourceFiles: number;
  configFiles: number;
  docs: number;
  tests: number;
  gitChanges: number;
  todos: number;
  entryPoints: number;
}): ProjectKind {
  const meaningfulSignals = Number(input.sourceFiles > 0) + Number(input.configFiles > 0) + Number(input.docs > 0) + Number(input.entryPoints > 0);
  if (meaningfulSignals === 0) {
    return /\b(create|new|scaffold|generate|make a new)\b/i.test(input.message) ? "empty_project" : "unknown";
  }
  if (input.gitChanges > 0 || input.todos > 0) {
    return "mid_progress_project";
  }
  if (input.sourceFiles >= 3 || input.tests > 0 || input.configFiles > 0) {
    return "existing_project";
  }
  return "unknown";
}

function inferEntryPoints(filePaths: string[], importantFiles: string[]) {
  return uniqueStrings([
    ...importantFiles.filter((file) => /(^|\/)(index|main|app|server)\.(ts|tsx|js|jsx|rs|py|html)$/i.test(file)),
    ...filePaths.filter((file) => /(^|\/)(index|main|app|server)\.(ts|tsx|js|jsx|rs|py|html)$/i.test(file)).slice(0, 8)
  ]).slice(0, 8);
}

function rankImportantFiles(input: {
  configFiles: string[];
  docFiles: string[];
  entryPoints: string[];
  testFiles: string[];
  gitChanges: string[];
  projectMap: ProjectMap;
}) {
  return uniqueStrings([
    ...input.projectMap.importantFiles,
    ...input.configFiles,
    ...input.docFiles,
    ...input.entryPoints,
    ...input.testFiles.slice(0, 4),
    ...input.gitChanges.slice(0, 4)
  ]).slice(0, 12);
}

function recommendNextAction(input: {
  message: string;
  projectKind: ProjectKind;
  importantFiles: string[];
  entryPoints: string[];
  todoHits: SearchHit[];
}) {
  if (input.projectKind === "empty_project") {
    return "Workspace looks close to empty; normal blank-project planning can proceed.";
  }
  const hintedFile = pickFilesRelevantToMessage(input.message, [...input.importantFiles, ...input.entryPoints])[0];
  if (hintedFile) {
    return `Inspect ${hintedFile} before editing; existing project signals suggest preserving current structure first.`;
  }
  if (input.todoHits[0]) {
    return `Inspect ${input.todoHits[0].path} before editing; it contains an existing TODO/FIXME marker.`;
  }
  if (input.entryPoints[0]) {
    return `Inspect ${input.entryPoints[0]} before editing; it looks like an existing entry point.`;
  }
  if (input.importantFiles[0]) {
    return `Inspect ${input.importantFiles[0]} before editing; it is a high-signal project file.`;
  }
  return "Module state could not be proven; recommended next action is read-only mapping before edits.";
}

function reconstructProgress(input: {
  message: string;
  sourceFiles: string[];
  testFiles: string[];
  todoHits: SearchHit[];
  docFiles: string[];
  topLevelDirs: string[];
  importantFiles: string[];
  nextActionRecommendation: string;
}) {
  const implementedAreas = input.topLevelDirs.slice(0, 6).map((dir) => `Inferred implementation under ${dir}/`);
  const partialAreas = uniqueStrings([
    ...input.todoHits.slice(0, 5).map((hit) => `Inferred partial area: ${hit.path} (${hit.preview || `line ${hit.line}`})`),
    ...input.importantFiles.filter((file) => /stub|placeholder/i.test(file)).map((file) => `Inferred partial area: ${file}`)
  ]).slice(0, 6);
  const missingAreas: string[] = [];
  const brokenAreas: string[] = [];
  if (input.sourceFiles.length > 0 && input.testFiles.length === 0) {
    missingAreas.push("Tests were not detected alongside existing source; coverage may be missing or out of scan range.");
  }
  if (input.docFiles.some((file) => /architecture|roadmap|plan/i.test(file)) && input.sourceFiles.length < 2) {
    brokenAreas.push("Documentation exists, but implementation evidence is thin relative to the docs.");
  }
  const previousPlanEvidence = input.docFiles
    .filter((file) => /architecture|roadmap|plan|status/i.test(file))
    .map((file) => `Plan-like evidence: ${file}`)
    .slice(0, 6);
  return {
    inferred: true as const,
    summary: "Progress reconstruction is inferred from workspace structure, docs, and TODO markers; it is not a proof of completion.",
    implementedAreas,
    partialAreas,
    missingAreas,
    brokenAreas,
    previousPlanEvidence,
    nextSafeAction: input.nextActionRecommendation,
    warnings: ["All progress labels are best-effort inferences from file and text signals."]
  };
}

function summarizeArchitecture(projectMap: ProjectMap, topLevelDirs: string[], entryPoints: string[]) {
  const stack = projectMap.stack.length ? projectMap.stack.join(", ") : "unknown stack";
  const roots = topLevelDirs.length ? topLevelDirs.slice(0, 4).join(", ") : "no obvious module roots";
  const entry = entryPoints[0] ?? "no proven entry point";
  return `${stack}; module roots: ${roots}; primary entry signal: ${entry}.`;
}

function summarizeCurrentState(input: {
  projectKind: ProjectKind;
  sourceFiles: number;
  tests: number;
  docs: number;
  gitChanges: number;
  todoHits: number;
}) {
  const state = input.projectKind.replaceAll("_", " ");
  return `Detected ${state} with ${input.sourceFiles} source file(s), ${input.tests} test file(s), ${input.docs} doc file(s), ${input.gitChanges} changed path(s), and ${input.todoHits} TODO/FIXME marker(s).`;
}

function buildContextPack(input: {
  message: string;
  projectKind: ProjectKind;
  importantFiles: string[];
  testFiles: string[];
  sourceFiles: string[];
  todoHits: SearchHit[];
  entryPoints: string[];
  knownCommands: string[];
  testCommands: string[];
  riskyFiles: string[];
  doNotTouchCandidates: string[];
  unknowns: string[];
  currentStateSummary: string;
  guardrails: ProjectIntake["guardrails"];
}): ProjectContextPack {
  const relevantFiles = uniqueStrings([
    ...pickFilesRelevantToMessage(input.message, [...input.importantFiles, ...input.sourceFiles]),
    ...input.entryPoints.slice(0, 3),
    ...input.importantFiles.slice(0, 5)
  ]).slice(0, 10);
  const relatedTests = input.testFiles.filter((file) => relevantFiles.some((target) => shareStem(file, target))).slice(0, 8);
  const apisLikelyToPreserve = input.sourceFiles
    .filter((file) => /(api|interface|types|schema|protocol)/i.test(file))
    .slice(0, 8);
  const safeToEdit = uniqueStrings([
    ...relevantFiles.filter((file) => !input.riskyFiles.includes(file)),
    ...input.sourceFiles.filter((file) => /src\/|app\/|components\/|runtime\//i.test(file)).slice(0, 4)
  ]).slice(0, 8);
  const cautionPaths = uniqueStrings([...input.riskyFiles, ...input.entryPoints.slice(0, 2)]).slice(0, 8);
  const conventionsDiscovered = uniqueStrings([
    input.projectKind === "mid_progress_project" ? "Existing project with in-flight work; keep edits narrow." : "Existing source/layout should be preserved unless explicitly changed.",
    input.testFiles.some((file) => /\.test\./.test(file)) ? "Tests use .test.* naming." : "Test naming convention could not be proven.",
    input.entryPoints.length ? `Entry-point files detected: ${input.entryPoints.slice(0, 3).join(", ")}` : "Entry-point convention is unclear."
  ]);
  const acceptanceCriteriaDraft = [
    "Preserve existing public contracts and file layout unless the current task proves otherwise.",
    "Keep edits scoped to the selected files from the context pack.",
    `Verify with: ${(input.testCommands[0] ?? input.knownCommands[0] ?? "git diff --check")}.`
  ];
  const knownRisks = uniqueStrings([
    ...input.todoHits.slice(0, 4).map((hit) => `Existing TODO/FIXME marker in ${hit.path}.`),
    ...cautionPaths.map((file) => `Use caution in ${file}.`)
  ]).slice(0, 8);
  return {
    projectSummary: input.currentStateSummary,
    currentTaskObjective: input.message || undefined,
    relevantFiles,
    relatedTests,
    conventionsDiscovered,
    apisLikelyToPreserve,
    safeToEdit,
    cautionPaths,
    doNotTouchCandidates: input.doNotTouchCandidates,
    acceptanceCriteriaDraft,
    verificationCommands: uniqueStrings([...input.testCommands, ...input.knownCommands]).slice(0, 6),
    knownRisks,
    unknowns: input.unknowns,
    guardrails: input.guardrails
  };
}

function createGuardrails() {
  return {
    summary: "Read wide, summarize hard, edit narrow.",
    rules: [
      "No deleting files without explicit approval.",
      "No broad public API rename without approval.",
      "No architecture rewrite unless explicitly requested.",
      "No new dependency without a stated reason.",
      "Prefer modifying existing files over creating parallel duplicate systems.",
      "Keep changes scoped to the current module or objective.",
      "Preserve existing tests and public contracts."
    ]
  };
}

function summarizeTopLevelDirs(filePaths: string[]) {
  const counts = new Map<string, number>();
  for (const file of filePaths) {
    const root = file.split("/")[0];
    if (!root) continue;
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([dir]) => dir)
    .slice(0, 8);
}

function isConfigFile(file: string) {
  return /(^|\/)(package\.json|tsconfig.*\.json|Cargo\.toml|pyproject\.toml|vite\.config\.(ts|js)|tauri\.conf\.json)$/i.test(file);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueSearchHits(values: SearchHit[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.path}:${value.line}:${value.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pickFilesRelevantToMessage(message: string, files: string[]) {
  const normalized = message.toLowerCase();
  return files.filter((file) => {
    const base = path.basename(file).toLowerCase();
    return normalized.includes(base) || normalized.includes(base.replace(path.extname(base), "")) || normalized.includes(file.toLowerCase());
  });
}

function shareStem(left: string, right: string) {
  const leftStem = path.basename(left).replace(/\.(test|spec)\./, ".").split(".")[0];
  const rightStem = path.basename(right).split(".")[0];
  return Boolean(leftStem) && leftStem === rightStem;
}

export function createProjectMapFromIntake(projectMap: ProjectMap, intake: ProjectIntake): ProjectMap {
  return {
    ...projectMap,
    entryPoints: intake.knownEntryPoints.length ? intake.knownEntryPoints : projectMap.entryPoints,
    importantFiles: intake.importantFiles.length ? intake.importantFiles : projectMap.importantFiles,
    testCommands: intake.testCommands.length ? intake.testCommands : projectMap.testCommands,
    projectKind: intake.projectKind,
    intakeConfidence: intake.confidence,
    currentStateSummary: intake.currentStateSummary
  };
}

export function createProjectIntakeEvidenceRefs(intake: ProjectIntake) {
  return intake.importantFiles.slice(0, 5).map((file) => ({
    type: "file" as const,
    path: file,
    category: "project-intake",
    reason: "High-signal file referenced by project intake."
  }));
}

export function createProjectIntakeWarnings(intake: ProjectIntake) {
  return [...intake.warnings, ...intake.unknowns].slice(0, 6);
}

export function projectNeedsDeeperReadOnlyIntake(intake: ProjectIntake) {
  return intake.projectKind === "unknown" || intake.confidence === "low" || intake.confidence === "unknown";
}

export function pathExistsInsideWorkspace(workspacePath: string, relativePath: string) {
  return fs.existsSync(path.join(workspacePath, relativePath));
}
