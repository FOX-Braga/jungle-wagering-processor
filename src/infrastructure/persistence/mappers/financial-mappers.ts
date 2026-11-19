import type {
  PersistedWager,
  WagerPersistenceDetails,
} from "../../../application/ports/repositories/financial-repositories";
import { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { CurrencyMismatchError } from "../../../domain/shared/domain-errors";
import { FailureCode } from "../../../domain/shared/failure-code";
import { Wallet } from "../../../domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import type {
  InboxRow,
  LedgerRow,
  OutboxRow,
  WagerRow,
  WalletRow,
} from "../entities/financial-entities";
import { fromStoredMoney, toStoredMoney } from "../types/exact-numeric";

export function walletBaseline(wallet: Wallet): WalletRow {
  if (wallet.version !== 1 || wallet.createdAt.getTime() !== wallet.updatedAt.getTime()) {
    throw new RangeError("A wallet baseline requires version one and the original timestamp");
  }
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: "0.00",
    version: 1,
    createdAt: wallet.createdAt,
    updatedAt: wallet.createdAt,
  };
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    balance: fromStoredMoney(row.balance, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function wagerState(
  transaction: WagerTransaction,
  details: WagerPersistenceDetails,
  snapshotCurrency = transaction.money.currency,
) {
  const result = details.result;
  if (result && result.balance.currency !== snapshotCurrency) {
    throw new CurrencyMismatchError(snapshotCurrency, result.balance.currency);
  }
  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    resultBalance: details.result ? toStoredMoney(details.result.balance) : null,
    resultWalletVersion: details.result?.walletVersion ?? null,
    updatedAt: details.updatedAt,
  };
}

export function wagerRow(
  transaction: WagerTransaction,
  details: WagerPersistenceDetails,
): WagerRow {
  const requestedCurrency = transaction.money.currency;
  const currency =
    transaction.status === WagerTransactionStatus.Rejected &&
    transaction.failureCode === FailureCode.CurrencyMismatch
      ? (details.result?.balance.currency ?? requestedCurrency)
      : requestedCurrency;
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: toStoredMoney(transaction.money),
    currency,
    requestedCurrency: currency === requestedCurrency ? null : requestedCurrency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    createdAt: transaction.createdAt,
    ...wagerState(transaction, details, currency),
  };
}

export function toWager(row: WagerRow): PersistedWager {
  const transaction = WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    status: row.status,
    money: fromStoredMoney(row.amount, row.requestedCurrency ?? row.currency),
    createdAt: row.createdAt,
    ...(row.referenceExternalTransactionId
      ? { referenceExternalTransactionId: row.referenceExternalTransactionId }
      : {}),
    ...(row.referenceTransactionId ? { referenceTransactionId: row.referenceTransactionId } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
    ...(row.processedAt ? { processedAt: row.processedAt } : {}),
  });
  return {
    transaction,
    updatedAt: row.updatedAt,
    referenceAttempts: row.referenceAttempts ?? 0,
    ...(row.referenceNextAttemptAt ? { referenceNextAttemptAt: row.referenceNextAttemptAt } : {}),
    ...(row.resultBalance !== null && row.resultWalletVersion !== null
      ? {
          result: {
            balance: fromStoredMoney(row.resultBalance, row.currency),
            walletVersion: row.resultWalletVersion,
          },
        }
      : {}),
  };
}

export function ledgerRow(entry: WalletLedgerEntry): LedgerRow {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    walletId: entry.walletId,
    direction: entry.direction,
    amount: toStoredMoney(entry.money),
    currency: entry.money.currency,
    balanceBefore: toStoredMoney(entry.balanceBefore),
    balanceAfter: toStoredMoney(entry.balanceAfter),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function toLedger(row: LedgerRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    transactionId: row.transactionId,
    walletId: row.walletId,
    direction: row.direction,
    money: fromStoredMoney(row.amount, row.currency),
    balanceBefore: fromStoredMoney(row.balanceBefore, row.currency),
    balanceAfter: fromStoredMoney(row.balanceAfter, row.currency),
    walletVersion: row.walletVersion,
    createdAt: row.createdAt,
  });
}

export function inboxRow(message: InboxMessage): InboxRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toInbox(row: InboxRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    ...(row.processedAt ? { processedAt: row.processedAt } : {}),
  });
}

export function outboxDelivery(message: OutboxMessage) {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
    parkedAt: message.parkedAt ?? null,
    claimOwner: null,
    claimUntil: null,
  };
}

export function outboxRow(message: OutboxMessage): OutboxRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: structuredClone(message.payload),
    occurredAt: message.occurredAt,
    ...outboxDelivery(message),
  };
}

export function toOutbox(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}),
    ...(row.parkedAt ? { parkedAt: row.parkedAt } : {}),
  });
}
