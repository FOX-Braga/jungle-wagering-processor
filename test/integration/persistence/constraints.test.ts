import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind as Kind } from "../../../src/domain/wagering/wager-transaction";
import { MikroTransactionManager } from "../../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { at } from "../../helpers/domain";
import { insertApplied, insertOpening, makeWager, opening } from "../../helpers/financial-fixtures";
import { createTestDatabase } from "../../helpers/test-database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let transactions: MikroTransactionManager;

beforeAll(async () => {
  database = await createTestDatabase();
  transactions = new MikroTransactionManager(database.orm);
}, 15_000);
afterAll(async () => database?.close());

function insertSql(
  table:
    | "wallets"
    | "wager_transactions"
    | "wallet_ledger_entries"
    | "inbox_messages"
    | "outbox_messages",
  row: Record<string, string | number | Date | null>,
) {
  return {
    statement: `insert into wagering.${table} (${Object.keys(row).join(", ")}) values (${Object.values(
      row,
    )
      .map(() => "?")
      .join(", ")})`,
    params: Object.values(row),
  };
}

function rawInsert(table: Parameters<typeof insertSql>[0], row: Parameters<typeof insertSql>[1]) {
  const { statement, params } = insertSql(table, row);
  return database.orm.em.getConnection().execute(statement, params);
}

async function rejected(action: () => Promise<unknown>, code: string, constraint?: string) {
  const failure = await action().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ code, ...(constraint ? { constraint } : {}) });
}

function sqlWallet() {
  return {
    id: randomUUID(),
    player_id: randomUUID(),
    currency: "BRL",
    balance: "0.00",
    version: 1,
    created_at: at(),
    updated_at: at(),
  };
}

function sqlWager(wallet: { id: string; player_id: string; currency: string }) {
  const id = randomUUID();
  return {
    id,
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    currency: wallet.currency,
    provider_id: "provider",
    external_transaction_id: id,
    idempotency_key: `idem-${id}`,
    payload_hash: `hash-${id}`,
    round_id: "round",
    game_id: "game",
    kind: "BET",
    status: "PENDING",
    amount: "1.00",
    created_at: at(),
    updated_at: at(),
  };
}

test.each(["-0.01", "1.001", "1.230", "1e36", "NaN", "Infinity", "-Infinity"])(
  "rejects invalid SQL numeric input %s",
  async (balance) => {
    await rejected(
      () => rawInsert("wallets", { ...sqlWallet(), balance }),
      "23514",
      "ck_money_range_scale",
    );
  },
);

test("SQL enforces wallet identity, ISO currency, version and dates", async () => {
  const wallet = sqlWallet();
  await rawInsert("wallets", wallet);
  await rejected(
    () => rawInsert("wallets", { ...wallet, id: randomUUID() }),
    "23505",
    "uq_wallet_player_currency",
  );
  await rawInsert("wallets", { ...wallet, id: randomUUID(), currency: "USD" });
  await rejected(
    () => rawInsert("wallets", { ...sqlWallet(), currency: "ZZZ" }),
    "23514",
    "ck_currency_code",
  );
  await rejected(
    () => rawInsert("wallets", { ...sqlWallet(), version: 0 }),
    "23514",
    "ck_wallet_baseline",
  );
  await rejected(() => rawInsert("wallets", { ...sqlWallet(), created_at: "infinity" }), "23514");
  const stored = await transactions.execute((repos) => repos.wallets.findById(wallet.id));
  expect(stored?.balance.toString()).toBe("0.00");
  expect(stored?.createdAt).toEqual(at());
});

test("SQL rejects direct projection updates and non-zero wallet creation", async () => {
  const wallet = sqlWallet();
  await rawInsert("wallets", wallet);
  await rejected(
    () => rawInsert("wallets", { ...sqlWallet(), balance: "1.00" }),
    "23514",
    "ck_wallet_baseline",
  );
  const execute = database.orm.em.getConnection();
  await rejected(
    () => execute.execute("update wagering.wallets set balance = -1 where id = ?", [wallet.id]),
    "23514",
    "ck_money_range_scale",
  );
  await rejected(
    () =>
      execute.execute("update wagering.wallets set balance = 5, version = 2 where id = ?", [
        wallet.id,
      ]),
    "23514",
    "ck_wallet_ledger_projection",
  );
  expect(
    (await transactions.execute((repos) => repos.wallets.findById(wallet.id)))?.balance.toString(),
  ).toBe("0.00");
});

