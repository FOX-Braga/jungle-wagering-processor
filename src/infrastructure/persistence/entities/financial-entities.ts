import { EntitySchema } from "@mikro-orm/core";
import type { LedgerDirection } from "../../../domain/ledger/wallet-ledger-entry";
import type { FailureCode } from "../../../domain/shared/failure-code";
import type { JsonObject } from "../../../domain/shared/json";
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { ExactNumericType } from "../types/exact-numeric";
import { FiniteTimestampType } from "../types/finite-timestamp";

const text = { type: "string", columnType: "wagering.required_text" } as const;
const plainText = { type: "string", columnType: "text" } as const;
const date = { type: FiniteTimestampType } as const;
const currency = { type: "string", columnType: "wagering.currency_code" } as const;
const money = { type: ExactNumericType } as const;
const version = { type: "integer" } as const;

export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

const wallet = new EntitySchema<WalletRow>({
  class: WalletRow,
  schema: "wagering",
  tableName: "wallets",
  properties: {
    id: { ...text, primary: true },
    playerId: text,
    currency,
    balance: money,
    version,
    createdAt: date,
    updatedAt: date,
  },
});

export class WagerRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  status!: WagerTransactionStatus;
  amount!: string;
  currency!: string;
  requestedCurrency!: string | null;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: FailureCode | null;
  processedAt!: Date | null;
  resultBalance!: string | null;
  resultWalletVersion!: number | null;
  referenceAttempts?: number;
  referenceNextAttemptAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
}

const wager = new EntitySchema<WagerRow>({
  class: WagerRow,
  schema: "wagering",
  tableName: "wager_transactions",
  properties: {
    id: { ...text, primary: true },
    providerId: text,
    externalTransactionId: text,
    idempotencyKey: text,
    payloadHash: text,
    walletId: text,
    playerId: text,
    roundId: text,
    gameId: text,
    kind: plainText,
    status: plainText,
    amount: money,
    currency,
    requestedCurrency: { ...currency, nullable: true },
    referenceExternalTransactionId: { ...text, nullable: true },
    referenceTransactionId: { ...text, nullable: true },
    failureCode: { ...plainText, nullable: true },
    processedAt: { ...date, nullable: true },
    resultBalance: { ...money, nullable: true },
    resultWalletVersion: { ...version, nullable: true },
    referenceAttempts: { ...version, default: 0 },
    referenceNextAttemptAt: { ...date, nullable: true },
    createdAt: date,
    updatedAt: date,
  },
});

export class LedgerRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

const ledger = new EntitySchema<LedgerRow>({
  class: LedgerRow,
  schema: "wagering",
  tableName: "wallet_ledger_entries",
  properties: {
    id: { ...text, primary: true },
    walletId: text,
    transactionId: text,
    direction: plainText,
    amount: money,
    currency,
    balanceBefore: money,
    balanceAfter: money,
    walletVersion: version,
    createdAt: date,
  },
});

export class InboxRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

const inbox = new EntitySchema<InboxRow>({
  class: InboxRow,
  schema: "wagering",
  tableName: "inbox_messages",
  properties: {
    consumerName: { ...text, primary: true },
    messageId: { ...text, primary: true },
    payloadHash: text,
    receivedAt: date,
    processedAt: { ...date, nullable: true },
  },
});

export class OutboxRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: JsonObject;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  parkedAt!: Date | null;
  claimOwner!: string | null;
  claimUntil!: Date | null;
}

const outbox = new EntitySchema<OutboxRow>({
  class: OutboxRow,
  schema: "wagering",
  tableName: "outbox_messages",
  properties: {
    id: { ...text, primary: true },
    aggregateId: text,
    eventType: text,
    payload: { type: "json" },
    occurredAt: date,
    attempts: version,
    nextAttemptAt: { ...date, nullable: true },
    publishedAt: { ...date, nullable: true },
    parkedAt: { ...date, nullable: true },
    claimOwner: { ...text, nullable: true },
    claimUntil: { ...date, nullable: true },
  },
});

export const financialEntities = [wallet, wager, ledger, inbox, outbox];
