import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { FinancialRepositories } from "../../../src/application/ports/repositories/financial-repositories";
import { PersistenceConflictError } from "../../../src/application/ports/transaction-manager";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/wager-transaction";
import { MikroTransactionManager } from "../../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { at } from "../../helpers/domain";
import { failureFrom } from "../../helpers/failure-from";
import { insertApplied, insertOpening, makeWager, opening } from "../../helpers/financial-fixtures";
import { createTestDatabase } from "../../helpers/test-database";
import { waitFor } from "../../helpers/wait-for";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let transactions: MikroTransactionManager;

beforeAll(async () => {
  database = await createTestDatabase();
  transactions = new MikroTransactionManager(database.orm);
}, 15_000);
afterAll(async () => database?.close());

const amounts = ["0.00", "0.01", "0.10", "0.30", "25.00", "1000000.00", "9".repeat(36) + ".99"];
test.each(amounts)("persists and rehydrates an exact opening of %s", async (amount) => {
  const opened = opening(amount, "USD");
  await transactions.execute((repos) => insertOpening(repos, opened));
  await transactions.execute(async (repos) => {
    const wallet = await repos.wallets.findByPlayerAndCurrency(opened.wallet.playerId, "USD");
    expect(wallet?.id).toBe(opened.wallet.id);
    expect(wallet?.balance.toJSON()).toEqual({ amount, currency: "USD" });
    expect(wallet?.version).toBe(1);
    expect(wallet?.createdAt).toEqual(at());
    expect(wallet?.updatedAt).toEqual(at());
    const audit = await repos.ledger.auditBalance(opened.wallet.id);
    expect(audit?.calculatedBalance.toString()).toBe(amount);
    expect(audit?.difference.toString()).toBe("0.00");
    expect(audit?.checkedEntries).toBe(amount === "0.00" ? 0 : 1);
  });
});

test("rejects an out-of-range domain amount and rolls the baseline back", async () => {
  const opened = opening("1" + "0".repeat(36) + ".00");
  expect(
    await failureFrom(transactions.execute((repos) => insertOpening(repos, opened))),
  ).toBeInstanceOf(RangeError);
  expect(
    await transactions.execute((repos) => repos.wallets.findById(opened.wallet.id)),
  ).toBeUndefined();
});

