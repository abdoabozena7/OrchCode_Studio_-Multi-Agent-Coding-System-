import type { ModuleExecutionPlan, PatchFileChange, PatchProposal, RunToGreenDiagnosis } from "@hivo/protocol";
import { ToolRegistry } from "../tools/ToolRegistry.js";

export type RepairPatchIntentOperation = "create_file" | "replace_range";

export type RepairPatchIntent = {
  path: string;
  operation: RepairPatchIntentOperation;
  anchorText?: string;
  preimageText?: string;
  replacementText: string;
  reason: string;
  risk: PatchProposal["riskLevel"];
};

export type RepairPatchIntentModel = {
  title: string;
  summary: string;
  intents: RepairPatchIntent[];
  suggestedCommands?: Array<{ command: string; reason: string }>;
};

export function buildRepairPatchPrompt(input: {
  objective: string;
  command: string;
  diagnosis: RunToGreenDiagnosis;
  modulePlan?: ModuleExecutionPlan;
  relevantFiles: Array<{ path: string; excerpt: string }>;
}) {
  return [
    "Create a reviewable repair patch intent as strict JSON for a local coding agent.",
    "Do not include hidden chain-of-thought.",
    "Fix only the proven failure. Keep changes narrow, preserve existing public contracts, and avoid new dependencies or broad rewrites.",
    "Return JSON with: title, summary, intents[{path,operation,anchorText?,preimageText?,replacementText,reason,risk}], suggestedCommands.",
    "Allowed operations: create_file, replace_range.",
    "Use replace_range for existing files and choose a preimageText snippet that appears exactly once.",
    `Objective: ${input.objective}`,
    `Failed command: ${input.command}`,
    `Diagnosis: ${JSON.stringify(input.diagnosis)}`,
    `Module plan: ${JSON.stringify(input.modulePlan)}`,
    `Relevant file excerpts: ${JSON.stringify(input.relevantFiles)}`
  ].join("\n");
}

export function compileRepairPatchProposal(
  workspacePath: string,
  tools: ToolRegistry,
  patchIntent: RepairPatchIntentModel
): Omit<PatchProposal, "id" | "sessionId" | "createdAt"> {
  const filesChanged: Array<{ path: string; changeType: PatchFileChange["changeType"]; explanation: string }> = [];
  const artifacts: Array<{ path: string; content: string }> = [];
  const diffs: string[] = [];
  const riskLevel = highestRiskLevel(patchIntent.intents.map((intent) => intent.risk));

  for (const intent of patchIntent.intents) {
    const compiled = compileIntent(workspacePath, tools, intent);
    filesChanged.push({
      path: compiled.path,
      changeType: compiled.changeType,
      explanation: compiled.explanation
    });
    artifacts.push({ path: compiled.path, content: compiled.content });
    diffs.push(compiled.unifiedDiff);
  }

  return {
    title: patchIntent.title,
    summary: patchIntent.summary,
    riskLevel,
    filesChanged,
    artifacts,
    unifiedDiff: diffs.join("\n"),
    requiresApproval: true,
    status: "proposed"
  };
}

export function collectRepairFileExcerpts(tools: ToolRegistry, filePaths: string[]) {
  return filePaths.flatMap((filePath) => {
    if (!tools.workspace.fileExists(filePath)) return [];
    return [{
      path: filePath,
      excerpt: tools.workspace.readWholeFile(filePath).slice(0, 1200)
    }];
  }).slice(0, 6);
}

