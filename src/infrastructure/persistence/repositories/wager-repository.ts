import { raw, type FilterQuery } from "@mikro-orm/core";
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

const referenceDueAt = "coalesce(reference_next_attempt_at, created_at)";

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
    return this.em
      .createQueryBuilder(WagerRow)
      .select(["id", "walletId", "providerId", "referenceAttempts"])
      .where({
        status: WagerTransactionStatus.PendingReference,
        [raw(referenceDueAt)]: { $lte: now },
      })
      .orderBy({ [raw(referenceDueAt)]: "asc", id: "asc" })
      .limit(pageLimit(limit))
      .execute<PendingReferenceCandidate[]>();
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
