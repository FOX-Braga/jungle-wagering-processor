import { expect, test } from "bun:test";
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import {
  DomainInvariantError,
  DomainUsageError,
  InvalidTransactionStateError,
} from "../../../src/domain/shared/domain-errors";
import { FailureCode, type RejectionCode } from "../../../src/domain/shared/failure-code";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { openWallet } from "../../../src/domain/wagering/open-wallet";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type WagerTransactionProps,
} from "../../../src/domain/wagering/wager-transaction";
import { at, brl } from "../../helpers/domain";
import { wager, wagerProps } from "../../helpers/wager";

const walletWith = (amount = "100.00") =>
  Wallet.open({ id: "wallet", playerId: "player", initialBalance: brl(amount), createdAt: at() });
const application = (
  atOffset = 10,
  reference?: WagerTransaction,
  appliedReversals: readonly WagerTransaction[] = [],
) => ({
  at: at(atOffset),
  ledgerEntryId: `entry-${atOffset}`,
  appliedReversals,
  ...(reference ? { reference } : {}),
});
const finishedBet = () => {
  const tx = wager(Kind.Bet);
  tx.markProcessed(undefined, at());
  return tx;
};
const terminal = [Status.Processed, Status.Rejected, Status.Failed];

function processedEntry(result: ReturnType<WagerTransaction["apply"]>): WalletLedgerEntry {
  if (result.status !== Status.Processed || !result.ledgerEntry) {
    throw new Error("Expected a processed transaction with a ledger entry");
  }
  return result.ledgerEntry;
}

function reconstruct(entries: readonly WalletLedgerEntry[], initial = brl("0.00")) {
  return entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    initial,
  );
}

