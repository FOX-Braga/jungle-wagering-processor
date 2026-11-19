import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000400 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wagering.wager_transactions
        add column reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column reference_next_attempt_at wagering.finite_time,
        add constraint ck_wager_reference_schedule check (
          reference_next_attempt_at is null or
            (status = 'PENDING_REFERENCE' and reference_next_attempt_at >= created_at)
        );
      create index ix_wager_reference_due on wagering.wager_transactions
        ((coalesce(reference_next_attempt_at, created_at)), id) where status = 'PENDING_REFERENCE';
      alter table wagering.outbox_messages
        add column parked_at wagering.finite_time,
        add constraint ck_outbox_parked check (
          parked_at is null or (parked_at >= occurred_at and published_at is null
            and next_attempt_at is null and claim_owner is null)
        );
      drop index wagering.ix_outbox_due;
      create index ix_outbox_due on wagering.outbox_messages
        ((coalesce(next_attempt_at, occurred_at)), id)
        where published_at is null and parked_at is null;
    `);
  }

  override down(): void {
    this.addSql(`
      drop index wagering.ix_outbox_due;
      alter table wagering.outbox_messages drop column parked_at;
      create index ix_outbox_due on wagering.outbox_messages
        ((coalesce(next_attempt_at, occurred_at)), id) where published_at is null;
      drop index wagering.ix_wager_reference_due;
      alter table wagering.wager_transactions
        drop constraint ck_wager_reference_schedule,
        drop column reference_next_attempt_at,
        drop column reference_attempts;
    `);
  }
}
