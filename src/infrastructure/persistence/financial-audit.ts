import { IsolationLevel } from "@mikro-orm/core";
import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import {
  ledgerAudit,
  reconstruction,
  type LedgerBalanceRow,
} from "./repositories/ledger-repository";

interface AuditRow extends LedgerBalanceRow {
  currencyMismatch: boolean;
  invalidRelationships: boolean;
  brokenChain: boolean;
  duplicates: boolean;
  missingMovement: boolean;
  unfinishedWager: boolean;
}

interface AuditOptions {
  walletId?: string;
  limit?: number;
  batchSize: number;
  signal: AbortSignal;
}

function readPage(
  em: EntityManager,
  cursor: string | undefined,
  walletId: string | undefined,
  size: number,
) {
  const where = walletId ? "where id = ?" : cursor === undefined ? "" : "where id > ?";
  const key = walletId ?? cursor;
  return em.execute<AuditRow[]>(
    `
    with wallet_page as (
      select id, currency, balance, version from wagering.wallets ${where} order by id limit ?
    )
    select w.id, w.currency, w.balance::text as stored, ledger.reconstructed, ledger.entries,
           ledger.currency_mismatch as "currencyMismatch",
           ledger.invalid_relationships as "invalidRelationships",
           (ledger.broken_chain or coalesce(ledger.last_version, 1) <> w.version) as "brokenChain",
           ledger.duplicates,
           exists (
             select from wagering.wager_transactions t
             where t.wallet_id = w.id and t.status = 'PROCESSED' and t.kind <> 'LOSS'
               and not exists (
                 select from wagering.wallet_ledger_entries e where e.wallet_id = w.id and e.transaction_id = t.id
               )
           ) as "missingMovement",
           exists (
             select from wagering.wager_transactions t
             where t.wallet_id = w.id and t.status in ('PENDING', 'FAILED')
           ) as "unfinishedWager"
    from wallet_page w
    cross join lateral (
      select ${reconstruction}, max(e.wallet_version) as last_version,
             coalesce(bool_or(e.currency <> w.currency), false) as currency_mismatch,
             coalesce(bool_or(t.id is null or t.wallet_id <> w.id or t.status <> 'PROCESSED'
               or t.kind = 'LOSS' or t.currency <> e.currency or t.amount <> e.amount
               or row(t.result_balance, t.result_wallet_version, t.processed_at)
                    is distinct from row(e.balance_after, e.wallet_version, e.created_at)), false) as invalid_relationships,
             coalesce(bool_or(e.balance_before <> coalesce(e.previous_balance, 0)
               or e.wallet_version <> coalesce(e.previous_version::bigint + 1,
                    case when t.kind = 'OPENING' then 1 else 2 end)), false) as broken_chain,
             (count(e.id) <> count(distinct e.transaction_id)
               or count(e.id) <> count(distinct e.wallet_version)) as duplicates
      from (
        select entry.*, lag(balance_after) over versions as previous_balance,
               lag(wallet_version) over versions as previous_version
        from wagering.wallet_ledger_entries entry
        where entry.wallet_id = w.id
        window versions as (order by wallet_version, id)
      ) e
      left join wagering.wager_transactions t on t.id = e.transaction_id
    ) ledger
    order by w.id
  `,
    key === undefined ? [size] : [key, size],
  );
}

export async function auditWallets(
  orm: MikroORM,
  { batchSize, limit, walletId, signal }: AuditOptions,
  onAnomaly: (walletId: string, codes: readonly string[]) => void,
) {
  return orm.em.fork().transactional(
    async (em) => {
      await em.execute("set transaction read only");
      const summary = { walletsChecked: 0, inconsistent: 0, ledgerEntriesChecked: 0n };
      let cursor: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const size = Math.min(batchSize, (limit ?? Infinity) - summary.walletsChecked);
        if (size === 0) break;
        const page = await readPage(em, cursor, walletId, size);
        signal.throwIfAborted();
        if (walletId && page.length === 0) throw new Error("Requested wallet does not exist");
        for (const row of page) {
          const { checkedEntries, consistent } = ledgerAudit(row);
          const anomalies = {
            BALANCE_DIVERGENCE: !consistent,
            CURRENCY_MISMATCH: row.currencyMismatch,
            INVALID_LEDGER_RELATIONSHIP: row.invalidRelationships,
            BROKEN_LEDGER_CHAIN: row.brokenChain,
            DUPLICATE_LEDGER_ENTRY: row.duplicates,
            MISSING_LEDGER_ENTRY: row.missingMovement,
            UNFINISHED_WAGER: row.unfinishedWager,
          };
          const codes = Object.entries(anomalies)
            .filter(([, found]) => found)
            .map(([code]) => code);
          summary.walletsChecked++;
          summary.ledgerEntriesChecked += BigInt(checkedEntries);
          if (codes.length) {
            summary.inconsistent++;
            onAnomaly(row.id, codes);
          }
        }
        if (walletId || page.length < size) break;
        cursor = page.at(-1)?.id;
      }
      signal.throwIfAborted();
      return { ...summary, ledgerEntriesChecked: summary.ledgerEntriesChecked.toString() };
    },
    { isolationLevel: IsolationLevel.REPEATABLE_READ },
  );
}
