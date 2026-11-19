import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { ServerResponse } from "node:http";
import {
  GetProviderWagerTransactionUseCase,
  GetWagerTransactionUseCase,
} from "../../../application/use-cases/financial-queries";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { WagerTransactionStatus as Status } from "../../../domain/wagering/wager-transaction";
import {
  idempotencyKey,
  idempotencyPattern,
  ProviderTransactionParams,
  SubmitWagerRequest,
  TransactionParams,
} from "../dto/financial-requests";
import {
  ApiIdentifier,
  ApiProblems,
  errorSchema,
  submitWagerBody,
  transactionResponse,
  wagerOutcome,
} from "../dto/openapi-schemas";
import { HttpContractError } from "../http-contract-error";
import { getRequestContext, singleHeader, type HttpRequest } from "../request-context";

@ApiTags("Wagering")
@Controller()
export class WagerController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly process: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(GetProviderWagerTransactionUseCase)
    private readonly getProviderTransaction: GetProviderWagerTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(200)
  @ApiOperation({ summary: "Submeter operação financeira ou recuperar o resultado histórico" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { type: "string", pattern: idempotencyPattern, example: "provider-a:transaction-123" },
  })
  @ApiBody({
    schema: submitWagerBody,
    examples: {
      bet: {
        value: {
          providerId: "provider-a",
          externalTransactionId: "transaction-123",
          walletId: "wallet-demo",
          playerId: "player-demo",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
      },
      refund: {
        value: {
          providerId: "provider-a",
          externalTransactionId: "refund-123",
          walletId: "wallet-demo",
          playerId: "player-demo",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "REFUND",
          referenceExternalTransactionId: "transaction-123",
          money: { amount: "25.00", currency: "BRL" },
        },
      },
    },
  })
  @ApiOkResponse({
    description: "Operação processada, inclusive replay histórico",
    schema: wagerOutcome(Status.Processed),
  })
  @ApiResponse({
    status: 202,
    description: "Referência aguardada",
    schema: wagerOutcome(Status.PendingReference),
  })
  @ApiResponse({
    status: 422,
    description: "Rejeição financeira persistida ou jogador divergente",
    schema: { oneOf: [wagerOutcome(Status.Rejected), errorSchema] },
  })
  @ApiProblems(400, 404, 409, 413, 415, 500, 503)
  async submit(
    @Body() body: SubmitWagerRequest,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const rawKey = singleHeader(request, "idempotency-key");
    const key = idempotencyKey.safeParse(rawKey);
    if (!key.success)
      throw new HttpContractError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Provide one valid Idempotency-Key header",
      );
    const context = getRequestContext(request);
    context.walletId = body.walletId;
    context.providerId = body.providerId;
    const result = await this.process.execute({
      ...body,
      idempotencyKey: key.data,
      correlationId: context.correlationId,
    });
    context.transactionId = result.transactionId;
    if (result.status === Status.PendingReference) response.statusCode = 202;
    if (result.status === Status.Rejected) response.statusCode = 422;
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({ summary: "Consultar transação pelo ID interno" })
  @ApiIdentifier("transactionId")
  @ApiOkResponse({ schema: transactionResponse })
  @ApiProblems(400, 404, 500, 503)
  async transaction(@Param() { transactionId }: TransactionParams, @Req() request: HttpRequest) {
    const context = getRequestContext(request);
    context.transactionId = transactionId;
    const result = await this.getTransaction.execute(transactionId);
    context.providerId = result.providerId;
    context.walletId = result.walletId;
    return result;
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Consultar transação pelo provedor e ID externo" })
  @ApiIdentifier("providerId")
  @ApiIdentifier("externalTransactionId")
  @ApiOkResponse({ schema: transactionResponse })
  @ApiProblems(400, 404, 500, 503)
  async providerTransaction(
    @Param() { providerId, externalTransactionId }: ProviderTransactionParams,
    @Req() request: HttpRequest,
  ) {
    const context = getRequestContext(request);
    context.providerId = providerId;
    const result = await this.getProviderTransaction.execute(providerId, externalTransactionId);
    context.transactionId = result.transactionId;
    context.walletId = result.walletId;
    return result;
  }
}
