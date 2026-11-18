import { MikroORM } from "@mikro-orm/postgresql";
import { afterAll, beforeAll, expect, test } from "bun:test";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import type { ProcessWagerCommand } from "../../../src/application/commands/financial-commands";
import type { ProcessWagerResult } from "../../../src/application/results/financial-results";
import { PersistenceUnavailableError } from "../../../src/application/ports/transaction-manager";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/wager-transaction";
import { MikroTransactionManager } from "../../../src/infrastructure/persistence/transaction/mikro-transaction-manager";
import { command, financialApplication } from "../../helpers/application-fixtures";
import { failureFrom } from "../../helpers/failure-from";
import { makeWager } from "../../helpers/financial-fixtures";
import { createTestDatabase } from "../../helpers/test-database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof financialApplication>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = financialApplication(database.orm);
}, 15_000);
afterAll(async () => database?.close());

const Processed = "WagerTransactionProcessed";
const Rejected = "WagerTransactionRejected";
const BalanceChanged = "WalletBalanceChanged";
const Pending = "WagerTransactionPendingReference";

async function events(transactionId: string) {
  return database.orm.em
    .getConnection()
    .execute<{ event_type: string; payload: Record<string, unknown> }[]>(
      "select event_type, payload from wagering.outbox_messages where payload -> 'data' ->> 'transactionId' = ? order by event_type",
      [transactionId],
    );
}

async function audit(walletId: string, balance: string, entries: number) {
  await app.manager.execute(async (repos) => {
    const wallet = await repos.wallets.findById(walletId);
    const ledger = await repos.ledger.auditBalance(walletId);
    expect(wallet?.balance.toString()).toBe(balance);
    expect(ledger?.storedBalance.toString()).toBe(balance);
    expect(ledger?.calculatedBalance.toString()).toBe(balance);
    expect(ledger?.checkedEntries).toBe(entries);
    expect(ledger?.difference.toString()).toBe("0.00");
  });
}

async function expectOutcome(
  result: ProcessWagerResult,
  walletId: string,
  amount: string,
  status: Status,
  version: number,
  ledgerCount: number,
  types: string[],
  failureCode?: FailureCode,
) {
  expect(result.status).toBe(status);
  expect(result.balance.amount).toBe(amount);
  expect(result.walletVersion).toBe(version);
  expect(result.failureCode).toBe(failureCode);
  expect(result.idempotentReplay).toBe(false);
  expect((await events(result.transactionId)).map(({ event_type }) => event_type)).toEqual(
    [...types].sort(),
  );
  const persisted = await app.wager.execute(result.transactionId);
  expect(persisted).toMatchObject({
    status,
    walletId,
    transactionId: result.transactionId,
    balance: result.balance,
  });
  await audit(walletId, amount, ledgerCount);
}

test("opens zero with no journal and positive balance with one OPENING and two outbox rows", async () => {
  const zero = await app.open("0.00");
  expect(zero.version).toBe(1);
  expect(await app.wallet.execute(zero.id)).toEqual(zero);
  expect(await app.ledger.execute({ walletId: zero.id })).toEqual({ entries: [] });
  await audit(zero.id, "0.00", 0);
  const [empty] = await database.orm.em
    .getConnection()
    .execute<{ wagers: number; events: number }[]>(
      `
    select
      (select count(*)::int from wagering.wager_transactions where wallet_id = ?) as wagers,
      (select count(*)::int from wagering.outbox_messages where payload -> 'data' ->> 'walletId' = ?) as events
  `,
      [zero.id, zero.id],
    );
  expect(empty).toEqual({ wagers: 0, events: 0 });

  const funded = await app.open("100.00");
  const page = await app.ledger.execute({ walletId: funded.id });
  expect(page.entries).toHaveLength(1);
  const entry = page.entries[0];
  if (!entry) throw new Error("Missing opening ledger");
  expect(entry).toMatchObject({
    direction: "CREDIT",
    balanceBefore: { amount: "0.00" },
    balanceAfter: { amount: "100.00" },
    walletVersion: 1,
  });
  const opening = await app.wager.execute(entry.transactionId);
  expect(opening).toMatchObject({
    kind: Kind.Opening,
    status: Status.Processed,
    balance: funded.balance,
    walletVersion: 1,
  });
  expect((await events(opening.transactionId)).map(({ event_type }) => event_type)).toEqual(
    [BalanceChanged, Processed].sort(),
  );
  expect(
    await failureFrom(app.providerWager.execute(opening.providerId, opening.externalTransactionId)),
  ).toMatchObject({ code: "WAGER_NOT_FOUND" });
  await audit(funded.id, "100.00", 1);
});

