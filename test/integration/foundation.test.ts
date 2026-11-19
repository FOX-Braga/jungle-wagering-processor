import "reflect-metadata";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createOrmOptions } from "../../mikro-orm.config";
import { AppModule } from "../../src/app.module";
import { WAGER_DLQ_NAME, WAGER_QUEUE_NAME } from "../../src/infrastructure/config/environment";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { checkPostgres } from "../../src/infrastructure/persistence/postgres-probe";
import { createDependencyLink } from "../helpers/dependency-link";
import { loadIntegrationConfig } from "../helpers/test-database";
import { waitFor } from "../helpers/wait-for";

const config = loadIntegrationConfig();
const requestDeadline = () => ({ abortSignal: AbortSignal.timeout(4_000) });
const baseline = "Migration20261118000000";
let orm: MikroORM;
let sqs: SQSClient;

beforeAll(async () => {
  orm = await MikroORM.init(createOrmOptions(config, 10_000));
  sqs = createSqsClient(config, 1);

  await waitFor(
    async () => {
      const probes = await Promise.allSettled([
        checkPostgres(orm),
        sqs.send(new ListQueuesCommand({}), requestDeadline()),
      ]);
      return probes.every(({ status }) => status === "fulfilled") ? true : undefined;
    },
    "PostgreSQL e MiniStack do Compose",
    20_000,
  );
}, 25_000);

afterAll(async () => {
  sqs?.destroy();
  await orm?.close(true);
});

describe("PostgreSQL e MikroORM", () => {
  test("consulta PostgreSQL e confirma a baseline provisionada", async () => {
    const rows = await orm.em
      .getConnection()
      .execute<{ database: string }[]>("select current_database() as database");
    expect(rows[0]?.database).toBe(
      decodeURIComponent(new URL(config.DATABASE_URL).pathname.slice(1)),
    );

    const executed = await orm.getMigrator().getExecutedMigrations();
    expect(executed.map(({ name }) => name)).toContain(baseline);
    expect(await orm.getMigrator().getPendingMigrations()).toEqual([]);
  });

  test("rejeita credenciais PostgreSQL inválidas", async () => {
    const invalidUrl = new URL(config.DATABASE_URL);
    invalidUrl.password = randomUUID();
    const badOrm = await MikroORM.init(
      createOrmOptions({ ...config, DATABASE_URL: invalidUrl.href }),
    );

    try {
      const failure = await checkPostgres(badOrm).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "28P01" });
    } finally {
      await badOrm.close(true);
    }
  });

  test("aplica, reverte e reaplica migrations em um banco descartável", async () => {
    const database = `phase1_${randomUUID().replaceAll("-", "")}`;
    const connection = orm.em.getConnection();
    await connection.execute(`create database "${database}"`);
    let disposable: MikroORM | undefined;

    try {
      const url = new URL(config.DATABASE_URL);
      url.pathname = `/${database}`;
      disposable = await MikroORM.init(createOrmOptions({ ...config, DATABASE_URL: url.href }));
      const migrator = disposable.getMigrator();
      const migrationConnection = disposable.em.getConnection();
      const schemaExists = async () => {
        const rows = await migrationConnection.execute<{ present: boolean }[]>(
          "select to_regnamespace('wagering') is not null as present",
        );
        return rows[0]?.present;
      };

      expect(await schemaExists()).toBe(false);
      await migrator.up();
      expect(await schemaExists()).toBe(true);
      expect((await migrator.getExecutedMigrations()).map(({ name }) => name)).toContain(baseline);

      await migrator.down({ to: 0 });
      expect(await schemaExists()).toBe(false);
      expect(await migrator.getExecutedMigrations()).toEqual([]);

      await migrator.up();
      expect(await schemaExists()).toBe(true);
      expect(await migrator.getPendingMigrations()).toEqual([]);
    } finally {
      try {
        await disposable?.close(true);
      } finally {
        await connection.execute(`drop database if exists "${database}"`);
      }
    }
  }, 15_000);
});

