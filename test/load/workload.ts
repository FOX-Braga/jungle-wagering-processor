import { Money } from "../../src/domain/money/money";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";
import { command, type PublicWallet } from "../helpers/http-client";

export const scenarios = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"] as const;
export type Scenario = (typeof scenarios)[number];
export const openingAmount = "1000000.00";

export function loadOptions(env: typeof process.env) {
  function integer(name: string, fallback: number, min: number, max: number) {
    const raw = env[name] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return value;
  }
  const selected = env.LOAD_SCENARIOS?.split(",") ?? scenarios;
  for (const id of selected) {
    if (!(scenarios as readonly string[]).includes(id)) throw new Error(`Unknown scenario: ${id}`);
  }
  return {
    scenarios: [...new Set(selected as readonly Scenario[])],
    rate: integer("LOAD_RATE", 40, 1, 300),
    duration: integer("LOAD_DURATION_SECONDS", 3, 1, 60),
    sustained: integer("LOAD_SUSTAINED_SECONDS", 30, 1, 300),
    workers: integer("LOAD_WORKERS", 12, 1, 64),
    wallets: integer("LOAD_WALLETS", 12, 1, 64),
    instances: integer("LOAD_INSTANCES", 3, 1, 8),
    seed: integer("LOAD_SEED", 20261118, 0, 2 ** 32 - 1),
    replayPercent: integer("LOAD_REPLAY_PERCENT", 30, 0, 100),
    mixedPercent: integer("LOAD_MIX_PERCENT", 100, 0, 100),
  };
}

export type LoadOptions = ReturnType<typeof loadOptions>;

export function draw(seed: number, index: number, salt: number): number {
  let value = Math.imul(seed ^ salt ^ index, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function plan(wallet: PublicWallet, scenario: Scenario, index: number, mixed: boolean) {
  const prefix = `${scenario}-${index}`;
  const betId = `${prefix}-bet`;
  const refundId = `${prefix}-refund`;
  const operation = (
    id: string,
    kind: Kind,
    amount: string,
    effect: "debit" | "credit" | "none",
    reference?: string,
    failureCode?: "AMOUNT_MISMATCH",
  ) => {
    const wager = {
      ...command(wallet, kind, amount, reference),
      externalTransactionId: id,
      roundId: prefix,
    };
    const money = Money.from(wager.money);
    return {
      wager,
      effect: effect === "debit" ? money.negate() : effect === "credit" ? money : Money.zero("BRL"),
      failureCode,
    };
  };
  const bet = operation(betId, Kind.Bet, "1.00", "debit");
  return mixed
    ? [
        bet,
        operation(`${prefix}-win`, Kind.Win, "2.00", "credit", betId),
        operation(`${prefix}-loss`, Kind.Loss, "0.00", "none"),
        operation(`${prefix}-invalid`, Kind.Refund, "0.50", "none", betId, "AMOUNT_MISMATCH"),
        operation(refundId, Kind.Refund, "1.00", "credit", betId),
        operation(`${prefix}-rollback`, Kind.Rollback, "1.00", "debit", refundId),
      ]
    : [bet];
}

export type Operation = ReturnType<typeof plan>[number];

export function percentiles(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile: number) =>
    Number(sorted[Math.ceil(sorted.length * quantile) - 1]!.toFixed(2));
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
