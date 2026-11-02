import { Migration } from '@mikro-orm/migrations';

export class Migration20260729150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(18,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency unique (player_id, currency)
      );
    `);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        wallet_id uuid not null references wallets(id),
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        status text not null,
        reference_transaction_id uuid references wager_transactions(id),
        failure_code text,
        result_balance_amount numeric(18,2),
        result_balance_currency char(3),
        attempt_count integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_kind check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_status check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_amount_positive check (amount > 0),
        constraint wager_idempotency unique (idempotency_key),
        constraint wager_provider_external unique (provider_id, external_transaction_id)
      );
    `);

    this.addSql(`
      create unique index wager_one_successful_reversal
        on wager_transactions (provider_id, reference_external_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
    this.addSql(`
      comment on index wager_one_successful_reversal is
        'REFUND e ROLLBACK da mesma bet creditariam duas vezes, então só uma reversão processada passa';
    `);
    this.addSql(`
      create index wager_pending_reference
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null unique references wager_transactions(id),
        direction text not null,
        amount numeric(18,2) not null,
        currency char(3) not null,
        balance_before numeric(18,2) not null,
        balance_after numeric(18,2) not null,
        created_at timestamptz not null,
        constraint ledger_direction check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balances_non_negative check (balance_before >= 0 and balance_after >= 0),
        constraint ledger_arithmetic check (
          (direction = 'DEBIT' and balance_after = balance_before - amount)
          or
          (direction = 'CREDIT' and balance_after = balance_before + amount)
        )
      );
    `);
    this.addSql(`
      create index ledger_wallet_created
        on wallet_ledger_entries (wallet_id, created_at desc, id desc);
    `);

    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        claim_token text,
        claim_expires_at timestamptz
      );
    `);
    this.addSql(`
      create index outbox_pending on outbox_messages (occurred_at) where published_at is null;
    `);

    this.addSql(`
      create or replace function prevent_ledger_mutation()
      returns trigger language plpgsql as $fn$
      begin
        raise exception 'ledger é imutável';
      end;
      $fn$;
    `);
    this.addSql(`
      create trigger ledger_no_mutation
      before update or delete on wallet_ledger_entries
      for each row execute function prevent_ledger_mutation();
    `);

    this.addSql(`
      create or replace function prevent_terminal_wager_change()
      returns trigger language plpgsql as $fn$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') and new.status is distinct from old.status then
          raise exception 'estado terminal não volta atrás';
        end if;
        if old.amount is distinct from new.amount
          or old.kind is distinct from new.kind
          or old.idempotency_key is distinct from new.idempotency_key
          or old.wallet_id is distinct from new.wallet_id then
          raise exception 'identidade da transação é imutável';
        end if;
        return new;
      end;
      $fn$;
    `);
    this.addSql(`
      create trigger wager_terminal_guard
      before update on wager_transactions
      for each row execute function prevent_terminal_wager_change();
    `);

    this.addSql(`
      create or replace function assert_wallet_matches_ledger()
      returns trigger language plpgsql as $fn$
      declare
        calc numeric(18,2);
      begin
        select coalesce(sum(
          case when direction = 'CREDIT' then amount else -amount end
        ), 0)::numeric(18,2)
        into calc
        from wallet_ledger_entries
        where wallet_id = new.id;

        if new.balance <> calc then
          raise exception 'saldo da wallet % não bate com o ledger', new.id;
        end if;
        return null;
      end;
      $fn$;
    `);
    this.addSql(`
      create constraint trigger wallets_match_ledger
      after insert or update of balance on wallets
      deferrable initially deferred
      for each row execute function assert_wallet_matches_ledger();
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop table if exists wallets;');
    this.addSql('drop function if exists prevent_ledger_mutation();');
    this.addSql('drop function if exists prevent_terminal_wager_change();');
    this.addSql('drop function if exists assert_wallet_matches_ledger();');
  }
}
