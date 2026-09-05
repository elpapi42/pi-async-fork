import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import register from "../src/index.js";

test("registers the three public tools with naming guidance", () => {
  const tools: any[] = [];
  const events = new Map<string, Function>();
  register({
    on(name: string, handler: Function) { events.set(name, handler); },
    registerTool(tool: unknown) { tools.push(tool); },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["create_fork", "steer_fork", "fork_status"]);
  assert.match(tools[0].description, /one or two short lowercase letter-only words/);
  assert.match(tools[1].description, /complete fork ID returned by create_fork/);
  assert.ok(events.has("session_start"));
  assert.ok(events.has("session_before_tree"));
  assert.ok(events.has("session_shutdown"));
  assert.ok(events.has("session_tree"));
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
    });
    await events.get("session_start")?.({}, { cwd: "/definitely-missing-pi-async-fork-settings" });
    await assert.rejects(
      () => tools.find((tool) => tool.name === "fork_status").execute("call", { forkId: "research-1234567" }, new AbortController().signal, undefined, { cwd: "/definitely-missing-pi-async-fork-settings" }),
      /pi-async-fork\.stateDir is required/,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(isolatedAgentDir, { recursive: true, force: true });
  }
});
