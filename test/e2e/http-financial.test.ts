import type { OpenAPIObject, OperationObject } from "@nestjs/swagger";
import Ajv from "ajv";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction.use-case";
import { FailureCode } from "../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { createHttpApplication } from "../../src/presentation/http/http-application";
import { drainHttpApplication } from "../../src/presentation/http/shutdown";
import { createDependencyLink } from "../helpers/dependency-link";
import {
  command,
  httpClient,
  json,
  wagerKey,
  type Problem,
  type PublicWallet,
} from "../helpers/http-client";
import { countTransactionEvents, walletEffects } from "../helpers/http-database";
import { createTestDatabase, loadIntegrationConfig } from "../helpers/test-database";
import { waitForWalletWaiters, withWalletLock } from "../helpers/wallet-lock";
import { waitFor } from "../helpers/wait-for";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: Awaited<ReturnType<typeof createHttpApplication>>;
let api: ReturnType<typeof httpClient>;

beforeAll(async () => {
  database = await createTestDatabase();
  const config = {
    ...loadIntegrationConfig(),
    DATABASE_URL: database.url.href,
    INSTANCE_ID: "phase5-http-e2e",
  };
  app = await createHttpApplication(config);
  await app.listen(0, "127.0.0.1");
  api = httpClient(await app.getUrl());
}, 15_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await database?.close();
  }
});

async function open(amount = "100.00") {
  const response = await api.open(amount);
  expect(response.status).toBe(201);
  return response.body;
}

async function consistent(wallet: PublicWallet, amount: string, checkedEntries: number) {
  const response = await api.reconcile(wallet.id);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    walletId: wallet.id,
    storedBalance: { amount, currency: wallet.balance.currency },
    calculatedBalance: { amount, currency: wallet.balance.currency },
    difference: { amount: "0.00", currency: wallet.balance.currency },
    consistent: true,
    checkedEntries,
  });
}

test("creates zero and funded wallets, commits OPENING and rejects concurrent duplicates", async () => {
  const zero = await open("0.00");
  expect(zero.version).toBe(1);
  expect((await api.ledger(zero.id)).body).toEqual({ items: [], nextCursor: null, hasMore: false });
  expect(await walletEffects(database.orm, zero.id)).toEqual({
    wagers: 0,
    debit: 0,
    credit: 0,
    events: 0,
  });
  await consistent(zero, "0.00", 0);
  const player = randomUUID();
  const results = await Promise.all([api.open("100.00", player), api.open("100.00", player)]);
  expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
  const success = results.find(({ status }) => status === 201);
  if (!success) throw new Error("Wallet creation failed");
  const wallet = success.body;
  expect((await api.wallet(wallet.id)).body).toEqual(wallet);
  const entry = (await api.ledger(wallet.id)).body.items[0];
  if (!entry) throw new Error("Missing OPENING ledger entry");
  expect(entry).toMatchObject({
    direction: "CREDIT",
    walletVersion: 1,
    balanceBefore: { amount: "0.00" },
    balanceAfter: wallet.balance,
  });
  expect((await api.transaction(entry.transactionId)).body.kind).toBe(Kind.Opening);
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
  await consistent(wallet, "100.00", 1);
  expect((await api.wallet(randomUUID())).status).toBe(404);
  expect((await api.reconcile(randomUUID())).status).toBe(404);
});

test("processes all external operations with durable lookup, journal and reconciliation", async () => {
  const wallet = await open();
  const bet = command(wallet, Kind.Bet, "30.00");
  const refund = command(wallet, Kind.Refund, "30.00", bet.externalTransactionId);
  const operations = [
    [bet, "70.00", 2, 2],
    [command(wallet, Kind.Win, "50.00", bet.externalTransactionId), "120.00", 3, 3],
    [command(wallet, Kind.Loss, "0.00"), "120.00", 3, 3],
    [refund, "150.00", 4, 4],
    [command(wallet, Kind.Rollback, "30.00", refund.externalTransactionId), "120.00", 5, 5],
  ] as const;
  for (const [request, amount, walletVersion, count] of operations) {
    const result = await api.wager(request);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "PROCESSED",
      balance: { amount },
      walletVersion,
      idempotentReplay: false,
    });
    expect((await api.wallet(wallet.id)).body).toMatchObject({
      balance: { amount },
      version: walletVersion,
    });
    const byId = await api.transaction(result.body.transactionId);
    const byProvider = await api.providerTransaction(
      request.providerId,
      request.externalTransactionId,
    );
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: result.body.transactionId,
      kind: request.kind,
      balance: { amount },
    });
    expect(byProvider.body).toEqual(byId.body);
    const events = await countTransactionEvents(database.orm, result.body.transactionId);
    expect(events).toHaveLength(request.kind === Kind.Loss ? 1 : 2);
    await consistent(wallet, amount, count);
  }
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 6,
    debit: 2,
    credit: 3,
    events: 11,
  });
});

