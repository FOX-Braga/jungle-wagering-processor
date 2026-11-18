import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module, type DynamicModule } from "@nestjs/common";
import { createOrmOptions } from "../mikro-orm.config";
import { APP_CONFIG, type AppConfig } from "./infrastructure/config/environment";
import { SqsService } from "./infrastructure/messaging/sqs.service";
import { ReadinessService } from "./infrastructure/observability/readiness.service";
import { FinancialApplicationModule } from "./infrastructure/financial/financial-application.module";
import { HealthController } from "./presentation/http/health.controller";

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmOptions(config)), FinancialApplicationModule],
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }, SqsService, ReadinessService],
    };
  }
}
