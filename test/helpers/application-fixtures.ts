import type { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import type { ProcessWagerCommand } from "../../src/application/commands/financial-commands";
import type { FinancialRuntime } from "../../src/application/ports/financial-runtime";
import type { FinancialRepositories } from "../../src/application/ports/repositories/financial-repositories";
import type { TransactionManager } from "../../src/application/ports/transaction-manager";
import type { WalletResult } from "../../src/application/results/financial-results";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet.use-case";
import {
  GetProviderWagerTransactionUseCase,
  GetWagerTransactionUseCase,
  GetWalletLedgerUseCase,
  GetWalletUseCase,
} from "../../src/application/use-cases/financial-queries";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { MikroTransactionManager } from "../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { at } from "./domain";

export const financeRuntime: FinancialRuntime = {
  clock: { now: () => at() },
  ids: { next: randomUUID },
};

export function financialApplication(
  orm: MikroORM,
  manager: TransactionManager = new MikroTransactionManager(orm),
) {
  const create = new CreateWalletUseCase(manager, financeRuntime);
  return {
    create,
    process: new ProcessWagerTransactionUseCase(manager, financeRuntime),
    wallet: new GetWalletUseCase(manager),
    ledger: new GetWalletLedgerUseCase(manager),
    wager: new GetWagerTransactionUseCase(manager),
    providerWager: new GetProviderWagerTransactionUseCase(manager),
    manager,
    open(amount = "100.00", currency = "BRL") {
      return create.execute({ playerId: randomUUID(), initialBalance: { amount, currency } });
    },
  };
}

export function command(
  wallet: WalletResult,
  kind = Kind.Bet,
  amount = "25.00",
  overrides: Partial<ProcessWagerCommand> = {},
): ProcessWagerCommand {
  const id = randomUUID();
  return {
    providerId: "provider",
    externalTransactionId: id,
    idempotencyKey: `provider:${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round",
    gameId: "game",
    kind,
    money: { amount, currency: wallet.currency },
    ...overrides,
  };
}

export function replaceMethod<T extends object, K extends keyof T>(
  target: T,
  method: K,
  replacement: T[K],
): T {
  return new Proxy(target, {
    get(base, key, receiver): unknown {
      if (key === method) return replacement;
      const value: unknown = Reflect.get(base, key, receiver);
      return typeof value === "function" ? value.bind(base) : value;
    },
  });
}

export function instrumentTransactions(
  delegate: TransactionManager,
  replace: (repos: FinancialRepositories) => FinancialRepositories,
  beforeCommit?: () => void,
): TransactionManager {
  return {
    execute<T>(
      work: (repos: FinancialRepositories) => Promise<T>,
      options?: { readonly lockTimeoutMs?: number },
    ) {
      return delegate.execute(async (repos) => {
        const result = await work(replace(repos));
        beforeCommit?.();
        return result;
      }, options);
    },
  };
}

export function barrier() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
