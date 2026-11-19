import { PersistenceConflictError } from "../../application/ports/transaction-manager";
import type { TransactionManager } from "../../application/ports/transaction-manager";
import type { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { FailureCode } from "../../domain/shared/failure-code";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import type { AppConfig } from "../config/environment";
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
    );
  }

  async processBatch(signal: AbortSignal): Promise<void> {
    const due = await this.transactions.execute(({ wagers }) =>
      wagers.findDueReferences(new Date(), this.config.REFERENCE_WORKER_BATCH_SIZE),
    );
    for (const { id: transactionId, providerId, walletId, referenceAttempts } of due) {
      if (signal.aborted) return;
      const started = performance.now();
      const trace = {
        transactionId,
        providerId,
        walletId,
        correlationId: transactionId,
        attempt: referenceAttempts + 1,
      };
      try {
        const outcome = await this.processor.retryPendingReference(transactionId, {
          maxAttempts: this.config.REFERENCE_MAX_ATTEMPTS,
          baseDelayMs: 1_000,
          maxDelayMs: 60_000,
        });
        if (!outcome) continue;
        const result =
          outcome.status === WagerTransactionStatus.PendingReference
            ? "reference_rescheduled"
            : outcome.failureCode === FailureCode.ReferenceNotFound
              ? "reference_expired"
              : "reference_finalized";
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

  private log(level: "log" | "warn", fields: object): void {
    this.context.logger[level](
      { ...fields, workerInstanceId: this.context.workerInstanceId },
      "PendingReferenceWorker",
    );
  }
}
