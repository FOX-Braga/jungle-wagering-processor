import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { expect, test } from "bun:test";
import { createOrmOptions } from "../../mikro-orm.config";
import { loadEnvironment } from "../../src/infrastructure/config/environment";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";
import { command, financialApplication } from "../helpers/application-fixtures";
import { failureFrom } from "../helpers/failure-from";
import { createTestDatabase, loadIntegrationConfig } from "../helpers/test-database";
import { validEnvironment } from "../helpers/test-environment";

test("rejects insecure production defaults and supports a managed AWS identity", () => {
  expect(() => loadEnvironment({ ...validEnvironment, NODE_ENV: "production" })).toThrow(
    /DATABASE_URL|SQS_ENDPOINT/,
  );
  const local = loadEnvironment({
    ...validEnvironment,
    NODE_ENV: "production",
    ALLOW_LOCAL_SERVICES: "true",
  });
  expect(local.ALLOW_LOCAL_SERVICES).toBe(true);
  const endpoint = "https://sqs.us-east-1.amazonaws.com";
  const account = "123456789012";
  const production = {
    NODE_ENV: "production",
    PORT: "3000",
    LOG_LEVEL: "info",
    AWS_REGION: "us-east-1",
    AWS_ACCOUNT_ID: account,
    SQS_ENDPOINT: endpoint,
    SQS_WAGER_QUEUE_URL: `${endpoint}/${account}/wager-transactions.fifo`,
    SQS_WAGER_DLQ_URL: `${endpoint}/${account}/wager-transactions-dlq.fifo`,
    DATABASE_URL: "postgresql://runtime:fixture-only-password@db.example/db?sslmode=verify-full",
  };
  const config = loadEnvironment(production);
  expect(config.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(config.SQS_EVENT_QUEUE_URL).toBe(`${endpoint}/${account}/wager-events`);
  for (const DATABASE_URL of [
    `${production.DATABASE_URL}&sslmode=disable`,
    "postgresql://runtime:%6A%75%6E%67%6C%65%5F%64%65%76@db.example/db?sslmode=verify-full",
  ]) {
    expect(() => loadEnvironment({ ...production, DATABASE_URL })).toThrow(/DATABASE_URL/);
  }
  expect(() => loadEnvironment({ ...validEnvironment, AWS_SECRET_ACCESS_KEY: undefined })).toThrow(
    /AWS_SECRET_ACCESS_KEY/,
  );
  expect(() => loadEnvironment({ ...validEnvironment, METRICS_PORT: "3000" })).toThrow(
    /METRICS_PORT/,
  );
});

test("runtime has only operational PostgreSQL grants and audit connects read-only", async () => {
  const database = await createTestDatabase();
  const config = loadIntegrationConfig();
  const admin = await MikroORM.init(createOrmOptions(config, 10_000));
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const runtimeRole = `runtime_${suffix}`;
  const auditRole = `audit_${suffix}`;
  const testPassword = crypto.randomUUID();
  let runtime: MikroORM | undefined;
  let auditor: MikroORM | undefined;
  function asRole(username: string) {
    const url = new URL(database.url);
    url.username = username;
    url.password = testPassword;
    return MikroORM.init(createOrmOptions({ ...config, DATABASE_URL: url.href }));
  }
  try {
    const conn = database.orm.em.getConnection();
    await conn.execute(
      `create role "${runtimeRole}" login password '${testPassword}'; create role "${auditRole}" login password '${testPassword}'`,
    );
    const grants = await Bun.file("scripts/bootstrap/database-privileges.sql").text();
    await conn.execute(
      grants
        .replaceAll(':"runtime_role"', `"${runtimeRole}"`)
        .replaceAll(':"audit_role"', `"${auditRole}"`),
    );
    runtime = await asRole(runtimeRole);
    auditor = await asRole(auditRole);
    const app = financialApplication(runtime);
    const wallet = await app.open();
    await app.process.execute(command(wallet));
    const audit = await auditWallets(
      auditor,
      {
        walletId: wallet.id,
        batchSize: 10,
        signal: AbortSignal.timeout(5_000),
      },
      () => {
        throw new Error("Unexpected discrepancy");
      },
    );
    expect(audit).toEqual({ walletsChecked: 1, inconsistent: 0, ledgerEntriesChecked: "2" });
    const runtimeConnection = runtime.em.getConnection();
    for (const sql of [
      "drop table wagering.wallets",
      "alter table wagering.wallets add column invalid boolean",
      "create table wagering.forbidden(id int)",
      "truncate wagering.wallet_ledger_entries",
      "update wagering.wallet_ledger_entries set amount = amount",
      "delete from wagering.wallet_ledger_entries",
      "update wagering.wallets set balance = 0",
    ]) {
      expect(await failureFrom(runtimeConnection.execute(sql))).toMatchObject({ code: "42501" });
    }
    expect(
      await failureFrom(
        auditor.em.getConnection().execute("select id from wagering.wallets for update"),
      ),
    ).toMatchObject({ code: "42501" });
    expect(
      await failureFrom(
        auditor.em.getConnection().execute("update wagering.outbox_messages set attempts = 0"),
      ),
    ).toMatchObject({ code: "42501" });
  } finally {
    await runtime?.close(true);
    await auditor?.close(true);
    try {
      await database.close();
    } finally {
      try {
        await admin.em
          .getConnection()
          .execute(`drop role if exists "${runtimeRole}", "${auditRole}"`);
      } finally {
        await admin.close(true);
      }
    }
  }
}, 20_000);
