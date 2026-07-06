import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isRecord,
  parseJsonArray,
  parseJsonRecord,
  readOptionalJson,
  teamHierarchySummary,
  type AgentTeam,
  type AgentTeamHierarchy
} from "../orchestration/index.js";

test("CoreReportArtifactHelpers parses records and arrays defensively", () => {
  assert.deepEqual(parseJsonRecord("{\"status\":\"ok\"}"), { status: "ok" });
  assert.deepEqual(parseJsonRecord("[1,2]"), {});
  assert.deepEqual(parseJsonRecord("{bad"), {});
  assert.deepEqual(parseJsonArray("[\"a\",\"b\"]"), ["a", "b"]);
  assert.deepEqual(parseJsonArray("{\"not\":\"array\"}"), []);
  assert.equal(isRecord({ value: 1 }), true);
  assert.equal(isRecord(["value"]), false);
});

test("CoreReportArtifactHelpers reads optional JSON artifacts without throwing", async () => {
  const workspace = path.join(os.tmpdir(), `core-report-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await mkdir(workspace, { recursive: true });
    const jsonPath = path.join(workspace, "artifact.json");
    const badPath = path.join(workspace, "bad.json");
    await writeFile(jsonPath, JSON.stringify({ ok: true }), "utf8");
    await writeFile(badPath, "{bad", "utf8");

    assert.deepEqual(await readOptionalJson(jsonPath), { ok: true });
    assert.equal(await readOptionalJson(path.join(workspace, "missing.json")), undefined);
    assert.equal(await readOptionalJson(badPath), undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CoreReportArtifactHelpers formats team hierarchy summaries", () => {
  const hierarchy: AgentTeamHierarchy = {
    hierarchy_id: "hierarchy_1",
    run_id: "run_1",
    root_team_id: "team_root",
    teams: [fakeTeam("team_root", "root", "platform", "active")],
    edges: [],
    max_depth: 1,
    warnings: [],
    created_at: new Date().toISOString()
  };

  const summary = teamHierarchySummary(hierarchy, {
    valid: false,
    budget_warnings: ["Too many active writers."]
  });

  assert.match(summary, /root_team_id: team_root/);
  assert.match(summary, /team_root: root\/platform \(active\)/);
  assert.match(summary, /Too many active writers\./);
});

function fakeTeam(
  teamId: string,
  teamType: AgentTeam["team_type"],
  domain: string,
  status: AgentTeam["status"]
): AgentTeam {
  const now = new Date().toISOString();
  const budgets = {
    max_depth: 2,
    max_children: 4,
    max_tasks: 10,
    max_active_tasks: 2,
    max_active_writers: 1,
    max_review_loops: 1,
    max_repair_attempts: 1,
    max_prompt_writer_runs: 1,
    max_provider_read_only_workers: 2
  };
  return {
    team_id: teamId,
    run_id: "run_1",
    domain,
    objective: "Coordinate orchestration refactor.",
    team_type: teamType,
    memory_scope: {
      scope_id: `scope_${teamId}`,
      run_id: "run_1",
      team_id: teamId,
      summary: "Team memory scope.",
      context_refs: [],
      evidence_refs: []
    },
    allowed_files: [],
    forbidden_files: [],
    module_locks: [],
    semantic_locks: [],
    budgets,
    limits: budgets,
    status,
    confidence: 0.9,
    metadata_json: {},
    created_at: now,
    updated_at: now,
    orchestrator_agent_id: "agent_orchestrator",
    prompt_writer_agent_ids: [],
    worker_agent_ids: [],
    reviewer_agent_ids: [],
    specialist_agent_ids: []
  };
}
