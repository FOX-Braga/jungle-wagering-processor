import type { MikroORM } from "@mikro-orm/postgresql";

export async function walletEffects(orm: MikroORM, walletId: string) {
  const [result] = await orm.em.getConnection().execute<
    {
      wagers: number;
      debit: number;
      credit: number;
      events: number;
    }[]
  >(
    `
    select
      (select count(*)::int from wagering.wager_transactions where wallet_id = ?) as wagers,
      (select count(*)::int from wagering.wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT') as debit,
      (select count(*)::int from wagering.wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT') as credit,
      (select count(*)::int from wagering.outbox_messages where payload->'data'->>'walletId' = ?) as events
  `,
    [walletId, walletId, walletId, walletId],
  );
  return result;
}

export async function countTransactionEvents(orm: MikroORM, transactionId: string) {
  const rows = await orm.em.getConnection().execute<{ event_type: string; correlation: string }[]>(
    `
    select event_type, payload->>'correlationId' as correlation
    from wagering.outbox_messages
    where payload->'data'->>'transactionId' = ?
    order by event_type
  `,
    [transactionId],
  );
  return rows;
}
