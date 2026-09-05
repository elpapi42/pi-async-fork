import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, AgentState } from "@elpapi42/pi-fleet-sdk";
import type { Configuration } from "../../src/configuration.js";
import { Controller } from "../../src/forks/controller.js";
import type { Candidate, ManagedAgents, ObserverCallbacks } from "../../src/forks/agent.js";

const configuration: Configuration = {
  agentDir: "/profile",
  stateDir: "/fleet",
  profiles: {
    fast: { provider: "p", model: "fast", thinking: "low" },
    balanced: { provider: "p", model: "balanced", thinking: "high" },
    deep: { provider: "p", model: "deep", thinking: "high" },
  },
};

class FakeAgents implements ManagedAgents {
  readonly agent = { id: "agent-1", name: "research-0000001" } as Agent;
  callbacks?: ObserverCallbacks;
  state: AgentState = "working";
  destroyed = 0;
  sent: string[] = [];
  async start() {}
  async stop() {}
  async create(name: string) { return { ...this.agent, name } as Agent; }
  async restore() { return this.agent; }
  async status() { return this.state; }
  async steer(_agent: Agent, message: string) { this.sent.push(message); }
  observe(_agent: Agent, _after: string | undefined, callbacks: ObserverCallbacks) { this.callbacks = callbacks; }
  stopObserving() {}
  async destroy() { this.destroyed += 1; }
  candidate(candidate: Candidate) { this.callbacks?.onCandidate(candidate); }
  statusUpdate(state: AgentState) { this.callbacks?.onStatus(state); }
}

function waitForLifecycle() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("registers only after task acceptance and finalizes a settled candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const parent = join(root, "parent.jsonl");
  const branch: any[] = [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "I will delegate research." },
      { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} },
    ],
  } }];
  const sent: any[] = [];
  const pi = {
    appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); },
    sendMessage(message: unknown) { sent.push(message); },
  };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => parent,
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.");
    assert.match(forkId, /^research-\d{7}$/);
    assert.equal(branch.filter((entry) => entry?.data?.type === "fork.created").length, 1);
    assert.match(agents.sent[0], /Fork ID: research-\d{7}/);

    agents.candidate({ text: "Answer", cursor: "cursor-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();

    assert.equal(agents.destroyed, 1);
    const destroyed = branch.find((entry) => entry?.data?.type === "fork.destroyed");
    assert.equal(destroyed.data.kind, "response");
    assert.equal(destroyed.data.output, "Answer");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, `${forkId}:\n\nAnswer`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not register a fork when initial task acceptance fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }],
  } }];
  const pi = { appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); }, sendMessage() {} };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  const agents = new FakeAgents();
  agents.steer = async () => { throw new Error("rejected"); };
  const controller = new Controller(pi, configuration, agents);
  try {
    await assert.rejects(() => controller.create(ctx, "call-1", "research", "Find the answer."), /rejected/);
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.created"), false);
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
