import { ApplicationError } from "../errors/application-error";
import type { TransactionManager } from "../ports/transaction-manager";
import { identifier } from "../services/financial-input";

export class ReconcileWalletUseCase {
  constructor(private readonly transactions: TransactionManager) {}

  execute(walletId: string) {
    identifier(walletId, "walletId");
    return this.transactions.execute(async ({ ledger }) => {
      const audit = await ledger.auditBalance(walletId);
      if (!audit) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
      return {
        walletId,
        storedBalance: audit.storedBalance.toJSON(),
        calculatedBalance: audit.calculatedBalance.toJSON(),
        difference: audit.difference.toJSON(),
        consistent: audit.consistent,
        checkedEntries: audit.checkedEntries,
      };
    });
  }
}
