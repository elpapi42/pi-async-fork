import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPrompt } from "../../src/forks/task-prompt.js";

test("places the assigned task after the fork identity and report contract", () => {
  const task = "Inspect this module.";
  const prompt = buildTaskPrompt("research-1234567", task);
  assert.match(prompt, /^Fork ID: research-1234567\n\nYou are a fork\. You are not the main agent\./);
  assert.match(prompt, /Treat the inherited conversation as background context only\./);
  assert.match(prompt, /Do not continue, execute, or answer requests or workflows from that conversation unless the assigned task repeats them\./);
  assert.ok(prompt.indexOf("## Output") < prompt.indexOf("## Assigned task"));
  assert.ok(prompt.indexOf("## Learnings") < prompt.indexOf("## Assigned task"));
  assert.equal(prompt.endsWith(`## Assigned task\n\n${task}\n\nComplete only the assigned task above.`), true);
});