function compileIntent(
  workspacePath: string,
  tools: ToolRegistry,
  intent: RepairPatchIntent
): {
  path: string;
  changeType: PatchFileChange["changeType"];
  explanation: string;
  content: string;
  unifiedDiff: string;
} {
  assertRelativeWorkspacePath(workspacePath, intent.path);

  if (intent.operation === "create_file") {
    if (tools.workspace.fileExists(intent.path)) {
      throw new Error(`Patch intent expected a new file, but ${intent.path} already exists`);
    }
    return {
      path: intent.path,
      changeType: "create",
      explanation: intent.reason,
      content: intent.replacementText,
      unifiedDiff: createFileDiff(intent.path, intent.replacementText)
    };
  }

  if (!tools.workspace.fileExists(intent.path)) {
    throw new Error(`Patch intent targeted missing file: ${intent.path}`);
  }

  const current = tools.workspace.readWholeFile(intent.path);
  const anchor = intent.preimageText ?? intent.anchorText;
  if (!anchor) {
    throw new Error(`Patch intent for ${intent.path} is missing anchorText/preimageText`);
  }

  const matches = findExactMatches(current, anchor);
  if (matches.length === 0) {
    throw new Error(`Patch intent anchor was not found in ${intent.path}`);
  }
  if (matches.length > 1) {
    throw new Error(`Patch intent anchor is ambiguous in ${intent.path}`);
  }

  const match = matches[0]!;
  const updated = `${current.slice(0, match.start)}${intent.replacementText}${current.slice(match.end)}`;
  return {
    path: intent.path,
    changeType: "modify",
    explanation: intent.reason,
    content: updated,
    unifiedDiff: createReplaceRangeDiff(intent.path, current, updated, match.start, match.end)
  };
}

function createFileDiff(filePath: string, content: string) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${countDiffLines(content)} @@`,
    ...normalizeDiffLines(content).map((line) => `+${line}`)
  ].join("\n");
}

function createReplaceRangeDiff(filePath: string, before: string, after: string, start: number, end: number) {
  const beforeLines = splitLinesForDiff(before);
  const afterLines = splitLinesForDiff(after);
  void start;
  void end;
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - suffix - 1] === afterLines[afterLines.length - suffix - 1]
  ) suffix += 1;
  const contextBeforeCount = Math.min(2, prefix);
  const contextAfterCount = Math.min(2, suffix);
  const oldSliceStart = prefix - contextBeforeCount;
  const newSliceStart = prefix - contextBeforeCount;
  const oldChanged = beforeLines.slice(prefix, beforeLines.length - suffix);
  const newChanged = afterLines.slice(prefix, afterLines.length - suffix);
  const trailingContext = beforeLines.slice(beforeLines.length - suffix, beforeLines.length - suffix + contextAfterCount);
  const oldCount = contextBeforeCount + oldChanged.length + contextAfterCount;
  const newCount = contextBeforeCount + newChanged.length + contextAfterCount;

  const hunkLines = [
    ...beforeLines.slice(oldSliceStart, prefix).map((line) => ` ${line}`),
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...trailingContext.map((line) => ` ${line}`)
  ];

  return [
    `diff --git a/${filePath} b/${filePath}`,
    "index 1111111..2222222 100644",
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -${oldSliceStart + 1},${oldCount} +${newSliceStart + 1},${newCount} @@`,
    ...hunkLines
  ].join("\n");
}

function assertRelativeWorkspacePath(workspacePath: string, targetPath: string) {
  const normalizedTarget = targetPath.replaceAll("\\", "/");
  if (!normalizedTarget || normalizedTarget.startsWith("/") || /^[a-z]:/i.test(normalizedTarget) || normalizedTarget.includes("..")) {
    throw new Error(`Patch intent references a path outside the workspace: ${targetPath}`);
  }
  const resolved = normalizedTarget.split("/").filter(Boolean).join("/");
  if (!resolved) {
    throw new Error(`Patch intent path is invalid: ${targetPath}`);
  }
  void workspacePath;
}

function highestRiskLevel(risks: PatchProposal["riskLevel"][]) {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

function findExactMatches(content: string, snippet: string) {
  const matches: Array<{ start: number; end: number }> = [];
  let startIndex = 0;
  while (startIndex <= content.length) {
    const index = content.indexOf(snippet, startIndex);
    if (index === -1) break;
    matches.push({ start: index, end: index + snippet.length });
    startIndex = index + 1;
  }
  return matches;
}

function lineIndexAt(content: string, position: number) {
  const clamped = Math.max(0, Math.min(position, content.length));
  return content.slice(0, clamped).split("\n").length - 1;
}

function splitLinesForDiff(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function normalizeDiffLines(content: string) {
  return splitLinesForDiff(content);
}

function countDiffLines(content: string) {
  return Math.max(splitLinesForDiff(content).length, 1);
}
