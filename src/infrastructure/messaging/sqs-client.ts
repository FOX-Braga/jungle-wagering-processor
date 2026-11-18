import { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config/environment";

export function createSqsClient(config: AppConfig, maxAttempts = 2): SQSClient {
  return new SQSClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    credentials: {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
    },
    maxAttempts,
    useQueueUrlAsEndpoint: false,
  });
}
