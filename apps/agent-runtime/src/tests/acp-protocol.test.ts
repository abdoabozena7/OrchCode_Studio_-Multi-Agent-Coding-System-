import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAcpPacket,
  serializeAcpDictionary,
  serializeAcpPacket,
  validateAcpPacket,
  type AcpPacket
} from "@hivo/protocol";

test("ACP parses the full header and serializes deterministically", () => {
  const result = parseAcpPacket([
    "M|Plan>Code|S18|impl|H",
    "O: patch+tests",
    "G: add ticket auto-routing",
    "E: tickets.ts; agents/router.ts",
    "R: no-ui-change; no-mock"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.deepEqual(result.packet, {
    version: 1,
    from: "Plan",
    to: "Code",
    session: "S18",
    type: "impl",
    priority: "H",
    fields: {
      O: "patch+tests",
      G: "add ticket auto-routing",
      E: "tickets.ts; agents/router.ts",
      R: "no-ui-change; no-mock"
    }
  });
  assert.equal(serializeAcpPacket(result.packet!), [
    "M|Plan>Code|S18|impl|H",
    "G:add ticket auto-routing",
    "E:tickets.ts; agents/router.ts",
    "R:no-ui-change; no-mock",
    "O:patch+tests"
  ].join("\n"));
});

test("ACP accepts and emits compact headers", () => {
  const result = parseAcpPacket([
    "P>C|S42|patch|H",
    "G:login returns 500",
    "CTX:S42.K3",
    "E:api/auth.ts@20-61",
    "O:diff+test"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.equal(serializeAcpPacket(result.packet!, { compactHeader: true }), [
    "P>C|S42|patch|H",
    "G:login returns 500",
    "CTX:S42.K3",
    "E:api/auth.ts@20-61",
    "O:diff+test"
  ].join("\n"));
});

test("ACP compact headers allow an endpoint named M", () => {
  const result = parseAcpPacket([
    "M>Code|S42|patch|H",
    "G:fix parser ambiguity"
  ].join("\n"));

  assert.equal(result.ok, true);
  assert.equal(result.packet?.from, "M");
});

test("ACP rejects ambiguous or unknown fields", () => {
  const result = parseAcpPacket([
    "M|Plan>Code|S18|impl|H",
    "G:add routing",
    "G:repeat goal",
    "WHY:no reason code exists"
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('repeats ACP field "G"')));
  assert.ok(result.errors.some((error) => error.includes('unknown ACP field "WHY"')));
});

test("ACP validation rejects multiline values and exposes the session dictionary", () => {
  const packet = {
    version: 1,
    from: "Code",
    to: "Test",
    session: "S18",
    type: "verify",
    priority: "M",
    fields: { S: "patch-ready\nunreviewed" }
  } satisfies AcpPacket;

  assert.equal(validateAcpPacket(packet).valid, false);
  assert.equal(validateAcpPacket({ version: 1, fields: [] }).valid, false);
  assert.match(serializeAcpDictionary(), /^DICT ACP\/1\nG=goal/m);
  assert.match(serializeAcpDictionary(), /^CTX=context-ref$/m);
});

test("ACP validation prevents the serializer from producing oversized packets", () => {
  const packet = {
    version: 1,
    from: "Plan",
    to: "Code",
    session: "S18",
    type: "impl",
    priority: "H",
    fields: {
      G: "g".repeat(4_096),
      C: "c".repeat(4_096),
      E: "e".repeat(4_096),
      R: "r".repeat(4_096)
    }
  } satisfies AcpPacket;

  assert.equal(validateAcpPacket(packet).valid, false);
  assert.throws(() => serializeAcpPacket(packet), /exceeds 16384 characters/);
});
