BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS visitor_link_identity ON visitor_links(company_id,issuer_user_id,link_id);
CREATE TABLE IF NOT EXISTS visitor_projection_receipts(
  company_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  link_id uuid NOT NULL,
  issuer_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$'),
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,operation_id),
  FOREIGN KEY(company_id,issuer_id,link_id) REFERENCES visitor_links(company_id,issuer_user_id,link_id)
);
ALTER TABLE visitor_link_events ADD COLUMN IF NOT EXISTS submission_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS visitor_event_submission ON visitor_link_events(company_id,submission_id) WHERE submission_id IS NOT NULL;
-- A cursor survives worker restart; one slow company cannot always be first.
CREATE TABLE IF NOT EXISTS visitor_projection_scan(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  last_company_id uuid
);
INSERT INTO visitor_projection_scan(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
COMMIT;
