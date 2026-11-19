import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { ApplicationError } from "../../src/application/errors/application-error";
import type { ProcessWagerResult } from "../../src/application/results/financial-results";
import { WagerTransactionStatus as Status } from "../../src/domain/wagering/wager-transaction";
import { parseWagerMessage } from "../../src/infrastructure/messaging/wager-message";
import { logRecord } from "../../src/infrastructure/observability/logger";
import { DependencyProbe } from "../../src/infrastructure/observability/dependency-probe";
import { Metrics, operationMetrics } from "../../src/infrastructure/observability/metrics";
import { observeWager } from "../../src/infrastructure/observability/wager-observation";
import { failureFrom } from "../helpers/failure-from";

describe("operational telemetry", () => {
  test("dependency timeouts share one in-flight attempt and recover on the next probe", async () => {
    let complete = () => {};
    let attempts = 0;
    const probe = new DependencyProbe(() => {
      attempts++;
      return attempts === 1
        ? new Promise<void>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve();
    }, 15);
    expect(await Promise.all([probe.check(), probe.check()])).toEqual(["down", "down"]);
    expect(attempts).toBe(1);
    complete();
    await Bun.sleep(1);
    expect(await probe.check()).toBe("up");
    expect(attempts).toBe(2);
  });
  test("emits JSON with trace identifiers and omits payloads, stacks and secrets", () => {
    const record = logRecord(
      {
        event: "sqs.message.retry",
        messageId: "message-1",
        correlationId: "correlation-1",
        transactionId: "transaction-1",
        walletId: "wallet-1",
        providerId: "provider-1",
        code: "DATABASE_UNAVAILABLE",
        authorization: "Bearer secret-token",
        password: "fake-password",
        DATABASE_URL: "postgresql://user:password@host/db",
        payload: { amount: "100.00", currency: "BRL" },
        stack: new Error("raw SQL with arguments"),
        route: "postgresql://user:password@host/db",
      },
      "warn",
      "SqsWagerConsumer",
      "consumer-1",
    );
    const line = JSON.stringify(record);
    expect(JSON.parse(line)).toMatchObject({
      level: "warn",
      instanceId: "consumer-1",
      messageId: "message-1",
      transactionId: "transaction-1",
      walletId: "wallet-1",
      providerId: "provider-1",
      correlationId: "correlation-1",
      errorCode: "DATABASE_UNAVAILABLE",
    });
    expect(record.timestamp).toEqual(new Date(record.timestamp).toISOString());
    expect(line).not.toMatch(/secret-token|password|raw SQL|100\.00|authorization|payload/);
  });

  test("isolates concurrent asynchronous contexts and limits labels to allowed values", async () => {
    const api = new Metrics("api-1");
    const worker = new Metrics("worker-1", "consumer");
    const result: ProcessWagerResult = {
      transactionId: "private-id",
      status: Status.Processed,
      idempotentReplay: false,
      balance: { amount: "10.00", currency: "BRL" },
      walletVersion: 2,
    };
    await Promise.all([
      observeWager(api, "http", async () => {
        await Bun.sleep(10);
        expect(operationMetrics.getStore()?.metrics).toBe(api);
        return result;
      }),
      observeWager(worker, "sqs", async () => {
        await Bun.sleep(1);
        expect(operationMetrics.getStore()?.metrics).toBe(worker);
        return { ...result, idempotentReplay: true };
      }),
    ]);
    await observeWager(api, "http", () => Promise.resolve({ ...result, status: Status.Rejected }));
    expect(
      await failureFrom(
        observeWager(api, "http", () =>
          Promise.reject(new ApplicationError("IDEMPOTENCY_CONFLICT", "conflict")),
        ),
      ),
    ).toBeInstanceOf(ApplicationError);
    expect(operationMetrics.getStore()).toBeUndefined();
    api.record("wager_transactions_total", 1, "private-id", "REJECTED");
    expect(api.snapshot().metrics).toMatchObject({
      wager_transactions_total: [
        { labels: { source: "http", status: "PROCESSED" }, value: 1 },
        { labels: { source: "http", status: "REJECTED" }, value: 1 },
      ],
      wager_processing_duration_seconds: [{ type: "histogram", count: 3 }],
      wager_idempotency_conflicts_total: [{ value: 1 }],
    });
    expect(JSON.stringify(api.snapshot())).not.toContain("private-id");
    expect(worker.snapshot().metrics.wager_idempotency_duplicates_total).toEqual([
      { type: "counter", labels: { source: "sqs" }, value: 1 },
    ]);
  });

  test("serves JSON on loopback in a listener independent of the financial API", async () => {
    const metrics = new Metrics("api-2");
    const server = metrics.serve(0);
    try {
      expect(server.url.hostname).toBe("127.0.0.1");
      const response = await fetch(new URL("/metrics", server.url));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ instanceId: "api-2" });
      expect((await fetch(new URL("/wallets", server.url))).status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("validates correlation and causation with a legacy message ID fallback", () => {
    const envelope = {
      messageId: "message-1",
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider",
        externalTransactionId: "transaction",
        walletId: "wallet",
        playerId: "player",
        roundId: "round",
        gameId: "game",
        kind: "BET",
        idempotencyKey: "business-key",
        money: { amount: "20.00", currency: "BRL" },
      },
    };
    expect(parseWagerMessage(JSON.stringify(envelope), "worker").correlationId).toBe("message-1");
    expect(
      parseWagerMessage(
        JSON.stringify({ ...envelope, correlationId: "corr", causationId: "cause" }),
        "worker",
      ),
    ).toMatchObject({
      correlationId: "corr",
      causationId: "cause",
      inbox: { messageId: "message-1" },
    });
    expect(() =>
      parseWagerMessage(JSON.stringify({ ...envelope, causationId: "invalid cause" }), "worker"),
    ).toThrow("INVALID_ENVELOPE");
  });
});
