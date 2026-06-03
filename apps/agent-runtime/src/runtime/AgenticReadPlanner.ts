import type { AgenticReadBudget, AgenticReadPlan, AgenticReadStep, AgenticTaskIntent } from "./AgenticTaskModels.js";

export function buildAgenticReadPlan(input: {
  intent: AgenticTaskIntent;
  allFiles: string[];
  budget: AgenticReadBudget;
}): AgenticReadPlan {
  const steps: AgenticReadStep[] = [];
  const add = (step: Omit<AgenticReadStep, "id">) => {
    steps.push({ id: `read_${steps.length + 1}`, ...step });
  };
  const important = importantFilesForMode(input.allFiles, input.intent);
  if (important.length) {
    add({
      kind: "seed",
      reason: seedReasonForMode(input.intent.mode),
      terms: input.intent.aliases.slice(0, 16),
      paths: important.slice(0, Math.min(10, input.budget.maxOpenedFiles)),
      depth: 0,
      readMode: "full_file",
      required: true
    });
  }
  if (input.intent.targetPaths.length) {
    add({
      kind: "path_open",
      reason: "The user named these paths explicitly.",
      terms: input.intent.terms,
      paths: input.intent.targetPaths,
      depth: 0,
      readMode: "full_file",
      required: true
    });
  }
  add({
    kind: "term_search",
    reason: `Search terms and aliases for ${input.intent.mode}.`,
    terms: input.intent.aliases.slice(0, 28),
    paths: candidateFilesForTerms(input.allFiles, input.intent.aliases).slice(0, input.budget.maxOpenedFiles),
    depth: 0,
    readMode: "snippet",
    required: true
  });
  if (input.intent.mode === "architecture_explain") {
    add({
      kind: "import_follow",
      reason: "Architecture questions need entrypoint, runtime, orchestration, shared types, and import relationships.",
      terms: ["import", "export", "router", "runtime", "orchestrator", "protocol", "types"],
      paths: architectureFiles(input.allFiles).slice(0, input.budget.maxOpenedFiles),
      depth: 1,
      readMode: "import_follow",
      required: true
    });
  }
  if (input.intent.mode === "data_flow" || input.intent.mode === "backend_flow" || input.intent.mode === "ui_flow") {
    add({
      kind: "route_follow",
      reason: "Flow questions need routes, services, UI handlers, and handoff points.",
      terms: ["route", "endpoint", "handler", "service", "fetch", "api", "storage", "state"],
      paths: flowFiles(input.allFiles).slice(0, input.budget.maxOpenedFiles),
      depth: 1,
      readMode: "import_follow",
      required: true
    });
  }
  if (input.intent.mode === "debugging_analysis") {
    add({
      kind: "term_search",
      reason: "Debugging questions prioritize failure terms, affected modules, and validation or test references.",
      terms: [...input.intent.aliases, "error", "throw", "catch", "failed", "validation", "test"].slice(0, 32),
      paths: debuggingFiles(input.allFiles).slice(0, input.budget.maxOpenedFiles),
      depth: 0,
      readMode: "snippet",
      required: true
    });
  }
  if (input.intent.mode === "repair_planning") {
    add({
      kind: "artifact_follow",
      reason: "Repair planning may inspect failed stage artifacts and validation logs as supporting evidence.",
      terms: ["failed", "validation", "sandbox", "apply", "review", "artifact"],
      paths: repairArtifactFiles(input.allFiles).slice(0, input.budget.maxOpenedFiles),
      depth: 0,
      readMode: "artifact_follow",
      required: false
    });
  }
  add({
    kind: "config_follow",
    reason: "Configuration and package manifests help identify runtime, dependencies, and validation commands.",
    terms: ["package", "config", "tsconfig", "vite", "pyproject", "requirements"],
    paths: configFiles(input.allFiles).slice(0, 12),
    depth: 0,
    readMode: "config_follow",
    required: false
  });
  return {
    mode: input.intent.mode,
    strategy: strategyForMode(input.intent.mode),
    budget: input.budget,
    steps: dedupeSteps(steps)
  };
}

