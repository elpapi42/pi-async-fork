import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildSession, isForkChildSession, projectInvokingAssistant } from "../../src/forks/session.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const entry = {
  type: "message",
  id: "assistant",
  parentId: "user",
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "assistant",
    api: "openai-responses",
    provider: "openai-codex",
    model: "model",
    responseId: "response-1",
    timestamp: 1,
    usage: { ...zeroUsage, output: 10, totalTokens: 10 },
    stopReason: "toolUse",
    content: [
      { type: "thinking", thinking: "reason" },
      { type: "text", text: "I will delegate this." },
      { type: "toolCall", id: "call-1", name: "create_fork", arguments: {} },
      { type: "toolCall", id: "call-2", name: "read", arguments: {} },
    ],
  },
};

function manager(root: string, branch: any[]) {
  return {
    getBranch: () => branch,
    getSessionFile: () => join(root, "parent.jsonl"),
    getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: root }),
  };
}

async function entries(path: string): Promise<any[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("projects text and thinking while removing all unfinished tool calls", () => {
  const projected = projectInvokingAssistant(entry);
  assert.deepEqual(projected?.message.content, [
    { type: "thinking", thinking: "reason" },
    { type: "text", text: "I will delegate this." },
  ]);
  assert.equal(projected?.message.stopReason, "stop");
});

test("preserves a cleaned thinking-only invoking assistant entry", () => {
  const projected = projectInvokingAssistant({
    ...entry,
    message: { ...entry.message, content: [{ type: "thinking", thinking: "reason" }, { type: "toolCall", id: "call-1" }] },
  });
  assert.deepEqual(projected?.message.content, [{ type: "thinking", thinking: "reason" }]);
  assert.equal(projected?.message.stopReason, "stop");
});

test("adds a linked zero-usage assistant boundary after the cleaned invoking assistant", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  const user = { type: "message", id: "user", parentId: null, message: { role: "user", content: "Delegate." } };
  try {
    const child = await createChildSession(manager(root, [user, entry]), "call-1", "research-1234567");
    const childEntries = await entries(child.path);
    const projected = childEntries.at(-3);
    const marker = childEntries.at(-2);
    const boundary = childEntries.at(-1);
    assert.equal(projected.id, "assistant");
    assert.equal(marker.type, "custom");
    assert.equal(marker.customType, "pi-async-fork-child");
    assert.equal(marker.parentId, projected.id);
    assert.equal(marker.data.version, 1);
    assert.equal(marker.data.sessionId, childEntries[0].id);
    assert.equal(marker.data.forkId, "research-1234567");
    assert.equal(boundary.type, "message");
    assert.notEqual(boundary.id, projected.id);
    assert.equal(boundary.parentId, marker.id);
    assert.equal(boundary.message.role, "assistant");
    assert.equal(boundary.message.stopReason, "stop");
    assert.equal(boundary.message.responseId, undefined);
    assert.deepEqual(boundary.message.usage, zeroUsage);
    assert.match(boundary.message.content[0].text, /^I am a fork\. I am not the main agent\./);
    assert.match(boundary.message.content[0].text, /Fork ID: research-1234567$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("links the assistant boundary to the parent user when no cleaned content remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  const user = { type: "message", id: "user", parentId: null, message: { role: "user", content: "Delegate." } };
  const toolOnly = { ...entry, message: { ...entry.message, content: [{ type: "toolCall", id: "call-1", name: "create_fork", arguments: {} }] } };
  try {
    const child = await createChildSession(manager(root, [user, toolOnly]), "call-1", "research-1234567");
    const childEntries = await entries(child.path);
    const marker = childEntries.at(-2);
    const boundary = childEntries.at(-1);
    assert.equal(marker.parentId, "user");
    assert.equal(boundary.parentId, marker.id);
    assert.equal(childEntries.at(-3).id, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects only a child marker for the current session ID", () => {
  const current = {
    getHeader: () => ({ id: "child-session" }),
    getEntries: () => [{
      type: "custom",
      customType: "pi-async-fork-child",
      data: { version: 1, sessionId: "child-session", forkId: "research-1234567" },
    }],
  };
  const inherited = {
    getHeader: () => ({ id: "copied-session" }),
    getEntries: current.getEntries,
  };
  assert.equal(isForkChildSession(current), true);
  assert.equal(isForkChildSession(inherited), false);
  assert.equal(isForkChildSession({ getHeader: () => null, getEntries: () => [] }), false);
});

test("uses a fresh exclusive session filename instead of the public fork ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  try {
    const first = await createChildSession(manager(root, [entry]), "call-1", "research-1234567");
    const second = await createChildSession(manager(root, [entry]), "call-1", "research-1234567");
    assert.notEqual(first.path, second.path);
    assert.match(first.path, /async-forks\/[0-9a-f-]+\.jsonl$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
