import { expect, test } from "bun:test";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { command } from "../helpers/application-fixtures";
import { createDependencyLink } from "../helpers/dependency-link";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("real crash before commit rolls back Inbox, wager, ledger and Outbox before redelivery", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const messageId = crypto.randomUUID();
    const consumer = await f.start("consumer", "before-commit");
    await f.send(bet, messageId);
    await consumer.waitLog("before-commit");
    const snapshot = () =>
      f.app.manager.execute(async ({ inbox, wagers, outbox }) => ({
        receipt: await inbox.find(f.config.SQS_CONSUMER_NAME, messageId),
        wager: await wagers.findByIdempotencyKey(bet.idempotencyKey),
        events: await outbox.findDue(new Date(), 30),
      }));
    const before = await snapshot();
    expect(before.receipt).toBeUndefined();
    expect(before.wager).toBeUndefined();
    expect(before.events).toHaveLength(2);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({ checkedEntries: 1 });
    await consumer.kill();
    const recovered = await f.start("consumer");
    await recovered.waitLog(
      "acknowledged",
      (log) => log.messageId === messageId && log.attempt === 2,
    );
    const after = await snapshot();
    expect(after.receipt?.isProcessed()).toBe(true);
    expect(after.wager?.transaction.status).toBe(Status.Processed);
    expect(after.events).toHaveLength(4);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
  }
}, 35_000);

test("failed DeleteMessage leaves a committed wager for safe redelivery after restart", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const messageId = crypto.randomUUID();
    const consumer = await f.start("consumer", "ack-fails");
    await f.send(bet, messageId);
    await consumer.waitLog("ack_failed", (log) => log.messageId === messageId);
    await consumer.kill();
    const recovered = await f.start("consumer");
    await recovered.waitLog("duplicate", (log) => log.messageId === messageId && log.attempt === 2);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
  }
}, 30_000);

test("PostgreSQL connection lost inside the transaction leaves no partial writes", async () => {
  const f = await messagingFixture({ maxReceives: 6 });
  const link = await createDependencyLink(f.database.url, 5432);
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const messageId = crypto.randomUUID();
    const consumer = await f.start("consumer", "slow-commit", { DATABASE_URL: link.url.href });
    await f.send(bet, messageId);
    await consumer.waitLog("slow-commit");
    link.setAvailable(false);
    await consumer.release();
    await consumer.waitLog(
      "retry",
      (log) => log.code === "DATABASE_UNAVAILABLE" && log.attempt === 1,
    );
    expect(
      await f.app.manager.execute(async ({ inbox, wagers, outbox }) => ({
        inbox: await inbox.find(f.config.SQS_CONSUMER_NAME, messageId),
        wager: await wagers.findByIdempotencyKey(bet.idempotencyKey),
        events: (await outbox.findDue(new Date(), 20)).length,
      })),
    ).toEqual({ inbox: undefined, wager: undefined, events: 2 });
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 1,
      storedBalance: { amount: "100.00" },
    });
    link.setAvailable(true);
    await consumer.waitLog(
      "acknowledged",
      (log) => log.messageId === messageId && (log.attempt ?? 0) >= 2,
    );
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
    await link.close();
  }
}, 30_000);

test("shutdown drains an in-flight transaction while heartbeat protects visibility", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const messageId = crypto.randomUUID();
    const consumer = await f.start("consumer", "slow-commit");
    await f.send(bet, messageId);
    await consumer.waitLog("slow-commit");
    await consumer.requestStop();
    await Bun.sleep(f.config.SQS_VISIBILITY_TIMEOUT_SECONDS * 1000 + 300);
    expect(await f.receive(f.source)).toBeUndefined();
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({ checkedEntries: 1 });
    await consumer.release();
    expect(await consumer.exited).toBe(0);
    expect(
      consumer.logs.some((log) => log.result === "acknowledged" && log.messageId === messageId),
    ).toBe(true);
    const idle = await f.start("consumer", undefined, { SQS_POLL_WAIT_SECONDS: 10 });
    await idle.requestStop();
    expect(await idle.exited).toBe(0);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
  }
}, 30_000);

