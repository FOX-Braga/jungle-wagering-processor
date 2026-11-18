import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmOptions } from "../../mikro-orm.config";
import {
  ConfigurationError,
  loadEnvironment,
  type AppConfig,
} from "../../src/infrastructure/config/environment";

type MigrationCommand = "up" | "down" | "status";

export async function runMigrations(config: AppConfig, command: MigrationCommand): Promise<void> {
  const orm = await MikroORM.init(createOrmOptions(config));
  try {
    const migrator = orm.getMigrator();

    if (command === "status") {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(
        JSON.stringify({
          status: "migrations",
          applied: executed.map(({ name }) => name),
          pending: pending.map(({ name }) => name),
        }),
      );
      if (pending.length) throw new Error("Há migrations pendentes");
      return;
    }

    const migrations = await migrator[command]();
    console.log(
      JSON.stringify({ status: command, migrations: migrations.map(({ name }) => name) }),
    );
  } finally {
    await orm.close(true);
  }
}

if (require.main === module) {
  const command = process.argv[2];
  if (command !== "up" && command !== "down" && command !== "status") {
    console.error("Informe up, down ou status");
    process.exitCode = 1;
  } else {
    void Promise.resolve()
      .then(() => runMigrations(loadEnvironment(), command))
      .catch((error: unknown) => {
        const detail =
          error instanceof ConfigurationError ? error.message : "Verifique o banco e o histórico";
        console.error(`Falha no comando de migration ${command}. ${detail}`);
        process.exitCode = 1;
      });
  }
}
