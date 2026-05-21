import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getRelevantFiles,
  readJson,
  readJsonl,
  resolveMemoryPaths
} from "../memory/ProjectMemory.js";
import { assessIndexFreshness } from "../memory/IndexFreshness.js";
import type { CommandInventory, DecisionRecord, FileSummaryRecord, RepoIndex } from "../memory/types.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { isSecretCandidate, resolveInsideWorkspace } from "../tools/security.js";
import { ORCHESTRATION_SCHEMA_VERSION, type ContextPack, type ContextSnippet, type Task } from "./OrchestrationModels.js";
import { assertValid, validateContextPack } from "./Validation.js";

export type ContextPackBuilderOptions = {
  memoryDir?: string;
  maxFiles?: number;
  maxChars?: number;
  snippetChars?: number;
};

export class ContextPackBuilder {
  constructor(
    private readonly workspacePath: string,
    private readonly options: ContextPackBuilderOptions = {}
  ) {}

  async build(runId: string, task: Task): Promise<ContextPack> {
    const memoryPaths = resolveMemoryPaths(this.workspacePath, this.options.memoryDir);
    const freshness = await assessIndexFreshness(this.workspacePath, this.options.memoryDir);
    if (!existsSync(memoryPaths.repoIndex) || !existsSync(memoryPaths.fileSummaries) || !existsSync(memoryPaths.commandInventory) || freshness.status !== "fresh") {
      await rebuildRepoIndex(this.workspacePath, { memoryDir: this.options.memoryDir });
    }
    const repoIndex = await readJson<RepoIndex>(memoryPaths.repoIndex);
    const commandInventory = await readJson<CommandInventory>(memoryPaths.commandInventory);
    const decisions = await readJsonl<DecisionRecord>(memoryPaths.decisions);
    const relevantSummaries = await getRelevantFiles(this.workspacePath, task.objective, {
      memoryDir: this.options.memoryDir,
      limit: this.options.maxFiles ?? 6
    });
    const relevantFiles = chooseRelevantFiles(task, relevantSummaries, repoIndex, this.options.maxFiles ?? 6);
    const snippets = await this.createSnippets(relevantFiles, this.options.maxChars ?? 12_000, this.options.snippetChars ?? 2_400);
    const approximateSize = snippets.reduce((sum, snippet) => sum + snippet.content.length, 0)
      + task.objective.length
      + decisions.slice(-5).reduce((sum, decision) => sum + decision.summary.length, 0);
    const warnings = [
      freshness.status === "stale" ? "Repository index was stale and refreshed before context pack creation." : "",
      freshness.status === "missing" ? "Repository index was missing and rebuilt before context pack creation." : "",
      relevantFiles.length === 0 ? "No relevant files were selected from memory." : "",
      approximateSize >= (this.options.maxChars ?? 12_000) ? "Context pack reached the configured character budget and was truncated." : ""
    ].filter(Boolean);
    const commands = selectValidationCommands(task, commandInventory);
    const pack: ContextPack = {
      schema_version: ORCHESTRATION_SCHEMA_VERSION,
      id: `ctx_${task.id}`,
      run_id: runId,
      task_id: task.id,
      objective: task.objective,
      relevant_files: relevantFiles,
      snippets,
      repo_index_refs: [
        "repo_index.json",
        "file_summaries.jsonl",
        "command_inventory.json",
        ...relevantFiles.map((file) => `file:${file}`)
      ],
      constraints: [
        "Do not read or write secret-like files.",
        "Do not edit outside allowed_files_to_edit.",
        "Use structured output and include unresolved risks.",
        "Treat repository memory as a map, not a substitute for reading target files."
      ],
      allowed_files_to_edit: task.allowed_files_to_edit,
      forbidden_files: task.forbidden_files,
      previous_decisions: decisions.slice(-8).map((decision) => `${decision.createdAt}: ${decision.summary}`),
      expected_output_schema: task.expected_output_schema,
      validation_requirements: commands.length ? commands : task.validation_commands,
      approximate_size: approximateSize,
      warnings
    };
    return assertValid("ContextPack", pack, validateContextPack);
  }

  private async createSnippets(files: string[], maxChars: number, snippetChars: number): Promise<ContextSnippet[]> {
    const snippets: ContextSnippet[] = [];
    let usedChars = 0;
    for (const relativePath of files) {
      if (usedChars >= maxChars) break;
      const fullPath = resolveInsideWorkspace(this.workspacePath, relativePath);
      if (isSecretCandidate(fullPath)) continue;
      const text = await readFile(fullPath, "utf8").catch(() => "");
      if (!text) continue;
      const remaining = Math.max(0, maxChars - usedChars);
      const content = text.slice(0, Math.min(snippetChars, remaining));
      if (!content) break;
      const endLine = content.split(/\r?\n/).length;
      snippets.push({
        path: relativePath,
        start_line: 1,
        end_line: endLine,
        content,
        truncated: text.length > content.length
      });
      usedChars += content.length;
    }
    return snippets;
  }
}

function chooseRelevantFiles(task: Task, summaries: FileSummaryRecord[], repoIndex: RepoIndex, maxFiles: number) {
  const direct = [...task.relevant_files, ...task.allowed_files_to_edit].filter(Boolean);
  const fromSummaries = summaries.map((summary) => summary.path);
  const fallback = [
    ...repoIndex.entrypoints,
    ...repoIndex.importantFiles,
    ...repoIndex.sourceFiles.slice(0, 5),
    ...repoIndex.docFiles.slice(0, 3)
  ];
  return uniqueStrings([...direct, ...fromSummaries, ...fallback])
    .filter((file) => !task.forbidden_files.includes(file) && !isLikelyGeneratedOrSecret(file))
    .slice(0, maxFiles);
}

function selectValidationCommands(task: Task, inventory: CommandInventory) {
  if (task.validation_commands.length) return task.validation_commands;
  return [
    ...inventory.byKind.test.slice(0, 1),
    ...inventory.byKind.typecheck.slice(0, 1),
    ...inventory.byKind.build.slice(0, 1)
  ].slice(0, 2);
}

function isLikelyGeneratedOrSecret(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/");
  return /(^|\/)(node_modules|dist|build|target|coverage|\.git|\.agent_memory)\//.test(normalized)
    || /(^|\/)\.env(\.|$)|\.pem$|id_rsa$|id_ed25519$|credentials\.json$/i.test(path.basename(normalized));
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
