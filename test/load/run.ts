import "reflect-metadata";
import { AssertionError, equal, ok } from "node:assert/strict";
import { cpus, totalmem, version } from "node:os";
import { Money } from "../../src/domain/money/money";
import {
  readDatabaseBacklog,
  readQueueBacklog,
} from "../../src/infrastructure/observability/backlog";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";
import { launchApi } from "../helpers/api-process";
import { type PublicWallet, wagerKey } from "../helpers/http-client";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";
import {
  draw,
  loadOptions,
  openingAmount,
  percentiles,
  plan,
  type LoadOptions,
  type Operation,
  type Scenario,
} from "./workload";

type Fixture = Awaited<ReturnType<typeof messagingFixture>>;
type Api = Awaited<ReturnType<typeof launchApi>>;
type Worker = Awaited<ReturnType<Fixture["start"]>>;

async function drain(f: Fixture, peak: { pending: number; lagSeconds: number }) {
  await waitFor(
    async () => {
      const backlog = await readDatabaseBacklog(f.database.orm, f.config.OUTBOX_MAX_ATTEMPTS);
      peak.pending = Math.max(peak.pending, backlog.outbox.unpublished);
      peak.lagSeconds = Math.max(peak.lagSeconds, backlog.oldestOutboxSeconds);
      equal(backlog.outbox.parked, 0, "Outbox contains parked events");
      return backlog.outbox.unpublished === 0 ? true : undefined;
    },
    "Outbox drainage",
    30_000,
  );
}

async function verify(
  f: Fixture,
  wallets: readonly PublicWallet[],
  expected: ReadonlyMap<string, Operation>,
  expectedReceipts: number,
) {
  const ids = wallets.map(({ id }) => id);
  const params = ids.map(() => "?").join(", ");
  const db = f.database.orm.em.getConnection();
  const rows = await db.execute<
    {
      external_id: string;
      wallet_id: string;
      status: string;
      failure_code: string | null;
      direction: "DEBIT" | "CREDIT" | null;
      amount: string | null;
    }[]
  >(
    `select w.external_transaction_id as external_id, w.wallet_id, w.status, w.failure_code,
            l.direction, l.amount::text
       from wagering.wager_transactions w
       left join wagering.wallet_ledger_entries l on l.transaction_id = w.id
      where w.kind <> 'OPENING' and w.wallet_id in (${params})`,
    ids,
  );
  equal(rows.length, expected.size, "Unexpected number of wagers or ledger rows");
  const balances = new Map(
    ids.map((id) => [id, Money.from({ amount: openingAmount, currency: "BRL" })]),
  );
  let movements = 0;
  for (const row of rows) {
    const operation = expected.get(row.external_id);
    ok(operation, "Unexpected wager");
    equal(row.wallet_id, operation.wager.walletId);
    equal(row.status, operation.failureCode ? "REJECTED" : "PROCESSED");
    equal(row.failure_code, operation.failureCode ?? null);
    const delta = Money.from({ amount: row.amount ?? "0.00", currency: "BRL" });
    const signed = row.direction === "DEBIT" ? delta.negate() : delta;
    equal(signed.toString(), operation.effect.toString(), "Unexpected ledger amount or direction");
    if (row.direction) movements++;
    balances.set(row.wallet_id, balances.get(row.wallet_id)!.add(operation.effect));
  }
  for (const [id, expectedBalance] of balances) {
    const audit = await f.reconcile.execute(id);
    equal(audit.consistent, true);
    equal(audit.storedBalance.amount, expectedBalance.toString());
  }
  const inbox = await db.execute<{ receipts: number }[]>(
    `select count(*)::int as receipts from wagering.inbox_messages i
     join wagering.wager_transactions w on w.id = i.transaction_id
     where i.processed_at is not null and w.wallet_id in (${params})`,
    ids,
  );
  equal(inbox[0]?.receipts, expectedReceipts, "Unexpected completed Inbox receipt count");
  const outbox = await db.execute<{ events: number; published: number; p95_ms: number }[]>(
    `select count(*)::int as events, count(published_at)::int as published,
            percentile_cont(0.95) within group (order by extract(epoch from published_at - occurred_at) * 1000) as p95_ms
       from wagering.outbox_messages where payload->'data'->>'walletId' in (${params})`,
    ids,
  );
  const events = outbox[0];
  ok(events);
  equal(
    events.events,
    wallets.length * 2 + expected.size + movements,
    "Unexpected Outbox event count",
  );
  equal(events.published, events.events, "Unpublished events remain");
  return {
    wallets: wallets.length,
    wagers: rows.length,
    ledgerEntries: wallets.length + movements,
    receipts: expectedReceipts,
    events: events.events,
    publicationLagP95Ms: Number(events.p95_ms.toFixed(2)),
  };
}

