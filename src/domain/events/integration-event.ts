import { FailureCode } from "../shared/failure-code";
import { jsonSnapshot, type JsonObject } from "../shared/json";
import { requireFields, timestamp } from "../shared/validation";

export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly sourceMessageId?: string;
}

export interface IntegrationEventProps<T extends JsonObject> extends EventContext {
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly data: T;
}

export interface IntegrationEventEnvelope<T extends JsonObject> extends EventContext, JsonObject {
  readonly eventType: string;
  readonly version: number;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly data: Readonly<T>;
}

export abstract class IntegrationEvent<T extends JsonObject> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly sourceMessageId: string | undefined;
  readonly data: Readonly<T>;
  readonly #occurredAt: number;

  protected constructor(props: IntegrationEventProps<T>) {
    const { eventId, aggregateId, correlationId, causationId, sourceMessageId } = props;
    requireFields(FailureCode.InvalidEvent, {
      eventId,
      aggregateId,
      correlationId,
      ...(causationId !== undefined ? { causationId } : {}),
      ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    });
    this.eventId = eventId;
    this.aggregateId = aggregateId;
    this.correlationId = correlationId;
    this.causationId = causationId;
    this.sourceMessageId = sourceMessageId;
    this.#occurredAt = timestamp(props.occurredAt, FailureCode.InvalidEvent);
    this.data = jsonSnapshot(props.data);
  }

  get occurredAt(): Date {
    return new Date(this.#occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return Object.freeze({
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      ...(this.sourceMessageId === undefined ? {} : { sourceMessageId: this.sourceMessageId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    });
  }
}
