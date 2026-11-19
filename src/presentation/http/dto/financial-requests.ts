import { z } from "zod";
import type { MoneyProps } from "../../../domain/money/money";
import { WagerTransactionKind as Kind } from "../../../domain/wagering/wager-transaction";

export const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}(?![\\s\\S])";
export const idempotencyPattern = "^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}(?![\\s\\S])";
export const amountPattern = "^\\d{1,36}\\.\\d{2}(?![\\s\\S])";

const identifier = z.string().regex(new RegExp(identifierPattern));
export const idempotencyKey = z.string().regex(new RegExp(idempotencyPattern));
export const correlationId = identifier;
const money = z.strictObject({
  amount: z
    .string()
    .regex(new RegExp(amountPattern))
    .describe("Quantia decimal exata com duas casas, enviada como string"),
  currency: z.enum(Intl.supportedValuesOf("currency")),
});
export const externalKinds = [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback] as const;

export class CreateWalletRequest {
  static readonly schema = z.strictObject({ playerId: identifier, initialBalance: money });
  declare playerId: string;
  declare initialBalance: MoneyProps;
}

const wagerFields = {
  providerId: identifier,
  externalTransactionId: identifier,
  walletId: identifier,
  playerId: identifier,
  roundId: identifier,
  gameId: identifier,
  money,
};
export class SubmitWagerRequest {
  static readonly schema = z.discriminatedUnion("kind", [
    z.strictObject({ ...wagerFields, kind: z.enum([Kind.Bet, Kind.Loss]) }),
    z.strictObject({
      ...wagerFields,
      kind: z.literal(Kind.Win),
      referenceExternalTransactionId: identifier.optional(),
    }),
    z.strictObject({
      ...wagerFields,
      kind: z.enum([Kind.Refund, Kind.Rollback]),
      referenceExternalTransactionId: identifier,
    }),
  ]);
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
