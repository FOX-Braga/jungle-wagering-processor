import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from "../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/domain/money/money";
import {
  BusinessRuleError,
  CurrencyMismatchError,
  DomainInvariantError,
  InvalidTransactionStateError,
} from "../../src/domain/shared/domain-errors";
import { FailureCode } from "../../src/domain/shared/failure-code";
import { Wallet } from "../../src/domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { at } from "../helpers/domain";
import { wagerProps } from "../helpers/wager";

const runConfig = { seed: 20261118, numRuns: 300 };
const cents = fc.bigInt({ min: 0n, max: (1n << 256n) - 1n });
const positiveCents = fc.bigInt({ min: 1n, max: 2_000_000n });
const regularCents = fc.bigInt({ min: 0n, max: 1_000_000n });
const currencies = fc.constantFrom("BRL", "USD", "EUR", "JPY");
const invalidAmounts = fc.oneof(
  fc.constantFrom("", "Infinity", "NaN", "1e-2", "1.00\n"),
  regularCents.map((value) => `-${value}.00`),
  regularCents.map((value) => `${value}.001`),
);

function amount(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function money(cents: bigint, currency = "BRL"): Money {
  return Money.from({ amount: amount(cents), currency });
}

const movement = fc.record({
  direction: fc.constantFrom(LedgerDirection.Credit, LedgerDirection.Debit),
  cents: regularCents,
});
const sequences = fc.array(movement, { minLength: 1, maxLength: 45 });
type Movement = { direction: LedgerDirection; cents: bigint };

function applySequence(initial: bigint, operations: readonly Movement[]) {
  const wallet = Wallet.open({
    id: "wallet",
    playerId: "player",
    initialBalance: money(initial),
    createdAt: at(),
  });
  const entries: WalletLedgerEntry[] = [];
  let expectedBalance = initial;
  let expectedMovements = 0;

  for (const [index, operation] of operations.entries()) {
    const credit = operation.direction === LedgerDirection.Credit;
    if (!credit && operation.cents > expectedBalance) continue;

    const context = {
      ledgerEntryId: `entry-${index}`,
      transactionId: `tx-${index}`,
      at: at(index + 1),
    };
    const quantia = money(operation.cents);
    const entry = credit ? wallet.credit(quantia, context) : wallet.debit(quantia, context);
    if (entry) entries.push(entry);
    if (operation.cents > 0n) expectedMovements++;
    expectedBalance += credit ? operation.cents : -operation.cents;
    expect(wallet.balance.isNegative()).toBe(false);
  }
  return { wallet, entries, expectedBalance, expectedMovements };
}

test("P1 exact arithmetic gives back a after (a + b) - b", () => {
  fc.assert(
    fc.property(cents, cents, currencies, (a, b, currency) => {
      const left = money(a, currency);
      const right = money(b, currency);
      expect(left.add(right).subtract(right).equals(left)).toBe(true);
      expect(left.add(right).toString()).toBe(amount(a + b));
    }),
    runConfig,
  );
});

test("P2 arithmetic preserves operands and returns new objects", () => {
  fc.assert(
    fc.property(cents, cents, currencies, (a, b, currency) => {
      const left = money(a, currency);
      const right = money(b, currency);
      for (const result of [left.add(right), left.subtract(right), left.negate()]) {
        expect(result).not.toBe(left);
        expect(result).not.toBe(right);
      }
      expect(left.toString()).toBe(amount(a));
      expect(right.toString()).toBe(amount(b));
    }),
    runConfig,
  );
});

test("P3 generated valid credit and debit sequences preserve non-negative balances", () => {
  fc.assert(
    fc.property(regularCents, sequences, (initial, operations) => {
      const { wallet } = applySequence(initial, operations);
      expect(wallet.balance.isNegative()).toBe(false);
    }),
    runConfig,
  );
});

test("P4 rejected debit preserves balance, version and timestamp", () => {
  fc.assert(
    fc.property(regularCents, positiveCents, (available, excess) => {
      const wallet = Wallet.open({
        id: "wallet",
        playerId: "player",
        initialBalance: money(available),
        createdAt: at(),
      });
      expect(() =>
        wallet.debit(money(available + excess), {
          ledgerEntryId: "entry",
          transactionId: "tx",
          at: at(1),
        }),
      ).toThrow(BusinessRuleError);
      expect(wallet.balance.toString()).toBe(amount(available));
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(at());
    }),
    runConfig,
  );
});

test("P5 every entry is balanced and links consecutive balances", () => {
  fc.assert(
    fc.property(regularCents, sequences, (initial, operations) => {
      const { entries } = applySequence(initial, operations);
      let precedingBalance = money(initial);
      for (const entry of entries) {
        expect(entry.isBalanced()).toBe(true);
        expect(entry.balanceBefore.equals(precedingBalance)).toBe(true);
        precedingBalance = entry.balanceAfter;
      }
    }),
    runConfig,
  );
});

test("P6 ledger credits minus debits reconstruct the wallet balance", () => {
  fc.assert(
    fc.property(regularCents, sequences, (initial, operations) => {
      const { wallet, entries, expectedBalance } = applySequence(initial, operations);
      const reconstructed = entries.reduce(
        (balance, entry) =>
          entry.direction === LedgerDirection.Credit
            ? balance.add(entry.money)
            : balance.subtract(entry.money),
        money(initial),
      );
      expect(wallet.balance.equals(reconstructed)).toBe(true);
      expect(wallet.balance.toString()).toBe(amount(expectedBalance));
    }),
    runConfig,
  );
});

test("P7 a wallet increments version once per non-zero movement", () => {
  fc.assert(
    fc.property(regularCents, sequences, (initial, operations) => {
      const { wallet, entries, expectedMovements } = applySequence(initial, operations);
      expect(wallet.version).toBe(expectedMovements + 1);
      expect(entries).toHaveLength(expectedMovements);
      expect(entries.map((entry) => entry.walletVersion)).toEqual(
        entries.map((_, index) => index + 2),
      );
    }),
    runConfig,
  );
});

test("P8 different currencies are isolated in arithmetic and wallet movements", () => {
  const isolatedCurrency = fc
    .tuple(currencies, currencies)
    .filter(([left, right]) => left !== right);
  fc.assert(
    fc.property(positiveCents, isolatedCurrency, (value, [left, right]) => {
      const first = money(value, left);
      const second = money(value, right);
      expect(() => first.add(second)).toThrow(CurrencyMismatchError);
      expect(() => first.subtract(second)).toThrow(CurrencyMismatchError);
      expect(() => first.isLessThan(second)).toThrow(CurrencyMismatchError);
      expect(() => first.equals(second)).toThrow(CurrencyMismatchError);
      const wallet = Wallet.open({
        id: "wallet",
        playerId: "player",
        initialBalance: first,
        createdAt: at(),
      });
      expect(() =>
        wallet.credit(second, { ledgerEntryId: "entry", transactionId: "tx", at: at(1) }),
      ).toThrow(CurrencyMismatchError);
      expect(wallet.balance.equals(first)).toBe(true);
      expect(wallet.version).toBe(1);
    }),
    runConfig,
  );
});

test("P9 every attempted transition from a terminal state leaves it intact", () => {
  const states = fc.constantFrom(Status.Processed, Status.Rejected, Status.Failed);
  const strategies = fc.constantFrom(
    (tx: WagerTransaction) => tx.markPendingReference(),
    (tx: WagerTransaction) => tx.markProcessed(undefined, at(1)),
    (tx: WagerTransaction) => tx.reject(FailureCode.InvalidReference),
    (tx: WagerTransaction) => tx.fail(FailureCode.ProcessingFailed),
  );
  fc.assert(
    fc.property(
      states,
      fc.array(strategies, { minLength: 1, maxLength: 12 }),
      (status, attempts) => {
        const tx = WagerTransaction.rehydrate({ ...wagerProps(Kind.Bet), status });
        for (const attempt of attempts) {
          expect(() => attempt(tx)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(status);
          expect(tx.isTerminal()).toBe(true);
        }
      },
    ),
    runConfig,
  );
});

test("P10 serialization round-trips two decimals and invalid inputs are rejected", () => {
  fc.assert(
    fc.property(cents, currencies, invalidAmounts, (value, currency, invalid) => {
      const original = money(value, currency);
      const encoded = original.toJSON();
      expect(encoded).toEqual({ amount: amount(value), currency });
      expect(encoded.amount).toMatch(/^\d+\.\d{2}$/);
      expect(Money.from(encoded).equals(original)).toBe(true);
      expect(() => Money.from({ amount: invalid, currency })).toThrow(DomainInvariantError);
    }),
    runConfig,
  );
});
