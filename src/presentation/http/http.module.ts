import { Module } from "@nestjs/common";
import { FinancialApplicationModule } from "../../infrastructure/financial/financial-application.module";
import { WalletController } from "./controllers/wallet.controller";
import { WagerController } from "./controllers/wager.controller";

@Module({ imports: [FinancialApplicationModule], controllers: [WalletController, WagerController] })
export class HttpModule {}
