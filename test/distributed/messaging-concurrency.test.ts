import { expect, test } from "bun:test";
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
