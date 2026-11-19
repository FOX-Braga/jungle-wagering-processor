import { deepEqual, equal } from "node:assert/strict";
import { launchApi } from "../helpers/api-process";
import { createTestDatabase } from "../helpers/test-database";

async function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, "--no-env-file", script, ...args], {
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  equal(await child.exited, 0, `${script} failed`);
}

async function main() {
  const database = await createTestDatabase();
  try {
    const api = await launchApi(database.url, "demo-complete");
    try {
      const opened = await api.client.open();
      equal(opened.status, 201);
      const [wallet, ledger] = await Promise.all([
        api.client.wallet(opened.body.id),
        api.client.ledger(opened.body.id),
      ]);
      equal(wallet.status, 200);
      equal(ledger.status, 200);
      deepEqual(wallet.body.balance, { amount: "100.00", currency: "BRL" });
      equal(ledger.body.items.length, 1);
      const entry = ledger.body.items[0]!;
      equal(entry.direction, "CREDIT");
      deepEqual(entry.money, wallet.body.balance);
      const transaction = await api.client.transaction(entry.transactionId);
      equal(transaction.status, 200);
      equal(transaction.body.kind, "OPENING");
      console.log(
        JSON.stringify({ scenario: "opening", ...wallet.body.balance, ledgerEntries: 1 }),
      );

      await run("scripts/demo/http.ts", [api.url], process.env);
      await run("scripts/audit/wallets.ts", [], {
        ...process.env,
        AUDIT_DATABASE_URL: database.url.href,
      });
    } finally {
      await api.stop();
    }
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo failed");
  process.exitCode = 1;
});
