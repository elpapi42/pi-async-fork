import { randomInt } from "node:crypto";

const NAME = /^[a-z]{1,20}(?:-[a-z]{1,20})?$/;
const MAX_NAME_LENGTH = 30;
const UNSAFE_DESCRIPTION_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export const maxIdAttempts = 10;

export function validateName(name: string): void {
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new Error("Fork name must contain one or two lowercase letter-only words, separated by one hyphen when present. Do not add numbers.");
  }
}

export function validateDescription(description: string): string {
  if (UNSAFE_DESCRIPTION_CHARACTER.test(description)) {
    throw new Error("Fork description must not contain control characters or line separators.");
  }
  const normalized = description.trim();
  const words = normalized ? normalized.split(/\s+/) : [];
  if (words.length < 3 || words.length > 6) {
    throw new Error("Fork description must contain 3 to 6 words.");
  }
  return normalized;
}

export function formatId(name: string, suffix: number): string {
  return `${name}-${suffix.toString().padStart(7, "0")}`;
}

export function createId(name: string): string {
  validateName(name);
  return formatId(name, randomInt(0, 10_000_000));
}
