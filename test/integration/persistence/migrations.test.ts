import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroTransactionManager } from "../../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { command, financialApplication } from "../../helpers/application-fixtures";
import { at } from "../../helpers/domain";
import { failureFrom } from "../../helpers/failure-from";
import { opening } from "../../helpers/financial-fixtures";
import { createTestDatabase } from "../../helpers/test-database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase(false);
}, 15_000);
afterAll(async () => database?.close());

function snapshot() {
  return database.orm.em.getConnection().execute<
    { category: string; name: string; definition: string }[]
  >(`
    select 'table' as category, table_name as name, table_type as definition
      from information_schema.tables where table_schema = 'wagering'
    union all
    select 'column', table_name || '.' || column_name,
           coalesce(domain_name, udt_name) || ':' || is_nullable || ':' || coalesce(column_default, '')
      from information_schema.columns where table_schema = 'wagering'
    union all
    select 'constraint', conname, pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'wagering'::regnamespace
    union all
    select 'trigger', tgname, pg_get_triggerdef(oid)
      from pg_trigger where not tgisinternal and tgrelid in (
        select oid from pg_class where relnamespace = 'wagering'::regnamespace)
    union all
    select 'index', indexname, indexdef from pg_indexes where schemaname = 'wagering'
    union all
    select 'function', proname, pg_get_functiondef(oid)
      from pg_proc where pronamespace = 'wagering'::regnamespace
    order by category, name, definition
  `);
}

test("up, down and reapply recreate tables, columns, constraints, indexes and triggers", async () => {
  const migrator = database.orm.getMigrator();
  const applied = await migrator.up();
  expect(applied.map(({ name }) => name)).toEqual([
    "Migration20261118000000",
    "Migration20261118000100",
    "Migration20261118000200",
    "Migration20261118000300",
    "Migration20261118000400",
    "Migration20261118000500",
    "Migration20261118000600",
  ]);

  const first = await snapshot();
  expect(first.filter(({ category }) => category === "table").map(({ name }) => name)).toEqual([
    "inbox_messages",
    "outbox_messages",
    "wager_transactions",
    "wallet_ledger_entries",
    "wallets",
  ]);
  for (const invariant of [
    "uq_wallet_player_currency",
    "fk_wager_wallet",
    "uq_wager_provider_external",
    "uq_wager_idempotency",
    "fk_ledger_transaction_identity",
    "uq_ledger_transaction_wallet",
    "ck_ledger_arithmetic",
    "uq_wager_processed_reversal",
    "ix_outbox_due",
    "ix_outbox_pending_reference_trace",
    "ledger_append_only",
    "require_processed_ledger",
    "fk_inbox_wager",
    "ck_inbox_transaction_completed",
  ]) {
    expect(first.some(({ name }) => name === invariant)).toBe(true);
  }

  const reverted = await migrator.down({ to: 0 });
  expect(reverted.map(({ name }) => name)).toEqual(applied.map(({ name }) => name).reverse());
  const [row] = await database.orm.em
    .getConnection()
    .execute<{ exists: boolean }[]>("select to_regnamespace('wagering') is not null as exists");
  expect(row?.exists).toBe(false);
  expect(await migrator.getExecutedMigrations()).toEqual([]);
  expect(await migrator.up()).toHaveLength(applied.length);
  expect(await snapshot()).toEqual(first);
  expect(await migrator.up()).toEqual([]);
  expect(await migrator.getPendingMigrations()).toEqual([]);
}, 15_000);

test("refuses financial rollback after a wallet exists", async () => {
  const migrator = database.orm.getMigrator();
  await migrator.up();
  const manager = new MikroTransactionManager(database.orm);
  const { wallet } = opening();
  await manager.execute((repos) => repos.wallets.insertBaseline(wallet));
  expect((await failureFrom(migrator.down({ to: "Migration20261118000100" }))).message).toMatch(
    /populated ledger/,
  );
  expect((await manager.execute((repos) => repos.wallets.findById(wallet.id)))?.version).toBe(1);
  expect(await migrator.getPendingMigrations()).toEqual([]);
});