async function runScenario(
  f: Fixture,
  apis: readonly Api[],
  consumers: readonly Worker[],
  publishers: Worker[],
  options: LoadOptions,
  scenario: Scenario,
) {
  if (scenario === "L7") await Promise.all(publishers.splice(0).map((worker) => worker.kill()));
  const wallets = await Promise.all(
    Array.from({ length: scenario === "L2" ? 1 : options.wallets }, async (_, i) => {
      const opening = await apis[i % apis.length]!.client.open(openingAmount);
      equal(opening.status, 201);
      return opening.body;
    }),
  );
  const samples: number[] = [];
  const submitDelays: number[] = [];
  const sentAt = new Map<string, number>();
  const expected = new Map<string, Operation>();
  const errors: string[] = [];
  const peak = { pending: 0, lagSeconds: 0 };
  const seconds = scenario === "L8" ? options.sustained : options.duration;
  const jobs = seconds * options.rate;
  const sqs = scenario === "L6";
  const firstConsumerLog = consumers.map(({ logs }) => logs.length);
  let next = 0;
  let completed = 0;
  let replays = 0;
  let businessRejections = 0;
  const started = performance.now();

  async function submit(api: Api, operation: Operation, replay = false) {
    const before = performance.now();
    const { wager, failureCode } = operation;
    try {
      const result = await api.client.wager(wager, wagerKey(wager), {
        "x-correlation-id": wager.externalTransactionId,
      });
      equal(result.status, failureCode ? 422 : 200);
      equal(result.body.status, failureCode ? "REJECTED" : "PROCESSED");
      equal(result.body.failureCode, failureCode);
      equal(result.body.idempotentReplay, replay);
      completed++;
      if (replay) replays++;
      if (failureCode) businessRejections++;
      return result.body;
    } finally {
      samples.push(performance.now() - before);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(jobs, options.workers) }, async () => {
      while (next < jobs) {
        const index = next++;
        const due = scenario === "L5" ? started : started + (index * 1000) / options.rate;
        const delay = due - performance.now();
        if (delay > 0) await Bun.sleep(delay);
        submitDelays.push(Math.max(0, performance.now() - due));
        const wallet = wallets[draw(options.seed, index, 17) % wallets.length]!;
        const mix = scenario === "L4" && draw(options.seed, index, 29) % 100 < options.mixedPercent;
        const sequence = plan(wallet, scenario, index, mix);
        const api = apis[index % apis.length]!;
        try {
          for (const operation of sequence) {
            const { wager } = operation;
            expected.set(wager.externalTransactionId, operation);
            if (sqs) {
              sentAt.set(wager.externalTransactionId, performance.now());
              await f.send(
                { ...wager, idempotencyKey: wagerKey(wager) },
                wager.externalTransactionId,
              );
              continue;
            }
            const first = await submit(api, operation);
            if (scenario === "L3" && draw(options.seed, index, 41) % 100 < options.replayPercent) {
              const duplicate = await submit(apis[(index + 1) % apis.length]!, operation, true);
              equal(duplicate.transactionId, first.transactionId);
              equal(duplicate.balance.amount, first.balance.amount);
              equal(duplicate.walletVersion, first.walletVersion);
            }
          }
        } catch (error) {
          errors.push(
            error instanceof AssertionError
              ? error.message
              : error instanceof Error
                ? error.name
                : "UnknownError",
          );
        }
      }
    }),
  );

  let sqsRetries = 0;
  let sqsLockConflicts = 0;
  let finished = performance.now();
  if (sqs && errors.length === 0) {
    const logs = await waitFor(
      () => {
        const entries = consumers.flatMap((worker, i) => worker.logs.slice(firstConsumerLog[i]));
        const acked = new Map(
          entries
            .filter((log) => log.result === "acknowledged" && log.messageId)
            .map((log) => [log.messageId, log.observedAt]),
        );
        if (acked.size !== expected.size) return undefined;
        return { acked, entries };
      },
      "SQS acknowledgments",
      30_000,
    );
    for (const [id, time] of sentAt) {
      const ack = logs.acked.get(id);
      ok(ack !== undefined, "Missing SQS acknowledgment");
      samples.push(ack - time);
    }
    finished = [...logs.acked.values()].reduce((latest, ack) => Math.max(latest, ack), started);
    completed = logs.acked.size;
    sqsRetries = logs.entries.filter((log) => log.result === "retry").length;
    sqsLockConflicts = logs.entries.filter(
      (log) => log.code === "LOCK_TIMEOUT" || log.code === "DEADLOCK",
    ).length;
    for (const { queue, values } of await readQueueBacklog(f.sqs, f.config)) {
      if (queue !== "events")
        equal(
          Object.values(values).reduce((a, b) => a + b, 0),
          0,
        );
    }
  }
  const measuredMs = finished - started;
  const drainStarted = performance.now();
  if (scenario === "L7") {
    const backlog = await readDatabaseBacklog(f.database.orm, f.config.OUTBOX_MAX_ATTEMPTS);
    peak.pending = backlog.outbox.unpublished;
    peak.lagSeconds = backlog.oldestOutboxSeconds;
    ok(peak.pending > 0, "Expected a backlog before starting publishers");
    for (let i = 0; i < 2; i++) publishers.push(await f.start("outbox"));
  }
  await drain(f, peak);
  const drainMs = performance.now() - drainStarted;
  const result = {
    scenario,
    channel: sqs ? "sqs" : "http",
    jobs,
    completed,
    replays,
    businessRejections,
    errors: errors.length,
    errorRate: errors.length / Math.max(sqs ? sentAt.size : samples.length, 1),
    throughputPerSecond: Number(((completed * 1000) / measuredMs).toFixed(2)),
    latencyMs: percentiles(samples),
    schedulingDelayMs: percentiles(submitDelays),
    measuredSeconds: Number((measuredMs / 1000).toFixed(2)),
    sqsRetries,
    sqsLockConflicts,
    outbox: { ...peak, drainMs: Math.round(drainMs) },
  };
  if (errors.length) {
    console.error(JSON.stringify({ status: "FAIL", ...result, firstError: errors[0] }));
    throw new Error(`${scenario}: ${errors.length} unexpected errors`);
  }
  return { ...result, integrity: await verify(f, wallets, expected, sqs ? expected.size : 0) };
}

