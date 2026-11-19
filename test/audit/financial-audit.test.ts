import "reflect-metadata";
import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { Metrics } from "../../src/infrastructure/observability/metrics";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";
import { MikroTransactionManager } from "../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { createHttpApplication } from "../../src/presentation/http/http-application";
import { command, financialApplication } from "../helpers/application-fixtures";
import { httpClient } from "../helpers/http-client";
import { failureFrom } from "../helpers/failure-from";
import { createTestDatabase, loadIntegrationConfig } from "../helpers/test-database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.close();
});

function auditArgs() {
  return { batchSize: 1, signal: AbortSignal.timeout(10_000) };
}

async function runCli(url: string, args: string[]) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "scripts/audit/wallets.ts", ...args],
    {
      env: { ...process.env, AUDIT_DATABASE_URL: url },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

test("audits paginated wallets during concurrent financial commits using independent connections", async () => {
  const writer = financialApplication(database.orm);
  const readerOrm = await MikroORM.init(database.testOptions);
  const reconcile = new ReconcileWalletUseCase(new MikroTransactionManager(readerOrm));
  try {
    await writer.open("0.00");
    const wallet = await writer.open("90071992547409.93");
    async function apply(kind: Kind, amount: string, reference?: string) {
      const wager = command(
        wallet,
        kind,
        amount,
        reference ? { referenceExternalTransactionId: reference } : {},
      );
      const [outcome, reads] = await Promise.all([
        writer.process.execute(wager),
        Promise.all(Array.from({ length: 6 }, () => reconcile.execute(wallet.id))),
      ]);
      expect(outcome.status).toBe(Status.Processed);
      for (const audit of reads) expect(audit.difference.amount).toBe("0.00");
      return wager.externalTransactionId;
    }
    const bet = await apply(Kind.Bet, "25.09");
    const win = await apply(Kind.Win, "0.15", bet);
    const refund = await apply(Kind.Refund, "25.09", bet);
    await apply(Kind.Rollback, "25.09", refund);
    await apply(Kind.Loss, "0.00");
    expect(
      (await writer.process.execute(command(wallet, Kind.Bet, "90071992547409.93"))).status,
    ).toBe(Status.Rejected);
    expect((await reconcile.execute(wallet.id)).calculatedBalance.amount).toBe("90071992547384.99");
    expect(win).toBeDefined();
    const summary = await auditWallets(readerOrm, auditArgs(), () => {
      throw new Error("Unexpected anomaly");
    });
    expect(summary).toEqual({ walletsChecked: 2, inconsistent: 0, ledgerEntriesChecked: "5" });
    expect((await runCli(database.url.href, ["--wallet", wallet.id])).exit).toBe(0);
    expect((await runCli(database.url.href, ["--wallet", "missing-wallet"])).exit).toBe(2);
    const interrupted = AbortSignal.abort();
    expect(
      await failureFrom(auditWallets(readerOrm, { ...auditArgs(), signal: interrupted }, () => {})),
    ).toHaveProperty("name", "AbortError");
  } finally {
    await readerOrm.close(true);
  }
}, 20_000);

test("reports a divergent PostgreSQL projection through HTTP and the audit CLI without a corrective write", async () => {
  const isolated = await createTestDatabase();
  const appConfig = {
    ...loadIntegrationConfig(),
    DATABASE_URL: isolated.url.href,
    LOG_LEVEL: "warn",
  } as const;
  const metrics = new Metrics("audit-api");
  const api = await createHttpApplication(appConfig, metrics);
  try {
    const wallet = await financialApplication(isolated.orm).open("90.00");
    const conn = isolated.orm.em.getConnection();
    // Replace only the read projection in this disposable database. The data tables,
    // constraints and triggers stay intact under their original object identities.
    await conn.execute(`
      alter schema wagering rename to audit_fixture;
      create schema wagering;
      create view wagering.wallets as
        select id, player_id, currency, balance + 10.00 as balance, version, created_at, updated_at
        from audit_fixture.wallets;
      create view wagering.wallet_ledger_entries as select * from audit_fixture.wallet_ledger_entries;
      create view wagering.wager_transactions as select * from audit_fixture.wager_transactions;
    `);
    await api.listen(0, "127.0.0.1");
    const result = await httpClient(await api.getUrl()).reconcile(wallet.id);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      consistent: false,
      checkedEntries: 1,
      difference: { amount: "10.00", currency: "BRL" },
      storedBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(metrics.snapshot().metrics.wager_reconciliation_total).toMatchObject([
      { labels: { result: "divergent" }, value: 1 },
    ]);
    const cli = await runCli(isolated.url.href, ["--wallet", wallet.id]);
    expect(cli.exit).toBe(1);
    expect(cli.stdout).toContain("BALANCE_DIVERGENCE");
    expect(cli.stdout).not.toContain("90.00");
    expect(await conn.execute("select balance::text from audit_fixture.wallets")).toEqual([
      { balance: "90.00" },
    ]);
    expect(
      await conn.execute("select count(*)::int as count from audit_fixture.wallet_ledger_entries"),
    ).toEqual([{ count: 1 }]);
  } finally {
    await api.close();
    await isolated.close();
  }
}, 20_000);
