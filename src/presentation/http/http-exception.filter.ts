import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ServerResponse } from "node:http";
import {
  ApplicationError,
  type ApplicationErrorCode,
} from "../../application/errors/application-error";
import {
  PersistenceConflictError,
  PersistenceUnavailableError,
} from "../../application/ports/transaction-manager";
import { HttpContractError } from "./http-contract-error";
import { ReadinessUnavailable } from "./health.controller";
import { correlationHeader, getRequestContext, type HttpRequest } from "./request-context";

const applicationStatus: Record<ApplicationErrorCode, number> = {
  INVALID_COMMAND: 400,
  INVALID_CURSOR: 400,
  WALLET_NOT_FOUND: 404,
  WALLET_OWNERSHIP_MISMATCH: 422,
  WALLET_ALREADY_EXISTS: 409,
  WAGER_NOT_FOUND: 404,
  WAGER_NOT_PENDING: 409,
  IDEMPOTENCY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_CONFLICT: 409,
  INBOX_CONFLICT: 409,
  HISTORICAL_RESULT_UNAVAILABLE: 409,
};

function problem(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpContractError) {
    return { status: error.getStatus(), code: error.code, message: error.message };
  }
  if (error instanceof ApplicationError) {
    return { status: applicationStatus[error.code], code: error.code, message: error.message };
  }
  if (error instanceof PersistenceConflictError) {
    return {
      status: 503,
      code: error.reason,
      message: "Persistence contention. Retry with the original key",
    };
  }
  if (error instanceof PersistenceUnavailableError) {
    return {
      status: 503,
      code: "PERSISTENCE_UNAVAILABLE",
      message: "Persistence is temporarily unavailable",
    };
  }
  if (error instanceof HttpException) {
    switch (error.getStatus()) {
      case 400:
        return { status: 400, code: "INVALID_REQUEST", message: "Invalid HTTP request" };
      case 404:
        return { status: 404, code: "ROUTE_NOT_FOUND", message: "Route not found" };
      case 413:
        return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 16 KiB" };
      case 415:
        return {
          status: 415,
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Unsupported request encoding or media type",
        };
    }
  }
  if (error instanceof Error && "type" in error) {
    if (error.type === "entity.too.large") {
      return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 16 KiB" };
    }
    if (error.type === "encoding.unsupported" || error.type === "charset.unsupported") {
      return {
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "Unsupported request encoding or media type",
      };
    }
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Unexpected server error" };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("HTTP");

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<ServerResponse>();
    if (response.headersSent || response.destroyed) return;
    const { correlationId } = getRequestContext(http.getRequest<HttpRequest>());
    response.setHeader(correlationHeader, correlationId);
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (error instanceof ReadinessUnavailable) {
      response.statusCode = 503;
      response.end(JSON.stringify(error.readiness));
      return;
    }

    const { status, code, message } = problem(error);
    if (status === 500) this.logger.error({ correlationId, code });
    if (status === 503) response.setHeader("retry-after", "1");
    response.statusCode = status;
    response.end(JSON.stringify({ error: { code, message, correlationId } }));
  }
}
