import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPrompt } from "../../src/forks/task-prompt.js";

test("places variable fork instructions in the final user prompt", () => {
  const prompt = buildTaskPrompt("research-1234567", "Inspect this module.");
  assert.match(prompt, /Fork ID: research-1234567/);
  assert.match(prompt, /Inspect this module\./);
  assert.match(prompt, /You are a fork\./);
  assert.match(prompt, /## Output/);
  assert.match(prompt, /## Learnings/);
});
