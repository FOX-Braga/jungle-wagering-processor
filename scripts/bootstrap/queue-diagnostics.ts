import { GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { loadEnvironment } from "../../src/infrastructure/config/environment";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";

async function main() {
  const config = loadEnvironment();
  const client = createSqsClient(config, 1);
  try {
    const queueUrls = [
      config.SQS_WAGER_QUEUE_URL,
      config.SQS_WAGER_DLQ_URL,
      config.SQS_EVENT_QUEUE_URL,
    ];
    for (const QueueUrl of queueUrls) {
      const { Attributes } = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl,
          AttributeNames: ["All"],
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      console.log(
        JSON.stringify({
          queue: new URL(QueueUrl).pathname.split("/").at(-1),
          attributes: Attributes,
        }),
      );
    }
  } finally {
    client.destroy();
  }
}

void main().catch(() => {
  console.error(JSON.stringify({ result: "queue_diagnostics_failed" }));
  process.exitCode = 1;
});
