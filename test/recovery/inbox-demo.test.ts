import "reflect-metadata";
import { expect, test } from "bun:test";
import { hashWagerPayload } from "../../src/application/services/canonical-wager";
import { Money } from "../../src/domain/money/money";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";
import { createHttpApplication } from "../../src/presentation/http/http-application";
import { command as httpCommand, httpClient, wagerKey } from "../helpers/http-client";
import { walletEffects } from "../helpers/http-database";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("Inbox demo proves commit-before-ACK, redelivery, native DLQ and financial integrity", async () => {
  const f = await messagingFixture({ maxReceives: 3 });
  const api = await createHttpApplication(f.config);
  try {
    await api.listen(0, "127.0.0.1");
    const http = httpClient(await api.getUrl());
    const opened = await http.open("100.00");
    expect(opened.status).toBe(201);
    const wallet = opened.body;
    const bet = httpCommand(wallet, Kind.Bet, "25.00");
    const messageId = crypto.randomUUID();
    const envelope = {
      schemaVersion: 1,
      type: "WagerTransactionRequested",
      messageId,
      correlationId: "phase08-inbox-demo",
      occurredAt: new Date().toISOString(),
      data: { ...bet, idempotencyKey: wagerKey(bet) },
    };
    const body = JSON.stringify(envelope);
    const original = await f.start("consumer", "after-commit");
    await f.sendRaw(body, wallet.id);
    await original.waitLog("after-commit");
    const lookup = () => http.providerTransaction(bet.providerId, bet.externalTransactionId);
    const beforeCrash = (await lookup()).body;
    const getReceipt = () =>
      f.app.manager.execute(({ inbox }) => inbox.find(f.config.SQS_CONSUMER_NAME, messageId));
    const receipt = await getReceipt();
    expect(beforeCrash).toMatchObject({ status: "PROCESSED", balance: { amount: "75.00" } });
    expect(receipt?.isProcessed()).toBe(true);
    expect(receipt?.transactionId).toBe(beforeCrash.transactionId);
    expect(receipt?.payloadHash).toBe(await hashWagerPayload(envelope.data, Money.from(bet.money)));
    await original.kill();

    const replacement = await f.start("consumer");
    expect(replacement.pid).not.toBe(original.pid);
    const redelivery = await replacement.waitLog(
      "duplicate",
      (log) => log.messageId === messageId && (log.attempt ?? 0) > 1,
    );
    expect(redelivery.transactionId).toBe(beforeCrash.transactionId);
    await f.sendRaw(body, wallet.id);
    await replacement.waitLog(
      "duplicate",
      (log) => log.messageId === messageId && log.attempt === 1,
    );
    expect(await f.receive(f.source)).toBeUndefined();
    const invalid = JSON.stringify({
      ...envelope,
      schemaVersion: 2,
      messageId: crypto.randomUUID(),
    });
    await f.sendRaw(invalid, wallet.id);
    const exhausted = await replacement.waitLog(
      "awaiting_dlq",
      (log) => log.code === "UNSUPPORTED_SCHEMA_VERSION",
    );
    const dlq = await waitFor(() => f.receive(f.dlq), "versioned poison message on native DLQ");
    expect(dlq.Body).toBe(invalid);
    expect(exhausted.attempt).toBe(f.config.SQS_MAX_RECEIVE_COUNT);

    const [after, reconciliation, audit, effects, receiptCount] = await Promise.all([
      lookup(),
      http.reconcile(wallet.id),
      auditWallets(f.database.orm, { batchSize: 10, signal: AbortSignal.timeout(5_000) }, () => {}),
      walletEffects(f.database.orm, wallet.id),
      f.database.orm.em
        .getConnection()
        .execute<{ n: number }[]>("select count(*)::int as n from wagering.inbox_messages"),
    ]);
    expect(after.body.transactionId).toBe(beforeCrash.transactionId);
    expect(receiptCount).toEqual([{ n: 1 }]);
    expect(effects).toEqual({ wagers: 2, debit: 1, credit: 1, events: 4 });
    expect(reconciliation.body).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      difference: { amount: "0.00" },
      storedBalance: { amount: "75.00" },
    });
    expect(audit).toEqual({ walletsChecked: 1, inconsistent: 0, ledgerEntriesChecked: "2" });
    console.log(
      JSON.stringify({
        status: "PASS",
        scenario: "transactional-inbox",
        redeliveryAttempt: redelivery.attempt,
        dlqAttempt: exhausted.attempt,
        receipts: receiptCount[0]?.n,
        ...effects,
        balance: reconciliation.body.storedBalance.amount,
        difference: reconciliation.body.difference.amount,
      }),
    );
  } finally {
    await api.close();
    await f.close();
  }
}, 30_000);
