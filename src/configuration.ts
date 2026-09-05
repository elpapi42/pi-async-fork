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
  profiles: Record<Tier, TierProfile>;
};

type RawConfiguration = {
  agentDir?: unknown;
  stateDir?: unknown;
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

  const profiles = {} as Record<Tier, TierProfile>;
  for (const tier of TIERS) {
    profiles[tier] = profile(project[tier], projectFile, tier) ?? profile(global[tier], globalFile, tier)
      ?? (() => { throw new Error(`pi-async-fork.${tier} is required in global or project settings.`); })();
  }
  return { agentDir, stateDir, profiles };
}
