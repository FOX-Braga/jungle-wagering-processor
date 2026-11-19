import { DomainUsageError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { requireFields, timestamp } from "../shared/validation";

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date;
  readonly transactionId?: string;
}

export class InboxMessage {
  readonly #receivedAt: number;
  #processedAt: number | undefined;
  #transactionId: string | undefined;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
    transactionId?: string,
  ) {
    this.#receivedAt = receivedAt.getTime();
    this.#processedAt = processedAt?.getTime();
    this.#transactionId = transactionId;
    Object.freeze(this);
  }

  static receive({
    messageId,
    consumerName,
    payloadHash,
    receivedAt,
  }: ReceiveInboxProps): InboxMessage {
    requireFields(FailureCode.InvalidMessage, { messageId, consumerName, payloadHash });
    timestamp(receivedAt, FailureCode.InvalidMessage);
    return new InboxMessage(messageId, consumerName, payloadHash, receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
      state.transactionId,
    );
  }

  get receivedAt(): Date {
    return new Date(this.#receivedAt);
  }

  get processedAt(): Date | undefined {
    return this.#processedAt === undefined ? undefined : new Date(this.#processedAt);
  }

  isProcessed(): boolean {
    return this.#processedAt !== undefined;
  }

  get transactionId(): string | undefined {
    return this.#transactionId;
  }

  markProcessed(at: Date, transactionId?: string): void {
    if (this.isProcessed()) {
      throw new DomainUsageError(
        FailureCode.InvalidMessageState,
        "Inbox message is already processed",
      );
    }
    if (transactionId !== undefined)
      requireFields(FailureCode.InvalidMessageState, { transactionId });
    this.#processedAt = timestamp(at, FailureCode.InvalidMessage, this.#receivedAt);
    this.#transactionId = transactionId;
  }
}
