import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { FinancialRepositories } from "../../../src/application/ports/repositories/financial-repositories";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/wager-transaction";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { MikroTransactionManager } from "../../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import {
  barrier,
  command,
  financialApplication,
  instrumentTransactions,
  replaceMethod,
} from "../../helpers/application-fixtures";
import { createTestDatabase } from "../../helpers/test-database";
import { failureFrom } from "../../helpers/failure-from";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof financialApplication>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = financialApplication(database.orm);
}, 15_000);
afterAll(async () => database?.close());

async function assertBalance(id: string, amount: string, expectedEntries: number) {
  const audit = await app.manager.execute(({ ledger }) => ledger.auditBalance(id));
  expect(audit?.storedBalance.toString()).toBe(amount);
  expect(audit?.calculatedBalance.toString()).toBe(amount);
  expect(audit?.checkedEntries).toBe(expectedEntries);
  expect(audit?.consistent).toBe(true);
}

function outboxCount(transactionId: string) {
  return database.orm.em
    .getConnection()
    .execute<{ total: number }[]>(
      "select count(*)::int as total from wagering.outbox_messages where payload -> 'data' ->> 'transactionId' = ?",
      [transactionId],
    );
}

test("50 concurrent identical BET commands debit once and return the same historical result", async () => {
  const wallet = await app.open();
  const request = command(wallet, Kind.Bet, "25.00");
  const start = barrier();
  const engines = Array.from({ length: 3 }, () => financialApplication(database.orm).process);
  const attempts = Array.from({ length: 50 }, (_, index) =>
    start.reached.then(() => (engines[index % engines.length] ?? app.process).execute(request)),
  );
  start.release();
  const results = await Promise.all(attempts);
  expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(1);
  expect(results.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
  expect(
    results.every(
      (result) =>
        result.status === Status.Processed &&
        result.balance.amount === "75.00" &&
        result.walletVersion === 2,
    ),
  ).toBe(true);
  const id = results[0]?.transactionId;
  if (!id) throw new Error("Missing result ID");
  expect((await outboxCount(id))[0]?.total).toBe(2);
  await assertBalance(wallet.id, "75.00", 2);
}, 15_000);

test("two concurrent 80.00 BETs select one debit and one insufficient-funds rejection", async () => {
  const wallet = await app.open();
  const start = barrier();
  const requests = [command(wallet, Kind.Bet, "80.00"), command(wallet, Kind.Bet, "80.00")];
  const attempts = requests.map((request) =>
    start.reached.then(() => app.process.execute(request)),
  );
  start.release();
  const results = await Promise.all(attempts);
  const processed = results.find(({ status }) => status === Status.Processed);
  const rejected = results.find(({ status }) => status === Status.Rejected);
  if (!processed || !rejected) throw new Error("Expected one debit and one rejection");
  expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(processed.balance.amount).toBe("20.00");
  expect(rejected.balance.amount).toBe("20.00");
  expect((await outboxCount(processed.transactionId))[0]?.total).toBe(2);
  expect((await outboxCount(rejected.transactionId))[0]?.total).toBe(1);
  await assertBalance(wallet.id, "20.00", 2);
});

test("concurrent direct REFUND and ROLLBACK of one BET apply one credit", async () => {
  const wallet = await app.open();
  const bet = command(wallet, Kind.Bet, "20.00");
  await app.process.execute(bet);
  const reference = { referenceExternalTransactionId: bet.externalTransactionId };
  const results = await Promise.all([
    app.process.execute(command(wallet, Kind.Refund, "20.00", reference)),
    app.process.execute(command(wallet, Kind.Rollback, "20.00", reference)),
  ]);
  expect(results.filter(({ status }) => status === Status.Processed)).toHaveLength(1);
  expect(
    results.filter(({ failureCode }) => failureCode === FailureCode.AlreadyReversed),
  ).toHaveLength(1);
  expect(new Set(results.map(({ transactionId }) => transactionId)).size).toBe(2);
  await assertBalance(wallet.id, "100.00", 3);
});

test("two concurrent distinct WINs both credit and get consecutive versions", async () => {
  const wallet = await app.open();
  const results = await Promise.all([
    app.process.execute(command(wallet, Kind.Win, "10.00")),
    app.process.execute(command(wallet, Kind.Win, "15.00")),
  ]);
  expect(results.map(({ walletVersion }) => walletVersion).sort()).toEqual([2, 3]);
  expect(results.every(({ status }) => status === Status.Processed)).toBe(true);
  await assertBalance(wallet.id, "125.00", 3);
});

test("race across two wallets with a shared key resolves conflict after the unique constraint", async () => {
  const left = await app.open();
  const right = await app.open();
  const key = randomUUID();
  const arrived = barrier();
  const release = barrier();
  let inserts = 0;
  const manager = instrumentTransactions(new MikroTransactionManager(database.orm), (repos) => ({
    ...repos,
    wagers: replaceMethod(repos.wagers, "insert", async (...args) => {
      if (++inserts === 2) arrived.release();
      await release.reached;
      return repos.wagers.insert(...args);
    }),
  }));
  const process = financialApplication(database.orm, manager).process;
  const first = process.execute(command(left, Kind.Bet, "25.00", { idempotencyKey: key }));
  const second = process.execute(command(right, Kind.Bet, "25.00", { idempotencyKey: key }));
  const all = Promise.allSettled([first, second]);
  try {
    await Promise.race([
      arrived.reached,
      first.catch(() => undefined),
      second.catch(() => undefined),
    ]);
    expect(inserts).toBe(2);
  } finally {
    release.release();
  }
  const outcomes = await all;
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const loser = outcomes.find((outcome) => outcome.status === "rejected");
  expect(loser?.reason).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", cause: undefined });
  const winningWallet = outcomes[0]?.status === "fulfilled" ? left : right;
  const losingWallet = winningWallet === left ? right : left;
  await assertBalance(winningWallet.id, "75.00", 2);
  await assertBalance(losingWallet.id, "100.00", 1);
}, 15_000);

test("two concurrent openings for one player and currency produce one wallet and opening", async () => {
  const spec = { playerId: randomUUID(), initialBalance: { amount: "50.00", currency: "BRL" } };
  const result = await Promise.allSettled([app.create.execute(spec), app.create.execute(spec)]);
  const winner = result.find((outcome) => outcome.status === "fulfilled");
  const loser = result.find((outcome) => outcome.status === "rejected");
  expect(loser?.reason).toMatchObject({ code: "WALLET_ALREADY_EXISTS" });
  if (!winner) throw new Error("Missing wallet");
  expect(winner.value.version).toBe(1);
  await assertBalance(winner.value.id, "50.00", 1);
});

test("holding one wallet allows independent progress while the disputed one times out", async () => {
  const blocked = await app.open();
  const independent = await app.open();
  const acquired = barrier();
  const release = barrier();
  const boom = new Error("force rollback");
  const holder = app.manager
    .execute(async ({ wallets }) => {
      await wallets.lockById(blocked.id);
      acquired.release();
      await release.reached;
      throw boom;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  await Promise.race([acquired.reached, holder]);
  const same = command(blocked, Kind.Bet, "25.00");
  const shortTimeout = financialApplication(database.orm, {
    execute<T>(work: (repos: FinancialRepositories) => Promise<T>) {
      return app.manager.execute(work, { lockTimeoutMs: 150 });
    },
  });
  try {
    const failed = failureFrom(shortTimeout.process.execute(same));
    const separate = await app.process.execute(command(independent, Kind.Win, "5.00"));
    expect(separate.status).toBe(Status.Processed);
    expect(await failed).toMatchObject({ reason: "LOCK_TIMEOUT" });
    expect(
      await app.manager.execute(({ wagers }) => wagers.findByIdempotencyKey(same.idempotencyKey)),
    ).toBeUndefined();
    await assertBalance(independent.id, "105.00", 2);
  } finally {
    release.release();
  }
  expect(await holder).toBe(boom);
  const retried = await app.process.execute(same);
  expect(retried.idempotentReplay).toBe(false);
  await assertBalance(blocked.id, "75.00", 2);
}, 15_000);

test("PostgreSQL deadlock aborts one transaction and is reported as a persistence conflict", async () => {
  const first = await app.open();
  const second = await app.open();
  const orm = await MikroORM.init({
    ...database.testOptions,
    driverOptions: {
      connection: {
        options: "-c deadlock_timeout=50ms",
        connectionTimeoutMillis: 1500,
        query_timeout: 1500,
      },
    },
  });
  const firstLocked = barrier();
  const secondLocked = barrier();
  const manager = new MikroTransactionManager(orm);

  try {
    const results = await Promise.allSettled([
      manager.execute(async ({ wallets }) => {
        await wallets.lockById(first.id);
        firstLocked.release();
        await secondLocked.reached;
        await wallets.lockById(second.id);
      }),
      manager.execute(async ({ wallets }) => {
        await wallets.lockById(second.id);
        secondLocked.release();
        await firstLocked.reached;
        await wallets.lockById(first.id);
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const victim = results.find((result) => result.status === "rejected");
    expect(victim?.reason).toMatchObject({ reason: "DEADLOCK" });
    await assertBalance(first.id, "100.00", 1);
    await assertBalance(second.id, "100.00", 1);
  } finally {
    await orm.close(true);
  }
}, 10_000);

test("simultaneous resume of a pending operation applies its journal once", async () => {
  const wallet = await app.open();
  const bet = command(wallet, Kind.Bet, "20.00");
  const pending = await app.process.execute(
    command(wallet, Kind.Refund, "20.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
    }),
  );
  expect(pending.status).toBe(Status.PendingReference);
  await app.process.execute(bet);

  const resumed = await Promise.all([
    app.process.resumePending(pending.transactionId),
    app.process.resumePending(pending.transactionId),
  ]);
  expect(
    resumed.every(
      (result) =>
        result.transactionId === pending.transactionId && result.status === Status.Processed,
    ),
  ).toBe(true);
  expect(resumed.filter(({ idempotentReplay }) => !idempotentReplay)).toHaveLength(1);
  expect((await outboxCount(pending.transactionId))[0]?.total).toBe(3);
  await assertBalance(wallet.id, "100.00", 3);
});
