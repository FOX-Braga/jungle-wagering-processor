import { applyDecorators } from "@nestjs/common";
import { ApiParam, ApiResponse } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";
import { LedgerDirection } from "../../../domain/ledger/wallet-ledger-entry";
import { FailureCode } from "../../../domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../domain/wagering/wager-transaction";
import { CreateWalletRequest, identifierPattern, SubmitWagerRequest } from "./financial-requests";

const text: SchemaObject = { type: "string" };
const date: SchemaObject = { type: "string", format: "date-time" };
const version: SchemaObject = { type: "integer", minimum: 1 };
const id: SchemaObject = {
  type: "string",
  pattern: identifierPattern,
  example: "0192f291-27dd-7d3f-8071-5f8685deef37",
};
const bool: SchemaObject = { type: "boolean" };

function object(
  properties: Record<string, SchemaObject>,
  required = Object.keys(properties),
): SchemaObject {
  return { type: "object", properties, required, additionalProperties: false };
}

function requestSchema(schema: z.ZodType): SchemaObject {
  return z.toJSONSchema(schema, { target: "openapi-3.0" }) as SchemaObject;
}

const money = object({
  amount: { type: "string", pattern: "^\\d+\\.\\d{2}$", example: "75.00" },
  currency: { type: "string", example: "BRL" },
});
const difference = object({
  amount: { type: "string", pattern: "^-?\\d+\\.\\d{2}$", example: "0.00" },
  currency: { type: "string", example: "BRL" },
});

export const createWalletBody = requestSchema(CreateWalletRequest.schema);
export const submitWagerBody = requestSchema(SubmitWagerRequest.schema);
export const walletResponse = object({ id, playerId: id, balance: money, version });
export const ledgerResponse = object({
  items: {
    type: "array",
    items: object({
      id,
      walletId: id,
      transactionId: id,
      direction: { type: "string", enum: Object.values(LedgerDirection) },
      money,
      balanceBefore: money,
      balanceAfter: money,
      walletVersion: version,
      createdAt: date,
    }),
  },
  nextCursor: { type: "string", nullable: true },
  hasMore: bool,
});

const rejectionCodes = [
  FailureCode.InsufficientFunds,
  FailureCode.ReversalInsufficientFunds,
  FailureCode.CurrencyMismatch,
  FailureCode.WalletMismatch,
  FailureCode.InvalidReference,
  FailureCode.ReferenceNotFound,
  FailureCode.ReferenceTypeNotAllowed,
  FailureCode.AmountMismatch,
  FailureCode.AlreadyReversed,
];
const failureCode: SchemaObject = {
  type: "string",
  enum: [...rejectionCodes, FailureCode.ReferenceNotReady, FailureCode.ProcessingFailed],
};
const outcome = {
  transactionId: id,
  balance: money,
  walletVersion: version,
  failureCode,
  referenceTransactionId: id,
  processedAt: date,
};
export function wagerOutcome(status: Status): SchemaObject {
  const basic = ["transactionId", "status", "balance", "walletVersion", "idempotentReplay"];
  return object(
    {
      ...outcome,
      status: { type: "string", enum: [status] },
      idempotentReplay: bool,
      ...(status === Status.Rejected
        ? { failureCode: { ...failureCode, enum: rejectionCodes } }
        : {}),
    },
    status === Status.Rejected ? [...basic, "failureCode"] : basic,
  );
}
export const transactionResponse = object(
  {
    ...outcome,
    status: { type: "string", enum: Object.values(Status) },
    providerId: id,
    externalTransactionId: id,
    walletId: id,
    kind: { type: "string", enum: Object.values(Kind) },
    money,
    referenceExternalTransactionId: id,
    createdAt: date,
    updatedAt: date,
  },
  [
    "transactionId",
    "status",
    "providerId",
    "externalTransactionId",
    "walletId",
    "kind",
    "money",
    "createdAt",
    "updatedAt",
  ],
);

export const reconciliationResponse = object({
  walletId: id,
  storedBalance: money,
  calculatedBalance: money,
  difference,
  consistent: bool,
  checkedEntries: { type: "integer", minimum: 0 },
});

export const errorSchema = object({
  error: object({ code: text, message: text, correlationId: id }),
});

const descriptions: Record<number, string> = {
  400: "Parâmetros, cabeçalho ou corpo inválido",
  404: "Recurso inexistente",
  409: "Conflito de identidade ou idempotência",
  413: "Corpo acima de 16 KiB",
  415: "Formato ou codificação incompatível",
  500: "Erro interno",
  503: "Persistência temporariamente indisponível ou bloqueada",
};

export function ApiProblems(...statuses: number[]) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({ status, description: descriptions[status] ?? "Erro", schema: errorSchema }),
    ),
  );
}

export function ApiIdentifier(name: string) {
  return ApiParam({ name, required: true, schema: id });
}
