import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { WalletResult } from "../../../application/results/financial-results";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import {
  GetWalletLedgerUseCase,
  GetWalletUseCase,
} from "../../../application/use-cases/financial-queries";
import { ReconcileWalletUseCase } from "../../../application/use-cases/reconcile-wallet.use-case";
import {
  CreateWalletRequest,
  cursorPattern,
  LedgerQuery,
  maxLedgerPage,
  WalletParams,
} from "../dto/financial-requests";
import {
  ApiIdentifier,
  ApiProblems,
  createWalletBody,
  ledgerResponse,
  reconciliationResponse,
  walletResponse,
} from "../dto/openapi-schemas";
import { getRequestContext, type HttpRequest } from "../request-context";

function publicWallet({ id, playerId, balance, version }: WalletResult) {
  return { id, playerId, balance, version };
}

@ApiTags("Wallets")
@Controller("wallets")
export class WalletController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(GetWalletLedgerUseCase) private readonly getLedger: GetWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  @ApiOperation({ summary: "Abrir carteira para um jogador e moeda" })
  @ApiBody({
    schema: createWalletBody,
    examples: {
      funded: {
        value: { playerId: "player-demo", initialBalance: { amount: "100.00", currency: "BRL" } },
      },
    },
  })
  @ApiCreatedResponse({ schema: walletResponse })
  @ApiProblems(400, 409, 413, 415, 500, 503)
  async create(@Body() body: CreateWalletRequest, @Req() request: HttpRequest) {
    const context = getRequestContext(request);
    const wallet = await this.createWallet.execute({
      ...body,
      correlationId: context.correlationId,
    });
    context.walletId = wallet.id;
    return publicWallet(wallet);
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Consultar saldo e versão atuais" })
  @ApiIdentifier("walletId")
  @ApiOkResponse({ schema: walletResponse })
  @ApiProblems(400, 404, 500, 503)
  async wallet(@Param() { walletId }: WalletParams, @Req() request: HttpRequest) {
    getRequestContext(request).walletId = walletId;
    return publicWallet(await this.getWallet.execute(walletId));
  }

  @Get(":walletId/ledger")
  @ApiOperation({ summary: "Consultar lançamentos em ordem crescente de versão" })
  @ApiIdentifier("walletId")
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: maxLedgerPage, default: 50 },
  })
  @ApiQuery({ name: "cursor", required: false, schema: { type: "string", pattern: cursorPattern } })
  @ApiOkResponse({ schema: ledgerResponse })
  @ApiProblems(400, 404, 500, 503)
  async ledger(
    @Param() { walletId }: WalletParams,
    @Query() page: LedgerQuery,
    @Req() request: HttpRequest,
  ) {
    getRequestContext(request).walletId = walletId;
    const { entries, nextCursor } = await this.getLedger.execute({ ...page, walletId });
    return { items: entries, nextCursor: nextCursor ?? null, hasMore: nextCursor !== undefined };
  }

  @Post(":walletId/reconciliation")
  @HttpCode(200)
  @ApiOperation({ summary: "Comparar saldo armazenado e saldo reconstruído pelo ledger" })
  @ApiIdentifier("walletId")
  @ApiOkResponse({ schema: reconciliationResponse })
  @ApiProblems(400, 404, 500, 503)
  async reconcile(@Param() { walletId }: WalletParams, @Req() request: HttpRequest) {
    const context = getRequestContext(request);
    context.walletId = walletId;
    const started = performance.now();
    try {
      const audit = await this.reconcileWallet.execute(walletId);
      context.event = audit.consistent ? "reconciliation.completed" : "reconciliation.divergence";
      context.outcome = audit.consistent ? "consistent" : "divergent";
      context.checkedEntries = audit.checkedEntries;
      request.metrics?.record("wager_reconciliation_total", 1, context.outcome);
      return audit;
    } catch (error) {
      request.metrics?.record("wager_reconciliation_total", 1, "error");
      throw error;
    } finally {
      request.metrics?.record(
        "wager_reconciliation_duration_seconds",
        (performance.now() - started) / 1000,
      );
    }
  }
}