test("SQL enforces external and idempotency uniqueness and the composite wallet FK", async () => {
  const wallet = sqlWallet();
  await rawInsert("wallets", wallet);
  const wager = sqlWager(wallet);
  await rawInsert("wager_transactions", wager);
  await rejected(
    () =>
      rawInsert("wager_transactions", {
        ...sqlWager(wallet),
        external_transaction_id: wager.external_transaction_id,
      }),
    "23505",
    "uq_wager_provider_external",
  );
  await rejected(
    () =>
      rawInsert("wager_transactions", {
        ...sqlWager(wallet),
        idempotency_key: wager.idempotency_key,
      }),
    "23505",
    "uq_wager_idempotency",
  );
  await rawInsert("wager_transactions", {
    ...sqlWager(wallet),
    provider_id: "other",
    external_transaction_id: wager.external_transaction_id,
  });
  await rejected(
    () => rawInsert("wager_transactions", { ...sqlWager(wallet), wallet_id: randomUUID() }),
    "23503",
    "fk_wager_wallet",
  );
  await rejected(
    () => rawInsert("wager_transactions", { ...sqlWager(wallet), currency: "USD" }),
    "23503",
    "fk_wager_wallet",
  );
  await rejected(
    () => rawInsert("wager_transactions", { ...sqlWager(wallet), player_id: randomUUID() }),
    "23503",
    "fk_wager_wallet",
  );
  const retry = await transactions.execute((repos) =>
    repos.wagers.findByIdempotencyKey(wager.idempotency_key),
  );
  expect(retry?.transaction.payloadHash).toBe(wager.payload_hash);
});

test("SQL enforces kind, amount, state, terminal data and reference shape", async () => {
  const wallet = sqlWallet();
  await rawInsert("wallets", wallet);
  const invalid = [
    [{ kind: "UNKNOWN" }, "ck_wager_kind"],
    [{ status: "UNKNOWN" }, "ck_wager_status"],
    [{ amount: "0.00" }, "ck_wager_amount"],
    [{ kind: "OPENING" }, "ck_wager_opening_identity"],
    [{ status: "PROCESSED" }, "ck_wager_processing_fields"],
    [{ status: "REJECTED" }, "ck_wager_processing_fields"],
    [{ status: "FAILED", failure_code: "INVALID_REFERENCE" }, "ck_wager_processing_fields"],
    [{ kind: "REFUND" }, "ck_wager_reference_shape"],
  ] as const;
  for (const [changes, constraint] of invalid) {
    await rejected(
      () => rawInsert("wager_transactions", { ...sqlWager(wallet), ...changes }),
      "23514",
      constraint,
    );
  }

  const waiting = {
    ...sqlWager(wallet),
    status: "PENDING_REFERENCE",
    kind: "REFUND",
    reference_external_transaction_id: "unknown",
  };
  await rawInsert("wager_transactions", waiting);
  await rejected(
    () =>
      database.orm.em
        .getConnection()
        .execute("update wagering.wager_transactions set status = 'PENDING' where id = ?", [
          waiting.id,
        ]),
    "23514",
    "ck_wager_state_transition",
  );
  const results = await transactions.execute((repos) =>
    repos.wagers.findPendingByReference(waiting.provider_id, "unknown", 3),
  );
  expect(results.map(({ transaction }) => transaction.id)).toEqual([waiting.id]);
});