test("replays a historical result, keeps correlation separate and protects both persistent keys", async () => {
  const wallet = await open();
  const bet = command(wallet);
  const original = await api.wager(bet, wagerKey(bet), { "x-correlation-id": "original-http" });
  expect(original.status).toBe(200);
  expect(original.headers.get("x-correlation-id")).toBe("original-http");
  expect((await api.wager(command(wallet, Kind.Win, "50.00"))).body.balance.amount).toBe("125.00");
  const replay = await api.wager(bet, wagerKey(bet), { "x-correlation-id": "retry-http" });
  expect(replay.status).toBe(200);
  expect(replay.headers.get("x-correlation-id")).toBe("retry-http");
  expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  expect(replay.body.balance.amount).toBe("75.00");
  expect(
    (await countTransactionEvents(database.orm, replay.body.transactionId)).map(
      (event) => event.correlation,
    ),
  ).toEqual(["original-http", "original-http"]);

  const changed = await api.request<Problem>(
    "/wagering/transactions",
    json(
      { ...bet, money: { ...bet.money, amount: "50.00" } },
      {
        "idempotency-key": wagerKey(bet),
        "x-correlation-id": "conflict-http",
      },
    ),
  );
  expect(changed.status).toBe(409);
  expect(changed.body.error).toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
    correlationId: "conflict-http",
  });
  const external = await api.request<Problem>(
    "/wagering/transactions",
    json(bet, { "idempotency-key": "new-key" }),
  );
  expect(external.status).toBe(409);
  expect(external.body.error.code).toBe("EXTERNAL_TRANSACTION_CONFLICT");

  const anotherProvider = { ...bet, providerId: "provider-b" };
  const distinct = await api.wager(anotherProvider);
  expect(distinct.status).toBe(200);
  expect(distinct.body.transactionId).not.toBe(replay.body.transactionId);
  expect(
    (await api.providerTransaction("provider-b", bet.externalTransactionId)).body.transactionId,
  ).toBe(distinct.body.transactionId);
  expect((await api.providerTransaction("provider-c", bet.externalTransactionId)).status).toBe(404);
  expect((await api.transaction(randomUUID())).status).toBe(404);
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 4,
    debit: 2,
    credit: 2,
    events: 8,
  });
  await consistent(wallet, "100.00", 4);
});

test("returns auditable 422/202 results, accepts pending replay and exposes terminal state after internal resume", async () => {
  const wallet = await open();
  const insufficient = command(wallet, Kind.Bet, "101.00");
  const rejected = await api.wager(insufficient);
  expect(rejected.status).toBe(422);
  expect(rejected.body).toMatchObject({
    status: "REJECTED",
    failureCode: "INSUFFICIENT_FUNDS",
    balance: { amount: "100.00" },
  });
  const wrongCurrency = { ...command(wallet), money: { amount: "10.00", currency: "USD" } };
  expect((await api.wager(wrongCurrency)).body.failureCode).toBe(FailureCode.CurrencyMismatch);
  const missing = await api.wager({ ...command(wallet), walletId: randomUUID() });
  expect(missing.status).toBe(404);
  const ownership = await api.wager({ ...command(wallet), playerId: randomUUID() });
  expect(ownership.status).toBe(422);
  expect(ownership.body).toMatchObject({ error: { code: "WALLET_OWNERSHIP_MISMATCH" } });

  const bet = command(wallet);
  const refund = command(wallet, Kind.Refund, "25.00", bet.externalTransactionId);
  const pending = await api.wager(refund);
  expect(pending.status).toBe(202);
  expect(pending.body.status).toBe(Status.PendingReference);
  expect((await api.transaction(pending.body.transactionId)).body.status).toBe(
    Status.PendingReference,
  );
  expect((await api.wager(refund)).body).toEqual({ ...pending.body, idempotentReplay: true });
  await consistent(wallet, "100.00", 1);
  expect((await api.wager(bet)).status).toBe(200);
  const after = await app
    .get(ProcessWagerTransactionUseCase)
    .resumePending(pending.body.transactionId);
  expect(after.status).toBe(Status.Processed);
  const resumed = await api.wager(refund);
  expect(resumed.status).toBe(200);
  expect(resumed.body).toEqual({ ...after, idempotentReplay: true });
  const conflict = await api.wager(
    command(wallet, Kind.Rollback, "10.00", bet.externalTransactionId),
  );
  expect(conflict.status).toBe(422);
  expect(conflict.body.failureCode).toBe(FailureCode.AmountMismatch);
  const rejectedAgain = await api.wager(insufficient);
  expect(rejectedAgain.status).toBe(422);
  expect(rejectedAgain.body).toEqual({ ...rejected.body, idempotentReplay: true });
  await consistent(wallet, "100.00", 3);
});

