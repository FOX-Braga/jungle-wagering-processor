import { DomainInvariantError } from "./domain-errors";
import type { FailureCode } from "./failure-code";

export function requireFields(code: FailureCode, fields: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new DomainInvariantError(code, `${key} must be a non-empty string`);
    }
  }
}

export function timestamp(date: Date, code: FailureCode, earliest = -Infinity): number {
  const value = date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(value) || value < earliest) {
    throw new DomainInvariantError(code, "Invalid or out-of-order timestamp");
  }
  return value;
}
