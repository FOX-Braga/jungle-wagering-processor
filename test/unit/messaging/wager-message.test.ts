import { expect, test } from "bun:test";
import { ApplicationError } from "../../../src/application/errors/application-error";
import {
  PersistenceConflictError,
  PersistenceUnavailableError,
} from "../../../src/application/ports/transaction-manager";
import { WagerTransactionKind as Kind } from "../../../src/domain/wagering/wager-transaction";
import { classifyWagerFailure } from "../../../src/infrastructure/messaging/wager-consumer";
import {
  InvalidWagerMessage,
  parseWagerMessage,
} from "../../../src/infrastructure/messaging/wager-message";
import { jitteredDelay, poll, retryDelay } from "../../../src/infrastructure/messaging/worker-loop";

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
  ["messageId ausente", JSON.stringify({ ...envelope, messageId: undefined })],
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

test("version 1 retains the legacy command and unsupported versions are permanent", () => {
  const parse = (body: object) => parseWagerMessage(JSON.stringify(body), "wager-processor");
  expect(parse({ ...envelope, schemaVersion: 1 })).toEqual(parse(envelope));
  for (const schemaVersion of [0, 2, "1", null]) {
    expect(() => parse({ ...envelope, schemaVersion })).toThrow("UNSUPPORTED_SCHEMA_VERSION");
  }
  expect(classifyWagerFailure(new InvalidWagerMessage("UNSUPPORTED_SCHEMA_VERSION"))).toEqual({
    code: "UNSUPPORTED_SCHEMA_VERSION",
    permanent: true,
  });
  expect(classifyWagerFailure(new ApplicationError("INBOX_CONFLICT", "conflict"))).toEqual({
    code: "INBOX_CONFLICT",
    permanent: true,
  });
  expect(classifyWagerFailure(new PersistenceUnavailableError(undefined))).toEqual({
    code: "DATABASE_UNAVAILABLE",
    permanent: false,
  });
  expect(classifyWagerFailure(new PersistenceConflictError("DEADLOCK", undefined))).toEqual({
    code: "DEADLOCK",
    permanent: false,
  });
});

test("bounds exponential backoff even for a very large receive count", () => {
  expect([1, 2, 3, 6, 1000].map((attempt) => retryDelay(attempt, 1, 30))).toEqual([
    1, 2, 4, 30, 30,
  ]);
  expect(jitteredDelay(30_000, () => 0)).toBe(15_000);
  expect(jitteredDelay(30_000, () => 0.99999)).toBe(30_000);
});

test("shutdown cancels polling backoff and starts no new receive cycle", async () => {
  const abort = new AbortController();
  let receives = 0;
  const failures: number[] = [];
  await poll(
    () => {
      receives++;
      return Promise.reject(new Error("offline"));
    },
    abort.signal,
    30_000,
    (attempt) => {
      failures.push(attempt);
      abort.abort();
    },
    undefined,
    true,
  );
  expect({ receives, failures }).toEqual({ receives: 1, failures: [1] });
});