async function withFifoQueues(run: (source: string, dlq: string) => Promise<void>): Promise<void> {
  const testId = randomUUID();
  const queues: string[] = [];
  const fifo = { FifoQueue: "true", ContentBasedDeduplication: "true" };

  try {
    const deadLetter = await sqs.send(
      new CreateQueueCommand({ QueueName: `phase1-${testId}-dlq.fifo`, Attributes: fifo }),
      requestDeadline(),
    );
    if (!deadLetter.QueueUrl) throw new Error("SQS não retornou URL da DLQ");
    queues.push(deadLetter.QueueUrl);

    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: deadLetter.QueueUrl,
        AttributeNames: ["QueueArn"],
      }),
      requestDeadline(),
    );
    if (!Attributes?.QueueArn) throw new Error("SQS não retornou ARN da DLQ");

    const source = await sqs.send(
      new CreateQueueCommand({
        QueueName: `phase1-${testId}.fifo`,
        Attributes: {
          ...fifo,
          VisibilityTimeout: "1",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: Attributes.QueueArn,
            maxReceiveCount: 2,
          }),
        },
      }),
      requestDeadline(),
    );
    if (!source.QueueUrl) throw new Error("SQS não retornou URL da fila de origem");
    queues.push(source.QueueUrl);

    await run(source.QueueUrl, deadLetter.QueueUrl);
  } finally {
    await Promise.all(
      queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }), requestDeadline())),
    );
  }
}

async function send(QueueUrl: string, MessageBody: string) {
  return sqs.send(
    new SendMessageCommand({ QueueUrl, MessageBody, MessageGroupId: "integration" }),
    requestDeadline(),
  );
}

async function receive(QueueUrl: string, WaitTimeSeconds: number): Promise<Message | undefined> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl,
      WaitTimeSeconds,
      MaxNumberOfMessages: 1,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
    requestDeadline(),
  );
  return result.Messages?.[0];
}

async function remove(QueueUrl: string, message: Message): Promise<void> {
  if (!message.ReceiptHandle) throw new Error("SQS não retornou receipt handle");
  await sqs.send(
    new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }),
    requestDeadline(),
  );
}

describe("SQS FIFO real", () => {
  test("lista as filas oficiais e confirma FIFO, dedup, long polling e redrive", async () => {
    const listed = await sqs.send(
      new ListQueuesCommand({ QueueNamePrefix: "wager-transactions" }),
      requestDeadline(),
    );
    const names = listed.QueueUrls?.map((url) => new URL(url).pathname.split("/").at(-1));
    expect(names).toContain(WAGER_QUEUE_NAME);
    expect(names).toContain(WAGER_DLQ_NAME);

    const [source, dlq] = await Promise.all(
      [config.SQS_WAGER_QUEUE_URL, config.SQS_WAGER_DLQ_URL].map((QueueUrl) =>
        sqs.send(
          new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["All"] }),
          requestDeadline(),
        ),
      ),
    );

    expect(dlq?.Attributes).toMatchObject({ FifoQueue: "true", ContentBasedDeduplication: "true" });
    expect(source?.Attributes).toMatchObject({
      FifoQueue: "true",
      ContentBasedDeduplication: "true",
      ReceiveMessageWaitTimeSeconds: "10",
      VisibilityTimeout: "30",
    });
    const redrive = source?.Attributes?.RedrivePolicy;
    const deadLetterArn = dlq?.Attributes?.QueueArn;
    if (!redrive || !deadLetterArn) throw new Error("Configuração de redrive incompleta");
    const policy = JSON.parse(redrive) as {
      deadLetterTargetArn: string;
      maxReceiveCount: string | number;
    };
    expect(policy.deadLetterTargetArn).toBe(deadLetterArn);
    expect(Number(policy.maxReceiveCount)).toBe(3);
  });

  test("envia, recebe e exclui sem redelivery depois da exclusão", async () => {
    await withFifoQueues(async (source) => {
      const body = `ack-${randomUUID()}`;
      const sent = await send(source, body);
      const message = await waitFor(() => receive(source, 1), "mensagem enviada");

      expect(message.MessageId).toBe(sent.MessageId);
      expect(message.Body).toBe(body);
      await remove(source, message);
      expect(await receive(source, 2)).toBeUndefined();
    });
  }, 15_000);

  test("entrega novamente após expirar visibilidade sem exclusão", async () => {
    await withFifoQueues(async (source) => {
      const sent = await send(source, `redelivery-${randomUUID()}`);
      const first = await waitFor(() => receive(source, 1), "primeira entrega");
      expect(first.Attributes?.ApproximateReceiveCount).toBe("1");
      expect(await receive(source, 0)).toBeUndefined();

      const again = await waitFor(() => receive(source, 1), "expiração da visibilidade");
      expect(again.Attributes?.ApproximateReceiveCount).toBe("2");
      expect(again.MessageId).toBe(sent.MessageId);
      expect(typeof first.ReceiptHandle).toBe("string");
      expect(again.ReceiptHandle === first.ReceiptHandle).toBe(false);
      await remove(source, again);
    });
  }, 15_000);

  test("move mensagem não excluída para a DLQ após o limite", async () => {
    await withFifoQueues(async (source, dlq) => {
      const body = `dlq-${randomUUID()}`;
      await send(source, body);

      const first = await waitFor(() => receive(source, 1), "primeira tentativa");
      const second = await waitFor(() => receive(source, 1), "segunda tentativa");
      expect(first.Attributes?.ApproximateReceiveCount).toBe("1");
      expect(second.Attributes?.ApproximateReceiveCount).toBe("2");
      expect(await receive(source, 2)).toBeUndefined();

      const deadLetter = await waitFor(() => receive(dlq, 1), "redrive para a DLQ");
      expect(deadLetter.Body).toBe(body);
      await remove(dlq, deadLetter);
    });
  }, 15_000);
});

