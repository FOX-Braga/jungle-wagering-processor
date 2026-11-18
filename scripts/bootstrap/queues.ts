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
const queueAttributes = {
  ...fifoAttributes,
  ReceiveMessageWaitTimeSeconds: "10",
  VisibilityTimeout: "30",
};
const requestDeadline = () => ({ abortSignal: AbortSignal.timeout(5_000) });

async function ensureQueue(
  client: SQSClient,
  queueName: string,
  queueUrl: string,
  attributes: Partial<Record<QueueAttributeName, string>>,
): Promise<void> {
  try {
    await client.send(new GetQueueUrlCommand({ QueueName: queueName }), requestDeadline());
  } catch (error) {
    if (!(error instanceof QueueDoesNotExist)) throw error;

    await client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: "true", ...attributes },
      }),
      requestDeadline(),
    );
  }

  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["FifoQueue"] }),
    requestDeadline(),
  );
  if (Attributes?.FifoQueue !== "true") {
    throw new Error(`A fila ${queueName} deve ser FIFO`);
  }

  await client.send(
    new SetQueueAttributesCommand({ QueueUrl: queueUrl, Attributes: attributes }),
    requestDeadline(),
  );
}

export async function provisionQueues(client: SQSClient, config: AppConfig): Promise<void> {
  await ensureQueue(client, WAGER_DLQ_NAME, config.SQS_WAGER_DLQ_URL, fifoAttributes);
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
    ...queueAttributes,
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn, maxReceiveCount: 3 }),
  });
}
