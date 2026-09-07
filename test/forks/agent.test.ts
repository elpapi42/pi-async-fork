import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@elpapi42/pi-fleet-sdk";
import { Agents } from "../../src/forks/agent.js";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("omits stateDir from pi-fleet connection when the default state is requested", async () => {
  const options: any[] = [];
  const client = { close() { return Promise.resolve(); } };
  const agents = new Agents(undefined, async (value: unknown) => {
    options.push(value);
    return client as any;
  });
  await agents.start();
  await agents.stop();
  assert.deepEqual(options, [{}]);
  assert.equal(Object.hasOwn(options[0], "stateDir"), false);
});

test("passes a configured stateDir to pi-fleet connection", async () => {
  const options: any[] = [];
  const client = { close() { return Promise.resolve(); } };
  const agents = new Agents("/state", async (value: unknown) => {
    options.push(value);
    return client as any;
  });
  await agents.start();
  await agents.stop();
  assert.equal(options[0].stateDir, "/state");
});

test("omits agentDir from pi-fleet creation when the default profile is requested", async () => {
  const options: any[] = [];
  const agent = { id: "agent-1", name: "research-0000001" } as Agent;
  const client = { create(value: unknown) { options.push(value); return Promise.resolve(agent); } };
  const agents = new Agents("/state", async () => client as any);
  await agents.create("research-0000001", "/work", undefined, ["--session", "/child"]);
  assert.deepEqual(options, [{ name: "research-0000001", cwd: "/work", piArgs: ["--session", "/child"] }]);
  assert.equal(Object.hasOwn(options[0], "agentDir"), false);
});

test("passes a configured agentDir to pi-fleet creation", async () => {
  const options: any[] = [];
  const agent = { id: "agent-1", name: "research-0000001" } as Agent;
  const client = { create(value: unknown) { options.push(value); return Promise.resolve(agent); } };
  const agents = new Agents("/state", async () => client as any);
  await agents.create("research-0000001", "/work", "/profile", ["--session", "/child"]);
  assert.equal(options[0].agentDir, "/profile");
});

test("forwards a configured child-Pi environment and omits an undefined one", async () => {
  const options: any[] = [];
  const agent = { id: "agent-1", name: "research-0000001" } as Agent;
  const client = { create(value: unknown) { options.push(value); return Promise.resolve(agent); } };
  const agents = new Agents("/state", async () => client as any);
  const env = Object.assign(Object.create(null), { PI_OBSERVATIONAL_MEMORY_PASSIVE: "", FEATURE_MODE: "enabled" });
  await agents.create("research-0000001", "/work", undefined, ["--session", "/child"], env);
  await agents.create("research-0000002", "/work", undefined, ["--session", "/child"]);
  assert.deepEqual(options[0].env, env);
  assert.equal(Object.hasOwn(options[1], "env"), false);
});

test("reports ordered continuation activity after visible messages", async () => {
  let release!: () => void;
  const releaseNext = new Promise<void>((resolve) => { release = resolve; });
  const agent = {
    id: "agent-events",
    name: "research-0000001",
    async status() { return { state: "working" }; },
    receive() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "message.finished", text: "checkpoint", cursor: "c1" };
          yield { type: "tool.started", cursor: "tool-1" };
          yield { type: "agent.destroyed", cursor: "destroyed" };
          await releaseNext;
        },
      };
    },
  } as unknown as Agent;
  const agents = new Agents("/unused");
  const events: string[] = [];
  agents.observe(agent, undefined, {
    onCandidate(candidate) { events.push(`message:${candidate.cursor}`); },
    onActivity() { events.push("activity"); },
    onStatus() {},
    onError(error) { throw error; },
  });
  try {
    await wait(20);
    assert.deepEqual(events, ["message:c1", "activity"]);
  } finally {
    release();
    agents.stopObserving(agent.id);
  }
});

test("polls one status request at a time and reports transport errors separately", async () => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const agent = {
    id: "agent-1",
    name: "research-0000001",
    async status() {
      calls += 1;
      await pending;
      throw new Error("temporary transport failure");
    },
    receive() {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise(() => undefined);
        },
      };
    },
  } as unknown as Agent;
  const agents = new Agents("/unused");
  const errors: unknown[] = [];
  const states: string[] = [];
  agents.observe(agent, undefined, {
    onCandidate() {},
    onActivity() {},
    onStatus(state) { states.push(state); },
    onError(error) { errors.push(error); },
  });
  await wait(20);
  assert.equal(calls, 1);
  release();
  await wait(20);
  agents.stopObserving(agent.id);
  assert.equal(states.length, 0);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /temporary transport failure/);
});

