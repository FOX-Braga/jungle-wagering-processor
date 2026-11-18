import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { DomainInvariantError } from "../shared/domain-errors";
import { FailureCode } from "../shared/failure-code";
import { Wallet, type OpenWalletProps } from "../wallet/wallet";
import { WagerTransaction } from "./wager-transaction";

interface OpeningJournal {
  readonly transactionId: string;
  readonly ledgerEntryId: string;
  readonly payloadHash: string;
}

export function openWallet(props: OpenWalletProps, journal?: OpeningJournal) {
  const wallet = Wallet.open(props);
  if (wallet.balance.isZero()) return { wallet };
  if (!journal) {
    throw new DomainInvariantError(
      FailureCode.InvalidWalletState,
      "Positive opening requires transaction and journal identities",
    );
  }

  const transaction = WagerTransaction.createOpening({
    id: journal.transactionId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    providerId: "system:wallet-opening",
    externalTransactionId: wallet.id,
    idempotencyKey: `internal:opening:${wallet.id}`,
    payloadHash: journal.payloadHash,
    roundId: wallet.id,
    gameId: "wallet-opening",
    money: wallet.balance,
    createdAt: wallet.createdAt,
  });
  const ledgerEntry = WalletLedgerEntry.create({
    id: journal.ledgerEntryId,
    transactionId: transaction.id,
    walletId: wallet.id,
    direction: LedgerDirection.Credit,
    money: wallet.balance,
    balanceBefore: Money.zero(wallet.currency),
    balanceAfter: wallet.balance,
    walletVersion: wallet.version,
    createdAt: wallet.createdAt,
  });
  transaction.markProcessed(undefined, wallet.createdAt);
  return { wallet, opening: { transaction, ledgerEntry } };
}
