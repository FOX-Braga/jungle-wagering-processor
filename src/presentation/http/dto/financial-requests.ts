import { z } from "zod";
import type { MoneyProps } from "../../../domain/money/money";
import {
  externalKinds,
  requestIdentifier as identifier,
  requestMoney as money,
  wagerSchema,
} from "../../../application/services/wager-contract";

export {
  amountPattern,
  externalKinds,
  idempotencyKey,
  idempotencyPattern,
  identifierPattern,
} from "../../../application/services/wager-contract";
export const correlationId = identifier;

export class CreateWalletRequest {
  static readonly schema = z.strictObject({ playerId: identifier, initialBalance: money });
  declare playerId: string;
  declare initialBalance: MoneyProps;
}

export class SubmitWagerRequest {
  static readonly schema = wagerSchema({});
  declare providerId: string;
  declare externalTransactionId: string;
  declare walletId: string;
  declare playerId: string;
  declare roundId: string;
  declare gameId: string;
  declare kind: (typeof externalKinds)[number];
  declare money: MoneyProps;
  declare referenceExternalTransactionId?: string;
}

export class WalletParams {
  static readonly schema = z.strictObject({ walletId: identifier });
  declare walletId: string;
}

export class TransactionParams {
  static readonly schema = z.strictObject({ transactionId: identifier });
  declare transactionId: string;
}

export class ProviderTransactionParams {
  static readonly schema = z.strictObject({
    providerId: identifier,
    externalTransactionId: identifier,
  });
  declare providerId: string;
  declare externalTransactionId: string;
}

export const maxLedgerPage = 100;
export const cursorPattern = "^[A-Za-z0-9_-]{1,512}(?![\\s\\S])";
export class LedgerQuery {
  static readonly schema = z.strictObject({
    cursor: z.string().regex(new RegExp(cursorPattern)).optional(),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}(?![\s\S])/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(maxLedgerPage))
      .optional(),
  });
  declare cursor?: string;
  declare limit?: number;
}
