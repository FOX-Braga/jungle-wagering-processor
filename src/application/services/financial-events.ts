import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import type { EventContext } from "../../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/events/wager-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import {
  WagerTransactionStatus as Status,
  type WagerTransaction,
} from "../../domain/wagering/wager-transaction";
import type { EventTrace } from "../commands/financial-commands";
import type { IdGenerator } from "../ports/financial-runtime";
import type { OutboxRepository } from "../ports/repositories/financial-repositories";

export async function enqueueWagerEvents(
  outbox: OutboxRepository,
  transaction: WagerTransaction,
  ledgerEntry: WalletLedgerEntry | undefined,
  at: Date,
  trace: EventTrace,
  ids: IdGenerator,
): Promise<void> {
  const context = (): EventContext => ({
    eventId: ids.next(),
    correlationId: trace.correlationId ?? transaction.id,
    ...(trace.causationId === undefined ? {} : { causationId: trace.causationId }),
    ...(trace.sourceMessageId === undefined ? {} : { sourceMessageId: trace.sourceMessageId }),
  });

  switch (transaction.status) {
    case Status.Processed:
      await outbox.insert(
        OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context())),
      );
      if (ledgerEntry) {
        await outbox.insert(
          OutboxMessage.enqueue(WalletBalanceChanged.from(ledgerEntry, context())),
        );
      }
      break;
    case Status.Rejected:
      await outbox.insert(
        OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, context(), at)),
      );
      break;
    case Status.PendingReference:
      await outbox.insert(
        OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, context(), at)),
      );
      break;
    default:
      throw new Error("No financial event defined for this transaction status");
  }
}
