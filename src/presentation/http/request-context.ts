import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { correlationId } from "./dto/financial-requests";
import { HttpContractError } from "./http-contract-error";

const key = Symbol("http-context");
export const correlationHeader = "x-correlation-id";

interface RequestContext {
  correlationId: string;
  walletId?: string;
  providerId?: string;
  transactionId?: string;
}

export interface HttpRequest extends IncomingMessage {
  [key]?: RequestContext;
  route?: { path?: unknown };
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

export function requestContextMiddleware(instanceId: string) {
  const logger = new Logger("HTTP");
  return (request: HttpRequest, response: ServerResponse, next: (error?: Error) => void) => {
    const start = performance.now();
    const rawId = singleHeader(request, correlationHeader);
    const provided = rawId === undefined ? undefined : correlationId.safeParse(rawId);
    const context = getRequestContext(request);
    if (provided?.success) context.correlationId = provided.data;
    response.setHeader(correlationHeader, context.correlationId);
    response.once("finish", () => {
      logger.log({
        ...context,
        method: request.method,
        route: typeof request.route?.path === "string" ? request.route.path : undefined,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
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
    next();
  };
}
