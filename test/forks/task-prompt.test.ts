import assert from "node:assert/strict";
import test from "node:test";
import { buildForkBoundary } from "../../src/forks/task-prompt.js";

test("frames fork ownership in an assistant boundary and sends only the task as user content", () => {
  const boundary = buildForkBoundary("research-1234567");
  assert.match(boundary, /^I am now operating as a bounded fork\. I am not the main agent\./);
  assert.match(boundary, /The earlier conversation records work done by the main agent\./);
  assert.match(boundary, /Its assistant messages are not my previous actions\./);
  assert.match(boundary, /The next user message is my only active task\./);
  assert.match(boundary, /I must not call `create_fork`, `fork_status`, or `steer_fork`\./);
  assert.match(boundary, /Their availability does not permit me to use them\./);
  assert.match(boundary, /<report_contract>[\s\S]*## Output[\s\S]*## Learnings[\s\S]*<\/report_contract>/);
  assert.equal(boundary.endsWith("Fork ID: research-1234567"), true);
});
