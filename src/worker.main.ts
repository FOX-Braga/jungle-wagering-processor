import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../mikro-orm.config";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ConfigurationError, loadEnvironment } from "./infrastructure/config/environment";
import { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import { ReferenceWorker } from "./infrastructure/messaging/reference-worker";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { checkSqsQueues } from "./infrastructure/messaging/sqs.service";
import { WagerConsumer } from "./infrastructure/messaging/wager-consumer";
import { createLogger } from "./infrastructure/observability/logger";
import { Metrics } from "./infrastructure/observability/metrics";
import { DependencyProbe } from "./infrastructure/observability/dependency-probe";
import { checkPostgres } from "./infrastructure/persistence/postgres-probe";
import { MikroTransactionManager } from "./infrastructure/persistence/transaction/mikro-transaction-manager";

async function main(): Promise<void> {
  const config = loadEnvironment();
  const role = process.argv[2];
  if (role !== "consumer" && role !== "outbox" && role !== "references") {
    throw new Error("Informe consumer, outbox ou references");
  }
  const workerInstanceId = config.INSTANCE_ID ?? crypto.randomUUID();
  const logger = createLogger(config.LOG_LEVEL, workerInstanceId);
  const metrics = new Metrics(workerInstanceId, role);
  const context = { logger, workerInstanceId, metrics };
  const stop = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function shutdown() {
    if (stop.signal.aborted) return;
    stop.abort();
    metrics.record("wager_readiness", 0, "process");
    logger.log({ event: "worker.draining", result: "draining", role, workerInstanceId }, "Worker");
    deadline = setTimeout(() => {
      logger.error(
        { event: "worker.shutdown.timeout", result: "shutdown_timeout", role, workerInstanceId },
        "Worker",
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    const orm = await MikroORM.init(createOrmOptions({ ...config, INSTANCE_ID: workerInstanceId }));
    const client = createSqsClient(config, 1);
    let metricsServer: ReturnType<Metrics["serve"]> | undefined;
    let probeTimer: ReturnType<typeof setInterval> | undefined;
    try {
      metrics.record("wager_readiness", 0, "process");
      if (config.METRICS_PORT) {
        try {
          metricsServer = metrics.serve(config.METRICS_PORT);
        } catch {
          logger.warn(
            {
              event: "metrics.listener.failed",
              code: "METRICS_BIND_FAILED",
              port: config.METRICS_PORT,
            },
            "Worker",
          );
        }
      }
      if (metricsServer) {
        const postgres = new DependencyProbe(() => checkPostgres(orm));
        const queueUrl =
          role === "consumer"
            ? config.SQS_WAGER_QUEUE_URL
            : role === "outbox"
              ? config.SQS_EVENT_QUEUE_URL
              : undefined;
        const sqs = queueUrl
          ? new DependencyProbe(() => checkSqsQueues(client, [queueUrl]))
          : undefined;
        const probe = async () => {
          const [db, queue] = await Promise.all([postgres.check(), sqs?.check()]);
          if (stop.signal.aborted) return;
          metrics.record("wager_readiness", db === "up" ? 1 : 0, "postgres");
          if (sqs) metrics.record("wager_readiness", queue === "up" ? 1 : 0, "sqs");
        };
        void probe();
        probeTimer = setInterval(() => void probe(), 10_000);
        probeTimer.unref();
      }
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
      logger.log({ event: "worker.running", result: "running", role, workerInstanceId }, "Worker");
      await worker.run(stop.signal);
    } finally {
      clearInterval(probeTimer);
      await metricsServer?.stop();
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
  createLogger("error").error(
    {
      event: "worker.startup.failed",
      result: "worker_startup_failed",
      code: error instanceof ConfigurationError ? "INVALID_CONFIGURATION" : "WORKER_STARTUP_FAILED",
    },
    "Worker",
  );
  process.exitCode = 1;
});
