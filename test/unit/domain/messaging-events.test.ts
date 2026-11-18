import { expect, test } from "bun:test";
import { IntegrationEvent } from "../../../src/domain/events/integration-event";
import { WalletBalanceChanged } from "../../../src/domain/events/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../../src/domain/events/wager-events";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/money/money";
import { DomainInvariantError, DomainUsageError } from "../../../src/domain/shared/domain-errors";
import { FailureCode } from "../../../src/domain/shared/failure-code";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { WagerTransactionKind as Kind } from "../../../src/domain/wagering/wager-transaction";
import { at, brl } from "../../helpers/domain";
import { wager } from "../../helpers/wager";

const context = { eventId: "event", correlationId: "correlation", causationId: "request" };
const inboxProps = () => ({
  messageId: "message",
  consumerName: "wagers",
  payloadHash: "hash",
  receivedAt: at(),
});
const processed = (kind: Kind.Bet | Kind.Loss = Kind.Bet) => {
  const tx = wager(kind);
  tx.markProcessed(undefined, at(10));
  return tx;
};
const queued = () => OutboxMessage.enqueue(WagerTransactionProcessed.from(processed(), context));

test("inbox validates identity and reception date", () => {
  for (const field of ["messageId", "consumerName", "payloadHash"] as const) {
    expect(() => InboxMessage.receive({ ...inboxProps(), [field]: " " })).toThrow(
      DomainInvariantError,
    );
  }
  expect(() => InboxMessage.receive({ ...inboxProps(), receivedAt: new Date(NaN) })).toThrow(
    DomainInvariantError,
  );
});

test("inbox records the first processing time and rejects repeated processing", () => {
  const props = inboxProps();
  const inbox = InboxMessage.receive(props);
  props.receivedAt.setTime(0);
  expect(inbox.receivedAt).toEqual(at());
  expect(inbox.isProcessed()).toBe(false);
  expect(inbox.processedAt).toBeUndefined();
  expect(() => inbox.markProcessed(at(-1))).toThrow(DomainInvariantError);
  expect(inbox.isProcessed()).toBe(false);
  const completed = at(20);
  inbox.markProcessed(completed);
  completed.setTime(0);
  inbox.processedAt?.setTime(0);
  expect(inbox.isProcessed()).toBe(true);
  expect(() => inbox.markProcessed(at(30))).toThrow(DomainUsageError);
  expect(inbox.processedAt).toEqual(at(20));
  expect(inbox.payloadHash).toBe("hash");
});

test("inbox rehydrates a processed record with its original consumer and hash", () => {
  const inbox = InboxMessage.rehydrate({ ...inboxProps(), processedAt: at(30) });
  expect(inbox.messageId).toBe("message");
  expect(inbox.consumerName).toBe("wagers");
  expect(inbox.payloadHash).toBe("hash");
  expect(inbox.processedAt).toEqual(at(30));
  expect(inbox.isProcessed()).toBe(true);
});

test("processed event includes a stable serialized envelope and covers LOSS", () => {
  const event = WagerTransactionProcessed.from(processed(Kind.Loss), context);
  expect(event).toBeInstanceOf(IntegrationEvent);
  expect(event.toJSON()).toEqual({
    ...context,
    eventType: "WagerTransactionProcessed",
    version: 1,
    aggregateId: "tx-loss",
    occurredAt: at(10).toISOString(),
    data: {
      transactionId: "tx-loss",
      walletId: "wallet",
      providerId: "provider",
      kind: Kind.Loss,
      money: brl("20.00").toJSON(),
    },
  });
  expect(event.data.money).not.toBeInstanceOf(Money);
  expect(JSON.stringify(event)).toBe(JSON.stringify(event.toJSON()));
  expect(
    WagerTransactionProcessed.from(processed(), {
      eventId: "other",
      correlationId: "corr",
    }).toJSON(),
  ).not.toHaveProperty("causationId");
});

test("rejected and pending reference events capture their own causes and state", () => {
  const rejected = wager(Kind.Bet);
  rejected.reject(FailureCode.InsufficientFunds);
  const rejectedEvent = WagerTransactionRejected.from(rejected, context, at(1));
  expect(rejectedEvent.toJSON()).toMatchObject({
    eventType: "WagerTransactionRejected",
    version: 1,
    aggregateId: rejected.id,
    occurredAt: at(1).toISOString(),
    data: { failureCode: FailureCode.InsufficientFunds },
  });

  const pending = wager(Kind.Refund, { referenceExternalTransactionId: "bet" });
  pending.markPendingReference();
  const waitEvent = WagerTransactionPendingReference.from(pending, context, at(2));
  expect(waitEvent.toJSON()).toMatchObject({
    eventType: "WagerTransactionPendingReference",
    version: 1,
    aggregateId: pending.id,
    occurredAt: at(2).toISOString(),
    data: { referenceExternalTransactionId: "bet" },
  });
  pending.reject(FailureCode.ReferenceNotFound);
  expect(waitEvent.data.referenceExternalTransactionId).toBe("bet");
  expect(WagerTransactionRejected.from(pending, context, at(3)).data.failureCode).toBe(
    FailureCode.ReferenceNotFound,
  );
});

test("event factories reject conflicting state and invalid context or time", () => {
  const bet = wager(Kind.Bet);
  expect(() => WagerTransactionProcessed.from(bet, context)).toThrow(DomainInvariantError);
  expect(() => WagerTransactionRejected.from(bet, context, at())).toThrow(DomainInvariantError);
  expect(() => WagerTransactionPendingReference.from(bet, context, at())).toThrow(
    DomainInvariantError,
  );
  expect(() =>
    WagerTransactionProcessed.from(processed(), { ...context, correlationId: "" }),
  ).toThrow(DomainInvariantError);
  bet.reject(FailureCode.InsufficientFunds);
  expect(() => WagerTransactionRejected.from(bet, context, at(-1))).toThrow(DomainInvariantError);
});