test("SQL rejects absent resolved FK and incompatible reference scope", async () => {
  const opened = opening("10.00");
  const bet = makeWager(opened.wallet, Kind.Bet, "1.00");
  await transactions.execute(async (repos) => {
    await insertOpening(repos, opened);
    await insertApplied(repos, opened.wallet, bet, at(1));
  });

  const physical = { ...sqlWallet(), id: opened.wallet.id, player_id: opened.wallet.playerId };
  const processed = {
    ...sqlWager(physical),
    kind: "REFUND",
    status: "PROCESSED",
    processed_at: at(2),
    updated_at: at(2),
    reference_external_transaction_id: bet.externalTransactionId,
    result_balance: "10.00",
    result_wallet_version: 3,
  };
  await rejected(
    () => rawInsert("wager_transactions", { ...processed, reference_transaction_id: randomUUID() }),
    "23503",
    "fk_wager_reference",
  );
  await rejected(
    () =>
      rawInsert("wager_transactions", {
        ...processed,
        reference_transaction_id: bet.id,
        round_id: "other",
      }),
    "23514",
    "ck_wager_reference_scope",
  );
  await rejected(
    () =>
      rawInsert("wager_transactions", {
        ...processed,
        reference_transaction_id: bet.id,
        amount: "2.00",
      }),
    "23514",
    "ck_wager_reference_scope",
  );
  await rejected(
    () =>
      database.orm.em
        .getConnection()
        .execute("update wagering.wager_transactions set status = 'PENDING' where id = ?", [
          bet.id,
        ]),
    "55000",
    "wager_terminal_state",
  );
  const truth = await transactions.execute((repos) => repos.ledger.auditBalance(opened.wallet.id));
  expect(truth?.storedBalance.toString()).toBe("9.00");
  expect(truth?.consistent).toBe(true);
});

