import path from "node:path";
import type { CommandRisk } from "@orchcode/protocol";

export function classifyCommandRisk(command: string, workspacePath: string): CommandRisk {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return "dangerous";
  if (hasDangerousPattern(normalized) || referencesOutsideWorkspace(command, workspacePath)) {
    return "dangerous";
  }
  if (startsWithAny(normalized, ["npm install", "npm i", "pnpm add", "pnpm install", "cargo add", "git checkout", "git merge", "git rebase", "git reset"])) {
    return "medium";
  }
  if (
    startsWithAny(normalized, [
      "git status",
      "git diff",
      "npm test",
      "pnpm test",
      "cargo test",
      "pytest",
      "npm run dev",
      "pnpm dev",
      "vite",
      "python -m http.server",
      "rg",
      "ls",
      "dir"
    ])
  ) {
    return "safe";
  }
  return "medium";
}

function hasDangerousPattern(command: string) {
  return (
    command.includes("rm -rf") ||
    command.includes("del /s") ||
    command.includes("format ") ||
    (command.includes("curl ") && command.includes("|") && command.includes("sh")) ||
    (command.includes("invoke-webrequest") && command.includes("|") && command.includes("iex")) ||
    command.includes("set-executionpolicy")
  );
}

function startsWithAny(command: string, prefixes: string[]) {
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

function referencesOutsideWorkspace(command: string, workspacePath: string) {
  const workspace = path.resolve(workspacePath);
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["',;]$/g, ""))
    .some((token) => {
      if (token.startsWith("..")) return true;
      if (!path.isAbsolute(token)) return false;
      return !path.resolve(token).startsWith(workspace);
    });
}
