import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  QueueDoesNotExist,
  SetQueueAttributesCommand,
  type QueueAttributeName,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  WAGER_DLQ_NAME,
  WAGER_QUEUE_NAME,
  type AppConfig,
} from "../../src/infrastructure/config/environment";

const fifoAttributes = { ContentBasedDeduplication: "true" };
const requestDeadline = () => ({ abortSignal: AbortSignal.timeout(5_000) });
type QueueAttributes = Partial<Record<QueueAttributeName, string>>;

function decodeRedrive(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const data: unknown = JSON.parse(value);
    if (
      !data ||
      typeof data !== "object" ||
      !("deadLetterTargetArn" in data) ||
      typeof data.deadLetterTargetArn !== "string" ||
      !("maxReceiveCount" in data)
    )
      return undefined;
    const count = data.maxReceiveCount;
    if (typeof count !== "string" && typeof count !== "number") return undefined;
    return JSON.stringify([data.deadLetterTargetArn, String(count)]);
  } catch {
    return undefined;
  }
}

async function ensureQueue(
  client: SQSClient,
  queueName: string,
  queueUrl: string,
  attributes: QueueAttributes,
  fifo = true,
  requireEncryption = false,
): Promise<void> {
  try {
    await client.send(new GetQueueUrlCommand({ QueueName: queueName }), requestDeadline());
  } catch (error) {
    if (!(error instanceof QueueDoesNotExist)) throw error;

    await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: fifo ? { FifoQueue: "true", ...attributes } : attributes,
      }),
      requestDeadline(),
    );
  }

  const AttributeNames: QueueAttributeName[] = [
    "FifoQueue",
    ...(Object.keys(attributes) as QueueAttributeName[]),
    ...(requireEncryption ? (["KmsMasterKeyId", "SqsManagedSseEnabled"] as const) : []),
  ];
  const read = async () => {
    const { Attributes } = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames }),
      requestDeadline(),
    );
    if ((Attributes?.FifoQueue === "true") !== fifo)
      throw new Error(`Tipo incompatível para a fila ${queueName}`);
    return Attributes ?? {};
  };
  const current = await read();
  const expected: QueueAttributes = { ...attributes };
  // Preserve existing KMS configuration. Managed SSE covers unencrypted queues in deployed environments.
  if (requireEncryption && !current.KmsMasterKeyId) expected.SqsManagedSseEnabled = "true";
  const drift = (state: QueueAttributes): QueueAttributes =>
    Object.fromEntries(
      (Object.keys(expected) as QueueAttributeName[]).flatMap((key) => {
        const value = expected[key];
        const matches =
          key === "RedrivePolicy"
            ? decodeRedrive(state[key]) === decodeRedrive(value)
            : state[key] === value;
        return matches || value === undefined ? [] : [[key, value]];
      }),
    );
  const changed = drift(current);
  if (!Object.keys(changed).length) return;
  await client.send(
    new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: changed }),
    requestDeadline(),
  );
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    if (!Object.keys(drift(await read())).length) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`Atributos ainda divergentes para a fila ${queueName}`);
}

export async function provisionQueues(client: SQSClient, config: AppConfig): Promise<void> {
  const encryption = config.NODE_ENV === "production" && !config.ALLOW_LOCAL_SERVICES;
  await ensureQueue(
    client,
    WAGER_DLQ_NAME,
    config.SQS_WAGER_DLQ_URL,
    {
      ...fifoAttributes,
      MessageRetentionPeriod: "1209600",
    },
    true,
    encryption,
  );
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: config.SQS_WAGER_DLQ_URL,
      AttributeNames: ["QueueArn"],
    }),
    requestDeadline(),
  );

  const deadLetterTargetArn = Attributes?.QueueArn;
  if (!deadLetterTargetArn) throw new Error("A DLQ não retornou seu ARN");

  await ensureQueue(
    client,
    WAGER_QUEUE_NAME,
    config.SQS_WAGER_QUEUE_URL,
    {
      ...fifoAttributes,
      ReceiveMessageWaitTimeSeconds: String(config.SQS_POLL_WAIT_SECONDS),
      VisibilityTimeout: String(config.SQS_VISIBILITY_TIMEOUT_SECONDS),
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn,
        maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
      }),
    },
    true,
    encryption,
  );
  const eventName = new URL(config.SQS_EVENT_QUEUE_URL).pathname.split("/").at(-1)!;
  await ensureQueue(
    client,
    eventName,
    config.SQS_EVENT_QUEUE_URL,
    {
      MessageRetentionPeriod: "1209600",
      ReceiveMessageWaitTimeSeconds: String(config.SQS_POLL_WAIT_SECONDS),
    },
    false,
    encryption,
  );
}
