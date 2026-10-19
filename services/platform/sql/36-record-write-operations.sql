BEGIN;
CREATE TABLE IF NOT EXISTS record_write_operations (
  company_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  endpoint text NOT NULL,
  idempotency_key text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  request_digest text NOT NULL,
  response jsonb NOT NULL,
  status_code integer NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  audit_payload jsonb NOT NULL,
  audit_delivered_at timestamptz,
  audit_attempts integer NOT NULL DEFAULT 0,
  audit_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,actor_id,endpoint,idempotency_key)
);
CREATE INDEX IF NOT EXISTS record_write_pending ON record_write_operations(company_id,audit_next_attempt_at,created_at)
  WHERE audit_delivered_at IS NULL;
ALTER TABLE record_write_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_write_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS record_write_company ON record_write_operations;
CREATE POLICY record_write_company ON record_write_operations
  USING (company_id=kvvi_guc_uuid('kvvi.company_id'))
  WITH CHECK (company_id=kvvi_guc_uuid('kvvi.company_id'));
COMMIT;
