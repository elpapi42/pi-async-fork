import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildSession, isForkChildSession, projectInvokingAssistant } from "../../src/forks/session.js";
import { buildForkBoundary } from "../../src/forks/task-prompt.js";

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

test("uses independent child files while retaining the parent session identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  try {
    const first = await createChildSession(manager(root, [entry]), "call-1", "research-1234567");
    const second = await createChildSession(manager(root, [entry]), "call-1", "research-1234567");
    assert.notEqual(first.path, second.path);
    assert.match(first.path, /async-forks\/[0-9a-f-]+\.jsonl$/);
    for (const child of [first, second]) {
      const childEntries = await entries(child.path);
      assert.equal(childEntries[0].id, "parent");
      assert.equal(childEntries[0].parentSession, join(root, "parent.jsonl"));
      assert.equal(childEntries.at(-2).data.sessionId, "parent");
      assert.equal(isForkChildSession({
        getHeader: () => childEntries[0],
        getEntries: () => childEntries.slice(1),
      }), true);
    }
    assert.equal(await readFile(join(root, "parent.jsonl"), "utf8"), "parent\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains identity and child detection when deriving a descendant session directly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  try {
    const child = await createChildSession(manager(root, [entry]), "call-1", "research-1234567");
    const childEntries = await entries(child.path);
    const descendant = await createChildSession({
      getBranch: () => [...childEntries.slice(1), entry],
      getSessionFile: () => child.path,
      getHeader: () => childEntries[0],
    }, "call-1", "research-7654321");
    const descendantEntries = await entries(descendant.path);
    assert.notEqual(descendant.path, child.path);
    assert.equal(descendantEntries[0].id, "parent");
    assert.equal(descendantEntries[0].parentSession, child.path);
    assert.equal(descendantEntries.at(-2).data.sessionId, "parent");
    assert.equal(descendantEntries.at(-2).data.forkId, "research-7654321");
    assert.equal(isForkChildSession({
      getHeader: () => descendantEntries[0],
      getEntries: () => descendantEntries.slice(1),
    }), true);
    assert.deepEqual(await entries(child.path), childEntries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- slim context ---

const systemEntry = {
  type: "message",
  id: "system",
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "system", content: "", sections: { preamble: "Parent prompt." }, toolsAdded: [{ name: "read" }], timestamp: 1 },
};
const parentUser = { type: "message", id: "user", parentId: "system", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "SECRET parent request." } };
const parentReply = { type: "message", id: "reply", parentId: "user", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "SECRET parent reply." }], stopReason: "stop" } };
const invoking = { ...entry, parentId: "reply" };

function assertValidChain(childEntries: any[]) {
  const [header, ...rest] = childEntries;
  assert.equal(header.type, "session");
  assert.equal(rest[0].parentId, null);
  const ids = new Set<string>();
  rest.forEach((child, index) => {
    assert.equal(ids.has(child.id), false, "entry ids are unique");
    if (index > 0) assert.equal(child.parentId, rest[index - 1].id);
    ids.add(child.id);
  });
}

