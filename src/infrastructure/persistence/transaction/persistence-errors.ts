import {
  PersistenceConflictError,
  PersistenceUnavailableError,
  PersistenceUniqueError,
  type UniqueResource,
} from "../../../application/ports/transaction-manager";

class PostgresUniqueError extends PersistenceUniqueError {
  readonly code = "23505";

  constructor(
    resource: UniqueResource,
    public readonly constraint: string,
    cause: unknown,
  ) {
    super(resource, cause);
  }
}

const uniqueConstraints: Readonly<Record<string, UniqueResource | undefined>> = {
  uq_wallet_player_currency: "wallet-player-currency",
  uq_wager_idempotency: "wager-idempotency",
  uq_wager_provider_external: "wager-external",
  pk_inbox_consumer_message: "inbox-message",
};

const unavailable = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "57014",
]);

export function normalizePersistenceError(error: unknown): unknown {
  if (typeof error !== "object" || !error || !("code" in error) || typeof error.code !== "string")
    return error;
  switch (error.code) {
    case "55P03":
      return new PersistenceConflictError("LOCK_TIMEOUT", error);
    case "40P01":
      return new PersistenceConflictError("DEADLOCK", error);
    case "40001":
      return new PersistenceConflictError("SERIALIZATION_FAILURE", error);
    case "23505": {
      const constraint = "constraint" in error ? error.constraint : undefined;
      const resource =
        typeof constraint === "string" && Object.hasOwn(uniqueConstraints, constraint)
          ? uniqueConstraints[constraint]
          : undefined;
      if (resource && typeof constraint === "string")
        return new PostgresUniqueError(resource, constraint, error);
      return error;
    }
    default:
      return error.code.startsWith("08") || unavailable.has(error.code)
        ? new PersistenceUnavailableError(error)
        : error;
  }
}
