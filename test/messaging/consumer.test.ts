import { test, expect } from "bun:test";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { command } from "../helpers/application-fixtures";
import { launchApi } from "../helpers/api-process";
import { createDependencyLink } from "../helpers/dependency-link";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("HTTP and SQS share identities in both orders and under concurrent delivery", async () => {
  const f = await messagingFixture();
  try {
    const [api, worker] = await Promise.all([
      launchApi(f.database.url, "http-sqs"),
      f.start("consumer"),
    ]);
    try {
      for (const order of ["http", "sqs", "simultaneous"]) {
        const wallet = await f.app.open();
        const wager = command(wallet);
        const messageId = crypto.randomUUID();
        const { idempotencyKey, ...body } = wager;
        const send = () =>
          f
            .send(wager, messageId)
            .then(() =>
              worker.waitLog(
                order === "http" ? "duplicate" : "acknowledged",
                (log) => log.messageId === messageId,
              ),
            );
        const post = () => api.client.wager(body, idempotencyKey);
        if (order === "http") {
          expect((await post()).status).toBe(200);
          await send();
        } else if (order === "sqs") {
          await send();
          expect((await post()).body.idempotentReplay).toBe(true);
        } else {
          const [http] = await Promise.all([post(), f.send(wager, messageId)]);
          expect(http.status).toBe(200);
          await waitFor(
            () =>
              worker.logs.find(
                (log) =>
                  log.messageId === messageId &&
                  ["acknowledged", "duplicate"].includes(log.result ?? ""),
              ),
            "cross-channel ACK",
          );
        }
        const record = await f.app.providerWager.execute(
          wager.providerId,
          wager.externalTransactionId,
        );
        expect(record.balance?.amount).toBe("75.00");
        expect(await f.reconcile.execute(wallet.id)).toMatchObject({
          consistent: true,
          checkedEntries: 2,
        });
        expect(
          await f.app.manager.execute(async ({ inbox }) =>
            (await inbox.find(f.config.SQS_CONSUMER_NAME, messageId))?.isProcessed(),
          ),
        ).toBe(true);
      }
    } finally {
      await api.stop();
    }
  } finally {
    await f.close();
  }
}, 45_000);

test("ACKs terminal financial rejection and sends poison and identity conflicts to native DLQ", async () => {
  const f = await messagingFixture({ maxReceives: 2 });
  try {
    const worker = await f.start("consumer");
    const wallet = await f.app.open();
    const wager = command(wallet, Kind.Bet, "150.00");
    const messageId = crypto.randomUUID();
    await f.send(wager, messageId);
    await worker.waitLog("acknowledged", (log) => log.messageId === messageId);
    expect(
      await f.app.providerWager.execute(wager.providerId, wager.externalTransactionId),
    ).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
    });
    await f.send({ ...wager, money: { amount: "25.00", currency: "BRL" } }, messageId);
    const poison = "{bad-json";
    await f.sendRaw(poison, crypto.randomUUID());
    await worker.waitLog(
      "awaiting_dlq",
      (log) => log.code === "INBOX_CONFLICT" && log.attempt === 2,
    );
    await worker.waitLog("awaiting_dlq", (log) => log.code === "INVALID_JSON" && log.attempt === 2);
    const deadLetters = [];
    for (let i = 0; i < 2; i++) {
      deadLetters.push(await waitFor(() => f.receive(f.dlq), "native DLQ"));
    }
    expect(deadLetters.map(({ Body }) => Body)).toContain(poison);
    const conflict = deadLetters.find(({ Body }) => Body?.includes(messageId));
    expect(conflict?.ReceiptHandle).toBeDefined();
    await f.send(wager, messageId);
    await worker.waitLog("duplicate", (log) => log.messageId === messageId);
    await Promise.all(deadLetters.map(({ ReceiptHandle }) => f.delete(f.dlq, ReceiptHandle!)));
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 1,
      storedBalance: { amount: "100.00" },
    });
  } finally {
    await f.close();
  }
}, 35_000);

test("retries a real PostgreSQL connection failure and acknowledges after recovery", async () => {
  const f = await messagingFixture({ maxReceives: 5 });
  const link = await createDependencyLink(f.database.url, 5432);
  try {
    const wallet = await f.app.open();
    const wager = command(wallet);
    const messageId = crypto.randomUUID();
    link.setAvailable(false);
    const worker = await f.start("consumer", undefined, { DATABASE_URL: link.url.href });
    await f.send(wager, messageId);
    await worker.waitLog(
      "retry",
      (log) => log.code === "DATABASE_UNAVAILABLE" && log.delaySeconds === 1,
    );
    await worker.waitLog(
      "retry",
      (log) => log.code === "DATABASE_UNAVAILABLE" && log.delaySeconds === 2,
    );
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({ checkedEntries: 1 });
    link.setAvailable(true);
    await worker.waitLog(
      "acknowledged",
      (log) => log.messageId === messageId && (log.attempt ?? 0) >= 3,
    );
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
    expect(await f.receive(f.dlq)).toBeUndefined();
  } finally {
    await f.close();
    await link.close();
  }
}, 35_000);

test("consumer backs off on SQS connection failures and resumes long polling", async () => {
  const f = await messagingFixture();
  const link = await createDependencyLink(new URL(f.config.SQS_ENDPOINT), 80);
  try {
    const wallet = await f.app.open();
    const wager = command(wallet);
    const messageId = crypto.randomUUID();
    link.setAvailable(false);
    const worker = await f.start("consumer", undefined, { SQS_ENDPOINT: link.url.origin });
    await worker.waitLog("poll_failed", (log) => log.attempt === 2);
    await f.send(wager, messageId);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({ checkedEntries: 1 });
    link.setAvailable(true);
    await worker.waitLog("acknowledged", (log) => log.messageId === messageId && log.attempt === 1);
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
  } finally {
    await f.close();
    await link.close();
  }
}, 25_000);
