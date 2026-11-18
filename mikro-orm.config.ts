import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { join } from "node:path";
import type { AppConfig } from "./src/infrastructure/config/environment";
import { financialEntities } from "./src/infrastructure/persistence/entities/financial-entities";

export function createOrmOptions(config: AppConfig) {
  const migrations = join(__dirname, "src", "infrastructure", "persistence", "migrations");

  return defineConfig({
    clientUrl: config.DATABASE_URL,
    connect: false,
    ensureDatabase: false,
    allowGlobalContext: false,
    entities: financialEntities,
    debug:
      config.NODE_ENV === "development" && config.LOG_LEVEL === "debug" ? ["discovery"] : false,
    pool: { min: 0, max: 10, acquireTimeoutMillis: 2_500 },
    driverOptions: { connection: { connectionTimeoutMillis: 1_500, query_timeout: 1_500 } },
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
