import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { ProcessWagerCommand } from "../../application/commands/financial-commands";
import { ApplicationError } from "../../application/errors/application-error";
import {
  PersistenceConflictError,
  PersistenceUnavailableError,
} from "../../application/ports/transaction-manager";
import type { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { AppConfig } from "../config/environment";
import { observeWager } from "../observability/wager-observation";
import { InvalidWagerMessage, parseWagerMessage } from "./wager-message";
import { pause, poll, retryDelay, type WorkerContext } from "./worker-loop";

export function classifyWagerFailure(error: unknown) {
  if (error instanceof InvalidWagerMessage) return { permanent: true, code: error.message };
  if (error instanceof ApplicationError) return { permanent: true, code: error.code };
  if (error instanceof PersistenceConflictError) return { permanent: false, code: error.reason };
  if (error instanceof PersistenceUnavailableError)
    return { permanent: false, code: "DATABASE_UNAVAILABLE" };
  return { permanent: false, code: "PROCESSING_ERROR" };
}

export class WagerConsumer {
  private inFlight = 0;

  constructor(
    private readonly client: SQSClient,
    private readonly processor: Pick<ProcessWagerTransactionUseCase, "execute">,
    private readonly config: AppConfig,
    private readonly context: WorkerContext,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const { SQS_CONSUMER_CONCURRENCY: capacity, SQS_CONSUMER_BATCH_SIZE: batchSize } = this.config;
    await Promise.all(
      Array.from({ length: Math.ceil(capacity / batchSize) }, (_, index) =>
        poll(
          async () => {
            const started = performance.now();
            const { Messages } = await this.client
              .send(
                new ReceiveMessageCommand({
                  QueueUrl: this.config.SQS_WAGER_QUEUE_URL,
                  MaxNumberOfMessages: Math.min(batchSize, capacity - index * batchSize),
                  WaitTimeSeconds: this.config.SQS_POLL_WAIT_SECONDS,
                  VisibilityTimeout: this.config.SQS_VISIBILITY_TIMEOUT_SECONDS,
                  MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
                }),
                {
                  abortSignal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout((this.config.SQS_POLL_WAIT_SECONDS + 5) * 1000),
                  ]),
                },
              )
              .finally(() =>
                this.context.metrics?.record(
                  "wager_sqs_poll_duration_seconds",
                  (performance.now() - started) / 1000,
                ),
              );
            if (!Messages?.length) return false;
            await this.processBatch(Messages, signal);
            return true;
          },
          signal,
          250,
          (attempt) =>
            this.log("warn", { result: "poll_failed", attempt, code: "SQS_POLL_FAILED" }),
          this.context.metrics,
          true,
        ),
      ),
    );
  }

  private async processBatch(messages: Message[], signal: AbortSignal): Promise<void> {
    const groups = new Map<string, ReturnType<WagerConsumer["lease"]>[]>();
    this.context.metrics?.record("wager_sqs_events_total", messages.length, "received");
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? "";
      const entries = groups.get(group) ?? [];
      entries.push(this.lease(message));
      groups.set(group, entries);
    }
    await Promise.all(
      [...groups.values()].map(async (entries) => {
        let deferFor: number | undefined;
        for (const entry of entries) {
          try {
            if (signal.aborted || deferFor !== undefined) {
              await entry.stop();
              if (entry.message.ReceiptHandle)
                await this.setVisibility(
                  entry.message.ReceiptHandle,
                  deferFor ?? 0,
                  entry.transport,
                );
              this.log("log", { ...entry.transport, result: "deferred" });
              continue;
            }
            const started = performance.now();
            this.inFlight++;
            this.context.metrics?.record("wager_sqs_in_flight", this.inFlight);
            try {
              deferFor = await this.handle(entry, started);
            } finally {
              this.inFlight--;
              this.context.metrics?.record("wager_sqs_in_flight", this.inFlight);
              this.context.metrics?.record(
                "wager_sqs_processing_duration_seconds",
                (performance.now() - started) / 1000,
              );
            }
          } finally {
            await entry.stop();
          }
        }
      }),
    );
  }

  private lease(message: Message) {
    const count = Number(message.Attributes?.ApproximateReceiveCount);
    const attempt = Number.isSafeInteger(count) && count > 0 ? count : 1;
    const transport = {
      transportMessageId: message.MessageId,
      messageId: message.MessageId,
      correlationId: message.MessageId,
      receiveCount: attempt,
      attempt,
    };
    const abort = new AbortController();
    const heartbeat = message.ReceiptHandle
      ? this.heartbeat(message.ReceiptHandle, abort.signal, transport)
      : undefined;
    return {
      message,
      transport,
      stop: async () => {
        abort.abort();
        await heartbeat;
      },
    };
  }

  private async handle(
    { message, transport, stop }: ReturnType<WagerConsumer["lease"]>,
    started: number,
  ): Promise<number | undefined> {
    const { attempt } = transport;
    const receipt = message.ReceiptHandle;
    if (!receipt) {
      this.log("warn", {
        ...transport,
        result: "missing_receipt",
        code: "SQS_MISSING_RECEIPT",
      });
      return this.config.SQS_VISIBILITY_TIMEOUT_SECONDS;
    }

    let result: Awaited<ReturnType<ProcessWagerTransactionUseCase["execute"]>>;
    try {
      const command = parseWagerMessage(message.Body, this.config.SQS_CONSUMER_NAME);
      Object.assign(transport, this.trace(command));
      result = await observeWager(this.context.metrics, "sqs", () =>
        this.processor.execute(command),
      );
    } catch (error) {
      await stop();
      const { permanent, code } = classifyWagerFailure(error);
      const exhausts = attempt >= this.config.SQS_MAX_RECEIVE_COUNT;
      const delay = permanent || exhausts ? 0 : retryDelay(attempt, 1, 30);
      if (!permanent && !exhausts)
        this.context.metrics?.record("wager_processing_retries_total", 1, "sqs");
      const scheduled = await this.setVisibility(receipt, delay, transport);
      this.log("warn", {
        ...transport,
        code,
        durationMs: Math.round(performance.now() - started),
        delaySeconds: delay,
        result: exhausts ? "awaiting_dlq" : permanent ? "permanent_failure" : "retry",
      });
      return scheduled ? delay : this.config.SQS_VISIBILITY_TIMEOUT_SECONDS;
    }

    const details = {
      ...transport,
      transactionId: result.transactionId,
      status: result.status,
      code: result.failureCode,
      durationMs: Math.round(performance.now() - started),
    };
    this.context.metrics?.record("wager_sqs_events_total", 1, "processed");
    if (result.status === WagerTransactionStatus.Rejected)
      this.context.metrics?.record("wager_sqs_events_total", 1, "rejected");
    if (result.idempotentReplay)
      this.context.metrics?.record("wager_sqs_events_total", 1, "duplicate");
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.SQS_WAGER_QUEUE_URL,
          ReceiptHandle: receipt,
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      this.context.metrics?.record("wager_sqs_events_total", 1, "acknowledged");
      this.log("log", {
        ...details,
        result: result.idempotentReplay ? "duplicate" : "acknowledged",
      });
      return undefined;
    } catch {
      this.log("warn", { ...details, code: "SQS_ACK_FAILED", result: "ack_failed" });
      return this.config.SQS_VISIBILITY_TIMEOUT_SECONDS;
    }
  }

  private async heartbeat(receipt: string, signal: AbortSignal, trace: object): Promise<void> {
    const interval = this.config.SQS_VISIBILITY_TIMEOUT_SECONDS * 500;
    const deadline = performance.now() + 5 * 60_000;
    while (!signal.aborted && performance.now() + interval < deadline) {
      await pause(interval, signal);
      if (signal.aborted) break;
      try {
        await this.changeVisibility(receipt, this.config.SQS_VISIBILITY_TIMEOUT_SECONDS, signal);
      } catch {
        if (!signal.aborted)
          this.log("warn", {
            ...trace,
            code: "SQS_VISIBILITY_FAILED",
            result: "visibility_extension_failed",
          });
        break;
      }
    }
  }

  private async setVisibility(receipt: string, delay: number, transport: object): Promise<boolean> {
    try {
      await this.changeVisibility(receipt, delay);
      return true;
    } catch {
      this.log("warn", {
        ...transport,
        code: "SQS_VISIBILITY_FAILED",
        result: "visibility_change_failed",
      });
      return false;
    }
  }

  private async changeVisibility(
    receipt: string,
    seconds: number,
    stop?: AbortSignal,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(
      Math.min(3_000, this.config.SQS_VISIBILITY_TIMEOUT_SECONDS * 400),
    );
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.config.SQS_WAGER_QUEUE_URL,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
      { abortSignal: stop ? AbortSignal.any([stop, timeout]) : timeout },
    );
  }

  private trace(command: ProcessWagerCommand) {
    return {
      messageId: command.inbox?.messageId,
      walletId: command.walletId,
      providerId: command.providerId,
      correlationId: command.correlationId,
      causationId: command.causationId ?? command.inbox?.messageId,
      operation: command.kind,
    };
  }

  private log(level: "log" | "warn", fields: { result: string } & Record<string, unknown>): void {
    if (fields.result !== "duplicate" && fields.result !== "acknowledged") {
      this.context.metrics?.record("wager_sqs_events_total", 1, fields.result);
    }
    if (["awaiting_dlq", "permanent_failure", "retry", "missing_receipt"].includes(fields.result)) {
      this.context.metrics?.record("wager_sqs_events_total", 1, "failed");
    }
    this.context.logger[level](
      {
        ...fields,
        event: `sqs.message.${fields.result}`,
        instanceId: this.context.workerInstanceId,
        workerType: "consumer",
        consumerName: this.config.SQS_CONSUMER_NAME,
        workerInstanceId: this.context.workerInstanceId,
      },
      "SqsWagerConsumer",
    );
  }
}
