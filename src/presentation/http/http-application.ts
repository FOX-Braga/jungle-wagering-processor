import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { AppModule } from "../../app.module";
import type { AppConfig } from "../../infrastructure/config/environment";
import { createLogger } from "../../infrastructure/observability/logger";
import { Metrics } from "../../infrastructure/observability/metrics";
import { identifierPattern } from "./dto/financial-requests";
import { HttpExceptionFilter } from "./http-exception.filter";
import { HttpValidationPipe } from "./http-validation.pipe";
import { HttpAdmissionInterceptor, requestContextMiddleware } from "./request-context";

export const httpBodyLimit = 16 * 1024;

export async function createHttpApplication(
  config: AppConfig,
  metrics = new Metrics(config.INSTANCE_ID ?? randomUUID()),
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, metrics),
    {
      logger: createLogger(config.LOG_LEVEL, metrics.instanceId),
      abortOnError: false,
      bodyParser: false,
    },
  );
  app.disable("x-powered-by");
  app.use(requestContextMiddleware(metrics.instanceId, metrics, config.HTTP_MAX_IN_FLIGHT));
  app.useBodyParser("json", { limit: httpBodyLimit, strict: true, inflate: false });
  app.useGlobalPipes(new HttpValidationPipe());
  app.useGlobalInterceptors(new HttpAdmissionInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  if (config.NODE_ENV !== "production") {
    const info = new DocumentBuilder()
      .setTitle("Jungle Wagering Processor")
      .setDescription(
        "API financeira da Fase 5. Sem autenticação no ambiente de avaliação. X-Correlation-Id é opcional e devolvido no cabeçalho de resposta.",
      )
      .addGlobalParameters({
        name: "X-Correlation-Id",
        in: "header",
        required: false,
        schema: { type: "string", pattern: identifierPattern },
        description: "Identificador opcional de rastreamento, devolvido na resposta",
      })
      .setVersion("0.1.0")
      .build();
    SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, info), {
      jsonDocumentUrl: "/docs-json",
    });
  }

  const server: Server = app.getHttpServer();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.prependListener("request", (_request, response) => {
    response.once("finish", () => {
      if (!server.listening) setImmediate(() => server.closeIdleConnections());
    });
  });
  return app;
}
