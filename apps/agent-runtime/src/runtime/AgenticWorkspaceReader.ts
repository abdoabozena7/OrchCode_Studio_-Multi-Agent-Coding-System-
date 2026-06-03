import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { filterProjectEvidencePaths } from "./EvidenceHygiene.js";
import type { AgenticOpenedFile, AgenticReadPlan } from "./AgenticTaskModels.js";
import { followAgenticRelationships, summarizeAgenticFiles } from "./AgenticRelationshipFollower.js";

const TEXT_FILE_RE = /\.(c|cc|conf|cpp|cs|css|go|h|hpp|html|java|js|json|jsx|kt|md|mjs|py|rs|scss|sh|sql|swift|toml|ts|tsx|txt|yaml|yml)$/i;
const HUGE_OR_GENERATED_RE = /(^|\/)(\.cache|\.git|\.next|\.nuxt|\.pytest_cache|\.ruff_cache|\.svelte-kit|\.turbo|\.venv|\.vite|__pycache__|build|coverage|dist|env|node_modules|out|output|outputs|playwright-report|site-packages|target|test-results|venv)(\/|$)/i;

export type AgenticWorkspaceReadResult = {
  allFiles: string[];
  evidenceExcludedFiles: string[];
  openedFiles: AgenticOpenedFile[];
  fileSummaries: ReturnType<typeof summarizeAgenticFiles>;
  relationships: ReturnType<typeof followAgenticRelationships>["relationships"];
};

export function readWorkspaceForAgenticPlan(input: {
  tools: ToolRegistry;
  prompt: string;
  plan: AgenticReadPlan;
}): AgenticWorkspaceReadResult {
  const allFiles = input.tools.workspace
    .listFiles(20_000)
    .filter((file) => !file.isDir && !file.isSecretCandidate)
    .map((file) => file.path.replaceAll("\\", "/"))
    .filter((file) => TEXT_FILE_RE.test(file))
    .filter((file) => !HUGE_OR_GENERATED_RE.test(file));
  const scoped = filterProjectEvidencePaths(allFiles, input.prompt);
  const files = scoped.included;
  const opened = new Map<string, AgenticOpenedFile>();
  let totalChars = 0;
  const startedAt = Date.now();
  const openFile = (filePath: string, reason: string, readMode: AgenticOpenedFile["readMode"]) => {
    if (Date.now() - startedAt > input.plan.budget.timeoutMs) return;
    if (opened.size >= input.plan.budget.maxOpenedFiles) return;
    if (totalChars >= input.plan.budget.maxTotalChars) return;
    if (!files.includes(filePath)) return;
    const existing = opened.get(filePath);
    if (existing) {
      existing.openedBecause.push(reason);
      return;
    }
    const content = safeRead(input.tools, filePath);
    if (content === undefined) return;
    const remaining = input.plan.budget.maxTotalChars - totalChars;
    const limit = Math.min(input.plan.budget.maxCharsPerFile, remaining);
    const sliced = content.slice(0, limit);
    totalChars += sliced.length;
    opened.set(filePath, {
      path: filePath,
      content: sliced,
      truncated: content.length > sliced.length,
      charsRead: sliced.length,
      openedBecause: [reason],
      readMode
    });
  };

  for (const step of input.plan.steps) {
    for (const path of step.paths) openFile(path, step.reason, step.readMode);
    if (opened.size >= input.plan.budget.maxOpenedFiles || totalChars >= input.plan.budget.maxTotalChars) break;
    if (step.kind !== "term_search") continue;
    for (const file of files) {
      if (opened.size >= input.plan.budget.maxOpenedFiles || totalChars >= input.plan.budget.maxTotalChars) break;
      if (!step.terms.some((term) => file.toLowerCase().includes(term.toLowerCase()))) continue;
      openFile(file, step.reason, step.readMode);
    }
    for (const file of files) {
      if (opened.size >= input.plan.budget.maxOpenedFiles || totalChars >= input.plan.budget.maxTotalChars) break;
      if (opened.has(file)) continue;
      const content = safeRead(input.tools, file);
      if (content === undefined) continue;
      const lower = content.toLowerCase();
      if (!step.terms.some((term) => lower.includes(term.toLowerCase()))) continue;
      const windowed = contentWindowForTerms(content, step.terms, input.plan.budget.maxCharsPerFile);
      const remaining = input.plan.budget.maxTotalChars - totalChars;
      const sliced = windowed.slice(0, Math.min(input.plan.budget.maxCharsPerFile, remaining));
      totalChars += sliced.length;
      opened.set(file, {
        path: file,
        content: sliced,
        truncated: content.length > sliced.length,
        charsRead: sliced.length,
        openedBecause: [step.reason],
        readMode: step.readMode
      });
    }
  }

  if (input.plan.budget.maxRelationshipDepth > 0 && opened.size < input.plan.budget.maxOpenedFiles) {
    const followed = followAgenticRelationships({
      openedFiles: [...opened.values()],
      allFiles: files,
      readFile: (relativePath) => safeRead(input.tools, relativePath),
      budget: {
        ...input.plan.budget,
        maxOpenedFiles: input.plan.budget.maxOpenedFiles - opened.size
      }
    });
    for (const file of followed.additionalFiles) {
      if (opened.size >= input.plan.budget.maxOpenedFiles) break;
      opened.set(file.path, file);
    }
    const allOpened = [...opened.values()];
    return {
      allFiles: files,
      evidenceExcludedFiles: scoped.excluded.map((item) => item.path),
      openedFiles: allOpened,
      fileSummaries: summarizeAgenticFiles(allOpened),
      relationships: followed.relationships
    };
  }

  const openedFiles = [...opened.values()];
  return {
    allFiles: files,
    evidenceExcludedFiles: scoped.excluded.map((item) => item.path),
    openedFiles,
    fileSummaries: summarizeAgenticFiles(openedFiles),
    relationships: []
  };
}

function safeRead(tools: ToolRegistry, relativePath: string) {
  try {
    return tools.workspace.readWholeFile(relativePath);
  } catch {
    return undefined;
  }
}

function contentWindowForTerms(content: string, terms: string[], maxChars: number) {
  if (content.length <= maxChars) return content;
  const lower = content.toLowerCase();
  const index = terms
    .map((term) => lower.indexOf(term.toLowerCase()))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, index - Math.floor(maxChars / 3));
  return content.slice(start, start + maxChars);
}
