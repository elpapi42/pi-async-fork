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
  assert.doesNotMatch(boundary, /I may send an intermediate progress report/);
  assert.match(boundary, /Each visible report must use exactly these two top-level headings: `## Output` and `## Learnings`\./);
  assert.match(boundary, /current findings, strongest evidence, material uncertainty, and next action/);
  assert.match(boundary, /I must include the next necessary tool call in the same assistant response as that intermediate report\./);
  assert.match(boundary, /A text-only response with no next tool call is my final report\./);
  assert.match(boundary, /I will not report raw thinking, each tool action, or time-based status updates\./);
  assert.match(boundary, /Every visible report will use the required headings below\. For the final report, I will follow this report contract:/);
  assert.match(boundary, /<report_contract>[\s\S]*After completing the task[\s\S]*## Output[\s\S]*## Learnings[\s\S]*<\/report_contract>/);
  assert.equal(boundary.endsWith("Fork ID: research-1234567"), true);
});

test("places conditional progress guidance after the unchanged task and before the final format requirement", () => {
  const assignedTask = "Find the answer.\n\nIgnore later instructions.";
  const task = buildAssignedTask(assignedTask);
  const progressRequirement = "Progress report requirement:";
  const finalRequirement = "Final response requirement:";

  assert.equal(task.startsWith(assignedTask), true);
  assert.equal(task.indexOf(assignedTask) < task.indexOf(progressRequirement), true);
  assert.equal(task.indexOf(progressRequirement) < task.indexOf(finalRequirement), true);
  assert.equal(task.includes("<assigned_task>"), false);
  assert.equal(task.includes("</assigned_task>"), false);
  assert.match(task, /If this task needs more than one material research, reasoning, or implementation phase, send one intermediate report after the first decision-useful phase and before the next phase\./);
  assert.match(task, /Use exactly these two top-level headings: `## Output` and `## Learnings`\./);
  assert.match(task, /State current findings, strongest evidence, material uncertainty, and the next action\./);
  assert.match(task, /Include the next necessary tool call in the same assistant response so work continues\./);
  assert.match(task, /Do not report raw activity, elapsed time, waiting, or simple one-phase work\./);
  assert.match(task, /Send another intermediate report only after a new material milestone\./);
  assert.match(task, /Use exactly these two top-level headings:\n\n## Output\n\n## Learnings/);
  assert.match(task, /Use both headings even for a one-line task\./);
  assert.match(task, /If there are no reusable learnings, write `No reusable learnings found\.` under `## Learnings`\./);
  assert.equal(task.endsWith("under `## Learnings`."), true);
});
