import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const TIERS = ["fast", "balanced", "deep"] as const;
export type Tier = (typeof TIERS)[number];

export type TierProfile = {
  provider: string;
  model: string;
  thinking: string;
};

export type Configuration = {
  agentDir?: string;
  stateDir?: string;
  env?: Record<string, string>;
  profiles: Record<Tier, TierProfile>;
};

type RawConfiguration = {
  agentDir?: unknown;
  stateDir?: unknown;
  env?: unknown;
  fast?: unknown;
  balanced?: unknown;
  deep?: unknown;
};

function readNamespace(filePath: string): RawConfiguration {
  if (!existsSync(filePath)) return {};
  try {
    const settings = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const value = settings["pi-async-fork"];
    return value && typeof value === "object" && !Array.isArray(value) ? value as RawConfiguration : {};
  } catch (error) {
    throw new Error(`Cannot read pi-async-fork configuration from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolvePath(value: unknown, sourceFile: string, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`pi-async-fork.${key} in ${sourceFile} must be a non-empty string.`);
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(dirname(sourceFile), value);
}

function resolveOptionalPath(value: unknown, sourceFile: string, key: "agentDir" | "stateDir"): string | null | undefined {
  if (value === undefined || value === null) return value;
  return resolvePath(value, sourceFile, key);
}

function profile(value: unknown, sourceFile: string, tier: Tier): TierProfile | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pi-async-fork.${tier} in ${sourceFile} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const fields = ["provider", "model", "thinking"] as const;
  for (const field of fields) {
    if (typeof raw[field] !== "string" || !raw[field].trim()) {
      throw new Error(`pi-async-fork.${tier}.${field} in ${sourceFile} must be a non-empty string.`);
    }
  }
  return { provider: raw.provider as string, model: raw.model as string, thinking: raw.thinking as string };
}

function environment(value: unknown, sourceFile: string, allowNullValues: boolean): Record<string, string | null> | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`pi-async-fork.env in ${sourceFile} must be an object, null, or omitted.`);
  }
  const result = Object.create(null) as Record<string, string | null>;
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.includes("=") || key.includes("\0")) {
      throw new Error(`pi-async-fork.env in ${sourceFile} contains an invalid variable name.`);
    }
    if (key === "PATH" || key === "PI_CODING_AGENT_DIR") {
      throw new Error(`pi-async-fork.env in ${sourceFile} must not override ${key}.`);
    }
    if (entry === null && allowNullValues) {
      Object.defineProperty(result, key, { value: null, enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`pi-async-fork.env in ${sourceFile} must contain only string values.`);
    }
    Object.defineProperty(result, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function mergeEnvironment(globalEnv: Record<string, string | null> | null | undefined, projectEnv: Record<string, string | null> | null | undefined): Record<string, string> | undefined {
  if (projectEnv === null) return undefined;
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(globalEnv ?? {})) {
    if (value !== null) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
  }
  for (const [key, value] of Object.entries(projectEnv ?? {})) {
    if (value === null) delete result[key];
    else Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(result).length ? result : undefined;
}

export function loadConfiguration(cwd: string): Configuration {
  const globalFile = resolve(getAgentDir(), "settings.json");
  const projectFile = resolve(cwd, ".pi", "settings.json");
  const global = readNamespace(globalFile);
  const project = readNamespace(projectFile);

  const projectAgentDir = resolveOptionalPath(project.agentDir, projectFile, "agentDir");
  const globalAgentDir = resolveOptionalPath(global.agentDir, globalFile, "agentDir");
  const agentDir = projectAgentDir === undefined ? globalAgentDir ?? undefined : projectAgentDir ?? undefined;
  const projectStateDir = resolveOptionalPath(project.stateDir, projectFile, "stateDir");
  const globalStateDir = resolveOptionalPath(global.stateDir, globalFile, "stateDir");
  const stateDir = projectStateDir === undefined ? globalStateDir ?? undefined : projectStateDir ?? undefined;
  const env = mergeEnvironment(
    environment(global.env, globalFile, false),
    environment(project.env, projectFile, true),
  );

  const profiles = {} as Record<Tier, TierProfile>;
  for (const tier of TIERS) {
    profiles[tier] = profile(project[tier], projectFile, tier) ?? profile(global[tier], globalFile, tier)
      ?? (() => { throw new Error(`pi-async-fork.${tier} is required in global or project settings.`); })();
  }
  return { agentDir, stateDir, env, profiles };
}
