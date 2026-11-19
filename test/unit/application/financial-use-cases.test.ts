import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ProcessWagerCommand } from "../../../src/application/commands/financial-commands";
import type { FinancialRepositories } from "../../../src/application/ports/repositories/financial-repositories";
import {
  PersistenceConflictError,
  PersistenceUnavailableError,
  PersistenceUniqueError,
  type TransactionManager,
} from "../../../src/application/ports/transaction-manager";
import {
  hashCanonicalPayload,
  hashWagerPayload,
} from "../../../src/application/services/canonical-wager";
import { CreateWalletUseCase } from "../../../src/application/use-cases/create-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/wager-transaction";
import { normalizePersistenceError } from "../../../src/infrastructure/persistence/transaction/persistence-errors";
import { at, brl } from "../../helpers/domain";
import { failureFrom } from "../../helpers/failure-from";
import { opening, makeWager } from "../../helpers/financial-fixtures";

const { wallet } = opening("100.00");
const input: ProcessWagerCommand = {
  providerId: "provider",
  externalTransactionId: "bet",
  idempotencyKey: "idem",
  walletId: wallet.id,
  playerId: wallet.playerId,
  roundId: "round",
  gameId: "game",
  kind: Kind.Bet,
  money: { amount: "25.00", currency: "BRL" },
};
let count = 0;
const runtime = { clock: { now: () => at() }, ids: { next: () => `unit-${++count}` } };
const absent = () => Promise.resolve(undefined);
const unexpected = () => Promise.reject(new Error("Unexpected repository call"));

function unitPorts() {
  const repos: FinancialRepositories = {
    wallets: {
      insertBaseline: unexpected,
      findById: absent,
      findByPlayerAndCurrency: absent,
      lockById: unexpected,
      saveMovement: unexpected,
    },
    wagers: {
      findById: absent,
      findByExternalId: absent,
      findByIdempotencyKey: absent,
      findPendingByReference: unexpected,
      findAppliedReversals: unexpected,
      findDueReferences: unexpected,
      scheduleReferenceRetry: unexpected,
      insert: unexpected,
      saveState: unexpected,
    },
    ledger: {
      append: unexpected,
      findByTransaction: absent,
      findByWalletVersion: absent,
      listByWallet: unexpected,
      auditBalance: absent,
    },
    inbox: { find: absent, insert: unexpected, saveProcessed: unexpected },
    outbox: {
      findById: absent,
      insert: unexpected,
      findDue: unexpected,
      claimDue: unexpected,
      saveDelivery: unexpected,
    },
  };
  const manager: TransactionManager = { execute: (work) => work(repos) };
  return { repos, manager };
}

test("canonical JSON sorts nested keys and matches an independent SHA-256 vector", async () => {
  const expected = createHash("sha256")
    .update('{"a":{"a":"1.00","z":"BRL"},"z":"2"}')
    .digest("hex");
  expect(await hashCanonicalPayload({ z: "2", a: { z: "BRL", a: "1.00" } })).toBe(expected);
  expect(await hashCanonicalPayload({ a: { a: "1.00", z: "BRL" }, z: "2" })).toBe(expected);
});

test("wager hashes preserve business input and exclude the idempotency key and receipt metadata", async () => {
  const hash = await hashWagerPayload(input, brl("25.00"));
  expect(
    await hashWagerPayload(
      {
        ...input,
        correlationId: "trace",
        causationId: "cause",
        idempotencyKey: "another",
        inbox: { consumerName: "consumer", messageId: "message" },
      },
      brl("025.00"),
    ),
  ).toBe(hash);
  expect(await hashWagerPayload({ ...input, gameId: "other" }, brl("25.00"))).not.toBe(hash);
  expect(await hashWagerPayload(input, brl("25.01"))).not.toBe(hash);
  expect(
    await hashWagerPayload({ ...input, referenceExternalTransactionId: "ref" }, brl("25.00")),
  ).not.toBe(hash);
});

