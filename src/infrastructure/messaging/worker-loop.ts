import type { LoggerService } from "@nestjs/common";
import { setTimeout } from "node:timers/promises";

export interface WorkerContext {
  readonly workerInstanceId: string;
  readonly logger: LoggerService;
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

export async function poll(
  cycle: () => Promise<boolean>,
  signal: AbortSignal,
  interval: number,
  reportFailure: (attempt: number) => void,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const hadWork = await cycle();
      failures = 0;
      if (!hadWork) await pause(interval, signal);
    } catch {
      if (signal.aborted) break;
      reportFailure(++failures);
      await pause(retryDelay(failures, interval, Math.max(interval, 30_000)), signal);
    }
  }
}
