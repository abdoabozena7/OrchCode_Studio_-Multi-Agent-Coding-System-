import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@orchcode/protocol";
import { loadConfig } from "../config.js";
import {
  buildLargeProjectExplainReport,
  formatProjectExplainReportForChat
} from "../runtime/LargeProjectContextBuilder.js";
import { buildServer } from "../server.js";

test("large project explain report clusters modules and ignores vendor/build folders", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-large-explain-${Date.now()}`);
  await mkdir(path.join(workspace, "apps", "web", "src"), { recursive: true });
  await mkdir(path.join(workspace, "packages", "core", "src"), { recursive: true });
  await mkdir(path.join(workspace, "apps", "api", "src", "features"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules", "ignored"), { recursive: true });
  await mkdir(path.join(workspace, "dist"), { recursive: true });

  try {
    await writeFile(path.join(workspace, "README.md"), "# Large fixture\n\nExplains the fixture.\n", "utf8");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "large-fixture", workspaces: ["apps/*", "packages/*"], scripts: { test: "npm test" } }, null, 2),
      "utf8"
    );
    await writeFile(path.join(workspace, "apps", "web", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
    await writeFile(path.join(workspace, "packages", "core", "src", "index.ts"), "export const core = true;\n", "utf8");
    await writeFile(path.join(workspace, "packages", "core", "src", "index.test.ts"), "import { core } from './index';\n", "utf8");
    await writeFile(path.join(workspace, "node_modules", "ignored", "index.js"), "module.exports = {}\n", "utf8");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "console.log('generated')\n", "utf8");
    for (let index = 0; index < 1005; index += 1) {
      await writeFile(
        path.join(workspace, "apps", "api", "src", "features", `feature-${index}.ts`),
        `export const feature${index} = ${index};\n`,
        "utf8"
      );
    }

    const projectMap: ProjectMap = {
      stack: ["TypeScript"],
      packageManagers: ["npm"],
      testCommands: ["npm test"],
      entryPoints: ["apps/web/src/App.tsx"],
      importantFiles: ["package.json", "apps/web/src/App.tsx", "packages/core/src/index.ts"]
    };
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "explain this project",
      projectMap
    });

    assert.ok(report.contextPack.inventory.scannedFiles > 1000);
    assert.ok(report.contextPack.inventory.ignoredDirectories.includes("node_modules"));
    assert.ok(report.contextPack.inventory.ignoredDirectories.includes("dist"));
    assert.ok(report.moduleMap.some((module) => module.root === "apps/web"));
    assert.ok(report.moduleMap.some((module) => module.root === "packages/core"));
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("node_modules")), false);
    assert.equal(report.contextPack.sampledFiles.some((file) => file.path.includes("dist/")), false);
    assert.ok(report.sections.length > 0);
    assert.ok(report.sections.every((section) => section.lineStart > 0 && section.snippet.length > 0));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("static explain report emits line refs, snippets, and ignores agent proposals by default", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-static-explain-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  try {
    await writeFile(path.join(workspace, "AGENT_PROPOSAL.md"), "# Agent Proposal\n\nInternal agent note.\n", "utf8");
    await writeFile(
      path.join(workspace, "index.html"),
      [
        "<!doctype html>",
        "<html>",
        "  <body>",
        "    <canvas id=\"scene\"></canvas>",
        "    <script type=\"module\" src=\"./main.js\"></script>",
        "  </body>",
        "</html>"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "main.js"),
      [
        "import * as THREE from \"three\";",
        "",
        "const canvas = document.getElementById(\"scene\");",
        "",
        "function animate() {",
        "  requestAnimationFrame(animate);",
        "}",
        "",
        "window.addEventListener(\"keydown\", () => {});"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(workspace, "styles.css"),
      [
        ":root { color-scheme: dark; }",
        "#scene { width: 100%; }"
      ].join("\n"),
      "utf8"
    );

    const projectMap: ProjectMap = {
      stack: ["HTML", "JavaScript", "CSS"],
      packageManagers: [],
      testCommands: [],
      entryPoints: ["index.html", "main.js"],
      importantFiles: ["index.html", "main.js", "styles.css", "AGENT_PROPOSAL.md"]
    };
    const report = buildLargeProjectExplainReport({
      workspacePath: workspace,
      message: "اشرح المشروع",
      projectMap
    });
    const chat = formatProjectExplainReportForChat(report, "اشرح المشروع");

    assert.equal(report.importantFiles.includes("AGENT_PROPOSAL.md"), false);
    assert.ok(report.sections.some((section) => section.filePath === "index.html" && section.lineStart === 5));
    assert.ok(report.sections.some((section) => section.filePath === "main.js" && section.title === "DOM wiring"));
    assert.ok(report.sections.some((section) => section.filePath === "styles.css" && section.lineStart === 1));
    assert.match(chat, /شرح الكود بالسطر/);
    assert.match(chat, /المشروع ده عبارة عن/);
    assert.match(chat, /المعنى العملي/);
    assert.match(chat, /\[index\.html:5\]\(orchcode-file:index\.html:5\)/);
    assert.match(chat, /```html/i);
    assert.doesNotMatch(chat, /AGENT_PROPOSAL/);
    assert.doesNotMatch(chat, /Completed|Verification passed/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runtime explain creates a chat report without patches or commands", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-runtime-explain-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-runtime-explain-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "apps", "desktop", "src"), { recursive: true });
  await mkdir(path.join(workspace, "packages", "protocol", "src"), { recursive: true });

  try {
    await writeFile(path.join(workspace, "README.md"), "# Runtime explain fixture\n", "utf8");
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "runtime-explain", workspaces: ["apps/*", "packages/*"], scripts: { dev: "vite", test: "vitest" } }, null, 2),
      "utf8"
    );
    await writeFile(path.join(workspace, "apps", "desktop", "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
    await writeFile(path.join(workspace, "packages", "protocol", "src", "index.ts"), "export type Protocol = { ok: true };\n", "utf8");

    const { runtime, app } = await buildServer({ ...loadConfig(), storageDir });
    try {
      const created = await runtime.createSession({
        workspacePath: workspace,
        mode: "demo_mock",
        userPrompt: "اشرح المشروع ده"
      });
      await runtime.runTurn(created.sessionId, "اشرح المشروع ده");
      const session = runtime.getSession(created.sessionId);
      const assistantMessage = session?.messages.filter((message) => message.role === "assistant").at(-1)?.content ?? "";

      assert.equal(session?.runMode, "inspect_only");
      assert.equal(session?.patchProposals.length, 0);
      assert.equal(session?.commandRequests.length, 0);
      assert.ok(session?.explainReport);
      assert.ok(session?.explainReport?.moduleMap.some((module) => module.root === "apps/desktop"));
      assert.ok(session?.explainReport?.moduleMap.some((module) => module.root === "packages/protocol"));
      assert.ok(session?.artifacts.some((artifact) => artifact.type === "project_explain_report"));
      assert.ok(session?.explainReport?.sections.some((section) => section.lineStart > 0 && section.snippet.length > 0));
      assert.match(assistantMessage, /شرح الكود بالسطر/);
      assert.match(assistantMessage, /المشروع ده عبارة عن/);
      assert.match(assistantMessage, /المعنى العملي/);
      assert.match(assistantMessage, /orchcode-file:/);
      assert.match(assistantMessage, /```/);
      assert.match(assistantMessage, /apps\/desktop/);
      assert.doesNotMatch(assistantMessage, /Completed|Verification passed/);
    } finally {
      await app.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  }
});
