import { expect, test } from "bun:test";
import { WagerTransactionKind as Kind } from "../../../src/domain/wagering/wager-transaction";
import {
  InvalidWagerMessage,
  parseWagerMessage,
} from "../../../src/infrastructure/messaging/wager-message";
import { retryDelay } from "../../../src/infrastructure/messaging/worker-loop";

const data = {
  providerId: "provider-a",
  externalTransactionId: "bet-1",
  idempotencyKey: "provider-a:bet-1",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: Kind.Bet,
  money: { amount: "25.00", currency: "BRL" },
};
const envelope = {
  messageId: "message-1",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data,
};

test("maps the logical inbox identity to the same financial command as HTTP", () => {
  expect(parseWagerMessage(JSON.stringify(envelope), "wager-processor")).toEqual({
    ...data,
    correlationId: "message-1",
    inbox: { consumerName: "wager-processor", messageId: "message-1" },
  });
  const refund = { ...data, kind: "REFUND", referenceExternalTransactionId: "bet-0" };
  expect(
    parseWagerMessage(
      JSON.stringify({ ...envelope, data: refund, correlationId: "trace-1" }),
      "wager-processor",
    ),
  ).toMatchObject({ ...refund, correlationId: "trace-1" });
});

test.each([
  ["JSON quebrado", "{"],
  ["envelope ausente", "{}"],
  ["tipo desconhecido", JSON.stringify({ ...envelope, type: "Other" })],
  ["timestamp inválido", JSON.stringify({ ...envelope, occurredAt: "2026-02-30T00:00:00Z" })],
  ["identidade inválida", JSON.stringify({ ...envelope, messageId: "unsafe\n" })],
  ["campo desconhecido", JSON.stringify({ ...envelope, transportMessageId: "x" })],
  ["chave ausente", JSON.stringify({ ...envelope, data: { ...data, idempotencyKey: undefined } })],
  [
    "dinheiro numérico",
    JSON.stringify({ ...envelope, data: { ...data, money: { amount: 25, currency: "BRL" } } }),
  ],
  [
    "moeda inválida",
    JSON.stringify({
      ...envelope,
      data: { ...data, money: { amount: "25.00", currency: "INVALID" } },
    }),
  ],
  ["OPENING", JSON.stringify({ ...envelope, data: { ...data, kind: "OPENING" } })],
  ["REFUND sem referência", JSON.stringify({ ...envelope, data: { ...data, kind: "REFUND" } })],
  ["ROLLBACK sem referência", JSON.stringify({ ...envelope, data: { ...data, kind: "ROLLBACK" } })],
  ["corpo grande", "á".repeat(16_385)],
])("rejects %s before opening a transaction", (_name, body) => {
  expect(() => parseWagerMessage(body, "wager-processor")).toThrow(InvalidWagerMessage);
});

test("bounds exponential backoff even for a very large receive count", () => {
  expect([1, 2, 3, 6, 1000].map((attempt) => retryDelay(attempt, 1, 30))).toEqual([
    1, 2, 4, 30, 30,
  ]);
});
