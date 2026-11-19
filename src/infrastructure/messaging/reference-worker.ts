import { PersistenceConflictError } from "../../application/ports/transaction-manager";
import type { TransactionManager } from "../../application/ports/transaction-manager";
import type { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { FailureCode } from "../../domain/shared/failure-code";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { AppConfig } from "../config/environment";
import { observeWager } from "../observability/wager-observation";
import { poll, type WorkerContext } from "./worker-loop";

export class ReferenceWorker {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly processor: Pick<ProcessWagerTransactionUseCase, "retryPendingReference">,
    private readonly config: AppConfig,
    private readonly context: WorkerContext,
  ) {}

  run(signal: AbortSignal): Promise<void> {
    return poll(
      async () => {
        await this.processBatch(signal);
        return false;
      },
      signal,
      this.config.REFERENCE_WORKER_INTERVAL_MS,
      (attempt) => this.log("warn", { result: "reference_poll_failed", attempt }),
      this.context.metrics,
    );
  }

  async processBatch(signal: AbortSignal): Promise<void> {
    const due = await this.transactions.execute(({ wagers }) =>
      wagers.findDueReferences(new Date(), this.config.REFERENCE_WORKER_BATCH_SIZE),
    );
    for (const {
      id: transactionId,
      providerId,
      walletId,
      referenceAttempts,
      correlationId,
      causationId,
      sourceMessageId,
      createdAtMs,
    } of due) {
      if (signal.aborted) return;
      const started = performance.now();
      const trace = {
        transactionId,
        providerId,
        walletId,
        correlationId: correlationId ?? transactionId,
        ...(causationId ? { causationId } : {}),
        ...(sourceMessageId ? { sourceMessageId, messageId: sourceMessageId } : {}),
        attempt: referenceAttempts + 1,
      };
      try {
        const outcome = await observeWager(this.context.metrics, "references", () =>
          this.processor.retryPendingReference(
            transactionId,
            {
              maxAttempts: this.config.REFERENCE_MAX_ATTEMPTS,
              baseDelayMs: 1_000,
              maxDelayMs: 60_000,
            },
            trace,
          ),
        );
        if (!outcome) continue;
        const result =
          outcome.status === WagerTransactionStatus.PendingReference
            ? "reference_rescheduled"
            : outcome.failureCode === FailureCode.ReferenceNotFound
              ? "reference_expired"
              : "reference_finalized";
        if (result === "reference_rescheduled")
          this.context.metrics?.record("wager_processing_retries_total", 1, "references");
        else if (createdAtMs !== undefined) {
          this.context.metrics?.record(
            "wager_reference_resolution_duration_seconds",
            Math.max(0, Date.now() - createdAtMs) / 1000,
          );
        }
        this.log("log", {
          ...trace,
          result,
          status: outcome.status,
          code: outcome.failureCode,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        if (!(error instanceof PersistenceConflictError)) throw error;
        this.log("warn", { ...trace, result: "reference_lock_conflict", code: error.reason });
      }
    }
  }

  private log(level: "log" | "warn", fields: { result: string } & Record<string, unknown>): void {
    this.context.metrics?.record("wager_reference_events_total", 1, fields.result);
    this.context.logger[level](
      {
        ...fields,
        event: `reference.${fields.result}`,
        workerType: "references",
        workerInstanceId: this.context.workerInstanceId,
      },
      "PendingReferenceWorker",
    );
  }
}
