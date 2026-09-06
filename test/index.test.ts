import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Controller } from "../src/forks/controller.js";
import register from "../src/index.js";

test("registers the three public tools with focused task and effort guidance", () => {
  const tools: any[] = [];
  const events = new Map<string, Function>();
  const messageRenderers = new Map<string, Function>();
  register({
    on(name: string, handler: Function) { events.set(name, handler); },
    registerTool(tool: unknown) { tools.push(tool); },
    registerMessageRenderer(type: string, renderer: Function) { messageRenderers.set(type, renderer); },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["create_fork", "steer_fork", "fork_status"]);
  assert.match(tools[0].description, /focused task/);
  assert.match(tools[0].description, /terminal notices/);
  assert.doesNotMatch(tools[0].description, /Use it to offload/);
  assert.match(tools[0].description, /one or two short lowercase letter-only words/);
  assert.match(tools[0].parameters.properties.task.description, /ambiguities outside that authority/);
  assert.match(tools[0].parameters.properties.effort.description, /quick lookups, simple checks, or narrow validation/);
  assert.match(tools[0].parameters.properties.effort.description, /normal exploration, implementation, and testing/);
  assert.match(tools[0].parameters.properties.effort.description, /If unsure, use balanced/);
  assert.equal(Object.hasOwn(tools[0].parameters.properties, "tier"), false);
  assert.match(tools[1].description, /active async fork/);
  assert.match(tools[1].parameters.properties.message.description, /current task/);
  assert.equal(tools[2].description, "Get the current status of an async fork. Use the complete fork ID returned by create_fork. Do not shorten, modify, or reconstruct it.");
  assert.equal(typeof tools[0].renderCall, "function");
  assert.equal(typeof tools[0].renderResult, "function");
  assert.equal(typeof tools[1].renderCall, "function");
  assert.equal(typeof tools[1].renderResult, "function");
  assert.equal(typeof tools[2].renderCall, "function");
  assert.equal(typeof tools[2].renderResult, "function");
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_before_tree"));
  assert.ok(events.has("session_shutdown"));
  assert.ok(events.has("session_tree"));
  assert.ok(messageRenderers.has("pi-async-fork-result"));
});

test("forwards create_fork effort to the controller", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-index-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalCreate = Controller.prototype.create;
  let receivedEffort: unknown;
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      "pi-async-fork": {
        fast: { provider: "test", model: "fast", thinking: "low" },
        balanced: { provider: "test", model: "balanced", thinking: "low" },
        deep: { provider: "test", model: "deep", thinking: "low" },
      },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    Controller.prototype.create = async function (_ctx, _toolCallId, _name, _task, effort) {
      receivedEffort = effort;
      return "research-1234567";
    } as typeof Controller.prototype.create;
    const tools: any[] = [];
    register({ on() {}, registerTool(tool: unknown) { tools.push(tool); }, registerMessageRenderer() {} });
    const result = await tools.find((tool) => tool.name === "create_fork").execute(
      "call", { name: "research", task: "Do the task.", effort: "fast" }, new AbortController().signal, undefined, { cwd, sessionManager: {} },
    );
    assert.equal(receivedEffort, "fast");
    assert.equal(result.content[0].text, "research-1234567");
  } finally {
    Controller.prototype.create = originalCreate;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects every async-fork tool in a marked child session", async () => {
  const tools: any[] = [];
  const events = new Map<string, Function>();
  register({
    on(name: string, handler: Function) { events.set(name, handler); },
    registerTool(tool: unknown) { tools.push(tool); },
    registerMessageRenderer() {},
  });
  const marker = {
    type: "custom",
    customType: "pi-async-fork-child",
    data: { version: 1, sessionId: "child-session", forkId: "research-1234567" },
  };
  const ctx = {
    cwd: "/missing-configuration-is-not-read",
    sessionManager: {
      getHeader: () => ({ id: "child-session" }),
      getEntries: () => [marker],
    },
  };
  await events.get("session_start")?.({}, ctx);

  const calls = [
    ["create_fork", { name: "research", task: "Do the task." }],
    ["steer_fork", { forkId: "research-1234567", message: "Continue." }],
    ["fork_status", { forkId: "research-1234567" }],
  ] as const;
  for (const [name, params] of calls) {
    const tool = tools.find((candidate) => candidate.name === name);
    await assert.rejects(
      () => tool.execute("call", params, new AbortController().signal, undefined, ctx),
      /This session is an async fork\. Async fork tools are unavailable here\./,
    );
  }
});

test("keeps tools available with a clear error when startup configuration is absent", async () => {
  const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-async-fork-index-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  try {
    const tools: any[] = [];
    const events = new Map<string, Function>();
    register({
      on(name: string, handler: Function) { events.set(name, handler); },
      registerTool(tool: unknown) { tools.push(tool); },
      registerMessageRenderer() {},
    });
    await events.get("session_start")?.({}, { cwd: "/definitely-missing-pi-async-fork-settings" });
    await assert.rejects(
      () => tools.find((tool) => tool.name === "fork_status").execute("call", { forkId: "research-1234567" }, new AbortController().signal, undefined, { cwd: "/definitely-missing-pi-async-fork-settings" }),
      /pi-async-fork\.fast is required/,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(isolatedAgentDir, { recursive: true, force: true });
  }
});
