import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000200 extends Migration {
  override up(): void {
    this.addSql(`
      create function wagering.guard_wallet_projection() returns trigger
      language plpgsql as $fn$
      begin
        if tg_op = 'INSERT' then
          if new.balance <> 0 or new.version <> 1 or new.updated_at <> new.created_at then
            raise exception using errcode = '23514', constraint = 'ck_wallet_baseline',
              message = 'A wallet must start at zero and version one';
          end if;
          return new;
        end if;

        if row(new.id, new.player_id, new.currency, new.created_at)
           is distinct from row(old.id, old.player_id, old.currency, old.created_at) then
          raise exception using errcode = '23514', constraint = 'ck_wallet_immutable_identity',
            message = 'Wallet identity is immutable';
        end if;
        if row(new.balance, new.version, new.updated_at)
           is not distinct from row(old.balance, old.version, old.updated_at) then
          return new;
        end if;
        if new.updated_at < old.updated_at or not exists (
          select from wagering.wallet_ledger_entries e
          join wagering.wager_transactions t on t.id = e.transaction_id
          where e.wallet_id = old.id and e.wallet_version = new.version
            and e.balance_before = old.balance and e.balance_after = new.balance and e.created_at = new.updated_at
            and (
              (t.kind <> 'OPENING' and new.version::bigint = old.version::bigint + 1)
              or (t.kind = 'OPENING' and new.version = 1 and old.version = 1 and old.balance = 0
                and new.updated_at = old.created_at)
            )
        ) then
          raise exception using errcode = '23514', constraint = 'ck_wallet_ledger_projection',
            message = 'Wallet changes require the next ledger entry';
        end if;
        return new;
      end;
      $fn$;
      create trigger guard_wallet_projection before insert or update on wagering.wallets
        for each row execute function wagering.guard_wallet_projection();
    `);

    this.addSql(`
      create function wagering.guard_wager_transaction() returns trigger
      language plpgsql as $fn$
      declare
        reference wagering.wager_transactions%rowtype;
        current_balance wagering.money_amount;
        current_version integer;
      begin
        if tg_op in ('UPDATE', 'DELETE') and old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception using errcode = '55000', constraint = 'wager_terminal_state',
            message = 'Terminal wagering transactions are immutable';
        end if;
        if tg_op = 'DELETE' then return old; end if;

        if tg_op = 'UPDATE' then
          if row(new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
                 new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
                 new.reference_external_transaction_id, new.created_at)
             is distinct from
             row(old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
                 old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
                 old.reference_external_transaction_id, old.created_at) then
            raise exception using errcode = '23514', constraint = 'ck_wager_immutable_identity',
              message = 'Wager identity and payload are immutable';
          end if;
          if (old.status = 'PENDING_REFERENCE' and new.status = 'PENDING')
             or new.updated_at < old.updated_at then
            raise exception using errcode = '23514', constraint = 'ck_wager_state_transition',
              message = 'Invalid wagering transition';
          end if;
        end if;

        if new.reference_transaction_id is not null then
          select * into reference from wagering.wager_transactions where id = new.reference_transaction_id;
          -- Let the FK report absent references.
          if found and (
            row(reference.provider_id, reference.external_transaction_id, reference.wallet_id,
                reference.player_id, reference.currency, reference.round_id)
              is distinct from row(new.provider_id, new.reference_external_transaction_id, new.wallet_id,
                                    new.player_id, new.currency, new.round_id)
            or reference.status <> 'PROCESSED'
            or (new.kind in ('REFUND', 'WIN') and reference.kind <> 'BET')
            or (new.kind = 'ROLLBACK' and reference.kind not in ('BET', 'WIN', 'REFUND'))
            or (new.kind in ('REFUND', 'ROLLBACK') and reference.amount <> new.amount)
          ) then
            raise exception using errcode = '23514', constraint = 'ck_wager_reference_scope',
              message = 'Resolved reference is incompatible with the wager';
          end if;
        end if;

        if new.kind = 'LOSS' and new.status = 'PROCESSED' then
          select balance, version into current_balance, current_version
            from wagering.wallets where id = new.wallet_id for update;
          if found and row(new.result_balance, new.result_wallet_version)
                       is distinct from row(current_balance, current_version) then
            raise exception using errcode = '23514', constraint = 'ck_loss_wallet_snapshot',
              message = 'LOSS must preserve the wallet snapshot';
          end if;
        end if;
        return new;
      end;
      $fn$;
      create trigger guard_wager_transaction before insert or update or delete on wagering.wager_transactions
        for each row execute function wagering.guard_wager_transaction();

      create function wagering.require_processed_ledger() returns trigger
      language plpgsql as $fn$
      begin
        if not exists (select from wagering.wallet_ledger_entries
                       where transaction_id = new.id and wallet_id = new.wallet_id) then
          raise exception using errcode = '23514', constraint = 'ck_processed_wager_requires_ledger',
            message = 'Processed movement must commit with its ledger entry';
        end if;
        return null;
      end;
      $fn$;
      create constraint trigger require_processed_ledger
        after insert or update on wagering.wager_transactions deferrable initially deferred
        for each row when (new.status = 'PROCESSED' and new.kind <> 'LOSS')
        execute function wagering.require_processed_ledger();
    `);

    this.addSql(`
      create function wagering.apply_ledger_entry() returns trigger
      language plpgsql security definer set search_path = pg_catalog as $fn$
      declare
        wager wagering.wager_transactions%rowtype;
        reference_kind text;
        expected_direction text;
      begin
        select * into wager from wagering.wager_transactions where id = new.transaction_id;
        if not found then
          raise exception using errcode = '23503', constraint = 'fk_ledger_transaction_identity',
            message = 'Ledger transaction does not exist';
        end if;
        select kind into reference_kind from wagering.wager_transactions where id = wager.reference_transaction_id;

        expected_direction := case
          when wager.kind = 'BET' then 'DEBIT'
          when wager.kind in ('OPENING', 'WIN', 'REFUND') then 'CREDIT'
          when wager.kind = 'ROLLBACK' and reference_kind = 'BET' then 'CREDIT'
          when wager.kind = 'ROLLBACK' and reference_kind in ('WIN', 'REFUND') then 'DEBIT'
        end;
        if wager.status <> 'PROCESSED' or expected_direction is distinct from new.direction
           or row(wager.result_balance, wager.result_wallet_version, wager.processed_at)
              is distinct from row(new.balance_after, new.wallet_version, new.created_at) then
          raise exception using errcode = '23514', constraint = 'ck_ledger_processed_wager',
            message = 'Ledger entry must match the processed wager and its result';
        end if;

        update wagering.wallets
          set balance = new.balance_after, version = new.wallet_version, updated_at = new.created_at
          where id = new.wallet_id and balance = new.balance_before
            and (
              (wager.kind <> 'OPENING' and version::bigint + 1 = new.wallet_version)
              or (wager.kind = 'OPENING' and version = 1 and new.wallet_version = 1 and balance = 0)
            );
        if not found then
          raise exception using errcode = '23514', constraint = 'ck_wallet_ledger_projection',
            message = 'Ledger entry does not extend the wallet balance and version';
        end if;
        return null;
      end;
      $fn$;
      revoke execute on function wagering.apply_ledger_entry() from public;
      create trigger apply_ledger_entry after insert on wagering.wallet_ledger_entries
        for each row execute function wagering.apply_ledger_entry();

      create function wagering.reject_ledger_change() returns trigger
      language plpgsql as $fn$
      begin
        raise exception using errcode = '55000', constraint = 'ledger_append_only',
          message = 'Ledger entries are append-only';
      end;
      $fn$;
      create trigger ledger_append_only before update or delete or truncate on wagering.wallet_ledger_entries
        for each statement execute function wagering.reject_ledger_change();
    `);
  }

  override down(): void {
    this.addSql(`
      lock table wagering.wallets, wagering.wager_transactions, wagering.wallet_ledger_entries in access exclusive mode;
      do $guard$
      begin
        if exists (select from wagering.wallets)
          or exists (select from wagering.wager_transactions)
          or exists (select from wagering.wallet_ledger_entries) then
          raise exception 'Refusing to remove guards from a populated ledger';
        end if;
      end;
      $guard$;
      drop trigger ledger_append_only on wagering.wallet_ledger_entries;
      drop trigger apply_ledger_entry on wagering.wallet_ledger_entries;
      drop trigger require_processed_ledger on wagering.wager_transactions;
      drop trigger guard_wager_transaction on wagering.wager_transactions;
      drop trigger guard_wallet_projection on wagering.wallets;
      drop function wagering.reject_ledger_change(), wagering.apply_ledger_entry(),
        wagering.require_processed_ledger(), wagering.guard_wager_transaction(), wagering.guard_wallet_projection();
    `);
  }
}
