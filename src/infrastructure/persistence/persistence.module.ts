import { MikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { TRANSACTION_MANAGER } from "../../application/ports/transaction-manager";
import { MikroTransactionManager } from "./transaction/mikro-transaction-manager";

@Module({
  providers: [
    {
      provide: TRANSACTION_MANAGER,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new MikroTransactionManager(orm),
    },
  ],
  exports: [TRANSACTION_MANAGER],
})
export class PersistenceModule {}
