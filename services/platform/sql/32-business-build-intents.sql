BEGIN;
CREATE TABLE business_build_intents (
  company_id uuid NOT NULL,
  intent_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  session_id uuid NOT NULL,
  group_id uuid,
  asset_id text,
  draft_id uuid UNIQUE REFERENCES publish_drafts(draft_id),
  state text NOT NULL DEFAULT 'CREATED' CHECK (state IN ('CREATED','BOUND','PENDING','DONE')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,intent_id)
);
CREATE INDEX business_build_pending ON business_build_intents(created_at) WHERE state='PENDING';
COMMIT;
