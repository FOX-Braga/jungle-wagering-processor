import { z } from "zod";
import { WagerTransactionKind as Kind } from "../../domain/wagering/wager-transaction";

export const identifierPattern = "^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}(?![\\s\\S])";
export const idempotencyPattern = "^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}(?![\\s\\S])";
export const amountPattern = "^\\d{1,36}\\.\\d{2}(?![\\s\\S])";
export const requestIdentifier = z.string().regex(new RegExp(identifierPattern));
export const idempotencyKey = z.string().regex(new RegExp(idempotencyPattern));
export const requestMoney = z.strictObject({
  amount: z
    .string()
    .regex(new RegExp(amountPattern))
    .describe("Quantia decimal exata com duas casas, enviada como string"),
  currency: z.enum(Intl.supportedValuesOf("currency")),
});
export const externalKinds = [Kind.Bet, Kind.Win, Kind.Loss, Kind.Refund, Kind.Rollback] as const;

export function wagerSchema<Extra extends z.ZodRawShape>(extra: Extra) {
  const fields = {
    ...extra,
    providerId: requestIdentifier,
    externalTransactionId: requestIdentifier,
    walletId: requestIdentifier,
    playerId: requestIdentifier,
    roundId: requestIdentifier,
    gameId: requestIdentifier,
    money: requestMoney,
  };
  return z.discriminatedUnion("kind", [
    z.strictObject({ ...fields, kind: z.enum([Kind.Bet, Kind.Loss]) }),
    z.strictObject({
      ...fields,
      kind: z.literal(Kind.Win),
      referenceExternalTransactionId: requestIdentifier.optional(),
    }),
    z.strictObject({
      ...fields,
      kind: z.enum([Kind.Refund, Kind.Rollback]),
      referenceExternalTransactionId: requestIdentifier,
    }),
  ]);
}
