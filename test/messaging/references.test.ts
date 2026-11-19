import { expect, test } from "bun:test";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { command } from "../helpers/application-fixtures";
import { messagingFixture } from "../helpers/messaging-fixtures";

test("REFUND before BET and ROLLBACK before WIN resolve once with two reference workers", async () => {
  const f = await messagingFixture();
  try {
    const consumer = await f.start("consumer");
    const wallet = await f.app.open();
    const pairs = [
      [Kind.Bet, Kind.Refund],
      [Kind.Win, Kind.Rollback],
    ] as const;
    for (const [originalKind, reversalKind] of pairs) {
      const original = command(wallet, originalKind);
      const reversal = command(wallet, reversalKind, "25.00", {
        referenceExternalTransactionId: original.externalTransactionId,
      });
      const reversalMessage = crypto.randomUUID();
      await f.send(reversal, reversalMessage);
      await consumer.waitLog("acknowledged", (log) => log.messageId === reversalMessage);
      const pending = await f.app.providerWager.execute(
        reversal.providerId,
        reversal.externalTransactionId,
      );
      expect(pending.status).toBe(Status.PendingReference);
      expect(
        (await f.app.ledger.execute({ walletId: wallet.id })).entries.some(
          (row) => row.transactionId === pending.transactionId,
        ),
      ).toBe(false);
      const originalMessage = crypto.randomUUID();
      await f.send(original, originalMessage);
      await consumer.waitLog("acknowledged", (log) => log.messageId === originalMessage);
      const workers = await Promise.all([f.start("references"), f.start("references")]);
      await Promise.any(
        workers.map((worker) =>
          worker.waitLog(
            "reference_finalized",
            (log) => log.transactionId === pending.transactionId,
          ),
        ),
      );
      expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({
        status: "PROCESSED",
        transactionId: pending.transactionId,
      });
      expect(
        (await f.app.ledger.execute({ walletId: wallet.id })).entries.filter(
          (row) => row.transactionId === pending.transactionId,
        ),
      ).toHaveLength(1);
      await Promise.all(workers.map((worker) => worker.kill()));
    }
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 5,
      storedBalance: { amount: "100.00" },
    });
  } finally {
    await f.close();
  }
}, 40_000);

test("persists backoff and expires a missing reference with a single rejection event", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const pending = await f.app.process.execute(
      command(wallet, Kind.Refund, "25.00", {
        referenceExternalTransactionId: "missing-reference",
      }),
    );
    const worker = await f.start("references");
    await worker.waitLog("reference_rescheduled");
    const scheduled = await f.app.manager.execute(({ wagers }) =>
      wagers.findById(pending.transactionId),
    );
    expect(scheduled?.referenceAttempts).toBe(1);
    expect(scheduled?.referenceNextAttemptAt).toBeInstanceOf(Date);
    await worker.waitLog("reference_expired", (log) => log.transactionId === pending.transactionId);
    expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
    });
    const events = await f.app.manager.execute(({ outbox }) => outbox.findDue(new Date(), 100));
    expect(
      events.filter(
        ({ eventType, aggregateId }) =>
          eventType === "WagerTransactionRejected" && aggregateId === pending.transactionId,
      ),
    ).toHaveLength(1);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 1,
    });
  } finally {
    await f.close();
  }
}, 25_000);

test("reference crash inside financial commit rolls back and keeps the original wager recoverable", async () => {
  const f = await messagingFixture();
  try {
    const wallet = await f.app.open();
    const bet = command(wallet);
    const pending = await f.app.process.execute(
      command(wallet, Kind.Refund, "25.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    await f.app.process.execute(bet);
    const crash = await f.start("references", "reference-before-commit");
    await crash.waitLog("reference-before-commit");
    expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({
      status: "PENDING_REFERENCE",
    });
    await crash.kill();
    const worker = await f.start("references");
    await worker.waitLog(
      "reference_finalized",
      (log) => log.transactionId === pending.transactionId,
    );
    expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({ status: "PROCESSED" });
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 3,
      storedBalance: { amount: "100.00" },
    });
  } finally {
    await f.close();
  }
}, 25_000);

test("rejects a later reference that belongs to another wallet without moving money", async () => {
  const f = await messagingFixture();
  try {
    const originalWallet = await f.app.open();
    const otherWallet = await f.app.open();
    const bet = command(otherWallet);
    const pending = await f.app.process.execute(
      command(originalWallet, Kind.Refund, "25.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(pending.status).toBe(Status.PendingReference);
    await f.app.process.execute(bet);
    const worker = await f.start("references");
    await worker.waitLog(
      "reference_finalized",
      (log) => log.transactionId === pending.transactionId,
    );
    expect(await f.app.wager.execute(pending.transactionId)).toMatchObject({
      status: "REJECTED",
      failureCode: "INVALID_REFERENCE",
    });
    expect(await f.reconcile.execute(originalWallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 1,
      storedBalance: { amount: "100.00" },
    });
  } finally {
    await f.close();
  }
}, 25_000);
