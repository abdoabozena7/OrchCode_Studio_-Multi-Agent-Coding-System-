import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import { rebuildRepoIndex } from "../memory/RepoIndexer.js";
import { SqliteMemoryStore } from "../memory/SqliteMemoryStore.js";
import { classifyClarifications } from "../runtime/ClarificationPolicy.js";
import { runProjectUnderstandingKernel } from "../runtime/ProjectUnderstandingKernel.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";

test("semantic project model persists relationships and embeddings with freshness hashes", async () => {
  const fixture = await createFixture();
  try {
    await rebuildRepoIndex(fixture);
    const store = await SqliteMemoryStore.open({ workspacePath: fixture });
    const model = store.semanticProjectModel();
    assert.ok(model);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "import"), true);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "call"), true);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "ui_to_api"), true);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "storage"), true);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "produces"), true);
    assert.equal(model.relationships.some((relationship) => relationship.kind === "consumes"), true);
    assert.equal(model.nodes.some((node) => node.kind === "concept"), true);
    assert.equal(model.nodes.some((node) => node.kind === "data_field"), true);
    assert.ok(store.search("start save", { kinds: ["semantic_node"] }).length > 0);
    store.close();

    const provider = new UnderstandingProvider("supported");
    const result = await runProjectUnderstandingKernel({
      question: "How does start call save across the project?",
      provider,
      tools: new ToolRegistry(fixture),
      embeddingModel: "test-embedding",
      mode: "on"
    });
    assert.equal(result.decision, "ANSWER");
    assert.equal(result.claimLedger.allMaterialClaimsSupported, true);
    assert.equal(result.graphExpansionTrace.some((entry) => entry.includes("[call]")), true);

    const embedded = await SqliteMemoryStore.open({ workspacePath: fixture });
    assert.ok(embedded.semanticEmbeddings("test-embedding").length > 0);
    assert.ok(embedded.semanticEmbeddings("test-embedding").some((entry) => entry.nodeId === "file:src/a.ts"));
    assert.ok(embedded.semanticEmbeddings("test-embedding").some((entry) => entry.nodeId === "file:src/b.ts"));
    embedded.close();

    await writeFile(path.join(fixture, "src", "b.ts"), "export function save(value: string) { return value.trim(); }\n", "utf8");
    await rebuildRepoIndex(fixture);
    const refreshed = await SqliteMemoryStore.open({ workspacePath: fixture });
    assert.ok(refreshed.semanticEmbeddings("test-embedding").some((entry) => entry.nodeId === "file:src/a.ts"));
    assert.equal(refreshed.semanticEmbeddings("test-embedding").some((entry) => entry.nodeId === "file:src/b.ts"), false);
    refreshed.close();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("clarification policy separates user blockers from repository-discoverable facts", () => {
  const values = classifyClarifications({
    decomposition: {
      question: "question",
      concepts: [],
      requiredRelationships: [],
      ambiguities: ["Which intended business rule should win?"],
      expectedAnswerShape: "summary",
      language: "english"
    },
    missingFacts: ["The implementation route is not proven."]
  });
  assert.equal(values.some((entry) => entry.classification === "user_blocker"), true);
  assert.equal(values.some((entry) => entry.classification === "discoverable"), true);
  const arabic = classifyClarifications({
    decomposition: {
      question: "سؤال",
      concepts: [],
      requiredRelationships: [],
      ambiguities: ["ما السلوك المطلوب؟"],
      expectedAnswerShape: "summary",
      language: "arabic"
    },
    missingFacts: ["مسار التنفيذ غير مثبت."]
  });
  assert.equal(arabic.some((entry) => entry.classification === "user_blocker"), true);
  assert.equal(arabic.some((entry) => entry.classification === "discoverable"), true);
});

