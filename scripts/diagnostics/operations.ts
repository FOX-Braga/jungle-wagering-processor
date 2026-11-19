import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../mikro-orm.config";
import { ConfigurationError, loadEnvironment } from "../../src/infrastructure/config/environment";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { collectBacklog } from "../../src/infrastructure/observability/backlog";
import { Metrics } from "../../src/infrastructure/observability/metrics";

async function main(): Promise<void> {
  const config = loadEnvironment();
  const orm = await MikroORM.init(createOrmOptions(config));
  const client = createSqsClient(config, 1);
  try {
    const metrics = new Metrics(config.INSTANCE_ID ?? crypto.randomUUID());
    const healthy = await collectBacklog(orm, client, config, metrics);
    console.log(JSON.stringify(metrics.snapshot()));
    process.exitCode = healthy ? 0 : 1;
  } finally {
    client.destroy();
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "INCOMPLETE",
      code: error instanceof ConfigurationError ? "INVALID_CONFIGURATION" : "DIAGNOSTICS_FAILED",
    }),
  );
  process.exitCode = 1;
});
