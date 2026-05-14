import fs from "node:fs";
import path from "node:path";
import type { WorkerCapabilityGrant } from "@orchcode/protocol";
import { assertGrantAllowsTool, isSecretCandidate, resolveInsideWorkspace, shouldIgnore } from "./security.js";

export type WorkspaceFileEntry = {
  path: string;
  isDir: boolean;
  isSecretCandidate: boolean;
};

export class WorkspaceTools {
  constructor(private readonly workspacePath: string, private readonly grant?: WorkerCapabilityGrant) {}

  listFiles(limit = 240): WorkspaceFileEntry[] {
    assertGrantAllowsTool(this.grant, "workspace.list_files");
    return this.collectFiles(limit);
  }

  readFile(relativePath: string) {
    assertGrantAllowsTool(this.grant, "workspace.read_file");
    this.assertPathAllowed(relativePath);
    const filePath = resolveInsideWorkspace(this.workspacePath, relativePath);
    if (isSecretCandidate(filePath)) {
      throw new Error("Secret-like files are blocked");
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error("Path is not a file");
    }
    return fs.readFileSync(filePath, "utf8").slice(0, 80_000);
  }

  readWholeFile(relativePath: string) {
    assertGrantAllowsTool(this.grant, "workspace.read_file");
    this.assertPathAllowed(relativePath);
    const filePath = resolveInsideWorkspace(this.workspacePath, relativePath);
    if (isSecretCandidate(filePath)) {
      throw new Error("Secret-like files are blocked");
    }
    if (!fs.existsSync(filePath)) {
      throw new Error("Path does not exist");
    }
    if (!fs.statSync(filePath).isFile()) {
      throw new Error("Path is not a file");
    }
    return fs.readFileSync(filePath, "utf8");
  }

  fileExists(relativePath: string) {
    try {
      const filePath = resolveInsideWorkspace(this.workspacePath, relativePath);
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  writeFile(relativePath: string, content: string) {
    void relativePath;
    void content;
    throw new Error("Runtime file writes are disabled; propose a patch intent for Rust authority.");
  }

  deleteFile(relativePath: string) {
    void relativePath;
    throw new Error("Runtime file deletes are disabled; propose a patch intent for Rust authority.");
  }

  searchCode(query: string, limit = 50) {
    assertGrantAllowsTool(this.grant, "workspace.search_code");
    const matches: Array<{ path: string; line: number; preview: string }> = [];
    const lowerQuery = query.toLowerCase();
    const files = this.collectFiles(500);
    for (const file of files.filter((entry) => !entry.isDir && !entry.isSecretCandidate)) {
      if (matches.length >= limit) break;
      if (!isTextLike(file.path)) continue;
      try {
        const content = this.readFile(file.path);
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (matches.length < limit && line.toLowerCase().includes(lowerQuery)) {
            matches.push({ path: file.path, line: index + 1, preview: line.trim().slice(0, 180) });
          }
        });
      } catch {
        // Ignore unreadable files in the temporary Node-side scanner.
      }
    }
    return matches;
  }

  getProjectSummary() {
    const files = this.listFiles(500);
    const languages: Record<string, number> = {};
    const importantFiles = files
      .filter((file) => !file.isDir && isImportant(file.path))
      .map((file) => file.path);
    for (const file of files) {
      if (!file.isDir) {
        const language = languageForPath(file.path);
        if (language) languages[language] = (languages[language] ?? 0) + 1;
      }
    }
    const packageManagers = [
      importantFiles.includes("pnpm-lock.yaml") ? "pnpm" : undefined,
      importantFiles.includes("package-lock.json") || importantFiles.includes("package.json") ? "npm" : undefined,
      importantFiles.includes("Cargo.toml") ? "cargo" : undefined
    ].filter(Boolean) as string[];
    const testCommands = [
      packageManagers.includes("pnpm") ? "pnpm test" : undefined,
      packageManagers.includes("npm") && !packageManagers.includes("pnpm") ? "npm test" : undefined,
      packageManagers.includes("cargo") ? "cargo test" : undefined,
      languages.Python ? "pytest" : undefined
    ].filter(Boolean) as string[];
    return { languages, importantFiles, packageManagers, testCommands };
  }

  private walk(current: string, results: WorkspaceFileEntry[], limit: number) {
    if (results.length >= limit || shouldIgnore(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (results.length >= limit) return;
      const fullPath = path.join(current, entry.name);
      if (shouldIgnore(fullPath)) continue;
      const relative = path.relative(this.workspacePath, fullPath).replaceAll("\\", "/");
      results.push({
        path: relative,
        isDir: entry.isDirectory(),
        isSecretCandidate: isSecretCandidate(fullPath)
      });
      if (entry.isDirectory()) this.walk(fullPath, results, limit);
    }
  }

  private collectFiles(limit: number) {
    const root = resolveInsideWorkspace(this.workspacePath);
    const results: WorkspaceFileEntry[] = [];
    this.walk(root, results, limit);
    return results;
  }

  private assertPathAllowed(relativePath: string) {
    if (!this.grant) return;
    if (!this.grant.allowedPaths.length) return;
    const normalized = relativePath.replaceAll("\\", "/");
    const allowed = this.grant.allowedPaths.some((allowedPath) => {
      const allowedNormalized = allowedPath.replaceAll("\\", "/");
      return normalized === allowedNormalized || normalized.startsWith(`${allowedNormalized.replace(/\/$/, "")}/`);
    });
    if (!allowed) throw new Error(`Capability grant does not allow path: ${relativePath}`);
  }
}

function isTextLike(filePath: string) {
  return /\.(ts|tsx|js|jsx|rs|py|go|java|cs|css|html|md|json|toml|yaml|yml)$/i.test(filePath);
}

function isImportant(filePath: string) {
  return [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "Cargo.toml",
    "pyproject.toml",
    "README.md",
    "tsconfig.json",
    "vite.config.ts",
    "tauri.conf.json"
  ].includes(path.basename(filePath));
}

function languageForPath(filePath: string) {
  const ext = path.extname(filePath);
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".rs": "Rust",
    ".py": "Python",
    ".css": "CSS",
    ".md": "Markdown"
  };
  return map[ext];
}
