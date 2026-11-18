import type { FinancialRepositories } from "./repositories/financial-repositories";

export const TRANSACTION_MANAGER = Symbol("TRANSACTION_MANAGER");

export interface TransactionManager {
  execute<T>(
    work: (repositories: FinancialRepositories) => Promise<T>,
    options?: { readonly lockTimeoutMs?: number },
  ): Promise<T>;
}

export type UniqueResource =
  "wallet-player-currency" | "wager-idempotency" | "wager-external" | "inbox-message";

export class PersistenceUniqueError extends Error {
  constructor(
    public readonly resource: UniqueResource,
    cause: unknown,
  ) {
    super(resource, { cause });
    this.name = "PersistenceUniqueError";
  }
}

export class PersistenceUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Persistence temporarily unavailable", { cause });
    this.name = "PersistenceUnavailableError";
  }
}

export class PersistenceConflictError extends Error {
  constructor(
    public readonly reason: "LOCK_TIMEOUT" | "DEADLOCK" | "SERIALIZATION_FAILURE",
    cause: unknown,
  ) {
    super(reason, { cause });
    this.name = "PersistenceConflictError";
  }
}
