import { Migration } from "@mikro-orm/migrations";

export class Migration20261118000100 extends Migration {
  override up(): void {
    this.addSql(`
      create domain wagering.required_text as text
        check (value ~ '[^[:space:]]');
      create domain wagering.finite_time as timestamptz
        check (isfinite(value));
      create domain wagering.money_amount as numeric
        constraint ck_money_range_scale check (
          value >= 0 and value < '1e36'::numeric and scale(value) <= 2
        );
      -- Freeze the currency vocabulary accepted by the project's Bun 1.4.4 runtime.
      create domain wagering.currency_code as text
        constraint ck_currency_code check (value in (
        'ADP', 'AED', 'AFA', 'AFN', 'ALK', 'ALL', 'AMD', 'ANG', 'AOA', 'AOK', 'AON', 'AOR',
        'ARA', 'ARL', 'ARM', 'ARP', 'ARS', 'ATS', 'AUD', 'AWG', 'AZM', 'AZN', 'BAD', 'BAM',
        'BAN', 'BBD', 'BDT', 'BEC', 'BEF', 'BEL', 'BGL', 'BGM', 'BGN', 'BGO', 'BHD', 'BIF',
        'BMD', 'BND', 'BOB', 'BOL', 'BOP', 'BOV', 'BRB', 'BRC', 'BRE', 'BRL', 'BRN', 'BRR',
        'BRZ', 'BSD', 'BTN', 'BUK', 'BWP', 'BYB', 'BYN', 'BYR', 'BZD', 'CAD', 'CDF', 'CHE',
        'CHF', 'CHW', 'CLE', 'CLF', 'CLP', 'CNH', 'CNX', 'CNY', 'COP', 'COU', 'CRC', 'CSD',
        'CSK', 'CUC', 'CUP', 'CVE', 'CYP', 'CZK', 'DDM', 'DEM', 'DJF', 'DKK', 'DOP', 'DZD',
        'ECS', 'ECV', 'EEK', 'EGP', 'ERN', 'ESA', 'ESB', 'ESP', 'ETB', 'EUR', 'FIM', 'FJD',
        'FKP', 'FRF', 'GBP', 'GEK', 'GEL', 'GHC', 'GHS', 'GIP', 'GMD', 'GNF', 'GNS', 'GQE',
        'GRD', 'GTQ', 'GWE', 'GWP', 'GYD', 'HKD', 'HNL', 'HRD', 'HRK', 'HTG', 'HUF', 'IDR',
        'IEP', 'ILP', 'ILR', 'ILS', 'INR', 'IQD', 'IRR', 'ISJ', 'ISK', 'ITL', 'JMD', 'JOD',
        'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRH', 'KRO', 'KRW', 'KWD', 'KYD', 'KZT',
        'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LTL', 'LTT', 'LUC', 'LUF', 'LUL', 'LVL', 'LVR',
        'LYD', 'MAD', 'MAF', 'MCF', 'MDC', 'MDL', 'MGA', 'MGF', 'MKD', 'MKN', 'MLF', 'MMK',
        'MNT', 'MOP', 'MRO', 'MRU', 'MTL', 'MTP', 'MUR', 'MVP', 'MVR', 'MWK', 'MXN', 'MXP',
        'MXV', 'MYR', 'MZE', 'MZM', 'MZN', 'NAD', 'NGN', 'NIC', 'NIO', 'NLG', 'NOK', 'NPR',
        'NZD', 'OMR', 'PAB', 'PEI', 'PEN', 'PES', 'PGK', 'PHP', 'PKR', 'PLN', 'PLZ', 'PTE',
        'PYG', 'QAR', 'RHD', 'ROL', 'RON', 'RSD', 'RUB', 'RUR', 'RWF', 'SAR', 'SBD', 'SCR',
        'SDD', 'SDG', 'SDP', 'SEK', 'SGD', 'SHP', 'SIT', 'SKK', 'SLE', 'SLL', 'SOS', 'SRD',
        'SRG', 'SSP', 'STD', 'STN', 'SUR', 'SVC', 'SYP', 'SZL', 'THB', 'TJR', 'TJS', 'TMM',
        'TMT', 'TND', 'TOP', 'TPE', 'TRL', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UAK', 'UGS',
        'UGX', 'USD', 'USN', 'USS', 'UYI', 'UYP', 'UYU', 'UYW', 'UZS', 'VEB', 'VED', 'VEF',
        'VES', 'VND', 'VNN', 'VUV', 'WST', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD',
        'XCD', 'XCG', 'XDR', 'XEU', 'XFO', 'XFU', 'XOF', 'XPD', 'XPF', 'XPT', 'XRE', 'XSU',
        'XTS', 'XUA', 'XXX', 'YDD', 'YER', 'YUD', 'YUM', 'YUN', 'YUR', 'ZAL', 'ZAR', 'ZMK',
        'ZMW', 'ZRN', 'ZRZ', 'ZWD', 'ZWG', 'ZWL', 'ZWR'
        ));

      create table wagering.wallets (
        id wagering.required_text primary key,
        player_id wagering.required_text not null,
        currency wagering.currency_code not null,
        balance wagering.money_amount not null default 0.00,
        version integer not null default 1 constraint ck_wallet_version_positive check (version >= 1),
        created_at wagering.finite_time not null,
        updated_at wagering.finite_time not null,
        constraint uq_wallet_player_currency unique (player_id, currency),
        constraint uq_wallet_identity unique (id, player_id, currency),
        constraint ck_wallet_dates check (updated_at >= created_at)
      );
    `);

    this.addSql(`
      create table wagering.wager_transactions (
        id wagering.required_text primary key,
        provider_id wagering.required_text not null,
        external_transaction_id wagering.required_text not null,
        idempotency_key wagering.required_text not null,
        payload_hash wagering.required_text not null,
        wallet_id wagering.required_text not null,
        player_id wagering.required_text not null,
        round_id wagering.required_text not null,
        game_id wagering.required_text not null,
        kind text not null,
        status text not null default 'PENDING',
        amount wagering.money_amount not null,
        currency wagering.currency_code not null,
        reference_external_transaction_id wagering.required_text,
        reference_transaction_id wagering.required_text,
        failure_code text,
        processed_at wagering.finite_time,
        result_balance wagering.money_amount,
        result_wallet_version integer,
        created_at wagering.finite_time not null,
        updated_at wagering.finite_time not null,
        constraint uq_wager_provider_external unique (provider_id, external_transaction_id),
        constraint uq_wager_idempotency unique (idempotency_key),
        constraint uq_wager_ledger_identity unique (id, wallet_id, currency, amount),
        constraint fk_wager_wallet foreign key (wallet_id, player_id, currency)
          references wagering.wallets (id, player_id, currency),
        constraint fk_wager_reference foreign key (reference_transaction_id)
          references wagering.wager_transactions (id),
        constraint ck_wager_kind check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint ck_wager_status check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint ck_wager_amount check (kind = 'LOSS' or amount > 0),
        constraint ck_wager_opening_identity check ((kind = 'OPENING') = (provider_id = 'system:wallet-opening')),
        constraint ck_wager_reference_shape check (
          (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null)
          and (reference_external_transaction_id is null or
            (kind in ('WIN', 'REFUND', 'ROLLBACK') and reference_external_transaction_id <> external_transaction_id))
          and (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null)
          and ((reference_transaction_id is not null) = (status = 'PROCESSED' and reference_external_transaction_id is not null))
          and (reference_transaction_id is null or reference_transaction_id <> id)
        ),
        constraint ck_wager_processing_fields check (
          ((status = 'PROCESSED') = (processed_at is not null))
          and ((result_balance is null) = (result_wallet_version is null))
          and (result_wallet_version is null or result_wallet_version >= 1)
          and (status <> 'PROCESSED' or result_balance is not null)
          and (status not in ('PENDING', 'PENDING_REFERENCE', 'FAILED') or result_balance is null)
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
        )
      );
      create unique index uq_wager_processed_reversal
        on wagering.wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
      create index ix_wager_wallet on wagering.wager_transactions (wallet_id, created_at, id);
      create index ix_wager_reference on wagering.wager_transactions (reference_transaction_id);
      create index ix_wager_pending_reference on wagering.wager_transactions
        (provider_id, reference_external_transaction_id, created_at, id)
        where status = 'PENDING_REFERENCE';

      create table wagering.wallet_ledger_entries (
        id wagering.required_text primary key,
        wallet_id wagering.required_text not null references wagering.wallets (id),
        transaction_id wagering.required_text not null,
        direction text not null constraint ck_ledger_direction check (direction in ('DEBIT', 'CREDIT')),
        amount wagering.money_amount not null constraint ck_ledger_amount check (amount > 0),
        currency wagering.currency_code not null,
        balance_before wagering.money_amount not null,
        balance_after wagering.money_amount not null,
        wallet_version integer not null constraint ck_ledger_wallet_version check (wallet_version >= 1),
        created_at wagering.finite_time not null,
        constraint fk_ledger_transaction_identity foreign key (transaction_id, wallet_id, currency, amount)
          references wagering.wager_transactions (id, wallet_id, currency, amount),
        constraint uq_ledger_transaction_wallet unique (transaction_id, wallet_id),
        constraint uq_ledger_wallet_version unique (wallet_id, wallet_version),
        constraint ck_ledger_arithmetic check (
          balance_after = case direction
            when 'CREDIT' then balance_before + amount
            when 'DEBIT' then balance_before - amount
          end
        )
      );
    `);

    this.addSql(`
      create table wagering.inbox_messages (
        consumer_name wagering.required_text not null,
        message_id wagering.required_text not null,
        payload_hash wagering.required_text not null,
        received_at wagering.finite_time not null,
        processed_at wagering.finite_time,
        constraint pk_inbox_consumer_message primary key (consumer_name, message_id),
        constraint ck_inbox_processed_at check (processed_at >= received_at)
      );

      create table wagering.outbox_messages (
        id wagering.required_text primary key,
        aggregate_id wagering.required_text not null,
        event_type wagering.required_text not null,
        payload jsonb not null constraint ck_outbox_payload_object check (jsonb_typeof(payload) = 'object'),
        occurred_at wagering.finite_time not null,
        attempts integer not null default 0 constraint ck_outbox_attempts check (attempts >= 0),
        next_attempt_at wagering.finite_time,
        published_at wagering.finite_time,
        claim_owner wagering.required_text,
        claim_until wagering.finite_time,
        constraint ck_outbox_dates check (
          (next_attempt_at is null or next_attempt_at >= occurred_at)
          and (published_at is null or (published_at >= occurred_at and next_attempt_at is null and claim_owner is null))
          and ((claim_until is null) = (claim_owner is null))
          and (claim_until is null or claim_until >= coalesce(next_attempt_at, occurred_at))
        )
      );
      create index ix_outbox_due on wagering.outbox_messages
        (coalesce(next_attempt_at, occurred_at), id) where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`
      lock table wagering.wallets, wagering.wager_transactions, wagering.wallet_ledger_entries,
        wagering.inbox_messages, wagering.outbox_messages in access exclusive mode;
      do $guard$
      begin
        if exists (select from wagering.wallets)
          or exists (select from wagering.wager_transactions)
          or exists (select from wagering.wallet_ledger_entries)
          or exists (select from wagering.inbox_messages)
          or exists (select from wagering.outbox_messages) then
          raise exception 'Refusing to drop a populated financial schema';
        end if;
      end;
      $guard$;
      drop table wagering.outbox_messages, wagering.inbox_messages, wagering.wallet_ledger_entries,
        wagering.wager_transactions, wagering.wallets;
      drop domain wagering.currency_code, wagering.money_amount, wagering.finite_time, wagering.required_text;
    `);
  }
}
