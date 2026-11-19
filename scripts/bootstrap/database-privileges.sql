-- Run after migrations as the schema owner. Both login roles must already exist.
begin;
grant usage on schema wagering to :"runtime_role", :"audit_role";
grant select, insert on wagering.wallets, wagering.wager_transactions,
  wagering.wallet_ledger_entries, wagering.inbox_messages, wagering.outbox_messages to :"runtime_role";
grant update (updated_at) on wagering.wallets to :"runtime_role";
grant update (status, reference_transaction_id, failure_code, processed_at,
  result_balance, result_wallet_version, updated_at, reference_attempts, reference_next_attempt_at)
  on wagering.wager_transactions to :"runtime_role";
grant update (processed_at, transaction_id) on wagering.inbox_messages to :"runtime_role";
grant update (attempts, next_attempt_at, published_at, claim_owner, claim_until, parked_at)
  on wagering.outbox_messages to :"runtime_role";
grant select on wagering.wallets, wagering.wager_transactions, wagering.wallet_ledger_entries,
  wagering.inbox_messages, wagering.outbox_messages to :"audit_role";
grant select on public.mikro_orm_migrations to :"audit_role";
commit;
