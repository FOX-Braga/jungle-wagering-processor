import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../mikro-orm.config";
import type { TransactionManager } from "../../src/application/ports/transaction-manager";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import type { AppConfig } from "../../src/infrastructure/config/environment";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { ReferenceWorker } from "../../src/infrastructure/messaging/reference-worker";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { WagerConsumer } from "../../src/infrastructure/messaging/wager-consumer";
import { createLogger } from "../../src/infrastructure/observability/logger";
import { MikroTransactionManager } from "../../src/infrastructure/persistence/transaction/mikro-transaction-manager";

export type WorkerRole = "consumer" | "outbox" | "references";
export type Failpoint =
  | "before-commit"
  | "after-commit"
  | "before-send"
  | "after-send"
  | "reference-before-commit"
  | "ack-fails"
  | "slow-commit";

async function block(result: string): Promise<never> {
  console.log(JSON.stringify({ result }));
  return new Promise<never>(() => {});
}

async function main() {
  const config = JSON.parse(process.env.TEST_WORKER_CONFIG!) as AppConfig;
  const role = process.argv[2] as WorkerRole;
  const point = process.argv[3] as Failpoint | undefined;
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort());
  // Windows can't send a catchable SIGTERM to a Bun child.
  if (process.platform === "win32") {
    process.stdin.on("data", (chunk) => {
      if (String(chunk).includes("shutdown")) stop.abort();
    });
  }
  const orm = await MikroORM.init(createOrmOptions(config));
  const client = createSqsClient(config, 1);
  const base = new MikroTransactionManager(orm);
  let release: () => void = () => {};
  const slowCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (point === "slow-commit") {
    process.stdin.on("data", (chunk) => {
      if (String(chunk).includes("release")) release();
    });
  }
  const transactions: TransactionManager =
    point === "before-commit" || point === "reference-before-commit" || point === "slow-commit"
      ? {
          execute: (work, options) =>
            base.execute(async (repos) => {
              const result = await work(repos);
              if (
                point === "reference-before-commit" &&
                !Array.isArray(result) &&
                result !== undefined
              )
                await block(point);
              if (point === "before-commit") await block(point);
              if (point === "slow-commit") {
                console.log(JSON.stringify({ result: point }));
                await slowCommit;
              }
              return result;
            }, options),
        }
      : base;
  const processor = new ProcessWagerTransactionUseCase(transactions, {
    ids: { next: () => crypto.randomUUID() },
    clock: { now: () => new Date() },
  });
  if (point === "after-send" || point === "before-send" || point === "ack-fails") {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (point === "ack-fails" && context.commandName === "DeleteMessageCommand") {
          throw new Error("Injected ACK network error");
        }
        if (point === "before-send" && context.commandName === "SendMessageCommand") {
          await block(point);
        }
        const result = await next(args);
        if (point === "after-send" && context.commandName === "SendMessageCommand") {
          await block(point);
        }
        return result;
      },
      { step: "initialize" },
    );
  }
  const workerContext = { workerInstanceId: config.INSTANCE_ID!, logger: createLogger("info") };
  const commandProcessor: Pick<ProcessWagerTransactionUseCase, "execute"> = {
    async execute(command) {
      const result = await processor.execute(command);
      if (point === "after-commit") await block(point);
      return result;
    },
  };
  try {
    const worker =
      role === "consumer"
        ? new WagerConsumer(client, commandProcessor, config, workerContext)
        : role === "outbox"
          ? new OutboxPublisher(client, transactions, config, workerContext)
          : new ReferenceWorker(transactions, processor, config, workerContext);
    console.log(JSON.stringify({ result: "worker_ready" }));
    await worker.run(stop.signal);
  } finally {
    client.destroy();
    await orm.close(true);
    process.stdin.pause();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
