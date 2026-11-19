import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { FailureCode } from "../../src/domain/shared/failure-code";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../src/domain/wagering/wager-transaction";
import { launchApi } from "../helpers/api-process";
import { command, httpClient, type PublicWallet } from "../helpers/http-client";
import { countTransactionEvents, walletEffects } from "../helpers/http-database";
import { createTestDatabase } from "../helpers/test-database";
import { waitForWalletWaiters, withWalletLock } from "../helpers/wallet-lock";
import { waitFor } from "../helpers/wait-for";

type Instance = Awaited<ReturnType<typeof launchApi>>;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let first: Instance;
let second: Instance;
let third: Instance;
const all = new Set<Instance>();

async function start(id: string, port?: number): Promise<Instance> {
  const instance = await launchApi(database.url, id, port);
  all.add(instance);
  return instance;
}

beforeAll(async () => {
  database = await createTestDatabase();
  // Settle every launch before teardown can drop the shared database.
  const started = await Promise.allSettled([
    start("phase5-api-1"),
    start("phase5-api-2"),
    start("phase5-api-3"),
  ]);
  const values = started.map((item) => {
    if (item.status === "rejected")
      throw new Error("Three API processes are required", { cause: item.reason });
    return item.value;
  });
  const [a, b, c] = values;
  if (!a || !b || !c) throw new Error("Missing API process");
  [first, second, third] = [a, b, c];
}, 25_000);

afterAll(async () => {
  try {
    await Promise.all([...all].map((instance) => instance.stop()));
  } finally {
    await database?.close();
  }
});

async function open(instance = first) {
  const result = await instance.client.open();
  expect(result.status).toBe(201);
  return result.body;
}

async function audit(wallet: PublicWallet, balance: string, credit: number, debit: number) {
  const result = await third.client.reconcile(wallet.id);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    storedBalance: { amount: balance },
    calculatedBalance: { amount: balance },
    consistent: true,
    checkedEntries: credit + debit,
  });
  expect(await walletEffects(database.orm, wallet.id)).toMatchObject({ credit, debit });
}

test("three distinct Bun processes on distinct ports share one PostgreSQL", async () => {
  const instances = [first, second, third];
  expect(new Set(instances.map(({ pid }) => pid)).size).toBe(3);
  expect(new Set(instances.map(({ port }) => port)).size).toBe(3);
  const health = await Promise.all(instances.map(({ client }) => client.request("/health/ready")));
  expect(health.map(({ status }) => status)).toEqual([200, 200, 200]);
  const wallet = await open();
  expect((await second.client.wallet(wallet.id)).body).toEqual(wallet);
  expect((await third.client.wallet(wallet.id)).body).toEqual(wallet);
  await audit(wallet, "100.00", 1, 0);
  const player = randomUUID();
  const creations = await Promise.all(instances.map(({ client }) => client.open("100.00", player)));
  expect(creations.map(({ status }) => status).sort()).toEqual([201, 409, 409]);
  const funded = creations.find(({ status }) => status === 201);
  if (!funded) throw new Error("Wallet not created");
  expect(await walletEffects(database.orm, funded.body.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
});

test("two 80.00 BETs converge to one debit of 80.00 in three synchronized trials", async () => {
  for (let trial = 0; trial < 3; trial++) {
    const wallet = await open();
    const betA = command(wallet, Kind.Bet, "80.00");
    const betB = command(wallet, Kind.Bet, "80.00");
    const contenders = [first, second] as const;
    const requests = [betA, betB] as const;
    const flights: ReturnType<Instance["client"]["wager"]>[] = [];
    await withWalletLock(database.orm, wallet.id, async () => {
      flights.push(first.client.wager(betA), second.client.wager(betB));
      await waitForWalletWaiters(
        database.orm,
        2,
        contenders.map(({ id }) => id),
      );
    });
    const original = await Promise.all(flights);
    expect(original.map(({ status }) => status).sort()).toEqual([200, 422]);
    const approved = original.find(({ status }) => status === 200);
    const rejected = original.find(({ status }) => status === 422);
    expect(approved?.body).toMatchObject({
      status: Status.Processed,
      balance: { amount: "20.00" },
    });
    expect(rejected?.body).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: { amount: "20.00" },
    });
    for (const [index, originalResult] of original.entries()) {
      const request = requests[index];
      if (!request) throw new Error("Missing original request");
      const replay = await third.client.wager(request);
      expect(replay.status).toBe(originalResult.status);
      expect(replay.body).toEqual({ ...originalResult.body, idempotentReplay: true });
    }
    expect(await walletEffects(database.orm, wallet.id)).toEqual({
      wagers: 3,
      debit: 1,
      credit: 1,
      events: 5,
    });
    await audit(wallet, "20.00", 1, 1);
  }
}, 20_000);

