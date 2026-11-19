import type { FilterQuery } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type {
  PendingReferenceCandidate,
  PersistedWager,
  WagerPersistenceDetails,
  WagerTransactionRepository,
} from "../../../application/ports/repositories/financial-repositories";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { WagerRow } from "../entities/financial-entities";
import { toWager, wagerRow, wagerState } from "../mappers/financial-mappers";
import { pageLimit } from "./page-limit";

export class MikroWagerRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<PersistedWager | undefined> {
    return this.find({ id });
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<PersistedWager | undefined> {
    return this.find({ providerId, externalTransactionId });
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<PersistedWager | undefined> {
    return this.find({ idempotencyKey });
  }

  async findPendingByReference(
    providerId: string,
    referenceExternalTransactionId: string,
    limit: number,
  ): Promise<PersistedWager[]> {
    const rows = await this.em.find(
      WagerRow,
      {
        providerId,
        referenceExternalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { orderBy: { createdAt: "asc", id: "asc" }, limit: pageLimit(limit), refresh: true },
    );
    return rows.map(toWager);
  }

  async findAppliedReversals(referenceTransactionId: string): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerRow,
      {
        referenceTransactionId,
        status: WagerTransactionStatus.Processed,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      },
      { refresh: true },
    );
    return rows.map((row) => toWager(row).transaction);
  }

  findDueReferences(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    return this.em.execute<PendingReferenceCandidate[]>(
      `
      select w.id, w.wallet_id as "walletId", w.provider_id as "providerId",
             w.reference_attempts as "referenceAttempts",
             (extract(epoch from w.created_at) * 1000)::double precision as "createdAtMs",
             event.payload->>'correlationId' as "correlationId",
             event.payload->>'causationId' as "causationId",
             event.payload->>'sourceMessageId' as "sourceMessageId"
      from (
        select id, wallet_id, provider_id, reference_attempts, created_at, reference_next_attempt_at
        from wagering.wager_transactions
        where status = 'PENDING_REFERENCE' and coalesce(reference_next_attempt_at, created_at) <= ?
        order by coalesce(reference_next_attempt_at, created_at), id limit ?
      ) w
      left join lateral (
        select payload from wagering.outbox_messages
        where aggregate_id = w.id and event_type = 'WagerTransactionPendingReference'
        order by occurred_at, id limit 1
      ) event on true
      order by coalesce(w.reference_next_attempt_at, w.created_at), w.id
    `,
      [now, pageLimit(limit)],
    );
  }

  async scheduleReferenceRetry(id: string, attempts: number, dueAt: Date): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WagerRow,
      {
        id,
        status: WagerTransactionStatus.PendingReference,
      },
      { referenceAttempts: attempts, referenceNextAttemptAt: dueAt },
    );
    if (updated !== 1) throw new Error("Wager is no longer pending");
  }

  async insert(
    transaction: WagerTransaction,
    details: WagerPersistenceDetails = {
      updatedAt: transaction.processedAt ?? transaction.createdAt,
    },
  ): Promise<void> {
    await this.em.insert(WagerRow, wagerRow(transaction, details));
  }

  async saveState(transaction: WagerTransaction, details: WagerPersistenceDetails): Promise<void> {
    const updated = await this.em.nativeUpdate(
      WagerRow,
      {
        id: transaction.id,
        payloadHash: transaction.payloadHash,
      },
      {
        ...wagerState(transaction, details),
        referenceNextAttemptAt: null,
        ...(details.referenceAttempts === undefined
          ? {}
          : { referenceAttempts: details.referenceAttempts }),
      },
    );
    if (updated !== 1) throw new Error("Wager transaction or original hash not found");
  }

  private async find(where: FilterQuery<WagerRow>): Promise<PersistedWager | undefined> {
    const row = await this.em.findOne(WagerRow, where, { refresh: true });
    return row ? toWager(row) : undefined;
  }
}
