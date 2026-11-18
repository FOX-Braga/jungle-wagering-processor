import { expect, test } from "bun:test";
import {
  LedgerDirection,
  WalletLedgerEntry,
  type LedgerEntryState,
} from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import {
  BusinessRuleError,
  CurrencyMismatchError,
  DomainInvariantError,
} from "../../../src/domain/shared/domain-errors";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { at, brl } from "../../helpers/domain";

const openWallet = (amount = "100.00") =>
  Wallet.open({ id: "wallet", playerId: "player", initialBalance: brl(amount), createdAt: at() });
const movement = (offset = 10) => ({ ledgerEntryId: "entry", transactionId: "tx", at: at(offset) });
const newEntry = (overrides: Partial<LedgerEntryState> = {}): LedgerEntryState => ({
  id: "entry",
  walletId: "wallet",
  transactionId: "tx",
  direction: LedgerDirection.Credit,
  money: brl("20.00"),
  balanceBefore: brl("80.00"),
  balanceAfter: brl("100.00"),
  walletVersion: 2,
  createdAt: at(),
  ...overrides,
});

test.each(["0.00", "100.00"])("opens a wallet with %s and version one", (amount) => {
  const wallet = openWallet(amount);
  expect(wallet.balance.toString()).toBe(amount);
  expect(wallet.currency).toBe("BRL");
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(at());
});

test("rejects an opening with negative balance, missing player or invalid timestamp", () => {
  const props = { id: "wallet", playerId: "player", initialBalance: brl("1.00"), createdAt: at() };
  expect(() => Wallet.open({ ...props, initialBalance: props.initialBalance.negate() })).toThrow(
    DomainInvariantError,
  );
  expect(() => Wallet.open({ ...props, playerId: "" })).toThrow(DomainInvariantError);
  expect(() => Wallet.open({ ...props, createdAt: new Date(NaN) })).toThrow(DomainInvariantError);
});

test("credits and debits to zero with one ledger entry and one version per movement", () => {
  const wallet = openWallet("80.00");
  const credit = wallet.credit(brl("20.00"), movement());
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(2);
  const debit = wallet.debit(brl("100.00"), {
    ...movement(20),
    transactionId: "debit",
    ledgerEntryId: "second",
  });
  expect(wallet.balance.toString()).toBe("0.00");
  expect(wallet.version).toBe(3);
  expect(wallet.updatedAt).toEqual(at(20));
  expect(credit?.toJSON()).toMatchObject({
    direction: "CREDIT",
    balanceBefore: brl("80.00").toJSON(),
    balanceAfter: brl("100.00").toJSON(),
  });
  expect(debit?.toJSON()).toMatchObject({
    direction: "DEBIT",
    balanceBefore: brl("100.00").toJSON(),
    balanceAfter: brl("0.00").toJSON(),
  });
  expect(brl("80.00").add(credit!.money).subtract(debit!.money).equals(wallet.balance)).toBe(true);
});