test("persists pending reference, terminal state, historical balance and paginates the ledger", async () => {
  const opened = opening("100.00");
  const wallet = opened.wallet;
  const bet = makeWager(wallet, Kind.Bet, "20.00");
  const win = makeWager(wallet, Kind.Win, "5.00", {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const refund = makeWager(wallet, Kind.Refund, "20.00", {
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  const loss = makeWager(wallet, Kind.Loss, "0.00");
  await transactions.execute(async (repos) => {
    await insertOpening(repos, opened);
    refund.markPendingReference();
    await repos.wagers.insert(refund);

    await insertApplied(repos, wallet, bet, at(1));
    await insertApplied(repos, wallet, win, at(2), bet);
    const result = refund.apply(wallet, {
      reference: bet,
      at: at(3),
      ledgerEntryId: randomUUID(),
      appliedReversals: [],
    });
    if (result.status !== Status.Processed || !result.ledgerEntry)
      throw new Error("Expected refund movement");
    await repos.wagers.saveState(refund, {
      updatedAt: at(3),
      result: { balance: wallet.balance, walletVersion: wallet.version },
    });
    await repos.ledger.append(result.ledgerEntry);
    expect(await insertApplied(repos, wallet, loss, at(4))).toBeUndefined();

    const declined = makeWager(wallet, Kind.Bet, "200.00");
    declined.reject(FailureCode.InsufficientFunds);
    await repos.wagers.insert(declined, { updatedAt: at(5) });
    const storedFailure = await repos.wagers.findById(declined.id);
    expect(storedFailure?.transaction.failureCode).toBe(FailureCode.InsufficientFunds);

    const failed = makeWager(wallet, Kind.Bet, "10.00");
    failed.fail(FailureCode.ProcessingFailed);
    await repos.wagers.insert(failed);
    expect((await repos.wagers.findById(failed.id))?.transaction.status).toBe(Status.Failed);
  });

  await transactions.execute(async (repos) => {
    const replay = await repos.wagers.findByExternalId(bet.providerId, bet.externalTransactionId);
    expect(replay?.transaction.status).toBe(Status.Processed);
    expect(replay?.transaction.payloadHash).toBe(bet.payloadHash);
    expect(replay?.transaction.processedAt).toEqual(at(1));
    expect(replay?.result?.balance.toString()).toBe("80.00");
    expect(replay?.result?.walletVersion).toBe(2);
    expect((await repos.wagers.findById(refund.id))?.transaction.referenceTransactionId).toBe(
      bet.id,
    );
    expect((await repos.wagers.findById(loss.id))?.result?.balance.toString()).toBe("105.00");
    expect(await repos.ledger.findByTransaction(wallet.id, loss.id)).toBeUndefined();

    const first = await repos.ledger.listByWallet(wallet.id, { limit: 2 });
    const second = await repos.ledger.listByWallet(wallet.id, { limit: 3, afterVersion: 2 });
    expect(first.map((entry) => entry.walletVersion)).toEqual([1, 2]);
    expect(second.map((entry) => entry.walletVersion)).toEqual([3, 4]);
    const audit = await repos.ledger.auditBalance(wallet.id);
    expect(audit?.storedBalance.toString()).toBe("105.00");
    expect(audit?.consistent).toBe(true);
    expect(audit?.checkedEntries).toBe(4);
  });
});

function atomicFixtures() {
  const opened = opening("25.00");
  if (!opened.opening) throw new Error("Expected opening");
  const { transaction, ledgerEntry } = opened.opening;
  const event = WalletBalanceChanged.from(ledgerEntry, {
    eventId: randomUUID(),
    correlationId: randomUUID(),
  });
  const outbox = OutboxMessage.enqueue(event);
  const inbox = InboxMessage.receive({
    consumerName: "wagers",
    messageId: randomUUID(),
    payloadHash: "hash",
    receivedAt: at(),
  });
  return { wallet: opened.wallet, transaction, ledgerEntry, inbox, outbox };
}

type AtomicFixtures = ReturnType<typeof atomicFixtures>;
const steps: [string, (repos: FinancialRepositories, fixture: AtomicFixtures) => Promise<void>][] =
  [
    ["wallet", (repos, data) => repos.wallets.insertBaseline(data.wallet)],
    [
      "wager",
      (repos, data) =>
        repos.wagers.insert(data.transaction, {
          updatedAt: at(),
          result: { balance: data.wallet.balance, walletVersion: data.wallet.version },
        }),
    ],
    ["ledger", (repos, data) => repos.wallets.saveMovement(data.wallet, data.ledgerEntry)],
    ["inbox", (repos, data) => repos.inbox.insert(data.inbox)],
    ["outbox", (repos, data) => repos.outbox.insert(data.outbox)],
  ];

for (const [index, [name]] of steps.entries()) {
  test(`rolls back everything when the transaction fails after ${name}`, async () => {
    const fixture = atomicFixtures();
    const failure = await failureFrom(
      transactions.execute(async (repos) => {
        for (const [, operation] of steps.slice(0, index + 1)) await operation(repos, fixture);
        throw new Error("intentional abort");
      }),
    );
    expect(failure.message).toBe("intentional abort");

    const { wallet, transaction, inbox, outbox } = fixture;
    await transactions.execute(async (repos) => {
      expect(await repos.wallets.findById(wallet.id)).toBeUndefined();
      expect(await repos.wagers.findById(transaction.id)).toBeUndefined();
      expect(await repos.ledger.findByTransaction(wallet.id, transaction.id)).toBeUndefined();
      expect(await repos.inbox.find(inbox.consumerName, inbox.messageId)).toBeUndefined();
      expect(await repos.outbox.findById(outbox.id)).toBeUndefined();
    });
  });
}

test("protects the transaction boundary from accidental nested execution", async () => {
  const { wallet } = opening();
  const problem = await failureFrom(
    transactions.execute(async (repos) => {
      await repos.wallets.insertBaseline(wallet);
      await transactions.execute((nested) => nested.wallets.findById(wallet.id));
    }),
  );
  expect(problem.message).toContain("active transaction");
  expect(await transactions.execute((repos) => repos.wallets.findById(wallet.id))).toBeUndefined();
});

test("commits all five records and rehydrates them on a new connection", async () => {
  const fixture = atomicFixtures();
  const { wallet, transaction, ledgerEntry, inbox, outbox } = fixture;
  inbox.markProcessed(at(1));
  outbox.scheduleRetry(at(), { baseDelayMs: 100, maxDelayMs: 100 });

  await transactions.execute(async (repos) => {
    for (const [, operation] of steps) await operation(repos, fixture);
  });

  const fresh = await MikroORM.init(database.testOptions);
  try {
    await new MikroTransactionManager(fresh).execute(async (repos) => {
      const storedWallet = await repos.wallets.findById(wallet.id);
      const storedWager = await repos.wagers.findByIdempotencyKey(transaction.idempotencyKey);
      const storedEntry = await repos.ledger.findByTransaction(wallet.id, transaction.id);
      const storedInbox = await repos.inbox.find(inbox.consumerName, inbox.messageId);
      const storedOutbox = await repos.outbox.findById(outbox.id);
      expect(storedWallet?.balance.toString()).toBe("25.00");
      expect(storedWallet?.version).toBe(1);
      expect(storedWager?.transaction.kind).toBe(Kind.Opening);
      expect(storedWager?.transaction.status).toBe(Status.Processed);
      expect(storedWager?.result?.balance.toString()).toBe("25.00");
      expect(storedEntry?.toJSON()).toEqual(ledgerEntry.toJSON());
      expect(storedInbox?.processedAt).toEqual(at(1));
      expect(storedInbox?.payloadHash).toBe("hash");
      expect(storedOutbox?.payload).toEqual(outbox.payload);
      expect(storedOutbox?.nextAttemptAt).toEqual(at(100));
      expect(storedOutbox?.attempts).toBe(1);
      expect((await repos.ledger.auditBalance(wallet.id))?.consistent).toBe(true);
    });
  } finally {
    await fresh.close(true);
  }
});

test("persistently marks an inbox message as processed once", async () => {
  const inbox = atomicFixtures().inbox;
  await transactions.execute((repos) => repos.inbox.insert(inbox));
  inbox.markProcessed(at(10));
  await transactions.execute((repos) => repos.inbox.saveProcessed(inbox));
  const failure = await failureFrom(
    transactions.execute((repos) => repos.inbox.saveProcessed(inbox)),
  );
  expect(failure.message).toContain("already processed");
  const stored = await transactions.execute((repos) =>
    repos.inbox.find(inbox.consumerName, inbox.messageId),
  );
  expect(stored?.processedAt).toEqual(at(10));
});

test("selects due outbox updates, fences leases and ignores published messages", async () => {
  const { outbox } = atomicFixtures();
  const now = at(500);
  const claim = { owner: randomUUID(), until: at(600) };
  await transactions.execute((repos) => repos.outbox.insert(outbox));

  await transactions.execute(async (repos) => {
    expect((await repos.outbox.findDue(now, 200)).some((item) => item.id === outbox.id)).toBe(true);
    expect(
      (await repos.outbox.claimDue(now, 200, claim)).some((item) => item.id === outbox.id),
    ).toBe(true);
  });
  await transactions.execute(async (repos) => {
    expect((await repos.outbox.findDue(now, 200)).some((item) => item.id === outbox.id)).toBe(
      false,
    );
    expect(await repos.outbox.saveDelivery(outbox, { owner: claim.owner, until: at(599) })).toBe(
      false,
    );
    outbox.scheduleRetry(now, { baseDelayMs: 100, maxDelayMs: 100 });
    expect(await repos.outbox.saveDelivery(outbox, claim)).toBe(true);
    expect((await repos.outbox.findById(outbox.id))?.attempts).toBe(1);
    expect((await repos.outbox.findDue(at(599), 200)).some((item) => item.id === outbox.id)).toBe(
      false,
    );
    expect((await repos.outbox.findDue(at(600), 200)).some((item) => item.id === outbox.id)).toBe(
      true,
    );
    outbox.markPublished(at(600));
    expect(await repos.outbox.saveDelivery(outbox)).toBe(true);
  });
  const stored = await transactions.execute(async (repos) => {
    expect((await repos.outbox.findDue(at(1000), 200)).some((item) => item.id === outbox.id)).toBe(
      false,
    );
    return repos.outbox.findById(outbox.id);
  });
  expect(stored?.publishedAt).toEqual(at(600));
  expect(stored?.nextAttemptAt).toBeUndefined();
});

function latch() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

test("a concurrent insert with the same idempotency key can commit only once", async () => {
  const opened = opening();
  const key = randomUUID();
  await transactions.execute((repos) => insertOpening(repos, opened));
  const attempts = [
    makeWager(opened.wallet, Kind.Bet, "1.00", { idempotencyKey: key }),
    makeWager(opened.wallet, Kind.Bet, "2.00", { idempotencyKey: key }),
  ];
  const results = await Promise.allSettled(
    attempts.map((item) =>
      transactions.execute(async (repos) => {
        await repos.wagers.insert(item);
        return item.id;
      }),
    ),
  );
  const commits = results.filter((result) => result.status === "fulfilled");
  const failures = results.filter((result) => result.status === "rejected");
  expect(commits).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatchObject({ code: "23505", constraint: "uq_wager_idempotency" });
  const stored = await transactions.execute((repos) => repos.wagers.findByIdempotencyKey(key));
  expect(stored?.transaction.id).toBe(commits[0]?.value);
});

test("concurrent outbox claims skip locked work and use distinct rows", async () => {
  const earlier = atomicFixtures().outbox;
  const later = atomicFixtures().outbox;
  await transactions.execute(async (repos) => {
    await repos.outbox.insert(earlier);
    await repos.outbox.insert(later);
  });

  const firstReady = latch();
  const release = latch();
  const now = at(500);
  const first = transactions.execute(async (repos) => {
    const batch = await repos.outbox.claimDue(now, 1, { owner: "first", until: at(900) });
    firstReady.release();
    await release.reached;
    return batch.map((item) => item.id);
  });
  const outcome = first.then(
    (result) => ({ result }),
    (failure: unknown) => ({ failure }),
  );
  await Promise.race([firstReady.reached, outcome]);
  let other: string[];
  try {
    other = await transactions.execute(async (repos) =>
      (await repos.outbox.claimDue(now, 1, { owner: "second", until: at(900) })).map(
        (item) => item.id,
      ),
    );
  } finally {
    release.release();
  }
  const initial = await first;
  expect(initial).toHaveLength(1);
  expect(other).toHaveLength(1);
  expect(initial[0]).not.toBe(other[0]);
});

test("serializes the same wallet and lets a third connection update another wallet", async () => {
  const a = opening("10.00");
  const b = opening("10.00");
  const aId = a.wallet.id;
  await transactions.execute(async (repos) => {
    await insertOpening(repos, a);
    await insertOpening(repos, b);
  });
  const acquired = latch();
  const finish = latch();
  const first = transactions.execute(async (repos) => {
    const locked = await repos.wallets.lockById(aId);
    if (!locked) throw new Error("Missing wallet A");
    acquired.release();
    await finish.reached;
    await insertApplied(repos, locked, makeWager(locked, Kind.Win, "2.00"), at(1));
  });
  const firstOutcome = first.then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([acquired.reached, firstOutcome]);
  const second = transactions.execute(
    async (repos) => {
      const locked = await repos.wallets.lockById(aId);
      if (!locked) throw new Error("Missing wallet A");
      expect(locked.balance.toString()).toBe("12.00");
      await insertApplied(repos, locked, makeWager(locked, Kind.Win, "3.00"), at(2));
    },
    { lockTimeoutMs: 1_200 },
  );
  const secondOutcome = second.then(
    () => undefined,
    (error: unknown) => error,
  );

  try {
    await waitFor(
      async () => {
        const [row] = await database.orm.em.getConnection().execute<{ waiting: boolean }[]>(`
        select exists (
          select from pg_stat_activity
           where datname = current_database() and wait_event_type = 'Lock'
             and cardinality(pg_blocking_pids(pid)) > 0
        ) as waiting
      `);
        return row?.waiting ? true : undefined;
      },
      "a second connection waiting for wallet A",
      750,
    );

    await transactions.execute(async (repos) => {
      const other = await repos.wallets.lockById(b.wallet.id);
      if (!other) throw new Error("Missing wallet B");
      await insertApplied(repos, other, makeWager(other, Kind.Win, "5.00"), at(1));
      expect((await repos.wallets.findById(aId))?.balance.toString()).toBe("10.00");
    });
  } finally {
    finish.release();
    await Promise.all([firstOutcome, secondOutcome]);
  }
  expect(await firstOutcome).toBeUndefined();
  expect(await secondOutcome).toBeUndefined();
  await transactions.execute(async (repos) => {
    for (const id of [aId, b.wallet.id]) {
      const audit = await repos.ledger.auditBalance(id);
      expect(audit?.storedBalance.toString()).toBe("15.00");
      expect(audit?.consistent).toBe(true);
    }
  });
}, 15_000);

test("classifies lock timeout and releases the lock and journal after rollback", async () => {
  const opened = opening("10.00");
  const walletId = opened.wallet.id;
  await transactions.execute((repos) => insertOpening(repos, opened));
  const acquired = latch();
  const release = latch();
  const boom = new Error("rollback holder");
  const holder = transactions
    .execute(async (repos) => {
      const locked = await repos.wallets.lockById(walletId);
      if (!locked) throw new Error("Missing wallet");
      await insertApplied(repos, locked, makeWager(locked, Kind.Win, "2.00"), at(1));
      acquired.release();
      await release.reached;
      throw boom;
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  await Promise.race([acquired.reached, holder]);
  try {
    const failure = await transactions
      .execute((repos) => repos.wallets.lockById(walletId), { lockTimeoutMs: 100 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(PersistenceConflictError);
    expect(failure).toMatchObject({ reason: "LOCK_TIMEOUT", cause: { code: "55P03" } });
  } finally {
    release.release();
    await holder;
  }
  expect(await holder).toBe(boom);
  await transactions.execute(async (repos) => {
    const locked = await repos.wallets.lockById(walletId);
    expect(locked?.balance.equals(Money.from({ amount: "10.00", currency: "BRL" }))).toBe(true);
    const audit = await repos.ledger.auditBalance(walletId);
    expect(audit?.checkedEntries).toBe(1);
    expect(audit?.consistent).toBe(true);
  });
}, 15_000);
