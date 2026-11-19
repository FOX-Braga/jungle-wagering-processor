import { expect, test } from "bun:test";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { readDatabaseBacklog } from "../../src/infrastructure/observability/backlog";
import { launchApi } from "../helpers/api-process";
import { command, type Wager } from "../helpers/http-client";
import { walletEffects } from "../helpers/http-database";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("restarts API and workers against the same state and completes pending financial work", async () => {
  const f = await messagingFixture();
  const apis: Awaited<ReturnType<typeof launchApi>>[] = [];
  try {
    const original = await launchApi(f.database.url, "restart-original");
    apis.push(original);
    const opening = await original.client.open();
    expect(opening.status).toBe(201);
    const wallet = opening.body;
    const consumer = await f.start("consumer");
    const bet = command(wallet);
    const initial = await original.client.wager(bet);
    expect(initial.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00" },
      idempotentReplay: false,
    });

    async function deliver(wager: Wager, worker: typeof consumer) {
      const messageId = crypto.randomUUID();
      await f.send(
        {
          ...wager,
          idempotencyKey: `${wager.providerId}:${wager.externalTransactionId}`,
        },
        messageId,
      );
      await worker.waitLog("acknowledged", (log) => log.messageId === messageId);
    }

    await deliver(command(wallet, Kind.Win, "50.00"), consumer);
    const lateBet = command(wallet);
    const refund = command(wallet, Kind.Refund, "25.00", lateBet.externalTransactionId);
    await deliver(refund, consumer);
    const pending = await original.client.providerTransaction(
      refund.providerId,
      refund.externalTransactionId,
    );
    expect(pending.body).toMatchObject({ status: "PENDING_REFERENCE" });

    const publisher = await f.start("outbox", "before-send", { OUTBOX_BATCH_SIZE: 1 });
    await publisher.waitLog("before-send");
    expect(await f.receive(f.events)).toBeUndefined();
    await Promise.all([consumer.kill(), publisher.kill(), original.stop()]);

    const restarted = await launchApi(f.database.url, "restart-replacement");
    apis.push(restarted);
    expect(restarted.pid).not.toBe(original.pid);
    const replacement = await f.start("consumer");
    await deliver(lateBet, replacement);
    const references = await f.start("references");
    await references.waitLog(
      "reference_finalized",
      (log) => log.transactionId === pending.body.transactionId,
    );
    expect((await restarted.client.transaction(pending.body.transactionId)).body).toMatchObject({
      status: "PROCESSED",
    });
    const replay = await restarted.client.wager(bet);
    expect(replay.body).toEqual({ ...initial.body, idempotentReplay: true });
    const secondPublisher = await f.start("outbox");
    expect(secondPublisher.pid).not.toBe(publisher.pid);
    await waitFor(
      async () => {
        const state = await readDatabaseBacklog(f.database.orm, f.config.OUTBOX_MAX_ATTEMPTS);
        return state.outbox.unpublished === 0 ? true : undefined;
      },
      "all committed events published",
      15_000,
    );
    expect(await walletEffects(f.database.orm, wallet.id)).toEqual({
      wagers: 5,
      debit: 2,
      credit: 3,
      events: 11,
    });
    expect((await restarted.client.reconcile(wallet.id)).body).toMatchObject({
      consistent: true,
      checkedEntries: 5,
      storedBalance: { amount: "125.00" },
      difference: { amount: "0.00" },
    });
  } finally {
    try {
      await Promise.all(apis.map((api) => api.stop()));
    } finally {
      await f.close();
    }
  }
}, 45_000);