test("returns REVERSAL_INSUFFICIENT_FUNDS with no rollback debit", async () => {
  const wallet = await open("0.00");
  const win = command(wallet, Kind.Win, "50.00");
  expect((await api.wager(win)).status).toBe(200);
  expect((await api.wager(command(wallet, Kind.Bet, "45.00"))).status).toBe(200);
  const reverse = await api.wager(
    command(wallet, Kind.Rollback, "50.00", win.externalTransactionId),
  );
  expect(reverse.status).toBe(422);
  expect(reverse.body.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 3,
    debit: 1,
    credit: 1,
    events: 5,
  });
  await consistent(wallet, "5.00", 2);
});

test("validates DTO, exact money, headers, query, path and malformed or oversized JSON before processing", async () => {
  const wallet = await open();
  const body = command(wallet);
  const headers = { "idempotency-key": wagerKey(body) };
  const walletBody = {
    playerId: randomUUID(),
    initialBalance: { amount: "100.00", currency: "BRL" },
  };
  const invalidWallets: unknown[] = [
    null,
    [],
    {},
    { ...walletBody, extra: true },
    { ...walletBody, playerId: "x".repeat(129) },
    ...[
      25,
      "25",
      "25.1",
      "25.000",
      "25.00\n",
      "1e2",
      "NaN",
      "Infinity",
      "-0.01",
      "0".repeat(37) + ".00",
    ].map((amount) => ({
      ...walletBody,
      initialBalance: { currency: "BRL", amount },
    })),
    ...["ZZZ", "brl", null].map((currency) => ({
      ...walletBody,
      initialBalance: { currency, amount: "0.00" },
    })),
    { ...walletBody, initialBalance: { amount: "0.00" } },
    { ...walletBody, initialBalance: { ...walletBody.initialBalance, extra: true } },
  ];
  for (const invalid of invalidWallets) {
    const result = await api.request<Problem>("/wallets", json(invalid));
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("INVALID_REQUEST");
  }

  const invalidWagers = [
    { ...body, kind: "OPENING" },
    { ...body, kind: "REFUND" },
    { ...body, referenceExternalTransactionId: "unexpected" },
    { ...body, money: { ...body.money, amount: 25 } },
    { ...body, money: { ...body.money, amount: "0.00" } },
    { ...body, idempotencyKey: wagerKey(body) },
    { ...body, correlationId: "in-body" },
    { ...body, externalTransactionId: "unsafe id" },
  ];
  for (const invalid of invalidWagers) {
    expect(
      (await api.request<Problem>("/wagering/transactions", json(invalid, headers))).status,
    ).toBe(400);
  }

  const invalidKeys = [undefined, "", " ", "same,other", "x".repeat(257)];
  for (const key of invalidKeys) {
    const result = await api.request<Problem>(
      "/wagering/transactions",
      json(body, key === undefined ? {} : { "idempotency-key": key }),
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  }
  const malformed = await api.request<Problem>("/wallets", {
    method: "POST",
    headers: { "content-type": "application/json", "x-correlation-id": "malformed-json" },
    body: '{"broken":',
  });
  expect(malformed.status).toBe(400);
  expect(malformed.body.error).toMatchObject({
    code: "INVALID_REQUEST",
    correlationId: "malformed-json",
  });
  const large = await api.request<Problem>("/wallets", json({ ignored: "x".repeat(17_000) }));
  expect(large.status).toBe(413);
  expect(large.body.error.code).toBe("PAYLOAD_TOO_LARGE");

  for (const path of [
    "/wallets/bad%20id",
    "/wallets/id%0A",
    "/wagering/transactions/bad%27id",
    "/providers/bad%20provider/wagering/transactions/valid",
    "/providers/provider/wagering/transactions/bad%20id",
  ]) {
    expect((await api.request<Problem>(path)).status).toBe(400);
  }
  for (const query of [
    "?limit=-1",
    "?limit=101",
    "?limit=2.5",
    "?limit=1%0A",
    "?limit=1&limit=2",
    "?cursor=+",
    "?cursor=",
    "?unknown=1",
  ]) {
    expect((await api.ledger(wallet.id, query)).status).toBe(400);
  }
  const invalidCorrelation = await api.request<Problem>("/health/live", {
    headers: { "x-correlation-id": "bad id" },
  });
  expect(invalidCorrelation.status).toBe(400);
  expect(invalidCorrelation.body.error.code).toBe("INVALID_CORRELATION_ID");
  expect(invalidCorrelation.headers.get("x-correlation-id")).toBe(
    invalidCorrelation.body.error.correlationId,
  );
  expect((await api.wallet(wallet.id)).headers.get("x-correlation-id")).not.toBe(
    (await api.wallet(wallet.id)).headers.get("x-correlation-id"),
  );
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
}, 15_000);

test("paginates more than fifty ledger entries with a wallet-bound cursor while new entries arrive", async () => {
  const wallet = await open();
  const other = await open();
  for (let i = 0; i < 49; i++) {
    const result = await api.wager(command(wallet, Kind.Win, "1.00"));
    expect(result.status).toBe(200);
  }
  const exactlyFifty = await api.ledger(wallet.id);
  expect(exactlyFifty.body.items).toHaveLength(50);
  expect(exactlyFifty.body.nextCursor).toBeNull();
  expect((await api.wager(command(wallet, Kind.Win, "1.00"))).status).toBe(200);
  const first = await api.ledger(wallet.id);
  expect(first.body.items.map((entry) => entry.walletVersion)).toEqual(
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  expect(first.body.hasMore).toBe(true);
  const cursor = first.body.nextCursor;
  if (!cursor) throw new Error("Missing cursor");
  expect((await api.ledger(other.id, `?cursor=${cursor}`)).status).toBe(400);
  const unsupported = Buffer.from(JSON.stringify([2, wallet.id, 50])).toString("base64url");
  expect((await api.ledger(wallet.id, `?cursor=${unsupported}`)).status).toBe(400);
  expect((await api.wager(command(wallet, Kind.Win, "1.00"))).status).toBe(200);
  const second = await api.ledger(wallet.id, `?cursor=${cursor}`);
  expect(second.body.items.map((entry) => entry.walletVersion)).toEqual([51, 52]);
  expect(second.body.nextCursor).toBeNull();
  expect(second.body.hasMore).toBe(false);
  const entries = first.body.items.concat(second.body.items);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(52);
  expect(entries.every((entry) => entry.walletId === wallet.id)).toBe(true);
  await consistent(wallet, "151.00", 52);
}, 25_000);

test("reports a controlled reconciliation mismatch without changing the projection", async () => {
  const wallet = await open();
  await database.orm.em.fork().transactional(async (em) => {
    await em.execute("alter table wagering.wallets disable trigger guard_wallet_projection");
    await em.execute("update wagering.wallets set balance = 90.00 where id = ?", [wallet.id]);
    await em.execute("alter table wagering.wallets enable trigger guard_wallet_projection");
  });
  const result = await api.reconcile(wallet.id);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    storedBalance: { amount: "90.00" },
    calculatedBalance: { amount: "100.00" },
    difference: { amount: "-10.00" },
    consistent: false,
    checkedEntries: 1,
  });
  expect((await api.wallet(wallet.id)).body.balance.amount).toBe("90.00");
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
});