test("slim child holds no parent conversation and has a valid chain from a null root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  try {
    const child = await createChildSession(manager(root, [systemEntry, parentUser, parentReply, invoking]), "call-1", "research-1234567", "slim");
    const raw = await readFile(child.path, "utf8");
    assert.doesNotMatch(raw, /SECRET/);
    assert.doesNotMatch(raw, /I will delegate this/);
    assert.doesNotMatch(raw, /"toolCall"/);
    const childEntries = await entries(child.path);
    assert.deepEqual(childEntries.slice(1).map((value) => value.id === "system" ? "system" : value.type), ["system", "custom", "message"]);
    assertValidChain(childEntries);
    const marker = childEntries.at(-2);
    const boundary = childEntries.at(-1);
    assert.equal(marker.parentId, "system");
    assert.equal(marker.data.sessionId, childEntries[0].id);
    assert.equal(marker.data.forkId, "research-1234567");
    assert.equal(boundary.parentId, marker.id);
    assert.equal(boundary.message.provider, "openai-codex");
    assert.equal(boundary.message.model, "model");
    assert.doesNotMatch(boundary.message.content[0].text, /earlier conversation records work/);
    assert.match(boundary.message.content[0].text, /no earlier conversation/);
    assert.match(boundary.message.content[0].text, /Fork ID: research-1234567$/);
    assert.equal(childEntries[0].parentSession, join(root, "parent.jsonl"));
    assert.equal(isForkChildSession({ getHeader: () => childEntries[0], getEntries: () => childEntries.slice(1) }), true);
    assert.equal(await readFile(join(root, "parent.jsonl"), "utf8"), "parent\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slim child roots the marker at null when the parent has no system entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  try {
    const child = await createChildSession(manager(root, [{ ...parentUser, parentId: null }, parentReply, invoking]), "call-1", "research-1234567", "slim");
    const childEntries = await entries(child.path);
    assert.equal(childEntries.length, 3);
    assert.equal(childEntries[1].type, "custom");
    assert.equal(childEntries[1].parentId, null);
    assertValidChain(childEntries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slim child replays the latest compaction checkpoint plus later system patches only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  const checkpoint = { role: "system", content: "", sections: { preamble: "Checkpoint prompt." }, toolsAdded: [], timestamp: 5 };
  const compaction = { type: "compaction", id: "compaction", parentId: "reply", timestamp: "2026-01-01T00:00:05.000Z", summary: "SECRET summary", firstKeptEntryId: "user", tokensBefore: 10, systemMessage: checkpoint };
  const patch = { type: "message", id: "patch", parentId: "compaction", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "system", content: "", sections: { skills: "later" }, timestamp: 6 } };
  try {
    const child = await createChildSession(manager(root, [systemEntry, parentUser, parentReply, compaction, patch, { ...invoking, parentId: "patch" }]), "call-1", "research-1234567", "slim");
    const raw = await readFile(child.path, "utf8");
    assert.doesNotMatch(raw, /SECRET/);
    assert.doesNotMatch(raw, /Parent prompt\./);
    const childEntries = await entries(child.path);
    const setup = childEntries.slice(1, -2);
    assert.deepEqual(setup.map((value) => value.message.sections), [{ preamble: "Checkpoint prompt." }, { skills: "later" }]);
    assert.equal(childEntries.some((value) => value.type === "compaction"), false);
    assertValidChain(childEntries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slim still fails clearly when the tool call is not on the active branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  try {
    await assert.rejects(() => createChildSession(manager(root, [parentUser]), "call-1", "research-1234567", "slim"), /current tool call is not in the active session branch/);
    await assert.rejects(() => createChildSession(manager(root, [invoking]), "call-1", "research-1234567", "bogus" as any), /Unsupported fork context/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full context stays identical to the pre-slim projection and is the default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-session-"));
  await writeFile(join(root, "parent.jsonl"), "parent\n");
  const branch = [systemEntry, parentUser, parentReply, invoking];
  // Normalise the generated ids and timestamps; everything else must match the original projection.
  const normalise = (childEntries: any[]) => childEntries.slice(1).map((value, index, all) => {
    const { id: _id, timestamp: _timestamp, ...rest } = value;
    if (index === all.length - 1) rest.parentId = "marker";
    if (rest.message?.timestamp) rest.message = { ...rest.message, timestamp: 0 };
    return rest;
  });
  try {
    const implicit = await createChildSession(manager(root, branch), "call-1", "research-1234567");
    const explicit = await createChildSession(manager(root, branch), "call-1", "research-1234567", "full");
    const [a, b] = [await entries(implicit.path), await entries(explicit.path)];
    assert.deepEqual(normalise(a), normalise(b));
    assert.deepEqual(a.slice(1, 5).map((value) => value.id), ["system", "user", "reply", "assistant"]);
    assert.deepEqual(a.slice(1, 4), [systemEntry, parentUser, parentReply]);
    assert.equal(a.at(-3).message.content.some((block: any) => block.type === "toolCall"), false);
    assert.equal(a.at(-2).parentId, "assistant");
    assert.equal(a.at(-1).message.content[0].text, buildForkBoundary("research-1234567"));
    assertValidChain(a);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
