import { Module } from "@nestjs/common";
import type { FinancialRuntime } from "../../application/ports/financial-runtime";
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from "../../application/ports/transaction-manager";
import { CreateWalletUseCase } from "../../application/use-cases/create-wallet.use-case";
import {
  GetProviderWagerTransactionUseCase,
  GetWagerTransactionUseCase,
  GetWalletLedgerUseCase,
  GetWalletUseCase,
} from "../../application/use-cases/financial-queries";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction.use-case";
import { PersistenceModule } from "../persistence/persistence.module";

const runtime: FinancialRuntime = {
  ids: { next: () => crypto.randomUUID() },
  clock: { now: () => new Date() },
};
const queries = [
  GetWalletUseCase,
  GetWalletLedgerUseCase,
  GetWagerTransactionUseCase,
  GetProviderWagerTransactionUseCase,
];

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [TRANSACTION_MANAGER],
      useFactory: (manager: TransactionManager) => new CreateWalletUseCase(manager, runtime),
    },
    {
      provide: ProcessWagerTransactionUseCase,
      inject: [TRANSACTION_MANAGER],
      useFactory: (manager: TransactionManager) =>
        new ProcessWagerTransactionUseCase(manager, runtime),
    },
    ...queries.map((query) => ({
      provide: query,
      inject: [TRANSACTION_MANAGER],
      useFactory: (manager: TransactionManager) => new query(manager),
    })),
  ],
  exports: [CreateWalletUseCase, ProcessWagerTransactionUseCase, ...queries],
})
export class FinancialApplicationModule {}
