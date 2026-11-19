import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import { ConfigurationError, loadEnvironment } from "./infrastructure/config/environment";
import { createLogger } from "./infrastructure/observability/logger";
import { collectBacklog } from "./infrastructure/observability/backlog";
import { Metrics } from "./infrastructure/observability/metrics";
import { ReadinessService } from "./infrastructure/observability/readiness.service";
import { createSqsClient } from "./infrastructure/messaging/sqs-client";
import { drainHttpApplication } from "./presentation/http/shutdown";
import { createHttpApplication } from "./presentation/http/http-application";

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const config = { ...environment, INSTANCE_ID: environment.INSTANCE_ID ?? randomUUID() };
  const logger = createLogger(config.LOG_LEVEL, config.INSTANCE_ID);
  const metrics = new Metrics(config.INSTANCE_ID);
  const app = await createHttpApplication(config, metrics);
  const readiness = app.get(ReadinessService);
  const host = config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  await app.listen(config.PORT, host);
  let metricsServer: ReturnType<Metrics["serve"]> | undefined;
  if (config.METRICS_PORT) {
    try {
      metricsServer = metrics.serve(config.METRICS_PORT);
    } catch {
      logger.warn(
        {
          event: "metrics.listener.failed",
          code: "METRICS_BIND_FAILED",
          port: config.METRICS_PORT,
        },
        "Bootstrap",
      );
    }
  }
  const collector =
    metricsServer && config.METRICS_SHARED_INTERVAL_MS ? createSqsClient(config, 1) : undefined;
  let collection: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (collector) {
    const orm = app.get<MikroORM>(MikroORM);
    const sample = () => {
      collection ??= collectBacklog(orm, collector, config, metrics).finally(() => {
        collection = undefined;
      });
    };
    sample();
    timer = setInterval(sample, config.METRICS_SHARED_INTERVAL_MS);
    timer.unref();
  }
  logger.log({ port: config.PORT, instanceId: config.INSTANCE_ID, pid: process.pid }, "Bootstrap");

  function stop(signal: NodeJS.Signals): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    readiness.stop();
    void metricsServer?.stop();
    clearInterval(timer);
    collector?.destroy();
    logger.log({ signal, instanceId: config.INSTANCE_ID }, "Shutdown");
    void drainHttpApplication(app, config.SHUTDOWN_TIMEOUT_MS).catch(() => {
      logger.error({ code: "SHUTDOWN_FAILED", instanceId: config.INSTANCE_ID }, "Shutdown");
      process.exit(1);
    });
  }

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void bootstrap().catch((error: unknown) => {
  const code = error instanceof ConfigurationError ? "INVALID_CONFIGURATION" : "API_STARTUP_FAILED";
  createLogger("error").error({ event: "api.startup.failed", code }, "Bootstrap");
  process.exitCode = 1;
});
