import fs from "node:fs";
import path from "node:path";
import type { WorkerCapabilityGrant } from "@orchcode/protocol";

export const ignoredDirectories = new Set([
  ".cache",
  ".coverage",
  ".eggs",
  ".git",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".playwright-cli",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
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
  "venv"
]);

export function resolveInsideWorkspace(workspacePath: string, requestedPath = ".") {
  const workspace = fs.realpathSync(workspacePath);
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.join(workspace, requestedPath);
  const normalized = path.resolve(candidate);
  const relative = path.relative(workspace, normalized);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the active workspace");
  }
  return normalized;
}

export function isSecretCandidate(filePath: string) {
  const basename = path.basename(filePath).toLowerCase();
  return (
    basename === ".env" ||
    basename.endsWith(".pem") ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename === "credentials.json"
  );
}

export function shouldIgnore(filePath: string) {
  return filePath.split(path.sep).some((part) => ignoredDirectories.has(part));
}

export function assertGrantAllowsTool(grant: WorkerCapabilityGrant | undefined, toolName: string) {
  if (!grant) return;
  if (Date.parse(grant.expiresAt) <= Date.now()) {
    throw new Error("Capability grant expired");
  }
  if (!grant.allowedTools.includes(toolName)) {
    throw new Error(`Capability grant does not allow tool: ${toolName}`);
  }
}