test("same player and currency is a typed conflict and a different currency opens independently", async () => {
  const wallet = await app.open();
  expect(
    await failureFrom(
      app.create.execute({ playerId: wallet.playerId, initialBalance: wallet.balance }),
    ),
  ).toMatchObject({ code: "WALLET_ALREADY_EXISTS" });
  const other = await app.create.execute({
    playerId: wallet.playerId,
    initialBalance: { amount: "20.00", currency: "USD" },
  });
  expect(other.currency).toBe("USD");
  await audit(wallet.id, "100.00", 1);
  await audit(other.id, "20.00", 1);
});

test("applies BET, referenced WIN, LOSS, REFUND and ROLLBACK of a REFUND", async () => {
  const wallet = await app.open();
  const betRequest = command(wallet, Kind.Bet, "30.00", { correlationId: "match" });
  const bet = await app.process.execute(betRequest);
  await expectOutcome(bet, wallet.id, "70.00", Status.Processed, 2, 2, [BalanceChanged, Processed]);
  const eventRows = await events(bet.transactionId);
  for (const { payload } of eventRows) {
    expect(payload).toMatchObject({
      version: 1,
      correlationId: "match",
      data: { money: { amount: "30.00", currency: "BRL" } },
    });
  }
  expect(new Set(eventRows.map(({ payload }) => payload.eventId)).size).toBe(2);

  const win = await app.process.execute(
    command(wallet, Kind.Win, "50.00", {
      referenceExternalTransactionId: betRequest.externalTransactionId,
    }),
  );
  expect(win.referenceTransactionId).toBe(bet.transactionId);
  await expectOutcome(win, wallet.id, "120.00", Status.Processed, 3, 3, [
    BalanceChanged,
    Processed,
  ]);
  const loss = await app.process.execute(command(wallet, Kind.Loss, "0.00"));
  await expectOutcome(loss, wallet.id, "120.00", Status.Processed, 3, 3, [Processed]);

  const refundRequest = command(wallet, Kind.Refund, "30.00", {
    referenceExternalTransactionId: betRequest.externalTransactionId,
  });
  const refund = await app.process.execute(refundRequest);
  await expectOutcome(refund, wallet.id, "150.00", Status.Processed, 4, 4, [
    BalanceChanged,
    Processed,
  ]);
  const rollback = await app.process.execute(
    command(wallet, Kind.Rollback, "30.00", {
      referenceExternalTransactionId: refundRequest.externalTransactionId,
    }),
  );
  expect(rollback.referenceTransactionId).toBe(refund.transactionId);
  await expectOutcome(rollback, wallet.id, "120.00", Status.Processed, 5, 5, [
    BalanceChanged,
    Processed,
  ]);
});

