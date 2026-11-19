import { ApplicationError } from "../../application/errors/application-error";
import type { ProcessWagerResult } from "../../application/results/financial-results";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { type Metrics, operationMetrics, type WagerSource } from "./metrics";

export async function observeWager<T extends ProcessWagerResult | undefined>(
  metrics: Metrics | undefined,
  source: WagerSource,
  execute: () => Promise<T>,
): Promise<T> {
  if (!metrics) return execute();
  const started = performance.now();
  try {
    const result = await operationMetrics.run({ metrics, source }, execute);
    if (source === "references" && result?.status === WagerTransactionStatus.PendingReference) {
      return result;
    }
    if (result?.idempotentReplay) {
      metrics.record("wager_idempotency_duplicates_total", 1, source);
    } else if (result) {
      metrics.record("wager_transactions_total", 1, source, result.status);
    }
    return result;
  } catch (error) {
    if (
      error instanceof ApplicationError &&
      ["IDEMPOTENCY_CONFLICT", "EXTERNAL_TRANSACTION_CONFLICT", "INBOX_CONFLICT"].includes(
        error.code,
      )
    ) {
      metrics.record("wager_idempotency_conflicts_total", 1, source);
    }
    throw error;
  } finally {
    metrics.record(
      "wager_processing_duration_seconds",
      (performance.now() - started) / 1000,
      source,
    );
  }
}
