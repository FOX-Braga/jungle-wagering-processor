export const validEnvironment = {
  NODE_ENV: "test",
  PORT: "3000",
  DATABASE_URL: "postgresql://jungle:unit-test@127.0.0.1:5434/jungle",
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "000000000000",
  AWS_SECRET_ACCESS_KEY: "unit-test",
  SQS_ENDPOINT: "http://127.0.0.1:4567",
  SQS_WAGER_QUEUE_URL: "http://127.0.0.1:4567/000000000000/wager-transactions.fifo",
  SQS_WAGER_DLQ_URL: "http://127.0.0.1:4567/000000000000/wager-transactions-dlq.fifo",
  LOG_LEVEL: "error",
};
