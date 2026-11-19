import { MikroORM } from "@mikro-orm/postgresql";
import { existsSync, readdirSync } from "node:fs";
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
import { collectBacklog } from "../../src/infrastructure/observability/backlog";
import { Metrics } from "../../src/infrastructure/observability/metrics";
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
    const eventName = new URL(config.SQS_EVENT_QUEUE_URL).pathname.split("/").at(-1);
    console.log(
      JSON.stringify({ status: "ok", queues: [WAGER_QUEUE_NAME, WAGER_DLQ_NAME, eventName] }),
    );
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

  const options = createOrmOptions(config);
  const orm = await MikroORM.init(options);
  const client = createSqsClient(config, 1);
  const sqs = new SqsService(config);
  const metrics = new Metrics(config.INSTANCE_ID ?? crypto.randomUUID());
  try {
    const checks = await Promise.allSettled([
      checkPostgres(orm),
      sqs.checkQueues(),
      migrationInventory(orm, options.migrations?.path),
      collectBacklog(orm, client, config, metrics).then((healthy) => {
        console.log(JSON.stringify({ check: "backlog", ...metrics.snapshot() }));
        if (!healthy) throw new Error("Backlog unavailable");
      }),
    ]);

    const names = ["postgres", "sqs_queues", "migrations", "backlog"];
    for (const [index, result] of checks.entries()) {
      console.log(
        JSON.stringify({
          check: names[index],
          status: result.status === "fulfilled" ? "ok" : "error",
        }),
      );
    }
    const ready = checks[0]?.status === "fulfilled" && checks[1]?.status === "fulfilled";
    console.log(
      JSON.stringify({ check: "readiness_dependencies", status: ready ? "ok" : "error" }),
    );
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

async function migrationInventory(orm: MikroORM, path: string | undefined): Promise<void> {
  if (!path) throw new Error("Missing migrations directory");
  const expected = readdirSync(path).flatMap((file) => {
    const name = /^Migration\d+(?=\.(?:ts|js)$)/.exec(file)?.[0];
    return name ? [name] : [];
  });
  const rows = await orm.em
    .getConnection()
    .execute<{ name: string }[]>("select name from public.mikro_orm_migrations");
  const applied = rows.map(({ name }) => name);
  const pending = expected.filter((name) => !applied.includes(name));
  console.log(JSON.stringify({ check: "migration_inventory", applied, pending }));
  if (expected.length === 0 || pending.length > 0) throw new Error("Pending migrations");
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
