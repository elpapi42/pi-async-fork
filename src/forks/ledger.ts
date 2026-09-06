import type { Tier } from "../configuration.js";
import { validateDescription } from "./identity.js";

export const ENTRY_TYPE = "pi-async-fork";
export const RESULT_TYPE = "pi-async-fork-result";

export type Created = {
  type: "fork.created";
  forkId: string;
  agentId: string;
  agentName: string;
  stateDir?: string;
  sessionPath: string;
  tier: Tier;
  triggerTurn?: boolean;
  description?: string;
};

export type Destroyed = {
  type: "fork.destroyed";
  forkId: string;
  agentId: string;
  kind: "response" | "notice";
  output: string;
  cursor?: string;
};

export type LifecycleRecord = Created | Destroyed;
export type ManagedFork = Created & { destroyed?: Destroyed };

function hasValidDescription(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    return validateDescription(value) === value;
  } catch {
    return false;
  }
}

function isLifecycleRecord(value: unknown): value is LifecycleRecord {
  if (!value || typeof value !== "object") return false;
  const raw = value as globalThis.Record<string, unknown>;
  if (raw.type === "fork.created") {
    return typeof raw.forkId === "string"
      && typeof raw.agentId === "string"
      && typeof raw.agentName === "string"
      && (raw.stateDir === undefined || typeof raw.stateDir === "string")
      && typeof raw.sessionPath === "string"
      && (raw.tier === "fast" || raw.tier === "balanced" || raw.tier === "deep")
      && (raw.triggerTurn === undefined || typeof raw.triggerTurn === "boolean")
      && hasValidDescription(raw.description);
  }
  return raw.type === "fork.destroyed"
    && typeof raw.forkId === "string"
    && typeof raw.agentId === "string"
    && (raw.kind === "response" || raw.kind === "notice")
    && typeof raw.output === "string"
    && (raw.cursor === undefined || typeof raw.cursor === "string");
}

function customData(entry: any): LifecycleRecord | undefined {
  return entry?.type === "custom" && entry.customType === ENTRY_TYPE && isLifecycleRecord(entry.data) ? entry.data : undefined;
}

export function project(entries: readonly any[]): Map<string, ManagedFork> {
  const forks = new Map<string, ManagedFork>();
  for (const entry of entries) {
    const data = customData(entry);
    if (!data) continue;
    if (data.type === "fork.created") forks.set(data.forkId, data);
    if (data.type === "fork.destroyed") {
      const created = forks.get(data.forkId);
      if (created && created.agentId === data.agentId) forks.set(data.forkId, { ...created, destroyed: data });
    }
  }
  return forks;
}

export function active(entries: readonly any[]): Map<string, Created> {
  return new Map([...project(entries)].flatMap(([id, fork]) => fork.destroyed ? [] : [[id, fork] as [string, Created]]));
}

export function appendCreated(pi: any, record: Created): void {
  pi.appendEntry(ENTRY_TYPE, record);
}

export function appendDestroyed(pi: any, record: Destroyed): void {
  pi.appendEntry(ENTRY_TYPE, record);
}

export function isDelivered(entries: readonly any[], forkId: string, agentId: string, cursor: string | undefined): boolean {
  return entries.some((entry) => {
    if (entry?.type !== "custom_message" || entry.customType !== RESULT_TYPE) return false;
    const details = entry.details;
    return details?.forkId === forkId && details?.agentId === agentId && details?.cursor === cursor;
  });
}
