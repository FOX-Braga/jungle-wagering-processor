import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import type { Money } from "../../../domain/money/money";
import type { Wallet } from "../../../domain/wallet/wallet";
import type { WagerTransaction } from "../../../domain/wagering/wager-transaction";

export interface WalletRepository {
  insertBaseline(wallet: Wallet): Promise<void>;
  findById(walletId: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  lockById(walletId: string): Promise<Wallet | undefined>;
  saveMovement(wallet: Wallet, entry: WalletLedgerEntry): Promise<void>;
}

export interface WagerResult {
  readonly balance: Money;
  readonly walletVersion: number;
}

export interface WagerPersistenceDetails {
  readonly updatedAt: Date;
  readonly result?: WagerResult;
  readonly referenceAttempts?: number;
}

export interface PersistedWager extends WagerPersistenceDetails {
  readonly transaction: WagerTransaction;
  readonly referenceNextAttemptAt?: Date;
}

export interface PendingReferenceCandidate {
  readonly id: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly referenceAttempts: number;
  readonly createdAtMs?: number;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  readonly sourceMessageId?: string | null;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<PersistedWager | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWager | undefined>;
  findByIdempotencyKey(key: string): Promise<PersistedWager | undefined>;
  findPendingByReference(
    providerId: string,
    referenceExternalId: string,
    limit: number,
  ): Promise<PersistedWager[]>;
  findAppliedReversals(referenceId: string): Promise<WagerTransaction[]>;
  findDueReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  scheduleReferenceRetry(id: string, attempts: number, dueAt: Date): Promise<void>;
  insert(transaction: WagerTransaction, details?: WagerPersistenceDetails): Promise<void>;
  saveState(transaction: WagerTransaction, details: WagerPersistenceDetails): Promise<void>;
}

export interface LedgerAudit {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined>;
  findByWalletVersion(
    walletId: string,
    walletVersion: number,
  ): Promise<WalletLedgerEntry | undefined>;
  listByWallet(
    walletId: string,
    page: { limit: number; afterVersion?: number },
  ): Promise<WalletLedgerEntry[]>;
  auditBalance(walletId: string): Promise<LedgerAudit | undefined>;
}

export interface InboxRepository {
  find(
    consumerName: string,
    messageId: string,
    options?: { readonly forUpdate?: boolean },
  ): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
  saveProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxClaim {
  readonly owner: string;
  readonly until: Date;
}

export interface OutboxRepository {
  findById(id: string): Promise<OutboxMessage | undefined>;
  insert(message: OutboxMessage): Promise<void>;
  findDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  claimDue(
    now: Date,
    limit: number,
    claim: OutboxClaim,
    onRecovery?: () => void,
  ): Promise<OutboxMessage[]>;
  saveDelivery(message: OutboxMessage, claim?: OutboxClaim): Promise<boolean>;
}

export interface FinancialRepositories {
  readonly wallets: WalletRepository;
  readonly wagers: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}