test("50 simultaneous copies across three processes create one wager, one debit and one set of events", async () => {
  const wallet = await open();
  const body = command(wallet);
  const instances = [first, second, third];
  const flights: ReturnType<Instance["client"]["wager"]>[] = [];
  await withWalletLock(database.orm, wallet.id, async () => {
    for (let index = 0; index < 50; index++) {
      const target = instances[index % instances.length];
      if (!target) throw new Error("Missing target");
      flights.push(target.client.wager(body));
    }
    await waitForWalletWaiters(
      database.orm,
      3,
      instances.map(({ id }) => id),
    );
  });
  const results = await Promise.all(flights);
  expect(results.every(({ status }) => status === 200)).toBe(true);
  const originals = results.filter(({ body: result }) => !result.idempotentReplay);
  expect(originals).toHaveLength(1);
  const transactionId = originals[0]?.body.transactionId;
  if (!transactionId) throw new Error("Missing canonical transaction ID");
  expect(
    results.every(
      ({ body: result }) =>
        result.transactionId === transactionId && result.balance.amount === "75.00",
    ),
  ).toBe(true);
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 2,
    debit: 1,
    credit: 1,
    events: 4,
  });
  expect(
    (await countTransactionEvents(database.orm, transactionId))
      .map(({ event_type }) => event_type)
      .sort(),
  ).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  await audit(wallet, "75.00", 1, 1);
}, 20_000);

test("independent wallets finish while one is locked, then a 503 retries without partial effects", async () => {
  const [blocked, b, c] = await Promise.all([open(first), open(second), open(third)]);
  const pendingBet = command(blocked);
  const started = performance.now();
  await withWalletLock(database.orm, blocked.id, async () => {
    const pending = first.client.wager(pendingBet);
    await waitForWalletWaiters(database.orm, 1, [first.id]);
    const [win, bet, snapshot] = await Promise.all([
      second.client.wager(command(b, Kind.Win, "20.00")),
      third.client.wager(command(c)),
      third.client.reconcile(blocked.id),
    ]);
    expect(win.body.balance.amount).toBe("120.00");
    expect(bet.body.balance.amount).toBe("75.00");
    expect(snapshot.body).toMatchObject({
      consistent: true,
      storedBalance: { amount: "100.00" },
      checkedEntries: 1,
    });
    const timedOut = await pending;
    expect(timedOut.status).toBe(503);
    expect(timedOut.body).toMatchObject({ error: { code: "LOCK_TIMEOUT" } });
    expect(timedOut.headers.get("retry-after")).toBe("1");
  });
  expect(await walletEffects(database.orm, blocked.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
  expect((await third.client.wager(pendingBet)).body.idempotentReplay).toBe(false);
  await audit(blocked, "75.00", 1, 1);
  await audit(b, "120.00", 2, 0);
  await audit(c, "75.00", 1, 1);
  expect(
    (await second.client.ledger(c.id)).body.items.every((entry) => entry.walletId === c.id),
  ).toBe(true);
  console.log(
    `Independent-wallet and lock timeout scenario completed in ${Math.round(performance.now() - started)} ms`,
  );
}, 15_000);

test.each([Kind.Refund, Kind.Rollback])(
  "two concurrent %s commands allow one reversal and replay across instances",
  async (kind) => {
    const wallet = await open();
    const bet = command(wallet, Kind.Bet, "30.00");
    expect((await first.client.wager(bet)).status).toBe(200);
    const commands = [
      command(wallet, kind, "30.00", bet.externalTransactionId),
      command(wallet, kind, "30.00", bet.externalTransactionId),
    ] as const;
    const pending: ReturnType<Instance["client"]["wager"]>[] = [];
    await withWalletLock(database.orm, wallet.id, async () => {
      pending.push(second.client.wager(commands[0]), third.client.wager(commands[1]));
      await waitForWalletWaiters(database.orm, 2, [second.id, third.id]);
    });
    const results = await Promise.all(pending);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 422]);
    expect(results.find(({ status }) => status === 422)?.body.failureCode).toBe(
      FailureCode.AlreadyReversed,
    );
    const winner = results.findIndex(({ status }) => status === 200);
    const result = results[winner];
    const request = commands[winner];
    if (!result || !request) throw new Error("Missing winning reversal");
    expect((await first.client.wager(request)).body).toEqual({
      ...result.body,
      idempotentReplay: true,
    });
    expect(await walletEffects(database.orm, wallet.id)).toEqual({
      wagers: 4,
      debit: 1,
      credit: 2,
      events: 7,
    });
    await audit(wallet, "100.00", 2, 1);
  },
  15_000,
);

