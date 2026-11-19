import { LockMode, raw } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  InboxRepository,
  OutboxClaim,
  OutboxRepository,
} from "../../../application/ports/repositories/financial-repositories";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { InboxRow, OutboxRow } from "../entities/financial-entities";
import {
  inboxRow,
  outboxDelivery,
  outboxRow,
  toInbox,
  toOutbox,
} from "../mappers/financial-mappers";
import { pageLimit } from "./page-limit";

export class MikroInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(
    consumerName: string,
    messageId: string,
    { forUpdate = false }: { readonly forUpdate?: boolean } = {},
  ): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(
      InboxRow,
      { consumerName, messageId },
      {
        refresh: true,
        ...(forUpdate ? { lockMode: LockMode.PESSIMISTIC_WRITE } : {}),
      },
    );
    return row ? toInbox(row) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxRow, inboxRow(message));
  }

  async saveProcessed(message: InboxMessage): Promise<void> {
    const { consumerName, messageId, payloadHash, processedAt, transactionId } = message;
    if (!processedAt) throw new Error("Inbox message has no processing date");
    const updated = await this.em.nativeUpdate(
      InboxRow,
      {
        consumerName,
        messageId,
        payloadHash,
        processedAt: null,
      },
      { processedAt, transactionId: transactionId ?? null },
    );
    if (updated !== 1) throw new Error("Inbox message is absent, changed or already processed");
  }
}

const dueAtExpression = "coalesce(next_attempt_at, occurred_at)";

export class MikroOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const row = await this.em.findOne(OutboxRow, id, { refresh: true });
    return row ? toOutbox(row) : undefined;
  }

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxRow, outboxRow(message));
  }

  async findDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.dueQuery(now, limit).getResultList();
    return rows.map(toOutbox);
  }

  async claimDue(
    now: Date,
    limit: number,
    claim: OutboxClaim,
    onRecovery?: () => void,
  ): Promise<OutboxMessage[]> {
    if (!Number.isFinite(claim.until.getTime()) || claim.until <= now || !claim.owner.trim()) {
      throw new RangeError("Outbox claim requires a future expiry and an owner");
    }
    const rows = await this.dueQuery(now, limit)
      .setLockMode(LockMode.PESSIMISTIC_PARTIAL_WRITE)
      .getResultList();
    for (const row of rows) {
      if (row.claimUntil) onRecovery?.();
      row.claimOwner = claim.owner;
      row.claimUntil = claim.until;
    }
    await this.em.flush();
    return rows.map(toOutbox);
  }

  async saveDelivery(message: OutboxMessage, claim?: OutboxClaim): Promise<boolean> {
    const updated = await this.em.nativeUpdate(
      OutboxRow,
      {
        id: message.id,
        publishedAt: null,
        parkedAt: null,
        claimOwner: claim?.owner ?? null,
        claimUntil: claim?.until ?? null,
      },
      outboxDelivery(message),
    );
    return updated === 1;
  }

  private dueQuery(now: Date, limit: number) {
    if (!Number.isFinite(now.getTime())) throw new RangeError("Outbox due date is invalid");
    return this.em
      .createQueryBuilder(OutboxRow)
      .select("*")
      .where({
        publishedAt: null,
        parkedAt: null,
        [raw(dueAtExpression)]: { $lte: now },
        $or: [{ claimUntil: null }, { claimUntil: { $lte: now } }],
      })
      .orderBy({ [raw(dueAtExpression)]: "asc", id: "asc" })
      .limit(pageLimit(limit));
  }
}
