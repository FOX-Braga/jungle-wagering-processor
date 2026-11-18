import type { IntegrationEvent } from "../events/integration-event";
import { DomainInvariantError, DomainUsageError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { jsonSnapshot, type JsonObject } from "../shared/json";
import { timestamp } from "../shared/validation";

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: JsonObject;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date;
  readonly publishedAt?: Date;
}

interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

const retryDefaults: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export class OutboxMessage {
  readonly #occurredAt: number;
  readonly payload: JsonObject;
  #attempts: number;
  #nextAttemptAt: number | undefined;
  #publishedAt: number | undefined;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    state: OutboxMessageState,
  ) {
    this.payload = jsonSnapshot(state.payload);
    this.#occurredAt = state.occurredAt.getTime();
    this.#attempts = state.attempts;
    this.#nextAttemptAt = state.nextAttemptAt?.getTime();
    this.#publishedAt = state.publishedAt?.getTime();
    Object.freeze(this);
  }

  static enqueue(event: IntegrationEvent<JsonObject>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      payload: event.toJSON(),
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType, state);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }
  get attempts(): number {
    return this.#attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this.#nextAttemptAt === undefined ? undefined : new Date(this.#nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this.#publishedAt === undefined ? undefined : new Date(this.#publishedAt);
  }

  isPending(): boolean {
    return this.#publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && timestamp(now, FailureCode.InvalidMessage) >= this.readyAt();
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.#publishedAt = timestamp(at, FailureCode.InvalidMessage, this.readyAt());
    this.#nextAttemptAt = undefined;
  }

  scheduleRetry(now: Date, policy: RetryPolicy = retryDefaults): void {
    this.assertPending();
    const startedAt = timestamp(now, FailureCode.InvalidMessage, this.readyAt());
    const { baseDelayMs, maxDelayMs } = policy;
    const attempts = this.#attempts + 1;
    if (
      !Number.isSafeInteger(baseDelayMs) ||
      !Number.isSafeInteger(maxDelayMs) ||
      baseDelayMs < 1 ||
      maxDelayMs < baseDelayMs ||
      !Number.isSafeInteger(attempts)
    ) {
      throw new DomainInvariantError(
        FailureCode.InvalidMessage,
        "Invalid retry policy or attempt count",
      );
    }
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** this.#attempts);
    const scheduledAt = timestamp(new Date(startedAt + delay), FailureCode.InvalidMessage);
    this.#attempts = attempts;
    this.#nextAttemptAt = scheduledAt;
  }

  private readyAt(): number {
    return this.#nextAttemptAt ?? this.#occurredAt;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new DomainUsageError(
        FailureCode.InvalidMessageState,
        "Outbox message is already published",
      );
    }
  }
}
