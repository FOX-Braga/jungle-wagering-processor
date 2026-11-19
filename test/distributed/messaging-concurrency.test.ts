import { expect, test } from "bun:test";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { command } from "../helpers/application-fixtures";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("three independent consumers process in parallel and fifty distinct deliveries debit once", async () => {
  const f = await messagingFixture({ visibility: 5 });
  try {
    const wallets = await Promise.all([f.app.open(), f.app.open(), f.app.open()]);
    const consumers = await Promise.all([
      f.start("consumer", "slow-commit"),
      f.start("consumer", "slow-commit"),
      f.start("consumer", "slow-commit"),
    ]);
    const distinct = wallets.map((wallet) => command(wallet));
    await Promise.all(distinct.map((wager) => f.send(wager)));
    await Promise.all(consumers.map((consumer) => consumer.waitLog("slow-commit")));
    expect(new Set(consumers.map((consumer) => consumer.pid)).size).toBe(3);
    await Promise.all(consumers.map((consumer) => consumer.release()));
    await Promise.all(consumers.map((consumer) => consumer.waitLog("acknowledged")));
    await Promise.all(consumers.map((consumer) => consumer.kill()));
    for (const wallet of wallets) {
      expect(await f.reconcile.execute(wallet.id)).toMatchObject({
        consistent: true,
        storedBalance: { amount: "75.00" },
      });
    }

    const replayWorkers = await Promise.all([
      f.start("consumer"),
      f.start("consumer"),
      f.start("consumer"),
    ]);
    const wallet = await f.app.open();
    const bet = command(wallet);
    const ids: string[] = Array.from({ length: 50 }, () => crypto.randomUUID());
    // Vary groups to exercise the database independently of FIFO's serialization.
    await Promise.all(ids.map((id) => f.send(bet, id, id)));
    await waitFor(
      () => {
        const logs = replayWorkers
          .flatMap((worker) => worker.logs)
          .filter(
            (log) =>
              log.messageId &&
              ids.includes(log.messageId) &&
              ["acknowledged", "duplicate"].includes(log.result ?? ""),
          );
        return new Set(logs.map((log) => log.messageId)).size === 50 ? logs : undefined;
      },
      "50 ACKs",
      25_000,
    );
    expect(
      replayWorkers.flatMap(({ logs }) => logs).filter(({ result }) => result === "acknowledged"),
    ).toHaveLength(1);
    const rows = await f.database.orm.em.getConnection().execute<{ receipts: number }[]>(
      `select count(*)::int as receipts from wagering.inbox_messages
        where message_id in (${ids.map(() => "?").join(", ")}) and processed_at is not null`,
      ids,
    );
    expect(rows[0]?.receipts).toBe(50);
    const wager = await f.app.providerWager.execute(bet.providerId, bet.externalTransactionId);
    const events = await f.app.manager.execute(({ outbox }) => outbox.findDue(new Date(), 100));
    expect(
      events.filter(({ payload }) => payload.aggregateId === wager.transactionId),
    ).toHaveLength(1);
    expect(
      events.filter(
        ({ payload }) =>
          payload.aggregateId === wallet.id && payload.eventType === "WalletBalanceChanged",
      ),
    ).toHaveLength(2);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
      calculatedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
  }
}, 65_000);

