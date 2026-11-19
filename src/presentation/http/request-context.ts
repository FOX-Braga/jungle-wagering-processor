import {
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { finalize } from "rxjs";
import type { Metrics } from "../../infrastructure/observability/metrics";
import { correlationId } from "./dto/financial-requests";
import { HttpContractError } from "./http-contract-error";

const key = Symbol("http-context");
const admission = Symbol("http-admission");
export const correlationHeader = "x-correlation-id";

interface RequestContext {
  correlationId: string;
  walletId?: string;
  providerId?: string;
  transactionId?: string;
  event?: string;
  operation?: string;
  outcome?: string;
  errorCode?: string;
  checkedEntries?: number;
}

export interface HttpRequest extends IncomingMessage {
  [key]?: RequestContext;
  [admission]?: { executing: boolean; release(): void };
  metrics?: Metrics;
  route?: { path?: unknown };
}

export class HttpAdmissionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const slot = context.switchToHttp().getRequest<HttpRequest>()[admission];
    if (!slot) return next.handle();
    slot.executing = true;
    return next.handle().pipe(finalize(() => slot.release()));
  }
}

export function getRequestContext(request: HttpRequest): RequestContext {
  return (request[key] ??= { correlationId: randomUUID() });
}

export function singleHeader(request: HttpRequest, name: string): string | undefined {
  const distinct = request.headersDistinct[name];
  if (distinct) return distinct.length === 1 ? distinct[0] : "";
  const value = request.headers[name];
  return typeof value === "string" ? value : value ? "" : undefined;
}

export function requestContextMiddleware(instanceId: string, metrics: Metrics, limit: number) {
  const logger = new Logger("HTTP");
  let inFlight = 0;
  return (request: HttpRequest, response: ServerResponse, next: (error?: Error) => void) => {
    const start = performance.now();
    const rawId = singleHeader(request, correlationHeader);
    const provided = rawId === undefined ? undefined : correlationId.safeParse(rawId);
    const context = getRequestContext(request);
    request.metrics = metrics;
    if (provided?.success) context.correlationId = provided.data;
    response.setHeader(correlationHeader, context.correlationId);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cache-control", "no-store");
    response.once("finish", () => {
      const durationMs = performance.now() - start;
      const statusClass = `${Math.floor(response.statusCode / 100)}xx`;
      metrics.record("wager_http_duration_seconds", durationMs / 1000, statusClass);
      const level =
        response.statusCode >= 500
          ? "error"
          : response.statusCode >= 400 || context.outcome === "divergent"
            ? "warn"
            : "log";
      logger[level]({
        event: "http.request.completed",
        ...context,
        method: request.method,
        route: typeof request.route?.path === "string" ? request.route.path : undefined,
        statusCode: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        instanceId,
      });
    });
    if (provided && !provided.success) {
      next(
        new HttpContractError(
          400,
          "INVALID_CORRELATION_ID",
          "X-Correlation-Id has an invalid format",
        ),
      );
      return;
    }
    const path = request.url?.split("?", 1)[0];
    if (path !== "/health/live" && path !== "/health/ready") {
      if (inFlight >= limit) {
        next(
          new HttpContractError(503, "HTTP_OVERLOADED", "Server busy. Retry with the original key"),
        );
        return;
      }
      inFlight++;
      const slot = {
        executing: false,
        release() {
          if (request[admission] !== slot) return;
          delete request[admission];
          inFlight--;
        },
      };
      request[admission] = slot;
      response.once("close", () => {
        if (!slot.executing) slot.release();
      });
    }
    next();
  };
}
