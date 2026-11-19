import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import type { ProcessWagerCommand } from "../../src/application/commands/financial-commands";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import type { AppConfig } from "../../src/infrastructure/config/environment";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { financialApplication } from "./application-fixtures";
import type { Failpoint, WorkerRole } from "./messaging-process";
import { createTestDatabase, loadIntegrationConfig } from "./test-database";
import { waitFor } from "./wait-for";

interface WorkerLog {
  observedAt: number;
  result?: string;
  messageId?: string;
  transactionId?: string;
  code?: string;
  attempt?: number;
  delaySeconds?: number;
  eventId?: string;
  workerInstanceId?: string;
}

async function startWorker(config: AppConfig, role: WorkerRole, point?: Failpoint) {
  const logs: WorkerLog[] = [];
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "test/helpers/messaging-process.ts",
      role,
      ...(point ? [point] : []),
    ],
    {
      env: { ...process.env, TEST_WORKER_CONFIG: JSON.stringify(config) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = (async () => {
    let remaining = "";
    for await (const str of child.stdout.pipeThrough(new TextDecoderStream())) {
      const lines = (remaining + str).split("\n");
      remaining = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const log = JSON.parse(line) as WorkerLog & { message?: WorkerLog };
        logs.push({ ...(log.message ?? log), observedAt: performance.now() });
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  async function kill(): Promise<void> {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await output;
  }
  async function waitLog(result: string, predicate: (log: WorkerLog) => boolean = () => true) {
    try {
      return await waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`Worker ${role} stopped: ${await stderr}`);
          return logs.find((log) => log.result === result && predicate(log));
        },
        `${role}:${result}`,
        20_000,
      );
    } catch (error) {
      throw new Error(`Worker ${role} waiting for ${result}: ${JSON.stringify(logs.slice(-8))}`, {
        cause: error,
      });
    }
  }
  async function requestStop(): Promise<void> {
    if (process.platform === "win32") {
      await child.stdin.write("shutdown\n");
      await child.stdin.flush();
    } else {
      child.kill("SIGTERM");
    }
  }
  async function release(): Promise<void> {
    await child.stdin.write("release\n");
    await child.stdin.flush();
  }
  try {
    await waitLog("worker_ready");
    const exited = child.exited.then(async (code) => {
      await output;
      return code;
    });
    return { logs, waitLog, kill, requestStop, release, exited, pid: child.pid };
  } catch (error) {
    await kill();
    throw error;
  }
}

export async function messagingFixture(
  options: { visibility?: number; maxReceives?: number } = {},
) {
  const database = await createTestDatabase();
  const base = loadIntegrationConfig();
  const sqs = createSqsClient(base, 1);
  const prefix = `phase6-${crypto.randomUUID()}`;
  const queueUrls: string[] = [];
  const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
  const visibility = options.visibility ?? 2;
  const maxReceives = options.maxReceives ?? 4;
  const fifo = { FifoQueue: "true" };
  const timeout = () => ({ abortSignal: AbortSignal.timeout(5_000) });

  async function createQueue(QueueName: string, Attributes: Record<string, string>) {
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName, Attributes }),
      timeout(),
    );
    if (!QueueUrl) throw new Error("SQS did not return QueueUrl");
    queueUrls.push(QueueUrl);
    return QueueUrl;
  }
  async function close() {
    try {
      await Promise.all(workers.map((worker) => worker.kill()));
    } finally {
      try {
        await Promise.all(
          queueUrls.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }), timeout())),
        );
      } finally {
        sqs.destroy();
        await database.close();
      }
    }
  }
  try {
    const dlq = await createQueue(`${prefix}-dlq.fifo`, fifo);
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ["QueueArn"] }),
      timeout(),
    );
    if (!Attributes?.QueueArn) throw new Error("SQS did not return DLQ ARN");
    const source = await createQueue(`${prefix}.fifo`, {
      ...fifo,
      VisibilityTimeout: String(visibility),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: Attributes.QueueArn,
        maxReceiveCount: maxReceives,
      }),
    });
    const events = await createQueue(`${prefix}-events`, {});
    const config: AppConfig = {
      ...base,
      DATABASE_URL: database.url.href,
      SQS_WAGER_QUEUE_URL: source,
      SQS_WAGER_DLQ_URL: dlq,
      SQS_EVENT_QUEUE_URL: events,
      SQS_VISIBILITY_TIMEOUT_SECONDS: visibility,
      SQS_MAX_RECEIVE_COUNT: maxReceives,
      SQS_CONSUMER_CONCURRENCY: 1,
      SQS_POLL_WAIT_SECONDS: 1,
      OUTBOX_LEASE_SECONDS: 5,
      OUTBOX_POLL_INTERVAL_MS: 100,
      REFERENCE_WORKER_INTERVAL_MS: 100,
      REFERENCE_MAX_ATTEMPTS: 2,
    };
    const app = financialApplication(database.orm);
    return {
      app,
      config,
      database,
      source,
      dlq,
      events,
      sqs,
      close,
      reconcile: new ReconcileWalletUseCase(app.manager),
      async start(role: WorkerRole, point?: Failpoint, changes: Partial<AppConfig> = {}) {
        const worker = await startWorker(
          { ...config, ...changes, INSTANCE_ID: `${role}-${crypto.randomUUID()}` },
          role,
          point,
        );
        workers.push(worker);
        return worker;
      },
      sendRaw(body: string, group: string) {
        return sqs.send(
          new SendMessageCommand({
            QueueUrl: source,
            MessageBody: body,
            MessageGroupId: group,
            MessageDeduplicationId: crypto.randomUUID(),
          }),
          timeout(),
        );
      },
      send(
        command: ProcessWagerCommand,
        messageId: string = crypto.randomUUID(),
        group = command.walletId,
      ) {
        const data = { ...command };
        const { correlationId, causationId } = data;
        delete data.correlationId;
        delete data.causationId;
        delete data.sourceMessageId;
        delete data.inbox;
        return this.sendRaw(
          JSON.stringify({
            messageId,
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            ...(correlationId ? { correlationId } : {}),
            ...(causationId ? { causationId } : {}),
            data,
          }),
          group,
        );
      },
      async receive(QueueUrl: string, visibility?: number) {
        const { Messages } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl,
            WaitTimeSeconds: 0,
            MaxNumberOfMessages: 1,
            ...(visibility === undefined ? {} : { VisibilityTimeout: visibility }),
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
          timeout(),
        );
        return Messages?.[0];
      },
      async delete(QueueUrl: string, ReceiptHandle: string) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle }), timeout());
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