test("upgrades populated legacy receipts and guards new transaction links", async () => {
  const legacy = await createTestDatabase(false);
  try {
    const migrator = legacy.orm.getMigrator();
    await migrator.up({ to: "Migration20261118000500" });
    const conn = legacy.orm.em.getConnection();
    await conn.execute(`
      insert into wagering.inbox_messages(consumer_name, message_id, payload_hash, received_at, processed_at)
      values ('worker', 'legacy', 'legacy-hash', now(), now())
    `);
    await migrator.up();
    const app = financialApplication(legacy.orm);
    const receipt = await app.manager.execute(({ inbox }) => inbox.find("worker", "legacy"));
    expect(receipt?.isProcessed()).toBe(true);
    expect(receipt?.payloadHash).toBe("legacy-hash");
    expect(receipt?.transactionId).toBeUndefined();
    const wallet = await app.open();
    const wager = await app.process.execute(
      command(wallet, undefined, "25.00", {
        inbox: { consumerName: "worker", messageId: "new" },
      }),
    );
    const linked = await app.manager.execute(({ inbox }) => inbox.find("worker", "new"));
    expect(linked?.transactionId).toBe(wager.transactionId);
    const insert = (processed: boolean, id: string) =>
      conn.execute(
        `
      insert into wagering.inbox_messages(consumer_name, message_id, payload_hash, received_at, processed_at, transaction_id)
      values ('worker', 'invalid', 'hash', now(), case when ? then now() else null end, ?)
    `,
        [processed, id],
      );
    expect(await failureFrom(insert(false, wager.transactionId))).toHaveProperty(
      "constraint",
      "ck_inbox_transaction_completed",
    );
    expect(await failureFrom(insert(true, randomUUID()))).toHaveProperty(
      "constraint",
      "fk_inbox_wager",
    );
    expect((await failureFrom(migrator.down({ to: "Migration20261118000500" }))).message).toMatch(
      /populated inbox/,
    );
  } finally {
    await legacy.close();
  }
}, 15_000);

test("a restricted role can post a valid ledger but cannot write the projection, truncate or do DDL", async () => {
  await database.orm.getMigrator().up();
  const name = `finance_role_${randomUUID().replaceAll("-", "")}`;
  const connection = database.orm.em.getConnection();
  await connection.execute(`create role "${name}" nologin`);
  try {
    await connection.execute(`
      grant usage on schema wagering to "${name}";
      grant select on all tables in schema wagering to "${name}";
      grant insert on wagering.wallets, wagering.wager_transactions, wagering.wallet_ledger_entries to "${name}";
      grant update (updated_at) on wagering.wallets to "${name}";
    `);

    const walletId = randomUUID();
    const txId = randomUUID();
    await database.orm.em.fork().transactional(async (em) => {
      await em.execute(`set local role "${name}"`);
      await em.execute(
        `
        insert into wagering.wallets (id, player_id, currency, created_at, updated_at)
        values (?, 'player', 'BRL', ?, ?)
      `,
        [walletId, at(), at()],
      );
      const [locked] = await em.execute<{ role: string }[]>(
        "select current_user as role from wagering.wallets where id = ? for update",
        [walletId],
      );
      expect(locked?.role).toBe(name);
      await em.execute(
        `
        insert into wagering.wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id,
          kind, status, amount, currency, processed_at, result_balance, result_wallet_version, created_at, updated_at
        ) values (?, 'p', ?, ?, 'hash', ?, 'player', 'round', 'game', 'WIN', 'PROCESSED', 5, 'BRL', ?, 5, 2, ?, ?)
      `,
        [txId, txId, txId, walletId, at(1), at(), at(1)],
      );
      await em.execute(
        `
        insert into wagering.wallet_ledger_entries
          (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
        values (?, ?, ?, 'CREDIT', 5, 'BRL', 0, 5, 2, ?)
      `,
        [randomUUID(), walletId, txId, at(1)],
      );
    });

    for (const sql of [
      "update wagering.wallets set balance = 42",
      "update wagering.wallet_ledger_entries set amount = 42",
      "delete from wagering.wallet_ledger_entries",
      "truncate wagering.wallet_ledger_entries",
      "create table wagering.forbidden (id integer)",
      "alter table wagering.wallet_ledger_entries disable trigger ledger_append_only",
    ]) {
      const failed = await database.orm.em
        .fork()
        .transactional(async (em) => {
          await em.execute(`set local role "${name}"`);
          await em.execute(sql);
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failed).toMatchObject({ code: "42501" });
    }
    const audit = await new MikroTransactionManager(database.orm).execute((repos) =>
      repos.ledger.auditBalance(walletId),
    );
    expect(audit?.storedBalance.toString()).toBe("5.00");
    expect(audit?.consistent).toBe(true);
  } finally {
    await connection.execute(`drop owned by "${name}"; drop role "${name}";`);
  }
});
