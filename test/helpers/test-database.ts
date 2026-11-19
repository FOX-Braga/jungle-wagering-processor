import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";
import { createOrmOptions } from "../../mikro-orm.config";
import { loadEnvironment } from "../../src/infrastructure/config/environment";

const localHosts = ["127.0.0.1", "localhost", "[::1]"];

export function loadIntegrationConfig() {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw || !URL.canParse(raw)) throw new Error("Configure TEST_DATABASE_URL via .env.test");
  const url = new URL(raw);
  if (
    !localHosts.includes(url.hostname) ||
    !url.port ||
    url.port === "5432" ||
    !["/jungle", "/jungle_test"].includes(url.pathname)
  ) {
    throw new Error("TEST_DATABASE_URL must point to the isolated local Compose database");
  }
  const config = loadEnvironment({ ...process.env, DATABASE_URL: raw });
  if (!localHosts.includes(new URL(config.SQS_ENDPOINT).hostname)) {
    throw new Error("SQS integration requires a local emulator");
  }
  return config;
}

export async function createTestDatabase(migrate = true) {
  const config = loadIntegrationConfig();
  const options = createOrmOptions(config, 10_000);
  const admin = await MikroORM.init(options);
  const name = `financial_test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(config.DATABASE_URL);
  url.pathname = `/${name}`;
  const testConfig = { ...config, DATABASE_URL: url.href };
  const migrationOptions = createOrmOptions(testConfig, 10_000);
  const testOptions = migrate ? createOrmOptions(testConfig) : migrationOptions;
  const connection = admin.em.getConnection();
  let created = false;
  let orm: MikroORM | undefined;
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      await orm?.close(true);
    } finally {
      try {
        if (created) await connection.execute(`drop database "${name}" with (force)`);
      } finally {
        await admin.close(true);
      }
    }
  }

  try {
    await connection.execute(`create database "${name}"`);
    created = true;
    if (migrate) {
      const migrationOrm = await MikroORM.init(migrationOptions);
      try {
        await migrationOrm.getMigrator().up();
      } finally {
        await migrationOrm.close(true);
      }
    }
    orm = await MikroORM.init(testOptions);
    return { orm, close, testOptions, name, url };
  } catch (error) {
    await close();
    throw error;
  }
}
