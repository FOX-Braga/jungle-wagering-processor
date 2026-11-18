import { LedgerDirection, type WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import {
  BusinessRuleError,
  CurrencyMismatchError,
  DomainInvariantError,
  DomainUsageError,
  InvalidTransactionStateError,
} from "../shared/domain-errors";
import { FailureCode, type RejectionCode } from "../shared/failure-code";
import { requireFields, timestamp } from "../shared/validation";
import type { Wallet } from "../wallet/wallet";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

const Kind = WagerTransactionKind;
const Status = WagerTransactionStatus;
const invalidTransaction = FailureCode.InvalidTransaction;
const transitions: Record<WagerTransactionStatus, readonly WagerTransactionStatus[]> = {
  [Status.Pending]: [Status.PendingReference, Status.Processed, Status.Rejected, Status.Failed],
  [Status.PendingReference]: [Status.Processed, Status.Rejected, Status.Failed],
  [Status.Processed]: [],
  [Status.Rejected]: [],
  [Status.Failed]: [],
};

export interface WagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends WagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string;
  readonly failureCode?: FailureCode;
  readonly processedAt?: Date;
}

interface WagerApplicationContext {
  readonly at: Date;
  readonly ledgerEntryId: string;
  readonly reference?: WagerTransaction;
  readonly appliedReversals: readonly WagerTransaction[];
}

type WagerApplicationResult =
  | { readonly status: WagerTransactionStatus.PendingReference }
  | { readonly status: WagerTransactionStatus.Rejected; readonly failureCode: RejectionCode }
  | {
      readonly status: WagerTransactionStatus.Processed;
      readonly ledgerEntry: WalletLedgerEntry | undefined;
    };

export class WagerTransaction {
  readonly #props: Omit<WagerTransactionProps, "createdAt">;
  readonly #createdAt: number;
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAt: number | undefined;

  private constructor(state: WagerTransactionState) {
    const { createdAt, status, referenceTransactionId, failureCode, processedAt, ...props } = state;
    this.#props = Object.freeze(props);
    this.#createdAt = createdAt.getTime();
    this.#status = status;
    this.#referenceTransactionId = referenceTransactionId;
    this.#failureCode = failureCode;
    this.#processedAt = processedAt?.getTime();
    Object.freeze(this);
  }

  static create(props: WagerTransactionProps): WagerTransaction {
    if (props.kind === Kind.Opening) {
      throw new DomainUsageError(
        invalidTransaction,
        "OPENING must use the internal wallet-opening factory",
      );
    }
    return WagerTransaction.createPending(props);
  }

  static createOpening(
    props: Omit<WagerTransactionProps, "kind" | "referenceExternalTransactionId">,
  ): WagerTransaction {
    return WagerTransaction.createPending({ ...props, kind: Kind.Opening });
  }

