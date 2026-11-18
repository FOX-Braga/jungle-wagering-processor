import { randomUUID } from "node:crypto";
import type { FinancialRepositories } from "../../src/application/ports/repositories/financial-repositories";
import { Money } from "../../src/domain/money/money";
import type { Wallet } from "../../src/domain/wallet/wallet";
import { openWallet } from "../../src/domain/wagering/open-wallet";
import {
  WagerTransaction,
  WagerTransactionStatus,
  type WagerTransactionKind,
  type WagerTransactionProps,
} from "../../src/domain/wagering/wager-transaction";
import { at } from "./domain";

export function opening(amount = "0.00", currency = "BRL", playerId = randomUUID()) {
  const id = randomUUID();
  return openWallet(
    {
      id,
      playerId,
      initialBalance: Money.from({ amount, currency }),
      createdAt: at(),
    },
    { transactionId: randomUUID(), ledgerEntryId: randomUUID(), payloadHash: `opening-${id}` },
  );
}

export async function insertOpening(
  repos: FinancialRepositories,
  opened: ReturnType<typeof opening>,
): Promise<void> {
  const { wallet, opening } = opened;
  await repos.wallets.insertBaseline(wallet);
  if (opening) {
    await repos.wagers.insert(opening.transaction, {
      updatedAt: wallet.createdAt,
      result: { balance: wallet.balance, walletVersion: wallet.version },
    });
    await repos.wallets.saveMovement(wallet, opening.ledgerEntry);
  }
}

export function makeWager(
  wallet: Wallet,
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<WagerTransactionProps> = {},
): WagerTransaction {
  const id = randomUUID();
  return WagerTransaction.create({
    id,
    providerId: "provider",
    externalTransactionId: id,
    idempotencyKey: `idem-${id}`,
    payloadHash: `hash-${id}`,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round",
    gameId: "game",
    kind,
    money: Money.from({ amount, currency: wallet.currency }),
    createdAt: at(),
    ...overrides,
  });
}

export async function insertApplied(
  repos: FinancialRepositories,
  wallet: Wallet,
  transaction: WagerTransaction,
  timestamp: Date,
  reference?: WagerTransaction,
) {
  const result = transaction.apply(wallet, {
    at: timestamp,
    ledgerEntryId: randomUUID(),
    appliedReversals: [],
    ...(reference ? { reference } : {}),
  });
  if (result.status !== WagerTransactionStatus.Processed)
    throw new Error("Invalid applied test fixture");
  await repos.wagers.insert(transaction, {
    updatedAt: timestamp,
    result: { balance: wallet.balance, walletVersion: wallet.version },
  });
  if (result.ledgerEntry) await repos.wallets.saveMovement(wallet, result.ledgerEntry);
  return result.ledgerEntry;
}
