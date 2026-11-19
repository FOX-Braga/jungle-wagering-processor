import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { OutboxClaim } from "../../application/ports/repositories/financial-repositories";
import type { TransactionManager } from "../../application/ports/transaction-manager";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { JsonObject } from "../../domain/shared/json";
import type { AppConfig } from "../config/environment";
import { poll, type WorkerContext } from "./worker-loop";

const sendTimeoutMs = 3_000;
const retryPolicy = { baseDelayMs: 1_000, maxDelayMs: 60_000 };

export class OutboxPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly transactions: TransactionManager,
    private readonly config: AppConfig,
    private readonly context: WorkerContext,
  ) {}

  run(signal: AbortSignal): Promise<void> {
    return poll(
      async () => (await this.publishBatch()) > 0,
      signal,
      this.config.OUTBOX_POLL_INTERVAL_MS,
      (attempt) => this.log("warn", { result: "outbox_poll_failed", attempt }),
    );
  }

  async publishBatch(): Promise<number> {
    const now = new Date();
    const claim = {
      owner: crypto.randomUUID(),
      until: new Date(now.getTime() + this.config.OUTBOX_LEASE_SECONDS * 1000),
    };
    const messages = await this.transactions.execute(({ outbox }) =>
      outbox.claimDue(now, this.config.OUTBOX_BATCH_SIZE, claim),
    );
    const completed = await Promise.allSettled(
      messages.map((message) => this.publish(message, claim)),
    );
    if (completed.some(({ status }) => status === "rejected")) {
      throw new Error("Could not record outbox delivery");
    }
    return messages.length;
  }

  private async publish(message: OutboxMessage, claim: OutboxClaim): Promise<void> {
    const started = Date.now();
    const data = message.payload.data;
    const identifiers =
      data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject) : undefined;
    const details = {
      eventId: message.id,
      eventType: message.eventType,
      aggregateId: message.aggregateId,
      correlationId: message.payload.correlationId,
      causationId: message.payload.causationId,
      walletId: typeof identifiers?.walletId === "string" ? identifiers.walletId : undefined,
      providerId: typeof identifiers?.providerId === "string" ? identifiers.providerId : undefined,
      transactionId:
        typeof identifiers?.transactionId === "string" ? identifiers.transactionId : undefined,
      attempt: message.attempts + 1,
      lagMs: started - message.occurredAt.getTime(),
    };
    if (claim.until.getTime() - started < sendTimeoutMs) {
      this.log("warn", { ...details, result: "outbox_lease_too_short" });
      return;
    }
    let accepted = false;
    try {
      const reply = await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.config.SQS_EVENT_QUEUE_URL,
          MessageBody: JSON.stringify(message.payload),
        }),
        { abortSignal: AbortSignal.timeout(sendTimeoutMs) },
      );
      accepted = Boolean(reply.MessageId);
    } catch {
      // An ambiguous response is retried with the same persisted eventId.
    }
    const at = new Date(
      Math.max(Date.now(), message.nextAttemptAt?.getTime() ?? message.occurredAt.getTime()),
    );
    if (accepted) message.markPublished(at);
    else message.scheduleRetry(at, retryPolicy, this.config.OUTBOX_MAX_ATTEMPTS);

    const saved = await this.transactions.execute(({ outbox }) =>
      outbox.saveDelivery(message, claim),
    );
    const result = !saved
      ? "outbox_lease_lost"
      : accepted
        ? "published"
        : message.parkedAt
          ? "outbox_parked"
          : "outbox_retry";
    this.log(saved && accepted ? "log" : "warn", {
      ...details,
      result,
      durationMs: Date.now() - started,
    });
  }

  private log(level: "log" | "warn", fields: object): void {
    this.context.logger[level](
      { ...fields, workerInstanceId: this.context.workerInstanceId },
      "OutboxPublisher",
    );
  }
}