  private static createPending(props: WagerTransactionProps): WagerTransaction {
    const { kind, money, createdAt, referenceExternalTransactionId, ...fields } = props;
    requireFields(invalidTransaction, fields);
    timestamp(createdAt, invalidTransaction);
    if (
      !Object.values(Kind).includes(kind) ||
      !(money instanceof Money) ||
      money.isNegative() ||
      (kind !== Kind.Loss && money.isZero())
    ) {
      throw new DomainInvariantError(invalidTransaction, "Invalid wager kind or amount");
    }
    const transaction = WagerTransaction.rehydrate({ ...props, status: Status.Pending });
    if (referenceExternalTransactionId !== undefined) {
      requireFields(invalidTransaction, { referenceExternalTransactionId });
      if (
        (!transaction.requiresReference() && kind !== Kind.Win) ||
        referenceExternalTransactionId === props.externalTransactionId
      ) {
        throw new DomainInvariantError(invalidTransaction, "Unexpected or self-referencing wager");
      }
    } else if (transaction.requiresReference()) {
      throw new DomainInvariantError(invalidTransaction, "An external reference is required");
    }
    return transaction;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get id(): string {
    return this.#props.id;
  }
  get providerId(): string {
    return this.#props.providerId;
  }
  get externalTransactionId(): string {
    return this.#props.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.#props.idempotencyKey;
  }
  get payloadHash(): string {
    return this.#props.payloadHash;
  }
  get walletId(): string {
    return this.#props.walletId;
  }
  get playerId(): string {
    return this.#props.playerId;
  }
  get roundId(): string {
    return this.#props.roundId;
  }
  get gameId(): string {
    return this.#props.gameId;
  }
  get kind(): WagerTransactionKind {
    return this.#props.kind;
  }
  get money(): Money {
    return this.#props.money;
  }
  get referenceExternalTransactionId(): string | undefined {
    return this.#props.referenceExternalTransactionId;
  }
  get createdAt(): Date {
    return new Date(this.#createdAt);
  }
  get status(): WagerTransactionStatus {
    return this.#status;
  }
  get referenceTransactionId(): string | undefined {
    return this.#referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this.#failureCode;
  }
  get processedAt(): Date | undefined {
    return this.#processedAt === undefined ? undefined : new Date(this.#processedAt);
  }

  isTerminal(): boolean {
    return transitions[this.#status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== Kind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === Kind.Refund || this.kind === Kind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertTransition(Status.PendingReference);
    if (!this.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError(this.#status, Status.PendingReference);
    }
    this.#status = Status.PendingReference;
  }

  markProcessed(reference: WagerTransaction | undefined, at: Date): void {
    this.assertTransition(Status.Processed);
    const processedAt = timestamp(at, invalidTransaction, this.#createdAt);
    if (!this.referenceReady(reference)) {
      if (reference)
        throw new DomainUsageError(FailureCode.ReferenceNotReady, "Reference is still pending");
      throw new BusinessRuleError(FailureCode.ReferenceNotFound, "Reference is missing");
    }
    this.finishProcessed(reference, processedAt);
  }

  reject(code: RejectionCode): void {
    this.assertTransition(Status.Rejected);
    this.#failureCode = code;
    this.#status = Status.Rejected;
  }

  fail(code: FailureCode.ProcessingFailed): void {
    this.assertTransition(Status.Failed);
    this.#failureCode = code;
    this.#status = Status.Failed;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case Kind.Loss:
        return undefined;
      case Kind.Bet:
        return LedgerDirection.Debit;
      case Kind.Win:
      case Kind.Refund:
      case Kind.Opening:
        return LedgerDirection.Credit;
      case Kind.Rollback:
        if (!reference)
          throw new BusinessRuleError(
            FailureCode.ReferenceNotFound,
            "Rollback reference is missing",
          );
        if (reference.kind === Kind.Bet) return LedgerDirection.Credit;
        if (reference.kind === Kind.Win || reference.kind === Kind.Refund)
          return LedgerDirection.Debit;
        throw new BusinessRuleError(
          FailureCode.ReferenceTypeNotAllowed,
          "Rollback reference must be a BET, WIN or REFUND",
        );
    }
  }

  apply(wallet: Wallet, context: WagerApplicationContext): WagerApplicationResult {
    this.assertTransition(Status.Processed);
    if (this.kind === Kind.Opening) {
      throw new DomainUsageError(
        invalidTransaction,
        "OPENING is applied when the wallet is opened",
      );
    }
    const processedAt = timestamp(context.at, invalidTransaction, this.#createdAt);
    const reference = context.reference;

    try {
      this.assertWallet(wallet);
      if (!this.referenceReady(reference)) {
        if (this.#status === Status.Pending) this.markPendingReference();
        return { status: Status.PendingReference };
      }
      if (reference && this.requiresReference()) {
        this.assertNotReversed(reference, context.appliedReversals);
      }

      const movement = {
        ledgerEntryId: context.ledgerEntryId,
        transactionId: this.id,
        at: context.at,
      };
      const direction = this.ledgerDirectionFor(reference);
      let entry: WalletLedgerEntry | undefined;
      if (direction === LedgerDirection.Debit) entry = wallet.debit(this.money, movement);
      if (direction === LedgerDirection.Credit) entry = wallet.credit(this.money, movement);
      this.finishProcessed(reference, processedAt);
      return { status: Status.Processed, ledgerEntry: entry };
    } catch (error) {
      if (!(error instanceof BusinessRuleError)) throw error;
      const failureCode =
        this.kind === Kind.Rollback && error.code === FailureCode.InsufficientFunds
          ? FailureCode.ReversalInsufficientFunds
          : error.code;
      this.reject(failureCode);
      return { status: Status.Rejected, failureCode };
    }
  }

  private assertWallet(wallet: Wallet): void {
    if (wallet.id !== this.walletId || wallet.playerId !== this.playerId) {
      throw new BusinessRuleError(
        FailureCode.WalletMismatch,
        "Wager does not belong to the given wallet",
      );
    }
    if (wallet.currency !== this.money.currency) {
      throw new CurrencyMismatchError(wallet.currency, this.money.currency);
    }
  }

  private referenceReady(reference: WagerTransaction | undefined): boolean {
    if (!this.referenceExternalTransactionId) {
      if (reference)
        throw new BusinessRuleError(FailureCode.InvalidReference, "Unexpected reference");
      return true;
    }
    if (!reference) return false;
    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId
    ) {
      throw new BusinessRuleError(
        FailureCode.InvalidReference,
        "Reference does not match the wager identity",
      );
    }
    if (this.money.currency !== reference.money.currency) {
      throw new CurrencyMismatchError(this.money.currency, reference.money.currency);
    }
    const allowed = this.kind === Kind.Rollback ? [Kind.Bet, Kind.Win, Kind.Refund] : [Kind.Bet];
    if (!allowed.includes(reference.kind)) {
      throw new BusinessRuleError(
        FailureCode.ReferenceTypeNotAllowed,
        "Reference kind is not allowed",
      );
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new BusinessRuleError(
        FailureCode.AmountMismatch,
        "A reversal must match the full original amount",
      );
    }
    if (!reference.isTerminal()) return false;
    if (reference.status !== Status.Processed) {
      throw new BusinessRuleError(
        FailureCode.InvalidReference,
        "Reference did not process successfully",
      );
    }
    return true;
  }

  private assertNotReversed(
    reference: WagerTransaction,
    applied: readonly WagerTransaction[],
  ): void {
    const blocked = applied.some(
      (transaction) =>
        transaction.status === Status.Processed &&
        transaction.referenceTransactionId === reference.id &&
        (transaction.kind === this.kind ||
          (reference.kind === Kind.Bet && transaction.requiresReference())),
    );
    if (blocked)
      throw new BusinessRuleError(
        FailureCode.AlreadyReversed,
        "Reference has already been reversed",
      );
  }

  private finishProcessed(reference: WagerTransaction | undefined, processedAt: number): void {
    this.#referenceTransactionId = reference?.id;
    this.#processedAt = processedAt;
    this.#status = Status.Processed;
  }

  private assertTransition(next: WagerTransactionStatus): void {
    if (!transitions[this.#status].includes(next)) {
      throw new InvalidTransactionStateError(this.#status, next);
    }
  }
}