test("shows unavailable persistence as 503, preserves liveness and recovers the same key", async () => {
  const config = loadIntegrationConfig();
  const proxy = await createDependencyLink(new URL(database.url.href), 5432);
  const alternative = await createHttpApplication({ ...config, DATABASE_URL: proxy.url.href });
  try {
    await alternative.listen(0, "127.0.0.1");
    const client = httpClient(await alternative.getUrl());
    const wallet = await open();
    const wager = command(wallet);
    expect((await client.request("/health/ready")).status).toBe(200);
    proxy.setAvailable(false);
    const result = await client.request<Problem>(
      "/wagering/transactions",
      json(wager, { "idempotency-key": wagerKey(wager) }),
    );
    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBe("1");
    expect(result.body.error.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect((await client.request("/health/live")).status).toBe(200);
    expect((await client.request("/health/ready")).body).toMatchObject({
      checks: { postgres: "down", sqs: "up" },
    });
    expect(await walletEffects(database.orm, wallet.id)).toEqual({
      wagers: 1,
      debit: 0,
      credit: 1,
      events: 2,
    });
    proxy.setAvailable(true);
    await waitFor(
      async () => ((await client.request("/health/ready")).status === 200 ? true : undefined),
      "readiness HTTP",
    );
    expect((await client.wager(wager)).status).toBe(200);
    expect((await client.wager(wager)).body.idempotentReplay).toBe(true);
    await consistent(wallet, "75.00", 2);
  } finally {
    try {
      await alternative.close();
    } finally {
      await proxy.close();
    }
  }
}, 20_000);

test("an exhausted connection pool produces a retryable HTTP error without financial writes", async () => {
  const wallet = await open();
  const commands = Array.from({ length: 45 }, () => command(wallet));
  const timeouts = await withWalletLock(database.orm, wallet.id, async () => {
    const results = Promise.all(
      commands.map((body) =>
        api.request<Problem>(
          "/wagering/transactions",
          json(body, { "idempotency-key": wagerKey(body) }),
        ),
      ),
    );
    await waitForWalletWaiters(database.orm, 1, ["phase5-http-e2e"]);
    return results;
  });
  expect(timeouts.every(({ status }) => status === 503)).toBe(true);
  expect(timeouts.some(({ body }) => body.error.code === "LOCK_TIMEOUT")).toBe(true);
  expect(timeouts.some(({ body }) => body.error.code === "PERSISTENCE_UNAVAILABLE")).toBe(true);
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
  const [first] = commands;
  if (!first) throw new Error("Missing wager");
  expect((await api.wager(first)).status).toBe(200);
  await consistent(wallet, "75.00", 2);
}, 12_000);

test("a client request deadline leaves the wager safe to repeat with the original key", async () => {
  const wallet = await open();
  const body = command(wallet);
  await withWalletLock(database.orm, wallet.id, async () => {
    const deadline = AbortSignal.timeout(750);
    const initial = api
      .request("/wagering/transactions", {
        ...json(body, { "idempotency-key": wagerKey(body) }),
        signal: deadline,
      })
      .then(
        () => true,
        () => false,
      );
    await waitForWalletWaiters(database.orm, 1, ["phase5-http-e2e"]);
    expect(await initial).toBe(false);
    expect(deadline.aborted).toBe(true);
  });
  const retry = await api.wager(body);
  expect(retry.status).toBe(200);
  expect((await api.wager(body)).body).toEqual({ ...retry.body, idempotentReplay: true });
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 2,
    debit: 1,
    credit: 1,
    events: 4,
  });
  await consistent(wallet, "75.00", 2);
}, 12_000);

