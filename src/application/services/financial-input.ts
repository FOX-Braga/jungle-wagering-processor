import { Money, type MoneyProps } from "../../domain/money/money";
import { DomainError } from "../../domain/shared/domain-errors";
import type { EventTrace } from "../commands/financial-commands";
import { ApplicationError } from "../errors/application-error";

export function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ApplicationError("INVALID_COMMAND", `${field} must be a non-empty identifier`);
  }
  return value;
}

export function traceIdentifiers(trace: EventTrace): void {
  if (trace.correlationId !== undefined) identifier(trace.correlationId, "correlationId");
  if (trace.causationId !== undefined) identifier(trace.causationId, "causationId");
}

export function commandMoney(props: MoneyProps): Money {
  if (!props || typeof props !== "object") {
    throw new ApplicationError("INVALID_COMMAND", "A monetary value is required");
  }
  const money = validateDomain(() => Money.from(props));
  if (money.toString().length > 39) {
    throw new ApplicationError(
      "INVALID_COMMAND",
      "Money exceeds the supported persistence precision",
    );
  }
  return money;
}

export function validateDomain<T>(factory: () => T): T {
  try {
    return factory();
  } catch (error) {
    if (error instanceof DomainError) {
      throw new ApplicationError("INVALID_COMMAND", error.message, error);
    }
    throw error;
  }
}