describe("API e dependências reais", () => {
  test("readiness detecta e recupera quedas independentes, liveness permanece 200", async () => {
    const postgres = await createDependencyLink(new URL(config.DATABASE_URL), 5432);
    let sqsLink: Awaited<ReturnType<typeof createDependencyLink>> | undefined;
    let app: INestApplication | undefined;

    try {
      const sqsEndpoint = new URL(config.SQS_ENDPOINT);
      sqsLink = await createDependencyLink(
        sqsEndpoint,
        sqsEndpoint.protocol === "https:" ? 443 : 80,
      );
      app = await NestFactory.create(
        AppModule.register({
          ...config,
          DATABASE_URL: postgres.url.href,
          SQS_ENDPOINT: sqsLink.url.origin,
          SQS_WAGER_QUEUE_URL: new URL(new URL(config.SQS_WAGER_QUEUE_URL).pathname, sqsLink.url)
            .href,
          SQS_WAGER_DLQ_URL: new URL(new URL(config.SQS_WAGER_DLQ_URL).pathname, sqsLink.url).href,
        }),
        { logger: false, abortOnError: false },
      );

      await app.listen(0, "127.0.0.1");
      const url = await app.getUrl();
      const ready = () => fetch(`${url}/health/ready`);
      const live = () => fetch(`${url}/health/live`);
      const waitForReady = () =>
        waitFor(async () => {
          const response = await ready();
          if (response.ok) return response;
          await response.body?.cancel();
          return undefined;
        }, "readiness após restabelecer a conexão");

      expect(await (await waitForReady()).json()).toEqual({
        status: "ok",
        checks: { postgres: "up", sqs: "up" },
      });

      postgres.setAvailable(false);
      const postgresDown = await ready();
      expect(postgresDown.status).toBe(503);
      expect(await postgresDown.json()).toEqual({
        status: "unavailable",
        checks: { postgres: "down", sqs: "up" },
      });
      expect((await live()).status).toBe(200);

      postgres.setAvailable(true);
      expect(await (await waitForReady()).json()).toEqual({
        status: "ok",
        checks: { postgres: "up", sqs: "up" },
      });

      sqsLink.setAvailable(false);
      const sqsDown = await ready();
      expect(sqsDown.status).toBe(503);
      expect(await sqsDown.json()).toEqual({
        status: "unavailable",
        checks: { postgres: "up", sqs: "down" },
      });
      expect((await live()).status).toBe(200);

      sqsLink.setAvailable(true);
      expect(await (await waitForReady()).json()).toEqual({
        status: "ok",
        checks: { postgres: "up", sqs: "up" },
      });
    } finally {
      try {
        await app?.close();
      } finally {
        await Promise.all([postgres.close(), sqsLink?.close()]);
      }
    }
  }, 25_000);
});
