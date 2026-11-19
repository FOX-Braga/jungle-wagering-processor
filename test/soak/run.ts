import { deepEqual, equal, notEqual, ok } from "node:assert/strict";
import { arch, version } from "node:os";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import {
  readDatabaseBacklog,
  readQueueBacklog,
} from "../../src/infrastructure/observability/backlog";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";
import { launchApi } from "../helpers/api-process";
import { command, type PublicWallet, type Wager, wagerKey } from "../helpers/http-client";
import { walletEffects } from "../helpers/http-database";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";
import { percentiles } from "../load/workload";

type Fixture = Awaited<ReturnType<typeof messagingFixture>>;
type Api = Awaited<ReturnType<typeof launchApi>>;

async function open(api: Api, amount = "100.00") {
  const result = await api.client.open(amount);
  equal(result.status, 201);
  return result.body;
}

async function checkWallet(
  f: Fixture,
  api: Api,
  wallet: PublicWallet,
  balance: string,
  debits: number,
  rejected: number,
) {
  const [reconciliation, effects] = await Promise.all([
    api.client.reconcile(wallet.id),
    walletEffects(f.database.orm, wallet.id),
  ]);
  equal(reconciliation.status, 200);
  equal(reconciliation.body.consistent, true);
  equal(reconciliation.body.storedBalance.amount, balance);
  equal(reconciliation.body.difference.amount, "0.00");
  equal(reconciliation.body.checkedEntries, 1 + debits);
  deepEqual(effects, {
    wagers: 1 + debits + rejected,
    debit: debits,
    credit: 1,
    events: 2 + 2 * debits + rejected,
  });
}

