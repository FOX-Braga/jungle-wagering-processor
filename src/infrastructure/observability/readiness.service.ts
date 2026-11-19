import { MikroORM } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { SqsService } from "../messaging/sqs.service";
import { checkPostgres } from "../persistence/postgres-probe";
import { DependencyProbe, type DependencyStatus } from "./dependency-probe";
import { METRICS, Metrics } from "./metrics";

export interface ReadinessStatus {
  status: "ok" | "unavailable";
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

@Injectable()
export class ReadinessService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("Readiness");
  private readonly states = new Map<string, DependencyStatus>();
  private pending?: Promise<ReadinessStatus> | undefined;
  private accepting = false;
  private readonly postgres = new DependencyProbe(() => checkPostgres(this.orm));
  private readonly queue = new DependencyProbe(() => this.sqs.checkQueues());

  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsService) private readonly sqs: SqsService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    this.accepting = true;
    this.metrics.record("wager_readiness", 1, "process");
  }

  stop(): void {
    this.accepting = false;
    this.metrics.record("wager_readiness", 0, "process");
  }

  onModuleDestroy(): void {
    this.stop();
  }

  async check(): Promise<ReadinessStatus> {
    if (!this.accepting)
      return { status: "unavailable", checks: { postgres: "down", sqs: "down" } };
    this.pending ??= this.probe().finally(() => {
      this.pending = undefined;
    });
    const result = await this.pending;
    return this.accepting ? result : { ...result, status: "unavailable" };
  }

  private async probe(): Promise<ReadinessStatus> {
    const [postgres, sqs] = await Promise.all([this.postgres.check(), this.queue.check()]);

    const result: ReadinessStatus = {
      status: postgres === "up" && sqs === "up" ? "ok" : "unavailable",
      checks: { postgres, sqs },
    };
    for (const dependency of ["postgres", "sqs"] as const) {
      const state = result.checks[dependency];
      this.metrics.record("wager_readiness", state === "up" ? 1 : 0, dependency);
      if (this.states.get(dependency) !== state) {
        this.states.set(dependency, state);
        this.logger[state === "up" ? "log" : "warn"]({
          event:
            state === "up" ? "infrastructure.connection.ready" : "infrastructure.connection.failed",
          dependency,
          result: state,
        });
      }
    }
    return result;
  }
}