test("factory protects operation shape, reference and money contracts", () => {
  const props = wagerProps(Kind.Bet);
  expect(() => WagerTransaction.create({ ...props, kind: Kind.Opening })).toThrow(DomainUsageError);
  for (const kind of [Kind.Refund, Kind.Rollback]) {
    expect(() => wager(kind)).toThrow(DomainInvariantError);
  }
  for (const kind of [Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback]) {
    expect(() =>
      wager(kind, {
        money: brl("0.00"),
        ...(kind === Kind.Refund || kind === Kind.Rollback
          ? { referenceExternalTransactionId: "bet" }
          : {}),
      }),
    ).toThrow(DomainInvariantError);
  }
  expect(() => wager(Kind.Bet, { id: " " })).toThrow(DomainInvariantError);
  expect(() => wager(Kind.Bet, { money: brl("1.00").negate() })).toThrow(DomainInvariantError);
  expect(() => wager(Kind.Loss, { referenceExternalTransactionId: "bet" })).toThrow(
    DomainInvariantError,
  );
  expect(() => wager(Kind.Win, { referenceExternalTransactionId: "win" })).toThrow(
    DomainInvariantError,
  );
  expect(() => wager(Kind.Win, { referenceExternalTransactionId: "" })).toThrow(
    DomainInvariantError,
  );
  expect(() => wager("UNKNOWN" as Kind)).toThrow(DomainInvariantError);
  const transaction = WagerTransaction.create(props);
  expect(transaction.status).toBe(Status.Pending);
  expect(transaction.matchesPayload(props.payloadHash)).toBe(true);
  expect(transaction.matchesPayload("another-hash")).toBe(false);
  expect(transaction.requiresReference()).toBe(false);
  expect(transaction.affectsBalance()).toBe(true);
  expect(transaction.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
});

const transitions = [
  [Status.PendingReference, (tx: WagerTransaction) => tx.markPendingReference()],
  [Status.Processed, (tx: WagerTransaction) => tx.markProcessed(finishedBet(), at(100))],
  [Status.Rejected, (tx: WagerTransaction) => tx.reject(FailureCode.InvalidReference)],
  [Status.Failed, (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed)],
] as const;

for (const start of Object.values(Status)) {
  for (const [end, transition] of transitions) {
    test(`transition ${start} -> ${end}`, () => {
      const tx = WagerTransaction.rehydrate({
        ...wagerProps(Kind.Win, { referenceExternalTransactionId: "bet" }),
        status: start,
      });
      const allowed =
        start === Status.Pending ||
        (start === Status.PendingReference && end !== Status.PendingReference);
      if (allowed) {
        transition(tx);
        expect(tx.status).toBe(end);
        expect(tx.isTerminal()).toBe(terminal.includes(end));
        if (end === Status.Failed) expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
        if (end === Status.Rejected) expect(tx.failureCode).toBe(FailureCode.InvalidReference);
        if (end === Status.Processed) expect(tx.processedAt).toEqual(at(100));
      } else {
        expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
        expect(tx.status).toBe(start);
      }
    });
  }
}

test("rehydration preserves dates, failure codes, references and historical shape", () => {
  const createdAt = at();
  const processedAt = at(20);
  const tx = WagerTransaction.rehydrate({
    ...wagerProps(Kind.Refund, { createdAt, money: brl("0.00") }),
    status: Status.Processed,
    processedAt,
    referenceTransactionId: "original",
  });
  createdAt.setTime(0);
  processedAt.setTime(0);
  tx.processedAt?.setTime(0);
  expect(tx.status).toBe(Status.Processed);
  expect(tx.createdAt).toEqual(at());
  expect(tx.processedAt).toEqual(at(20));
  expect(tx.referenceTransactionId).toBe("original");
  expect(Reflect.set(tx, "money", brl("100.00"))).toBe(false);
  expect(() => tx.apply(walletWith(), application())).toThrow(InvalidTransactionStateError);
  const failed = WagerTransaction.rehydrate({
    ...wagerProps(Kind.Bet),
    status: Status.Failed,
    failureCode: FailureCode.ProcessingFailed,
  });
  expect(failed.failureCode).toBe(FailureCode.ProcessingFailed);
});

test("rejects reference waiting for an operation with no reference and rejects a stale processedAt", () => {
  const tx = wager(Kind.Bet);
  expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
  expect(() => tx.markProcessed(undefined, at(-1))).toThrow(DomainInvariantError);
  expect(tx.status).toBe(Status.Pending);
});

test("direct processing preserves pending state until the reference is processed", () => {
  const tx = wager(Kind.Rollback, { referenceExternalTransactionId: "bet" });
  const bet = wager(Kind.Bet);
  expect(() => tx.markProcessed(undefined, at(10))).toThrow(
    expect.objectContaining({ code: FailureCode.ReferenceNotFound }),
  );
  expect(() => tx.markProcessed(bet, at(10))).toThrow(
    expect.objectContaining({ code: FailureCode.ReferenceNotReady }),
  );
  expect(() => tx.ledgerDirectionFor()).toThrow(
    expect.objectContaining({ code: FailureCode.ReferenceNotFound }),
  );
  expect(() => tx.ledgerDirectionFor(wager(Kind.Loss))).toThrow(
    expect.objectContaining({ code: FailureCode.ReferenceTypeNotAllowed }),
  );
  expect(tx.status).toBe(Status.Pending);
});

test("opening 100.00 emits an internal credit at version 1 and zero opening emits no entry", () => {
  const props = {
    id: "wallet",
    playerId: "player",
    initialBalance: brl("100.00"),
    createdAt: at(),
  };
  const journal = {
    transactionId: "opening",
    ledgerEntryId: "entry-0",
    payloadHash: "opening-hash",
  };
  const { wallet, opening } = openWallet(props, journal);
  expect(opening?.transaction.kind).toBe(Kind.Opening);
  expect(opening?.transaction.status).toBe(Status.Processed);
  expect(opening?.ledgerEntry.direction).toBe(LedgerDirection.Credit);
  expect(opening?.ledgerEntry.walletVersion).toBe(1);
  expect(opening?.ledgerEntry.balanceBefore.toString()).toBe("0.00");
  expect(opening?.ledgerEntry.balanceAfter.equals(wallet.balance)).toBe(true);
  expect(wallet.version).toBe(1);
  expect(openWallet({ ...props, initialBalance: brl("0.00") }).opening).toBeUndefined();
  expect(() => openWallet(props)).toThrow(DomainInvariantError);
});

test("BET 30.00, WIN 50.00 and REFUND 30.00 reconcile to 150.00", () => {
  const { wallet, opening } = openWallet(
    { id: "wallet", playerId: "player", initialBalance: brl("100.00"), createdAt: at() },
    { transactionId: "opening", ledgerEntryId: "entry-0", payloadHash: "opening-hash" },
  );
  if (!opening) throw new Error("Expected a positive opening");
  const entries = [opening.ledgerEntry];
  const bet = wager(Kind.Bet, { money: brl("30.00") });
  entries.push(processedEntry(bet.apply(wallet, application(10))));
  expect(wallet.balance.toString()).toBe("70.00");
  expect(reconstruct(entries).equals(wallet.balance)).toBe(true);

  const win = wager(Kind.Win, { money: brl("50.00"), referenceExternalTransactionId: "bet" });
  entries.push(processedEntry(win.apply(wallet, application(20, bet))));
  expect(win.referenceTransactionId).toBe(bet.id);
  expect(wallet.balance.toString()).toBe("120.00");
  expect(reconstruct(entries).equals(wallet.balance)).toBe(true);

  const refund = wager(Kind.Refund, { money: brl("30.00"), referenceExternalTransactionId: "bet" });
  entries.push(processedEntry(refund.apply(wallet, application(30, bet))));
  expect(refund.requiresReference()).toBe(true);
  expect(wallet.balance.toString()).toBe("150.00");
  expect(wallet.version).toBe(4);
  expect(reconstruct(entries).equals(wallet.balance)).toBe(true);
});

test("rejects an insufficient BET and keeps 75.00 after BET 25.00 and LOSS", () => {
  const wallet = walletWith("100.00");
  const rejected = wager(Kind.Bet, { externalTransactionId: "too-high", money: brl("100.01") });
  expect(rejected.apply(wallet, application())).toEqual({
    status: Status.Rejected,
    failureCode: FailureCode.InsufficientFunds,
  });
  expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(1);
  const bet = wager(Kind.Bet, { money: brl("25.00") });
  const debit = processedEntry(bet.apply(wallet, application(20)));
  expect(wallet.balance.toString()).toBe("75.00");
  expect(wallet.version).toBe(2);
  const loss = wager(Kind.Loss, { money: brl("0.00") });
  expect(loss.affectsBalance()).toBe(false);
  expect(loss.ledgerDirectionFor()).toBeUndefined();
  expect(loss.apply(wallet, application(30))).toEqual({
    status: Status.Processed,
    ledgerEntry: undefined,
  });
  expect(wallet.balance.toString()).toBe("75.00");
  expect(reconstruct([debit], brl("100.00")).equals(wallet.balance)).toBe(true);
  expect(wallet.version).toBe(2);
});

test("reference may arrive after the reversal and a still pending reference can be retried", () => {
  const wallet = walletWith();
  const refund = wager(Kind.Refund, { referenceExternalTransactionId: "bet" });
  const bet = wager(Kind.Bet);
  expect(refund.apply(wallet, application())).toEqual({ status: Status.PendingReference });
  expect(refund.apply(wallet, application(20, bet))).toEqual({ status: Status.PendingReference });
  expect(wallet.balance.toString()).toBe("100.00");
  const debit = processedEntry(bet.apply(wallet, application(30)));
  const credit = processedEntry(refund.apply(wallet, application(40, bet)));
  expect(refund.referenceTransactionId).toBe(bet.id);
  expect(reconstruct([debit, credit], brl("100.00")).equals(wallet.balance)).toBe(true);
});

const mismatches: [string, Partial<WagerTransactionProps>, RejectionCode][] = [
  ["provider", { providerId: "other" }, FailureCode.InvalidReference],
  ["player", { playerId: "other" }, FailureCode.InvalidReference],
  ["wallet", { walletId: "other" }, FailureCode.InvalidReference],
  ["round", { roundId: "other" }, FailureCode.InvalidReference],
  ["external ID", { externalTransactionId: "another" }, FailureCode.InvalidReference],
  [
    "currency",
    { money: Money.from({ amount: "20.00", currency: "USD" }) },
    FailureCode.CurrencyMismatch,
  ],
  ["amount", { money: brl("20.01") }, FailureCode.AmountMismatch],
];
test.each(mismatches)("rejects a reference that differs in %s", (_label, overrides, code) => {
  const source = wager(Kind.Bet, overrides);
  source.markProcessed(undefined, at());
  const wallet = walletWith();
  const tx = wager(Kind.Refund, { referenceExternalTransactionId: "bet" });
  expect(tx.apply(wallet, application(10, source))).toEqual({
    status: Status.Rejected,
    failureCode: code,
  });
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(1);
});

test("rejects invalid reference kinds and unsuccessful terminal references", () => {
  const wallet = walletWith();
  const rejected = wager(Kind.Bet);
  rejected.reject(FailureCode.InsufficientFunds);
  const win = wager(Kind.Win);
  win.markProcessed(undefined, at());
  const scenarios = [
    [
      wager(Kind.Refund, { referenceExternalTransactionId: "bet" }),
      rejected,
      FailureCode.InvalidReference,
    ],
    [
      wager(Kind.Refund, { referenceExternalTransactionId: "win" }),
      win,
      FailureCode.ReferenceTypeNotAllowed,
    ],
    [
      wager(Kind.Rollback, { referenceExternalTransactionId: "loss" }),
      wager(Kind.Loss),
      FailureCode.ReferenceTypeNotAllowed,
    ],
    [
      wager(Kind.Win, {
        externalTransactionId: "another-win",
        referenceExternalTransactionId: "win",
      }),
      win,
      FailureCode.ReferenceTypeNotAllowed,
    ],
  ] as const;
  for (const [tx, reference, code] of scenarios) {
    expect(tx.apply(wallet, application(10, reference))).toEqual({
      status: Status.Rejected,
      failureCode: code,
    });
  }
  expect(wallet.balance.toString()).toBe("100.00");
});

test.each([Kind.Bet, Kind.Win, Kind.Refund])("ROLLBACK reverses a processed %s exactly", (kind) => {
  const wallet = walletWith();
  const entries: WalletLedgerEntry[] = [];
  let reference: WagerTransaction;
  if (kind === Kind.Refund) {
    const bet = wager(Kind.Bet);
    entries.push(processedEntry(bet.apply(wallet, application(10))));
    reference = wager(Kind.Refund, { referenceExternalTransactionId: "bet" });
    entries.push(processedEntry(reference.apply(wallet, application(20, bet))));
  } else {
    reference = wager(kind, kind === Kind.Bet ? { money: brl("80.00") } : {});
    entries.push(processedEntry(reference.apply(wallet, application(20))));
    expect(wallet.balance.toString()).toBe(kind === Kind.Bet ? "20.00" : "120.00");
  }
  const rollback = wager(Kind.Rollback, {
    referenceExternalTransactionId: reference.externalTransactionId,
    money: reference.money,
  });
  const inverse = processedEntry(rollback.apply(wallet, application(30, reference, [reference])));
  entries.push(inverse);
  expect(inverse.direction).toBe(
    kind === Kind.Bet ? LedgerDirection.Credit : LedgerDirection.Debit,
  );
  expect(wallet.balance.toString()).toBe(kind === Kind.Refund ? "80.00" : "100.00");
  expect(reconstruct(entries, brl("100.00")).equals(wallet.balance)).toBe(true);
});

test("records a distinct rejection when rolling back a WIN whose credit was spent", () => {
  const wallet = walletWith("100.00");
  const win = wager(Kind.Win, { money: brl("50.00") });
  const credit = processedEntry(win.apply(wallet, application(10)));
  expect(wallet.balance.toString()).toBe("150.00");
  const debit = processedEntry(
    wager(Kind.Bet, { money: brl("140.00") }).apply(wallet, application(20)),
  );
  expect(wallet.balance.toString()).toBe("10.00");
  const reversal = wager(Kind.Rollback, {
    referenceExternalTransactionId: "win",
    money: brl("50.00"),
  });
  expect(reversal.apply(wallet, application(30, win))).toEqual({
    status: Status.Rejected,
    failureCode: FailureCode.ReversalInsufficientFunds,
  });
  expect(wallet.balance.toString()).toBe("10.00");
  expect(wallet.version).toBe(3);
  expect(reconstruct([credit, debit], brl("100.00")).equals(wallet.balance)).toBe(true);
});

test("blocks duplicate and competing direct reversals when an applied reversal exists", () => {
  const wallet = walletWith();
  const bet = wager(Kind.Bet);
  const debit = processedEntry(bet.apply(wallet, application(10)));
  const refund = wager(Kind.Refund, { referenceExternalTransactionId: "bet" });
  const credit = processedEntry(refund.apply(wallet, application(20, bet)));
  const operations = [
    wager(Kind.Refund, {
      externalTransactionId: "second-refund",
      referenceExternalTransactionId: "bet",
    }),
    wager(Kind.Rollback, { referenceExternalTransactionId: "bet" }),
  ];
  for (const transaction of operations) {
    expect(transaction.apply(wallet, application(30, bet, [refund]))).toEqual({
      status: Status.Rejected,
      failureCode: FailureCode.AlreadyReversed,
    });
  }
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(3);
  expect(reconstruct([debit, credit], brl("100.00")).equals(wallet.balance)).toBe(true);
});

test("ignores rejected reversal history and blocks a second successful ROLLBACK", () => {
  const wallet = walletWith();
  const win = wager(Kind.Win);
  const credit = processedEntry(win.apply(wallet, application(10)));
  const rejected = wager(Kind.Rollback, {
    externalTransactionId: "prior",
    referenceExternalTransactionId: "win",
  });
  rejected.reject(FailureCode.ReversalInsufficientFunds);
  const rollback = wager(Kind.Rollback, { referenceExternalTransactionId: "win" });
  const debit = processedEntry(rollback.apply(wallet, application(20, win, [rejected])));
  const duplicate = wager(Kind.Rollback, {
    externalTransactionId: "duplicate",
    referenceExternalTransactionId: "win",
  });
  expect(duplicate.apply(wallet, application(30, win, [rejected, rollback]))).toEqual({
    status: Status.Rejected,
    failureCode: FailureCode.AlreadyReversed,
  });
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(3);
  expect(reconstruct([credit, debit], brl("100.00")).equals(wallet.balance)).toBe(true);
});

test("rejects a wager with unrelated wallet or money and leaves invalid metadata uncommitted", () => {
  const wallet = walletWith();
  const unrelated = wager(Kind.Bet, { walletId: "another" });
  expect(unrelated.apply(wallet, application())).toEqual({
    status: Status.Rejected,
    failureCode: FailureCode.WalletMismatch,
  });
  const otherCurrency = wager(Kind.Bet, { money: Money.from({ amount: "1.00", currency: "USD" }) });
  expect(otherCurrency.apply(wallet, application())).toEqual({
    status: Status.Rejected,
    failureCode: FailureCode.CurrencyMismatch,
  });
  const tx = wager(Kind.Bet);
  expect(() => tx.apply(wallet, { ...application(), ledgerEntryId: "" })).toThrow(
    DomainInvariantError,
  );
  expect(tx.status).toBe(Status.Pending);
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(1);
});
