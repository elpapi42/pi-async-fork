import assert from "node:assert/strict";
import test from "node:test";
import { active, isDelivered, project } from "../../src/forks/ledger.js";

const created = {
  type: "fork.created" as const,
  forkId: "research-1234567",
  agentId: "agent-1",
  agentName: "research-1234567",
  stateDir: "/fleet",
  sessionPath: "/session",
  tier: "balanced" as const,
};

function entry(data: unknown) {
  return { type: "custom", customType: "pi-async-fork", data };
}

test("projects active and completed fork history", () => {
  const entries = [entry(created), entry({ type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "done", cursor: "c1" })];
  const record = project(entries).get(created.forkId);
  assert.equal(record?.destroyed?.output, "done");
  assert.equal(active(entries).has(created.forkId), false);
});

test("projects a creation record without a custom state directory", () => {
  const defaultState = { ...created } as Record<string, unknown>;
  delete defaultState.stateDir;
  assert.equal(project([entry(defaultState)]).get(created.forkId)?.stateDir, undefined);
});

test("projects legacy and explicit final wake choices and descriptions", () => {
  assert.equal(project([entry(created)]).get(created.forkId)?.triggerTurn, undefined);
  assert.equal(project([entry(created)]).get(created.forkId)?.description, undefined);
  assert.equal(project([entry({ ...created, triggerTurn: false, description: "Trace login session validation" })]).get(created.forkId)?.triggerTurn, false);
  assert.equal(project([entry({ ...created, triggerTurn: true, description: "Trace login session validation" })]).get(created.forkId)?.description, "Trace login session validation");
});

test("does not accept a destroy record for another agent identity", () => {
  const records = project([entry(created), entry({ type: "fork.destroyed", forkId: created.forkId, agentId: "other", kind: "notice", output: "done" })]);
  assert.equal(records.get(created.forkId)?.destroyed, undefined);
});

test("matches delivered result metadata exactly", () => {
  const entries = [{ type: "custom_message", customType: "pi-async-fork-result", details: { forkId: created.forkId, agentId: created.agentId, cursor: "c1" } }];
  assert.equal(isDelivered(entries, created.forkId, created.agentId, "c1"), true);
  assert.equal(isDelivered(entries, created.forkId, created.agentId, "c2"), false);
});

test("ignores malformed lifecycle records", () => {
  const malformedCreated = { ...created, agentName: undefined };
  const malformedDestroyed = {
    type: "fork.destroyed",
    forkId: created.forkId,
    agentId: created.agentId,
    kind: "response",
    output: "done",
    cursor: 1,
  };

  const records = project([
    entry(malformedCreated),
    entry(malformedDestroyed),
    entry({ ...created, triggerTurn: "false" }),
    entry({ ...created, triggerTurn: null }),
    entry({ ...created, triggerTurn: 0 }),
    entry({ ...created, description: "Only two" }),
    entry({ ...created, description: "Trace login\nsession validation" }),
    entry({ ...created, description: 1 }),
  ]);
  assert.equal(records.size, 0);
});
