import type { MoneyProps } from "../../domain/money/money";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction";

export interface EventTrace {
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface CreateWalletCommand extends EventTrace {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
}

export interface InboxReceipt {
  readonly consumerName: string;
  readonly messageId: string;
}

export interface ProcessWagerCommand extends EventTrace {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly inbox?: InboxReceipt;
}