test("ROLLBACK inverts BET and WIN exactly and rejects another successful reversal", async () => {
  const wallet = await app.open();
  const betRequest = command(wallet, Kind.Bet, "80.00");
  const bet = await app.process.execute(betRequest);
  await expectOutcome(bet, wallet.id, "20.00", Status.Processed, 2, 2, [BalanceChanged, Processed]);
  const reverseBet = command(wallet, Kind.Rollback, "80.00", {
    referenceExternalTransactionId: betRequest.externalTransactionId,
  });
  await expectOutcome(
    await app.process.execute(reverseBet),
    wallet.id,
    "100.00",
    Status.Processed,
    3,
    3,
    [BalanceChanged, Processed],
  );
  const duplicate = command(wallet, Kind.Rollback, "80.00", {
    referenceExternalTransactionId: betRequest.externalTransactionId,
  });
  await expectOutcome(
    await app.process.execute(duplicate),
    wallet.id,
    "100.00",
    Status.Rejected,
    3,
    3,
    [Rejected],
    FailureCode.AlreadyReversed,
  );

  const winRequest = command(wallet, Kind.Win, "50.00");
  const win = await app.process.execute(winRequest);
  await expectOutcome(win, wallet.id, "150.00", Status.Processed, 4, 4, [
    BalanceChanged,
    Processed,
  ]);
  const reverseWin = command(wallet, Kind.Rollback, "50.00", {
    referenceExternalTransactionId: winRequest.externalTransactionId,
  });
  await expectOutcome(
    await app.process.execute(reverseWin),
    wallet.id,
    "100.00",
    Status.Processed,
    5,
    5,
    [BalanceChanged, Processed],
  );
});

