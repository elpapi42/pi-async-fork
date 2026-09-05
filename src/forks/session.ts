import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ChildSession = { path: string };

function hasToolCall(message: any, toolCallId: string): boolean {
  return message?.role === "assistant" && Array.isArray(message.content)
    && message.content.some((block: any) => block?.type === "toolCall" && block.id === toolCallId);
}

export function projectInvokingAssistant(entry: any): any | undefined {
  const message = entry.message;
  const content = message.content.filter((block: any) => block?.type !== "toolCall");
  const hasText = content.some((block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim());
  if (!hasText) return undefined;
  return {
    ...entry,
    message: {
      ...message,
      content,
      stopReason: message.stopReason === "toolUse" ? "stop" : message.stopReason,
    },
  };
}

export async function createChildSession(sessionManager: any, toolCallId: string): Promise<ChildSession> {
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
  const projected = [...branch.slice(0, boundary)];
  const assistant = projectInvokingAssistant(branch[boundary]);
  if (assistant) projected.push(assistant);

  const directory = join(dirname(parentPath), "async-forks");
  const sessionId = randomUUID();
  const path = join(directory, `${sessionId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const childHeader = { ...header, id: sessionId, parentSession: parentPath };
  await writeFile(path, `${[childHeader, ...projected].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
  return { path };
}

export async function removeChildSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
