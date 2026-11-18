import "reflect-metadata";
import { MikroORM, PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { AppModule } from "../../src/app.module";
import { loadEnvironment } from "../../src/infrastructure/config/environment";
import { SqsService } from "../../src/infrastructure/messaging/sqs.service";
import {
  ReadinessService,
  type ReadinessStatus,
} from "../../src/infrastructure/observability/readiness.service";
import { HealthController } from "../../src/presentation/http/health.controller";
import { validEnvironment } from "../helpers/test-environment";

describe("composição NestJS", () => {
  test("instancia módulos e providers sem conexões externas", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.register(loadEnvironment(validEnvironment))],
    }).compile();

    try {
      expect(module.get(HealthController)).toBeInstanceOf(HealthController);
      expect(module.get(ReadinessService)).toBeInstanceOf(ReadinessService);
      expect(module.get(SqsService)).toBeInstanceOf(SqsService);
      expect(module.get(MikroORM).em.getDriver()).toBeInstanceOf(PostgreSqlDriver);
    } finally {
      await module.close();
    }
  });
});

describe("health HTTP", () => {
  let app: INestApplication | undefined;

  async function startWithProbe(check: () => Promise<ReadinessStatus>): Promise<string> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: ReadinessService, useValue: { check } }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, "127.0.0.1");
    return app.getUrl();
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  test("liveness responde sem consultar dependências", async () => {
    const check = mock(() => Promise.reject(new Error("dependência indisponível")));
    const url = await startWithProbe(check);
    const response = await fetch(`${url}/health/live`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
  });

  test("readiness mapeia dependência indisponível para 503", async () => {
    const status = { status: "unavailable", checks: { postgres: "down", sqs: "up" } } as const;
    const url = await startWithProbe(() => Promise.resolve(status));
    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(status);
  });

  test("readiness mapeia dependências disponíveis para 200", async () => {
    const status = { status: "ok", checks: { postgres: "up", sqs: "up" } } as const;
    const url = await startWithProbe(() => Promise.resolve(status));
    const response = await fetch(`${url}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
  });
});
