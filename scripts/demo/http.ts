import { randomUUID } from "node:crypto";
import { z } from "zod";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
if (
  !["http:", "https:"].includes(baseUrl.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
) {
  throw new Error("Use a local HTTP API URL for the demo");
}

async function post(
  route: string,
  expected: number,
  body?: object,
  key?: string,
): Promise<unknown> {
  const headers = new Headers();
  if (body) headers.set("Content-Type", "application/json");
  if (key) headers.set("Idempotency-Key", key);
  const response = await fetch(new URL(route, baseUrl), {
    method: "POST",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  const value: unknown = await response.json();
  if (response.status !== expected)
    throw new Error(`${route} returned ${response.status}, expected ${expected}`);
  return value;
}

const walletSchema = z.object({ id: z.string() });
const wagerSchema = z.object({
  transactionId: z.string(),
  status: z.literal("PROCESSED"),
  balance: z.object({ amount: z.string() }),
  idempotentReplay: z.boolean(),
});

async function run(): Promise<void> {
  const playerId = randomUUID();
  const { id: walletId } = walletSchema.parse(
    await post("/wallets", 201, {
      playerId,
      initialBalance: { amount: "100.00", currency: "BRL" },
    }),
  );
  const providerId = "provider-demo";
  const externalTransactionId = randomUUID();
  const bet = {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    gameId: "game-demo",
    roundId: "round-demo",
    kind: "BET",
    money: { amount: "30.00", currency: "BRL" },
  };
  const key = `${providerId}:${externalTransactionId}`;
  const first = wagerSchema.parse(await post("/wagering/transactions", 200, bet, key));
  async function submit(kind: string, amount: string, referenceExternalTransactionId?: string) {
    const id = randomUUID();
    const result = wagerSchema.parse(
      await post(
        "/wagering/transactions",
        200,
        {
          ...bet,
          externalTransactionId: id,
          kind,
          money: { amount, currency: "BRL" },
          ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
        },
        `${providerId}:${id}`,
      ),
    );
    if (result.idempotentReplay) throw new Error(`Unexpected replay for ${kind}`);
    return { id, result };
  }
  const win = await submit("WIN", "50.00", externalTransactionId);
  const replay = wagerSchema.parse(await post("/wagering/transactions", 200, bet, key));
  const refund = await submit("REFUND", "30.00", externalTransactionId);
  const rollback = await submit("ROLLBACK", "30.00", refund.id);
  const loss = await submit("LOSS", "0.00");
  const response = await fetch(new URL(`/wallets/${walletId}/ledger`, baseUrl), {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Ledger returned ${response.status}`);
  const ledger = z
    .object({
      items: z
        .array(z.object({ direction: z.enum(["DEBIT", "CREDIT"]), transactionId: z.string() }))
        .length(5),
    })
    .parse(await response.json());
  const audit = z
    .object({
      consistent: z.literal(true),
      checkedEntries: z.literal(5),
      storedBalance: z.object({ amount: z.literal("120.00") }),
      difference: z.object({ amount: z.literal("0.00") }),
    })
    .parse(await post(`/wallets/${walletId}/reconciliation`, 200));
  if (
    first.idempotentReplay ||
    first.balance.amount !== "70.00" ||
    win.result.balance.amount !== "120.00" ||
    refund.result.balance.amount !== "150.00" ||
    rollback.result.balance.amount !== "120.00" ||
    loss.result.balance.amount !== "120.00" ||
    !replay.idempotentReplay ||
    replay.transactionId !== first.transactionId ||
    replay.balance.amount !== "70.00" ||
    ledger.items.filter(({ direction }) => direction === "DEBIT").length !== 2 ||
    ledger.items.some(({ transactionId }) => transactionId === loss.result.transactionId)
  ) {
    throw new Error("Financial HTTP demo generated an unexpected result");
  }
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        walletId,
        bet: first,
        win: win.result,
        replay,
        refund: refund.result,
        rollback: rollback.result,
        loss: loss.result,
        ledgerEntries: ledger.items.length,
        reconciliation: audit,
      },
      null,
      2,
    ),
  );
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "HTTP demo failed");
  process.exitCode = 1;
});
