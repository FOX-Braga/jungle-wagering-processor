import type { Money, MoneyProps } from "../../domain/money/money";
import type { ProcessWagerCommand } from "../commands/financial-commands";

type CanonicalObject = { readonly [key: string]: string | CanonicalObject };

function canonicalJson(object: CanonicalObject): string {
  const fields = Object.keys(object)
    .sort()
    .map((key) => {
      const value = object[key];
      if (value === undefined) throw new TypeError("Canonical payload values must be defined");
      return `${JSON.stringify(key)}:${typeof value === "string" ? JSON.stringify(value) : canonicalJson(value)}`;
    });
  return `{${fields.join(",")}}`;
}

export async function hashCanonicalPayload(payload: CanonicalObject): Promise<string> {
  const data = new TextEncoder().encode(canonicalJson(payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashWagerPayload(command: ProcessWagerCommand, money: Money): Promise<string> {
  return hashCanonicalPayload({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: money.toJSON(),
    ...(command.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
  });
}

export function hashOpeningPayload(playerId: string, initialBalance: MoneyProps): Promise<string> {
  return hashCanonicalPayload({ playerId, initialBalance });
}
