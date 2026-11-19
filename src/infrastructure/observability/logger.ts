import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import type { AppConfig } from "../config/environment";

const levels: Record<AppConfig["LOG_LEVEL"], LogLevel[]> = {
  error: ["fatal", "error"],
  warn: ["fatal", "error", "warn"],
  info: ["fatal", "error", "warn", "log"],
  debug: ["fatal", "error", "warn", "log", "debug", "verbose"],
};
const processId = crypto.randomUUID();
const fields = [
  "event",
  "result",
  "outcome",
  "operation",
  "errorCode",
  "code",
  "status",
  "statusCode",
  "correlationId",
  "causationId",
  "messageId",
  "sourceMessageId",
  "transportMessageId",
  "transactionId",
  "walletId",
  "providerId",
  "eventId",
  "eventType",
  "aggregateId",
  "attempt",
  "receiveCount",
  "durationMs",
  "lagMs",
  "delaySeconds",
  "checkedEntries",
  "workerType",
  "role",
  "workerInstanceId",
  "consumerName",
  "method",
  "route",
  "port",
  "signal",
  "dependency",
];
const safeValue = /^[A-Za-z0-9_./:-]{1,160}$/;

export function logRecord(message: unknown, level: LogLevel, context: string, instanceId: string) {
  const allowed: Record<string, string | number | boolean> = {};
  if (message && typeof message === "object") {
    for (const key of fields) {
      const value: unknown = Object.getOwnPropertyDescriptor(message, key)?.value;
      if (
        (typeof value === "string" && safeValue.test(value) && !value.includes("://")) ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
      )
        allowed[key] = value;
    }
  }
  return {
    timestamp: new Date().toISOString(),
    level: level === "log" ? "info" : level,
    service: "jungle-wagering-processor",
    instanceId,
    pid: process.pid,
    context: safeValue.test(context) ? context : "Application",
    event: "application.lifecycle",
    ...(allowed.code ? { errorCode: allowed.code } : {}),
    ...allowed,
  };
}

export function createLogger(
  level: AppConfig["LOG_LEVEL"],
  instanceId: string = processId,
): ConsoleLogger {
  return new (class extends ConsoleLogger {
    protected override printMessages(
      messages: unknown[],
      context = "Application",
      logLevel: LogLevel = "log",
      stream: "stdout" | "stderr" = "stdout",
    ): void {
      for (const message of messages) {
        try {
          process[stream].write(
            JSON.stringify(logRecord(message, logLevel, context, instanceId)) + "\n",
          );
        } catch {
          // Logging is best effort and must not interrupt a financial request or ACK.
          return;
        }
      }
    }
  })({ json: true, logLevels: levels[level] });
}
