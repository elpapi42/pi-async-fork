import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfiguration } from "../src/configuration.js";

const profile = (model: string) => ({ provider: "test", model, thinking: "low" });

test("loads global configuration and replaces whole tiers from project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-async-fork-config-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      "pi-async-fork": { agentDir: "profile", stateDir: "~/fleet", fast: profile("fast"), balanced: profile("balanced"), deep: profile("deep") },
    }));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
      "pi-async-fork": { balanced: profile("project-balanced") },
    }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const config = loadConfiguration(cwd);
    assert.equal(config.agentDir, join(agentDir, "profile"));
    assert.equal(config.stateDir, join(homedir(), "fleet"));
    assert.equal(config.profiles.fast.model, "fast");
    assert.equal(config.profiles.balanced.model, "project-balanced");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
