import fs from "node:fs";
import path from "node:path";

export const ignoredDirectories = new Set(["node_modules", "target", "dist", "build", ".git", ".vite"]);

export function resolveInsideWorkspace(workspacePath: string, requestedPath = ".") {
  const workspace = fs.realpathSync(workspacePath);
  const candidate = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.join(workspace, requestedPath);
  const normalized = path.resolve(candidate);
  if (!normalized.startsWith(workspace)) {
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
