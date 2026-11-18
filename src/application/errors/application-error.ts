export type ApplicationErrorCode =
  | "INVALID_COMMAND"
  | "INVALID_CURSOR"
  | "WALLET_NOT_FOUND"
  | "WALLET_OWNERSHIP_MISMATCH"
  | "WALLET_ALREADY_EXISTS"
  | "WAGER_NOT_FOUND"
  | "WAGER_NOT_PENDING"
  | "IDEMPOTENCY_CONFLICT"
  | "EXTERNAL_TRANSACTION_CONFLICT"
  | "INBOX_CONFLICT"
  | "HISTORICAL_RESULT_UNAVAILABLE";

export class ApplicationError extends Error {
  constructor(
    public readonly code: ApplicationErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ApplicationError";
  }
}
