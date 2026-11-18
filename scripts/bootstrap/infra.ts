import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { existsSync } from "node:fs";
import { createOrmOptions } from "../../mikro-orm.config";
import {
  ConfigurationError,
  WAGER_DLQ_NAME,
  WAGER_QUEUE_NAME,
  loadEnvironment,
  type AppConfig,
} from "../../src/infrastructure/config/environment";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { SqsService } from "../../src/infrastructure/messaging/sqs.service";
import { checkPostgres } from "../../src/infrastructure/persistence/postgres-probe";
import { runMigrations } from "./migrate";
import { provisionQueues } from "./queues";

class BootstrapError extends Error {}

function runDocker(args: string[]): void {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "inherit", stderr: "inherit" });
  if (!result.success) throw new BootstrapError(`Falha em docker ${args.join(" ")}`);
}

function startInfrastructure(): void {
  runDocker(["compose", "version", "--short"]);
  runDocker(["info", "--format", "{{.ServerVersion}}"]);
  const envFiles = ["--env-file", ".env.example"];
  if (existsSync(".env")) envFiles.push("--env-file", ".env");
  runDocker([
    "compose",
    ...envFiles,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "90",
    "postgres",
    "sqs",
  ]);
}

async function provision(config: AppConfig): Promise<void> {
  try {
    await runMigrations(config, "up");
  } catch (error) {
    throw new BootstrapError("Falha ao aplicar migrations. Verifique a conexão e o schema.", {
      cause: error,
    });
  }

  const client = createSqsClient(config);
  try {
    await provisionQueues(client, config);
    console.log(JSON.stringify({ status: "ok", queues: [WAGER_QUEUE_NAME, WAGER_DLQ_NAME] }));
  } catch (error) {
    throw new BootstrapError("Falha ao provisionar filas. Verifique o endpoint e o MiniStack.", {
      cause: error,
    });
  } finally {
    client.destroy();
  }
}

async function doctor(config: AppConfig): Promise<void> {
  console.log(
    JSON.stringify({
      bun: Bun.version,
      postgres: new URL(config.DATABASE_URL).host,
      sqs: new URL(config.SQS_ENDPOINT).origin,
    }),
  );

  const orm = await MikroORM.init(createOrmOptions(config));
  const client = createSqsClient(config, 1);
  const sqs = new SqsService(config);
  try {
    const checks = await Promise.allSettled([
      checkPostgres(orm),
      sqs.checkQueues(),
      client
        .send(new ListQueuesCommand({ QueueNamePrefix: "wager-transactions" }), {
          abortSignal: AbortSignal.timeout(2_000),
        })
        .then(({ QueueUrls }) => {
          const names = new Set(QueueUrls?.map((url) => new URL(url).pathname.split("/").at(-1)));
          if (!names.has(WAGER_QUEUE_NAME) || !names.has(WAGER_DLQ_NAME)) {
            throw new Error("Filas obrigatórias ausentes");
          }
        }),
      runMigrations(config, "status"),
    ]);

    const names = ["postgres", "sqs", "queues", "migrations"];
    for (const [index, result] of checks.entries()) {
      console.log(
        JSON.stringify({
          check: names[index],
          status: result.status === "fulfilled" ? "ok" : "error",
        }),
      );
    }
    if (checks.some((result) => result.status === "rejected")) {
      throw new BootstrapError(
        "Diagnóstico encontrou dependências indisponíveis ou configuração incompleta",
      );
    }
  } finally {
    client.destroy();
    sqs.onModuleDestroy();
    await orm.close(true);
  }
}

async function main(): Promise<void> {
  if (!Bun.version.startsWith("1.")) throw new BootstrapError("Execute com Bun 1.x");
  const config = loadEnvironment();
  const command = process.argv[2];

  switch (command) {
    case "setup":
      startInfrastructure();
      await provision(config);
      return;
    case "provision":
      await provision(config);
      return;
    case "doctor":
      await doctor(config);
      return;
    default:
      throw new BootstrapError("Informe setup, provision ou doctor");
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof BootstrapError || error instanceof ConfigurationError
      ? error.message
      : "Falha na infraestrutura";
  console.error(JSON.stringify({ status: "error", message }));
  process.exitCode = 1;
});
