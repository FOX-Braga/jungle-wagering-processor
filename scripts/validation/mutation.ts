import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const money = "src/domain/money/money.ts";
const wallet = "src/domain/wallet/wallet.ts";
const ledger = "src/domain/ledger/wallet-ledger-entry.ts";
const wager = "src/domain/wagering/wager-transaction.ts";
const processor = "src/application/use-cases/process-wager-transaction.use-case.ts";
const mutations = [
  {
    id: "ignore-currency",
    file: money,
    from: "if (this.currency !== other.currency)",
    to: "if (false)",
  },
  {
    id: "allow-money-negative-input",
    file: money,
    from: "!decimal.test(amount)",
    to: '!decimal.test(amount.replace(/^-/, ""))',
  },
  {
    id: "reject-exact-balance",
    file: wallet,
    from: "if (balanceAfter.isNegative())",
    to: "if (!balanceAfter.isPositive())",
  },
  {
    id: "invert-comparison",
    file: money,
    from: "this.#cents < other.#cents",
    to: "this.#cents > other.#cents",
  },
  {
    id: "skip-ledger-balance-check",
    file: ledger,
    from: "return expected.equals(this.balanceAfter);",
    to: "return true;",
  },
  {
    id: "credit-bet-instead-of-debiting",
    file: wager,
    from: "if (direction === LedgerDirection.Debit) entry = wallet.debit(this.money, movement);",
    to: "if (direction === LedgerDirection.Debit) entry = wallet.credit(this.money, movement);",
  },
  {
    id: "reopen-processed-wager",
    file: wager,
    from: "[Status.Processed]: [],",
    to: "[Status.Processed]: [Status.Rejected],",
  },
  {
    id: "ignore-missing-reference",
    file: wager,
    from: "if (!reference) return false;",
    to: "if (!reference) return true;",
  },
  { id: "allow-double-reversal", file: wager, from: "if (blocked)", to: "if (false)" },
  {
    id: "allow-divergent-replay",
    file: processor,
    from: "if (!record.transaction.matchesPayload(proposed.payloadHash))",
    to: "if (false)",
  },
];

async function suite(cwd: string) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "test", "./test/unit", "./test/properties"],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stdout + stderr;
  const passed = Number(/^\s*(\d+) pass\r?$/m.exec(output)?.[1] ?? 0);
  const failed = Number(/^\s*(\d+) fail\r?$/m.exec(output)?.[1] ?? 0);
  const errors = Number(/^\s*(\d+) errors?\r?$/m.exec(output)?.[1] ?? 0);
  return { exitCode, passed, failed, errors };
}

async function main() {
  const tempParent = resolve(tmpdir());
  const isolated = await mkdtemp(join(tempParent, "jungle-mutation-"));
  if (!/^jungle-mutation-[\w-]+$/.test(relative(tempParent, isolated))) {
    throw new Error("Unexpected mutation workspace path");
  }
  const started = performance.now();
  try {
    await mkdir(join(isolated, "test"));
    for (const item of [
      "src",
      "test/unit",
      "test/properties",
      "test/helpers",
      "tsconfig.json",
      "package.json",
      "mikro-orm.config.ts",
    ]) {
      await cp(resolve(item), join(isolated, item), { recursive: true });
    }
    await symlink(resolve("node_modules"), join(isolated, "node_modules"), "junction");
    const baseline = await suite(isolated);
    if (baseline.exitCode || baseline.failed || baseline.errors || !baseline.passed) {
      throw new Error(`Mutation baseline failed: ${JSON.stringify(baseline)}`);
    }
    const results = [];
    for (const { id, file, from, to } of mutations) {
      const target = join(isolated, file);
      const original = await Bun.file(target).text();
      if (original.split(from).length !== 2) throw new Error(`Mutation anchor drifted: ${id}`);
      try {
        await Bun.write(
          target,
          original.replace(from, () => to),
        );
        const result = await suite(isolated);
        const valid = result.errors === 0 && result.passed + result.failed === baseline.passed;
        const status = !valid
          ? "INVALID"
          : result.exitCode === 0 && result.failed === 0
            ? "SURVIVED"
            : result.exitCode !== 0 && result.failed > 0
              ? "DETECTED"
              : "INVALID";
        results.push({ id, file, status, ...result });
      } finally {
        await Bun.write(target, original);
      }
    }
    const detected = results.filter(({ status }) => status === "DETECTED").length;
    const survived = results.filter(({ status }) => status === "SURVIVED").length;
    const invalid = results.length - detected - survived;
    console.log(
      JSON.stringify(
        {
          runner: `Bun ${Bun.version}`,
          baseline,
          detected,
          survived,
          invalid,
          seconds: (performance.now() - started) / 1000,
          results,
        },
        null,
        2,
      ),
    );
    if (invalid) process.exitCode = 1;
  } finally {
    await rm(join(isolated, "node_modules"), { force: true });
    await rm(isolated, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Mutation run failed");
  process.exitCode = 1;
});
