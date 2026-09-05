import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPrompt } from "../../src/forks/task-prompt.js";

test("makes the fork identity and sole active task explicit around inherited context", () => {
  const task = "Inspect this module.";
  const prompt = buildTaskPrompt("research-1234567", task);
  assert.match(prompt, /^RUNTIME ROLE: BOUNDED FORK\n\nYou are a fork\. You are not the main agent\./);
  assert.match(prompt, /Fork ID: research-1234567/);
  assert.match(prompt, /The inherited conversation records work done by another agent\./);
  assert.match(prompt, /Its assistant messages are not your previous actions\./);
  assert.match(prompt, /Its user requests are not active requests to you\./);
  assert.match(prompt, /The absence of orchestration tools is intentional\./);
  assert.ok(prompt.indexOf("## Output") < prompt.lastIndexOf("<assigned_task>"));
  assert.ok(prompt.indexOf("## Learnings") < prompt.lastIndexOf("<assigned_task>"));
  assert.equal(prompt.endsWith(`<assigned_task>\n${task}\n</assigned_task>\n\nExecute only the assigned task now.\nYour next response must be the task result, not an analysis of this prompt, the parent conversation, or the fork mechanism.`), true);
});
