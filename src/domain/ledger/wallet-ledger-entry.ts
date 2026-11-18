import { Money } from "../money/money";
import { CurrencyMismatchError, DomainInvariantError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { requireFields, timestamp } from "../shared/validation";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly createdAt: Date;
}

const invalidLedger = FailureCode.InvalidLedgerEntry;

export class WalletLedgerEntry {
  readonly #createdAt: number;

  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    createdAt: Date,
  ) {
    this.#createdAt = createdAt.getTime();
    Object.freeze(this);
  }

  static create(state: LedgerEntryState): WalletLedgerEntry {
    const {
      id,
      walletId,
      transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      createdAt,
    } = state;
    requireFields(invalidLedger, { id, walletId, transactionId });
    timestamp(createdAt, invalidLedger);
    if (!Number.isSafeInteger(state.walletVersion) || state.walletVersion < 1) {
      throw new DomainInvariantError(invalidLedger, "Ledger requires a positive wallet version");
    }
    if (direction !== LedgerDirection.Debit && direction !== LedgerDirection.Credit) {
      throw new DomainInvariantError(invalidLedger, "Invalid ledger direction");
    }
    if (
      !(money instanceof Money) ||
      !(balanceBefore instanceof Money) ||
      !(balanceAfter instanceof Money) ||
      !money.isPositive() ||
      balanceBefore.isNegative() ||
      balanceAfter.isNegative()
    ) {
      throw new DomainInvariantError(
        invalidLedger,
        "Ledger requires a positive amount and non-negative balances",
      );
    }
    for (const balance of [balanceBefore, balanceAfter]) {
      if (balance.currency !== money.currency) {
        throw new CurrencyMismatchError(money.currency, balance.currency);
      }
    }
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) {
      throw new DomainInvariantError(
        invalidLedger,
        "Ledger arithmetic does not match the resulting balance",
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  get createdAt(): Date {
    return new Date(this.#createdAt);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  toJSON() {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
