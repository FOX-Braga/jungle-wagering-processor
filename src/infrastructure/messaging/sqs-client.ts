import { SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../config/environment";

export function createSqsClient(config: AppConfig, maxAttempts = 2): SQSClient {
  return new SQSClient({
    endpoint: config.SQS_ENDPOINT,
    region: config.AWS_REGION,
    ...(config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
            ...(config.AWS_SESSION_TOKEN ? { sessionToken: config.AWS_SESSION_TOKEN } : {}),
          },
        }
      : {}),
    maxAttempts,
    useQueueUrlAsEndpoint: false,
  });
}