test("invalid commands fail before requesting a transaction", async () => {
  const execute = mock(unexpected);
  const { manager } = unitPorts();
  const failManager: TransactionManager = { execute: () => execute() };
  const process = new ProcessWagerTransactionUseCase(failManager, runtime);
  const open = new CreateWalletUseCase(failManager, runtime);
  for (const invalid of [
    { ...input, kind: Kind.Opening },
    { ...input, kind: Kind.Rollback },
    { ...input, idempotencyKey: " " },
    { ...input, money: { amount: "25.001", currency: "BRL" } },
    { ...input, money: { amount: "9".repeat(37) + ".99", currency: "BRL" } },
    { ...input, money: { amount: "25.00", currency: "invalid" } },
    { ...input, providerId: "system:wallet-opening" },
    { ...input, idempotencyKey: "internal:opening:other" },
  ]) {
    expect(await failureFrom(process.execute(invalid))).toMatchObject({ code: "INVALID_COMMAND" });
  }
  expect(
    await failureFrom(
      open.execute({ playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }),
    ),
  ).toMatchObject({ code: "INVALID_COMMAND" });
  expect(execute).not.toHaveBeenCalled();
  expect(
    await failureFrom(
      new ProcessWagerTransactionUseCase(manager, runtime).execute({
        ...input,
        kind: Kind.Win,
        referenceExternalTransactionId: input.externalTransactionId,
      }),
    ),
  ).toMatchObject({ code: "INVALID_COMMAND" });
});

test("zero opening performs one write and positive opening orders wager, ledger and outbox", async () => {
  const { repos, manager } = unitPorts();
  const calls: string[] = [];
  repos.wallets.insertBaseline = () => {
    calls.push("wallet");
    return Promise.resolve();
  };
  repos.wagers.insert = (wager) => {
    expect(wager.kind).toBe(Kind.Opening);
    calls.push("wager");
    return Promise.resolve();
  };
  repos.wallets.saveMovement = (_wallet, entry) => {
    expect(entry.balanceBefore.toString()).toBe("0.00");
    calls.push("ledger");
    return Promise.resolve();
  };
  repos.outbox.insert = (event) => {
    calls.push(event.eventType);
    return Promise.resolve();
  };
  const create = new CreateWalletUseCase(manager, runtime);
  const zero = await create.execute({
    playerId: "zero",
    initialBalance: { amount: "0.00", currency: "BRL" },
  });
  expect(zero.version).toBe(1);
  expect(calls).toEqual(["wallet"]);
  calls.length = 0;
  const positive = await create.execute({
    playerId: "positive",
    initialBalance: { amount: "25.00", currency: "BRL" },
  });
  expect(positive.balance.amount).toBe("25.00");
  expect(calls).toEqual([
    "wallet",
    "wager",
    "ledger",
    "WagerTransactionProcessed",
    "WalletBalanceChanged",
  ]);
});

test("the external lookup can discover a committed replay between two reads", async () => {
  const { repos, manager } = unitPorts();
  const tx = makeWager(wallet, Kind.Bet, "25.00", {
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    payloadHash: await hashWagerPayload(input, brl("25.00")),
  });
  tx.markProcessed(undefined, at());
  repos.wagers.findByExternalId = () =>
    Promise.resolve({
      transaction: tx,
      updatedAt: at(),
      result: { balance: brl("75.00"), walletVersion: 2 },
    });
  const replay = await new ProcessWagerTransactionUseCase(manager, runtime).execute(input);
  expect(replay).toMatchObject({
    transactionId: tx.id,
    balance: { amount: "75.00" },
    walletVersion: 2,
    idempotentReplay: true,
  });
});

test("a closed snapshot rather than current wallet balance determines replays and conflicts", async () => {
  const { repos, manager } = unitPorts();
  const rejected = makeWager(wallet, Kind.Bet, "25.00", {
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    payloadHash: await hashWagerPayload(input, brl("25.00")),
  });
  rejected.reject(FailureCode.InsufficientFunds);
  repos.wagers.findByIdempotencyKey = () =>
    Promise.resolve({
      transaction: rejected,
      updatedAt: at(),
      result: { balance: brl("0.00"), walletVersion: 1 },
    });
  const process = new ProcessWagerTransactionUseCase(manager, runtime);
  expect(await process.execute(input)).toMatchObject({
    idempotentReplay: true,
    status: Status.Rejected,
    balance: { amount: "0.00" },
  });
  expect(await failureFrom(process.execute({ ...input, gameId: "different" }))).toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("infrastructure errors are typed without turning them into financial rejections", () => {
  expect(normalizePersistenceError({ code: "40P01" })).toBeInstanceOf(PersistenceConflictError);
  expect(normalizePersistenceError({ code: "55P03" })).toMatchObject({ reason: "LOCK_TIMEOUT" });
  expect(normalizePersistenceError({ code: "ECONNREFUSED" })).toBeInstanceOf(
    PersistenceUnavailableError,
  );
  expect(
    normalizePersistenceError({ code: "23505", constraint: "uq_wager_idempotency" }),
  ).toBeInstanceOf(PersistenceUniqueError);
  const unknown = new Error("ledger failure");
  expect(normalizePersistenceError(unknown)).toBe(unknown);
});
