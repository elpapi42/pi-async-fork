import assert from "node:assert/strict";
import test from "node:test";
import { Delivery, formatOutput } from "../../src/forks/delivery.js";

test("formats visible output without an additional label", () => {
  assert.equal(formatOutput("research-1234567", "result"), "research-1234567:\n\nresult");
});

test("sends adaptive immediate custom messages in call order", async () => {
  const calls: any[] = [];
  const delivery = new Delivery();
  const pi = { sendMessage: (...args: any[]) => calls.push(args) };
  await Promise.all([
    delivery.deliver(pi, "first-1234567", "a1", "one", "c1"),
    delivery.deliver(pi, "second-1234567", "a2", "two", "c2"),
  ]);
  assert.deepEqual(calls.map(([message]) => message.content), ["first-1234567:\n\none", "second-1234567:\n\ntwo"]);
  assert.deepEqual(calls[0][1], { deliverAs: "steer", triggerTurn: true });
});
