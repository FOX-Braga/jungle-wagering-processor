import "reflect-metadata";
import { expect, test } from "bun:test";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { ReferenceWorker } from "../../src/infrastructure/messaging/reference-worker";
import { WagerConsumer } from "../../src/infrastructure/messaging/wager-consumer";
import {
  collectBacklog,
  readDatabaseBacklog,
} from "../../src/infrastructure/observability/backlog";
import { createLogger } from "../../src/infrastructure/observability/logger";
import { Metrics } from "../../src/infrastructure/observability/metrics";
import { createHttpApplication } from "../../src/presentation/http/http-application";
import { command } from "../helpers/application-fixtures";
import { createDependencyLink } from "../helpers/dependency-link";
import { command as httpCommand, httpClient } from "../helpers/http-client";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";
import { waitForWalletWaiters, withWalletLock } from "../helpers/wallet-lock";

test("reports dependency outages, lock conflict and recovery while preserving the original financial identity", async () => {
  const fixture = await messagingFixture();
  const dbLink = await createDependencyLink(new URL(fixture.config.DATABASE_URL), 5432);
  const sqsLink = await createDependencyLink(new URL(fixture.config.SQS_ENDPOINT), 4566);
  const queue = (url: string) => new URL(new URL(url).pathname, sqsLink.url).href;
  const metrics = new Metrics("recovery-api");
  const app = await createHttpApplication(
    {
      ...fixture.config,
      INSTANCE_ID: "recovery-api",
      HTTP_MAX_IN_FLIGHT: 1,
      DATABASE_URL: dbLink.url.href,
      SQS_ENDPOINT: sqsLink.url.origin,
      SQS_WAGER_QUEUE_URL: queue(fixture.source),
      SQS_WAGER_DLQ_URL: queue(fixture.dlq),
      SQS_EVENT_QUEUE_URL: queue(fixture.events),
    },
    metrics,
  );
  try {
    await app.listen(0, "127.0.0.1");
    const http = httpClient(await app.getUrl());
    const wallet = (await http.open()).body;
    const bet = httpCommand(wallet);
    expect((await http.request("/health/ready")).status).toBe(200);
    dbLink.setAvailable(false);
    const databaseDown = await http.request("/health/ready");
    expect(databaseDown.status).toBe(503);
    expect(databaseDown.body).toMatchObject({ checks: { postgres: "down", sqs: "up" } });
    expect((await http.request("/health/live")).status).toBe(200);
    expect((await http.wager(bet)).status).toBe(503);
    expect((await fixture.reconcile.execute(wallet.id)).checkedEntries).toBe(1);
    dbLink.setAvailable(true);
    sqsLink.setAvailable(false);
    const queueDown = await http.request("/health/ready");
    expect(queueDown.status).toBe(503);
    expect(queueDown.body).toMatchObject({ checks: { postgres: "up", sqs: "down" } });
    sqsLink.setAvailable(true);
    expect((await http.request("/health/ready")).status).toBe(200);
    await withWalletLock(fixture.database.orm, wallet.id, async () => {
      const waiting = http.wager(bet);
      try {
        await waitForWalletWaiters(fixture.database.orm, 1, ["recovery-api"]);
        const overloaded = await http.wager(bet);
        expect(overloaded.status).toBe(503);
        expect(overloaded.headers.get("retry-after")).toBe("1");
        expect(overloaded.body).toMatchObject({ error: { code: "HTTP_OVERLOADED" } });
        expect((await http.request("/health/live")).status).toBe(200);
      } finally {
        expect((await waiting).status).toBe(503);
      }
    });
    const processed = await http.wager(bet);
    const replay = await http.wager(bet);
    expect(processed.body.status).toBe(Status.Processed);
    expect(replay.body).toMatchObject({
      transactionId: processed.body.transactionId,
      idempotentReplay: true,
    });
    expect(metrics.snapshot().metrics).toMatchObject({
      wager_wallet_lock_conflicts_total: [{ labels: { reason: "LOCK_TIMEOUT" }, value: 1 }],
      wager_transactions_total: [{ labels: { status: "PROCESSED", source: "http" }, value: 1 }],
      wager_idempotency_duplicates_total: [{ labels: { source: "http" }, value: 1 }],
    });
    expect(await fixture.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      calculatedBalance: { amount: "75.00" },
    });
  } finally {
    await app.close();
    await dbLink.close();
    await sqsLink.close();
    await fixture.close();
  }
}, 20_000);

