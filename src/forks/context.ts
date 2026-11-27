export const CONTEXTS = ["full", "slim"] as const;
export type ForkContext = (typeof CONTEXTS)[number];
export const DEFAULT_CONTEXT: ForkContext = "full";

export function isForkContext(value: unknown): value is ForkContext {
  return typeof value === "string" && (CONTEXTS as readonly string[]).includes(value);
}
