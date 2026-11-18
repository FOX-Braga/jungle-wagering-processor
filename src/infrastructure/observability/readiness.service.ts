import { MikroORM } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { SqsService } from "../messaging/sqs.service";
import { checkPostgres } from "../persistence/postgres-probe";

type DependencyStatus = "up" | "down";

export interface ReadinessStatus {
  status: "ok" | "unavailable";
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsService) private readonly sqs: SqsService,
  ) {}

  async check(): Promise<ReadinessStatus> {
    const [postgres, sqs] = await Promise.allSettled([
      checkPostgres(this.orm),
      this.sqs.checkQueues(),
    ]);

    return {
      status: postgres.status === "fulfilled" && sqs.status === "fulfilled" ? "ok" : "unavailable",
      checks: {
        postgres: postgres.status === "fulfilled" ? "up" : "down",
        sqs: sqs.status === "fulfilled" ? "up" : "down",
      },
    };
  }
}