test("observes DLQ, pending-reference age, outbox backlog and publication recovery with real dependencies", async () => {
  const fixture = await messagingFixture({ maxReceives: 2 });
  const logger = createLogger("error", "operations-test");
  const consumerMetrics = new Metrics("test-consumer", "consumer");
  const outboxMetrics = new Metrics("test-outbox", "outbox");
  const referenceMetrics = new Metrics("test-references", "references");
  const referenceWorker = new ReferenceWorker(
    fixture.app.manager,
    fixture.app.process,
    fixture.config,
    {
      logger,
      workerInstanceId: "test-references",
      metrics: referenceMetrics,
    },
  );
  const consumer = new WagerConsumer(fixture.sqs, fixture.app.process, fixture.config, {
    logger,
    workerInstanceId: "test-consumer",
    metrics: consumerMetrics,
  });
  const stop = new AbortController();
  const running = consumer.run(stop.signal);
  const broken = await createDependencyLink(new URL(fixture.config.SQS_ENDPOINT), 4566);
  const brokenSqs = createSqsClient({ ...fixture.config, SQS_ENDPOINT: broken.url.origin }, 1);
  try {
    const wallet = await fixture.app.open();
    const bet = command(wallet);
    const refund = command(wallet, Kind.Refund, "25.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
      correlationId: "refund-correlation",
      causationId: "upstream-event",
    });
    await fixture.send(refund, "origin-message");
    await fixture.sendRaw("{broken-json", "invalid-message");
    const pending = await waitFor(
      async () =>
        fixture.app.providerWager
          .execute(refund.providerId, refund.externalTransactionId)
          .catch(() => undefined),
      "pending reference",
      8_000,
    );
    expect(pending.status).toBe(Status.PendingReference);
    const backlog = () =>
      readDatabaseBacklog(fixture.database.orm, fixture.config.OUTBOX_MAX_ATTEMPTS);
    expect((await backlog()).references.pending).toBe(1);
    expect((await backlog()).oldestReferenceSeconds).toBeGreaterThan(0);
    expect((await backlog()).outbox.unpublished).toBeGreaterThan(0);
    expect((await backlog()).oldestOutboxSeconds).toBeGreaterThan(0);
    const shared = new Metrics("diagnostics");
    await waitFor(
      async () => {
        await collectBacklog(fixture.database.orm, fixture.sqs, fixture.config, shared);
        const [depth] = shared.snapshot().metrics.wager_dlq_messages ?? [];
        return depth && "value" in depth && depth.value === 1 ? true : undefined;
      },
      "observed DLQ depth",
      8_000,
    );
    expect(consumerMetrics.snapshot().metrics.wager_sqs_events_total).toContainEqual({
      type: "counter",
      labels: { result: "awaiting_dlq" },
      value: 1,
    });
    await fixture.app.process.execute(bet);
    await referenceWorker.processBatch(stop.signal);
    expect((await backlog()).references.pending).toBe(0);
    expect(referenceMetrics.snapshot().metrics.wager_reference_events_total).toMatchObject([
      { labels: { result: "reference_finalized" }, value: 1 },
    ]);
    const events = await fixture.database.orm.em
      .getConnection()
      .execute<{ payload: unknown }[]>(
        "select payload from wagering.outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionProcessed'",
        [pending.transactionId],
      );
    expect(events[0]?.payload).toMatchObject({
      correlationId: "refund-correlation",
      causationId: "upstream-event",
      sourceMessageId: "origin-message",
    });
    broken.setAvailable(false);
    const context = { logger, workerInstanceId: "test-outbox", metrics: outboxMetrics };
    await new OutboxPublisher(
      brokenSqs,
      fixture.app.manager,
      fixture.config,
      context,
    ).publishBatch();
    expect((await backlog()).outbox.retry).toBeGreaterThan(0);
    const replacement = new OutboxPublisher(
      fixture.sqs,
      fixture.app.manager,
      fixture.config,
      context,
    );
    await waitFor(
      async () => {
        await replacement.publishBatch();
        return (await backlog()).outbox.unpublished === 0 ? true : undefined;
      },
      "committed outbox drained after publisher replacement",
      8_000,
    );
    expect((await backlog()).oldestOutboxSeconds).toBe(0);
    expect(outboxMetrics.snapshot().metrics.wager_outbox_events_total).toContainEqual({
      type: "counter",
      labels: { result: "published" },
      value: 7,
    });
    expect(await fixture.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 3,
      calculatedBalance: { amount: "100.00" },
    });
  } finally {
    stop.abort();
    await running;
    brokenSqs.destroy();
    await broken.close();
    await fixture.close();
  }
}, 25_000);
