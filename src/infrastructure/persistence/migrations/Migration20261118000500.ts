import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000500 extends Migration {
  override up(): void {
    this.addSql(`
      create index ix_outbox_pending_reference_trace
        on wagering.outbox_messages (aggregate_id, occurred_at, id)
        where event_type = 'WagerTransactionPendingReference';
    `);
  }

  override down(): void {
    this.addSql("drop index wagering.ix_outbox_pending_reference_trace;");
  }
}
