import assert from "node:assert/strict";
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
