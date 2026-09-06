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
    "research-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.\n\nresult",
  );
  assert.equal(
    formatOutput("research-1234567", "notice", "notice"),
    "research-1234567:\n\nThis is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.\n\nnotice",
  );
});

test("keeps progress quiet and always wakes for terminal reports", async () => {
  const calls: any[] = [];
  const delivery = new Delivery();
  const pi = { sendMessage: (...args: any[]) => calls.push(args) };
  await Promise.all([
    delivery.deliver(pi, "first-1234567", "a1", "progress", "one", "c1", "Trace login session validation"),
    delivery.deliver(pi, "second-1234567", "a2", "notice", "two", "c2", "Trace login session validation"),
  ]);
  await delivery.deliver(pi, "third-1234567", "a3", "response", "three", "c3", "Trace login session validation");
  await delivery.deliver(pi, "fourth-1234567", "a4", "response", "four", "c4", "Trace login session validation");
  await delivery.deliver(pi, "fifth-1234567", "a5", "notice", "five", "c5", "Trace login session validation");
  assert.deepEqual(calls.map(([message]) => message.content), [
    "first-1234567:\n\nThis is an intermediate progress report. The fork is still working and can receive steering.\n\none",
    "second-1234567:\n\nThis is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.\n\ntwo",
    "third-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.\n\nthree",
    "fourth-1234567:\n\nThis is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.\n\nfour",
    "fifth-1234567:\n\nThis is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.\n\nfive",
  ]);
  assert.deepEqual(calls.map(([message]) => message.details.description), Array(5).fill("Trace login session validation"));
  assert.deepEqual(calls.map(([, options]) => options), [
    { deliverAs: "steer", triggerTurn: false },
    { deliverAs: "steer", triggerTurn: true },
    { deliverAs: "steer", triggerTurn: true },
    { deliverAs: "steer", triggerTurn: true },
    { deliverAs: "steer", triggerTurn: true },
  ]);
});
