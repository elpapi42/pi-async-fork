import assert from "node:assert/strict";
import test from "node:test";
import { createId, formatId, validateDescription, validateName } from "../../src/forks/identity.js";

test("accepts one or two semantic words and rejects agent-supplied numbering", () => {
  for (const name of ["research", "window-researcher", "api-review"]) assert.doesNotThrow(() => validateName(name));
  for (const name of ["researcher-1", "researcher1", "window-api-review", "window_researcher", "-research", "research-"]) {
    assert.throws(() => validateName(name));
  }
});

test("accepts a trimmed three-to-six-word purpose description", () => {
  assert.equal(validateDescription("  Trace login session validation  "), "Trace login session validation");
  assert.equal(validateDescription("Review every active API authorization boundary"), "Review every active API authorization boundary");
});

test("rejects invalid purpose descriptions", () => {
  for (const description of [
    "Only two",
    "This purpose has seven separate words now",
    "Trace login\nsession validation",
    "Trace login\u2028session validation",
    "Trace login\u0085session validation",
  ]) assert.throws(() => validateDescription(description));
});

test("formats a zero-padded seven-digit suffix", () => {
  assert.equal(formatId("research", 42), "research-0000042");
});

test("creates one valid candidate for controller collision handling", () => {
  const id = createId("research");
  assert.match(id, /^research-\d{7}$/);
});
