import { ConsoleLogger, type LogLevel } from "@nestjs/common";
import type { AppConfig } from "../config/environment";

const levels: Record<AppConfig["LOG_LEVEL"], LogLevel[]> = {
  error: ["fatal", "error"],
  warn: ["fatal", "error", "warn"],
  info: ["fatal", "error", "warn", "log"],
  debug: ["fatal", "error", "warn", "log", "debug", "verbose"],
};

export function createLogger(level: AppConfig["LOG_LEVEL"]): ConsoleLogger {
  return new ConsoleLogger({ json: true, logLevels: levels[level] });
}
