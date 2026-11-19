import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../mikro-orm.config";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ConfigurationError, loadEnvironment } from "./infrastructure/config/environment";
import { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import { ReferenceWorker } from "./infrastructure/messaging/reference-worker";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { WagerConsumer } from "./infrastructure/messaging/wager-consumer";
import { createLogger } from "./infrastructure/observability/logger";
import { MikroTransactionManager } from "./infrastructure/persistence/transaction/mikro-transaction-manager";

async function main(): Promise<void> {
  const config = loadEnvironment();
  const role = process.argv[2];
  if (role !== "consumer" && role !== "outbox" && role !== "references") {
    throw new Error("Informe consumer, outbox ou references");
  }
  const logger = createLogger(config.LOG_LEVEL);
  const workerInstanceId = config.INSTANCE_ID ?? crypto.randomUUID();
  const context = { logger, workerInstanceId };
  const stop = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function shutdown() {
    if (stop.signal.aborted) return;
    stop.abort();
    logger.log({ result: "draining", role, workerInstanceId }, "Worker");
    deadline = setTimeout(() => {
      logger.error({ result: "shutdown_timeout", role, workerInstanceId }, "Worker");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    const orm = await MikroORM.init(createOrmOptions(config));
    const client = createSqsClient(config, 1);
    try {
      const transactions = new MikroTransactionManager(orm);
      const processor = new ProcessWagerTransactionUseCase(transactions, {
        ids: { next: () => crypto.randomUUID() },
        clock: { now: () => new Date() },
      });
      const worker =
        role === "references"
          ? new ReferenceWorker(transactions, processor, config, context)
          : role === "consumer"
            ? new WagerConsumer(client, processor, config, context)
            : new OutboxPublisher(client, transactions, config, context);
      logger.log({ result: "running", role, workerInstanceId }, "Worker");
      await worker.run(stop.signal);
    } finally {
      client.destroy();
      await orm.close(true);
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      result: "worker_startup_failed",
      message: error instanceof ConfigurationError ? error.message : "Falha ao iniciar worker",
    }),
  );
  process.exitCode = 1;
});