test("restarts one API after commit and recovers the same snapshot while the others continue", async () => {
  const wallet = await open();
  const request = command(wallet);
  const original = await first.client.wager(request, undefined, {
    "x-correlation-id": "before-restart",
  });
  expect(original.status).toBe(200);
  const previous = first;
  await previous.stop();
  expect(
    await fetch(`${previous.url}/health/live`, { signal: AbortSignal.timeout(1_000) }).then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect((await second.client.wager(command(wallet, Kind.Win, "50.00"))).body.balance.amount).toBe(
    "125.00",
  );
  expect((await third.client.wager(request)).body).toEqual({
    ...original.body,
    idempotentReplay: true,
  });

  first = await start(previous.id, previous.port);
  expect(first.pid).not.toBe(previous.pid);
  expect((await first.client.wager(request)).body).toEqual({
    ...original.body,
    idempotentReplay: true,
  });
  const persisted = await first.client.providerTransaction(
    request.providerId,
    request.externalTransactionId,
  );
  expect(persisted.body).toMatchObject({
    transactionId: original.body.transactionId,
    balance: { amount: "75.00" },
  });
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 3,
    debit: 1,
    credit: 2,
    events: 6,
  });
  await audit(wallet, "125.00", 2, 1);
  const output = await previous.stdout;
  const logged = output.split(/\r?\n/).filter((line) => line.includes("before-restart"));
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain('"route":"/wagering/transactions"');
  expect(logged[0]).toContain('"instanceId":"phase5-api-1"');
  expect(logged[0]).not.toContain('"amount"');
}, 20_000);

test("a response discarded by the transport after commit is recovered on another API", async () => {
  const wallet = await open();
  const request = command(wallet);
  const sockets = new Set<Socket>();
  let upstreamStatus = "";
  const relay = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: first.port });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.pipe(upstream);
    let responsePrefix = "";
    upstream.on("data", (chunk) => {
      responsePrefix += chunk.toString("utf8");
      const end = responsePrefix.indexOf("\r\n");
      if (end === -1) return;
      upstreamStatus = responsePrefix.slice(0, end);
      client.destroy();
      upstream.destroy();
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("Missing relay port");
    const client = httpClient(`http://127.0.0.1:${address.port}`);
    expect(
      await client.wager(request).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    expect(upstreamStatus).toMatch(/^HTTP\/1\.[01] 200 /);
    const persisted = await second.client.providerTransaction(
      request.providerId,
      request.externalTransactionId,
    );
    expect(persisted.status).toBe(200);
    const retry = await third.client.wager(request);
    expect(retry.body).toMatchObject({
      transactionId: persisted.body.transactionId,
      balance: { amount: "75.00" },
      idempotentReplay: true,
    });
    expect(await walletEffects(database.orm, wallet.id)).toEqual({
      wagers: 2,
      debit: 1,
      credit: 1,
      events: 4,
    });
    await audit(wallet, "75.00", 1, 1);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
}, 15_000);

test("killing a process during an observed SQL lock wait aborts its transaction and a retry debits once", async () => {
  const wallet = await open();
  const request = command(wallet);
  const processToKill = first;
  await withWalletLock(database.orm, wallet.id, async () => {
    const lost = processToKill.client.wager(request).then(
      () => false,
      () => true,
    );
    await waitForWalletWaiters(database.orm, 1, [processToKill.id]);
    await processToKill.stop();
    expect(await lost).toBe(true);
    expect((await second.client.reconcile(wallet.id)).body.storedBalance.amount).toBe("100.00");
  });
  await waitFor(async () => {
    const [row] = await database.orm.em
      .getConnection()
      .execute<{ sessions: number }[]>(
        "select count(*)::int as sessions from pg_stat_activity where datname = current_database() and application_name = ?",
        [processToKill.id],
      );
    return row?.sessions === 0 ? true : undefined;
  }, "aborted process PostgreSQL sessions");
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 1,
    debit: 0,
    credit: 1,
    events: 2,
  });
  const recovery = await second.client.wager(request);
  expect(recovery.status).toBe(200);
  expect(recovery.body.idempotentReplay).toBe(false);
  first = await start(processToKill.id, processToKill.port);
  expect((await first.client.wager(request)).body).toEqual({
    ...recovery.body,
    idempotentReplay: true,
  });
  expect(await walletEffects(database.orm, wallet.id)).toEqual({
    wagers: 2,
    debit: 1,
    credit: 1,
    events: 4,
  });
  await audit(wallet, "75.00", 1, 1);
}, 20_000);
