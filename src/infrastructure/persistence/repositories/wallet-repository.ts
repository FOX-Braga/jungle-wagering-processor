import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerRepository,
  WalletRepository,
} from "../../../application/ports/repositories/financial-repositories";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import type { Wallet } from "../../../domain/wallet/wallet";
import { operationMetrics } from "../../observability/metrics";
import { WalletRow } from "../entities/financial-entities";
import { toWallet, walletBaseline } from "../mappers/financial-mappers";

export class MikroWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly ledger: LedgerRepository,
  ) {}

  async insertBaseline(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRow, walletBaseline(wallet));
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, walletId, { refresh: true });
    return row ? toWallet(row) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRow, { playerId, currency }, { refresh: true });
    return row ? toWallet(row) : undefined;
  }

  async lockById(walletId: string): Promise<Wallet | undefined> {
    const started = performance.now();
    try {
      const row = await this.em.findOne(WalletRow, walletId, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
        refresh: true,
      });
      return row ? toWallet(row) : undefined;
    } finally {
      operationMetrics
        .getStore()
        ?.metrics.record("wager_wallet_lock_wait_seconds", (performance.now() - started) / 1000);
    }
  }

  async saveMovement(wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    if (
      entry.walletId !== wallet.id ||
      entry.walletVersion !== wallet.version ||
      !entry.balanceAfter.equals(wallet.balance) ||
      entry.createdAt.getTime() !== wallet.updatedAt.getTime()
    ) {
      throw new Error("Ledger movement does not match the wallet snapshot");
    }
    await this.ledger.append(entry);
  }
}
