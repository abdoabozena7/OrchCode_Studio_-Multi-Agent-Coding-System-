import path from "node:path";
import type { CommandRisk } from "@hivo/protocol";

export function classifyCommandRisk(command: string, workspacePath: string): CommandRisk {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return "dangerous";
  if (hasDangerousPattern(normalized) || referencesOutsideWorkspace(command, workspacePath)) {
    return "dangerous";
  }
  if (
    startsWithAny(normalized, [
      "npm install",
      "npm i",
      "npm run dev",
      "npm run start",
      "pnpm add",
      "pnpm install",
      "pnpm dev",
      "pnpm start",
      "yarn add",
      "yarn install",
      "yarn dev",
      "yarn start",
      "cargo add",
      "cargo install",
      "git checkout",
      "git merge",
      "git rebase",
      "git reset"
    ]) ||
    containsShellChain(normalized) ||
    looksLikeNetworkCommand(normalized) ||
    looksLikeBackgroundCommand(normalized)
  ) {
    return "medium";
  }
  if (
    startsWithAny(normalized, [
      "git status",
      "git diff",
      "npm test",
      "npm run test",
      "npm run build",
      "npm run typecheck",
      "pnpm test",
      "pnpm run test",
      "pnpm run build",
      "pnpm run typecheck",
      "cargo test",
      "cargo check",
      "python -m pytest",
      "node -e",
      "tsc --noemit",
      "eslint",
      "pytest",
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
    command.includes("rmdir /s") ||
    command.includes("del /s") ||
    command.includes("format ") ||
    command.includes("git push") ||
    command.includes("git reset --hard") ||
    (command.includes("curl ") && command.includes("|") && command.includes("sh")) ||
    (command.includes("invoke-webrequest") && command.includes("|") && command.includes("iex")) ||
    command.includes("set-executionpolicy") ||
    command.includes("sudo ") ||
    command.includes("runas ") ||
    command.includes("-verb runas")
  );
}

function startsWithAny(command: string, prefixes: string[]) {
  return prefixes.some((prefix) => command === prefix || command.startsWith(`${prefix} `));
}

export function looksLikeNetworkCommand(command: string) {
  return [
    "curl",
    "wget",
    "invoke-webrequest",
    "iwr ",
    "irm ",
    "npm install",
    "pnpm add",
    "pnpm install",
    "pip install",
    "cargo install"
  ].some((needle) => command.includes(needle));
}

export function looksLikeBackgroundCommand(command: string) {
  return [
    "python -m http.server",
    "npm run dev",
    "npm run start",
    "pnpm dev",
    "pnpm start",
    "yarn dev",
    "yarn start",
    "yarn dev",
    "vite",
    "next dev",
    "react-scripts start"
  ].some((needle) => command.includes(needle));
}

function containsShellChain(command: string) {
  return command.includes("&&")
    || command.includes("||")
    || command.includes(";")
    || (command.includes("|") && !command.includes("| sh") && !command.includes("| iex"));
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
