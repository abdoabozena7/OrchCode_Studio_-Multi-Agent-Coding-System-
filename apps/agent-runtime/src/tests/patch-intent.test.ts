import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProjectMap } from "@orchcode/protocol";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { EventBus } from "../runtime/EventBus.js";
import { RunEngine } from "../runtime/RunEngine.js";
import { SessionManager } from "../runtime/SessionManager.js";

test("existing-file edits use patch intents and generate focused reviewable diffs", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-patch-intent-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-intent-storage-${Date.now()}`);
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

  const session = await runTurnWithProvider(workspace, storageDir, provider, "update App.tsx color");
  const proposal = session.patchProposals[0];

  assert.ok(proposal);
  assert.equal(proposal?.filesChanged[0]?.changeType, "modify");
  assert.match(proposal?.unifiedDiff ?? "", /diff --git a\/src\/App\.tsx b\/src\/App\.tsx/);
  assert.match(proposal?.unifiedDiff ?? "", /@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.match(proposal?.unifiedDiff ?? "", /-  const color = "red";/);
  assert.match(proposal?.unifiedDiff ?? "", /\+  const color = "blue";/);
  assert.doesNotMatch(proposal?.unifiedDiff ?? "", /console\.log\("tail line"\);/);
  assert.equal(provider.prompts.some((prompt) => prompt.includes("do not return full file contents")), true);

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("malformed patch intents are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-patch-malformed-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-malformed-storage-${Date.now()}`);
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

  await assert.rejects(
    () => runTurnWithProvider(workspace, storageDir, provider, "break the patch intent"),
    /Patch intent validation failed/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("missing anchors are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-patch-missing-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-missing-storage-${Date.now()}`);
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
    () => runTurnWithProvider(workspace, storageDir, provider, "replace a missing anchor"),
    /anchor was not found/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("ambiguous anchors are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-patch-ambiguous-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-ambiguous-storage-${Date.now()}`);
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
    () => runTurnWithProvider(workspace, storageDir, provider, "replace an ambiguous anchor"),
    /anchor is ambiguous/
  );

  await rm(workspace, { recursive: true, force: true });
  await rm(storageDir, { recursive: true, force: true });
});

test("outside-workspace patch intents are rejected", async () => {
  const workspace = path.join(os.tmpdir(), `orchcode-patch-outside-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-outside-storage-${Date.now()}`);
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
  const workspace = path.join(os.tmpdir(), `orchcode-patch-create-${Date.now()}`);
  const storageDir = path.join(os.tmpdir(), `orchcode-patch-create-storage-${Date.now()}`);
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
  importantFiles: string[] = ["src/App.tsx"]
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
    projectMap: createProjectMap(importantFiles)
  });
  return sessionManager.getSession(session.id)!;
}

function createProjectMap(importantFiles: string[]): ProjectMap {
  return {
    stack: ["TypeScript"],
    packageManagers: ["npm"],
    testCommands: ["npm test"],
    entryPoints: importantFiles,
    importantFiles
  };
}
