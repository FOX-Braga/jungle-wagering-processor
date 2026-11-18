import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionProps,
} from "../../src/domain/wagering/wager-transaction";
import { at, brl } from "./domain";

export function wagerProps(
  kind: WagerTransactionKind,
  overrides: Partial<WagerTransactionProps> = {},
): WagerTransactionProps {
  const externalId = overrides.externalTransactionId ?? kind.toLowerCase();
  return {
    id: `tx-${externalId}`,
    providerId: "provider",
    externalTransactionId: externalId,
    idempotencyKey: `provider:${externalId}`,
    payloadHash: `hash-${externalId}`,
    walletId: "wallet",
    playerId: "player",
    roundId: "round",
    gameId: "game",
    kind,
    money: brl("20.00"),
    createdAt: at(),
    ...overrides,
  };
}

export function wager(
  kind: WagerTransactionKind,
  overrides: Partial<WagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(wagerProps(kind, overrides));
}
