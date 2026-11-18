import { FailureCode, type RejectionCode } from "./failure-code";

export abstract class DomainError extends Error {
  protected constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class DomainInvariantError extends DomainError {
  constructor(code: FailureCode, message: string) {
    super(code, message);
  }
}

export class DomainUsageError extends DomainError {
  constructor(code: FailureCode, message: string) {
    super(code, message);
  }
}

export class BusinessRuleError extends DomainError {
  constructor(
    public override readonly code: RejectionCode,
    message: string,
  ) {
    super(code, message);
  }
}

export class CurrencyMismatchError extends BusinessRuleError {
  constructor(expected: string, received: string) {
    super(FailureCode.CurrencyMismatch, `Expected currency ${expected}, received ${received}`);
  }
}

export class InvalidTransactionStateError extends DomainUsageError {
  constructor(from: string, to: string) {
    super(FailureCode.InvalidTransactionState, `Cannot transition from ${from} to ${to}`);
  }
}
