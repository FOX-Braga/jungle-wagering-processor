import type { MoneyProps } from "../../domain/money/money";
import type { FailureCode } from "../../domain/shared/failure-code";
import type { Wallet } from "../../domain/wallet/wallet";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import { ApplicationError } from "../errors/application-error";
import type { PersistedWager, WagerResult } from "../ports/repositories/financial-repositories";

export interface WalletResult {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: MoneyProps;
  readonly version: number;
}

export interface ProcessWagerResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyProps;
  readonly walletVersion: number;
  readonly failureCode?: FailureCode;
  readonly referenceTransactionId?: string;
  readonly processedAt?: string;
  readonly idempotentReplay: boolean;
}

export interface WagerTransactionResult extends Omit<
  ProcessWagerResult,
  "idempotentReplay" | "balance" | "walletVersion"
> {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly balance?: MoneyProps;
  readonly walletVersion?: number;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function walletResult(wallet: Wallet): WalletResult {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
  };
}

export function walletSnapshot(wallet: Wallet): WagerResult {
  return { balance: wallet.balance, walletVersion: wallet.version };
}

function transactionOutcome(transaction: PersistedWager["transaction"]) {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
    ...(transaction.referenceTransactionId === undefined
      ? {}
      : { referenceTransactionId: transaction.referenceTransactionId }),
    ...(transaction.processedAt === undefined
      ? {}
      : { processedAt: transaction.processedAt.toISOString() }),
  };
}

export function processResult(
  record: PersistedWager,
  idempotentReplay: boolean,
): ProcessWagerResult {
  if (!record.result) {
    throw new ApplicationError(
      "HISTORICAL_RESULT_UNAVAILABLE",
      "The transaction has no persisted result snapshot",
    );
  }
  return {
    ...transactionOutcome(record.transaction),
    balance: record.result.balance.toJSON(),
    walletVersion: record.result.walletVersion,
    idempotentReplay,
  };
}

export function wagerTransactionResult(record: PersistedWager): WagerTransactionResult {
  const { transaction, result, updatedAt } = record;
  return {
    ...transactionOutcome(transaction),
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(result ? { balance: result.balance.toJSON(), walletVersion: result.walletVersion } : {}),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}
