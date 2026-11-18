import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000300 extends Migration {
  override up(): void {
    this.addSql(`
      alter table wagering.wager_transactions
        add column requested_currency wagering.currency_code,
        add constraint ck_wager_requested_currency check (
          requested_currency is null or (
            requested_currency <> currency and status = 'REJECTED' and failure_code = 'CURRENCY_MISMATCH'
          )
        );
      create function wagering.guard_wager_requested_currency() returns trigger language plpgsql as $fn$
      begin
        if new.requested_currency is distinct from old.requested_currency then
          raise exception using errcode = '23514', constraint = 'ck_wager_immutable_identity',
            message = 'Requested currency is immutable';
        end if;
        return new;
      end;
      $fn$;
      create trigger guard_wager_requested_currency
        before update of requested_currency on wagering.wager_transactions
        for each row execute function wagering.guard_wager_requested_currency();
    `);
    this.setProcessingConstraint(true);
  }

  override down(): void {
    this.addSql(`
      lock table wagering.wager_transactions in access exclusive mode;
      do $guard$
      begin
        if exists (
          select from wagering.wager_transactions
          where requested_currency is not null or (status = 'PENDING_REFERENCE' and result_balance is not null)
        ) then
          raise exception 'Refusing to drop historical wager outcome data';
        end if;
      end;
      $guard$;
      drop trigger guard_wager_requested_currency on wagering.wager_transactions;
      drop function wagering.guard_wager_requested_currency();
      alter table wagering.wager_transactions
        drop constraint ck_wager_requested_currency,
        drop column requested_currency;
    `);
    this.setProcessingConstraint(false);
  }

  private setProcessingConstraint(allowPendingSnapshot: boolean): void {
    const forbidden = allowPendingSnapshot
      ? "'PENDING', 'FAILED'"
      : "'PENDING', 'PENDING_REFERENCE', 'FAILED'";
    this.addSql(`
      alter table wagering.wager_transactions
        drop constraint ck_wager_processing_fields,
        add constraint ck_wager_processing_fields check (
          ((status = 'PROCESSED') = (processed_at is not null))
          and ((result_balance is null) = (result_wallet_version is null))
          and (result_wallet_version is null or result_wallet_version >= 1)
          and (status <> 'PROCESSED' or result_balance is not null)
          and (status not in (${forbidden}) or result_balance is null)
          and case
            when status = 'FAILED' then failure_code is not null and failure_code = 'PROCESSING_FAILED'
            when status = 'REJECTED' then failure_code is not null and failure_code in (
              'INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_MISMATCH',
              'INVALID_REFERENCE', 'REFERENCE_NOT_FOUND', 'REFERENCE_TYPE_NOT_ALLOWED', 'AMOUNT_MISMATCH', 'ALREADY_REVERSED'
            )
            else failure_code is null
          end
          and updated_at >= created_at
          and (processed_at is null or processed_at between created_at and updated_at)
        );
    `);
  }
}