test.each(["0.00", "100.00"])(
  "rejects an excessive debit and preserves state from %s",
  (amount) => {
    const wallet = openWallet(amount);
    try {
      wallet.debit(brl("100.01"), movement());
      throw new Error("Debit should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(BusinessRuleError);
      expect(error).toMatchObject({ code: FailureCode.InsufficientFunds });
    }
    expect(wallet.balance.toString()).toBe(amount);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(at());
  },
);

test("zero movements leave the wallet and journal unchanged", () => {
  const wallet = openWallet();
  expect(wallet.credit(brl("0.00"), movement())).toBeUndefined();
  expect(wallet.debit(brl("0.00"), movement())).toBeUndefined();
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(at());
});

test("currency, negative movement, invalid ledger metadata and stale date fail without mutation", () => {
  const wallet = openWallet();
  const usd = Money.from({ amount: "5.00", currency: "USD" });
  expect(() => wallet.debit(usd, movement())).toThrow(CurrencyMismatchError);
  expect(() => wallet.credit(usd, movement())).toThrow(CurrencyMismatchError);
  expect(() => wallet.credit(brl("5.00").negate(), movement())).toThrow(DomainInvariantError);
  expect(() => wallet.credit(brl("5.00"), { ...movement(), transactionId: "" })).toThrow(
    DomainInvariantError,
  );
  expect(() => wallet.debit(brl("5.00"), movement(-1))).toThrow(DomainInvariantError);
  expect(wallet.balance.toString()).toBe("100.00");
  expect(wallet.version).toBe(1);
  expect(wallet.updatedAt).toEqual(at());
});

test("rehydrates wallet state with defensive timestamps", () => {
  const updatedAt = at(20);
  const wallet = Wallet.rehydrate({
    id: "wallet",
    playerId: "player",
    balance: brl("45.00"),
    version: 9,
    createdAt: at(),
    updatedAt,
  });
  updatedAt.setTime(0);
  wallet.createdAt.setTime(0);
  wallet.updatedAt.setTime(0);
  expect(wallet.balance.toString()).toBe("45.00");
  expect(wallet.createdAt).toEqual(at());
  expect(wallet.updatedAt).toEqual(at(20));
  expect(wallet.version).toBe(9);
});

test("rejects version overflow without changing the wallet", () => {
  const wallet = Wallet.rehydrate({
    id: "wallet",
    playerId: "player",
    balance: brl("45.00"),
    version: Number.MAX_SAFE_INTEGER,
    createdAt: at(),
    updatedAt: at(),
  });
  expect(() => wallet.credit(brl("1.00"), movement())).toThrow(DomainInvariantError);
  expect(wallet.balance.toString()).toBe("45.00");
  expect(wallet.version).toBe(Number.MAX_SAFE_INTEGER);
  expect(wallet.updatedAt).toEqual(at());
});

test("ledger validates both directions and exports decimal snapshots", () => {
  const credit = WalletLedgerEntry.create(newEntry());
  const debit = WalletLedgerEntry.create(
    newEntry({
      direction: LedgerDirection.Debit,
      balanceBefore: brl("100.00"),
      balanceAfter: brl("80.00"),
    }),
  );
  expect(credit.isBalanced()).toBe(true);
  expect(debit.isBalanced()).toBe(true);
  expect(debit.toJSON()).toMatchObject({
    money: brl("20.00").toJSON(),
    createdAt: at().toISOString(),
  });
});

test("ledger rejects unbalanced, negative, zero, malformed and cross-currency movements", () => {
  const invalid = [
    newEntry({ id: "" }),
    newEntry({ walletVersion: 0 }),
    newEntry({ transactionId: " " }),
    newEntry({ balanceBefore: brl("10.00") }),
    newEntry({ balanceAfter: brl("9.00") }),
    newEntry({ balanceAfter: brl("9.00").negate() }),
    newEntry({ money: brl("0.00") }),
    newEntry({ money: brl("20.00").negate() }),
    newEntry({ direction: "INVALID" as LedgerDirection }),
  ];
  for (const state of invalid) {
    expect(() => WalletLedgerEntry.create(state)).toThrow(DomainInvariantError);
  }
  expect(() => WalletLedgerEntry.create(newEntry({ balanceBefore: Money.zero("USD") }))).toThrow(
    CurrencyMismatchError,
  );
});

test("ledger rehydrates without running creation rules and protects dates and IDs", () => {
  const createdAt = at();
  const entry = WalletLedgerEntry.rehydrate(newEntry({ createdAt, balanceAfter: brl("9.00") }));
  expect(entry.isBalanced()).toBe(false);
  createdAt.setTime(0);
  entry.createdAt.setTime(0);
  expect(entry.createdAt).toEqual(at());
  expect(Reflect.set(entry, "id", "other")).toBe(false);
  expect(entry.id).toBe("entry");
});
