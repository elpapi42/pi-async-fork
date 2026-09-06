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
