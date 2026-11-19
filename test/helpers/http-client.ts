import { randomUUID } from "node:crypto";
import type {
  ProcessWagerResult,
  WalletResult,
  WagerTransactionResult,
} from "../../src/application/results/financial-results";
import type { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import type { WalletLedgerEntry } from "../../src/domain/ledger/wallet-ledger-entry";
import { WagerTransactionKind as Kind } from "../../src/domain/wagering/wager-transaction";

export type PublicWallet = Omit<WalletResult, "currency">;
export type Problem = { error: { code: string; message: string; correlationId: string } };
export type LedgerPage = {
  items: ReturnType<WalletLedgerEntry["toJSON"]>[];
  hasMore: boolean;
  nextCursor: string | null;
};
export type Audit = Awaited<ReturnType<ReconcileWalletUseCase["execute"]>>;
export type Wager = ReturnType<typeof command>;

export function httpClient(baseUrl: string) {
  async function request<T>(path: string, init?: RequestInit) {
    const response = await fetch(new URL(path, baseUrl), {
      signal: AbortSignal.timeout(12_000),
      ...init,
    });
    const raw: unknown = await response.json();
    return { status: response.status, body: raw as T, headers: response.headers };
  }

  return {
    request,
    open(amount = "100.00", playerId: string = randomUUID(), currency = "BRL") {
      return request<PublicWallet>(
        "/wallets",
        json({ playerId, initialBalance: { amount, currency } }),
      );
    },
    wallet(id: string) {
      return request<PublicWallet>(`/wallets/${id}`);
    },
    ledger(id: string, query = "") {
      return request<LedgerPage>(`/wallets/${id}/ledger${query}`);
    },
    wager(body: Wager, key = wagerKey(body), headers?: HeadersInit) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("idempotency-key", key);
      return request<ProcessWagerResult>("/wagering/transactions", json(body, requestHeaders));
    },
    transaction(id: string) {
      return request<WagerTransactionResult>(`/wagering/transactions/${id}`);
    },
    providerTransaction(provider: string, externalId: string) {
      return request<WagerTransactionResult>(
        `/providers/${provider}/wagering/transactions/${externalId}`,
      );
    },
    reconcile(walletId: string) {
      return request<Audit>(`/wallets/${walletId}/reconciliation`, { method: "POST" });
    },
  };
}

export function json(body: unknown, headers?: HeadersInit): RequestInit {
  const values = new Headers(headers);
  values.set("content-type", "application/json");
  return { method: "POST", headers: values, body: JSON.stringify(body) };
}

export function command(
  wallet: PublicWallet,
  kind = Kind.Bet,
  amount = "25.00",
  referenceExternalTransactionId?: string,
) {
  return {
    providerId: "provider-a",
    externalTransactionId: randomUUID() as string,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-demo",
    gameId: "game-demo",
    kind,
    money: { amount, currency: wallet.balance.currency },
    ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
  };
}

export function wagerKey(wager: Wager): string {
  return `${wager.providerId}:${wager.externalTransactionId}`;
}
