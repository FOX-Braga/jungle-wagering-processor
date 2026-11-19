import { IsolationLevel } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AsyncLocalStorage } from "node:async_hooks";
import type { FinancialRepositories } from "../../../application/ports/repositories/financial-repositories";
import {
  PersistenceConflictError,
  PersistenceUniqueError,
  type TransactionManager,
} from "../../../application/ports/transaction-manager";
import { operationMetrics } from "../../observability/metrics";
import { MikroLedgerRepository } from "../repositories/ledger-repository";
import {
  MikroInboxRepository,
  MikroOutboxRepository,
} from "../repositories/messaging-repositories";
import { MikroWagerRepository } from "../repositories/wager-repository";
import { MikroWalletRepository } from "../repositories/wallet-repository";
import { normalizePersistenceError } from "./persistence-errors";

export class MikroTransactionManager implements TransactionManager {
  private readonly active = new AsyncLocalStorage<true>();

  constructor(private readonly orm: MikroORM) {}

  async execute<T>(
    work: (repositories: FinancialRepositories) => Promise<T>,
    {
      lockTimeoutMs = 1_000,
      readOnly = false,
    }: { readonly lockTimeoutMs?: number; readonly readOnly?: boolean } = {},
  ): Promise<T> {
    if (this.active.getStore()) throw new Error("Reuse the repositories of the active transaction");
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1 || lockTimeoutMs > 1_200) {
      throw new RangeError("lockTimeoutMs must be between 1 and 1200");
    }

    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          if (readOnly) await em.execute("set transaction read only");
          await em.execute("select set_config('lock_timeout', ?, true)", [`${lockTimeoutMs}ms`]);
          const ledger = new MikroLedgerRepository(em);
          return this.active.run(true, () =>
            work({
              ledger,
              wallets: new MikroWalletRepository(em, ledger),
              wagers: new MikroWagerRepository(em),
              inbox: new MikroInboxRepository(em),
              outbox: new MikroOutboxRepository(em),
            }),
          );
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      const failure = normalizePersistenceError(error);
      const observation = operationMetrics.getStore();
      if (failure instanceof PersistenceConflictError) {
        observation?.metrics.record("wager_wallet_lock_conflicts_total", 1, failure.reason);
      } else if (
        observation &&
        failure instanceof PersistenceUniqueError &&
        ["wager-idempotency", "wager-external", "inbox-message"].includes(failure.resource)
      ) {
        observation.metrics.record("wager_processing_retries_total", 1, observation.source);
      }
      throw failure;
    }
  }
}
