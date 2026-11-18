import { DomainInvariantError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { timestamp } from "../shared/validation";
import {
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "../wagering/wager-transaction";
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from "./integration-event";

function wagerData(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
type WagerData = ReturnType<typeof wagerData>;
type ProcessedData = WagerData & { readonly referenceTransactionId?: string };
type RejectedData = WagerData & { readonly failureCode: FailureCode };
type PendingReferenceData = WagerData & { readonly referenceExternalTransactionId: string };

export class WagerTransactionProcessed extends IntegrationEvent<ProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<ProcessedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    const occurredAt = transaction.processedAt;
    if (transaction.status !== Status.Processed || !occurredAt) {
      throw new DomainInvariantError(FailureCode.InvalidEvent, "Transaction must be processed");
    }
    const reference = transaction.referenceTransactionId;
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt,
      data: {
        ...wagerData(transaction),
        ...(reference === undefined ? {} : { referenceTransactionId: reference }),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<RejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<RejectedData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
    at: Date,
  ): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    if (transaction.status !== Status.Rejected || !failureCode) {
      throw new DomainInvariantError(FailureCode.InvalidEvent, "Transaction must be rejected");
    }
    timestamp(at, FailureCode.InvalidEvent, transaction.createdAt.getTime());
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt: at,
      data: { ...wagerData(transaction), failureCode },
    });
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<PendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<PendingReferenceData>) {
    super(props);
    Object.freeze(this);
  }

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
    at: Date,
  ): WagerTransactionPendingReference {
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (transaction.status !== Status.PendingReference || !referenceExternalTransactionId) {
      throw new DomainInvariantError(
        FailureCode.InvalidEvent,
        "Transaction must be waiting for a reference",
      );
    }
    timestamp(at, FailureCode.InvalidEvent, transaction.createdAt.getTime());
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      occurredAt: at,
      data: { ...wagerData(transaction), referenceExternalTransactionId },
    });
  }
}