test("publishes all nine OpenAPI operations and validates requests and live responses against schemas", async () => {
  const document = await api.request<OpenAPIObject>("/docs-json");
  expect(document.status).toBe(200);
  const operations = {
    "/wallets": "post",
    "/wallets/{walletId}": "get",
    "/wallets/{walletId}/ledger": "get",
    "/wallets/{walletId}/reconciliation": "post",
    "/wagering/transactions": "post",
    "/wagering/transactions/{transactionId}": "get",
    "/providers/{providerId}/wagering/transactions/{externalTransactionId}": "get",
    "/health/live": "get",
    "/health/ready": "get",
  } as const;
  const ajv = new Ajv({ validateFormats: false, strict: false });
  for (const [path, method] of Object.entries(operations)) {
    expect(document.body.paths[path]?.[method]).toBeDefined();
  }

  function validateResponse(
    operation: OperationObject | undefined,
    status: number,
    value: unknown,
  ) {
    const response = operation?.responses[String(status)];
    const schema =
      response && "content" in response
        ? response.content?.["application/json"]?.schema
        : undefined;
    if (!schema) throw new Error(`Undocumented HTTP ${status}`);
    const validator = ajv.compile(schema);
    if (!validator(value)) throw new Error(ajv.errorsText(validator.errors));
  }

  const creation = await api.open();
  validateResponse(document.body.paths["/wallets"]?.post, creation.status, creation.body);
  const wallet = creation.body;
  const submit = document.body.paths["/wagering/transactions"]?.post;
  expect(
    submit?.parameters?.some(
      (param) =>
        "name" in param &&
        param.name === "Idempotency-Key" &&
        param.in === "header" &&
        param.required === true,
    ),
  ).toBe(true);
  expect(
    submit?.parameters?.some(
      (param) => "name" in param && param.name === "X-Correlation-Id" && param.required === false,
    ),
  ).toBe(true);
  const body = submit?.requestBody;
  const schema = body && "content" in body ? body.content["application/json"]?.schema : undefined;
  if (!schema) throw new Error("Missing request schema");
  const validate = ajv.compile(schema);
  const bet = command(wallet);
  expect(validate(bet)).toBe(true);
  expect(validate({ ...bet, money: { ...bet.money, amount: 1 } })).toBe(false);
  expect(validate({ ...bet, kind: Kind.Opening })).toBe(false);
  expect(validate({ ...bet, kind: Kind.Refund })).toBe(false);
  expect(validate({ ...bet, extra: true })).toBe(false);

  const processed = await api.wager(bet);
  expect(processed.status).toBe(200);
  validateResponse(submit, processed.status, processed.body);
  const rejected = await api.wager(command(wallet, Kind.Bet, "99.00"));
  expect(rejected.status).toBe(422);
  validateResponse(submit, rejected.status, rejected.body);
  const pending = await api.wager(command(wallet, Kind.Refund, "25.00", randomUUID()));
  expect(pending.status).toBe(202);
  validateResponse(submit, pending.status, pending.body);
  const conflicting = await api.wager({ ...bet, money: { ...bet.money, amount: "50.00" } });
  expect(conflicting.status).toBe(409);
  validateResponse(submit, conflicting.status, conflicting.body);

  const ledger = await api.ledger(wallet.id, "?limit=1");
  validateResponse(
    document.body.paths["/wallets/{walletId}/ledger"]?.get,
    ledger.status,
    ledger.body,
  );
  const audit = await api.reconcile(wallet.id);
  validateResponse(
    document.body.paths["/wallets/{walletId}/reconciliation"]?.post,
    audit.status,
    audit.body,
  );
  await consistent(wallet, "75.00", 2);
});

