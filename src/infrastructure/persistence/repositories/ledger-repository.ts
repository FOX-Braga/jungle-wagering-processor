import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  LedgerAudit,
  LedgerRepository,
} from "../../../application/ports/repositories/financial-repositories";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { LedgerRow } from "../entities/financial-entities";
import { ledgerRow, toLedger } from "../mappers/financial-mappers";
import { fromStoredMoney } from "../types/exact-numeric";
import { pageLimit } from "./page-limit";

export interface LedgerBalanceRow {
  id: string;
  currency: string;
  stored: string;
  reconstructed: string;
  entries: string;
}

export function ledgerAudit(row: LedgerBalanceRow): LedgerAudit {
  const storedBalance = fromStoredMoney(row.stored, row.currency);
  const calculatedBalance = fromStoredMoney(row.reconstructed, row.currency);
  const difference = storedBalance.subtract(calculatedBalance);
  const checkedEntries = Number(row.entries);
  if (!Number.isSafeInteger(checkedEntries)) {
    throw new RangeError("Ledger count exceeds the safe integer range");
  }
  return {
    walletId: row.id,
    storedBalance,
    calculatedBalance,
    difference,
    consistent: difference.isZero(),
    checkedEntries,
  };
}

export const reconstruction = `
  coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::text as reconstructed,
  count(e.id)::text as entries
`;

export class MikroLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerRow, ledgerRow(entry));
  }

  async findByTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined> {
    const row = await this.em.findOne(LedgerRow, { walletId, transactionId });
    return row ? toLedger(row) : undefined;
  }

  async findByWalletVersion(
    walletId: string,
    walletVersion: number,
  ): Promise<WalletLedgerEntry | undefined> {
    const row = await this.em.findOne(LedgerRow, { walletId, walletVersion });
    return row ? toLedger(row) : undefined;
  }

  async listByWallet(
    walletId: string,
    { limit, afterVersion = 0 }: { limit: number; afterVersion?: number },
  ): Promise<WalletLedgerEntry[]> {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0)
      throw new RangeError("Invalid ledger cursor");
    const rows = await this.em.find(
      LedgerRow,
      { walletId, walletVersion: { $gt: afterVersion } },
      {
        limit: pageLimit(limit),
        orderBy: { walletVersion: "asc", id: "asc" },
      },
    );
    return rows.map(toLedger);
  }

  async auditBalance(walletId: string): Promise<LedgerAudit | undefined> {
    const [row] = await this.em.execute<LedgerBalanceRow[]>(
      `
      select w.id, w.currency, w.balance::text as stored, ${reconstruction}
      from wagering.wallets w left join wagering.wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.id, w.currency, w.balance
    `,
      [walletId],
    );
    return row ? ledgerAudit(row) : undefined;
  }
}
