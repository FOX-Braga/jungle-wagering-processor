import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000600 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wagering.inbox_messages
        add column transaction_id wagering.required_text,
        add constraint fk_inbox_wager foreign key (transaction_id)
          references wagering.wager_transactions (id),
        add constraint ck_inbox_transaction_completed
          check (transaction_id is null or processed_at is not null);
    `);
  }

  override down(): void {
    this.addSql(`
      lock table wagering.inbox_messages in access exclusive mode;
      do $guard$
      begin
        if exists (select from wagering.inbox_messages where transaction_id is not null) then
          raise exception 'Refusing to remove populated inbox transaction links';
        end if;
      end
      $guard$;
      alter table wagering.inbox_messages
        drop constraint ck_inbox_transaction_completed,
        drop constraint fk_inbox_wager,
        drop column transaction_id;
    `);
  }
}
