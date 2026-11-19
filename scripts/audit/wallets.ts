import { MikroORM } from "@mikro-orm/postgresql";
import { parseArgs } from "node:util";
import { createOrmOptions } from "../../mikro-orm.config";
import { requestIdentifier } from "../../src/application/services/wager-contract";
import { ConfigurationError, loadEnvironment } from "../../src/infrastructure/config/environment";
import { auditWallets } from "../../src/infrastructure/persistence/financial-audit";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      wallet: { type: "string" },
      limit: { type: "string" },
      "batch-size": { type: "string", default: "100" },
    },
  });
  const batchSize = Number(values["batch-size"]);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    (limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || values.wallet !== undefined))
  ) {
    throw new Error("Invalid audit arguments");
  }
  const walletId = values.wallet === undefined ? undefined : requestIdentifier.parse(values.wallet);
  const config = loadEnvironment({
    ...process.env,
    DATABASE_URL: process.env.AUDIT_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  const interrupt = new AbortController();
  const stop = () => interrupt.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const orm = await MikroORM.init(createOrmOptions(config, 10_000));
    try {
      const summary = await auditWallets(
        orm,
        {
          batchSize,
          ...(walletId === undefined ? {} : { walletId }),
          ...(limit === undefined ? {} : { limit }),
          signal: AbortSignal.any([interrupt.signal, AbortSignal.timeout(120_000)]),
        },
        (id, codes) =>
          console.log(JSON.stringify({ event: "audit.wallet.anomaly", walletId: id, codes })),
      );
      interrupt.signal.throwIfAborted();
      console.log(JSON.stringify({ status: summary.inconsistent ? "FAIL" : "PASS", ...summary }));
      process.exitCode = summary.inconsistent ? 1 : 0;
    } finally {
      await orm.close(true);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      status: "INCOMPLETE",
      code: error instanceof ConfigurationError ? "INVALID_CONFIGURATION" : "AUDIT_INCOMPLETE",
    }),
  );
  process.exitCode = 2;
});
