import { Buffer } from "node:buffer";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction";
import { ApplicationError } from "../errors/application-error";
import type { TransactionManager } from "../ports/transaction-manager";
import {
  wagerTransactionResult,
  walletResult,
  type WagerTransactionResult,
  type WalletResult,
} from "../results/financial-results";
import { identifier } from "../services/financial-input";

export class GetWalletUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute(walletId: string): Promise<WalletResult> {
    identifier(walletId, "walletId");
    return this.transactions.execute(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
      return walletResult(wallet);
    });
  }
}

export class GetWagerTransactionUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute(transactionId: string): Promise<WagerTransactionResult> {
    identifier(transactionId, "transactionId");
    return this.transactions.execute(async ({ wagers }) => {
      const record = await wagers.findById(transactionId);
      if (!record) throw new ApplicationError("WAGER_NOT_FOUND", "Wager not found");
      return wagerTransactionResult(record);
    });
  }
}

export class GetProviderWagerTransactionUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute(providerId: string, externalTransactionId: string): Promise<WagerTransactionResult> {
    identifier(providerId, "providerId");
    identifier(externalTransactionId, "externalTransactionId");
    return this.transactions.execute(async ({ wagers }) => {
      const record = await wagers.findByExternalId(providerId, externalTransactionId);
      if (!record || record.transaction.kind === WagerTransactionKind.Opening) {
        throw new ApplicationError("WAGER_NOT_FOUND", "Wager not found");
      }
      return wagerTransactionResult(record);
    });
  }
}

export interface WalletLedgerQuery {
  readonly walletId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface WalletLedgerResult {
  readonly entries: ReturnType<WalletLedgerEntry["toJSON"]>[];
  readonly nextCursor?: string;
}

function invalidCursor(): ApplicationError {
  return new ApplicationError("INVALID_CURSOR", "Ledger cursor is invalid for this wallet");
}

function decodeCursor(walletId: string, cursor: string): number {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  try {
    const buffer = Buffer.from(cursor, "base64url");
    if (buffer.toString("base64url") !== cursor) throw invalidCursor();
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    if (!Array.isArray(value) || value.length !== 3) throw invalidCursor();
    const cursorFields: readonly unknown[] = value;
    const [format, wallet, version] = cursorFields;
    if (
      format !== 1 ||
      wallet !== walletId ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw invalidCursor();
    }
    return version;
  } catch {
    throw invalidCursor();
  }
}

export class GetWalletLedgerUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute({ walletId, cursor, limit = 50 }: WalletLedgerQuery): Promise<WalletLedgerResult> {
    identifier(walletId, "walletId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApplicationError("INVALID_COMMAND", "Ledger limit must be between 1 and 100");
    }
    const afterVersion = cursor === undefined ? undefined : decodeCursor(walletId, cursor);
    return this.transactions.execute(async ({ wallets, ledger }) => {
      if (!(await wallets.findById(walletId)))
        throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
      if (
        afterVersion !== undefined &&
        !(await ledger.findByWalletVersion(walletId, afterVersion))
      ) {
        throw invalidCursor();
      }
      const fetched = await ledger.listByWallet(walletId, {
        limit: limit + 1,
        ...(afterVersion === undefined ? {} : { afterVersion }),
      });
      const page = fetched.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page.map((entry) => entry.toJSON()),
        ...(fetched.length > limit && last
          ? {
              nextCursor: Buffer.from(
                JSON.stringify([1, walletId, last.walletVersion]),
                "utf8",
              ).toString("base64url"),
            }
          : {}),
      };
    });
  }
}
