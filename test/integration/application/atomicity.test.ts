import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ProcessWagerTransactionUseCase } from "../../../src/application/use-cases/process-wager-transaction.use-case";
import type { FinancialRepositories } from "../../../src/application/ports/repositories/financial-repositories";
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../../src/domain/wagering/wager-transaction";
import {
  barrier,
  command,
  financialApplication,
  financeRuntime,
  instrumentTransactions,
  replaceMethod,
} from "../../helpers/application-fixtures";
import { createTestDatabase } from "../../helpers/test-database";
import { failureFrom } from "../../helpers/failure-from";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof financialApplication>;
beforeAll(async () => {
  database = await createTestDatabase();
  app = financialApplication(database.orm);
}, 15_000);
afterAll(async () => database?.close());

function counts() {
  return database.orm.em.getConnection().execute<
    {
      wallets: number;
      wagers: number;
      ledger: number;
      inbox: number;
      outbox: number;
    }[]
  >(`
    select
      (select count(*)::int from wagering.wallets) as wallets,
      (select count(*)::int from wagering.wager_transactions) as wagers,
      (select count(*)::int from wagering.wallet_ledger_entries) as ledger,
      (select count(*)::int from wagering.inbox_messages) as inbox,
      (select count(*)::int from wagering.outbox_messages) as outbox
  `);
}

const stages = [
  "before-wager",
  "after-wager",
  "before-ledger",
  "after-ledger",
  "before-outbox",
  "after-outbox",
  "after-inbox",
  "before-commit",
] as const;
type Stage = (typeof stages)[number];

function failAt(repo: FinancialRepositories, stage: Stage, failure: Error): FinancialRepositories {
  const stop = (point: Stage) => {
    if (point === stage) throw failure;
  };
  return {
    ...repo,
    wagers: replaceMethod(repo.wagers, "insert", async (...args) => {
      stop("before-wager");
      await repo.wagers.insert(...args);
      stop("after-wager");
    }),
    wallets: replaceMethod(repo.wallets, "saveMovement", async (...args) => {
      stop("before-ledger");
      await repo.wallets.saveMovement(...args);
      stop("after-ledger");
    }),
    outbox: replaceMethod(repo.outbox, "insert", async (message) => {
      stop("before-outbox");
      await repo.outbox.insert(message);
      if (message.eventType === "WalletBalanceChanged") stop("after-outbox");
    }),
    inbox: replaceMethod(repo.inbox, "insert", async (message) => {
      await repo.inbox.insert(message);
      stop("after-inbox");
    }),
  };
}

function withFailure(stage: Stage) {
  const failure = new Error(`Injected failure: ${stage}`);
  const manager = instrumentTransactions(
    app.manager,
    (r) => failAt(r, stage, failure),
    () => {
      if (stage === "before-commit") throw failure;
    },
  );
  return { failure, application: financialApplication(database.orm, manager) };
}

test.each(stages.filter((stage) => stage !== "after-inbox"))(
  "opening rolls back all rows at %s",
  async (stage) => {
    const before = await counts();
    const playerId = randomUUID();
    const { failure, application } = withFailure(stage);
    const thrown = await failureFrom(
      application.create.execute({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    );
    expect(thrown).toBe(failure);
    expect(await counts()).toEqual(before);
    expect(
      await app.manager.execute(({ wallets }) => wallets.findByPlayerAndCurrency(playerId, "BRL")),
    ).toBeUndefined();
  },
);

test.each(stages)(
  "wager keeps all tables and wallet intact at %s, then can be retried",
  async (stage) => {
    const wallet = await app.open("100.00");
    const request = command(wallet, Kind.Bet, "25.00", {
      inbox: { consumerName: "processor", messageId: randomUUID() },
    });
    const before = await counts();
    const { failure, application } = withFailure(stage);
    expect(await failureFrom(application.process.execute(request))).toBe(failure);
    expect(await counts()).toEqual(before);
    expect(await app.wallet.execute(wallet.id)).toEqual(wallet);
    expect(
      await app.manager.execute(({ wagers }) =>
        wagers.findByIdempotencyKey(request.idempotencyKey),
      ),
    ).toBeUndefined();
    const initial = await app.manager.execute(({ ledger }) => ledger.auditBalance(wallet.id));
    expect(initial?.calculatedBalance.toString()).toBe("100.00");
    expect(initial?.checkedEntries).toBe(1);
    expect(initial?.consistent).toBe(true);

    const result = await app.process.execute(request);
    expect(result.idempotentReplay).toBe(false);
    expect(result.status).toBe(Status.Processed);
    expect(result.balance.amount).toBe("75.00");
    const final = await app.manager.execute(({ ledger }) => ledger.auditBalance(wallet.id));
    expect(final?.calculatedBalance.toString()).toBe("75.00");
    expect(final?.checkedEntries).toBe(2);
    expect(final?.consistent).toBe(true);
    expect(await app.process.execute(request)).toEqual({ ...result, idempotentReplay: true });
  },
);

test("an actual outbox primary key violation rolls back all financial writes", async () => {
  const wallet = await app.open();
  const request = command(wallet, Kind.Bet, "25.00", {
    inbox: { consumerName: "processor", messageId: randomUUID() },
  });
  const before = await counts();
  const eventId = randomUUID();
  const ids = [randomUUID(), randomUUID(), eventId, eventId];
  const failingProcessor = new ProcessWagerTransactionUseCase(app.manager, {
    ...financeRuntime,
    ids: {
      next() {
        const id = ids.shift();
        if (!id) throw new Error("Unexpected ID allocation");
        return id;
      },
    },
  });
  expect(await failureFrom(failingProcessor.execute(request))).toMatchObject({ code: "23505" });
  expect(await counts()).toEqual(before);
  expect(await app.wallet.execute(wallet.id)).toEqual(wallet);
  expect(
    await app.manager.execute(({ wagers }) => wagers.findByIdempotencyKey(request.idempotencyKey)),
  ).toBeUndefined();
  expect((await app.process.execute(request)).balance.amount).toBe("75.00");
});

test("one aborted outbox write does not undo a concurrent commit on another wallet", async () => {
  const blocked = await app.open("100.00");
  const independent = await app.open("100.00");
  const reached = barrier();
  const release = barrier();
  const failure = new Error("outbox write failed");
  const manager = instrumentTransactions(app.manager, (repos) => ({
    ...repos,
    outbox: replaceMethod(repos.outbox, "insert", async (message) => {
      await repos.outbox.insert(message);
      reached.release();
      await release.reached;
      throw failure;
    }),
  }));
  const aborted = financialApplication(database.orm, manager);
  const pending = aborted.process.execute(command(blocked));
  const observedFailure = failureFrom(pending);
  try {
    await Promise.race([reached.reached, observedFailure]);
    const committed = await app.process.execute(command(independent, Kind.Win, "10.00"));
    expect(committed.balance.amount).toBe("110.00");
    expect((await app.wallet.execute(blocked.id)).balance.amount).toBe("100.00");
  } finally {
    release.release();
  }
  expect(await observedFailure).toBe(failure);
  const audits = await app.manager.execute(async ({ ledger }) => [
    await ledger.auditBalance(blocked.id),
    await ledger.auditBalance(independent.id),
  ]);
  expect(audits.map((item) => item?.storedBalance.toString())).toEqual(["100.00", "110.00"]);
  expect(audits.map((item) => item?.checkedEntries)).toEqual([1, 2]);
  expect(audits.every((item) => item?.consistent)).toBe(true);
}, 15_000);
