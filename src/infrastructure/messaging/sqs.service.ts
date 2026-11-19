import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/environment";
import { createSqsClient } from "./sqs-client";

export async function checkSqsQueues(
  client: SQSClient,
  queueUrls: readonly string[],
): Promise<void> {
  const signal = AbortSignal.timeout(2_000);
  const results = await Promise.all(
    queueUrls.map((QueueUrl) =>
      client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }), {
        abortSignal: signal,
      }),
    ),
  );
  if (results.some(({ Attributes }) => !Attributes?.QueueArn)) {
    throw new Error("SQS did not confirm configured queues");
  }
}

@Injectable()
export class SqsService implements OnModuleDestroy {
  private readonly client: SQSClient;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = createSqsClient(config, 1);
  }

  async checkQueues(): Promise<void> {
    await checkSqsQueues(this.client, [
      this.config.SQS_WAGER_QUEUE_URL,
      this.config.SQS_WAGER_DLQ_URL,
      this.config.SQS_EVENT_QUEUE_URL,
    ]);
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
