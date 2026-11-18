import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import {
  BusinessRuleError,
  CurrencyMismatchError,
  DomainInvariantError,
} from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { requireFields, timestamp } from "../shared/validation";

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly createdAt: Date;
}

export interface WalletState extends Omit<OpenWalletProps, "initialBalance"> {
  readonly balance: Money;
  readonly version: number;
  readonly updatedAt: Date;
}

export interface WalletMovementContext {
  readonly ledgerEntryId: string;
  readonly transactionId: string;
  readonly at: Date;
}

const invalidWallet = FailureCode.InvalidWalletState;

export class Wallet {
  readonly #createdAt: number;
  #balance: Money;
  #version: number;
  #updatedAt: number;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    state: WalletState,
  ) {
    this.#balance = state.balance;
    this.#version = state.version;
    this.#createdAt = state.createdAt.getTime();
    this.#updatedAt = state.updatedAt.getTime();
    Object.freeze(this);
  }

  static open({ id, playerId, initialBalance, createdAt }: OpenWalletProps): Wallet {
    requireFields(invalidWallet, { id, playerId });
    timestamp(createdAt, invalidWallet);
    if (!(initialBalance instanceof Money) || initialBalance.isNegative()) {
      throw new DomainInvariantError(invalidWallet, "Initial balance must be non-negative");
    }
    return Wallet.rehydrate({
      id,
      playerId,
      balance: initialBalance,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance.currency, state);
  }

  get balance(): Money {
    return this.#balance;
  }
  get version(): number {
    return this.#version;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt);
  }
  get updatedAt(): Date {
    return new Date(this.#updatedAt);
  }

  debit(money: Money, context: WalletMovementContext): WalletLedgerEntry | undefined {
    return this.move(LedgerDirection.Debit, money, context);
  }

  credit(money: Money, context: WalletMovementContext): WalletLedgerEntry | undefined {
    return this.move(LedgerDirection.Credit, money, context);
  }

  private move(
    direction: LedgerDirection,
    money: Money,
    context: WalletMovementContext,
  ): WalletLedgerEntry | undefined {
    if (!(money instanceof Money) || money.isNegative()) {
      throw new DomainInvariantError(invalidWallet, "Movement amount must be non-negative");
    }
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    const updatedAt = timestamp(context.at, invalidWallet, this.#updatedAt);
    if (money.isZero()) return undefined;

    const balanceBefore = this.#balance;
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? balanceBefore.subtract(money)
        : balanceBefore.add(money);
    if (balanceAfter.isNegative()) {
      throw new BusinessRuleError(
        FailureCode.InsufficientFunds,
        "Wallet balance is too low for the debit",
      );
    }
    const version = this.#version + 1;
    if (!Number.isSafeInteger(version)) {
      throw new DomainInvariantError(
        invalidWallet,
        "Wallet version exceeds the safe integer range",
      );
    }
    const entry = WalletLedgerEntry.create({
      id: context.ledgerEntryId,
      transactionId: context.transactionId,
      walletId: this.id,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: version,
      createdAt: context.at,
    });
    this.#balance = balanceAfter;
    this.#version = version;
    this.#updatedAt = updatedAt;
    return entry;
  }
}