test("kernel produces FOLLOW_UP, ESCALATE, and REFUSE from unsupported material claims", async () => {
  const fixture = await createFixture();
  try {
    await rebuildRepoIndex(fixture);
    const tools = new ToolRegistry(fixture);
    const followUp = await runProjectUnderstandingKernel({
      question: "Explain the intended business rule.",
      provider: new UnderstandingProvider("user_blocker"),
      tools,
      embeddingModel: "test-embedding",
      mode: "on"
    });
    assert.equal(followUp.decision, "FOLLOW_UP");

    const escalate = await runProjectUnderstandingKernel({
      question: "Explain the missing implementation route.",
      provider: new UnderstandingProvider("unsupported"),
      tools,
      embeddingModel: "test-embedding",
      mode: "on"
    });
    assert.equal(escalate.decision, "ESCALATE");

    const refused = await runProjectUnderstandingKernel({
      question: "Explain the missing implementation route.",
      provider: new UnderstandingProvider("unsupported"),
      tools,
      embeddingModel: "test-embedding",
      mode: "on",
      escalate: async () => ({ reviews: ["Read-only review found no additional evidence."], providerCalls: 1 })
    });
    assert.equal(refused.escalationUsed, true);
    assert.equal(refused.decision, "REFUSE");
    assert.ok(refused.providerCalls <= 12);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("deep kernel fails explicitly without embeddings", async () => {
  const fixture = await createFixture();
  try {
    await rebuildRepoIndex(fixture);
    await assert.rejects(
      runProjectUnderstandingKernel({
        question: "How does start call save?",
        provider: new NoEmbeddingProvider(),
        tools: new ToolRegistry(fixture),
        mode: "on"
      }),
      /embedding_provider_required/
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

class UnderstandingProvider implements LlmProvider {
  constructor(private readonly behavior: "supported" | "unsupported" | "user_blocker") {}

  async generateStructured<T>(): Promise<T> {
    return {
      question: "question",
      concepts: ["start", "save"],
      requiredRelationships: [{ fromConcept: "start", toConcept: "save", required: true, rationale: "trace the call" }],
      ambiguities: this.behavior === "user_blocker" ? ["Which intended business rule should win?"] : [],
      expectedAnswerShape: "flow",
      language: "english"
    } as T;
  }

  async generateText(): Promise<string> {
    if (this.behavior === "supported") {
      return "The start function calls save through the imported service at src/a.ts:1 and src/b.ts:1.";
    }
    return "The implementation route calls missing_handler and this is definitely the final behavior.";
  }

  async embed(input: { inputs: string[]; model?: string }) {
    return {
      model: input.model ?? "test-embedding",
      vectors: input.inputs.map((value) => vector(value))
    };
  }
}

class NoEmbeddingProvider implements LlmProvider {
  async generateStructured<T>(_input: LlmRequest): Promise<T> {
    return {} as T;
  }
  async generateText() {
    return "unused";
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hivo-project-understanding-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "understanding-fixture" }), "utf8");
  await writeFile(path.join(root, "src", "a.ts"), "import { save } from './b';\nexport function start() { return save('value'); }\n", "utf8");
  await writeFile(path.join(root, "src", "b.ts"), "export function save(value: string) { return value; }\n", "utf8");
  await writeFile(path.join(root, "src", "ui.ts"), "export async function load() { return fetch('/api/items'); }\n", "utf8");
  await writeFile(path.join(root, "src", "api.ts"), "app.get('/api/items', () => ({ itemId: 'one' }));\n", "utf8");
  await writeFile(path.join(root, "src", "store.ts"), "export function persist(db: any, payload: any) { db.write({ itemId: payload.itemId }); return { itemId: payload.itemId }; }\n", "utf8");
  return root;
}

function vector(value: string) {
  const result = Array.from({ length: 8 }, (_, index) => ((value.charCodeAt(index % Math.max(value.length, 1)) || 1) % 23) / 23);
  const norm = Math.sqrt(result.reduce((sum, entry) => sum + entry * entry, 0)) || 1;
  return result.map((entry) => entry / norm);
}
