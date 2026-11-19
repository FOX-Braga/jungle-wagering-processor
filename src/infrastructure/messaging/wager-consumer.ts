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
import type { AppConfig } from "../config/environment";
import { InvalidWagerMessage, parseWagerMessage } from "./wager-message";
import { pause, poll, retryDelay, type WorkerContext } from "./worker-loop";

function classify(error: unknown) {
  if (error instanceof InvalidWagerMessage) return { permanent: true, code: error.message };
  if (error instanceof ApplicationError) return { permanent: true, code: error.code };
  if (error instanceof PersistenceConflictError) return { permanent: false, code: error.reason };
  if (error instanceof PersistenceUnavailableError)
    return { permanent: false, code: "DATABASE_UNAVAILABLE" };
  return { permanent: false, code: "PROCESSING_ERROR" };
}

export class WagerConsumer {
  constructor(
    private readonly client: SQSClient,
    private readonly processor: Pick<ProcessWagerTransactionUseCase, "execute">,
    private readonly config: AppConfig,
    private readonly context: WorkerContext,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    await Promise.all(
      Array.from({ length: this.config.SQS_CONSUMER_CONCURRENCY }, () =>
        poll(
          async () => {
            const { Messages } = await this.client.send(
              new ReceiveMessageCommand({
                QueueUrl: this.config.SQS_WAGER_QUEUE_URL,
                MaxNumberOfMessages: 1,
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
            );
            const message = Messages?.[0];
            if (message) {
              if (signal.aborted && message.ReceiptHandle)
                await this.changeVisibility(message.ReceiptHandle, 0);
              else if (!signal.aborted) await this.handle(message);
            }
            return Boolean(message);
          },
          signal,
          250,
          (attempt) => this.log("warn", { result: "poll_failed", attempt }),
        ),
      ),
    );
  }

  private async handle(message: Message): Promise<void> {
    const started = performance.now();
    const attempt = Number(message.Attributes?.ApproximateReceiveCount) || 1;
    const receipt = message.ReceiptHandle;
    const transport = { transportMessageId: message.MessageId, attempt };
    if (!receipt) {
      this.log("warn", { ...transport, result: "missing_receipt" });
      return;
    }

    let command: ProcessWagerCommand | undefined;
    let result: Awaited<ReturnType<ProcessWagerTransactionUseCase["execute"]>>;
    try {
      command = parseWagerMessage(message.Body, this.config.SQS_CONSUMER_NAME);
      const heartbeatStop = new AbortController();
      const heartbeat = this.heartbeat(receipt, heartbeatStop.signal, {
        ...transport,
        ...this.trace(command),
      });
      try {
        result = await this.processor.execute(command);
      } finally {
        heartbeatStop.abort();
        await heartbeat;
      }
    } catch (error) {
      const { permanent, code } = classify(error);
      const exhausts = attempt >= this.config.SQS_MAX_RECEIVE_COUNT;
      const delay = permanent || exhausts ? 0 : retryDelay(attempt, 1, 30);
      try {
        await this.changeVisibility(receipt, delay);
      } catch {
        this.log("warn", {
          ...transport,
          ...this.trace(command),
          result: "visibility_change_failed",
        });
      }
      this.log("warn", {
        ...transport,
        ...this.trace(command),
        code,
        durationMs: Math.round(performance.now() - started),
        delaySeconds: delay,
        result: exhausts ? "awaiting_dlq" : permanent ? "permanent_failure" : "retry",
      });
      return;
    }

    const details = {
      ...transport,
      ...this.trace(command),
      transactionId: result.transactionId,
      status: result.status,
      durationMs: Math.round(performance.now() - started),
    };
    try {
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.config.SQS_WAGER_QUEUE_URL,
          ReceiptHandle: receipt,
        }),
        { abortSignal: AbortSignal.timeout(3_000) },
      );
      this.log("log", {
        ...details,
        result: result.idempotentReplay ? "duplicate" : "acknowledged",
      });
    } catch {
      this.log("warn", { ...details, result: "ack_failed" });
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
        if (!signal.aborted) this.log("warn", { ...trace, result: "visibility_extension_failed" });
        break;
      }
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

  private trace(command: ProcessWagerCommand | undefined) {
    return {
      messageId: command?.inbox?.messageId,
      walletId: command?.walletId,
      providerId: command?.providerId,
      correlationId: command?.correlationId,
    };
  }

  private log(level: "log" | "warn", fields: object): void {
    this.context.logger[level](
      {
        ...fields,
        consumerName: this.config.SQS_CONSUMER_NAME,
        workerInstanceId: this.context.workerInstanceId,
      },
      "SqsWagerConsumer",
    );
  }
}
