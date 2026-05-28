import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendDecision,
  appendRunHistory,
  getRelevantFiles,
  readJsonl,
  rebuildRepoIndex,
  resolveMemoryPaths
} from "../memory/index.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { DecisionRecord, TaskHistoryRecord } from "../memory/types.js";

test("repository indexer creates memory files and ignores generated/vendor directories", async () => {
  const workspace = await createFixtureWorkspace("hivo-memory-index");
  try {
    const snapshot = await rebuildRepoIndex(workspace, { now: fixedNow });
    const memoryPaths = resolveMemoryPaths(workspace);

    assert.equal(existsSync(memoryPaths.repoIndex), true);
    assert.equal(existsSync(memoryPaths.fileManifest), true);
    assert.equal(existsSync(memoryPaths.symbolIndex), true);
    assert.equal(existsSync(memoryPaths.fileSummaries), true);
    assert.equal(existsSync(memoryPaths.commandInventory), true);
    assert.equal(existsSync(memoryPaths.decisions), true);
    assert.equal(existsSync(memoryPaths.taskHistory), true);

    const indexedPaths = snapshot.fileManifest.map((file) => file.path);
    assert.equal(indexedPaths.some((file) => file.startsWith("node_modules/")), false);
    assert.equal(indexedPaths.some((file) => file.startsWith("dist/")), false);
    assert.equal(indexedPaths.some((file) => file.startsWith(".agent_memory/")), false);
    assert.ok(indexedPaths.includes("src/index.ts"));
    assert.ok(indexedPaths.includes("src/index.test.ts"));
    assert.ok(indexedPaths.includes("package.json"));
    assert.ok(indexedPaths.includes("docs/guide.md"));

    assert.ok(snapshot.repoIndex.sourceFiles.includes("src/index.ts"));
    assert.ok(snapshot.repoIndex.testFiles.includes("src/index.test.ts"));
    assert.ok(snapshot.repoIndex.configFiles.includes("package.json"));
    assert.ok(snapshot.repoIndex.docFiles.includes("docs/guide.md"));
    assert.ok(snapshot.repoIndex.entrypoints.includes("src/index.ts"));
    assert.ok(snapshot.repoIndex.ignoredDirectories.includes("node_modules"));
    assert.ok(snapshot.repoIndex.ignoredDirectories.includes("dist"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("command inventory detects package scripts and classifies validation commands", async () => {
  const workspace = await createFixtureWorkspace("hivo-memory-commands");
  try {
    const snapshot = await rebuildRepoIndex(workspace, { now: fixedNow });
    const commands = snapshot.commandInventory.commands;

    assert.ok(commands.some((command) => command.kind === "test" && command.command === "npm run test"));
    assert.ok(commands.some((command) => command.kind === "build" && command.command === "npm run build"));
    assert.ok(commands.some((command) => command.kind === "typecheck" && command.command === "npm run typecheck"));
    assert.ok(commands.some((command) => command.kind === "lint" && command.command === "npm run lint"));
    assert.ok(commands.some((command) => command.kind === "smoke" && command.command === "npm run smoke"));
    assert.ok(snapshot.commandInventory.packageManagers.includes("npm"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("memory append APIs and relevant-file lookup work from generated summaries", async () => {
  const workspace = await createFixtureWorkspace("hivo-memory-apis");
  try {
    await rebuildRepoIndex(workspace, { now: fixedNow });
    const decision = await appendDecision(workspace, {
      agent: "test",
      summary: "Keep memory file-backed in Phase 1.",
      relatedFiles: ["src/index.ts"],
      tags: ["phase-1"]
    });
    const history = await appendRunHistory(workspace, {
      task: "memory API test",
      status: "completed",
      summary: "Verified append-only JSONL records."
    });
    const memoryPaths = resolveMemoryPaths(workspace);
    const decisions = await readJsonl<DecisionRecord>(memoryPaths.decisions);
    const taskHistory = await readJsonl<TaskHistoryRecord>(memoryPaths.taskHistory);
    const relevant = await getRelevantFiles(workspace, "start helper");

    assert.equal(decisions.some((entry) => entry.id === decision.id), true);
    assert.equal(taskHistory.some((entry) => entry.id === history.id), true);
    assert.ok(relevant.some((entry) => entry.path === "src/index.ts"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("index rebuilds are repeatable for stable file metadata and do not break existing workspace tools", async () => {
  const workspace = await createFixtureWorkspace("hivo-memory-repeatable");
  try {
    const first = await rebuildRepoIndex(workspace, { now: fixedNow });
    const second = await rebuildRepoIndex(workspace, { now: fixedNow });
    assert.deepEqual(stableSnapshot(first), stableSnapshot(second));

    const registry = new ToolRegistry(workspace);
    assert.equal(registry.workspace.readFile("src/index.ts").includes("export function start"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createFixtureWorkspace(prefix: string) {
  const workspace = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await mkdir(path.join(workspace, "docs"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules", "left-pad"), { recursive: true });
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "fixture-agent-project",
    scripts: {
      test: "node --test dist/tests/*.test.js",
      build: "tsc -p tsconfig.json",
      typecheck: "tsc -p tsconfig.json --noEmit",
      lint: "eslint src",
      smoke: "node smoke.js",
      dev: "tsx watch src/index.ts"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }, null, 2), "utf8");
  await writeFile(path.join(workspace, "src", "helper.ts"), "export class Helper { value = 1; }\n", "utf8");
  await writeFile(path.join(workspace, "src", "index.ts"), [
    "import { Helper } from './helper.js';",
    "export function start() {",
    "  return new Helper().value;",
    "}"
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "src", "index.test.ts"), [
    "import { start } from './index.js';",
    "test('start', () => start());"
  ].join("\n"), "utf8");
  await writeFile(path.join(workspace, "docs", "guide.md"), "# Fixture Guide\n\nA small fixture project.\n", "utf8");
  await writeFile(path.join(workspace, "node_modules", "left-pad", "index.js"), "module.exports = () => null;\n", "utf8");
  await writeFile(path.join(workspace, "dist", "bundle.js"), "generated();\n", "utf8");
  await mkdir(path.join(workspace, ".agent_memory", "runs"), { recursive: true });
  await writeFile(path.join(workspace, ".agent_memory", "runs", "old.json"), "{}\n", "utf8");

  const packageText = await readFile(path.join(workspace, "package.json"), "utf8");
  assert.ok(packageText.includes("fixture-agent-project"));
  return workspace;
}

function stableSnapshot(snapshot: Awaited<ReturnType<typeof rebuildRepoIndex>>) {
  return {
    manifest: snapshot.fileManifest.map((file) => ({
      path: file.path,
      hashSha256: file.hashSha256,
      roles: file.roles
    })),
    symbols: snapshot.symbolIndex.symbols.map((symbol) => ({
      path: symbol.path,
      line: symbol.line,
      kind: symbol.kind,
      name: symbol.name,
      exported: symbol.exported
    })),
    commands: snapshot.commandInventory.commands.map((command) => ({
      id: command.id,
      kind: command.kind,
      command: command.command,
      cwd: command.cwd
    }))
  };
}

function fixedNow() {
  return new Date("2026-05-21T00:00:00.000Z");
}
