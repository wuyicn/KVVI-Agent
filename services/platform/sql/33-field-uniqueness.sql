-- Only a boolean leaves this narrowly scoped, cross-row check. Ordinary reads retain RLS.
CREATE OR REPLACE FUNCTION kvvi_unique_conflict(
  tenant uuid, asset text, fields text[], candidate jsonb DEFAULT NULL, excluded uuid DEFAULT NULL
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE conflict boolean;
BEGIN
  IF tenant IS DISTINCT FROM public.kvvi_guc_uuid('kvvi.company_id')
     OR tenant IS NULL THEN
    RAISE EXCEPTION 'KVVI_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;
  IF cardinality(fields) NOT BETWEEN 1 AND 4 OR fields IS NULL
     OR EXISTS (SELECT 1 FROM unnest(fields) f WHERE f IS NULL OR f !~ '^[a-z][a-z0-9_]{2,63}$') THEN
    RAISE EXCEPTION 'KVVI_UNIQUE_RULE_INVALID';
  END IF;
  -- Product writes and publication preflight share this transaction lock.
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('field-unique',tenant,asset)::text,0));
  IF candidate IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM unnest(fields) f
       WHERE candidate->f IS NULL OR candidate->f IN ('null'::jsonb, '""'::jsonb)) THEN
      RETURN false;
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.business_records r
      WHERE r.company_id=tenant AND r.schema_code=asset
        AND (excluded IS NULL OR r.record_id<>excluded)
        AND NOT EXISTS (SELECT 1 FROM unnest(fields) f
                        WHERE r.data->f IS DISTINCT FROM candidate->f)
    ) INTO conflict;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.business_records r
      WHERE r.company_id=tenant AND r.schema_code=asset
        AND NOT EXISTS (SELECT 1 FROM unnest(fields) f
                        WHERE r.data->f IS NULL OR r.data->f IN ('null'::jsonb, '""'::jsonb))
      GROUP BY (SELECT jsonb_agg(r.data->f ORDER BY n) FROM unnest(fields) WITH ORDINALITY AS t(f,n))
      HAVING count(*)>1
    ) INTO conflict;
  END IF;
  RETURN conflict;
END $$;
REVOKE ALL ON FUNCTION kvvi_unique_conflict(uuid,text,text[],jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kvvi_unique_conflict(uuid,text,text[],jsonb,uuid) TO kvvi_business;

-- A committed fence survives connection loss between the business and platform commits.
CREATE TABLE business_rule_publications (
  company_id uuid NOT NULL,
  asset_id text NOT NULL,
  draft_id uuid NOT NULL,
  expected_model jsonb NOT NULL,
  PRIMARY KEY (company_id, asset_id)
);
ALTER TABLE business_rule_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_rule_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_publication_company ON business_rule_publications
  USING (company_id = public.kvvi_guc_uuid('kvvi.company_id'))
  WITH CHECK (company_id = public.kvvi_guc_uuid('kvvi.company_id'));
GRANT SELECT, INSERT, UPDATE, DELETE ON business_rule_publications TO kvvi_business;