async function main() {
  const raw = process.env.SOAK_SECONDS ?? "12";
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || seconds < 4 || seconds > 120)
    throw new Error("SOAK_SECONDS must be an integer from 4 to 120");
  const f = await messagingFixture({ visibility: 3 });
  const apis: Api[] = [];
  let report: object;
  let phase = "setup";
  let businessRejections = 0;
  let replays = 0;
  let completedBatches = 0;
  const httpLatency: number[] = [];
  const sqsLatency: number[] = [];
  try {
    for (let index = 0; index < 3; index++)
      apis.push(await launchApi(f.database.url, `soak-${index}`, undefined, "warn"));
    equal(new Set(apis.map(({ pid }) => pid)).size, 3);
    const [first, second, third] = apis as [Api, Api, Api];
    const independent = await open(third, "500.00");
    const queued = await open(first);
    const consumer = await f.start("consumer", "after-commit");
    const publisher = await f.start("outbox");
    const hotWallets: PublicWallet[] = [];

    async function wager(api: Api, bet: Wager) {
      const before = performance.now();
      try {
        return await api.client.wager(bet);
      } finally {
        httpLatency.push(performance.now() - before);
      }
    }

    async function restartWorkers() {
      const bet = command(queued, Kind.Bet, "10.00");
      const later = command(queued, Kind.Bet, "10.00");
      const send = (operation: Wager) =>
        f.send(
          { ...operation, idempotencyKey: wagerKey(operation) },
          operation.externalTransactionId,
        );
      const firstSent = performance.now();
      await send(bet);
      await consumer.waitLog("after-commit");
      const lookup = () =>
        first.client.providerTransaction(bet.providerId, bet.externalTransactionId);
      const committed = await lookup();
      equal(committed.status, 200);
      equal(committed.body.status, "PROCESSED");
      equal(committed.body.balance?.amount, "90.00");
      await Promise.all([consumer.kill(), publisher.kill()]);
      // Commit HTTP work and enqueue SQS work while both workers are offline.
      const offline = await wager(third, command(independent, Kind.Bet, "1.00"));
      equal(offline.status, 200);
      equal(offline.body.status, "PROCESSED");
      const laterSent = performance.now();
      await send(later);
      const backlog = await readDatabaseBacklog(f.database.orm, f.config.OUTBOX_MAX_ATTEMPTS);
      ok(backlog.outbox.unpublished >= 2, "Expected Outbox work committed during downtime");
      const replacementConsumer = await f.start("consumer");
      const replacementPublisher = await f.start("outbox");
      notEqual(replacementConsumer.pid, consumer.pid);
      notEqual(replacementPublisher.pid, publisher.pid);
      const [duplicate, ack] = await Promise.all([
        replacementConsumer.waitLog(
          "duplicate",
          (log) => log.messageId === bet.externalTransactionId && (log.attempt ?? 0) > 1,
        ),
        replacementConsumer.waitLog(
          "acknowledged",
          (log) => log.messageId === later.externalTransactionId,
        ),
      ]);
      equal(duplicate.transactionId, committed.body.transactionId);
      deepEqual((await lookup()).body, committed.body);
      sqsLatency.push(duplicate.observedAt - firstSent, ack.observedAt - laterSent);
      const [receipts] = await f.database.orm.em
        .getConnection()
        .execute<{ n: number }[]>(
          "select count(*)::int as n from wagering.inbox_messages where processed_at is not null",
        );
      equal(receipts?.n, 2);
      return {
        redeliveryAttempt: duplicate.attempt!,
        unpublishedAtRestart: backlog.outbox.unpublished,
        httpCommitsWhileWorkersOffline: 1,
      };
    }

    phase = "traffic-and-restart";
    const started = performance.now();
    const restart = (async () => {
      await Bun.sleep(seconds * 500);
      return restartWorkers();
    })();
    const traffic = (async () => {
      for (let batch = 0; batch < seconds * 2; batch++) {
        const due = started + batch * 500;
        await Bun.sleep(Math.max(0, due - performance.now()));
        if (performance.now() - started >= seconds * 1000 && batch > 0) break;
        const hot = await open(first);
        hotWallets.push(hot);
        const a = command(hot, Kind.Bet, "80.00");
        const b = command(hot, Kind.Bet, "80.00");
        const own = command(independent, Kind.Bet, "1.00");
        const [aResult, bResult, independentResult] = await Promise.all([
          wager(first, a),
          wager(second, b),
          wager(third, own),
        ]);
        deepEqual([aResult.status, bResult.status].sort(), [200, 422]);
        equal(independentResult.status, 200);
        equal(independentResult.body.status, "PROCESSED");
        for (const [input, result] of [
          [a, aResult],
          [b, bResult],
        ] as const) {
          equal(result.body.idempotentReplay, false);
          equal(result.body.status, result.status === 200 ? "PROCESSED" : "REJECTED");
          equal(result.body.balance.amount, "20.00");
          equal(
            result.body.failureCode,
            result.status === 422 ? FailureCode.InsufficientFunds : undefined,
          );
          const replay = await wager(third, input);
          equal(replay.status, result.status);
          deepEqual(replay.body, { ...result.body, idempotentReplay: true });
          replays++;
        }
        businessRejections++;
        completedBatches++;
      }
      return performance.now() - started;
    })();
    const [http, workers] = await Promise.allSettled([traffic, restart]);
    if (http.status === "rejected") throw http.reason;
    if (workers.status === "rejected") throw workers.reason;

    phase = "drain-and-audit";
    const dbState = await waitFor(
      async () => {
        const state = await readDatabaseBacklog(f.database.orm, f.config.OUTBOX_MAX_ATTEMPTS);
        equal(state.outbox.parked, 0);
        return state.outbox.unpublished === 0 ? state : undefined;
      },
      "Outbox drainage",
      30_000,
    );
    equal(dbState.unprocessedInbox, 0);
    equal(dbState.references.pending, 0);
    const queues = await readQueueBacklog(f.sqs, f.config);
    for (const { queue, values } of queues) {
      if (queue === "events") continue;
      deepEqual(values, { visible: 0, in_flight: 0, delayed: 0 });
    }
    ok(hotWallets.length > 0);
    for (const wallet of hotWallets) await checkWallet(f, first, wallet, "20.00", 1, 1);
    const independentDebits = completedBatches + workers.value.httpCommitsWhileWorkersOffline;
    await checkWallet(
      f,
      third,
      independent,
      `${500n - BigInt(independentDebits)}.00`,
      independentDebits,
      0,
    );
    await checkWallet(f, second, queued, "80.00", 2, 0);
    const audit = await auditWallets(
      f.database.orm,
      { batchSize: 40, signal: AbortSignal.timeout(15_000) },
      () => {},
    );
    equal(audit.inconsistent, 0);
    equal(audit.walletsChecked, hotWallets.length + 2);
    equal(audit.ledgerEntriesChecked, String(hotWallets.length * 2 + independentDebits + 4));
    report = {
      status: "PASS",
      environment: { bun: Bun.version, os: version(), arch: arch(), apiProcesses: apis.length },
      configuredSeconds: seconds,
      measuredHttpSeconds: http.value / 1000,
      http: {
        operations: httpLatency.length,
        throughputPerSecond: (httpLatency.length * 1000) / http.value,
        latencyMs: percentiles(httpLatency),
        businessRejections,
        replays,
      },
      sqs: {
        operations: sqsLatency.length,
        latencyMs: percentiles(sqsLatency),
        retries: workers.value.redeliveryAttempt - 1,
        ...workers.value,
      },
      unexpectedErrors: 0,
      pending: {
        outbox: dbState.outbox.unpublished,
        references: dbState.references.pending,
        inbox: dbState.unprocessedInbox,
      },
      audit,
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        status: "FAIL",
        phase,
        completedBatches,
        businessRejections,
        replays,
        unexpectedErrors: 1,
      }),
    );
    throw error;
  } finally {
    try {
      await Promise.all(apis.map((api) => api.stop()));
    } finally {
      await f.close();
    }
  }
  console.log(JSON.stringify(report));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Soak test failed");
  process.exitCode = 1;
});