test("absorbs a receiver close failure", async () => {
  const agent = {
    id: "agent-2",
    name: "research-0000002",
    async status() { return { state: "working" }; },
    receive() {
      return {
        [Symbol.asyncIterator]() {
          return {
            next: async () => await new Promise(() => undefined),
            return: async () => { throw new Error("close failed"); },
          };
        },
      };
    },
  } as unknown as Agent;
  const agents = new Agents("/unused");
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    agents.observe(agent, undefined, { onCandidate() {}, onActivity() {}, onStatus() {}, onError() {} });
    await wait(10);
    agents.stopObserving(agent.id);
    await wait(10);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

type TimerTask = { delay: number; callback: () => void; cleared: boolean };

function fakeTimers() {
  const tasks: TimerTask[] = [];
  return {
    timers: {
      set(delay: number, callback: () => void) {
        const task = { delay, callback, cleared: false };
        tasks.push(task);
        return task;
      },
      clear(task: TimerTask) { task.cleared = true; },
    },
    fire(delay: number) {
      const task = tasks.find((candidate) => candidate.delay === delay && !candidate.cleared);
      assert.ok(task, `missing ${delay}ms timer`);
      task.cleared = true;
      task.callback();
    },
  };
}

function activityAgent(events: unknown[], options: { pending?: boolean; error?: Error } = {}) {
  let receiveCalls = 0;
  let returnCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const agent = {
    id: "agent-history",
    name: "history-0000001",
    receive() {
      receiveCalls += 1;
      return {
        [Symbol.asyncIterator]() {
          let index = 0;
          return {
            async next() {
              if (options.error) throw options.error;
              if (index < events.length) return { done: false, value: events[index++] };
              if (options.pending) await pending;
              return { done: true, value: undefined };
            },
            async return() { returnCalls += 1; release(); return { done: true, value: undefined }; },
          };
        },
      };
    },
  } as unknown as Agent;
  return { agent, receiveCalls: () => receiveCalls, returnCalls: () => returnCalls };
}

test("collects compact ordered activity from an independent subscription", async () => {
  const clock = fakeTimers();
  const source = activityAgent([
    { type: "thinking.started", timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
    { type: "thinking.finished", content: "private", timestamp: 2, cursor: "b", eventId: "b", activityId: "b" },
    { type: "tool.started", toolName: "bash", args: { command: "echo ok", token: "secret" }, argsTruncated: false, timestamp: 3, cursor: "c", eventId: "c", activityId: "c" },
    { type: "message.finished", text: "private response", timestamp: Number.NaN, cursor: "d", eventId: "d", activityId: "d" },
  ]);
  const agents = new Agents("/unused", undefined as any, { timers: clock.timers });
  const history = await agents.collectActivity(source.agent, undefined);
  assert.equal(source.receiveCalls(), 1);
  assert.equal(source.returnCalls(), 1);
  assert.equal(history.stopReason, "stream-ended");
  assert.deepEqual(history.entries, [
    { timestamp: 1, kind: "thinking" },
    { timestamp: 3, kind: "tool", toolName: "bash", args: { command: "echo ok", token: "[REDACTED]" }, argsTruncated: false, redacted: true, truncated: false },
    { timestamp: null, kind: "message" },
  ]);
});

test("rejects nonpositive or noninteger activity limits", async () => {
  const source = activityAgent([]);
  const agents = new Agents("/unused");
  await assert.rejects(agents.collectActivity(source.agent, 0), /positive integer/);
  await assert.rejects(agents.collectActivity(source.agent, 1.5), /positive integer/);
});

test("retains the latest limited activity and bounds tool arguments", async () => {
  const source = activityAgent([
    { type: "thinking.started", timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
    { type: "tool.started", toolName: "bash", args: { command: "x".repeat(2_000), authorization: "Bearer secret" }, argsTruncated: false, timestamp: 2, cursor: "b", eventId: "b", activityId: "b" },
    { type: "message.finished", text: "text", timestamp: 3, cursor: "c", eventId: "c", activityId: "c" },
  ]);
  const agents = new Agents("/unused");
  const history = await agents.collectActivity(source.agent, 2);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].kind, "tool");
  assert.equal(history.entries[1].kind, "message");
  const tool = history.entries[0];
  assert.equal(tool.redacted, true);
  assert.equal(tool.truncated, true);
  assert.equal(tool.args, "[TRUNCATED]");
});

test("ends collection after idle and absolute deadlines and returns the iterator once", async () => {
  for (const deadline of [1_000, 3_000]) {
    const clock = fakeTimers();
    const source = activityAgent(deadline === 3_000 ? [
      { type: "thinking.started", timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
      { type: "message.started", timestamp: 2, cursor: "b", eventId: "b", activityId: "b" },
    ] : [], { pending: true });
    const agents = new Agents("/unused", undefined as any, { timers: clock.timers });
    const collecting = agents.collectActivity(source.agent, undefined);
    await Promise.resolve();
    clock.fire(deadline);
    const history = await collecting;
    assert.equal(history.stopReason, deadline === 1_000 ? "idle" : "deadline");
    assert.equal(source.returnCalls(), 1);
  }
});

test("redacts secret-shaped values and credential-bearing tool strings", async () => {
  const source = activityAgent([
    { type: "tool.started", toolName: "fetch", args: {
      authorization: "Basic dXNlcjpwYXNz",
      url: "https://user:password@example.test/path?token=abc",
      nested: { apiKey: "abc" },
    }, argsTruncated: false, timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
  ]);
  const history = await new Agents("/unused").collectActivity(source.agent, undefined);
  assert.deepEqual(history.entries[0].args, {
    authorization: "[REDACTED]",
    url: "https://[REDACTED]@example.test/path?token=[REDACTED]",
    nested: { apiKey: "[REDACTED]" },
  });
  assert.equal(history.entries[0].redacted, true);
});

test("redacts shell assignments, headers, nested strings, and encoded query keys", async () => {
  const source = activityAgent([
    { type: "tool.started", toolName: "bash", args: {
      command: "curl -H 'X-Api-Key: test-api-value' -H 'Authorization: ApiKey test-auth-value' -H 'Cookie: session=test-cookie' 'https://example.test/?access%5ftoken=test-query-value'; export AWS_SECRET_ACCESS_KEY=test-env-value",
      headers: ["Authorization: ApiKey test-header-value", "X-Api-Key: test-nested-value"],
    }, argsTruncated: false, timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
  ]);
  const history = await new Agents("/unused").collectActivity(source.agent, undefined);
  const args = JSON.stringify(history.entries[0].args);
  for (const value of ["test-api-value", "test-auth-value", "test-cookie", "test-query-value", "test-env-value", "test-header-value", "test-nested-value"]) {
    assert.equal(args.includes(value), false, `${value} leaked`);
  }
  assert.match(args, /X-Api-Key: \[REDACTED\]/);
  assert.match(args, /Authorization: ApiKey \[REDACTED\]/);
  assert.match(args, /Cookie: \[REDACTED\]/);
  assert.match(args, /access%5ftoken=\[REDACTED\]/i);
  assert.match(args, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.equal(history.entries[0].redacted, true);
});

test("redacts complete semicolon-separated cookie headers without removing nearby command text", async () => {
  const source = activityAgent([
    { type: "tool.started", toolName: "bash", args: {
      command: "echo safe; curl -H 'Cookie: session=first-cookie; preference=second-cookie' https://example.test; echo done",
      headers: ["Cookie: first=third-cookie; second=fourth-cookie", "Accept: text/plain"],
    }, argsTruncated: false, timestamp: 1, cursor: "a", eventId: "a", activityId: "a" },
  ]);
  const history = await new Agents("/unused").collectActivity(source.agent, undefined);
  const args = JSON.stringify(history.entries[0].args);
  for (const value of ["first-cookie", "second-cookie", "third-cookie", "fourth-cookie"]) {
    assert.equal(args.includes(value), false, `${value} leaked`);
  }
  assert.match(args, /Cookie: \[REDACTED\]/);
  assert.match(args, /echo safe/);
  assert.match(args, /echo done/);
  assert.match(args, /Accept: text\/plain/);
});

test("marks output truncation when full observed history exceeds the total cap", async () => {
  const source = activityAgent(Array.from({ length: 1_000 }, (_, index) => ({
    type: "message.finished", text: "ignored", timestamp: index, cursor: String(index), eventId: String(index), activityId: String(index),
  })));
  const history = await new Agents("/unused").collectActivity(source.agent, undefined);
  assert.equal(history.outputTruncated, true);
  assert.ok(history.entries.length < 1_000);
});

test("resets idle collection after ignored activity and handles error and abort", async () => {
  const clock = fakeTimers();
  const source = activityAgent([{ type: "message.started", timestamp: 1, cursor: "a", eventId: "a", activityId: "a" }], { pending: true });
  const agents = new Agents("/unused", undefined as any, { timers: clock.timers });
  const collecting = agents.collectActivity(source.agent, undefined);
  await Promise.resolve();
  clock.fire(1_000);
  const history = await collecting;
  assert.equal(history.stopReason, "idle");
  assert.equal(source.returnCalls(), 1);

  const failing = activityAgent([], { error: new Error("stream failed") });
  assert.equal((await agents.collectActivity(failing.agent, undefined)).stopReason, "error");

  const controller = new AbortController();
  const aborted = activityAgent([], { pending: true });
  const pending = agents.collectActivity(aborted.agent, undefined, controller.signal);
  controller.abort();
  assert.equal((await pending).stopReason, "aborted");
  assert.equal(aborted.returnCalls(), 1);
});
