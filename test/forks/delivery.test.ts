import assert from "node:assert/strict";
import test from "node:test";
import { Delivery, formatOutput } from "../../src/forks/delivery.js";

test("formats progress, final, and notice envelopes for the parent model", () => {
  assert.equal(
    formatOutput("research-1234567", "progress", "progress"),
    "research-1234567:\n\nThis is an intermediate progress report. The fork is still working and can receive steering.\n\nprogress",
  );
  assert.equal(
    formatOutput("research-1234567", "result", "response"),
    "research-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering.\n\nresult",
  );
  assert.equal(
    formatOutput("research-1234567", "notice", "notice"),
    "research-1234567:\n\nThis is a terminal notice. The fork can no longer receive steering.\n\nnotice",
  );
});

test("sends adaptive immediate custom messages in call order", async () => {
  const calls: any[] = [];
  const delivery = new Delivery();
  const pi = { sendMessage: (...args: any[]) => calls.push(args) };
  await Promise.all([
    delivery.deliver(pi, "first-1234567", "a1", "progress", "one", "c1"),
    delivery.deliver(pi, "second-1234567", "a2", "notice", "two", "c2"),
  ]);
  assert.deepEqual(calls.map(([message]) => message.content), [
    "first-1234567:\n\nThis is an intermediate progress report. The fork is still working and can receive steering.\n\none",
    "second-1234567:\n\nThis is a terminal notice. The fork can no longer receive steering.\n\ntwo",
  ]);
  assert.deepEqual(calls[0][0].details, { forkId: "first-1234567", agentId: "a1", kind: "progress", cursor: "c1" });
  assert.deepEqual(calls[1][0].details, { forkId: "second-1234567", agentId: "a2", kind: "notice", cursor: "c2" });
  assert.deepEqual(calls[0][1], { deliverAs: "steer", triggerTurn: true });
});
