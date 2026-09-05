import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildSession, projectInvokingAssistant } from "../../src/forks/session.js";

const entry = {
  type: "message",
  message: {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "I will delegate this." },
      { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} },
      { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    ],
  },
};

test("projects text and thinking while removing all unfinished tool calls", () => {
  const projected = projectInvokingAssistant(entry);
  assert.deepEqual(projected?.message.content, [
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "I will delegate this." },
  ]);
  assert.equal(projected?.message.stopReason, "stop");
});

test("omits entries that contain only thinking after tool calls are removed", () => {
  const projected = projectInvokingAssistant({
    type: "message",
    message: { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "reason" }, { type: "toolCall", id: "call-1" }] },
  });
  assert.equal(projected, undefined);
});

test("uses a fresh exclusive session filename instead of the public fork ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  const parent = join(root, "parent.jsonl");
  await writeFile(parent, "parent\n");
  const branch = [{ ...entry, id: "assistant", parentId: "user" }];
  const manager = {
    getBranch: () => branch,
    getSessionFile: () => parent,
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  };
  try {
    const first = await createChildSession(manager, "call-1");
    const second = await createChildSession(manager, "call-1");
    assert.notEqual(first.path, second.path);
    assert.match(first.path, /async-forks\/[0-9a-f-]+\.jsonl$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
