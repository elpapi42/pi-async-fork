import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Agent, AgentState } from "@elpapi42/pi-fleet-sdk";
import type { Configuration } from "../../src/configuration.js";
import { Controller } from "../../src/forks/controller.js";
import type { Candidate, ManagedAgents, ObserverCallbacks } from "../../src/forks/agent.js";
import { buildAssignedTask } from "../../src/forks/task-prompt.js";

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
  destroyHook?: () => Promise<void>;
  sent: string[] = [];
  observed = 0;
  stopped = 0;
  async start() {}
  async stop() { this.stopped += 1; }
  async create(name: string) { return { ...this.agent, name } as Agent; }
  async restore() { return this.agent; }
  async status() { return this.state; }
  async steer(_agent: Agent, message: string) { this.sent.push(message); }
  observe(_agent: Agent, _after: string | undefined, callbacks: ObserverCallbacks) { this.observed += 1; this.callbacks = callbacks; }
  stopObserving() { this.stopped += 1; }
  async destroy() { this.destroyed += 1; await this.destroyHook?.(); }
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
    assert.equal(agents.sent[0], buildAssignedTask("Find the answer."));

    agents.candidate({ text: "Answer", cursor: "cursor-1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();

    assert.equal(agents.destroyed, 1);
    const destroyed = branch.find((entry) => entry?.data?.type === "fork.destroyed");
    assert.equal(destroyed.data.kind, "response");
    assert.equal(destroyed.data.output, "Answer");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, `${forkId}:\n\nAnswer`);
    assert.equal(sent[0].details.kind, "response");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits the state directory from a default-state fork record", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, { ...configuration, stateDir: undefined }, agents);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.");
    const created = branch.find((item) => item?.data?.type === "fork.created");
    assert.equal(Object.hasOwn(created.data, "stateDir"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restores a default-state record only with the default current state", async () => {
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", sessionPath: "/child", tier: "balanced" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
  const { pi, ctx } = harness("/work", branch);
  const defaultAgents = new FakeAgents();
  const defaultController = new Controller(pi, { ...configuration, stateDir: undefined }, defaultAgents);
  await defaultController.start(ctx);
  assert.equal(defaultAgents.observed, 1);

  const customAgents = new FakeAgents();
  const customController = new Controller(pi, configuration, customAgents);
  await customController.start(ctx);
  await assert.rejects(() => customController.status(ctx, created.forkId), /different pi-fleet state directory/);
});

