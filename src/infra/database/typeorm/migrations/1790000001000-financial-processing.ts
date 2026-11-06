import type { MigrationInterface, QueryRunner } from 'typeorm';

export class FinancialProcessing1790000001000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id varchar(128) NOT NULL,
        external_transaction_id varchar(256) NOT NULL,
        idempotency_key varchar(256) NOT NULL UNIQUE,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallets(id), player_id uuid NOT NULL,
        round_id varchar(256) NOT NULL, game_id varchar(256) NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL, currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(256),
        reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text, result jsonb,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        correlation_id text NOT NULL,
        UNIQUE (provider_id, external_transaction_id),
        UNIQUE (id, wallet_id, currency),
        CHECK ((kind = 'LOSS' AND amount = 0) OR (kind <> 'LOSS' AND amount > 0)),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CHECK (status NOT IN ('PROCESSED','REJECTED','FAILED') OR result IS NOT NULL),
        CHECK (reference_transaction_id IS DISTINCT FROM id)
      );
      CREATE UNIQUE INDEX unique_reversal ON wager_transactions(reference_transaction_id, kind)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
      CREATE INDEX pending_references ON wager_transactions(next_attempt_at, id) WHERE status = 'PENDING_REFERENCE';
      ALTER TABLE wallets ADD CONSTRAINT wallet_id_currency UNIQUE(id, currency);
      CREATE TABLE wallet_ledger (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0), currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        wallet_version integer NOT NULL CHECK (wallet_version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (wallet_id, transaction_id), UNIQUE (wallet_id, wallet_version),
        FOREIGN KEY (wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY (transaction_id, wallet_id, currency) REFERENCES wager_transactions(id, wallet_id, currency),
        CHECK (balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL, message_id varchar(256) NOT NULL, payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
        lease_token uuid, lease_until timestamptz,
        CHECK (attempts >= 0), CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
        CHECK (payload->>'eventId' = id::text), CHECK (payload->>'eventType' = event_type)
      );
      CREATE INDEX pending_outbox ON outbox_messages(next_attempt_at, occurred_at) WHERE published_at IS NULL;

      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'ledger is append-only' USING ERRCODE = '23514'; END $$;
      CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON wallet_ledger FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
      CREATE TRIGGER immutable_ledger_truncate BEFORE TRUNCATE ON wallet_ledger FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();

      CREATE FUNCTION protect_wager_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'transactions are audit records' USING ERRCODE = '23514'; END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') OR
          (to_jsonb(NEW) - ARRAY['status','failure_code','reference_transaction_id','result','attempts','next_attempt_at','processed_at'])
            IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status','failure_code','reference_transaction_id','result','attempts','next_attempt_at','processed_at'])
        THEN RAISE EXCEPTION 'immutable transaction or invalid terminal transition' USING ERRCODE = '23514'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER immutable_transaction BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION protect_wager_identity();

      CREATE FUNCTION verify_financial_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid uuid; w wallets%ROWTYPE; total numeric; latest integer;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT * INTO w FROM wallets WHERE id = wid FOR UPDATE;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0), COALESCE(MAX(wallet_version),1)
          INTO total, latest FROM wallet_ledger WHERE wallet_id = wid;
        IF w.balance <> total OR w.version <> latest THEN
          RAISE EXCEPTION 'wallet/ledger balance or version mismatch' USING ERRCODE = '23514';
        END IF;
        IF EXISTS (
          SELECT 1 FROM (
            SELECT balance_before, wallet_version,
              COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
                OVER (ORDER BY wallet_version ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS expected_before,
              LAG(wallet_version) OVER (ORDER BY wallet_version) AS previous_version
            FROM wallet_ledger WHERE wallet_id = wid
          ) chain WHERE balance_before <> expected_before OR
            (previous_version IS NULL AND wallet_version NOT IN (1,2)) OR
            (previous_version IS NOT NULL AND wallet_version <> previous_version + 1)
        ) THEN RAISE EXCEPTION 'broken ledger chain' USING ERRCODE = '23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM wager_transactions t LEFT JOIN wallet_ledger l ON l.transaction_id = t.id AND l.wallet_id = t.wallet_id
          WHERE t.wallet_id = wid AND (
            ((t.status = 'PROCESSED' AND t.kind <> 'LOSS') <> (l.id IS NOT NULL)) OR
            (l.id IS NOT NULL AND (t.amount <> l.amount OR t.currency <> w.currency OR t.player_id <> w.player_id OR
              (l.wallet_version=1 AND t.kind<>'OPENING') OR
              (t.kind IN ('WIN','REFUND','OPENING') AND l.direction <> 'CREDIT') OR (t.kind = 'BET' AND l.direction <> 'DEBIT'))) OR
            (t.status = 'PROCESSED' AND (t.player_id <> w.player_id OR t.currency <> w.currency)) OR
            (t.status = 'PROCESSED' AND t.kind = 'OPENING' AND l.wallet_version <> 1)
          )
        ) THEN RAISE EXCEPTION 'transaction/ledger mismatch' USING ERRCODE = '23514'; END IF;
        IF EXISTS (
          SELECT 1 FROM wager_transactions t
          LEFT JOIN wager_transactions r ON r.id = t.reference_transaction_id
          LEFT JOIN wallet_ledger rl ON rl.transaction_id = r.id
          LEFT JOIN wallet_ledger tl ON tl.transaction_id = t.id
          WHERE t.wallet_id = wid AND t.status = 'PROCESSED' AND (
            (t.kind IN ('REFUND','ROLLBACK') AND r.id IS NULL) OR
            (t.reference_external_transaction_id IS NOT NULL AND (
              r.id IS NULL OR r.status <> 'PROCESSED' OR r.provider_id <> t.provider_id OR r.wallet_id <> t.wallet_id OR
              r.player_id <> t.player_id OR r.currency <> t.currency OR r.round_id <> t.round_id OR
              r.external_transaction_id <> t.reference_external_transaction_id OR
              (t.kind IN ('WIN','LOSS','REFUND') AND r.kind <> 'BET') OR
              (t.kind = 'ROLLBACK' AND r.kind NOT IN ('BET','WIN','REFUND')) OR
              (t.kind IN ('REFUND','ROLLBACK') AND t.amount <> r.amount) OR
              (t.kind = 'ROLLBACK' AND tl.direction = rl.direction)
            ))
          )
        ) THEN RAISE EXCEPTION 'invalid processed reference' USING ERRCODE = '23514'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER wallet_financial_consistency AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_financial_wallet();
      CREATE CONSTRAINT TRIGGER ledger_financial_consistency AFTER INSERT ON wallet_ledger
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_financial_wallet();
      CREATE CONSTRAINT TRIGGER transaction_financial_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_financial_wallet();
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      DROP TRIGGER transaction_financial_consistency ON wager_transactions;
      DROP TRIGGER ledger_financial_consistency ON wallet_ledger;
      DROP TRIGGER wallet_financial_consistency ON wallets;
      DROP FUNCTION verify_financial_wallet();
      DROP TABLE outbox_messages, inbox_messages, wallet_ledger;
      DROP TABLE wager_transactions;
      DROP FUNCTION protect_wager_identity();
      DROP FUNCTION forbid_ledger_mutation();
      ALTER TABLE wallets DROP CONSTRAINT wallet_id_currency;
    `);
  }
}