test("balance event uses immutable ledger money and the version at the movement", () => {
  const wallet = Wallet.open({
    id: "wallet",
    playerId: "player",
    initialBalance: brl("100.00"),
    createdAt: at(),
  });
  const entry = wallet.debit(brl("20.00"), {
    ledgerEntryId: "entry",
    transactionId: "tx-bet",
    at: at(10),
  });
  wallet.credit(brl("20.00"), { ledgerEntryId: "credit", transactionId: "tx-win", at: at(20) });
  if (!entry) throw new Error("Expected ledger entry");
  const event = WalletBalanceChanged.from(entry, context);
  event.occurredAt.setTime(0);
  expect(event.toJSON()).toMatchObject({
    eventType: "WalletBalanceChanged",
    version: 1,
    aggregateId: "wallet",
    occurredAt: at(10).toISOString(),
    data: {
      transactionId: "tx-bet",
      direction: "DEBIT",
      walletVersion: 2,
      money: brl("20.00").toJSON(),
      balanceBefore: brl("100.00").toJSON(),
      balanceAfter: brl("80.00").toJSON(),
    },
  });
  expect(Reflect.set(event.data.balanceAfter, "amount", "999.00")).toBe(false);
  expect(Reflect.set(event, "eventType", "other")).toBe(false);
});

test("outbox enqueues a deep snapshot with the same stable event ID", () => {
  const event = WagerTransactionProcessed.from(processed(), context);
  const outbox = OutboxMessage.enqueue(event);
  expect(outbox.id).toBe(event.eventId);
  expect(outbox.aggregateId).toBe(event.aggregateId);
  expect(outbox.eventType).toBe(event.eventType);
  expect(outbox.payload).toEqual(event.toJSON());
  expect(outbox.payload).not.toBe(event.toJSON());
  expect(outbox.attempts).toBe(0);
  expect(outbox.nextAttemptAt).toBeUndefined();
  expect(outbox.publishedAt).toBeUndefined();
  expect(outbox.isPending()).toBe(true);
  expect(outbox.isDue(at(9))).toBe(false);
  expect(outbox.isDue(at(10))).toBe(true);
});

test("outbox retry grows from the base delay, respects the cap and preserves terminal publication", () => {
  const outbox = queued();
  const policy = { baseDelayMs: 100, maxDelayMs: 250 };
  outbox.scheduleRetry(at(10), policy);
  expect(outbox.attempts).toBe(1);
  expect(outbox.nextAttemptAt).toEqual(at(110));
  expect(outbox.isDue(at(109))).toBe(false);
  expect(outbox.isDue(at(110))).toBe(true);
  expect(() => outbox.markPublished(at(109))).toThrow(DomainInvariantError);

  outbox.scheduleRetry(at(110), policy);
  expect(outbox.attempts).toBe(2);
  expect(outbox.nextAttemptAt).toEqual(at(310));
  outbox.scheduleRetry(at(310), policy);
  expect(outbox.attempts).toBe(3);
  expect(outbox.nextAttemptAt).toEqual(at(560));
  outbox.markPublished(at(560));
  outbox.publishedAt?.setTime(0);
  expect(outbox.publishedAt).toEqual(at(560));
  expect(outbox.nextAttemptAt).toBeUndefined();
  expect(outbox.isPending()).toBe(false);
  expect(outbox.isDue(at(1000))).toBe(false);
  expect(() => outbox.markPublished(at(600))).toThrow(DomainUsageError);
  expect(() => outbox.scheduleRetry(at(600))).toThrow(DomainUsageError);
});

test("outbox handles invalid retry policy without mutating attempts or due time", () => {
  const outbox = queued();
  expect(() => outbox.scheduleRetry(at(10), { baseDelayMs: 0, maxDelayMs: 10 })).toThrow(
    DomainInvariantError,
  );
  expect(() => outbox.scheduleRetry(at(10), { baseDelayMs: 10, maxDelayMs: 1 })).toThrow(
    DomainInvariantError,
  );
  expect(outbox.attempts).toBe(0);
  expect(outbox.nextAttemptAt).toBeUndefined();
  outbox.scheduleRetry(at(10));
  expect(outbox.nextAttemptAt).toEqual(at(1010));
});

test("outbox rehydrates pending and published snapshots defensively", () => {
  const payload = { data: { amounts: ["25.00"] } };
  const occurredAt = at();
  const nextAttemptAt = at(30);
  const props = {
    id: "event",
    aggregateId: "wallet",
    eventType: "Test",
    occurredAt,
    payload,
    attempts: 2,
  };
  const outbox = OutboxMessage.rehydrate({ ...props, nextAttemptAt });
  occurredAt.setTime(0);
  nextAttemptAt.setTime(0);
  outbox.nextAttemptAt?.setTime(0);
  payload.data.amounts.push("30.00");
  expect(outbox.payload).toEqual({ data: { amounts: ["25.00"] } });
  expect(Object.isFrozen(outbox.payload.data)).toBe(true);
  expect(outbox.occurredAt).toEqual(at());
  expect(outbox.attempts).toBe(2);
  expect(outbox.nextAttemptAt).toEqual(at(30));
  expect(outbox.isDue(at(29))).toBe(false);
  expect(outbox.isDue(at(30))).toBe(true);
  const published = OutboxMessage.rehydrate({ ...props, publishedAt: at(50) });
  expect(published.isPending()).toBe(false);
  expect(published.publishedAt).toEqual(at(50));
});
