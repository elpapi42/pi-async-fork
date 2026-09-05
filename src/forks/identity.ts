import { randomInt } from "node:crypto";

const NAME = /^[a-z]{1,20}(?:-[a-z]{1,20})?$/;
const MAX_NAME_LENGTH = 30;
export const maxIdAttempts = 10;

export function validateName(name: string): void {
  if (!NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new Error("Fork name must contain one or two lowercase letter-only words, separated by one hyphen when present. Do not add numbers.");
  }
}

export function formatId(name: string, suffix: number): string {
  return `${name}-${suffix.toString().padStart(7, "0")}`;
}

export function createId(name: string): string {
  validateName(name);
  return formatId(name, randomInt(0, 10_000_000));
}
