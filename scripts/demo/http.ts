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
    money: { amount: "25.00", currency: "BRL" },
  };
  const key = `${providerId}:${externalTransactionId}`;
  const first = wagerSchema.parse(await post("/wagering/transactions", 200, bet, key));
  const win = wagerSchema.parse(
    await post(
      "/wagering/transactions",
      200,
      {
        ...bet,
        externalTransactionId: randomUUID(),
        kind: "WIN",
        money: { amount: "50.00", currency: "BRL" },
      },
      `${providerId}:${randomUUID()}`,
    ),
  );
  const replay = wagerSchema.parse(await post("/wagering/transactions", 200, bet, key));
  const audit = z
    .object({
      consistent: z.literal(true),
      checkedEntries: z.literal(3),
      storedBalance: z.object({ amount: z.literal("125.00") }),
    })
    .parse(await post(`/wallets/${walletId}/reconciliation`, 200));
  if (
    first.idempotentReplay ||
    first.balance.amount !== "75.00" ||
    win.balance.amount !== "125.00" ||
    !replay.idempotentReplay ||
    replay.transactionId !== first.transactionId ||
    replay.balance.amount !== "75.00"
  ) {
    throw new Error("Financial HTTP demo generated an unexpected result");
  }
  console.log(
    JSON.stringify({ walletId, bet: first, win, replay, reconciliation: audit }, null, 2),
  );
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "HTTP demo failed");
  process.exitCode = 1;
});
