import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { LlmProvider, LlmRequest } from "../llm/LlmProvider.js";
import {
  SemanticConflictResolver,
  createSemanticConflictDecision,
  createSemanticConflictResolutionBatch,
  semanticBatchBlocks
} from "../orchestration/index.js";

test("semantic conflict models preserve requested fields and blocking status", () => {
  const decision = createSemanticConflictDecision({
    run_id: "run_semantic_model",
    phase: "integration",
    conflict: "fun_arcade_physics_vs_realistic_physics",
    source_a: "MarketingAgent",
    source_b: "PhysicsAgent",
    root_intent: "arcade fun car game",
    decision: "use low gravity arcade physics",
    reason: "user goal prioritizes fun over realism",
    requires_user_approval: false
  });
  const batch = createSemanticConflictResolutionBatch({
    run_id: "run_semantic_model",
    phase: "integration",
    root_intent: decision.root_intent,
    decisions: [decision],
    provider_used: true
  });

  assert.equal(decision.conflict, "fun_arcade_physics_vs_realistic_physics");
  assert.equal(decision.decision, "use low gravity arcade physics");
  assert.equal(decision.requires_user_approval, false);
  assert.equal(batch.status, "resolved");
  assert.equal(semanticBatchBlocks(batch), false);
});

test("semantic conflict resolver normalizes provider-authored resolved tradeoffs", async () => {
  const workspace = await fixtureWorkspace("semantic-resolver-normalize");
  try {
    const provider = new ResponseProvider({
      decisions: [{
        conflict: "fun_arcade_physics_vs_realistic_physics",
        source_a: "MarketingAgent",
        source_b: "PhysicsAgent",
        root_intent: "arcade fun car game",
        decision: "use low gravity arcade physics",
        reason: "user goal prioritizes fun over realism",
        requires_user_approval: false,
        severity: "warning",
        status: "resolved",
        evidence_refs: ["intent_contract:arcade"]
      }]
    });
    const batch = await new SemanticConflictResolver({
      workspacePath: workspace,
      provider,
      mode: "strict"
    }).resolve({
      runId: "run_semantic_normalize",
      phase: "integration",
      rootIntent: "arcade fun car game",
      sources: [{
        source_id: "branch_physics",
        source_role: "PhysicsAgent",
        summary: "Physics branch proposes low gravity for fun.",
        refs: ["branch_physics"]
      }]
    });

    assert.equal(provider.schemaName, "semantic_conflict_resolution");
    assert.equal(batch.status, "resolved");
    assert.equal(batch.decisions[0].decision, "use low gravity arcade physics");
    assert.equal(batch.decisions[0].requires_user_approval, false);
    assert.equal(semanticBatchBlocks(batch), false);
    assert.ok(batch.artifact_ref && existsSync(batch.artifact_ref));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("semantic conflict resolver blocks malformed provider output in strict mode without local fallback", async () => {
  const workspace = await fixtureWorkspace("semantic-resolver-strict-malformed");
  try {
    const batch = await new SemanticConflictResolver({
      workspacePath: workspace,
      provider: new ResponseProvider({ status: "aligned", rationale: "old schema" }),
      mode: "strict"
    }).resolve({
      runId: "run_semantic_strict_malformed",
      phase: "review",
      rootIntent: "ship the product goal",
      sources: [{
        source_id: "worker_a",
        source_role: "ExecutorAgent",
        summary: "Worker output may change product tradeoffs.",
        refs: ["worker_a"]
      }]
    });

    assert.equal(batch.status, "provider_unavailable");
    assert.equal(batch.provider_used, false);
    assert.equal(batch.decisions[0].conflict, "semantic_conflict_provider_unavailable");
    assert.match(batch.decisions[0].reason, /decisions array missing/);
    assert.equal(semanticBatchBlocks(batch), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("semantic conflict resolver records malformed provider output as report-only warning", async () => {
  const workspace = await fixtureWorkspace("semantic-resolver-report-only");
  try {
    const batch = await new SemanticConflictResolver({
      workspacePath: workspace,
      provider: new ResponseProvider({ nope: true }),
      mode: "report_only"
    }).resolve({
      runId: "run_semantic_report_only",
      phase: "finalization",
      rootIntent: "ship the product goal",
      sources: [{
        source_id: "integration_summary",
        source_role: "DomainOrchestrator",
        summary: "Domain summary needs semantic review.",
        refs: ["integration_summary"]
      }]
    });

    assert.equal(batch.status, "provider_unavailable");
    assert.equal(batch.decisions[0].severity, "warning");
    assert.equal(batch.decisions[0].requires_user_approval, false);
    assert.equal(semanticBatchBlocks(batch), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

class ResponseProvider implements LlmProvider {
  schemaName?: string;

  constructor(private readonly response: unknown) {}

  async generateStructured<T>(_input: LlmRequest, schema: unknown): Promise<T> {
    this.schemaName = getSchemaName(schema);
    return this.response as T;
  }

  async generateText(_input: LlmRequest): Promise<string> {
    return "";
  }
}

async function fixtureWorkspace(name: string) {
  return mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

function getSchemaName(schema: unknown) {
  return typeof schema === "object" && schema && "name" in schema
    ? String((schema as { name: string }).name)
    : "";
}
