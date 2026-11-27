import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_CONTEXT, isForkContext, type ForkContext } from "./context.js";
import { buildForkBoundary } from "./task-prompt.js";

export type ChildSession = { path: string };

export const FORK_CHILD_ERROR = "This session is an async fork. Async fork tools are unavailable here. Complete the assigned task directly. Do not create, inspect, or steer forks. Return the result using `## Output` and `## Learnings`.";

const CHILD_MARKER_TYPE = "pi-async-fork-child";

export function isForkChildSession(sessionManager: any): boolean {
  const sessionId = sessionManager?.getHeader?.()?.id;
  if (typeof sessionId !== "string" || typeof sessionManager?.getEntries !== "function") return false;
  return sessionManager.getEntries().some((entry: any) => entry?.type === "custom"
    && entry.customType === CHILD_MARKER_TYPE
    && entry.data?.version === 1
    && entry.data?.sessionId === sessionId);
}

export function assertForkToolsAvailable(sessionManager: any): void {
  if (isForkChildSession(sessionManager)) throw new Error(FORK_CHILD_ERROR);
}

function createForkChildMarker(parentId: string | null | undefined, sessionId: string, forkId: string): any {
  return {
    type: "custom",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    customType: CHILD_MARKER_TYPE,
    data: { version: 1, sessionId, forkId },
  };
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function hasToolCall(message: any, toolCallId: string): boolean {
  return message?.role === "assistant" && Array.isArray(message.content)
    && message.content.some((block: any) => block?.type === "toolCall" && block.id === toolCallId);
}

export function projectInvokingAssistant(entry: any): any | undefined {
  const message = entry.message;
  const content = message.content.filter((block: any) => block?.type !== "toolCall");
  if (content.length === 0) return undefined;
  return {
    ...entry,
    message: {
      ...message,
      content,
      stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
    },
  };
}

export function createForkBoundary(entry: any, parentId: string | null | undefined, forkId: string, context: ForkContext = DEFAULT_CONTEXT): any {
  const timestamp = Date.now();
  const message = { ...entry.message };
  delete message.responseId;
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: {
      ...message,
      role: "assistant",
      content: [{ type: "text", text: buildForkBoundary(forkId, context) }],
      stopReason: "stop",
      timestamp,
      usage: zeroUsage(),
    },
  };
}

function isSystemMessage(entry: any): boolean {
  return entry?.type === "message" && entry.message?.role === "system";
}

/**
 * Slim children keep the parent's prompt and tool loadout but none of its conversation.
 * Pi persists both as system-role message entries, and a compaction entry's `systemMessage` is a
 * complete checkpoint that supersedes every earlier system message. Replaying the returned entries
 * in order yields the parent's current prompt and tools. Entries are re-linked into a fresh chain
 * that starts at a null parent.
 */
export function projectSlimSetup(entries: readonly any[]): any[] {
  let start = 0;
  let checkpoint: any;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction" && entries[index].systemMessage) {
      checkpoint = entries[index];
      start = index + 1;
      break;
    }
  }
  const setup: any[] = [];
  if (checkpoint) {
    setup.push({
      type: "message",
      id: randomUUID(),
      parentId: null,
      timestamp: checkpoint.timestamp,
      message: { ...checkpoint.systemMessage },
    });
  }
  for (const entry of entries.slice(start)) if (isSystemMessage(entry)) setup.push({ ...entry });
  let parentId: string | null = null;
  for (const entry of setup) {
    entry.parentId = parentId;
    parentId = entry.id;
  }
  return setup;
}

export async function createChildSession(sessionManager: any, toolCallId: string, forkId: string, context: ForkContext = DEFAULT_CONTEXT): Promise<ChildSession> {
  if (!isForkContext(context)) throw new Error(`Unsupported fork context: ${String(context)}.`);
  const branch = sessionManager.getBranch();
  let boundary = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "message" && hasToolCall(branch[index].message, toolCallId)) {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) throw new Error("Cannot create a fork because its current tool call is not in the active session branch.");

  const parentPath = sessionManager.getSessionFile();
  if (typeof parentPath !== "string" || !parentPath) throw new Error("Cannot create a fork because the parent session has no file path.");
  const header = sessionManager.getHeader();
  const sessionId = header.id;
  const fileId = randomUUID();
  const slim = context === "slim";
  const projected = slim ? projectSlimSetup(branch.slice(0, boundary)) : [...branch.slice(0, boundary)];
  const assistant = slim ? undefined : projectInvokingAssistant(branch[boundary]);
  if (assistant) projected.push(assistant);
  const markerParent = slim ? projected.at(-1)?.id ?? null : assistant?.id ?? branch[boundary].parentId;
  const marker = createForkChildMarker(markerParent, sessionId, forkId);
  projected.push(marker);
  projected.push(createForkBoundary(branch[boundary], marker.id, forkId, context));

  const directory = join(dirname(parentPath), "async-forks");
  const path = join(directory, `${fileId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const childHeader = { ...header, id: sessionId, parentSession: parentPath };
  await writeFile(path, `${[childHeader, ...projected].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { path };
}

export async function removeChildSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
