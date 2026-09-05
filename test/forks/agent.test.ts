import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@elpapi42/pi-fleet-sdk";
import { Agents } from "../../src/forks/agent.js";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
