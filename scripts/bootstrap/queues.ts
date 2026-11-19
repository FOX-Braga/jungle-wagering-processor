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

async function ensureQueue(
  client: SQSClient,
  queueName: string,
  queueUrl: string,
  attributes: Partial<Record<QueueAttributeName, string>>,
  fifo = true,
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

  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["FifoQueue"] }),
    requestDeadline(),
  );
  if ((Attributes?.FifoQueue === "true") !== fifo) {
    throw new Error(`Tipo incompatível para a fila ${queueName}`);
  }

  await client.send(
    new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: attributes }),
    requestDeadline(),
  );
}

export async function provisionQueues(client: SQSClient, config: AppConfig): Promise<void> {
  await ensureQueue(client, WAGER_DLQ_NAME, config.SQS_WAGER_DLQ_URL, {
    ...fifoAttributes,
    MessageRetentionPeriod: "1209600",
  });
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: config.SQS_WAGER_DLQ_URL,
      AttributeNames: ["QueueArn"],
    }),
    requestDeadline(),
  );

  const deadLetterTargetArn = Attributes?.QueueArn;
  if (!deadLetterTargetArn) throw new Error("A DLQ não retornou seu ARN");

  await ensureQueue(client, WAGER_QUEUE_NAME, config.SQS_WAGER_QUEUE_URL, {
    ...fifoAttributes,
    ReceiveMessageWaitTimeSeconds: String(config.SQS_POLL_WAIT_SECONDS),
    VisibilityTimeout: String(config.SQS_VISIBILITY_TIMEOUT_SECONDS),
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn,
      maxReceiveCount: config.SQS_MAX_RECEIVE_COUNT,
    }),
  });
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
  );
}
