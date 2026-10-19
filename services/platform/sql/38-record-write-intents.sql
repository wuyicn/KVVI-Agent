BEGIN;
CREATE TABLE IF NOT EXISTS record_write_intents (
  company_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  gateway text NOT NULL CHECK (gateway IN ('USER','BUILDER')),
  request_digest text NOT NULL,
  request_fields text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('PREPARED','COMMITTED','CANCELED','ACKNOWLEDGED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,actor_id,endpoint,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS record_write_one_active ON record_write_intents(company_id,actor_id,endpoint)
  WHERE status IN ('PREPARED','COMMITTED');
ALTER TABLE record_write_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_write_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_write_intent_company ON record_write_intents;
CREATE POLICY record_write_intent_company ON record_write_intents
  USING(company_id=kvvi_guc_uuid('kvvi.company_id')) WITH CHECK(company_id=kvvi_guc_uuid('kvvi.company_id'));
COMMIT;
