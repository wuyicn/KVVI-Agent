-- Company directory only; never grants access to business records.
BEGIN;
CREATE TABLE business_groups (
  company_id uuid NOT NULL,
  group_id uuid NOT NULL,
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80),
  position integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, group_id),
  UNIQUE(company_id, name)
);
CREATE TABLE business_form_directory (
  company_id uuid NOT NULL,
  asset_id text NOT NULL,
  group_id uuid,
  archived_at timestamptz,
  archived_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY(company_id, asset_id),
  FOREIGN KEY(company_id, group_id) REFERENCES business_groups(company_id, group_id),
  CHECK ((archived_at IS NULL) = (archived_by IS NULL))
);
CREATE TABLE business_directory_operations (
  company_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  action text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  audit_payload jsonb NOT NULL,
  audit_delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id, operation_id)
);
CREATE INDEX business_directory_pending ON business_directory_operations(company_id, created_at)
  WHERE audit_delivered_at IS NULL;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_groups','business_form_directory','business_directory_operations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY directory_company ON %I USING (company_id = kvvi_guc_uuid(''kvvi.company_id'')) WITH CHECK (company_id = kvvi_guc_uuid(''kvvi.company_id''))',t);
  END LOOP;
END $$;
COMMIT;
