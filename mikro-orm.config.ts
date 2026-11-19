import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { join } from "node:path";
import type { AppConfig } from "./src/infrastructure/config/environment";
import { createLogger } from "./src/infrastructure/observability/logger";
import { financialEntities } from "./src/infrastructure/persistence/entities/financial-entities";

export function createOrmOptions(config: AppConfig, queryTimeoutMs = 1_500) {
  const migrations = join(__dirname, "src", "infrastructure", "persistence", "migrations");

  const logger = createLogger(config.LOG_LEVEL, config.INSTANCE_ID);

  return defineConfig({
    clientUrl: config.DATABASE_URL,
    connect: false,
    ensureDatabase: false,
    allowGlobalContext: false,
    logger: () => logger.debug({ event: "persistence.diagnostic" }, "MikroORM"),
    entities: financialEntities,
    debug:
      config.NODE_ENV === "development" && config.LOG_LEVEL === "debug" ? ["discovery"] : false,
    pool: { min: 0, max: 10, acquireTimeoutMillis: 2_500 },
    driverOptions: {
      connection: {
        application_name: config.INSTANCE_ID ?? "jungle-wagering",
        connectionTimeoutMillis: 1_500,
        query_timeout: queryTimeoutMs,
        statement_timeout: queryTimeoutMs - 100,
      },
      log: {
        warn: () =>
          logger.warn(
            { code: "DATABASE_DRIVER_WARNING", instanceId: config.INSTANCE_ID },
            "PostgreSQL",
          ),
      },
    },
    extensions: [Migrator],
    migrations: {
      path: migrations,
      pathTs: migrations,
      transactional: true,
      allOrNothing: true,
      disableForeignKeys: false,
      snapshot: false,
    },
  });
}
