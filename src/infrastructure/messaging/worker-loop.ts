import type { LoggerService } from "@nestjs/common";
import { setTimeout } from "node:timers/promises";
import type { Metrics } from "../observability/metrics";

export interface WorkerContext {
  readonly workerInstanceId: string;
  readonly logger: LoggerService;
  readonly metrics?: Metrics;
}

export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await setTimeout(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

export function retryDelay(attempt: number, base: number, cap: number): number {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

export function jitteredDelay(delay: number, random = Math.random): number {
  const minimum = Math.ceil(delay / 2);
  return minimum + Math.floor(random() * (delay - minimum + 1));
}

export async function poll(
  cycle: () => Promise<boolean>,
  signal: AbortSignal,
  interval: number,
  reportFailure: (attempt: number) => void,
  metrics?: Metrics,
  jitter = false,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const hadWork = await cycle();
      failures = 0;
      if (!signal.aborted) {
        metrics?.record("wager_worker_last_success_timestamp_seconds", Date.now() / 1000);
        metrics?.record("wager_readiness", 1, "process");
      }
      if (!hadWork) await pause(interval, signal);
    } catch {
      if (signal.aborted) break;
      metrics?.record("wager_readiness", 0, "process");
      reportFailure(++failures);
      const delay = retryDelay(failures, interval, Math.max(interval, 30_000));
      await pause(jitter ? jitteredDelay(delay) : delay, signal);
    }
  }
}