function strategyForMode(mode: AgenticTaskIntent["mode"]) {
  if (mode === "architecture_explain") return "manifest_entrypoint_module_relationship_scan";
  if (mode === "feature_existence" || mode === "feature_explain") return "term_alias_production_evidence_scan";
  if (mode === "debugging_analysis") return "failure_terms_affected_modules_validation_scan";
  if (mode === "repair_planning") return "failed_stage_artifact_and_source_scan";
  if (mode === "refactor_planning" || mode === "coding_planning" || mode === "patch_preparation") return "target_api_dependency_validation_scan";
  if (mode === "data_flow" || mode === "ui_flow" || mode === "backend_flow") return "relationship_following_flow_scan";
  return "adaptive_workspace_scan";
}

function seedReasonForMode(mode: AgenticTaskIntent["mode"]) {
  if (mode === "architecture_explain") return "Open manifests, entrypoints, orchestration modules, protocol/shared types, and UI shell where present.";
  if (mode === "feature_existence") return "Open candidate production files before treating tests or fixtures as evidence.";
  if (mode === "debugging_analysis") return "Open likely affected modules and validation references.";
  return "Open high-signal files for the requested task mode.";
}

function importantFilesForMode(files: string[], intent: AgenticTaskIntent) {
  const fromMode = intent.mode === "architecture_explain"
    ? architectureFiles(files)
    : intent.mode === "config_explain"
      ? configFiles(files)
      : candidateFilesForTerms(files, intent.aliases);
  return uniqueStrings([...intent.targetPaths, ...fromMode]);
}

function candidateFilesForTerms(files: string[], terms: string[]) {
  const normalizedTerms = terms.map(normalize).filter((term) => term.length > 1);
  return files
    .filter((file) => normalizedTerms.some((term) => normalize(file).includes(term)))
    .sort(scorePath);
}

function architectureFiles(files: string[]) {
  return files
    .filter((file) => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|tsconfig\.json|vite\.config\.[tj]s|next\.config\.[tj]s|src\/index\.[tj]s|src\/main\.[tj]sx?|src\/server\.[tj]s|src\/runtime\/|src\/orchestration\/|src\/agents?\/|src\/tools\/|src\/memory\/|packages\/protocol\/)/i.test(file))
    .sort(scorePath);
}

function flowFiles(files: string[]) {
  return files
    .filter((file) => /(^|\/)(routes?|api|controllers?|services?|stores?|state|pages|components|app|runtime|orchestration)\/|(^|\/)src\/(index|main|server)\.[tj]sx?$|fetch|endpoint|pipeline|ingest|stream/i.test(file))
    .sort(scorePath);
}

function debuggingFiles(files: string[]) {
  return files
    .filter((file) => /(^|\/)(src|apps|packages|tests?)\/|\.test\.|\.spec\.|validation|runner|error|logger|runtime/i.test(file))
    .sort(scorePath);
}

function repairArtifactFiles(files: string[]) {
  return files
    .filter((file) => /(^|\/)(\.agent_memory|artifacts?|reports?|logs?|validation|sandbox|patch|review|runtime_events|sessions)(\/|$)|failed|failure/i.test(file))
    .sort(scorePath);
}

function configFiles(files: string[]) {
  return files
    .filter((file) => /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod|tsconfig\.json|vite\.config\.[tj]s|next\.config\.[tj]s|dockerfile|compose\.ya?ml|\.env\.example)$/i.test(file))
    .sort(scorePath);
}

function scorePath(left: string, right: string) {
  return pathScore(right) - pathScore(left) || left.localeCompare(right);
}

function pathScore(file: string) {
  let score = 0;
  if (/(^|\/)(package\.json|tsconfig\.json|Cargo\.toml|pyproject\.toml)$/i.test(file)) score += 10;
  if (/(^|\/)(src|apps|packages)\//i.test(file)) score += 8;
  if (/(^|\/)(runtime|orchestration|agents?|tools|memory|protocol)\//i.test(file)) score += 5;
  if (/\.(test|spec)\./i.test(file) || /(^|\/)tests?\//i.test(file)) score -= 4;
  if (/(^|\/)(dist|build|coverage|node_modules|tmp|\.agent_memory)\//i.test(file)) score -= 20;
  return score;
}

function dedupeSteps(steps: AgenticReadStep[]) {
  const seen = new Set<string>();
  const result: AgenticReadStep[] = [];
  for (const step of steps) {
    const paths = uniqueStrings(step.paths);
    const key = `${step.kind}:${step.reason}:${paths.join("|")}:${step.terms.join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...step, paths });
  }
  return result.map((step, index) => ({ ...step, id: `read_${index + 1}` }));
}

function normalize(value: string) {
  return value.toLowerCase().replaceAll("\\", "/");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
