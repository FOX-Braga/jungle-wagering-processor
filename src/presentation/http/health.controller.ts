import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import {
  ReadinessService,
  type ReadinessStatus,
} from "../../infrastructure/observability/readiness.service";

const checks = {
  type: "object",
  required: ["postgres", "sqs"],
  properties: {
    postgres: { type: "string", enum: ["up", "down"] },
    sqs: { type: "string", enum: ["up", "down"] },
  },
};

@ApiTags("Health")
@Controller("health")
export class HealthController {
  constructor(@Inject(ReadinessService) private readonly readiness: ReadinessService) {}

  @Get("live")
  @ApiOkResponse({ schema: { example: { status: "ok" } } })
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOkResponse({
    schema: {
      type: "object",
      required: ["status", "checks"],
      properties: { status: { type: "string", enum: ["ok"] }, checks },
    },
  })
  @ApiServiceUnavailableResponse({
    schema: {
      type: "object",
      required: ["status", "checks"],
      properties: { status: { type: "string", enum: ["unavailable"] }, checks },
    },
  })
  async ready(): Promise<ReadinessStatus> {
    const result = await this.readiness.check();
    if (result.status === "unavailable") {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
