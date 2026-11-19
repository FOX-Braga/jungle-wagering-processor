import { z } from "zod";
import type { ProcessWagerCommand } from "../../application/commands/financial-commands";
import {
  idempotencyKey,
  requestIdentifier,
  wagerSchema,
} from "../../application/services/wager-contract";

const schema = z.strictObject({
  schemaVersion: z.literal(1).optional(),
  messageId: requestIdentifier,
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime({ offset: true }),
  correlationId: requestIdentifier.optional(),
  causationId: requestIdentifier.optional(),
  data: wagerSchema({ idempotencyKey }),
});

export class InvalidWagerMessage extends Error {}

export function parseWagerMessage(
  body: string | undefined,
  consumerName: string,
): ProcessWagerCommand {
  if (!body || Buffer.byteLength(body, "utf8") > 32 * 1024) {
    throw new InvalidWagerMessage("INVALID_MESSAGE_SIZE");
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessage("INVALID_JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const invalidVersion = parsed.error.issues.some(({ path }) => path[0] === "schemaVersion");
    throw new InvalidWagerMessage(
      invalidVersion ? "UNSUPPORTED_SCHEMA_VERSION" : "INVALID_ENVELOPE",
    );
  }
  const { data, messageId, correlationId, causationId } = parsed.data;
  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    idempotencyKey: data.idempotencyKey,
    walletId: data.walletId,
    playerId: data.playerId,
    roundId: data.roundId,
    gameId: data.gameId,
    money: data.money,
    kind: data.kind,
    ...("referenceExternalTransactionId" in data &&
    data.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
      : {}),
    correlationId: correlationId ?? messageId,
    ...(causationId ? { causationId } : {}),
    inbox: { consumerName, messageId },
  };
}
