import { expect, test } from "bun:test";
import { WagerConsumer } from "../../src/infrastructure/messaging/wager-consumer";
import { createLogger } from "../../src/infrastructure/observability/logger";
import { Metrics } from "../../src/infrastructure/observability/metrics";
import { barrier, command } from "../helpers/application-fixtures";
import { messagingFixture } from "../helpers/messaging-fixtures";
import { waitFor } from "../helpers/wait-for";

test("drains the running message and returns buffered FIFO messages during shutdown", async () => {
  const f = await messagingFixture({ visibility: 30, maxReceives: 5 });
  const stop = new AbortController();
  const finish = barrier();
  let worker: Promise<void> | undefined;
  try {
    const wallet = await f.app.open();
    const first = command(wallet);
    const second = command(wallet);
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();
    await f.send(first, firstId);
    await f.send(second, secondId);
    const executions: string[] = [];
    const config = { ...f.config, SQS_CONSUMER_BATCH_SIZE: 2, SQS_CONSUMER_CONCURRENCY: 2 };
    const metrics = new Metrics("batch", "consumer");
    const consumer = new WagerConsumer(
      f.sqs,
      {
        async execute(input) {
          executions.push(input.externalTransactionId);
          await finish.reached;
          return f.app.process.execute(input);
        },
      },
      config,
      { workerInstanceId: "batch", logger: createLogger("error"), metrics },
    );
    worker = consumer.run(stop.signal);
    await waitFor(() => (executions.length ? true : undefined), "first handler in the FIFO batch");
    expect(metrics.snapshot().metrics.wager_sqs_events_total).toContainEqual({
      type: "counter",
      labels: { result: "received" },
      value: 2,
    });
    expect(executions).toEqual([first.externalTransactionId]);
    stop.abort();
    finish.release();
    await worker;
    expect(executions).toEqual([first.externalTransactionId]);
    expect(metrics.snapshot().metrics.wager_sqs_events_total).toContainEqual({
      type: "counter",
      labels: { result: "deferred" },
      value: 1,
    });
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: "75.00" },
    });
    const replacement = await f.start("consumer");
    await replacement.waitLog(
      "acknowledged",
      (log) => log.messageId === secondId && log.attempt === 2,
    );
    expect(await f.reconcile.execute(wallet.id)).toMatchObject({
      consistent: true,
      checkedEntries: 3,
      storedBalance: { amount: "50.00" },
    });
  } finally {
    stop.abort();
    finish.release();
    await worker;
    await f.close();
  }
}, 25_000);