test("drains active finalization before a session tree transition", async () => {
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
  let destroyStarted!: () => void;
  const started = new Promise<void>((resolve) => { destroyStarted = resolve; });
  let releaseDestroy!: () => void;
  const release = new Promise<void>((resolve) => { releaseDestroy = resolve; });
  agents.destroyHook = async () => { destroyStarted(); await release; };
  const controller = new Controller(pi, configuration, agents);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.");
    agents.candidate({ text: "Answer", cursor: "cursor-1" });
    agents.statusUpdate("idle");
    await started;
    let transitionFinished = false;
    const transition = controller.beforeTree().then(() => { transitionFinished = true; });
    await waitForLifecycle();
    assert.equal(transitionFinished, false);
    releaseDestroy();
    await transition;
    assert.equal(branch.some((entry) => entry?.data?.type === "fork.destroyed"), true);
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

function harness(root: string, branch: any[], sent: any[] = []) {
  const pi = {
    appendEntry(_type: string, data: unknown) { branch.push({ type: "custom", customType: "pi-async-fork", data }); },
    sendMessage(message: unknown) { sent.push(message); },
  };
  const ctx = { cwd: root, sessionManager: {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  } };
  return { pi, ctx, sent };
}

function invokingBranch() {
  return [{ type: "message", id: "assistant", parentId: "user", message: {
    role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Delegating." }, { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }],
  } }];
}

test("buffers a fast candidate until task acceptance registers the fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let release!: () => void;
  const accepted = new Promise<void>((resolve) => { release = resolve; });
  agents.steer = async (_agent, message) => {
    agents.sent.push(message);
    agents.candidate({ text: "Fast result", cursor: "c1" });
    agents.statusUpdate("idle");
    await accepted;
  };
  const controller = new Controller(pi, configuration, agents);
  try {
    await controller.beforeTree();
    const creating = controller.create(ctx, "call-1", "research", "Find the answer.");
    await waitForLifecycle();
    assert.equal(branch.some((item) => item?.data?.type === "fork.created"), false);
    assert.equal(agents.destroyed, 0);
    release();
    await creating;
    await waitForLifecycle();
    assert.equal(branch.filter((item) => item?.data?.type === "fork.created").length, 1);
    assert.equal(branch.filter((item) => item?.data?.type === "fork.destroyed").length, 1);
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts the no-output grace period when idle is observed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  let now = 0;
  const controller = new Controller(pi, configuration, agents, () => now);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.");
    now = 50_000;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 9_999;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    now += 1;
    agents.statusUpdate("idle");
    await waitForLifecycle();
    const destroyed = branch.find((item) => item?.data?.type === "fork.destroyed");
    assert.equal(agents.destroyed, 1);
    assert.equal(destroyed?.data.kind, "notice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defers inactive-branch completion until the owning branch is active again", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const owned: any[] = invokingBranch();
  let branch: any[] = owned;
  const { pi, ctx } = harness(root, branch);
  ctx.sessionManager.getBranch = () => branch;
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    await controller.create(ctx, "call-1", "research", "Find the answer.");
    branch = [];
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    branch = owned;
    await controller.afterTree(ctx);
    agents.candidate({ text: "Answer", cursor: "c1" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
    assert.equal(owned.some((item) => item?.data?.type === "fork.destroyed"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replays completed output only when parent metadata has no match", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  const destroyed = { type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "Answer", cursor: "c1" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }, { type: "custom", customType: "pi-async-fork", data: destroyed }];
  const { pi, ctx, sent } = harness(root, branch);
  const controller = new Controller(pi, configuration, new FakeAgents());
  try {
    await controller.start(ctx);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].details.kind, "response");
    branch.push({ type: "custom_message", customType: "pi-async-fork-result", details: { forkId: created.forkId, agentId: created.agentId, cursor: "c1" } });
    await controller.afterTree(ctx);
    assert.equal(sent.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not retain stale reconciliation after delayed restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  let branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: created }];
  const { pi, ctx } = harness(root, branch);
  ctx.sessionManager.getBranch = () => branch;
  const agents = new FakeAgents();
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  agents.restore = async () => { await delayed; return agents.agent; };
  const controller = new Controller(pi, configuration, agents);
  try {
    const stale = controller.reconcile(ctx);
    await waitForLifecycle();
    branch = [];
    await controller.reconcile(ctx);
    release();
    await stale;
    assert.equal(agents.observed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains the child session when failed creation cleanup leaves an agent alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  agents.steer = async () => { throw new Error("send failed"); };
  agents.destroyHook = async () => { throw new Error("destroy failed"); };
  const controller = new Controller(pi, configuration, agents);
  try {
    await assert.rejects(
      () => controller.create(ctx, "call-1", "research", "Find the answer."),
      /Agent cleanup failed: destroy failed.*Child session retained/,
    );
    assert.equal(branch.some((item) => item?.data?.type === "fork.created"), false);
    assert.equal(agents.stopped > 0, true);
    assert.equal((await readdir(join(root, "async-forks"))).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes accepted steering before automatic destruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const branch: any[] = invokingBranch();
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.");
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    let releaseSend!: () => void;
    const release = new Promise<void>((resolve) => { releaseSend = resolve; });
    agents.steer = async (_agent, message) => {
      agents.sent.push(message);
      sendStarted();
      await release;
    };
    const steering = controller.steer(ctx, forkId, "Continue.");
    await started;
    agents.candidate({ text: "Updated answer", cursor: "c2" });
    agents.statusUpdate("idle");
    await waitForLifecycle();
    assert.equal(agents.destroyed, 0);
    releaseSend();
    await steering;
    await waitForLifecycle();
    assert.equal(agents.destroyed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closes managed agents when startup reconciliation fails", async () => {
  const created = { type: "fork.created", forkId: "research-0000001", agentId: "agent-1", agentName: "research-0000001", stateDir: "/fleet", sessionPath: "/child", tier: "balanced" };
  const destroyed = { type: "fork.destroyed", forkId: created.forkId, agentId: created.agentId, kind: "response", output: "Answer", cursor: "c1" };
  const branch: any[] = [
    { type: "custom", customType: "pi-async-fork", data: created },
    { type: "custom", customType: "pi-async-fork", data: destroyed },
  ];
  const ctx = { cwd: "/work", sessionManager: { getBranch: () => branch } };
  const pi = { appendEntry() {}, sendMessage() { throw new Error("delivery failed"); } };
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  await assert.rejects(() => controller.start(ctx), /delivery failed/);
  assert.equal(agents.stopped, 1);
});

test("reports state-directory mismatch and ignores abort after accepted steering", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-controller-"));
  const mismatch = { type: "fork.created", forkId: "other-0000001", agentId: "other", agentName: "other-0000001", stateDir: "/other", sessionPath: "/child", tier: "balanced" };
  const branch: any[] = [{ type: "custom", customType: "pi-async-fork", data: mismatch }];
  const { pi, ctx } = harness(root, branch);
  const agents = new FakeAgents();
  const controller = new Controller(pi, configuration, agents);
  try {
    await controller.start(ctx);
    await assert.rejects(() => controller.status(ctx, mismatch.forkId), /different pi-fleet state directory/);

    branch.length = 0;
    branch.push(...invokingBranch());
    await controller.afterTree(ctx);
    const forkId = await controller.create(ctx, "call-1", "research", "Find the answer.");
    const abort = new AbortController();
    agents.steer = async (_agent, message) => { agents.sent.push(message); abort.abort(); };
    await controller.steer(ctx, forkId, "Continue.", abort.signal);
    assert.equal(agents.sent.at(-1), "Continue.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