test("shutdown closes listening sockets and drains an accepted financial request to commit", async () => {
  const alternative = await createHttpApplication({
    ...loadIntegrationConfig(),
    DATABASE_URL: database.url.href,
    INSTANCE_ID: "phase5-elo-drain",
  });
  let draining: Promise<void> | undefined;
  try {
    await alternative.listen(0, "127.0.0.1");
    const url = await alternative.getUrl();
    const client = httpClient(url);
    const wallet = await open();
    const request = command(wallet);
    const inFlight = await withWalletLock(database.orm, wallet.id, async () => {
      const response = client.wager(request);
      await waitForWalletWaiters(database.orm, 1, ["phase5-elo-drain"]);
      draining = drainHttpApplication(alternative, 5000);
      const accepted = await fetch(`${url}/health/live`, {
        headers: { connection: "close" },
        signal: AbortSignal.timeout(1000),
        keepalive: false,
      }).then(
        () => true,
        () => false,
      );
      expect(accepted).toBe(false);
      return { response };
    });
    const committed = await inFlight.response;
    expect(committed.status).toBe(200);
    expect(committed.body.balance.amount).toBe("75.00");
    await draining;
    expect((await api.wager(request)).body).toEqual({ ...committed.body, idempotentReplay: true });
    await consistent(wallet, "75.00", 2);
  } finally {
    await (draining ?? alternative.close());
  }
}, 12_000);

test("sanitizes unexpected persistence errors and rolls back amount overflow", async () => {
  const wallet = await open("999999999999999999999999999999999999.99");
  const win = command(wallet, Kind.Win, "0.01");
  const result = await api.request<Problem>(
    "/wagering/transactions",
    json(win, {
      "idempotency-key": wagerKey(win),
      "x-correlation-id": "overflow-case",
    }),
  );
  expect(result.status).toBe(500);
  expect(result.body).toEqual({
    error: {
      code: "INTERNAL_ERROR",
      message: "Unexpected server error",
      correlationId: "overflow-case",
    },
  });
  expect(JSON.stringify(result.body)).not.toContain("wagering.");
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
  await consistent(wallet, wallet.balance.amount, 1);
});
