import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IntentContract } from "@hivo/protocol";
import { createDurableRuntimeEvent } from "../runtime/DurableRuntimeEvents.js";
import { EventBus } from "../runtime/EventBus.js";
import { SessionManager } from "../runtime/SessionManager.js";
import { replaySessionFromDurableEvents } from "../runtime/SessionReplay.js";

test("runtime replay restores compiled intent contract refs and status", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "runtime-intent-replay-workspace-"));
  const storage = await mkdtemp(path.join(os.tmpdir(), "runtime-intent-replay-storage-"));
  try {
    await mkdir(path.join(workspace, "src"), { recursive: true });
    await writeFile(path.join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf8");
    const manager = new SessionManager(storage, new EventBus());
    await manager.load();
    const session = await manager.createSession({
      workspacePath: workspace,
      mode: "real_provider",
      userPrompt: "Explain src/index.ts"
    });
    const contract = readyContract(session.id, session.userPrompt);
    const replayed = replaySessionFromDurableEvents([
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 1,
        type: "session.created",
        actor: "runtime",
        authority: "runtime",
        payload: { session },
        createdAt: session.createdAt
      }),
      createDurableRuntimeEvent({
        sessionId: session.id,
        sequence: 2,
        type: "intent_contract.compiled",
        actor: "runtime",
        authority: "runtime",
        payload: { intentContract: contract },
        createdAt: contract.created_at
      })
    ]);

    assert.equal(replayed.session?.intent_contract_ref, contract.artifact_ref);
    assert.equal(replayed.session?.intent_contract_status, "ready");
    assert.equal(replayed.session?.intentContract?.contract_id, contract.contract_id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});

function readyContract(runId: string, request: string): IntentContract {
  return {
    schema_version: 1,
    contract_id: `intent_contract_${runId}`,
    run_id: runId,
    run_kind: "runtime_session",
    revision: 1,
    original_user_request: request,
    precise_rewrite: request,
    assumptions: ["Replay fixture has a ready contract."],
    missing_questions: [],
    tradeoffs: [],
    priorities: {
      speed: { score: 50, rationale: "Balanced fixture." },
      quality: { score: 80, rationale: "Planning should preserve intent." },
      realism: { score: 70, rationale: "Use workspace evidence." },
      fun: { score: 10, rationale: "Not relevant." },
      security: { score: 80, rationale: "Keep gates active." },
      cost: { score: 50, rationale: "Avoid extra work." }
    },
    definition_of_done: ["Replay preserves contract state."],
    non_goals: [],
    conflict_rules: ["Ready contract gates planning."],
    status: "ready",
    artifact_ref: `.agent_memory/runtime_intents/${runId}/intent/intent_contract.json`,
    summary_ref: `.agent_memory/runtime_intents/${runId}/intent/intent_contract.md`,
    created_at: new Date().toISOString(),
    metadata_json: {}
  };
}
