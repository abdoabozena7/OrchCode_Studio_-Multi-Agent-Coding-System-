import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@hivo/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { RunEngine } from "../runtime/RunEngine.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("existing-file edits use patch intents and generate focused reviewable diffs", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-intent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-intent-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "package.json"), '{"scripts":{"test":"echo ok"}}\n', "utf8");
  await writeFile(
    path.join(workspace, "src", "App.tsx"),
    [
      "export function App() {",
      '  const title = "alpha";',
      '  const color = "red";',
      '  const subtitle = "stable";',
      '  const body = `${title}-${color}`;',
      "  return body;",
      "}",
      'console.log("tail line");',
      ""
    ].join("\n"),
    "utf8"
  );

  const provider = new PatchIntentProvider({
    targetFiles: ["src/App.tsx"],
    patchOutput: {
      title: "Update App color",
      summary: "Switch color constant safely.",
      intents: [
        {
          path: "src/App.tsx",
          operation: "replace_range",
          preimageText: '  const color = "red";',
          replacementText: '  const color = "blue";',
          reason: "Update the displayed color.",
          risk: "low"
        }
      ],
      suggestedCommands: [{ command: "npm test", reason: "Validate the proposal." }]
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "هاي update App.tsx color");
  const proposal = session.patchProposals[0];

  assert.ok(proposal);
  assert.equal(proposal?.filesChanged[0]?.changeType, "modify");
  assert.match(proposal?.unifiedDiff ?? "", /diff --git a\/src\/App\.tsx b\/src\/App\.tsx/);
  assert.match(proposal?.unifiedDiff ?? "", /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(proposal?.unifiedDiff ?? "", /-  const color = "red";/);
  assert.match(proposal?.unifiedDiff ?? "", /\+  const color = "blue";/);
  assert.doesNotMatch(proposal?.unifiedDiff ?? "", /console\.log\("tail line"\);/);
  assert.equal(provider.prompts.some((prompt) => prompt.includes("do not return full file contents")), true);
  assert.equal(provider.prompts.every((prompt) => !prompt.includes("هاي")), true);
  assert.equal(provider.prompts.some((prompt) => prompt.includes("update App.tsx color")), true);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("direct social turns bypass workspace intake and provider even when files match", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-direct-intent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-direct-intent-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "hay.ts"), "export const value = 'هاي';\n", "utf8");

  const provider = new PatchIntentProvider({
    targetFiles: ["src/hay.ts"],
    patchOutput: {
      title: "Should not run",
      summary: "Direct conversation should bypass provider.",
      intents: []
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "هاي", ["src/hay.ts"]);
  const answer = session.messages.at(-1)?.content ?? "";

  assert.equal(session.status, "completed");
  assert.equal(provider.prompts.length, 0);
  assert.equal(session.artifacts.some((artifact) => artifact.type === "project_intake"), false);
  assert.equal(session.artifacts.some((artifact) => artifact.type === "project_explain_report"), false);
  assert.equal(session.progressEvents.some((event) => /قراءة المشروع|Workspace snapshot/.test(event.taskTitle ?? "")), false);
  assert.doesNotMatch(answer, /Workspace used for this answer|لقيت|src\/hay\.ts/i);
  assert.match(answer, /أهل|موجود/);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("malformed broad patch intents fail with a chat explanation instead of creating AGENT_PROPOSAL", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-malformed-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-malformed-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "App.tsx"), "export const value = 1;\n", "utf8");

  const provider = new PatchIntentProvider({
    targetFiles: ["src/App.tsx"],
    patchOutput: {
      title: "Broken intent",
      summary: "Missing required operation.",
      intents: [
        {
          path: "src/App.tsx",
          replacementText: "export const value = 2;\n",
          reason: "Broken test fixture.",
          risk: "low"
        }
      ]
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "break the patch intent in src/App.tsx");
  assert.equal(session.status, "failed");
  assert.ok(session.reasoningSummaries.includes("Provider patch output was invalid; no deterministic implementation was invented."));
  assert.equal(session.patchProposals.length, 0);
  assert.match(session.messages.at(-1)?.content ?? "", /could not produce a file change/i);
  assert.doesNotMatch(session.messages.at(-1)?.content ?? "", /AGENT_PROPOSAL/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("malformed simple file requests fall back to the requested file instead of AGENT_PROPOSAL", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-simple-file-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-simple-file-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const provider = new PatchIntentProvider({
    targetFiles: ["hello.txt"],
    patchOutput: {
      title: "Broken intent",
      summary: "Missing required operation.",
      intents: [{ path: "hello.txt", reason: "Broken test fixture." }]
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "اكتب ملف hello.txt فيه hello");
  const proposal = session.patchProposals[0];
  assert.equal(session.status, "needs_approval");
  assert.equal(proposal?.filesChanged[0]?.path, "hello.txt");
  assert.match(proposal?.unifiedDiff ?? "", /\+hello/);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("single-file pygame provider failures do not invent deterministic implementations", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-pygame-fallback-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-pygame-fallback-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const provider = new PatchIntentProvider({
    targetFiles: ["main.py"],
    patchOutput: {
      title: "Broken intent",
      summary: "Invalid structured patch output.",
      intents: [{ path: "main.py", reason: "broken" }]
    }
  });

  const session = await runTurnWithProvider(
    workspace,
    storageDir,
    provider,
    "make a one python code for a 3d snake game with pygame",
    {
      stack: ["Python"],
      packageManagers: [],
      testCommands: ["python main.py"],
      importantFiles: []
    }
  );

  assert.equal(session.status, "failed");
  assert.ok(session.reasoningSummaries.includes("Provider patch output was invalid; no deterministic implementation was invented."));
  assert.equal(session.patchProposals.length, 0);
  assert.equal(session.commandRequests.length, 0);
  assert.match(session.messages.at(-1)?.content ?? "", /could not produce a file change/i);
  assert.doesNotMatch(session.messages.at(-1)?.content ?? "", /pygame|snake|import pygame/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("empty provider patch envelopes fail instead of creating demo scaffold", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-empty-patch-envelope-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-empty-patch-envelope-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const provider = new PatchIntentProvider({
    targetFiles: ["demo/src/main.js"],
    patchOutput: {
      title: "Empty patch",
      summary: "No edits were returned.",
      intents: []
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "create a tiny vite demo project", {
    stack: [],
    packageManagers: [],
    testCommands: [],
    importantFiles: []
  });

  assert.equal(session.status, "failed");
  assert.equal(session.patchProposals.length, 0);
  assert.ok(session.reasoningSummaries.includes("Provider patch output was invalid; no deterministic implementation was invented."));
  assert.doesNotMatch(session.messages.at(-1)?.content ?? "", /starter project|scaffold|vite/i);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("missing anchors are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-missing-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-missing-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "App.tsx"), "export const value = 1;\n", "utf8");

  const provider = new PatchIntentProvider({
    targetFiles: ["src/App.tsx"],
    patchOutput: {
      title: "Missing anchor",
      summary: "Anchor does not exist.",
      intents: [
        {
          path: "src/App.tsx",
          operation: "replace_range",
          preimageText: "export const value = 9;",
          replacementText: "export const value = 2;",
          reason: "Replace a missing line.",
          risk: "low"
        }
      ]
    }
  });

  await assert.rejects(
    () => runTurnWithProvider(workspace, storageDir, provider, "replace a missing anchor in src/App.tsx"),
    /anchor was not found/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("ambiguous anchors are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-ambiguous-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-ambiguous-storage-${Date.now()}`);
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(workspace, "src", "App.tsx"),
    'export const value = "same";\nexport const next = "same";\n',
    "utf8"
  );

  const provider = new PatchIntentProvider({
    targetFiles: ["src/App.tsx"],
    patchOutput: {
      title: "Ambiguous anchor",
      summary: "Anchor appears twice.",
      intents: [
        {
          path: "src/App.tsx",
          operation: "replace_range",
          preimageText: '"same"',
          replacementText: '"unique"',
          reason: "Replace an ambiguous token.",
          risk: "low"
        }
      ]
    }
  });

  await assert.rejects(
    () => runTurnWithProvider(workspace, storageDir, provider, "replace an ambiguous anchor in src/App.tsx"),
    /anchor is ambiguous/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("outside-workspace patch intents are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-outside-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-outside-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });

  const provider = new PatchIntentProvider({
    targetFiles: ["../evil.txt"],
    patchOutput: {
      title: "Outside workspace",
      summary: "Should be blocked.",
      intents: [
        {
          path: "../evil.txt",
          operation: "create_file",
          replacementText: "bad\n",
          reason: "Illegal write.",
          risk: "high"
        }
      ]
    }
  });

  await assert.rejects(
    () => runTurnWithProvider(workspace, storageDir, provider, "write outside workspace"),
    /outside the workspace/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("file creation intents still work", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-create-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-create-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "README.md"), "root\n", "utf8");

  const provider = new PatchIntentProvider({
    targetFiles: ["docs/NEW_GUIDE.md"],
    patchOutput: {
      title: "Create guide",
      summary: "Adds a new guide file.",
      intents: [
        {
          path: "docs/NEW_GUIDE.md",
          operation: "create_file",
          replacementText: "# New Guide\n\nHello.\n",
          reason: "Add the requested guide file.",
          risk: "low"
        }
      ]
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "create a new guide file", ["docs/NEW_GUIDE.md"]);
  const proposal = session.patchProposals[0];

  assert.ok(proposal);
  assert.equal(proposal?.filesChanged[0]?.changeType, "create");
  assert.match(proposal?.unifiedDiff ?? "", /new file mode 100644/);
  assert.match(proposal?.unifiedDiff ?? "", /\+\# New Guide/);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("overwrite file intents generate whole-file replacement diffs", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-overwrite-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-overwrite-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "notes.txt"), "old\n", "utf8");

  const provider = new PatchIntentProvider({
    targetFiles: ["notes.txt"],
    patchOutput: {
      title: "Overwrite notes",
      summary: "Replace notes content.",
      intents: [
        {
          path: "notes.txt",
          operation: "overwrite_file",
          replacementText: "new\n",
          reason: "Replace the whole file.",
          risk: "low"
        }
      ]
    }
  });

  const session = await runTurnWithProvider(workspace, storageDir, provider, "replace notes.txt");
  const diff = session.patchProposals[0]?.unifiedDiff ?? "";
  assert.match(diff, /-old/);
  assert.match(diff, /\+new/);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("insert and delete patch intents generate focused diffs", async () => {
  const workspace = path.join(os.tmpdir(), `hivo-patch-ops-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `hivo-patch-ops-storage-${Date.now()}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "list.txt"), "one\ntwo\nremove\n", "utf8");

  const insertAfter = await runTurnWithProvider(
    workspace,
    `${storageDir}-after`,
    new PatchIntentProvider({
      targetFiles: ["list.txt"],
      patchOutput: {
        title: "Insert after",
        summary: "Insert after an anchor.",
        intents: [{
          path: "list.txt",
          operation: "insert_after",
          anchorText: "one\n",
          replacementText: "after-one\n",
          reason: "Add line after one.",
          risk: "low"
        }]
      }
    }),
    "insert after one in list.txt"
  );
  assert.match(insertAfter.patchProposals[0]?.unifiedDiff ?? "", /\+after-one/);

  const insertBefore = await runTurnWithProvider(
    workspace,
    `${storageDir}-before`,
    new PatchIntentProvider({
      targetFiles: ["list.txt"],
      patchOutput: {
        title: "Insert before",
        summary: "Insert before an anchor.",
        intents: [{
          path: "list.txt",
          operation: "insert_before",
          anchorText: "two",
          replacementText: "before-two\n",
          reason: "Add line before two.",
          risk: "low"
        }]
      }
    }),
    "insert before two in list.txt"
  );
  assert.match(insertBefore.patchProposals[0]?.unifiedDiff ?? "", /\+before-two/);

  const deleteRange = await runTurnWithProvider(
    workspace,
    `${storageDir}-delete`,
    new PatchIntentProvider({
      targetFiles: ["list.txt"],
      patchOutput: {
        title: "Delete range",
        summary: "Delete an anchored range.",
        intents: [{
          path: "list.txt",
          operation: "delete_range",
          anchorText: "remove\n",
          replacementText: "",
          reason: "Remove the target line.",
          risk: "low"
        }]
      }
    }),
    "delete remove line in list.txt"
  );
  assert.match(deleteRange.patchProposals[0]?.unifiedDiff ?? "", /-remove/);

  await rm(workspace, { recursive: true, force: true });
  await rm(`${storageDir}-after`, { recursive: true, force: true });
  await rm(`${storageDir}-before`, { recursive: true, force: true });
  await rm(`${storageDir}-delete`, { recursive: true, force: true });
});

type PatchIntentProviderConfig = {
  targetFiles: string[];
  patchOutput: unknown;
};

class PatchIntentProvider implements LlmProvider {
  readonly prompts: string[] = [];

  constructor(private readonly config: PatchIntentProviderConfig) {}

  async generateStructured<T>(input: LlmRequest, schema: unknown): Promise<T> {
    this.prompts.push(input.userPrompt);
    const schemaName = typeof schema === "object" && schema && "name" in schema ? String((schema as { name: string }).name) : "";
    if (schemaName === "run-plan") {
      return {
        summary: "Patch intent plan",
        reasoningSummary: "Use exact anchors for safe edits.",
        mode: "edit_project",
        tasks: [
          {
            title: "Prepare safe edit",
            objective: "Apply the requested change with exact anchors.",
            roleTitle: "Implementation Worker",
            targetFiles: this.config.targetFiles
          }
        ],
        acceptanceCriteria: ["Changes are reviewable before apply."],
        risks: []
      } as T;
    }
    if (schemaName === "run-patch-intent") {
      return this.config.patchOutput as T;
    }
    throw new Error(`Unexpected schema request: ${schemaName}`);
  }

  async generateText(): Promise<string> {
    return "";
  }
}

async function runTurnWithProvider(
  workspace: string,
  storageDir: string,
  provider: PatchIntentProvider,
  message: string,
  projectMapInput: string[] | ProjectMapFixture = ["src/App.tsx"]
) {
  const sessionManager = new SessionManager(storageDir, new EventBus());
  await sessionManager.load();
  const session = await sessionManager.createSession({
    workspacePath: workspace,
    mode: "real_provider",
    userPrompt: message
  });
  await new RunEngine(provider, sessionManager).runTurn(session.id, message, {
    resolvedMode: "simple_mode",
    projectMap: createProjectMap(projectMapInput)
  });
  return sessionManager.getSession(session.id)!;
}

type ProjectMapFixture = {
  stack?: string[];
  packageManagers?: string[];
  testCommands?: string[];
  importantFiles: string[];
};

function createProjectMap(projectMapInput: string[] | ProjectMapFixture): ProjectMap {
  const fixture = Array.isArray(projectMapInput)
    ? { importantFiles: projectMapInput }
    : projectMapInput;
  return {
    stack: fixture.stack ?? ["TypeScript"],
    packageManagers: fixture.packageManagers ?? ["npm"],
    testCommands: fixture.testCommands ?? ["npm test"],
    entryPoints: fixture.importantFiles,
    importantFiles: fixture.importantFiles
  };
}
