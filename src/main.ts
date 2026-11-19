import { randomUUID } from "node:crypto";
import { ConfigurationError, loadEnvironment } from "./infrastructure/config/environment";
import { createLogger } from "./infrastructure/observability/logger";
import { drainHttpApplication } from "./presentation/http/shutdown";
import { createHttpApplication } from "./presentation/http/http-application";

async function bootstrap(): Promise<void> {
  const environment = loadEnvironment();
  const config = { ...environment, INSTANCE_ID: environment.INSTANCE_ID ?? randomUUID() };
  const logger = createLogger(config.LOG_LEVEL);
  const app = await createHttpApplication(config);
  const host = config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  await app.listen(config.PORT, host);
  logger.log({ port: config.PORT, instanceId: config.INSTANCE_ID, pid: process.pid }, "Bootstrap");

  function stop(signal: NodeJS.Signals): void {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
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
  const message = error instanceof ConfigurationError ? error.message : "Falha ao iniciar a API";
  createLogger("error").error(message, "Bootstrap");
  process.exitCode = 1;
});
