import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { ConfigurationError, loadEnvironment } from "./infrastructure/config/environment";
import { createLogger } from "./infrastructure/observability/logger";

async function bootstrap(): Promise<void> {
  const config = loadEnvironment();
  const logger = createLogger(config.LOG_LEVEL);
  const app = await NestFactory.create(AppModule.register(config), {
    logger,
    abortOnError: false,
  });
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle("Jungle Wagering Processor")
    .setDescription("Health checks da fundação do processador.")
    .setVersion("0.1.0")
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, openApi));

  await app.listen(config.PORT, "0.0.0.0");
  logger.log(`API escutando na porta ${config.PORT}`, "Bootstrap");
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof ConfigurationError ? error.message : "Falha ao iniciar a API";
  createLogger("error").error(message, "Bootstrap");
  process.exitCode = 1;
});
