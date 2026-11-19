import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module, type DynamicModule } from "@nestjs/common";
import { createOrmOptions } from "../mikro-orm.config";
import { APP_CONFIG, type AppConfig } from "./infrastructure/config/environment";
import { SqsService } from "./infrastructure/messaging/sqs.service";
import { METRICS, Metrics } from "./infrastructure/observability/metrics";
import { ReadinessService } from "./infrastructure/observability/readiness.service";
import { HttpModule } from "./presentation/http/http.module";
import { HealthController } from "./presentation/http/health.controller";

@Module({})
export class AppModule {
  static register(
    config: AppConfig,
    metrics = new Metrics(config.INSTANCE_ID ?? crypto.randomUUID()),
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmOptions(config)), HttpModule],
      controllers: [HealthController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: METRICS, useValue: metrics },
        SqsService,
        ReadinessService,
      ],
    };
  }
}