async function main() {
  const options = loadOptions(process.env);
  const f = await messagingFixture({ visibility: 10, maxReceives: 5 });
  const apis: Api[] = [];
  const consumers: Worker[] = [];
  const publishers: Worker[] = [];
  const results: Awaited<ReturnType<typeof runScenario>>[] = [];
  let peakRunnerRss = process.memoryUsage.rss();
  const sampler = setInterval(() => {
    peakRunnerRss = Math.max(peakRunnerRss, process.memoryUsage.rss());
  }, 250);
  const cpuBefore = process.cpuUsage();
  let report: object;
  try {
    for (let i = 0; i < options.instances; i++)
      apis.push(await launchApi(f.database.url, `load-${i}`, undefined, "warn"));
    if (options.scenarios.includes("L6")) {
      for (let i = 0; i < options.instances; i++) {
        consumers.push(await f.start("consumer", undefined, { SQS_CONSUMER_CONCURRENCY: 4 }));
      }
    }
    for (let i = 0; i < 2; i++) publishers.push(await f.start("outbox"));
    for (const [index, { client }] of apis.entries()) {
      const opening = await client.open();
      equal(opening.status, 201);
      const [warmup] = plan(opening.body, "L1", -1 - index, false);
      ok(warmup);
      equal((await client.wager(warmup.wager)).status, 200);
    }
    await drain(f, { pending: 0, lagSeconds: 0 });

    for (const scenario of options.scenarios) {
      results.push(await runScenario(f, apis, consumers, publishers, options, scenario));
    }
    const audit = await auditWallets(
      f.database.orm,
      { batchSize: 50, signal: AbortSignal.timeout(15_000) },
      () => {},
    );
    equal(audit.inconsistent, 0);
    await Promise.all(apis.map((api) => api.stop()));
    const stderr = (await Promise.all(apis.map((api) => api.stderr))).join("\n");
    const lockLogs = stderr
      .split("\n")
      .filter((line) => line.includes('"event":"wallet.lock.conflict"'));
    const cpu = process.cpuUsage(cpuBefore);
    report = {
      status: "PASS",
      environment: {
        bun: Bun.version,
        os: version(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        ramBytes: totalmem(),
      },
      options,
      processes: {
        http: new Set(apis.map(({ pid }) => pid)).size,
        consumers: new Set(consumers.map(({ pid }) => pid)).size,
        publishers: publishers.length,
      },
      runner: { peakRssBytes: peakRunnerRss, cpuMs: (cpu.user + cpu.system) / 1000 },
      audit,
      results: results.map((result) => ({
        ...result,
        lockConflicts:
          result.sqsLockConflicts +
          lockLogs.filter((line) => line.includes(`"correlationId":"${result.scenario}-`)).length,
      })),
    };
  } finally {
    clearInterval(sampler);
    try {
      await Promise.all(apis.map((api) => api.stop()));
    } finally {
      await f.close();
    }
  }
  console.log(JSON.stringify(report));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Load benchmark failed");
  process.exitCode = 1;
});