test("SQL blocks duplicate REFUND and conflicting direct ROLLBACK while allowing ROLLBACK of a REFUND", async () => {
  const opened = opening("10.00");
  const { wallet } = opened;
  const bet = makeWager(wallet, Kind.Bet, "1.00");
  const refund = makeWager(wallet, Kind.Refund, "1.00", {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  await transactions.execute(async (repos) => {
    await insertOpening(repos, opened);
    await insertApplied(repos, wallet, bet, at(1));
    await insertApplied(repos, wallet, refund, at(2), bet);
  });

  const physical = { ...sqlWallet(), id: wallet.id, player_id: wallet.playerId };
  for (const kind of ["REFUND", "ROLLBACK"]) {
    await rejected(
      () =>
        rawInsert("wager_transactions", {
          ...sqlWager(physical),
          kind,
          status: "PROCESSED",
          processed_at: at(3),
          updated_at: at(3),
          reference_external_transaction_id: bet.externalTransactionId,
          reference_transaction_id: bet.id,
          result_balance: "11.00",
          result_wallet_version: 4,
        }),
      "23505",
      "uq_wager_processed_reversal",
    );
  }

  const rollback = makeWager(wallet, Kind.Rollback, "1.00", {
    referenceExternalTransactionId: refund.externalTransactionId,
  });
  await transactions.execute((repos) => insertApplied(repos, wallet, rollback, at(4), refund));
  const audit = await transactions.execute(async (repos) => {
    const history = await repos.wagers.findAppliedReversals(bet.id);
    expect(history.map((item) => item.id)).toEqual([refund.id]);
    return repos.ledger.auditBalance(wallet.id);
  });
  expect(audit?.storedBalance.toString()).toBe("9.00");
  expect(audit?.consistent).toBe(true);
});

test("SQL rejects invalid ledger arithmetic, shape, money and immediate foreign keys", async () => {
  const opened = opening("10.00");
  await transactions.execute((repos) => insertOpening(repos, opened));
  if (!opened.opening) throw new Error("Expected opening");
  const movement = {
    id: randomUUID(),
    wallet_id: opened.wallet.id,
    transaction_id: opened.opening.transaction.id,
    direction: "CREDIT",
    amount: "10.00",
    currency: "BRL",
    balance_before: "0.00",
    balance_after: "10.00",
    wallet_version: 1,
    created_at: at(),
  };
  const invalid = [
    [{ direction: "swap" }, "23514", "ck_ledger_direction"],
    [{ amount: "0.00" }, "23514", "ck_ledger_amount"],
    [{ balance_after: "11.00" }, "23514", "ck_ledger_arithmetic"],
    [{ balance_before: "-1.00" }, "23514", "ck_money_range_scale"],
    [{ wallet_id: randomUUID() }, "23503", "wallet_ledger_entries_wallet_id_fkey"],
    [
      { transaction_id: randomUUID(), wallet_version: 7 },
      "23503",
      "fk_ledger_transaction_identity",
    ],
    [
      { currency: "USD", transaction_id: randomUUID(), wallet_version: 7 },
      "23503",
      "fk_ledger_transaction_identity",
    ],
  ] as const;
  for (const [changes, code, constraint] of invalid) {
    await rejected(
      () => rawInsert("wallet_ledger_entries", { ...movement, ...changes }),
      code,
      constraint,
    );
  }
  await rejected(
    () => rawInsert("wallet_ledger_entries", { ...movement, wallet_version: 2 }),
    "23505",
    "uq_ledger_transaction_wallet",
  );
  const audit = await transactions.execute((repos) => repos.ledger.auditBalance(opened.wallet.id));
  expect(audit?.checkedEntries).toBe(1);
  expect(audit?.storedBalance.toString()).toBe("10.00");
  expect(audit?.consistent).toBe(true);
});

test("SQL rejects a ledger pointing at a different wallet or currency than its wager", async () => {
  const opened = opening("10.00");
  const other = opening("10.00");
  await transactions.execute(async (repos) => {
    await insertOpening(repos, opened);
    await insertOpening(repos, other);
  });

  const wallet = opened.wallet;
  for (const invalid of [{ wallet_id: other.wallet.id }, { currency: "USD" }]) {
    const row = {
      ...sqlWager({ ...sqlWallet(), id: wallet.id, player_id: wallet.playerId }),
      kind: "WIN",
      status: "PROCESSED",
      processed_at: at(1),
      updated_at: at(1),
      result_balance: "11.00",
      result_wallet_version: 2,
    };
    await rejected(
      () =>
        database.orm.em.fork().transactional(async (em) => {
          const wager = insertSql("wager_transactions", row);
          await em.execute(wager.statement, wager.params);
          const ledger = insertSql("wallet_ledger_entries", {
            id: randomUUID(),
            wallet_id: wallet.id,
            transaction_id: row.id,
            currency: "BRL",
            direction: "CREDIT",
            amount: "1.00",
            balance_before: "10.00",
            balance_after: "11.00",
            wallet_version: 2,
            created_at: at(1),
            ...invalid,
          });
          await em.execute(ledger.statement, ledger.params);
        }),
      "23503",
      "fk_ledger_transaction_identity",
    );
    expect(await transactions.execute((repos) => repos.wagers.findById(row.id))).toBeUndefined();
  }
  for (const candidate of [wallet, other.wallet]) {
    const audit = await transactions.execute((repos) => repos.ledger.auditBalance(candidate.id));
    expect(audit?.storedBalance.toString()).toBe("10.00");
    expect(audit?.consistent).toBe(true);
  }
});

test("SQL requires a ledger at commit and rejects a stale or wrong-direction entry", async () => {
  const opened = opening("10.00");
  await transactions.execute((repos) => insertOpening(repos, opened));
  const wallet = opened.wallet;
  const row = {
    ...sqlWager({ ...sqlWallet(), id: wallet.id, player_id: wallet.playerId }),
    kind: "WIN",
    status: "PROCESSED",
    processed_at: at(1),
    updated_at: at(1),
    result_balance: "11.00",
    result_wallet_version: 2,
  };
  await rejected(
    () => rawInsert("wager_transactions", row),
    "23514",
    "ck_processed_wager_requires_ledger",
  );

  for (const [changes, expected] of [
    [{ direction: "DEBIT", balance_before: "12.00" }, "ck_ledger_processed_wager"],
    [{ balance_before: "20.00", balance_after: "21.00" }, "ck_ledger_processed_wager"],
  ] as const) {
    await rejected(
      () =>
        database.orm.em.fork().transactional(async (em) => {
          const wager = insertSql("wager_transactions", row);
          await em.execute(wager.statement, wager.params);
          const ledger = insertSql(
            "wallet_ledger_entries",
            Object.assign(
              {
                id: randomUUID(),
                wallet_id: wallet.id,
                transaction_id: row.id,
                currency: "BRL",
                direction: "CREDIT",
                amount: "1.00",
                balance_before: "10.00",
                balance_after: "11.00",
                wallet_version: 2,
                created_at: at(1),
              },
              changes,
            ),
          );
          await em.execute(ledger.statement, ledger.params);
        }),
      "23514",
      expected,
    );
  }

  await rejected(
    () =>
      database.orm.em.fork().transactional(async (em) => {
        const wager = insertSql("wager_transactions", { ...row, result_balance: "21.00" });
        const ledger = insertSql("wallet_ledger_entries", {
          id: randomUUID(),
          wallet_id: wallet.id,
          transaction_id: row.id,
          currency: "BRL",
          direction: "CREDIT",
          amount: "1.00",
          balance_before: "20.00",
          balance_after: "21.00",
          wallet_version: 2,
          created_at: at(1),
        });
        await em.execute(wager.statement, wager.params);
        await em.execute(ledger.statement, ledger.params);
      }),
    "23514",
    "ck_wallet_ledger_projection",
  );
  expect(await transactions.execute((repos) => repos.wagers.findById(row.id))).toBeUndefined();
  const audit = await transactions.execute((repos) => repos.ledger.auditBalance(wallet.id));
  expect(audit?.storedBalance.toString()).toBe("10.00");
  expect(audit?.consistent).toBe(true);
});

test("SQL ledger rejects UPDATE, DELETE and TRUNCATE even through the owner connection", async () => {
  const opened = opening("10.00");
  await transactions.execute((repos) => insertOpening(repos, opened));
  if (!opened.opening) throw new Error("Expected opening");
  const {
    ledgerEntry: { id },
    transaction: { id: transactionId },
  } = opened.opening;
  const connection = database.orm.em.getConnection();
  for (const field of ["amount", "direction", "balance_before", "balance_after", "wallet_id"]) {
    await rejected(
      () =>
        connection.execute(
          `update wagering.wallet_ledger_entries set ${field} = ${field} where id = ?`,
          [id],
        ),
      "55000",
      "ledger_append_only",
    );
  }
  await rejected(
    () => connection.execute("delete from wagering.wallet_ledger_entries where id = ?", [id]),
    "55000",
    "ledger_append_only",
  );
  await rejected(
    () => connection.execute("truncate wagering.wallet_ledger_entries"),
    "55000",
    "ledger_append_only",
  );
  const ledger = await transactions.execute((repos) =>
    repos.ledger.findByTransaction(opened.wallet.id, transactionId),
  );
  expect(ledger?.money.toString()).toBe("10.00");
});

test("SQL inbox composite uniqueness groups by consumer and validates dates", async () => {
  const message = {
    consumer_name: "one",
    message_id: randomUUID(),
    payload_hash: "hash",
    received_at: at(),
  };
  await rawInsert("inbox_messages", message);
  await rejected(
    () => rawInsert("inbox_messages", { ...message, payload_hash: "different" }),
    "23505",
    "pk_inbox_consumer_message",
  );
  await rawInsert("inbox_messages", { ...message, consumer_name: "two" });
  await rejected(
    () => rawInsert("inbox_messages", { ...message, consumer_name: "three", processed_at: at(-1) }),
    "23514",
    "ck_inbox_processed_at",
  );
  expect(
    (
      await transactions.execute((repos) =>
        repos.inbox.find(message.consumer_name, message.message_id),
      )
    )?.payloadHash,
  ).toBe("hash");
});

test("SQL outbox enforces object payload, unique IDs, attempts and valid dates", async () => {
  const event = {
    id: randomUUID(),
    aggregate_id: "agg",
    event_type: "Example",
    payload: '{"amount":"25.00"}',
    occurred_at: at(),
    attempts: 0,
  };
  await rawInsert("outbox_messages", event);
  await rejected(() => rawInsert("outbox_messages", event), "23505", "outbox_messages_pkey");
  await rejected(
    () => rawInsert("outbox_messages", { ...event, id: randomUUID(), payload: "[]" }),
    "23514",
    "ck_outbox_payload_object",
  );
  await rejected(
    () => rawInsert("outbox_messages", { ...event, id: randomUUID(), attempts: -1 }),
    "23514",
    "ck_outbox_attempts",
  );
  await rejected(
    () => rawInsert("outbox_messages", { ...event, id: randomUUID(), next_attempt_at: at(-1) }),
    "23514",
    "ck_outbox_dates",
  );
  expect((await transactions.execute((repos) => repos.outbox.findById(event.id)))?.payload).toEqual(
    { amount: "25.00" },
  );
});
