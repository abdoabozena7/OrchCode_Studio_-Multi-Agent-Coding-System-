import path from "node:path";
import type { PreviewRecommendation } from "@orchcode/protocol";
import type { WorkspaceTools } from "../tools/WorkspaceTools.js";

export type LaunchConfidence = "low" | "medium" | "high";

export type LaunchRecommendation = {
  strategy: "static_file" | "static_server" | "package_script";
  command?: string;
  background: boolean;
  preview: PreviewRecommendation;
  multipleTerminals: boolean;
  confidence: LaunchConfidence;
  reason: string;
};

export function inferProjectLaunch(workspacePath: string, workspace: WorkspaceTools): LaunchRecommendation | null {
  const indexHtmlPath = "index.html";
  if (workspace.fileExists(indexHtmlPath)) {
    const html = safeRead(workspace, indexHtmlPath);
    const moduleScript = /<script[^>]+type=["']module["']/i.test(html);
    const moduleImports =
      workspace.fileExists("main.js") && /\bimport\s+.+from\s+["'][^"']+["']/.test(safeRead(workspace, "main.js"));
    const needsHttp = moduleScript || moduleImports;
    if (needsHttp) {
      const port = pickPreviewPort(workspacePath);
      return {
        strategy: "static_server",
        command: `python -m http.server ${port}`,
        background: true,
        preview: {
          type: "url",
          target: `http://127.0.0.1:${port}/`,
          description: "Static browser preview",
          command: `python -m http.server ${port}`
        },
        multipleTerminals: false,
        confidence: "high",
        reason: "Found index.html plus ES module loading, so the safest preview is a local static server."
      };
    }

    return {
      strategy: "static_file",
      background: false,
      preview: {
        type: "file",
        target: indexHtmlPath,
        description: "Static file preview"
      },
      multipleTerminals: false,
      confidence: "medium",
      reason: "Found a standalone index.html that does not require module serving."
    };
  }

  if (workspace.fileExists("package.json")) {
    const manifest = parsePackageJson(safeRead(workspace, "package.json"));
    const scripts = manifest?.scripts ?? {};
    const packageManager = inferPackageManager(workspace);
    const runScript = pickScript(scripts);
    if (runScript) {
      const command =
        packageManager === "pnpm"
          ? runScript === "dev"
            ? "pnpm dev"
            : `pnpm ${runScript}`
          : runScript === "dev"
            ? "npm run dev"
            : `npm run ${runScript}`;
      return {
        strategy: "package_script",
        command,
        background: true,
        preview: {
          type: "url",
          target: inferDevUrl(scripts[runScript]),
          description: `Local ${runScript} server`,
          command
        },
        multipleTerminals: false,
        confidence: runScript === "dev" ? "high" : "medium",
        reason: `Found package.json with a ${runScript} script.`
      };
    }
  }

  return null;
}

function safeRead(workspace: WorkspaceTools, relativePath: string) {
  try {
    return workspace.readWholeFile(relativePath);
  } catch {
    return "";
  }
}

function parsePackageJson(raw: string): { scripts?: Record<string, string> } | null {
  try {
    return JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return null;
  }
}

function inferPackageManager(workspace: WorkspaceTools) {
  if (workspace.fileExists("pnpm-lock.yaml")) return "pnpm";
  return "npm";
}

function pickScript(scripts: Record<string, string>) {
  if (typeof scripts.dev === "string" && scripts.dev.trim()) return "dev";
  if (typeof scripts.start === "string" && scripts.start.trim()) return "start";
  return null;
}

function inferDevUrl(command: string | undefined) {
  if (!command) return "http://127.0.0.1:5173";
  const explicitPort = command.match(/--port(?:=|\s+)(\d{2,5})/i)?.[1];
  if (explicitPort) return `http://127.0.0.1:${explicitPort}`;
  if (/next dev/i.test(command)) return "http://127.0.0.1:3000";
  if (/vite|react-scripts|webpack serve|parcel/i.test(command)) return "http://127.0.0.1:5173";
  return "http://127.0.0.1:5173";
}

function pickPreviewPort(workspacePath: string) {
  let hash = 0;
  for (const char of workspacePath) {
    hash = (hash * 31 + char.charCodeAt(0)) % 200;
  }
  return 4300 + hash;
}
