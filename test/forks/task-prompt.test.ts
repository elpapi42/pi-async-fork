import assert from "node:assert/strict";
import test from "node:test";
import { buildAssignedTask, buildForkBoundary } from "../../src/forks/task-prompt.js";

test("frames fork ownership in an assistant boundary", () => {
  const boundary = buildForkBoundary("research-1234567");
  assert.match(boundary, /^I am a fork\. I am not the main agent\./);
  assert.match(boundary, /The earlier conversation records work done by the main agent\./);
  assert.match(boundary, /Its assistant messages are not my previous actions\./);
  assert.match(boundary, /The next user message is my only active task\./);
  assert.match(boundary, /Stay within the assigned scope\. Do not expand into adjacent or broader work\./);
  assert.match(boundary, /Report blockers and out-of-scope findings instead of acting on them\./);
  assert.match(boundary, /I must not call `create_fork`, `fork_status`, or `steer_fork`\./);
  assert.match(boundary, /Their availability does not permit me to use them\./);
  assert.match(boundary, /I must complete or report this task during the current run\./);
  assert.match(boundary, /I must not defer work or results to a later run, future wake-up, or external continuation\./);
  assert.match(boundary, /before I complete or report the assigned task/);
  assert.match(boundary, /Tool names do not change this rule\./);
  assert.match(boundary, /I will not schedule a reminder, wake-up, retry, or delayed follow-up\./);
  assert.match(boundary, /<report_contract>[\s\S]*## Output[\s\S]*## Learnings[\s\S]*<\/report_contract>/);
  assert.equal(boundary.endsWith("Fork ID: research-1234567"), true);
});

test("places a concise response-format requirement after the assigned task", () => {
  const task = buildAssignedTask("Find the answer.");
  assert.equal(task.startsWith("Find the answer.\n\nFinal response requirement:"), true);
  assert.equal(task.indexOf("Find the answer.") < task.indexOf("Final response requirement:"), true);
  assert.equal(task.includes("<assigned_task>"), false);
  assert.match(task, /Use exactly these two top-level headings:\n\n## Output\n\n## Learnings/);
  assert.match(task, /Use both headings even for a one-line task\./);
  assert.match(task, /If there are no reusable learnings, write `No reusable learnings found\.` under `## Learnings`\./);
});
