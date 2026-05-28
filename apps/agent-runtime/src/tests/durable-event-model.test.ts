import assert from "node:assert/strict";
import test from "node:test";
import {
  DURABLE_RUNTIME_EVENT_TYPES,
  isDurableRuntimeEventType
} from "@hivo/protocol";
import {
  createDurableRuntimeEvent,
  mapRuntimeEventNameToDurableType
} from "../runtime/DurableRuntimeEvents.js";

test("durable runtime event model includes required lifecycle names", () => {
  const required = [
    "session.created",
    "session.snapshot_persisted",
    "session.restored",
    "session.expired",
    "session.reconciliation_required",
    "run.phase_changed",
    "agent.created",
    "agent.updated",
    "decision.recorded",
    "evidence.recorded",
    "patch.proposed",
    "patch.approved",
    "patch.rejected",
    "patch.apply_started",
    "patch.applied",
    "patch.apply_failed",
    "patch.reconciled",
    "verification.started",
    "verification.check_completed",
    "verification.completed",
    "command.requested",
    "command.approved",
    "command.denied",
    "command.started",
    "command.completed",
    "command.failed",
    "review_gate.updated"
  ];
  for (const name of required) {
    assert.equal((DURABLE_RUNTIME_EVENT_TYPES as readonly string[]).includes(name), true);
    assert.equal(isDurableRuntimeEventType(name), true);
  }
});

test("durable runtime event construction includes required fields without inventing payload details", () => {
  const event = createDurableRuntimeEvent({
    sessionId: "session_1",
    sequence: 3,
    type: "patch.proposed",
    actor: "runtime",
    authority: "runtime",
    payload: {
      patchId: "patch_1"
    }
  });

  assert.ok(event.id);
  assert.equal(event.sessionId, "session_1");
  assert.equal(event.sequence, 3);
  assert.equal(event.type, "patch.proposed");
  assert.equal(event.version, 1);
  assert.equal(event.actor, "runtime");
  assert.equal(event.authority, "runtime");
  assert.equal(typeof event.createdAt, "string");
  assert.deepEqual(event.payload, { patchId: "patch_1" });
});

test("runtime event compatibility mapping stays explicit and conservative", () => {
  assert.equal(mapRuntimeEventNameToDurableType("runtime.patch.proposed"), "patch.proposed");
  assert.equal(mapRuntimeEventNameToDurableType("runtime.command.completed"), "command.completed");
  assert.equal(mapRuntimeEventNameToDurableType("runtime.verification.pending"), "verification.started");
  assert.equal(mapRuntimeEventNameToDurableType("runtime.unknown.display_only"), undefined);
});
