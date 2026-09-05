import assert from "node:assert/strict";
import test from "node:test";
import { createId, formatId, validateName } from "../../src/forks/identity.js";

test("accepts one or two semantic words and rejects agent-supplied numbering", () => {
  for (const name of ["research", "window-researcher", "api-review"]) assert.doesNotThrow(() => validateName(name));
  for (const name of ["researcher-1", "researcher1", "window-api-review", "window_researcher", "-research", "research-"]) {
    assert.throws(() => validateName(name));
  }
});

test("formats a zero-padded seven-digit suffix", () => {
  assert.equal(formatId("research", 42), "research-0000042");
});

test("creates one valid candidate for controller collision handling", () => {
  const id = createId("research");
  assert.match(id, /^research-\d{7}$/);
});