test("rejects insufficient BET and spent WIN rollback without affecting balance or ledger", async () => {
  const wallet = await app.open();
  const request = command(wallet, Kind.Bet, "101.00");
  const rejected = await app.process.execute(request);
  await expectOutcome(
    rejected,
    wallet.id,
    "100.00",
    Status.Rejected,
    1,
    1,
    [Rejected],
    FailureCode.InsufficientFunds,
  );

  const win = command(wallet, Kind.Win, "50.00");
  await expectOutcome(await app.process.execute(win), wallet.id, "150.00", Status.Processed, 2, 2, [
    BalanceChanged,
    Processed,
  ]);
  await expectOutcome(
    await app.process.execute(command(wallet, Kind.Bet, "140.00")),
    wallet.id,
    "10.00",
    Status.Processed,
    3,
    3,
    [BalanceChanged, Processed],
  );
  await expectOutcome(
    await app.process.execute(
      command(wallet, Kind.Rollback, "50.00", {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    ),
    wallet.id,
    "10.00",
    Status.Rejected,
    3,
    3,
    [Rejected],
    FailureCode.ReversalInsufficientFunds,
  );
  expect(await app.process.execute(request)).toEqual({ ...rejected, idempotentReplay: true });
});

test("records currency mismatch with original request currency and wallet-currency snapshot", async () => {
  const wallet = await app.open();
  const request = command(wallet, Kind.Bet, "25.00", {
    money: { amount: "25.00", currency: "USD" },
  });
  const rejected = await app.process.execute(request);
  await expectOutcome(
    rejected,
    wallet.id,
    "100.00",
    Status.Rejected,
    1,
    1,
    [Rejected],
    FailureCode.CurrencyMismatch,
  );
  expect(rejected.balance.currency).toBe("BRL");
  expect((await app.wager.execute(rejected.transactionId)).money.currency).toBe("USD");
  expect(await app.process.execute(request)).toEqual({ ...rejected, idempotentReplay: true });
});

test("matches reference scope, status, kind, amount and provider", async () => {
  const wallet = await app.open();
  const other = await app.open();
  const bet = command(wallet, Kind.Bet, "25.00");
  const rejectedBet = command(wallet, Kind.Bet, "999.00");
  const win = command(wallet, Kind.Win, "5.00");
  await app.process.execute(bet);
  await app.process.execute(rejectedBet);
  await app.process.execute(win);
  const cases: [ProcessWagerCommand, FailureCode][] = [
    [
      command(other, Kind.Refund, "25.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      FailureCode.InvalidReference,
    ],
    [
      command(wallet, Kind.Refund, "25.00", {
        roundId: "another",
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      FailureCode.InvalidReference,
    ],
    [
      command(wallet, Kind.Refund, "10.00", {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      FailureCode.AmountMismatch,
    ],
    [
      command(wallet, Kind.Refund, "5.00", {
        referenceExternalTransactionId: win.externalTransactionId,
      }),
      FailureCode.ReferenceTypeNotAllowed,
    ],
    [
      command(wallet, Kind.Refund, "999.00", {
        referenceExternalTransactionId: rejectedBet.externalTransactionId,
      }),
      FailureCode.InvalidReference,
    ],
  ];
  for (const [request, code] of cases) {
    const target = request.walletId === other.id ? other : wallet;
    const expected =
      target.id === other.id ? { amount: "100.00", entries: 1 } : { amount: "80.00", entries: 3 };
    await expectOutcome(
      await app.process.execute(request),
      target.id,
      expected.amount,
      Status.Rejected,
      expected.entries,
      expected.entries,
      [Rejected],
      code,
    );
  }

  const unknown = command(wallet, Kind.Refund, "25.00", {
    providerId: "other",
    referenceExternalTransactionId: bet.externalTransactionId,
  });
  await expectOutcome(
    await app.process.execute(unknown),
    wallet.id,
    "80.00",
    Status.PendingReference,
    3,
    3,
    [Pending],
  );
});

test.each([Kind.Refund, Kind.Rollback])(
  "persists an out-of-order %s once and resumes the same ID",
  async (kind) => {
    const wallet = await app.open();
    const bet = command(wallet, Kind.Bet, "20.00");
    const request = command(wallet, kind, "20.00", {
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const pending = await app.process.execute(request);
    await expectOutcome(pending, wallet.id, "100.00", Status.PendingReference, 1, 1, [Pending]);
    await app.process.execute(command(wallet, Kind.Win, "50.00"));
    expect(await app.process.execute(request)).toEqual({ ...pending, idempotentReplay: true });
    expect(await app.process.resumePending(pending.transactionId)).toEqual({
      ...pending,
      idempotentReplay: true,
    });
    expect(
      await failureFrom(
        app.process.execute({ ...request, money: { amount: "21.00", currency: "BRL" } }),
      ),
    ).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const processedBet = await app.process.execute(bet);
    const resumed = await app.process.resumePending(pending.transactionId);
    expect(resumed.transactionId).toBe(pending.transactionId);
    expect(resumed.referenceTransactionId).toBe(processedBet.transactionId);
    await expectOutcome(resumed, wallet.id, "150.00", Status.Processed, 4, 4, [
      BalanceChanged,
      Pending,
      Processed,
    ]);
    expect(await app.process.resumePending(resumed.transactionId)).toEqual({
      ...resumed,
      idempotentReplay: true,
    });
    expect(await app.process.execute(request)).toEqual({ ...resumed, idempotentReplay: true });
  },
);

test("replays processed and LOSS snapshots after later movements and database reconnection", async () => {
  const wallet = await app.open();
  const bet = command(wallet);
  const loss = command(wallet, Kind.Loss, "0.00");
  const original = await app.process.execute(bet);
  const lost = await app.process.execute(loss);
  await app.process.execute(command(wallet, Kind.Win, "50.00"));
  await app.process.execute(command(wallet, Kind.Win, "1.00"));

  const fresh = await MikroORM.init(database.testOptions);
  try {
    const reconnected = financialApplication(fresh);
    expect(
      await reconnected.process.execute({
        ...bet,
        correlationId: "replay",
        money: { currency: "BRL", amount: "025.00" },
      }),
    ).toEqual({ ...original, idempotentReplay: true });
    expect(await reconnected.process.execute(loss)).toEqual({ ...lost, idempotentReplay: true });
    expect(lost.balance.amount).toBe("75.00");
    expect(
      (await reconnected.providerWager.execute(bet.providerId, bet.externalTransactionId)).balance
        ?.amount,
    ).toBe("75.00");
    expect((await events(original.transactionId)).map(({ event_type }) => event_type)).toEqual(
      [BalanceChanged, Processed].sort(),
    );
    await audit(wallet.id, "126.00", 4);
  } finally {
    await fresh.close(true);
  }
});

test("rejects key collisions, external ID collisions and overwrites of immutable input", async () => {
  const wallet = await app.open();
  const first = command(wallet, Kind.Win, "5.00");
  await app.process.execute(first);
  for (const change of [
    { kind: Kind.Bet },
    { playerId: "another-player" },
    { walletId: "another-wallet" },
    { money: { amount: "7.00", currency: "BRL" } },
    { referenceExternalTransactionId: "bet" },
    { providerId: "different-provider" },
    { externalTransactionId: randomUUID() },
  ]) {
    expect(await failureFrom(app.process.execute({ ...first, ...change }))).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
  for (const money of [first.money, { amount: "10.00", currency: "BRL" }]) {
    expect(
      await failureFrom(app.process.execute({ ...first, money, idempotencyKey: randomUUID() })),
    ).toMatchObject({ code: "EXTERNAL_TRANSACTION_CONFLICT" });
  }
  await audit(wallet.id, "105.00", 2);
});

test("records inbox with the wager and deduplicates new receipts for a replay", async () => {
  const wallet = await app.open();
  const receipt = { consumerName: "processor", messageId: randomUUID() };
  const request = command(wallet, Kind.Bet, "25.00", { inbox: receipt });
  const result = await app.process.execute(request);
  const another = { ...receipt, messageId: randomUUID() };
  expect(await app.process.execute(request)).toEqual({ ...result, idempotentReplay: true });
  expect(await app.process.execute({ ...request, inbox: another })).toEqual({
    ...result,
    idempotentReplay: true,
  });
  await app.manager.execute(async (repos) => {
    const stored = await repos.wagers.findByIdempotencyKey(request.idempotencyKey);
    for (const { consumerName, messageId } of [receipt, another]) {
      const found = await repos.inbox.find(consumerName, messageId);
      expect(found?.isProcessed()).toBe(true);
      expect(found?.payloadHash).toBe(stored?.transaction.payloadHash);
    }
  });
  expect(
    await failureFrom(app.process.execute(command(wallet, Kind.Win, "1.00", { inbox: receipt }))),
  ).toMatchObject({ code: "INBOX_CONFLICT" });
  await expectOutcome(result, wallet.id, "75.00", Status.Processed, 2, 2, [
    BalanceChanged,
    Processed,
  ]);
});

test("looks up financial records and paginates by opaque wallet-bound cursor", async () => {
  const wallet = await app.open("100.00");
  const another = await app.open();
  const original = command(wallet, Kind.Bet, "25.00");
  const a = await app.process.execute(original);
  const first = await app.ledger.execute({ walletId: wallet.id, limit: 1 });
  expect(first.entries.map(({ walletVersion }) => walletVersion)).toEqual([1]);
  if (!first.nextCursor) throw new Error("Expected a next cursor");
  const cursor = first.nextCursor;
  await app.process.execute(command(wallet, Kind.Win, "20.00"));
  const second = await app.ledger.execute({ walletId: wallet.id, limit: 2, cursor });
  expect(second.entries.map(({ walletVersion }) => walletVersion)).toEqual([2, 3]);
  expect(second.nextCursor).toBeUndefined();
  expect((await app.wager.execute(a.transactionId)).balance?.amount).toBe("75.00");
  expect(
    (await app.providerWager.execute(original.providerId, original.externalTransactionId))
      .transactionId,
  ).toBe(a.transactionId);

  const invalid = (walletId: string, candidate: string) =>
    Promise.resolve().then(() => app.ledger.execute({ walletId, cursor: candidate }));
  expect(await failureFrom(invalid(wallet.id, "!"))).toMatchObject({ code: "INVALID_CURSOR" });
  expect(await failureFrom(invalid(another.id, cursor))).toMatchObject({ code: "INVALID_CURSOR" });
  const outside = Buffer.from(JSON.stringify([1, wallet.id, 999])).toString("base64url");
  expect(await failureFrom(invalid(wallet.id, outside))).toMatchObject({ code: "INVALID_CURSOR" });
  expect(await failureFrom(app.wallet.execute(randomUUID()))).toMatchObject({
    code: "WALLET_NOT_FOUND",
  });
  expect(await failureFrom(app.ledger.execute({ walletId: randomUUID() }))).toMatchObject({
    code: "WALLET_NOT_FOUND",
  });
  expect(await failureFrom(app.wager.execute(randomUUID()))).toMatchObject({
    code: "WAGER_NOT_FOUND",
  });
  expect(await failureFrom(app.providerWager.execute("provider", randomUUID()))).toMatchObject({
    code: "WAGER_NOT_FOUND",
  });
  expect(
    await failureFrom(app.process.execute({ ...command(wallet), playerId: randomUUID() })),
  ).toMatchObject({ code: "WALLET_OWNERSHIP_MISMATCH" });
  await audit(wallet.id, "95.00", 3);
});

test("supports reads of legacy records without inventing a historical balance", async () => {
  const wallet = await app.open();
  await app.manager.execute(async (repos) => {
    const stored = await repos.wallets.findById(wallet.id);
    if (!stored) throw new Error("Missing legacy wallet");
    const legacy = makeWager(stored, Kind.Refund, "1.00", {
      referenceExternalTransactionId: "unknown",
    });
    legacy.markPendingReference();
    await repos.wagers.insert(legacy);
    const view = await repos.wagers.findById(legacy.id);
    expect(view?.result).toBeUndefined();
  });
  await audit(wallet.id, "100.00", 1);
});

test("reports an unavailable PostgreSQL connection as infrastructure failure", async () => {
  const url = new URL(database.testOptions.clientUrl ?? "");
  url.port = "1";
  const disconnected = await MikroORM.init({ ...database.testOptions, clientUrl: url.href });
  try {
    const failure = await failureFrom(
      new MikroTransactionManager(disconnected).execute((repos) =>
        repos.wallets.findById("missing"),
      ),
    );
    expect(failure).toBeInstanceOf(PersistenceUnavailableError);
  } finally {
    await disconnected.close(true);
  }
});

test("generated command sequences preserve the journal, historic replay and non-negative balance", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          kind: fc.constantFrom(Kind.Bet, Kind.Win, Kind.Loss),
          cents: fc.integer({ min: 1, max: 150 }),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      async (operations) => {
        const wallet = await app.open("1.00");
        let balance = Money.from(wallet.balance);
        let entries = 1;
        for (const operation of operations) {
          const cents = BigInt(operation.cents);
          const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
          const request = command(wallet, operation.kind, amount);
          const result = await app.process.execute(request);
          const money = Money.from(request.money);
          if (operation.kind === Kind.Bet && balance.isLessThan(money)) {
            expect(result.status).toBe(Status.Rejected);
            expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
          } else {
            expect(result.status).toBe(Status.Processed);
            if (operation.kind !== Kind.Loss) {
              balance = operation.kind === Kind.Bet ? balance.subtract(money) : balance.add(money);
              entries++;
            }
          }
          expect(balance.isNegative()).toBe(false);
          expect(result.walletVersion).toBe(entries);
          expect(result.balance.amount).toBe(balance.toString());
          expect(await app.process.execute(request)).toEqual({ ...result, idempotentReplay: true });
          await audit(wallet.id, balance.toString(), entries);
        }
      },
    ),
    { seed: 20261118, numRuns: 16 },
  );
}, 25_000);