test("three consumers serialize concurrent identical IDs and distinct BETs across FIFO groups", async () => {
  const f = await messagingFixture({ visibility: 5, maxReceives: 5 });
  try {
    const wallet = await f.app.open();
    const bet = command(wallet, Kind.Bet, "80.00");
    const otherBet = command(wallet, Kind.Bet, "80.00");
    const messageId = crypto.randomUUID();
    const otherMessageId = crypto.randomUUID();
    const leader = await f.start("consumer", "slow-commit");
    await f.send(bet, messageId, "group-original");
    await leader.waitLog("slow-commit");
    const followers = await Promise.all([f.start("consumer"), f.start("consumer")]);
    try {
      expect(new Set([leader, ...followers].map(({ pid }) => pid)).size).toBe(3);
      await Promise.all([
        f.send(bet, messageId, "group-repeat"),
        f.send(otherBet, otherMessageId, "group-competing"),
      ]);
      await waitFor(
        async () => {
          const [row] = await f.database.orm.em.getConnection().execute<{ waiters: number }[]>(`
          select count(*)::int as waiters from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update%'
        `);
          return row?.waiters === 2 ? true : undefined;
        },
        "two consumers competing for the same wallet",
        4_000,
      );
    } finally {
      await leader.release();
    }
    await leader.waitLog("acknowledged", (log) => log.messageId === messageId);
    await waitFor(() => {
      const logs = followers.flatMap(({ logs }) => logs);
      return logs.some((log) => log.result === "duplicate" && log.messageId === messageId) &&
        logs.some(
          (log) =>
            log.result === "acknowledged" &&
            log.messageId === otherMessageId &&
            log.code === "INSUFFICIENT_FUNDS",
        )
        ? true
        : undefined;
    }, "replay and persisted rejection");
    const result = await f.app.providerWager.execute(bet.providerId, bet.externalTransactionId);
    const receipts = await f.database.orm.em
      .getConnection()
      .execute<{ transaction_id: string }[]>(
        "select transaction_id from wagering.inbox_messages where message_id = ?",
        [messageId],
      );
    expect(receipts).toEqual([{ transaction_id: result.transactionId }]);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "20.00" },
    });
  } finally {
    await f.close();
  }
}, 30_000);

test("a concurrent duplicate ID with a different wallet rolls back the losing wager and its outbox", async () => {
  const f = await messagingFixture({ visibility: 5, maxReceives: 3 });
  try {
    const [originalWallet, otherWallet] = await Promise.all([f.app.open(), f.app.open()]);
    const first = command(originalWallet);
    const conflicting = command(otherWallet);
    const messageId = crypto.randomUUID();
    const leader = await f.start("consumer", "slow-commit");
    await f.send(first, messageId);
    await leader.waitLog("slow-commit");
    const competitor = await f.start("consumer");
    try {
      await f.send(conflicting, messageId);
      await waitFor(
        async () => {
          const [row] = await f.database.orm.em.getConnection().execute<{ waiting: boolean }[]>(`
          select exists (select from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query ilike '%insert into%inbox_messages%') as waiting
        `);
          return row?.waiting || undefined;
        },
        "contended inbox primary key",
        4_000,
      );
    } finally {
      await leader.release();
    }
    await leader.waitLog("acknowledged");
    await waitFor(
      () =>
        [leader, competitor]
          .flatMap(({ logs }) => logs)
          .find((log) => log.result === "awaiting_dlq" && log.code === "INBOX_CONFLICT"),
      "concurrent identity conflict reaches redrive",
    );
    const dead = await waitFor(() => f.receive(f.dlq), "conflicting delivery on DLQ");
    expect(dead.Body).toContain(conflicting.externalTransactionId);
    const receipts = await f.database.orm.em
      .getConnection()
      .execute<{ transaction_id: string }[]>(
        "select transaction_id from wagering.inbox_messages where message_id = ?",
        [messageId],
      );
    const [winner, effects] = await Promise.all([
      f.app.providerWager.execute(first.providerId, first.externalTransactionId),
      f.app.manager.execute(async ({ wagers, outbox }) => ({
        loser: await wagers.findByIdempotencyKey(conflicting.idempotencyKey),
        events: await outbox.findDue(new Date(), 50),
      })),
    ]);
    expect(receipts).toEqual([{ transaction_id: winner.transactionId }]);
    expect(effects.loser).toBeUndefined();
    expect(
      effects.events.filter(({ payload }) => payload.aggregateId === otherWallet.id),
    ).toHaveLength(1);
    expect(await f.reconcile.execute(originalWallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
    expect(await f.reconcile.execute(otherWallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 1,
      storedBalance: { amount: "100.00" },
    });
  } finally {
    await f.close();
  }
}, 30_000);