test("demo de resiliência: reinicia consumer após commit e publisher após envio", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const laterBet = command(wallet);
    const refund = command(wallet, Kind.Refund, "25.00", {
      referenceExternalTransactionId: laterBet.externalTransactionId,
    });
    const firstMessage = crypto.randomUUID();
    const interrupted = await f.start("consumer", "after-commit");
    await f.send(bet, firstMessage);
    await interrupted.waitLog("after-commit");
    const committed = await f.app.providerWager.execute(bet.providerId, bet.externalTransactionId);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      storedBalance: { amount: "75.00" },
      checkedEntries: 2,
    });
    await interrupted.kill();
    const consumer = await f.start("consumer");
    const redelivery = await consumer.waitLog(
      "duplicate",
      (log) => log.messageId === firstMessage && log.attempt === 2,
    );
    expect(redelivery.transactionId).toBe(committed.transactionId);
    await f.send(bet, firstMessage);
    const refundMessage = crypto.randomUUID();
    await f.send(refund, refundMessage);
    await consumer.waitLog("acknowledged", (log) => log.messageId === refundMessage);
    const pending = await f.app.providerWager.execute(
      refund.providerId,
      refund.externalTransactionId,
    );
    expect(pending.status).toBe(Status.PendingReference);
    const laterMessage = crypto.randomUUID();
    await f.send(laterBet, laterMessage);
    await consumer.waitLog("acknowledged", (log) => log.messageId === laterMessage);
    const reference = await f.start("references");
    await reference.waitLog(
      "reference_finalized",
      (log) => log.transactionId === pending.transactionId,
    );
    expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({ status: "PROCESSED" });

    const publisher = await f.start("outbox", "after-send", { OUTBOX_BATCH_SIZE: 1 });
    await publisher.waitLog("after-send");
    const first = await waitFor(() => f.receive(f.events), "first published event");
    const firstId = (JSON.parse(first.Body!) as { eventId: string }).eventId;
    await f.delete(f.events, first.ReceiptHandle!);
    expect(
      (await f.app.manager.execute(({ outbox }) => outbox.findById(firstId)))?.publishedAt,
    ).toBeUndefined();
    await publisher.kill();
    const restartedPublisher = await f.start("outbox");
    await restartedPublisher.waitLog("published", (log) => log.eventId === firstId);
    const report = await f.database.orm.em.getConnection().execute<
      { wagers: number; published: number; pending: number; receipts: number }[]
    >(`
      select (select count(*)::int from wagering.wager_transactions) as wagers,
        (select count(*)::int from wagering.outbox_messages where published_at is not null) as published,
        (select count(*)::int from wagering.outbox_messages where published_at is null) as pending,
        (select count(*)::int from wagering.inbox_messages where processed_at is not null) as receipts
    `);
    const audit = await f.reconcile.execute(wallet.id);
    expect(report[0]).toEqual({ wagers: 4, published: 9, pending: 0, receipts: 3 });
    expect(audit).toMatchObject({
      consistent: true,
      checkedEntries: 4,
      storedBalance: { amount: "75.00" },
      calculatedBalance: { amount: "75.00" },
    });
    console.log(
      JSON.stringify({
        mensagensEnviadas: 4,
        mensagensConfirmadas: consumer.logs.filter(
          (log) => log.result === "acknowledged" || log.result === "duplicate",
        ).length,
        duplicatas: consumer.logs.filter((log) => log.result === "duplicate").length,
        reentrega: redelivery.attempt,
        eventoReenviado: firstId,
        ...report[0],
        reconciliacao: audit,
      }),
    );
  } finally {
    await f.close();
  }
}, 45_000);
