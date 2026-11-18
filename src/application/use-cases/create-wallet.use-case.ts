import { openWallet } from "../../domain/wagering/open-wallet";
import type { CreateWalletCommand } from "../commands/financial-commands";
import { ApplicationError } from "../errors/application-error";
import type { FinancialRuntime } from "../ports/financial-runtime";
import { PersistenceUniqueError, type TransactionManager } from "../ports/transaction-manager";
import { walletResult, walletSnapshot, type WalletResult } from "../results/financial-results";
import { hashOpeningPayload } from "../services/canonical-wager";
import { enqueueWagerEvents } from "../services/financial-events";
import { commandMoney, identifier, traceIdentifiers } from "../services/financial-input";

export class CreateWalletUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly runtime: FinancialRuntime,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletResult> {
    const playerId = identifier(command.playerId, "playerId");
    const initialBalance = commandMoney(command.initialBalance);
    traceIdentifiers(command);
    const { clock, ids } = this.runtime;
    const journal = initialBalance.isZero()
      ? undefined
      : {
          transactionId: ids.next(),
          ledgerEntryId: ids.next(),
          payloadHash: await hashOpeningPayload(playerId, initialBalance.toJSON()),
        };
    const at = clock.now();
    const { wallet, opening } = openWallet(
      { id: ids.next(), playerId, initialBalance, createdAt: at },
      journal,
    );

    try {
      return await this.transactions.execute(async (repos) => {
        await repos.wallets.insertBaseline(wallet);
        if (opening) {
          const { transaction, ledgerEntry } = opening;
          await repos.wagers.insert(transaction, { updatedAt: at, result: walletSnapshot(wallet) });
          await repos.wallets.saveMovement(wallet, ledgerEntry);
          await enqueueWagerEvents(repos.outbox, transaction, ledgerEntry, at, command, ids);
        }
        return walletResult(wallet);
      });
    } catch (error) {
      if (error instanceof PersistenceUniqueError && error.resource === "wallet-player-currency") {
        throw new ApplicationError(
          "WALLET_ALREADY_EXISTS",
          "A wallet already exists for this player and currency",
          error,
        );
      }
      throw error;
    }
  }
}
